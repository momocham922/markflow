/**
 * In-memory database adapter for browser/test environments.
 * Implements the same interface as @tauri-apps/plugin-sql Database
 * using simple Map/Array storage with basic SQL parsing.
 */

interface Table {
  columns: string[];
  rows: Record<string, unknown>[];
}

export class MemoryDatabase {
  private tables = new Map<string, Table>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(query: string, bindValues?: unknown[]): Promise<any> {
    const q = query.trim();

    if (q.toUpperCase().startsWith("CREATE TABLE")) {
      const match = q.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)\s*\(/i);
      if (match && !this.tables.has(match[1])) {
        this.tables.set(match[1], { columns: [], rows: [] });
      }
      return { rowsAffected: 0 };
    }

    if (q.toUpperCase().startsWith("CREATE INDEX")) {
      return { rowsAffected: 0 };
    }

    if (q.toUpperCase().startsWith("ALTER TABLE")) {
      return { rowsAffected: 0 };
    }

    if (q.toUpperCase().startsWith("INSERT")) {
      return this.handleInsert(q, bindValues || []);
    }

    if (q.toUpperCase().startsWith("DELETE")) {
      return this.handleDelete(q, bindValues || []);
    }

    if (q.toUpperCase().startsWith("UPDATE")) {
      return { rowsAffected: 0 };
    }

    return { rowsAffected: 0 };
  }

  async select<T>(query: string, bindValues?: unknown[]): Promise<T> {
    const q = query.trim().toUpperCase();
    const tableMatch = query.match(/FROM\s+(\w+)/i);
    if (!tableMatch) return [] as unknown as T;

    const tableName = tableMatch[1];
    const table = this.tables.get(tableName);
    if (!table) return [] as unknown as T;

    let rows = [...table.rows];

    // Handle WHERE clause with $N parameters
    const whereMatch = query.match(/WHERE\s+(\w+)\s*=\s*\$(\d+)/i);
    if (whereMatch && bindValues) {
      const col = whereMatch[1];
      const paramIdx = parseInt(whereMatch[2]) - 1;
      const value = bindValues[paramIdx];
      rows = rows.filter((r) => r[col] === value);
    }

    // Handle ORDER BY
    const orderMatch = query.match(/ORDER BY\s+(\w+)\s+(ASC|DESC)/i);
    if (orderMatch) {
      const col = orderMatch[1];
      const dir = orderMatch[2].toUpperCase();
      rows.sort((a, b) => {
        const av = a[col] as number;
        const bv = b[col] as number;
        return dir === "DESC" ? bv - av : av - bv;
      });
    }

    // Handle SELECT specific columns
    if (!q.includes("SELECT *")) {
      const colMatch = query.match(/SELECT\s+(.+?)\s+FROM/i);
      if (colMatch) {
        const cols = colMatch[1].split(",").map((c) => c.trim());
        rows = rows.map((r) => {
          const obj: Record<string, unknown> = {};
          for (const col of cols) {
            obj[col] = r[col];
          }
          return obj;
        });
      }
    }

    return rows as unknown as T;
  }

  private handleInsert(query: string, bindValues: unknown[]) {
    const tableMatch = query.match(/INSERT\s+INTO\s+(\w+)/i);
    if (!tableMatch) return { rowsAffected: 0 };

    const tableName = tableMatch[1];
    if (!this.tables.has(tableName)) {
      this.tables.set(tableName, { columns: [], rows: [] });
    }
    const table = this.tables.get(tableName)!;

    // Parse column names
    const colMatch = query.match(/\(([^)]+)\)\s*VALUES/i);
    if (!colMatch) return { rowsAffected: 0 };
    const columns = colMatch[1].split(",").map((c) => c.trim());

    // Build row from bind values
    const row: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = bindValues[i] ?? null;
    }

    // Handle ON CONFLICT (upsert)
    const hasConflict = query.toUpperCase().includes("ON CONFLICT");
    if (hasConflict) {
      // Find the primary key (first column typically)
      const pkCol = columns[0];
      const existingIdx = table.rows.findIndex((r) => r[pkCol] === row[pkCol]);
      if (existingIdx >= 0) {
        // Update existing row
        Object.assign(table.rows[existingIdx], row);
        return { rowsAffected: 1 };
      }
    }

    table.rows.push(row);
    return { rowsAffected: 1, lastInsertId: table.rows.length };
  }

  private handleDelete(query: string, bindValues: unknown[]) {
    const tableMatch = query.match(/DELETE\s+FROM\s+(\w+)/i);
    if (!tableMatch) return { rowsAffected: 0 };

    const tableName = tableMatch[1];
    const table = this.tables.get(tableName);
    if (!table) return { rowsAffected: 0 };

    const whereMatch = query.match(/WHERE\s+(\w+)\s*=\s*\$(\d+)/i);
    if (whereMatch && bindValues) {
      const col = whereMatch[1];
      const paramIdx = parseInt(whereMatch[2]) - 1;
      const value = bindValues[paramIdx];
      const before = table.rows.length;
      table.rows = table.rows.filter((r) => r[col] !== value);
      return { rowsAffected: before - table.rows.length };
    }

    return { rowsAffected: 0 };
  }

  static async load(_path: string): Promise<MemoryDatabase> {
    return new MemoryDatabase();
  }
}
