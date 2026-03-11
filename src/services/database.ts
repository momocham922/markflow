import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;
let migrated = false;

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load("sqlite:markflow.db");
  }
  if (!migrated) {
    migrated = true;
    await ensureMigrations(db);
  }
  return db;
}

/** Ensure all tables and columns exist (fixes missed Tauri migrations) */
async function ensureMigrations(database: Database) {
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
      `CREATE INDEX IF NOT EXISTS idx_versions_doc ON versions(document_id, created_at DESC)`
    );

    // folder and tags columns (migration v3) - ADD COLUMN fails if already exists
    try {
      await database.execute(`ALTER TABLE documents ADD COLUMN folder TEXT NOT NULL DEFAULT '/'`);
    } catch { /* already exists */ }
    try {
      await database.execute(`ALTER TABLE documents ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`);
    } catch { /* already exists */ }

    // owner_id column (migration v4)
    try {
      await database.execute(`ALTER TABLE documents ADD COLUMN owner_id TEXT DEFAULT NULL`);
    } catch { /* already exists */ }

    // is_shared column (migration v5)
    try {
      await database.execute(`ALTER TABLE documents ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0`);
    } catch { /* already exists */ }

    // title_pinned column (migration v7)
    try {
      await database.execute(`ALTER TABLE documents ADD COLUMN title_pinned INTEGER NOT NULL DEFAULT 0`);
    } catch { /* already exists */ }

    // document_snapshots table (migration v6) — last-known-good content backup
    await database.execute(`CREATE TABLE IF NOT EXISTS document_snapshots (
      document_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      title TEXT NOT NULL,
      updated_at INTEGER NOT NULL
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
}): Promise<void> {
  const database = await getDb();

  // LAYER 1: Write-ahead snapshot + empty overwrite protection.
  // Check if doc already exists in DB before writing.
  try {
    const existing = await database.select<{ content: string; title: string }[]>(
      "SELECT content, title FROM documents WHERE id = $1",
      [doc.id],
    );
    if (existing[0]) {
      // LAYER 2: Block overwriting existing non-empty content with empty content
      if (!doc.content.trim() && existing[0].content?.trim()) {
        console.warn(`[db] Blocked empty overwrite of doc ${doc.id}`);
        return;
      }
      // Save snapshot of current content before overwriting
      if (existing[0].content?.trim()) {
        await database.execute(
          `INSERT INTO document_snapshots (document_id, content, title, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(document_id) DO UPDATE SET content = $2, title = $3, updated_at = $4`,
          [doc.id, existing[0].content, existing[0].title, Date.now()],
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
  await database.execute(
    `INSERT INTO documents (id, title, content, created_at, updated_at, is_dirty, folder, tags, owner_id, is_shared, title_pinned)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10)
     ON CONFLICT(id) DO UPDATE SET
       title = $2, content = $3, updated_at = $5, is_dirty = 1, folder = $6, tags = $7, owner_id = $8, is_shared = $9, title_pinned = $10`,
    [doc.id, doc.title, doc.content, doc.createdAt, doc.updatedAt, folder, tags, ownerId, isShared, titlePinned],
  );
}

export async function deleteDocument(id: string): Promise<void> {
  const database = await getDb();
  await database.execute("DELETE FROM documents WHERE id = $1", [id]);
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
    [version.id, version.documentId, version.content, version.title, version.message, Date.now()],
  );
}

export async function deleteVersionsForDocument(documentId: string): Promise<void> {
  const database = await getDb();
  await database.execute(
    "DELETE FROM versions WHERE document_id = $1",
    [documentId],
  );
}

// Snapshot management — last-known-good content backup
export async function getSnapshot(documentId: string): Promise<{ content: string; title: string } | null> {
  const database = await getDb();
  const rows = await database.select<{ content: string; title: string }[]>(
    "SELECT content, title FROM document_snapshots WHERE document_id = $1",
    [documentId],
  );
  const row = rows[0];
  return row?.content?.trim() ? row : null;
}

export async function deleteSnapshot(documentId: string): Promise<void> {
  const database = await getDb();
  await database.execute(
    "DELETE FROM document_snapshots WHERE document_id = $1",
    [documentId],
  );
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
  if (goodVersion) return { content: goodVersion.content, title: goodVersion.title, source: "version" };

  return null;
}
