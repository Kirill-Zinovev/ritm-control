import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export function fingerprint(scope, finding) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope,
        finding.sourceId || "",
        finding.sheet || "",
        finding.cell || "",
        finding.type,
      ]),
    )
    .digest("hex");
}
export class IncidentStore {
  constructor(file) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.function("ritm_fold", (value) =>
      String(value ?? "").toLocaleLowerCase("ru-RU"),
    );
    this.db.exec(
      [
        "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
        "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);",
        "CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY,scope TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,resolved_at TEXT,occurrences INTEGER NOT NULL,generation INTEGER NOT NULL);",
        "CREATE INDEX IF NOT EXISTS incidents_scope ON incidents(scope,status);",
        "CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,type TEXT NOT NULL,message TEXT NOT NULL,incident_id TEXT);",
        "CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY,at TEXT NOT NULL,payload TEXT NOT NULL);",
        "CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY,at TEXT NOT NULL,payload TEXT NOT NULL);",
        "CREATE TABLE IF NOT EXISTS recommendations (id TEXT PRIMARY KEY,at TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL);",
        "CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL);",
        "CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires INTEGER NOT NULL);",
      ].join("\n"),
    );
    if (
      !this.db
        .prepare("PRAGMA table_info(incidents)")
        .all()
        .some((c) => c.name === "workflow")
    )
      this.db.exec("ALTER TABLE incidents ADD COLUMN workflow TEXT");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS repair_requests (id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,generation INTEGER NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL); PRAGMA user_version=2;",
    );
  }
  recoverNotifications() {
    const result = this.db
      .prepare("UPDATE outbox SET status='uncertain' WHERE status='sending'")
      .run();
    if (result.changes)
      this.log(
        "notification_uncertain",
        "После аварии результат отправки неизвестен; повторная отправка заблокирована",
      );
  }
  meta(key, value) {
    if (value === undefined) {
      const r = this.db
        .prepare("SELECT value FROM metadata WHERE key=?")
        .get(key);
      return r ? JSON.parse(r.value) : null;
    }
    this.db
      .prepare(
        "INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  acquire(owner, now = Date.now(), ttl = 90000) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM lease WHERE id=1").get();
      if (row && row.owner !== owner && row.expires > now) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          "INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires",
        )
        .run(owner, now + ttl);
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  release(owner) {
    this.db.prepare("DELETE FROM lease WHERE owner=?").run(owner);
  }
  log(type, message, incidentId = null, at = new Date().toISOString()) {
    this.db
      .prepare(
        "INSERT INTO history(at,type,message,incident_id) VALUES(?,?,?,?)",
      )
      .run(at, type, message, incidentId);
  }
  reconcile(
    scope,
    findings,
    { verified = true, at = new Date().toISOString() } = {},
  ) {
    const seen = new Set(),
      created = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const f of findings) {
        const id = fingerprint(scope, f);
        seen.add(id);
        const old = this.db
          .prepare("SELECT * FROM incidents WHERE id=?")
          .get(id);
        const reopen = old?.status === "resolved";
        const generation = old ? old.generation + (reopen ? 1 : 0) : 1;
        this.db
          .prepare(
            "INSERT INTO incidents(id,scope,payload,status,first_seen,last_seen,resolved_at,occurrences,generation) VALUES(?,?,?,'open',?,?,NULL,1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,status='open',last_seen=excluded.last_seen,resolved_at=NULL,occurrences=incidents.occurrences+1,generation=excluded.generation",
          )
          .run(
            id,
            scope,
            JSON.stringify(f),
            old?.first_seen || at,
            at,
            generation,
          );
        if (f.kind === "table_doctor") {
          const workflow =
            old?.workflow === "ignored" && !reopen
              ? "ignored"
              : !old || reopen
                ? f.initialStatus || "review"
                : f.verification === "rule_confirmed"
                  ? "confirmed"
                  : "review";
          this.db
            .prepare("UPDATE incidents SET workflow=? WHERE id=?")
            .run(workflow, id);
          if (old && !reopen && workflow !== old.workflow)
            this.log("incident_state", "Статус проверки: " + workflow, id, at);
        }
        if (!old || reopen) {
          this.log(
            reopen ? "incident_reopened" : "incident_detected",
            f.title,
            id,
            at,
          );
          if (
            f.kind !== "table_doctor" ||
            (f.verification === "rule_confirmed" && !f.demonstration)
          )
            this.db
              .prepare(
                "INSERT OR IGNORE INTO outbox(id,incident_id,status,next_at) VALUES(?,?,'pending',?)",
              )
              .run(id + ":" + generation, id, at);
          created.push(id);
        }
        if (
          old &&
          !reopen &&
          f.kind === "table_doctor" &&
          f.verification === "rule_confirmed" &&
          !f.demonstration &&
          old.workflow !== "ignored"
        )
          this.db
            .prepare(
              "INSERT OR IGNORE INTO outbox(id,incident_id,status,next_at) VALUES(?,?,\'pending\',?)",
            )
            .run(id + ":" + generation, id, at);
      }
      if (verified) {
        const active = this.db
          .prepare("SELECT id FROM incidents WHERE scope=? AND status='open'")
          .all(scope);
        for (const old of active)
          if (!seen.has(old.id)) {
            this.db
              .prepare(
                "UPDATE incidents SET status='resolved',resolved_at=?,last_seen=?,workflow=CASE WHEN workflow IS NULL THEN NULL ELSE 'fixed' END WHERE id=?",
              )
              .run(at, at, old.id);
            this.db
              .prepare(
                "UPDATE outbox SET status='cancelled' WHERE incident_id=? AND status='pending'",
              )
              .run(old.id);
            this.log(
              "incident_resolved",
              "Повторная успешная проверка больше не обнаружила проблему",
              old.id,
              at,
            );
          }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return created;
  }
  snapshot(id, payload, at = new Date().toISOString()) {
    this.db
      .prepare(
        "INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,payload=excluded.payload",
      )
      .run(id, at, JSON.stringify(payload));
  }
  getSnapshot(id) {
    const row = this.db.prepare("SELECT * FROM snapshots WHERE id=?").get(id);
    return row ? { at: row.at, value: JSON.parse(row.payload) } : null;
  }
  check(id, payload, at = new Date().toISOString()) {
    this.db
      .prepare(
        "INSERT INTO checks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,payload=excluded.payload",
      )
      .run(id, at, JSON.stringify(payload));
  }
  recommend(id, payload, at = new Date().toISOString()) {
    const exists = this.db
      .prepare("SELECT id FROM recommendations WHERE id=?")
      .get(id);
    this.db
      .prepare(
        "INSERT INTO recommendations VALUES(?,?,?,'new') ON CONFLICT(id) DO UPDATE SET at=excluded.at,payload=excluded.payload",
      )
      .run(id, at, JSON.stringify(payload));
    if (!exists) this.log("recommendation", payload.title, null, at);
  }
  listIncidents({
    department = "",
    source = "",
    severity = "",
    status = "",
    search = "",
    kind = "",
    type = "",
    page = 0,
    limit = 20,
  } = {}) {
    const clauses = [],
      params = [];
    for (const [name, val] of [
      ["department", department],
      ["sourceId", source],
      ["severity", severity],
      ["kind", kind],
      ["type", type],
    ]) {
      if (val) {
        clauses.push("json_extract(payload,'$." + name + "')=?");
        params.push(val);
      }
    }
    if (status) {
      clauses.push(
        ["open", "resolved"].includes(status)
          ? "status=?"
          : "COALESCE(workflow,status)=?",
      );
      params.push(status);
    }
    if (search) {
      clauses.push("instr(ritm_fold(payload),ritm_fold(?))>0");
      params.push(search);
    }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const total = this.db
      .prepare("SELECT count(*) AS n FROM incidents" + where)
      .get(...params).n;
    const safePage = Math.min(page, Math.max(0, Math.ceil(total / limit) - 1));
    const rows = this.db
      .prepare(
        "SELECT * FROM incidents" +
          where +
          " ORDER BY last_seen DESC,id LIMIT ? OFFSET ?",
      )
      .all(...params, limit, safePage * limit);
    return {
      total,
      page: safePage,
      limit,
      rows: rows.map((r) => this.incident(r)),
    };
  }
  incident(row) {
    return {
      ...JSON.parse(row.payload),
      id: row.id,
      status: row.workflow || row.status,
      monitorStatus: row.status,
      repairRequested: !!this.db
        .prepare(
          "SELECT id FROM repair_requests WHERE incident_id=? AND generation=?",
        )
        .get(row.id, row.generation),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      resolvedAt: row.resolved_at,
      occurrences: row.occurrences,
    };
  }
  getIncident(id) {
    const r = this.db.prepare("SELECT * FROM incidents WHERE id=?").get(id);
    return r ? this.incident(r) : null;
  }
  overview() {
    const checks = this.db
      .prepare("SELECT * FROM checks ORDER BY id")
      .all()
      .map((r) => ({ id: r.id, at: r.at, ...JSON.parse(r.payload) }));
    const active = this.db
      .prepare(
        "SELECT count(*) AS n FROM incidents WHERE status='open' AND COALESCE(workflow,'')!='ignored' AND COALESCE(json_extract(payload,'$.demonstration'),0)=0",
      )
      .get().n;
    const resolved = this.db
      .prepare(
        "SELECT count(*) AS n FROM incidents WHERE status='resolved' AND COALESCE(json_extract(payload,'$.demonstration'),0)=0",
      )
      .get().n;
    const recommendations = this.db
      .prepare("SELECT * FROM recommendations ORDER BY at DESC")
      .all()
      .map((r) => ({
        id: r.id,
        at: r.at,
        status: r.status,
        ...JSON.parse(r.payload),
      }));
    return {
      agent: this.meta("agent"),
      lastCheck: this.meta("lastCheck"),
      checks,
      active,
      resolved,
      demoActive: this.db
        .prepare(
          "SELECT count(*) n FROM incidents WHERE status=\'open\' AND COALESCE(workflow,\'\')!=\'ignored\' AND json_extract(payload,\'$.demonstration\')=1",
        )
        .get().n,
      corrections: 0,
      recommendations,
    };
  }
  history(page = 0, limit = 20) {
    const total = this.db.prepare("SELECT count(*) AS n FROM history").get().n;
    const safePage = Math.min(page, Math.max(0, Math.ceil(total / limit) - 1));
    return {
      total,
      page: safePage,
      limit,
      rows: this.db
        .prepare(
          "SELECT id,at,type,message,incident_id AS incidentId FROM history ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(limit, safePage * limit),
    };
  }
  incidentAction(id, action, at = new Date().toISOString()) {
    const row = this.db.prepare("SELECT * FROM incidents WHERE id=?").get(id);
    if (
      !row ||
      JSON.parse(row.payload).kind !== "table_doctor" ||
      row.status !== "open"
    )
      return null;
    if (!["request-repair", "ignore"].includes(action))
      throw new Error("Unsupported action");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (action === "ignore") {
        this.db
          .prepare("UPDATE incidents SET workflow=\'ignored\' WHERE id=?")
          .run(id);
        this.db
          .prepare(
            "UPDATE outbox SET status=\'cancelled\' WHERE incident_id=? AND status=\'pending\'",
          )
          .run(id);
        this.log(
          "incident_ignored",
          "Владелец игнорирует проблему; таблица не изменена",
          id,
          at,
        );
      } else {
        const requestId = id + ":" + row.generation;
        const change = this.db
          .prepare(
            "INSERT OR IGNORE INTO repair_requests VALUES(?,?,?, ?,\'pending\',?)",
          )
          .run(requestId, id, row.generation, at, row.payload);
        if (change.changes)
          this.log(
            "repair_requested",
            "Создана заявка на будущее исправление; Google Sheets не изменён",
            id,
            at,
          );
      }
      this.db.exec("COMMIT");
      return this.getIncident(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
