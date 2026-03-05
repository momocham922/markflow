import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load("sqlite:markflow.db");
  }
  return db;
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
}): Promise<void> {
  const database = await getDb();
  const folder = doc.folder ?? "/";
  const tags = JSON.stringify(doc.tags ?? []);
  await database.execute(
    `INSERT INTO documents (id, title, content, created_at, updated_at, is_dirty, folder, tags)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
     ON CONFLICT(id) DO UPDATE SET
       title = $2, content = $3, updated_at = $5, is_dirty = 1, folder = $6, tags = $7`,
    [doc.id, doc.title, doc.content, doc.createdAt, doc.updatedAt, folder, tags],
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
