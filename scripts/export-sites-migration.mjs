import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function exportMigration({ database, privateConfig, outputDirectory }) {
  const root = realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const output = path.resolve(outputDirectory);
  const relative = path.relative(root, output);
  if (!relative || (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) throw new Error("Migration data must stay outside the source repository");
  mkdirSync(output, { recursive: true });
  if (["ritm-before-sites.sqlite", "operational-state.json", "inventory.json"].some((name) => existsSync(path.join(output, name)))) throw new Error("Use a new migration output directory; existing backups must be preserved");
  const live = new DatabaseSync(realpathSync(database), { readOnly: true });
  const backupFile = path.join(output, "ritm-before-sites.sqlite");
  try { await backup(live, backupFile); } finally { live.close(); }
  // Export the consistent online backup, never an actively changing DB/WAL pair.
  const db = new DatabaseSync(backupFile, { readOnly: true });
  try {
    if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("Backup integrity check failed");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const sourceKeys = ["seasonalPrintingId", "rollPrintingId", "boxPrintingId", "catalogId", "fboSourceId", "assemblyDatabaseId"];
    const config = JSON.parse(readFileSync(privateConfig, "utf8").replace(/^\uFEFF/, ""));
    const sources = Object.fromEntries(sourceKeys.map((key) => [key, config.googleSources?.[key]]));
    if (Object.values(sources).some((id) => !/^[A-Za-z0-9_-]{20,100}$/.test(id || ""))) throw new Error("All production source identities must be known before export");
    const metadata = Object.fromEntries(db.prepare("SELECT key,value FROM metadata").all().filter((row) => ["productionSupplies", "productionSupplyOperations", "rollPrintingAdditionalSheets"].includes(row.key)).map((row) => [row.key, JSON.parse(row.value)]));
    const rollOperations = tables.has("roll_supply_operations") ? db.prepare("SELECT * FROM roll_supply_operations ORDER BY created_at,id").all().map((row) => ({ id: row.id, action: row.action, requestHash: row.request_hash, status: row.status, payload: JSON.parse(row.payload), createdAt: row.created_at, updatedAt: row.updated_at, result: row.result ? JSON.parse(row.result) : null })) : [];
    const syncEvents = tables.has("assembly_sync_events") ? db.prepare("SELECT * FROM assembly_sync_events ORDER BY created_at,id").all().map((row) => ({ ...row })) : [];
    const transferPreviews = tables.has("assembly_transfer_previews") ? db.prepare("SELECT * FROM assembly_transfer_previews").all().map((row) => ({ ...row })) : [];
    const pendingWrites = [];
    for (const [table, states] of [["test_repair_proposals", ["queued", "executing", "checking", "uncertain"]], ["source_recovery_operations", ["repairing", "checking", "uncertain", "written_unverified"]]]) {
      if (tables.has(table)) for (const row of db.prepare(`SELECT id,status,${table === "test_repair_proposals" ? "payload" : "target"} AS target_data FROM ${table} WHERE status IN (${states.map(() => "?").join(",")})`).all(...states)) {
        let target;
        try { target = JSON.parse(row.target_data || "{}"); target = target.target || target; } catch { target = {}; }
        pendingWrites.push({ table, id: row.id, status: row.status, documentId: target.documentId || null });
      }
    }
    const snapshots = db.prepare("SELECT id,at,payload FROM snapshots WHERE id IN ('assembly-fbo','printing-seasonal')").all().map((row) => ({ kind: row.id === "assembly-fbo" ? "assembly" : "printing", at: row.at, value: JSON.parse(row.payload) }));
    const payload = { sources, metadata, rollOperations, syncEvents, transferPreviews, pendingWrites, snapshots };
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const envelope = { format: "ritm-sites-migration", version: 1, id: randomUUID(), createdAt: new Date().toISOString(), digest, payload };
    const artifact = path.join(output, "operational-state.json");
    writeFileSync(artifact, JSON.stringify(envelope), { flag: "wx", mode: 0o600 });
    const inventory = [...tables].filter((name) => /^[a-z_]+$/.test(name) && !name.startsWith("sqlite_")).map((name) => ({ table: name, rows: Number(db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n) }));
    writeFileSync(path.join(output, "inventory.json"), JSON.stringify({ capturedAt: envelope.createdAt, backupFile, artifact, digest, tables: inventory }, null, 2), { flag: "wx", mode: 0o600 });
    return { backupFile, artifact, digest, tables: inventory.length, productionSupplies: metadata.productionSupplies?.length || 0, productionOperations: metadata.productionSupplyOperations?.length || 0, rollOperations: rollOperations.length, syncEvents: syncEvents.length, pendingWrites: pendingWrites.length, snapshots: snapshots.length };
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => index % 2 === 0 ? [value, all[index + 1]] : null).filter(Boolean));
  if (!args["--database"] || !args["--private-config"] || !args["--output-directory"]) throw new Error("Use --database, --private-config and --output-directory with absolute paths");
  console.log(JSON.stringify(await exportMigration({ database: args["--database"], privateConfig: args["--private-config"], outputDirectory: args["--output-directory"] }), null, 2));
}
