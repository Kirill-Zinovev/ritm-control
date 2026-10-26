// Local owner maintenance helper. Does not read credentials or call Google/Telegram.
import { DatabaseSync, backup } from "node:sqlite";

const [action, file, copyFile, pid] = process.argv.slice(2);
if (
  !["backup", "verify", "release"].includes(action) ||
  !file ||
  !copyFile ||
  !/^\d+$/.test(pid || "")
)
  throw new Error("Invalid maintenance parameters");

function hasTable(db, name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function activeSourceRecoveries(db) {
  return hasTable(db, "source_recovery_operations")
    ? db
        .prepare(
          "SELECT count(*) AS n FROM source_recovery_operations WHERE status IN ('repairing','checking')",
        )
        .get().n
    : 0;
}

if (action === "backup") {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const agent = JSON.parse(
      db.prepare("SELECT value FROM metadata WHERE key='agent'").get().value,
    );
    if (agent.pid !== Number(pid))
      throw new Error("Database does not belong to verified main process");
    const hasRepairQueue = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_repair_proposals'",
      )
      .get();
    if (
      (hasRepairQueue &&
        db
          .prepare(
            "SELECT count(*) AS n FROM test_repair_proposals WHERE status IN ('queued','executing','checking')",
          )
          .get().n) ||
      activeSourceRecoveries(db)
    )
      throw new Error(
        "Repair queue is active: a production or test repair operation is active; backup and restart are refused",
      );
    await backup(db, copyFile);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(copyFile, { readOnly: true });
  try {
    if (copy.prepare("PRAGMA quick_check").get().quick_check !== "ok")
      throw new Error("Backup verification failed");
  } finally {
    copy.close();
  }
} else if (action === "verify") {
  const live = new DatabaseSync(file, { readOnly: true });
  const previous = new DatabaseSync(copyFile, { readOnly: true });
  try {
    const liveCheck = live.prepare("PRAGMA quick_check").get().quick_check,
      backupCheck = previous.prepare("PRAGMA quick_check").get().quick_check,
      agent = JSON.parse(
        live.prepare("SELECT value FROM metadata WHERE key='agent'").get()
          .value,
      ),
      specifications = [
        {
          table: "history",
          keys: ["id"],
          columns: ["id", "at", "type", "message", "incident_id"],
        },
        { table: "incidents", keys: ["id"], columns: ["id"] },
        {
          table: "formula_protected",
          keys: ["source_id", "gid", "cell"],
          columns: [
            "source_id",
            "gid",
            "cell",
            "formula",
            "merge_signature",
            "region_id",
            "version",
          ],
        },
        {
          table: "formula_versions",
          keys: ["version"],
          columns: ["version", "region_id", "at", "hex(payload) AS payload"],
        },
        {
          table: "formula_decisions",
          keys: ["id"],
          columns: ["id", "at", "action", "payload"],
        },
        {
          table: "repair_requests",
          keys: ["id"],
          columns: [
            "id",
            "incident_id",
            "generation",
            "at",
            "status",
            "payload",
          ],
        },
        {
          table: "test_repair_proposals",
          keys: ["id"],
          columns: ["id", "incident_id", "version", "payload"],
        },
        {
          table: "test_repair_events",
          keys: ["id"],
          columns: ["id", "proposal_id", "at", "type", "payload"],
        },
        {
          table: "source_recovery_operations",
          keys: ["id"],
          columns: [
            "id",
            "request_id",
            "incident_id",
            "generation",
            "status",
            "created_at",
            "updated_at",
            "owner",
            "target",
            "approved_value",
            "authorization",
            "before_value",
            "after_value",
            "result",
          ],
          optional: true,
        },
      ],
      tables = {};
    for (const spec of specifications) {
      if (spec.optional && !hasTable(previous, spec.table)) {
        const currentCount = hasTable(live, spec.table)
          ? live.prepare(`SELECT count(*) AS n FROM ${spec.table}`).get().n
          : 0;
        tables[spec.table] = {
          backupRows: 0,
          missing: 0,
          changed: 0,
          currentRows: currentCount,
        };
        continue;
      }
      const projection = spec.columns.join(","),
        keyClause = spec.keys.map((key) => `${key}=?`).join(" AND "),
        oldRows = previous
          .prepare(`SELECT ${projection} FROM ${spec.table}`)
          .iterate(),
        lookup = live.prepare(
          `SELECT ${projection} FROM ${spec.table} WHERE ${keyClause}`,
        ),
        result = { backupRows: 0, missing: 0, changed: 0 };
      for (const row of oldRows) {
        result.backupRows++;
        const current = lookup.get(...spec.keys.map((key) => row[key]));
        if (!current) result.missing++;
        else if (JSON.stringify(current) !== JSON.stringify(row))
          result.changed++;
      }
      tables[spec.table] = result;
    }
    const hasRepairQueue = live
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_repair_proposals'",
        )
        .get(),
      activeQueue = hasRepairQueue
        ? live
            .prepare(
              "SELECT count(*) AS n FROM test_repair_proposals WHERE status IN ('queued','executing','checking')",
            )
            .get().n
        : 0,
      activeSourceRecovery = activeSourceRecoveries(live),
      repairWrites = hasRepairQueue
        ? {
            before: previous
              .prepare(
                "SELECT count(*) AS n FROM test_repair_events WHERE type='repair_write_started'",
              )
              .get().n,
            after: live
              .prepare(
                "SELECT count(*) AS n FROM test_repair_events WHERE type='repair_write_started'",
              )
              .get().n,
          }
        : { before: 0, after: 0 },
      passed =
        liveCheck === "ok" &&
        backupCheck === "ok" &&
        agent.pid === Number(pid) &&
        Object.values(tables).every(
          (result) => result.missing === 0 && result.changed === 0,
        ) &&
        activeQueue === 0 &&
        activeSourceRecovery === 0 &&
        repairWrites.before === repairWrites.after;
    console.log(
      JSON.stringify(
        {
          passed,
          liveCheck,
          backupCheck,
          activeAgentPid: agent.pid,
          tables,
          activeQueue,
          activeSourceRecovery,
          repairWriteStarted: repairWrites,
        },
        null,
        2,
      ),
    );
    if (!passed) process.exitCode = 1;
  } finally {
    live.close();
    previous.close();
  }
} else {
  const previous = new DatabaseSync(copyFile, { readOnly: true });
  const previousLease = previous
    .prepare("SELECT owner FROM lease WHERE id=1")
    .get();
  previous.close();
  const db = new DatabaseSync(file);
  db.exec("BEGIN IMMEDIATE");
  try {
    const agent = JSON.parse(
      db.prepare("SELECT value FROM metadata WHERE key='agent'").get().value,
    );
    const lease = db.prepare("SELECT owner FROM lease WHERE id=1").get();
    if (activeSourceRecoveries(db))
      throw new Error("Source recovery is active; lease release is refused");
    if (
      (agent.pid !== Number(pid) && agent.status !== "stopped") ||
      (lease && lease.owner !== previousLease?.owner)
    )
      throw new Error("Agent identity changed; lease retained");
    db.prepare("DELETE FROM lease WHERE id=1").run();
    db.prepare("INSERT INTO history(at,type,message) VALUES(?,?,?)").run(
      new Date().toISOString(),
      "maintenance_restart",
      "Перезапуск существующего задания после проверенной резервной копии; производственные данные не изменялись",
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }
}
