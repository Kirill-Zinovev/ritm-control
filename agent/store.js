import { scopeAllows } from "./monitorScope.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ownerSourceCandidate } from "./sourceCandidate.js";
import { incidentBaseFilters } from "./incidentFilters.js";
import { groupActiveIncidents } from "./incidentGrouping.js";

const FORMULA_REPAIR_TYPES = new Set([
  "formula_number",
  "formula_text",
  "formula_missing",
  "formula_mismatch",
]);

function approvedFormulaCandidate(db, row, incident) {
  if (!row.scope.startsWith("doctor:formula:")) return null;
  const blocked = (reason) => ({
    status: "blocked",
    kind: "approved_formula",
    reason,
  });
  if (row.status !== "open" || ["ignored", "excepted"].includes(row.workflow) || incident.demonstration)
    return blocked("Инцидент закрыт, проигнорирован или является демонстрационным.");
  if (!FORMULA_REPAIR_TYPES.has(incident.type))
    return blocked("Этот тип отклонения не поддерживает безопасную замену формулы.");
  if (incident.verification !== "rule_confirmed")
    return blocked("Нарушение формулы не подтверждено текущим правилом.");
  if (!incident.sourceId || !Number.isInteger(incident.gid) || !/^[A-Z]{1,3}\d{1,7}$/.test(incident.cell || ""))
    return blocked("Для этой формулы не указан полный точный адрес в Google Sheets.");
  if (!incident.baselineVersion || !incident.formulaRegionId)
    return blocked("В инциденте нет версии утверждённого эталона.");
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='formula_protected'")
    .get();
  if (!table) return blocked("Таблица утверждённых формул пока не загружена.");
  const baseline = db
    .prepare(
      "SELECT formula,version,region_id FROM formula_protected WHERE source_id=? AND gid=? AND cell=?",
    )
    .get(incident.sourceId, incident.gid, incident.cell);
  if (!baseline)
    return blocked("Утверждённый эталон этой ячейки удалён или не найден.");
  if (
    baseline.version !== incident.baselineVersion ||
    baseline.region_id !== incident.formulaRegionId ||
    baseline.formula !== incident.expected ||
    typeof baseline.formula !== "string" ||
    !baseline.formula.startsWith("=")
  )
    return blocked("Версия эталона изменилась или не совпадает с инцидентом; нужна новая проверка.");
  return {
    status: "candidate",
    kind: "approved_formula",
    value: { formulaValue: baseline.formula },
    version: baseline.version,
    evidence: `Утверждённая формула Formula Intelligence · версия ${baseline.version.slice(0, 12)}`,
    regionId: baseline.region_id,
  };
}

