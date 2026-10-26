// Domain persistence boundary. The local adapter uses existing SQLite tables;
// Sites supplies a leased CloudScope whose journal is checkpointed to D1.
export function supplyPersistence(store) {
  if (typeof store.syncEvents === "function") return store;
  return {
    ensureSyncSchema() {
      store.db.exec("CREATE TABLE IF NOT EXISTS assembly_sync_events (id TEXT PRIMARY KEY,action TEXT NOT NULL,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,delivered_at INTEGER,last_error TEXT)");
      store.db.exec("CREATE INDEX IF NOT EXISTS assembly_sync_due ON assembly_sync_events(delivered_at,next_attempt_at)");
      const columns = new Set(store.db.prepare("PRAGMA table_info(assembly_sync_events)").all().map((row) => row.name));
      for (const column of ["payload", "outcome", "receipt"]) if (!columns.has(column)) store.db.exec(`ALTER TABLE assembly_sync_events ADD COLUMN ${column} TEXT`);
    },
    ensureTransferSchema() {
      store.db.exec("CREATE TABLE IF NOT EXISTS assembly_transfer_previews (id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,payload TEXT NOT NULL)");
    },
    transferPreview(id) { return store.db.prepare("SELECT * FROM assembly_transfer_previews WHERE id=?").get(id) || null; },
    saveTransferPreview(id, expiresAt, payload) { store.db.prepare("INSERT INTO assembly_transfer_previews VALUES(?,?,?)").run(id, expiresAt, payload); },
    expireTransferPreviews(before) { store.db.prepare("DELETE FROM assembly_transfer_previews WHERE expires_at<?").run(before); },
    syncEvent(id) { return store.db.prepare("SELECT * FROM assembly_sync_events WHERE id=?").get(id) || null; },
    syncEvents() { return store.db.prepare("SELECT * FROM assembly_sync_events ORDER BY created_at,id").all(); },
    saveSyncEvent(row) {
      store.db.prepare("INSERT INTO assembly_sync_events(id,action,created_at,attempts,next_attempt_at,delivered_at,last_error,payload,outcome,receipt) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,delivered_at=excluded.delivered_at,last_error=excluded.last_error,payload=excluded.payload,outcome=excluded.outcome,receipt=excluded.receipt")
        .run(row.id, row.action, row.created_at, row.attempts || 0, row.next_attempt_at, row.delivered_at ?? null, row.last_error ?? null, row.payload ?? null, row.outcome ?? null, row.receipt ?? null);
    },
    saveSyncEvents(events) {
      store.db.exec("BEGIN IMMEDIATE");
      try { for (const row of events) this.saveSyncEvent(row); store.db.exec("COMMIT"); }
      catch (error) { store.db.exec("ROLLBACK"); throw error; }
    },
    recoverableRollOperations() { return store.db.prepare("SELECT id,action,status FROM roll_supply_operations WHERE status IN ('verified','verified_with_calculation_errors')").all(); },
  };
}
