import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { createDatabase, camelRows, type SqlStore } from "./database";
export async function openDatabase(path = ":memory:") {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _av2_dev_migrations (name TEXT PRIMARY KEY)",
  );
  const directory = new URL("../drizzle/", import.meta.url);
  for (const file of (await readdir(directory))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (
      sqlite
        .prepare("SELECT name FROM _av2_dev_migrations WHERE name=?")
        .get(file)
    )
      continue;
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(await readFile(new URL(file, directory), "utf8"));
      sqlite
        .prepare("INSERT INTO _av2_dev_migrations(name) VALUES(?)")
        .run(file);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  const store: SqlStore = {
    async readBatch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) =>
          camelRows<Record<string, unknown>>(
            sqlite.prepare(s.sql).all(...s.args),
          ),
        );
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async all<T>(sql: string, args: (string | number | null)[] = []) {
      return camelRows<T>(sqlite.prepare(sql).all(...args));
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const s of statements) sqlite.prepare(s.sql).run(...s.args);
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { ...createDatabase(store), sqlite, store };
}
