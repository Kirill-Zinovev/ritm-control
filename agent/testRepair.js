import { createHash, randomUUID } from "node:crypto";
import { TEST_TARGET, RepairError } from "./testSheetsWriter.js";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a, b) => digest(a) === digest(b);
const confirmation = (direction) =>
  direction === "repair"
    ? "Подтверждаю G247: 150 → =C247/D247"
    : "Подтверждаю откат G247: =C247/D247 → 150";
export function validateTestRepairConfig(config) {
  if (!config.testWriterCredentialsFile) return;
  const docs = config.doctorDocuments.filter((d) => d.enabled);
  const d = docs[0],
    s = d?.sheets?.[0],
    r = s?.rules?.[0];
  if (
    config.port !== 4319 ||
    config.publicOrigin ||
    config.telegram.enabled ||
    config.sources.some((s) => s.enabled) ||
    config.doctorDemoEnabled ||
    docs.length !== 1 ||
    d.documentId !== TEST_TARGET.documentId ||
    d.adapter !== "google" ||
    d.testSource !== true ||
    d.sheets.length !== 1 ||
    s.gid !== TEST_TARGET.sheetId ||
    s.name !== TEST_TARGET.sheet ||
    s.rules.length !== 1 ||
    r.approval !== "approved" ||
    r.kind !== "formula" ||
    r.column !== "G" ||
    r.startRow !== 247 ||
    r.endRow !== 247 ||
    !same(r.templates, [TEST_TARGET.formula]) ||
    (r.exceptions || []).length
  )
    throw new Error(
      "Test repair requires isolated localhost:4319, disabled production sources and one approved G247 test rule",
    );
}
export class TestRepairService {
  constructor(
    store,
    config,
    { reader, writer, doctor, now = () => Date.now() },
  ) {
    validateTestRepairConfig(config);
    Object.assign(this, { store, config, reader, writer, doctor, now });
    this.document = config.doctorDocuments.find((d) => d.enabled);
    this.db = store.db;
    this.busy = false;
    this.isolation = {
      status: "awaiting_verification",
      message: "Изоляция отдельного аккаунта ещё не проверена",
    };
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS test_repair_proposals (id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,result TEXT); CREATE TABLE IF NOT EXISTS test_repair_events (id INTEGER PRIMARY KEY AUTOINCREMENT,proposal_id TEXT NOT NULL,at TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL);",
    );
    const lost = this.db
      .prepare(
        "SELECT id,incident_id FROM test_repair_proposals WHERE status='executing'",
      )
      .all();
    for (const r of lost) {
      this.db
        .prepare(
          "UPDATE test_repair_proposals SET status='uncertain' WHERE id=?",
        )
        .run(r.id);
      this.event(r.id, r.incident_id, "repair_uncertain", {
        reason: "process_restart",
      });
    }
  }
  event(id, incidentId, type, payload) {
    const at = new Date(this.now()).toISOString();
    this.db
      .prepare(
        "INSERT INTO test_repair_events(proposal_id,at,type,payload) VALUES(?,?,?,?)",
      )
      .run(id, at, type, JSON.stringify(payload));
    const labels = {
      repair_proposed:
        "Предложено точечное изменение тестовой G247; запись ждёт владельца",
      repair_confirmed:
        "Владелец подтвердил точное изменение тестовой G247 и риск параллельного редактирования",
      repair_backup:
        "Исходное содержимое тестовой G247 и зависимости сохранены до записи",
      repair_write_started:
        "Начата единственная условная запись в тестовую G247",
      repair_verified:
        "Тестовое изменение проверено повторным чтением Google API",
      repair_uncertain:
        "Результат тестового изменения требует ручной проверки; повтор заблокирован",
      repair_cancelled:
        "Тестовое изменение отменено: условия или версия изменились",
    };
    this.store.log(type, labels[type] || type, incidentId, at);
  }
  state(incidentId) {
    const rows = this.db
      .prepare(
        "SELECT * FROM test_repair_proposals WHERE incident_id=? ORDER BY rowid DESC LIMIT 10",
      )
      .all(incidentId);
    return {
      enabled: true,
      testOnly: true,
      target: TEST_TARGET,
      writerVerifiedAt: this.writer.verifiedAt,
      isolation: this.isolation,
      metrics: this.writer.metrics,
      proposals: rows.map((row) => ({
        ...JSON.parse(row.payload),
        status: row.status,
        result: row.result ? JSON.parse(row.result) : null,
        expired: this.now() >= JSON.parse(row.payload).expiresAt,
        events: this.db
          .prepare(
            "SELECT at,type,payload FROM test_repair_events WHERE proposal_id=? ORDER BY id",
          )
          .all(row.id)
          .map((e) => ({ ...e, payload: JSON.parse(e.payload) })),
      })),
    };
  }
  incident(id, open) {
    const row = this.db.prepare("SELECT * FROM incidents WHERE id=?").get(id);
    const i = row && this.store.incident(row);
    const source = this.config.doctorDocuments.find(
      (d) => d.id === i?.sourceId,
    );
    if (
      !row ||
      i.kind !== "table_doctor" ||
      source?.documentId !== TEST_TARGET.documentId ||
      i.cell !== "G247" ||
      i.sheet !== TEST_TARGET.sheet ||
      i.verification !== "rule_confirmed" ||
      (open && (row.status !== "open" || i.status === "ignored"))
    )
      throw new RepairError(
        "incident_forbidden",
        "Инцидент не разрешён для тестового исправления",
        403,
      );
    return { generation: row.generation, incident: i };
  }
  async snapshot() {
    const value = await this.reader.get(TEST_TARGET.documentId, {
      ranges: ["'Проверка формулы'!A247:G247"],
      fields:
        "spreadsheetId,sheets(properties(sheetId,title),merges,data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,dataValidation))))",
    });
    const sheet = value.sheets.find(
      (s) => s.properties?.sheetId === TEST_TARGET.sheetId,
    );
    if (!sheet || sheet.properties.title !== TEST_TARGET.sheet)
      throw new RepairError(
        "structure_changed",
        "Изменилась структура тестового листа",
      );
    if (
      (sheet.merges || []).some(
        (m) =>
          m.startRowIndex <= 246 &&
          (m.endRowIndex ?? Infinity) > 246 &&
          m.startColumnIndex <= 6 &&
          (m.endColumnIndex ?? Infinity) > 6,
      )
    )
      throw new RepairError(
        "merged_cell",
        "Разрешённая ячейка входит в объединённый диапазон",
      );
    const block = sheet.data?.find(
      (d) => d.startRow === 246 && (d.startColumn || 0) === 0,
    );
    const cells = block?.rowData?.[0]?.values || [];
    const entered = (n) => cells[n]?.userEnteredValue || {};
    if (
      !same(entered(0), { stringValue: "TEST-ONLY-247" }) ||
      !same(entered(2), { numberValue: 124 }) ||
      !same(entered(3), { numberValue: 100 })
    )
      throw new RepairError(
        "dependencies_changed",
        "Изменились тестовый UID или исходные C247/D247",
      );
    return {
      uid: entered(0),
      numerator: entered(2),
      denominator: entered(3),
      cell: entered(6),
      effective: cells[6]?.effectiveValue || {},
      formatted: cells[6]?.formattedValue || "",
      validation: cells[6]?.dataValidation || null,
    };
  }
  sourceVersion() {
    return digest(this.document);
  }
  verifyAfter(after, p) {
    if (
      !same(after.cell, p.to) ||
      after.effective.numberValue !== p.expectedResult ||
      after.validation
    )
      throw new RepairError(
        "postcondition_failed",
        "Повторное чтение не подтвердило формулу, тип значения или результат; автоматический откат запрещён",
        503,
      );
  }
  verifyDoctor(p) {
    const check = this.doctor
      .state()
      .documents.find((d) => d.id === this.document.id)?.check;
    if (
      check?.status !== "ok" ||
      (p.direction === "repair" && check.issueCount !== 0)
    )
      throw new RepairError(
        "doctor_recheck_failed",
        "Запись прочитана, но итоговая диагностика не подтверждена",
        503,
      );
    return check.at;
  }
  async prepare(incidentId, direction = "repair", previousId = null) {
    if (this.busy)
      throw new RepairError(
        "repair_busy",
        "Дождитесь завершения текущего действия",
      );
    this.busy = true;
    try {
      const { generation, incident } = this.incident(
        incidentId,
        direction === "repair",
      );
      if (!["repair", "rollback"].includes(direction))
        throw new RepairError("invalid_direction", "Недопустимое действие");
      if (
        this.db
          .prepare(
            "SELECT id FROM test_repair_proposals WHERE status IN ('executing','uncertain')",
          )
          .get()
      )
        throw new RepairError(
          "unresolved_write",
          "Сначала вручную проверьте незавершённую запись; новая запись заблокирована",
        );
      if (direction === "rollback") {
        const previous = this.db
          .prepare("SELECT * FROM test_repair_proposals WHERE id=?")
          .get(previousId);
        if (
          !previous ||
          previous.incident_id !== incidentId ||
          previous.status !== "verified" ||
          JSON.parse(previous.payload).direction !== "repair"
        )
          throw new RepairError(
            "rollback_forbidden",
            "Нет проверенного исправления для отката",
          );
      }
      try {
        const audit = await this.writer.verifyIsolation();
        this.isolation = {
          status: "verified",
          message:
            "Тест разрешён; редактирование двух производственных документов запрещено",
          ...audit,
        };
      } catch (e) {
        this.isolation = {
          status: "blocked",
          message: e.code ? e.message : "Изоляция не подтверждена",
          code: e.code || "unavailable",
        };
      }
      this.store.meta("testWriterIsolation", this.isolation);
      // Preparing a proposal is read-only even when actual writes are blocked.
      const snapshot = await this.snapshot();
      const expected =
        direction === "repair"
          ? { numberValue: 150 }
          : { formulaValue: TEST_TARGET.formula };
      if (
        !same(snapshot.cell, expected) ||
        snapshot.validation ||
        (direction === "repair" && snapshot.formatted !== "150")
      )
        throw new RepairError(
          "cell_changed",
          "Текущее содержимое G247 не соответствует ожидаемому исходному состоянию",
        );
      this.db
        .prepare(
          "UPDATE test_repair_proposals SET status='superseded' WHERE status='pending' AND incident_id=?",
        )
        .run(incidentId);
      const proposal = {
        id: randomUUID(),
        incidentId,
        generation,
        direction,
        previousId,
        target: TEST_TARGET,
        sourceName: incident.sourceName,
        snapshot,
        from: snapshot.cell,
        to:
          direction === "repair"
            ? { formulaValue: TEST_TARGET.formula }
            : { numberValue: 150 },
        expectedResult: direction === "repair" ? 1.24 : 150,
        policyVersion: this.sourceVersion(),
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: this.now() + 10 * 60000,
        confirmation: confirmation(direction),
        limitation:
          "Google Sheets не предоставляет атомарную проверку всех прочитанных значений и запись. Условная замена проверяет текст только G247. Тип значения, C247/D247 и редактирование после записи не блокируются. Подтвердите отсутствие параллельного редактирования на время теста.",
      };
      proposal.version = digest(proposal);
      this.db
        .prepare(
          "INSERT INTO test_repair_proposals VALUES(?,?,?,'pending',?,NULL)",
        )
        .run(
          proposal.id,
          incidentId,
          proposal.version,
          JSON.stringify(proposal),
        );
      this.event(proposal.id, incidentId, "repair_proposed", {
        version: proposal.version,
        from: proposal.from,
        to: proposal.to,
        target: TEST_TARGET,
      });
      return { ok: true, ...this.state(incidentId) };
    } finally {
      this.busy = false;
    }
  }
  async confirm(id, payload) {
    // Compare every request to the persisted immutable proposal, never client addresses.
    const allowed = ["version", "confirmation", "exclusiveEditingAcknowledged"];
    if (
      !payload ||
      typeof payload !== "object" ||
      Object.keys(payload).some((k) => !allowed.includes(k)) ||
      payload.exclusiveEditingAcknowledged !== true
    )
      throw new RepairError(
        "confirmation_required",
        "Нужно подтвердить точное изменение и отсутствие параллельного редактирования",
        400,
      );
    const row = this.db
      .prepare("SELECT * FROM test_repair_proposals WHERE id=?")
      .get(id);
    if (!row)
      throw new RepairError(
        "proposal_not_found",
        "Предложение не найдено",
        404,
      );
    const p = JSON.parse(row.payload);
    if (
      payload.version !== row.version ||
      payload.confirmation !== p.confirmation
    )
      throw new RepairError(
        "proposal_version_changed",
        "Версия или текст подтверждения не совпадают",
      );
    if (row.status === "verified")
      return { ok: true, replayed: true, ...this.state(p.incidentId) };
    if (row.status !== "pending" || this.busy)
      throw new RepairError(
        "proposal_unavailable",
        "Предложение уже выполнено, отменено или требует ручной проверки",
      );
    this.busy = true;
    let writeStarted = false;
    try {
      const { generation } = this.incident(
        p.incidentId,
        p.direction === "repair",
      );
      if (
        this.now() >= p.expiresAt ||
        generation !== p.generation ||
        this.sourceVersion(p) !== p.policyVersion
      )
        throw new RepairError(
          "proposal_expired",
          "Срок, поколение инцидента или правило изменились; создайте новое предложение",
        );
      await this.writer.verifyIsolation(p.target);
      const snapshot = await this.snapshot(p.target);
      // Includes exact input types, formulas, dependencies, displayed value and validation.
      if (!same(snapshot, p.snapshot))
        throw new RepairError(
          "cell_changed",
          "После предложения изменилось содержимое ячейки или зависимости; запись отменена",
        );
      if (
        this.now() >= p.expiresAt ||
        this.sourceVersion(p) !== p.policyVersion ||
        this.incident(p.incidentId, p.direction === "repair").generation !==
          p.generation
      )
        throw new RepairError(
          "proposal_expired",
          "Предложение устарело до записи",
        );
      // Persist confirmation AND backup atomically before any Google write.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const claim = this.db
          .prepare(
            "UPDATE test_repair_proposals SET status='executing' WHERE id=? AND status='pending' AND version=?",
          )
          .run(id, p.version);
        if (claim.changes !== 1)
          throw new RepairError(
            "proposal_unavailable",
            "Предложение уже использовано",
          );
        this.event(id, p.incidentId, "repair_confirmed", {
          owner: "authenticated_local_owner",
          version: p.version,
          confirmation: payload.confirmation,
          exclusiveEditingAcknowledged: true,
        });
        this.event(id, p.incidentId, "repair_backup", {
          original: snapshot,
          restore: p.from,
          target: p.target,
        });
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      this.event(id, p.incidentId, "repair_write_started", {
        direction: p.direction,
      });
      writeStarted = true;
      const api = await this.writer.conditionalReplace(p.direction, p);
      const after = await this.snapshot(p.target);
      this.verifyAfter(after, p);
      // Wait for a previous scan and run a fresh one after the verified write.
      if (this.doctor.current) await this.doctor.current;
      await this.doctor.run();
      const doctorCheckAt = this.verifyDoctor(p);
      const result = {
        at: new Date(this.now()).toISOString(),
        after,
        api,
        doctorCheckAt,
      };
      this.db
        .prepare(
          "UPDATE test_repair_proposals SET status='verified',result=? WHERE id=?",
        )
        .run(JSON.stringify(result), id);
      this.event(id, p.incidentId, "repair_verified", result);
      return { ok: true, ...this.state(p.incidentId) };
    } catch (error) {
      const status =
        writeStarted &&
        error.code !== "conditional_conflict" &&
        error.code !== "write_rejected"
          ? "uncertain"
          : "cancelled";
      this.db
        .prepare(
          "UPDATE test_repair_proposals SET status=? WHERE id=? AND status IN ('pending','executing')",
        )
        .run(status, id);
      this.event(
        id,
        p.incidentId,
        status === "uncertain" ? "repair_uncertain" : "repair_cancelled",
        { code: error.code || "unavailable" },
      );
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
