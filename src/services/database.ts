import { isTauri } from "@/platform";

// Database interface shared between Tauri SQLite and in-memory fallback
interface DatabaseLike {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}

let db: DatabaseLike | null = null;
let migrated = false;

export async function getDb(): Promise<DatabaseLike> {
  if (!db) {
    if (isTauri) {
      const { default: Database } = await import("@tauri-apps/plugin-sql");
      db = await Database.load("sqlite:markflow.db");
    } else {
      const { MemoryDatabase } = await import("./database-memory");
      db = await MemoryDatabase.load("sqlite:markflow.db");
    }
  }
  if (!migrated) {
    migrated = true;
    await ensureMigrations(db);
  }
  return db;
}

/** Ensure all tables and columns exist (fixes missed Tauri migrations) */
async function ensureMigrations(database: DatabaseLike) {
  try {
    // versions table (migration v2)
    await database.execute(`CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      content TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    )`);
    await database.execute(
      `CREATE INDEX IF NOT EXISTS idx_versions_doc ON versions(document_id, created_at DESC)`,
    );

    // folder and tags columns (migration v3) - ADD COLUMN fails if already exists
    try {
      await database.execute(
        `ALTER TABLE documents ADD COLUMN folder TEXT NOT NULL DEFAULT '/'`,
      );
    } catch {
      /* already exists */
    }
    try {
      await database.execute(
        `ALTER TABLE documents ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`,
      );
    } catch {
      /* already exists */
    }

    // owner_id column (migration v4)
    try {
      await database.execute(
        `ALTER TABLE documents ADD COLUMN owner_id TEXT DEFAULT NULL`,
      );
    } catch {
      /* already exists */
    }

    // is_shared column (migration v5)
    try {
      await database.execute(
        `ALTER TABLE documents ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      /* already exists */
    }

    // title_pinned column (migration v7)
    try {
      await database.execute(
        `ALTER TABLE documents ADD COLUMN title_pinned INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      /* already exists */
    }

    // doc_type column (migration v8)
    try {
      await database.execute(
        `ALTER TABLE documents ADD COLUMN doc_type TEXT NOT NULL DEFAULT 'markdown'`,
      );
    } catch {
      /* already exists */
    }

    // settings table (ensure exists — may have been created by Rust migration)
    await database.execute(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    // document_snapshots table — multi-generation content backup (keeps last 3 per doc)
    await database.execute(`CREATE TABLE IF NOT EXISTS document_snapshots_v2 (
      document_id TEXT NOT NULL,
      content TEXT NOT NULL,
      title TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (document_id, updated_at)
    )`);
    // Migrate from v1 single-entry table if it exists
    try {
      const old = await database.select<
        {
          document_id: string;
          content: string;
          title: string;
          updated_at: number;
        }[]
      >("SELECT * FROM document_snapshots");
      for (const row of old) {
        await database.execute(
          `INSERT OR IGNORE INTO document_snapshots_v2 (document_id, content, title, updated_at) VALUES ($1, $2, $3, $4)`,
          [row.document_id, row.content, row.title, row.updated_at],
        );
      }
      await database.execute("DROP TABLE IF EXISTS document_snapshots");
    } catch {
      /* old table doesn't exist — fine */
    }

    // voice data columns (migration v10)
    try {
      await database.execute(
        `ALTER TABLE documents ADD COLUMN voice_transcript TEXT DEFAULT NULL`,
      );
    } catch {
      /* already exists */
    }
    try {
      await database.execute(
        `ALTER TABLE documents ADD COLUMN voice_gcs_uri TEXT DEFAULT NULL`,
      );
    } catch {
      /* already exists */
    }
    try {
      await database.execute(
        `ALTER TABLE documents ADD COLUMN voice_recorded_at INTEGER DEFAULT NULL`,
      );
    } catch {
      /* already exists */
    }

    // synced_at column (migration v11) — timestamp of the last successful cloud
    // sync for this doc. NULL means the doc has NEVER been persisted to Firestore
    // (created offline / first sync pending / prior upload failed). This is the
    // authoritative signal the deletion-reconciliation uses to distinguish a doc
    // genuinely deleted in the cloud (synced_at set, now absent) from one that was
    // simply never uploaded (synced_at NULL) — the latter must never be deleted.
    try {
      await database.execute(
        `ALTER TABLE documents ADD COLUMN synced_at INTEGER DEFAULT NULL`,
      );
    } catch {
      /* already exists */
    }

    // deleted_docs table (migration v9) — tracks locally deleted docs to prevent re-sync
    await database.execute(`CREATE TABLE IF NOT EXISTS deleted_docs (
      doc_id TEXT PRIMARY KEY,
      deleted_at INTEGER NOT NULL
    )`);
  } catch (err) {
    console.error("[db] migration repair failed:", err);
  }
}

export interface DbDocument {
  id: string;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
  is_dirty: number;
  synced_at: number | null;
  folder: string;
  tags: string;
  owner_id: string | null;
  is_shared: number;
  title_pinned: number;
  doc_type: string;
  voice_transcript: string | null;
  voice_gcs_uri: string | null;
  voice_recorded_at: number | null;
}

export async function getAllDocuments(): Promise<DbDocument[]> {
  const database = await getDb();
  return database.select<DbDocument[]>(
    "SELECT * FROM documents ORDER BY updated_at DESC",
  );
}

export async function getDocument(id: string): Promise<DbDocument | null> {
  const database = await getDb();
  const rows = await database.select<DbDocument[]>(
    "SELECT * FROM documents WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

export async function upsertDocument(doc: {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  folder?: string;
  tags?: string[];
  ownerId?: string | null;
  isShared?: boolean;
  titlePinned?: boolean;
  docType?: string;
  voiceTranscript?: string | null;
  voiceGcsUri?: string | null;
  voiceRecordedAt?: number | null;
}): Promise<void> {
  const database = await getDb();

  // LAYER 1: Write-ahead snapshot + empty overwrite protection.
  // Check if doc already exists in DB before writing.
  try {
    const existing = await database.select<
      { content: string; title: string }[]
    >("SELECT content, title FROM documents WHERE id = $1", [doc.id]);
    if (existing[0]) {
      // Save snapshot of current content before overwriting (preserves recovery ability)
      if (existing[0].content?.trim()) {
        const now = Date.now();
        await database.execute(
          `INSERT OR IGNORE INTO document_snapshots_v2 (document_id, content, title, updated_at)
           VALUES ($1, $2, $3, $4)`,
          [doc.id, existing[0].content, existing[0].title, now],
        );
        // Prune old snapshots: keep only the 3 most recent per document
        await database.execute(
          `DELETE FROM document_snapshots_v2 WHERE document_id = $1 AND updated_at NOT IN (
             SELECT updated_at FROM document_snapshots_v2 WHERE document_id = $1 ORDER BY updated_at DESC LIMIT 3
           )`,
          [doc.id],
        );
      }
    }
  } catch (e) {
    // Snapshot failure must never block the write
    console.error("[db] Snapshot save failed:", e);
  }

  const folder = doc.folder ?? "/";
  const tags = JSON.stringify(doc.tags ?? []);
  const ownerId = doc.ownerId ?? null;
  const isShared = doc.isShared ? 1 : 0;
  const titlePinned = doc.titlePinned ? 1 : 0;
  const docType = doc.docType ?? "markdown";
  const voiceTranscript = doc.voiceTranscript ?? null;
  const voiceGcsUri = doc.voiceGcsUri ?? null;
  const voiceRecordedAt = doc.voiceRecordedAt ?? null;
  await database.execute(
    `INSERT INTO documents (id, title, content, created_at, updated_at, is_dirty, folder, tags, owner_id, is_shared, title_pinned, doc_type, voice_transcript, voice_gcs_uri, voice_recorded_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT(id) DO UPDATE SET
       title = $2, content = $3, updated_at = $5, is_dirty = 1, folder = $6, tags = $7, owner_id = $8, is_shared = $9, title_pinned = $10, doc_type = $11, voice_transcript = $12, voice_gcs_uri = $13, voice_recorded_at = $14`,
    [
      doc.id,
      doc.title,
      doc.content,
      doc.createdAt,
      doc.updatedAt,
      folder,
      tags,
      ownerId,
      isShared,
      titlePinned,
      docType,
      voiceTranscript,
      voiceGcsUri,
      voiceRecordedAt,
    ],
  );
}

export async function deleteDocument(id: string): Promise<void> {
  const database = await getDb();
  await database.execute("DELETE FROM documents WHERE id = $1", [id]);
}

/**
 * Mark documents as successfully persisted to the cloud: stamps synced_at and
 * clears the dirty flag. Called after a successful Firestore write (syncToCloud)
 * and for docs confirmed present in the cloud (syncFromCloud). The deletion
 * reconciliation relies on synced_at to avoid deleting never-uploaded local docs.
 */
export async function markDocumentsSynced(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const database = await getDb();
  const now = Date.now();
  for (const id of ids) {
    try {
      await database.execute(
        "UPDATE documents SET synced_at = $1, is_dirty = 0 WHERE id = $2",
        [now, id],
      );
    } catch (e) {
      // Non-fatal: a failure here only means the doc may be re-evaluated next
      // sync; it must never abort the sync cycle.
      console.error(`[db] markDocumentsSynced failed for ${id}:`, e);
    }
  }
}

/**
 * Purge EVERY locally-cached document and its derived tables. SQLite here is a
 * single per-device cache with NO per-user scoping, so when a DIFFERENT account
 * signs in on the same device the previous user's PRIVATE documents would
 * otherwise remain in the sidebar (a data-isolation / privacy defect). This
 * clears documents + versions + snapshots + delete-tombstones, and resets the
 * per-user sync bookkeeping (lastSyncAt so the new user's docs upload; folders,
 * which are per-user). Device-level prefs (theme, editor settings) are KEPT.
 */
export async function clearAllLocalDocuments(): Promise<void> {
  const database = await getDb();
  await database.execute("DELETE FROM documents");
  await database.execute("DELETE FROM versions");
  await database.execute("DELETE FROM document_snapshots_v2");
  await database.execute("DELETE FROM deleted_docs");
  // Per-user bookkeeping that must not carry across accounts. Deleted per-key so
  // the in-memory adapter (equality-WHERE only) handles it too.
  for (const key of ["lastSyncAt", "folders", "versions_backfill_v2_done"]) {
    await database.execute("DELETE FROM settings WHERE key = $1", [key]);
  }
}

/**
 * Fail-closed data-isolation guard. Remove any locally-cached PRIVATE document
 * that belongs to a DIFFERENT account — `owner_id` is set, is NOT the current
 * uid, and the doc is not shared/team (`is_shared = 0`; team docs are stored with
 * `is_shared = 1`). This runs on EVERY login independently of the LAST_UID switch
 * purge, so even when that purge is skipped (getSetting/wipe throwing on iOS) or
 * an in-flight sync revived a row, another account's private docs can never
 * linger in the sidebar. Preserved: own docs (`owner_id = uid`), unclaimed docs
 * created offline before any login (`owner_id IS NULL`), and shared/team docs.
 * Returns the number of documents removed.
 */
export async function purgeForeignDocuments(uid: string): Promise<number> {
  if (!uid) return 0;
  const database = await getDb();
  // Read all rows and filter in JS (NOT via a compound SQL WHERE): the in-memory
  // adapter used on web/tests only models `WHERE col = $N` equality, so a
  // `owner_id != $1 AND is_shared = 0` predicate would silently match nothing and
  // return every row — which would then delete the whole cache. Equality-only
  // DELETEs below are handled identically by both adapters and real SQLite.
  const all = await database.select<DbDocument[]>("SELECT * FROM documents");
  const foreign = all.filter(
    (r) => r.owner_id != null && r.owner_id !== uid && r.is_shared === 0,
  );
  for (const { id } of foreign) {
    await database.execute("DELETE FROM documents WHERE id = $1", [id]);
    await database.execute("DELETE FROM versions WHERE document_id = $1", [id]);
    await database.execute(
      "DELETE FROM document_snapshots_v2 WHERE document_id = $1",
      [id],
    );
  }
  return foreign.length;
}

export async function getSetting(key: string): Promise<string | null> {
  const database = await getDb();
  const rows = await database.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1",
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const database = await getDb();
  await database.execute(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = $2`,
    [key, value],
  );
}

// Version management
export interface DbVersion {
  id: string;
  document_id: string;
  content: string;
  title: string;
  message: string | null;
  created_at: number;
}

export async function getVersions(documentId: string): Promise<DbVersion[]> {
  const database = await getDb();
  return database.select<DbVersion[]>(
    "SELECT * FROM versions WHERE document_id = $1 ORDER BY created_at DESC",
    [documentId],
  );
}

export async function createVersion(version: {
  id: string;
  documentId: string;
  content: string;
  title: string;
  message: string | null;
}): Promise<void> {
  const database = await getDb();
  await database.execute(
    `INSERT INTO versions (id, document_id, content, title, message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      version.id,
      version.documentId,
      version.content,
      version.title,
      version.message,
      Date.now(),
    ],
  );
}

/** Get ALL versions across all documents (for backfill migration) */
export async function getAllVersions(): Promise<DbVersion[]> {
  const database = await getDb();
  return database.select<DbVersion[]>(
    "SELECT * FROM versions ORDER BY created_at ASC",
  );
}

export async function deleteVersion(versionId: string): Promise<void> {
  const database = await getDb();
  await database.execute("DELETE FROM versions WHERE id = $1", [versionId]);
}

export async function deleteVersionsForDocument(
  documentId: string,
): Promise<void> {
  const database = await getDb();
  await database.execute("DELETE FROM versions WHERE document_id = $1", [
    documentId,
  ]);
}

// Snapshot management — multi-generation content backup
export async function getSnapshot(
  documentId: string,
): Promise<{ content: string; title: string } | null> {
  const database = await getDb();
  const rows = await database.select<{ content: string; title: string }[]>(
    "SELECT content, title FROM document_snapshots_v2 WHERE document_id = $1 ORDER BY updated_at DESC LIMIT 1",
    [documentId],
  );
  const row = rows[0];
  return row?.content?.trim() ? row : null;
}

export async function deleteSnapshot(documentId: string): Promise<void> {
  const database = await getDb();
  await database.execute(
    "DELETE FROM document_snapshots_v2 WHERE document_id = $1",
    [documentId],
  );
}

// ─── Deleted docs tracking ───────────────────────────────────

export async function trackDeletedDoc(docId: string): Promise<void> {
  const database = await getDb();
  await database.execute(
    `INSERT INTO deleted_docs (doc_id, deleted_at) VALUES ($1, $2)
     ON CONFLICT(doc_id) DO UPDATE SET deleted_at = $2`,
    [docId, Date.now()],
  );
}

export async function getDeletedDocIds(): Promise<Set<string>> {
  const database = await getDb();
  // Clean up entries older than 30 days to prevent permanent sync blocking
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await database.execute("DELETE FROM deleted_docs WHERE deleted_at < $1", [
    thirtyDaysAgo,
  ]);
  const rows = await database.select<{ doc_id: string }[]>(
    "SELECT doc_id FROM deleted_docs",
  );
  return new Set(rows.map((r) => r.doc_id));
}

export async function clearDeletedDoc(docId: string): Promise<void> {
  const database = await getDb();
  await database.execute("DELETE FROM deleted_docs WHERE doc_id = $1", [docId]);
}

/**
 * LAYER 3: Multi-source content recovery.
 * Tries to recover content for an empty document from (in order):
 *   1. document_snapshots (write-ahead backup)
 *   2. versions (auto-save history)
 * Returns recovered content+title, or null if unrecoverable locally.
 */
export async function recoverContent(
  documentId: string,
): Promise<{ content: string; title: string; source: string } | null> {
  // Source 1: snapshot
  const snapshot = await getSnapshot(documentId);
  if (snapshot) return { ...snapshot, source: "snapshot" };

  // Source 2: version history
  const versions = await getVersions(documentId);
  const goodVersion = versions.find((v) => v.content.trim());
  if (goodVersion)
    return {
      content: goodVersion.content,
      title: goodVersion.title,
      source: "version",
    };

  return null;
}
