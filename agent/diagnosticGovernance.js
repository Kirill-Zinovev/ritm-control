import { digest } from "./diagnosticGrid.js";
import { BASIC_RULE_IDS } from "./diagnosticReview.js";
export class DiagnosticDecisionError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}
export class DiagnosticGovernance {
  constructor(store, config, { now = () => new Date() } = {}) {
    this.store = store;
    this.config = config;
    this.now = now;
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS diagnostic_decisions (id TEXT PRIMARY KEY,version TEXT NOT NULL,decision TEXT NOT NULL,payload TEXT NOT NULL,at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS diagnostic_exceptions (id TEXT PRIMARY KEY,observation_id TEXT NOT NULL,evidence_version TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,at TEXT NOT NULL);",
    );
  }
  state() {
    const at = this.now(),
      documents = this.config.doctorDocuments.filter(
        (d) => d.enabled && d.adapter === "google",
      );
    const reports = documents.flatMap((d) => {
      const s = this.store.getSnapshot("doctor-review:" + d.id);
      return s
        ? [
            {
              ...s.value,
              stale:
                at.getTime() - Date.parse(s.at) > this.config.snapshotMaxAgeMs,
              sourceStatus:
                this.store.overview().checks.find((c) => c.id === d.id)
                  ?.status || "not_configured",
            },
          ]
        : [];
    });
    const rules = reports.flatMap((r) =>
      r.rules.map((rule) => {
        const decision = this.store.db
          .prepare("SELECT * FROM diagnostic_decisions WHERE id=?")
          .get(rule.id);
        return {
          ...rule,
          document: r.document,
          approval:
            decision?.version === rule.version &&
            decision.decision === "approved"
              ? "approved"
              : "pending",
          approvedAt:
            decision?.version === rule.version &&
            decision.decision === "approved"
              ? decision.at
              : null,
          stale: r.stale,
          sourceStatus: r.sourceStatus,
        };
      }),
    );
    const rawExceptions = this.store.db
      .prepare("SELECT * FROM diagnostic_exceptions ORDER BY at DESC")
      .all()
      .map((r) => ({
        ...JSON.parse(r.payload),
        id: r.id,
        status: r.status,
        createdAt: r.at,
      }));
    const observations = reports.flatMap((r) =>
      r.observations.map((o) => {
        const rule = rules.find((x) => x.id === o.ruleId),
          exception = rawExceptions.find(
            (e) =>
              e.observationId === o.id &&
              e.evidenceVersion === o.evidenceVersion &&
              e.status === "active" &&
              Date.parse(e.expiresAt) > at.getTime() &&
              e.ruleVersion === (rule?.version || null),
          );
        const formulaViolation = [
          "formula_missing",
          "formula_number",
          "formula_mismatch",
        ].includes(o.type);
        return {
          ...o,
          at: r.at,
          stale: r.stale || r.sourceStatus !== "ok",
          classification: exception
            ? "expected_exception"
            : formulaViolation && rule?.approval === "approved"
              ? "confirmed_formula"
              : o.classification,
          exceptionId: exception?.id || null,
          exceptionReason: exception?.reason || null,
          ruleVersion: rule?.version || null,
          confidence:
            formulaViolation && rule?.approval === "approved"
              ? "Высокая: нарушение утверждённого точного шаблона"
              : o.confidence,
        };
      }),
    );
    const exceptions = rawExceptions.map((e) => ({
      ...e,
      applies: observations.some((o) => o.exceptionId === e.id),
      status:
        e.status === "active" && Date.parse(e.expiresAt) <= at.getTime()
          ? "expired"
          : e.status,
    }));
    return {
      ok: true,
      at: at.toISOString(),
      permission: "diagnosis_only",
      rules,
      observations,
      exceptions,
      attention: observations.filter(
        (o) =>
          ![
            "expected_behavior",
            "expected_exception",
            "confirmed_formula",
          ].includes(o.classification),
      ).length,
      confirmed: observations.filter(
        (o) => o.classification === "confirmed_formula",
      ).length,
    };
  }
  fresh(item) {
    const check = this.store
      .overview()
      .checks.find((c) => c.id === item.sourceId);
    if (
      item.stale ||
      check?.status !== "ok" ||
      !check?.readVerifiedAt ||
      this.now().getTime() - Date.parse(item.at) > this.config.snapshotMaxAgeMs
    )
      throw new DiagnosticDecisionError(
        "Нужна свежая успешная проверка источника перед решением владельца.",
      );
  }
  decide({ ruleId, version, decision, acknowledged }) {
    if (
      !BASIC_RULE_IDS.includes(ruleId) ||
      !["approve", "revoke"].includes(decision) ||
      acknowledged !== true
    )
      throw new DiagnosticDecisionError(
        "Подтвердите конкретное правило диагностики.",
        400,
      );
    const rule = this.state().rules.find((r) => r.id === ruleId);
    if (!rule || rule.version !== version)
      throw new DiagnosticDecisionError(
        "Версия правила изменилась; откройте актуальную карточку.",
      );
    if (decision === "approve") this.fresh(rule);
    if (decision === "approve" && rule.status !== "ready")
      throw new DiagnosticDecisionError(
        "Источник или условия правила ещё не подтверждены.",
      );
    const old = this.store.db
        .prepare("SELECT * FROM diagnostic_decisions WHERE id=?")
        .get(ruleId),
      next = decision === "approve" ? "approved" : "revoked";
    if (old?.version === version && old.decision === next)
      return { ok: true, unchanged: true };
    const at = this.now().toISOString();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare(
          "INSERT INTO diagnostic_decisions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,decision=excluded.decision,payload=excluded.payload,at=excluded.at",
        )
        .run(
          ruleId,
          version,
          next,
          JSON.stringify({
            ruleId,
            version,
            actor: "owner",
            contract: rule,
            permission: "diagnosis_only",
          }),
          at,
        );
      if (next === "revoked")
        this.pause(
          ruleId,
          "rule_paused",
          "Правило диагностики отозвано владельцем; исправление не выполнялось",
          at,
        );
      this.store.log(
        "diagnostic_rule_" + next,
        rule.title + " · владелец · только диагностика, без права записи",
        null,
        at,
      );
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    return { ok: true };
  }
  addException({ observationId, evidenceVersion, reason, expiresAt }) {
    if (
      typeof reason !== "string" ||
      reason.trim().length < 5 ||
      reason.length > 1000 ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= this.now().getTime() ||
      Date.parse(expiresAt) > this.now().getTime() + 90 * 86400000
    )
      throw new DiagnosticDecisionError(
        "Укажите причину (5–1000 символов) и срок исключения до 90 дней.",
        400,
      );
    const o = this.state().observations.find((o) => o.id === observationId);
    if (!o || o.evidenceVersion !== evidenceVersion)
      throw new DiagnosticDecisionError(
        "Наблюдение изменилось; требуется новый просмотр доказательств.",
      );
    this.fresh(o);
    const id = digest([observationId, evidenceVersion, o.ruleVersion]),
      old = this.store.db
        .prepare("SELECT * FROM diagnostic_exceptions WHERE id=?")
        .get(id);
    if (
      old?.status === "active" &&
      Date.parse(JSON.parse(old.payload).expiresAt) > this.now().getTime()
    )
      return { ok: true, id, unchanged: true };
    const payload = {
      observationId,
      evidenceVersion,
      reason: reason.trim(),
      expiresAt,
      ruleVersion: o.ruleVersion,
      sourceId: o.sourceId,
      documentId: o.documentId,
      gid: o.gid,
      sheet: o.sheet,
      cell: o.cell,
      ruleId: o.ruleId,
      type: o.type,
      actor: "owner",
      evidence: o.evidence,
    };
    const at = this.now().toISOString();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare(
          "INSERT INTO diagnostic_exceptions VALUES(?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET status='active',payload=excluded.payload,at=excluded.at",
        )
        .run(id, observationId, evidenceVersion, JSON.stringify(payload), at);
      this.pause(
        o.ruleId,
        "excepted",
        "Допустимое точечное исключение владельца; производственная ячейка не исправлена",
        at,
        o.id,
      );
      this.store.log(
        "diagnostic_exception_added",
        o.document + " · " + o.sheet + "!" + o.cell + " · " + reason.trim(),
        null,
        at,
      );
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    return { ok: true, id };
  }
  revokeException(id) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new DiagnosticDecisionError("Неизвестное исключение.", 400);
    const e = this.store.db
      .prepare("SELECT * FROM diagnostic_exceptions WHERE id=?")
      .get(id);
    if (!e) throw new DiagnosticDecisionError("Исключение не найдено.", 404);
    if (e.status === "revoked") return { ok: true, unchanged: true };
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare("UPDATE diagnostic_exceptions SET status='revoked' WHERE id=?")
        .run(id);
      const p = JSON.parse(e.payload);
      this.store.log(
        "diagnostic_exception_revoked",
        p.sheet + "!" + p.cell + " · исключение отменено владельцем",
      );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true };
  }
  pause(ruleId, status, message, at, observationId = null) {
    for (const i of this.store.db
      .prepare(
        "SELECT id,payload FROM incidents WHERE (scope LIKE 'doctor:policy:%' OR scope LIKE 'doctor:data:%') AND status='open'",
      )
      .all()) {
      const p = JSON.parse(i.payload);
      if (
        p.diagnosticRuleId !== ruleId ||
        (observationId && p.observationId !== observationId)
      )
        continue;
      this.store.db
        .prepare(
          "UPDATE incidents SET status=?,workflow=?,resolved_at=NULL WHERE id=?",
        )
        .run(status, status, i.id);
      this.store.db
        .prepare(
          "UPDATE outbox SET status='cancelled' WHERE incident_id=? AND status='pending'",
        )
        .run(i.id);
      this.store.log("diagnostic_incident_paused", message, i.id, at);
    }
  }
  reviewLegacy(document, findings, at) {
    const state = this.state();
    return findings.flatMap((f) => {
      const o = state.observations.find(
        (o) =>
          o.sourceId === document.id &&
          o.cell === f.cell &&
          o.sheet === f.sheet &&
          o.type === f.type,
      );
      if (!o) return [f];
      if (o.classification === "expected_exception") {
        this.pause(
          o.ruleId,
          "excepted",
          "Применено точечное исключение владельца; данные не изменялись",
          at,
          o.id,
        );
        return [];
      }
      return [
        {
          ...f,
          diagnosticRuleId: o.ruleId,
          observationId: o.id,
          ...(o.classification === "confirmed_formula"
            ? {
                verification: "rule_confirmed",
                initialStatus: "confirmed",
                category: "confirmed_formula",
                expected: o.expected,
              }
            : {}),
        },
      ];
    });
  }
  reconcile(document, complete, at) {
    if (!complete) return;
    const state = this.state(),
      approved = new Set(
        state.rules
          .filter(
            (r) => r.sourceId === document.id && r.approval === "approved",
          )
          .map((r) => r.id),
      );
    // Exceptions and revoked rules are suspended, not marked fixed by omission.
    for (const i of this.store.db
      .prepare(
        "SELECT id,payload FROM incidents WHERE scope=? AND status='open'",
      )
      .all("doctor:policy:" + document.id)) {
      const p = JSON.parse(i.payload),
        o = state.observations.find((o) => o.id === p.observationId);
      if (!approved.has(p.diagnosticRuleId)) {
        this.pause(
          p.diagnosticRuleId,
          "rule_paused",
          "Эталон не активен; проблема не считается исправленной",
          at,
        );
        continue;
      }
      if (o?.classification === "expected_exception")
        this.pause(
          p.diagnosticRuleId,
          "excepted",
          "Применено точечное исключение; исправление не выполнялось",
          at,
          p.observationId,
        );
    }
    const represented = new Set(
      this.store.db
        .prepare(
          "SELECT payload FROM incidents WHERE scope=? AND status='open'",
        )
        .all("doctor:data:" + document.id)
        .map((r) => JSON.parse(r.payload).observationId)
        .filter(Boolean),
    );
    const findings = state.observations
      .filter(
        (o) =>
          o.sourceId === document.id &&
          approved.has(o.ruleId) &&
          !represented.has(o.id) &&
          !["expected_behavior", "expected_exception"].includes(
            o.classification,
          ),
      )
      .map((o) => ({
        kind: "table_doctor",
        sourceId: document.id,
        sourceName: document.name,
        department: document.department,
        sheet: o.sheet,
        cell: o.cell,
        row: Number(o.cell.match(/\d+/)?.[0] || 0),
        type:
          o.classification === "confirmed_formula" ? o.type : "business_rule",
        severity: o.classification === "confirmed_formula" ? "high" : "warning",
        title: o.title,
        observed: o.evidence,
        expected: o.expected,
        cause: o.cause,
        impact: o.impact,
        recommendation: o.recommendation,
        verification:
          o.classification === "confirmed_formula"
            ? "rule_confirmed"
            : "needs_review",
        initialStatus:
          o.classification === "confirmed_formula" ? "confirmed" : "review",
        category: o.classification,
        sourceUrl: o.sourceUrl,
        diagnosticRuleId: o.ruleId,
        observationId: o.id,
      }));
    this.store.reconcile("doctor:policy:" + document.id, findings, {
      verified: true,
      at,
    });
    return findings;
  }
}
