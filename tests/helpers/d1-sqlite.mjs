import { DatabaseSync } from "node:sqlite";
export class LocalD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  withSession() { return this; }
  prepare(sql) {
    const db = this.db;
    const wrap = (bindings = []) => ({
      bind(...values) { return wrap(values); },
      async first(column) { const row = db.prepare(sql).get(...bindings); return row ? column ? row[column] : { ...row } : null; },
      async all() { return { success: true, results: db.prepare(sql).all(...bindings).map((row) => ({ ...row })) }; },
      async run() { const result = db.prepare(sql).run(...bindings); return { success: true, meta: { changes: Number(result.changes) } }; },
    });
    return wrap();
  }
  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = [];
      for (const statement of statements) {
        // SQLite all() also executes writes and exposes RETURNING when present.
        const value = await statement.all();
        const changes = this.db.prepare("SELECT changes() AS n").get().n;
        result.push({ ...value, meta: { changes } });
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async exec(sql) { this.db.exec(sql); }
  close() { this.db.close(); }
}