export function fingerprint(scope, finding) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope,
        finding.sourceId || "",
        finding.sheet || "",
        finding.cell || "",
        finding.type,
        ...(scope.startsWith("doctor:policy:") && finding.observationId
          ? [finding.observationId]
          : []),
        ...(scope.startsWith("doctor:formula:") && finding.baselineVersion
          ? [finding.baselineVersion]
          : []),
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
      "CREATE TABLE IF NOT EXISTS repair_requests (id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,generation INTEGER NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS source_recovery_operations (id TEXT PRIMARY KEY,request_id TEXT NOT NULL,incident_id TEXT NOT NULL,generation INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,owner TEXT NOT NULL,target TEXT NOT NULL,approved_value TEXT NOT NULL,authorization TEXT NOT NULL,before_value TEXT,after_value TEXT,result TEXT);" +
        "CREATE INDEX IF NOT EXISTS source_recovery_incident ON source_recovery_operations(incident_id,created_at);" +
        "CREATE TABLE IF NOT EXISTS roll_supply_operations (id TEXT PRIMARY KEY,action TEXT NOT NULL,status TEXT NOT NULL,request_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,result TEXT);" +
        "CREATE INDEX IF NOT EXISTS roll_supply_operations_updated ON roll_supply_operations(updated_at DESC);" +
        "PRAGMA user_version=3;",
    );
  }
  setMonitoringScope(documents, sources = [], at = new Date().toISOString()) {
    this.monitoringDocuments = documents;
    this.monitoringSources = sources;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.db
        .prepare("SELECT * FROM incidents WHERE status='open'")
        .all()) {
        if (scopeAllows(JSON.parse(row.payload), documents, sources)) continue;
        this.db
          .prepare(
            "UPDATE incidents SET status='out_of_scope',workflow='out_of_scope' WHERE id=?",
          )
          .run(row.id);
        this.db
          .prepare(
            "UPDATE outbox SET status='cancelled' WHERE incident_id=? AND status='pending'",
          )
          .run(row.id);
        this.log(
          "incident_out_of_scope",
          "Вне области мониторинга: лист исключён владельцем; исправление не выполнялось",
          row.id,
          at,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
  rollSupplyOperation(id) {
    const row = this.db
      .prepare("SELECT * FROM roll_supply_operations WHERE id=?")
      .get(id);
    return row
      ? {
          id: row.id,
          action: row.action,
          status: row.status,
          requestHash: row.request_hash,
          payload: JSON.parse(row.payload),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          result: row.result ? JSON.parse(row.result) : null,
        }
      : null;
  }
  beginRollSupplyOperation(id, action, requestHash, payload, at) {
    const existing = this.rollSupplyOperation(id);
    if (existing) return existing;
    this.db
      .prepare(
        "INSERT INTO roll_supply_operations(id,action,status,request_hash,payload,created_at,updated_at,result) VALUES(?,?, 'writing', ?, ?, ?, ?, NULL)",
      )
      .run(id, action, requestHash, JSON.stringify(payload), at, at);
    return this.rollSupplyOperation(id);
  }
  updateRollSupplyOperation(id, status, result, at) {
    this.db
      .prepare(
        "UPDATE roll_supply_operations SET status=?,updated_at=?,result=? WHERE id=?",
      )
      .run(status, at, JSON.stringify(result || {}), id);
    return this.rollSupplyOperation(id);
  }
  recentRollSupplyOperations(limit = 20) {
    return this.db
      .prepare(
        "SELECT id,action,status,payload,created_at,updated_at,result FROM roll_supply_operations ORDER BY created_at DESC LIMIT ?",
      )
      .all(Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((row) => ({
        id: row.id,
        action: row.action,
        status: row.status,
        payload: JSON.parse(row.payload),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        result: row.result ? JSON.parse(row.result) : null,
      }));
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
    {
      verified = true,
      at = new Date().toISOString(),
      onlyCells = null,
      onlyTypes = null,
      resolution = null,
    } = {},
  ) {
    const seen = new Set(),
      created = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const f of findings) {
        if (
          this.monitoringDocuments &&
          !scopeAllows(f, this.monitoringDocuments, this.monitoringSources)
        )
          continue;
        const id = fingerprint(scope, f);
        seen.add(id);
        const old = this.db
          .prepare("SELECT * FROM incidents WHERE id=?")
          .get(id);
        const oldPayload = old ? JSON.parse(old.payload) : null;
        const reopen = ["resolved", "excepted", "rule_paused"].includes(
          old?.status,
        );
        const generation = old ? old.generation + (reopen ? 1 : 0) : 1;
        const storedFinding = {
          ...f,
          activeSince:
            !old || reopen ? at : oldPayload?.activeSince || old.first_seen,
        };
        this.db
          .prepare(
            "INSERT INTO incidents(id,scope,payload,status,first_seen,last_seen,resolved_at,occurrences,generation) VALUES(?,?,?,'open',?,?,NULL,1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,status='open',last_seen=excluded.last_seen,resolved_at=NULL,occurrences=incidents.occurrences+1,generation=excluded.generation",
          )
          .run(
            id,
            scope,
            JSON.stringify(storedFinding),
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
            if (onlyCells || onlyTypes) {
              const payload = this.db
                .prepare("SELECT payload FROM incidents WHERE id=?")
                .get(old.id);
              const previous = JSON.parse(payload.payload);
              if (
                (onlyCells && !onlyCells.has(previous.cell)) ||
                (onlyTypes && !onlyTypes.has(previous.type))
              )
                continue;
            }
            const previous = JSON.parse(
                this.db
                  .prepare("SELECT payload FROM incidents WHERE id=?")
                  .get(old.id).payload,
              ),
              resolvedPayload = resolution
                ? {
                    ...previous,
                    lifecycleState: "resolved",
                    resolutionCause:
                      resolution.cause ||
                      "Успешная перепроверка больше не обнаружила проблему",
                    resolutionAt: at,
                    resolutionEvidence: resolution.evidence || null,
                  }
                : null;
            this.db
              .prepare(
                "UPDATE incidents SET payload=COALESCE(?,payload),status='resolved',resolved_at=?,last_seen=?,workflow=CASE WHEN workflow IS NULL THEN NULL ELSE 'fixed' END WHERE id=?",
              )
              .run(
                resolvedPayload ? JSON.stringify(resolvedPayload) : null,
                at,
                at,
                old.id,
              );
            this.db
              .prepare(
                "UPDATE outbox SET status='cancelled' WHERE incident_id=? AND status='pending'",
              )
              .run(old.id);
            this.log(
              "incident_resolved",
              resolution?.cause ||
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
    sheet = "",
    severity = "",
    status = "",
    search = "",
    kind = "",
    type = "",
    group = "",
    includeDemonstrations = true,
    page = 0,
    limit = 20,
  } = {}) {
    const { clauses, params } = incidentBaseFilters({ department, source, sheet, severity, kind, type, search, includeDemonstrations });
    const
      hasRepairProposals = !!this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_repair_proposals'",
        )
        .get(),
      verifiedRepair = hasRepairProposals
        ? "EXISTS (SELECT 1 FROM test_repair_proposals rp WHERE rp.incident_id=incidents.id AND rp.status='verified' AND json_extract(rp.payload,'$.direction')='repair' AND CAST(json_extract(rp.payload,'$.generation') AS INTEGER)=incidents.generation)"
        : "0";
    if (status === "fixed") {
      clauses.push(
        "status='resolved' AND (json_extract(payload,'$.type')='data_quality_root_cause' OR (json_extract(payload,'$.verification')='rule_confirmed' AND json_extract(payload,'$.type') IN ('formula_missing','formula_number','formula_text','formula_mismatch','calculation_error')) OR " +
          verifiedRepair +
          ")",
      );
    } else if (status === "active") {
      clauses.push("status=\'open\' AND COALESCE(workflow,\'\')!=\'ignored\'");
    } else if (status) {
      clauses.push(
        ["open", "resolved"].includes(status)
          ? "status=?"
          : "COALESCE(workflow,status)=?",
      );
      params.push(status);
    }
    const calculationError =
      "(json_extract(payload,'$.type')='calculation_error' OR json_extract(payload,'$.sourceState')='dependent_formula_error' OR (json_type(payload,'$.errorCells')='array' AND json_array_length(payload,'$.errorCells')>0))";
    if (group === "missing_source")
      clauses.push("json_extract(payload,'$.sourceState')='missing'");
    else if (group === "calculation_error") clauses.push(calculationError);
    else if (group === "needs_review")
      clauses.push(
        "(json_extract(payload,'$.sourceState')='insufficient_data' OR json_extract(payload,'$.sourceState')='restored_pending_recalculation' OR json_extract(payload,'$.recoveryStatus')='needs_review' OR json_extract(payload,'$.verification')!='rule_confirmed')",
      );
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const order =
      (status === "fixed"
          ? " ORDER BY COALESCE(json_extract(payload,'$.resolutionAt'),resolved_at,last_seen) DESC,"
          : " ORDER BY") +
      " CASE json_extract(payload,'$.severity') WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, CASE WHEN json_extract(payload,'$.kpiImpactVerified')=1 OR json_extract(payload,'$.impactEvidence.verified')=1 THEN 0 WHEN " +
      calculationError +
      " THEN 1 WHEN json_extract(payload,'$.sourceState')='missing' THEN 2 WHEN json_extract(payload,'$.sourceState') IN ('restored_pending_recalculation','insufficient_data') THEN 3 WHEN json_extract(payload,'$.verification')='rule_confirmed' THEN 4 ELSE 5 END, CASE json_extract(payload,'$.severity') WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, last_seen DESC,id";
    if (status === "active") {
      const matched = this.db
          .prepare("SELECT * FROM incidents" + where + order)
          .all(...params)
          .map((row) => this.incident(row)),
        grouped = groupActiveIncidents(matched),
        total = grouped.length,
        safePage = Math.min(page, Math.max(0, Math.ceil(total / limit) - 1));
      return {
        total,
        page: safePage,
        limit,
        rows: grouped.slice(safePage * limit, (safePage + 1) * limit),
      };
    }
    const total = this.db
      .prepare("SELECT count(*) AS n FROM incidents" + where)
      .get(...params).n;
    const safePage = Math.min(page, Math.max(0, Math.ceil(total / limit) - 1));
    const rows = this.db
      .prepare("SELECT * FROM incidents" + where + order + " LIMIT ? OFFSET ?")
      .all(...params, limit, safePage * limit);
    return {
      total,
      page: safePage,
      limit,
      rows: rows.map((r) => this.incident(r)),
    };
  }
  incidentSummary(filters = {}) {
    const { clauses, params } = incidentBaseFilters({
      ...filters,
      includeDemonstrations: false,
    });
    const active = "status='open' AND COALESCE(workflow,'')!='ignored'",
      hasRepairProposals = !!this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_repair_proposals'",
        )
        .get(),
      verifiedRepair = hasRepairProposals
        ? "EXISTS (SELECT 1 FROM test_repair_proposals rp WHERE rp.incident_id=incidents.id AND rp.status='verified' AND json_extract(rp.payload,'$.direction')='repair' AND CAST(json_extract(rp.payload,'$.generation') AS INTEGER)=incidents.generation)"
        : "0",
      activeRows = this.db
        .prepare(
          "SELECT * FROM incidents WHERE " +
            [...clauses, active].join(" AND "),
        )
        .all(...params)
        .map((row) => this.incident(row)),
      groupedActive = groupActiveIncidents(activeRows),
      fixed = this.db
        .prepare(
          "SELECT COALESCE(SUM(CASE WHEN status='resolved' AND (json_extract(payload,'$.type')='data_quality_root_cause' OR (json_extract(payload,'$.verification')='rule_confirmed' AND json_extract(payload,'$.type') IN ('formula_missing','formula_number','formula_text','formula_mismatch','calculation_error')) OR " +
            verifiedRepair +
            ") THEN 1 ELSE 0 END),0) AS fixed FROM incidents WHERE " +
            clauses.join(" AND "),
        )
        .get(...params).fixed;
    return {
      allProblems: groupedActive.length,
      critical: groupedActive.filter((item) => item.severity === "critical").length,
      missingSource: groupedActive.filter((item) => item.sourceState === "missing").length,
      calculationError: groupedActive.filter(
        (item) =>
          item.type === "calculation_error" ||
          item.sourceState === "dependent_formula_error" ||
          (item.errorCells || []).length > 0,
      ).length,
      needsReview: groupedActive.filter(
        (item) =>
          ["insufficient_data", "restored_pending_recalculation"].includes(
            item.sourceState,
          ) ||
          item.recoveryStatus === "needs_review" ||
          (item.verification != null &&
            item.verification !== "rule_confirmed"),
      ).length,
      fixed: Number(fixed) || 0,
    };
  }
  incident(row) {
    const repairRequest = this.db
        .prepare(
          "SELECT id FROM repair_requests WHERE incident_id=? AND generation=?",
        )
        .get(row.id, row.generation),
      recovery = repairRequest
        ? this.db
            .prepare(
              "SELECT * FROM source_recovery_operations WHERE request_id=? ORDER BY created_at DESC LIMIT 1",
            )
            .get(repairRequest.id)
        : null;
    const payload = JSON.parse(row.payload);
    const proposed = ownerSourceCandidate(this, row, payload);
    const formulaProposal = proposed ? null : approvedFormulaCandidate(this.db, row, payload);
    return {
      ...payload,
      ...(proposed ? { recoveryCandidate: proposed } : formulaProposal?.status === "candidate" ? { recoveryCandidate: formulaProposal } : {}),
      ...(formulaProposal ? { repairAvailability: formulaProposal } : {}),
      id: row.id,
      status: row.workflow || row.status,
      monitorStatus: row.status,
      repairRequested: !!repairRequest,
      sourceRecoveryOperation: recovery
        ? {
            id: recovery.id,
            requestId: recovery.request_id,
            incidentId: recovery.incident_id,
            status: recovery.status,
            createdAt: recovery.created_at,
            updatedAt: recovery.updated_at,
            owner: recovery.owner,
            target: JSON.parse(recovery.target),
            approvedValue: JSON.parse(recovery.approved_value),
            before: recovery.before_value
              ? JSON.parse(recovery.before_value)
              : null,
            after: recovery.after_value ? JSON.parse(recovery.after_value) : null,
            result: recovery.result ? JSON.parse(recovery.result) : null,
          }
        : null,
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
  incidentAction(
    id,
    action,
    at = new Date().toISOString(),
    requestDetails = null,
  ) {
    const row = this.db.prepare("SELECT * FROM incidents WHERE id=?").get(id);
    if (
      !row ||
      JSON.parse(row.payload).kind !== "table_doctor" ||
      row.status !== "open"
    )
      return null;
    if (!["request-repair", "ignore"].includes(action))
      throw new Error("Unsupported action");
    if (
      action === "ignore" &&
      JSON.parse(row.payload).type === "data_quality_root_cause"
    )
      return null;
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
        const finding = JSON.parse(row.payload);
        let requestPayload = row.payload;
        if (finding.type === "data_quality_root_cause") {
          const candidate = finding.recoveryCandidate,
            keys = Object.keys(requestDetails || {}).sort();
          if (
            !candidate ||
            candidate.status !== "candidate" ||
            keys.join(",") !== "confirmation,sourceCell,value" ||
            requestDetails.sourceCell !== finding.cell ||
            requestDetails.confirmation !== candidate.confirmation ||
            JSON.stringify(requestDetails.value) !==
              JSON.stringify(candidate.value)
          ) {
            this.db.exec("ROLLBACK");
            return null;
          }
          requestPayload = JSON.stringify({
            finding,
            ownerConfirmation: {
              at,
              sourceCell: finding.cell,
              sheet: finding.sheet,
              value: candidate.value,
              confirmation: candidate.confirmation,
              owner: "authenticated_local_owner",
              googleSheetsChanged: false,
            },
          });
        } else if (requestDetails && Object.keys(requestDetails).length) {
          this.db.exec("ROLLBACK");
          return null;
        }
        const requestId = id + ":" + row.generation;
        const change = this.db
          .prepare(
            "INSERT OR IGNORE INTO repair_requests VALUES(?,?,?, ?,\'pending\',?)",
          )
          .run(requestId, id, row.generation, at, requestPayload);
        if (change.changes)
          this.log(
            finding.type === "data_quality_root_cause"
              ? "source_recovery_confirmed"
              : "repair_requested",
            finding.type === "data_quality_root_cause"
              ? "Владелец подтвердил точное значение и адрес источника; создана локальная заявка, Google Sheets не изменён"
              : "Создана заявка на будущее исправление; Google Sheets не изменён",
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
  bulkIgnoreIncidents(ids, at = new Date().toISOString()) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 50 ||
      new Set(ids).size !== ids.length
    )
      return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = ids.map((id) =>
          this.db.prepare("SELECT * FROM incidents WHERE id=?").get(id),
        ),
        eligible = rows.every((row) => {
          if (!row || row.status !== "open" || row.workflow === "ignored")
            return false;
          const payload = JSON.parse(row.payload);
          return (
            payload.kind === "table_doctor" &&
            !payload.demonstration &&
            payload.type !== "data_quality_root_cause"
          );
        });
      if (!eligible) {
        this.db.exec("ROLLBACK");
        return null;
      }
      for (const row of rows) {
        this.db
          .prepare("UPDATE incidents SET workflow='ignored' WHERE id=?")
          .run(row.id);
        this.db
          .prepare(
            "UPDATE outbox SET status='cancelled' WHERE incident_id=? AND status='pending'",
          )
          .run(row.id);
        this.log(
          "incident_ignored",
          "Владелец игнорирует проблему; таблица не изменена",
          row.id,
          at,
        );
      }
      this.db.exec("COMMIT");
      return ids.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
