import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  approvedTarget,
  validateProductionRepairConfig,
} from "./productionRepair.js";

const fail = (code, message, status = 409) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const valueOf = (cell) => {
  const value = cell?.effectiveValue || cell?.userEnteredValue;
  if (!value) return null;
  return (
    value.stringValue ??
    value.numberValue ??
    value.boolValue ??
    value.errorValue ??
    null
  );
};
const enteredValue = (cell) => cell?.userEnteredValue || null;
function point(address) {
  const match = String(address || "").match(/^([A-Z]{1,3})([1-9][0-9]*)$/);
  if (!match) return null;
  let column = 0;
  for (const letter of match[1])
    column = column * 26 + letter.charCodeAt(0) - 64;
  return { row: Number(match[2]), column: column - 1 };
}
function cellAt(sheet, address) {
  const p = point(address);
  if (!sheet || !p) return {};
  for (const block of sheet.data || []) {
    const rowIndex = p.row - 1 - (block.startRow || 0),
      columnIndex = p.column - (block.startColumn || 0),
      values = block.rowData?.[rowIndex]?.values;
    if (rowIndex >= 0 && columnIndex >= 0 && values?.[columnIndex])
      return values[columnIndex];
  }
  return {};
}
function parsePathCell(value) {
  const text = String(value || ""),
    separator = text.lastIndexOf("!"),
    sheet = separator < 0 ? "" : text.slice(0, separator),
    cell = separator < 0 ? text : text.slice(separator + 1);
  return { sheet, cell, point: point(cell) };
}
const blank = (cell) => {
  const entered = enteredValue(cell),
    effective = cell?.effectiveValue;
  if (entered?.formulaValue !== undefined || effective?.errorValue)
    return false;
  if (entered?.stringValue !== undefined) return entered.stringValue === "";
  if (entered) return false;
  if (effective?.stringValue !== undefined) return effective.stringValue === "";
  return !effective || Object.keys(effective).length === 0;
};
const sameCellState = (a, b) =>
  equal(enteredValue(a), enteredValue(b)) &&
  equal(a?.effectiveValue || null, b?.effectiveValue || null);
const stageLabels = {
  preflight: "Проверка заявки и исходных данных",
  writer_access: "Проверка права записи",
  pre_write_recheck: "Повторное чтение перед записью",
  write: "Запись Google Sheets",
  post_write_readback: "Проверка записи и зависимостей",
  full_doctor_check: "Полная проверка Table Doctor",
  finalize: "Фиксация истории и закрытие инцидента",
};

export class SourceRecoveryService {
  constructor(
    store,
    config,
    { reader, writer, doctor, now = () => Date.now(), retryDelayMs = 1000 },
  ) {
    validateProductionRepairConfig(config);
    if (!config.productionRepairEnabled || !reader || !writer || !doctor)
      fail(
        "source_recovery_unavailable",
        "Восстановление исходных данных не настроено в production backend",
        503,
      );
    Object.assign(this, {
      store,
      config,
      reader,
      writer,
      doctor,
      now,
      retryDelayMs,
    });
    this.db = store.db;
    this.running = new Map();
    this.recoverIncomplete();
  }

  recoverIncomplete() {
    const rows = this.db
      .prepare(
        "SELECT * FROM source_recovery_operations WHERE status IN ('repairing','checking')",
      )
      .all();
    if (!rows.length) return;
    const at = this.timestamp();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const prior = row.result ? JSON.parse(row.result) : {},
          writeConfirmed = row.status === "checking" && !!prior.api,
          status = writeConfirmed ? "written_unverified" : "uncertain",
          message = writeConfirmed
            ? "Google Sheets подтвердил запись, но агент остановился до завершения проверки. Повторная запись запрещена."
            : "После остановки результат записи не подтверждён; повторная запись запрещена до read-only сверки.",
          stages = { ...(prior.timing?.stages || {}) },
          activeStage = Object.entries(stages).find(
            ([, stage]) => stage.status === "running",
          )?.[0];
        if (activeStage) {
          const previous = stages[activeStage],
            endedAt = this.timestamp(),
            elapsed =
              Date.parse(endedAt) - Date.parse(previous.startedAt || endedAt);
          stages[activeStage] = {
            ...previous,
            status: "interrupted",
            completedAt: endedAt,
            durationMs: Math.max(
              previous.durationMs || 0,
              Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
            ),
            errorCode: "agent_stopped_during_recovery",
          };
        } else if (writeConfirmed) {
          stages.post_write_readback = {
            label: stageLabels.post_write_readback,
            status: "interrupted",
            startedAt: row.updated_at,
            completedAt: this.timestamp(),
            durationMs: 0,
            errorCode: "agent_stopped_during_recovery",
          };
        }
        const at = this.timestamp(),
          result = {
            ...prior,
            phase: status,
            at,
            code: "agent_stopped_during_recovery",
            message,
            writeConfirmed,
            retryAllowed: false,
            timing: {
              ...(prior.timing || {}),
              startedAt: prior.timing?.startedAt || row.created_at,
              totalMs: Math.max(0, Date.parse(at) - Date.parse(row.created_at)),
              stages,
            },
          };
        this.db
          .prepare(
            "UPDATE source_recovery_operations SET status=?,updated_at=?,result=? WHERE id=? AND status IN ('repairing','checking')",
          )
          .run(status, at, JSON.stringify(result), row.id);
        this.db
          .prepare(
            "UPDATE repair_requests SET status='needs_review' WHERE id=? AND status='executing'",
          )
          .run(row.request_id);
        this.store.log(
          writeConfirmed
            ? "source_recovery_written_unverified"
            : "source_recovery_uncertain",
          message,
          row.incident_id,
          at,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  timestamp() {
    return new Date(this.now()).toISOString();
  }

  operation(row) {
    if (!row) return null;
    return {
      id: row.id,
      requestId: row.request_id,
      incidentId: row.incident_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      owner: row.owner,
      target: JSON.parse(row.target),
      approvedValue: JSON.parse(row.approved_value),
      before: row.before_value ? JSON.parse(row.before_value) : null,
      after: row.after_value ? JSON.parse(row.after_value) : null,
      result: row.result ? JSON.parse(row.result) : null,
    };
  }

  state(incidentId) {
    const row = this.db
      .prepare(
        "SELECT * FROM source_recovery_operations WHERE incident_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(incidentId);
    return { operation: this.operation(row) };
  }

  async waitForOperation(id) {
    await this.running.get(id);
    return this.operation(
      this.db
        .prepare("SELECT * FROM source_recovery_operations WHERE id=?")
        .get(id),
    );
  }

  context(incidentId, { allowNewRequest = false } = {}) {
    const row = this.db
        .prepare("SELECT * FROM incidents WHERE id=?")
        .get(incidentId),
      incident = row && this.store.incident(row);
    if (
      !row ||
      row.status !== "open" ||
      incident?.type !== "data_quality_root_cause" ||
      incident?.demonstration ||
      !incident?.recoveryCandidate
    )
      fail(
        "source_incident_stale",
        "Инцидент уже закрыт, изменился или не содержит подтверждённого кандидата исходного значения.",
      );
    const doc = this.config.doctorDocuments.find(
        (item) =>
          item.id === incident.sourceId &&
          item.enabled &&
          item.adapter === "google",
      ),
      rule = doc?.dataQuality?.find(
        (item) => item.id === incident.dataQualityRule,
      ),
      sourceSheet = doc?.sheets.find(
        (sheet) => sheet.gid === rule?.source?.gid,
      ),
      productionSheet = doc?.sheets.find(
        (sheet) => sheet.gid === rule?.production?.gid,
      ),
      cellPoint = point(incident.cell);
    if (
      !doc ||
      !rule ||
      !sourceSheet ||
      !productionSheet ||
      sourceSheet.name !== rule.source.sheet ||
      incident.gid !== rule.source.gid ||
      incident.sheet !== sourceSheet.name ||
      incident.sourceFieldColumn !== rule.source.fieldColumn ||
      !cellPoint ||
      incident.cell !== rule.source.fieldColumn + cellPoint.row
    )
      fail(
        "source_target_unapproved",
        "Адрес не совпадает с действующим правилом обязательного исходного поля.",
        403,
      );
    const candidate = incident.recoveryCandidate,
      requestId = incident.id + ":" + row.generation,
      requestRow = this.db
        .prepare("SELECT * FROM repair_requests WHERE id=?")
        .get(requestId),
      request = requestRow && JSON.parse(requestRow.payload),
      savedFinding = request?.finding,
      savedCandidate = savedFinding?.recoveryCandidate;
    if (
      candidate.status !== "candidate" ||
      typeof candidate.value?.stringValue !== "string" ||
      (!requestRow && !allowNewRequest) ||
      (requestRow &&
        (requestRow.incident_id !== incident.id ||
          requestRow.generation !== row.generation ||
          !savedFinding ||
          savedFinding.cell !== incident.cell ||
          savedFinding.sheet !== incident.sheet ||
          savedFinding.dataQualityRule !== incident.dataQualityRule ||
          !equal(savedCandidate?.value, candidate.value) ||
          savedCandidate?.observedAt !== candidate.observedAt ||
          request?.ownerConfirmation?.owner !== "authenticated_local_owner" ||
          request?.ownerConfirmation?.sourceCell !== incident.cell ||
          request?.ownerConfirmation?.confirmation !== candidate.confirmation ||
          !equal(request?.ownerConfirmation?.value, candidate.value)))
    )
      fail(
        "source_request_stale",
        "Сохранённая заявка и текущий инцидент расходятся; восстановление отменено без записи.",
      );
    const snapshot = this.store.getSnapshot(
        "doctor:source-values:" + incident.sourceId,
      ),
      sourceCell = snapshot?.value?.cells?.[incident.cell],
      recentHistory = (sourceCell?.history || []).filter(
        (entry) =>
          entry?.origin === "entered" &&
          typeof entry?.value?.stringValue === "string" &&
          entry.value.stringValue.trim() !== "",
      ),
      lastKnown = recentHistory.at(-1),
      currentAt = Date.parse(sourceCell?.currentAt || snapshot?.at || ""),
      snapshotAt = Date.parse(snapshot?.at || ""),
      freshness = Math.max(currentAt || 0, snapshotAt || 0),
      ageMs = this.now() - freshness;
    if (
      !snapshot ||
      !sourceCell ||
      sourceCell.currentOrigin !== "entered" ||
      !lastKnown ||
      !Number.isFinite(freshness) ||
      ageMs < -5000 ||
      ageMs > this.config.snapshotMaxAgeMs ||
      !blank({
        userEnteredValue:
          sourceCell.currentOrigin === "entered" && sourceCell.current
            ? sourceCell.current
            : undefined,
        effectiveValue:
          sourceCell.currentOrigin === "formula_result" && sourceCell.current
            ? sourceCell.current
            : undefined,
      }) ||
      !equal(lastKnown.value, candidate.value) ||
      lastKnown.at !== candidate.observedAt
    )
      fail(
        "source_snapshot_stale",
        "Нет свежего успешного снимка, который подтверждает, что заявленное значение остаётся последним известным для пустой ячейки.",
      );
    const paths = incident.dependencyPaths || [],
      outputColumns = new Set(rule.production.errorColumns || []),
      productionRows = new Set();
    for (const path of paths) {
      const output = parsePathCell(path.outputCell);
      if (
        (!output.sheet || output.sheet === productionSheet.name) &&
        output.point &&
        outputColumns.has(String(output.cell.match(/^[A-Z]+/)?.[0] || ""))
      )
        productionRows.add(output.point.row);
      for (const value of path.cells || []) {
        const parsed = parsePathCell(value);
        if (
          parsed.sheet === productionSheet.name &&
          parsed.point &&
          outputColumns.has(String(parsed.cell.match(/^[A-Z]+/)?.[0] || ""))
        )
          productionRows.add(parsed.point.row);
      }
    }
    if (
      !productionRows.size ||
      productionRows.size > 20 ||
      [...productionRows].some(
        (value) =>
          value < (rule.production.startRow || 1) ||
          value > rule.production.maxRows,
      )
    )
      fail(
        "source_dependencies_stale",
        "Не удалось подтвердить текущие строки расчёта, зависящие от источника.",
      );
    const target = {
      documentId: doc.documentId,
      sheetId: sourceSheet.gid,
      sheet: sourceSheet.name,
      cell: incident.cell,
    };
    approvedTarget(target);
    return {
      incidentRow: row,
      incident,
      requestRow,
      request,
      requestId,
      doc,
      rule,
      sourceSheet,
      productionSheet,
      candidate,
      target,
      productionRows: [...productionRows].sort((a, b) => a - b),
      productKey: incident.observed?.productKey,
      sourceSnapshotAt: snapshot.at,
      candidateObservedAt: candidate.observedAt,
    };
  }

  async readLive(context) {
    const quote = (name) => "'" + name.replaceAll("'", "''") + "'!",
      ranges = [
        `${quote(context.sourceSheet.name)}A${context.incident.row}:Q${context.incident.row}`,
        ...context.productionRows.map(
          (row) => `${quote(context.productionSheet.name)}A${row}:AU${row}`,
        ),
      ];
    const data = await this.reader.get(
      context.doc.documentId,
      {
        ranges,
        fields:
          "spreadsheetId,sheets(properties(sheetId,title),merges,data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,dataValidation))))",
      },
      undefined,
      100,
    );
    if (data.spreadsheetId !== context.doc.documentId)
      fail("source_document_changed", "Google API вернул другой документ.");
    const source = data.sheets?.find(
        (item) => item.properties?.sheetId === context.sourceSheet.gid,
      ),
      production = data.sheets?.find(
        (item) => item.properties?.sheetId === context.productionSheet.gid,
      );
    if (
      source?.properties?.title !== context.sourceSheet.name ||
      production?.properties?.title !== context.productionSheet.name
    )
      fail(
        "source_sheet_changed",
        "Google API не подтвердил точные листы источника и расчёта.",
      );
    return {
      source,
      production,
      sourceCell: cellAt(source, context.incident.cell),
      productCell: cellAt(
        source,
        context.rule.source.keyColumn + context.incident.row,
      ),
      relatedCell: context.rule.source.relatedFieldColumn
        ? cellAt(
            source,
            context.rule.source.relatedFieldColumn + context.incident.row,
          )
        : {},
      productionCells: Object.fromEntries(
        context.productionRows.map((row) => [
          row,
          {
            article: cellAt(
              production,
              context.rule.production.articleColumn + row,
            ),
            formulas: Object.fromEntries(
              ["B", "C", ...(context.rule.production.errorColumns || [])].map(
                (column) => [column, cellAt(production, column + row)],
              ),
            ),
            guard: cellAt(
              production,
              context.rule.production.outputGuardColumn + row,
            ),
            operations: Object.fromEntries(
              (context.rule.production.operationColumns || []).map((column) => [
                column,
                cellAt(production, column + row),
              ]),
            ),
          },
        ]),
      ),
    };
  }

  validateBefore(context, live) {
    const targetCell = live.sourceCell,
      value = context.candidate.value.stringValue,
      merge = (live.source.merges || []).find((item) => {
        const p = point(context.incident.cell);
        return (
          (item.startRowIndex || 0) < p.row &&
          item.endRowIndex > p.row - 1 &&
          (item.startColumnIndex || 0) <= p.column &&
          item.endColumnIndex > p.column
        );
      });
    if (!blank(targetCell)) {
      const entered = enteredValue(targetCell);
      if (
        entered?.formulaValue === undefined &&
        entered?.stringValue === value &&
        valueOf(targetCell) === value
      )
        return { alreadyRestored: true, before: targetCell };
      fail(
        "source_cell_changed",
        `Ячейка ${context.incident.sheet}!${context.incident.cell} уже содержит другое значение; запись отменена.`,
      );
    }
    if (merge)
      fail(
        "source_cell_merged",
        "Целевая ячейка входит в объединённый диапазон; запись отменена.",
      );
    const validation = targetCell?.dataValidation,
      condition = validation?.condition;
    if (
      validation &&
      !(
        condition?.type === "ONE_OF_LIST" &&
        condition.values?.some((item) => item.userEnteredValue === value)
      )
    )
      fail(
        "source_validation_unverified",
        "Для исходной ячейки задано ограничение ввода, но точное значение нельзя подтвердить по разрешённым вариантам.",
      );
    if (
      typeof context.productKey !== "string" ||
      valueOf(live.productCell) !== context.productKey
    )
      fail(
        "source_product_changed",
        "Артикул строки каталога изменился после создания заявки; восстановление отменено.",
      );
    const formulas = {};
    for (const row of context.productionRows) {
      const current = live.productionCells[row];
      if (
        !current ||
        valueOf(current.article) !== context.productKey ||
        !["B", "C", ...(context.rule.production.errorColumns || [])].every(
          (column) =>
            typeof enteredValue(current.formulas[column])?.formulaValue ===
            "string",
        )
      )
        fail(
          "source_dependency_changed",
          `Артикул или формула цепочки в строке ${row} изменились; исходные формулы не переписывались.`,
        );
      formulas[row] = Object.fromEntries(
        Object.entries(current.formulas).map(([column, cell]) => [
          column,
          enteredValue(cell).formulaValue,
        ]),
      );
    }
    return { alreadyRestored: false, before: targetCell, formulas };
  }

  verifyDependents(context, live, beforeFormulas) {
    const rows = [];
    for (const row of context.productionRows) {
      const current = live.productionCells[row],
        article = valueOf(current?.article),
        productType = valueOf(current?.formulas?.B),
        norm = valueOf(current?.formulas?.C),
        output = valueOf(
          current?.formulas?.[context.rule.production.errorColumns[0]],
        ),
        guard = valueOf(current?.guard),
        active =
          typeof article === "string" &&
          article.trim() !== "" &&
          (context.rule.production.operationColumns || []).some((column) => {
            const value = valueOf(current.operations[column]);
            return (
              value !== null &&
              value !== undefined &&
              !(typeof value === "string" && value.trim() === "")
            );
          }),
        formulas = Object.fromEntries(
          Object.entries(current?.formulas || {}).map(([column, cell]) => [
            column,
            enteredValue(cell)?.formulaValue ?? null,
          ]),
        );
      if (
        article !== context.productKey ||
        productType !== context.candidate.value.stringValue ||
        typeof norm !== "number" ||
        !Number.isFinite(norm) ||
        output?.type ||
        (typeof guard === "string" &&
          guard.trim() !== "" &&
          (typeof output !== "number" || !Number.isFinite(output))) ||
        !equal(formulas, beforeFormulas[row])
      )
        fail(
          "dependent_recalculation_failed",
          `Проверка строки ${row} не подтвердила цепочку B${row} → C${row} → AP${row}: проверьте источник, формулы и пересчёт.`,
        );
      rows.push({
        row,
        productType,
        norm,
        coefficient: typeof output === "number" ? output : null,
        kpiActive: active && typeof guard === "string" && guard.trim() !== "",
        formulas,
      });
    }
    return rows;
  }

  startForIncident(incidentId, payload = {}) {
    if (
      payload.explicitWriteApproval !== true ||
      Object.keys(payload).sort().join(",") !==
        "explicitWriteApproval,incidentId" ||
      payload.incidentId !== incidentId
    )
      fail(
        "source_write_confirmation_required",
        "Нужно одно явное подтверждение записи точного адреса и значения.",
        403,
      );
    const currentIncident = this.db
        .prepare("SELECT generation FROM incidents WHERE id=?")
        .get(incidentId),
      prior =
        currentIncident &&
        this.db
          .prepare(
            "SELECT * FROM source_recovery_operations WHERE incident_id=? AND generation=? ORDER BY created_at DESC LIMIT 1",
          )
          .get(incidentId, currentIncident.generation);
    if (prior) {
      if (
        ["repairing", "checking", "verified", "already_restored"].includes(
          prior.status,
        )
      )
        return this.operation(prior);
      fail(
        "source_operation_not_retryable",
        "У операции уже есть результат или неопределённое состояние; автоматическая повторная запись заблокирована.",
      );
    }
    const context = this.context(incidentId, { allowNewRequest: true }),
      at = this.timestamp();
    const id = randomUUID(),
      target = {
        documentId: context.target.documentId,
        sheetId: context.target.sheetId,
        sheet: context.target.sheet,
        cell: context.target.cell,
      },
      authorization = {
        at,
        owner: "authenticated_local_owner",
        purpose: "explicit_source_value_write",
        source: "owner_confirmation_action",
        target,
        value: context.candidate.value,
      };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const activeFormulaRepair = this.db
          .prepare(
            "SELECT 1 FROM test_repair_proposals WHERE status IN ('queued','executing','checking') LIMIT 1",
          )
          .get(),
        activeSourceRecovery = this.db
          .prepare(
            "SELECT 1 FROM source_recovery_operations WHERE status IN ('repairing','checking') LIMIT 1",
          )
          .get();
      if (activeFormulaRepair || activeSourceRecovery)
        fail(
          "repair_operation_conflict",
          "Сейчас выполняется другое исправление; операция исходных данных не запущена.",
        );
      const fresh = this.context(incidentId, { allowNewRequest: true });
      if (fresh.requestId !== context.requestId)
        fail("source_request_stale", "Заявка изменилась перед запуском.");
      if (!fresh.requestRow) {
        const requestPayload = JSON.stringify({
          finding: fresh.incident,
          ownerConfirmation: {
            at,
            sourceCell: fresh.incident.cell,
            sheet: fresh.incident.sheet,
            value: fresh.candidate.value,
            confirmation: fresh.candidate.confirmation,
            owner: "authenticated_local_owner",
            googleSheetsChanged: false,
            purpose: "explicit_source_value_write",
          },
        });
        this.db
          .prepare("INSERT INTO repair_requests VALUES(?,?,?,?,?,?)")
          .run(
            context.requestId,
            incidentId,
            context.incidentRow.generation,
            at,
            "pending",
            requestPayload,
          );
      }
      const currentRequest = this.db
        .prepare("SELECT status FROM repair_requests WHERE id=?")
        .get(context.requestId);
      if (!currentRequest || currentRequest.status !== "pending")
        fail(
          "source_request_unavailable",
          "Сохранённая заявка уже обрабатывается или завершена.",
        );
      this.db
        .prepare(
          "INSERT INTO source_recovery_operations(id,request_id,incident_id,generation,status,created_at,updated_at,owner,target,approved_value,authorization,before_value,after_value,result) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          context.requestId,
          incidentId,
          context.incidentRow.generation,
          "repairing",
          at,
          at,
          authorization.owner,
          JSON.stringify(target),
          JSON.stringify(context.candidate.value),
          JSON.stringify(authorization),
          null,
          null,
          null,
        );
      this.db
        .prepare("UPDATE repair_requests SET status='executing' WHERE id=?")
        .run(context.requestId);
      this.store.log(
        "source_recovery_authorized",
        `Владелец разрешил точечную запись ${context.incident.sheet}!${context.incident.cell} = ${context.candidate.value.stringValue}; проверяется текущее состояние`,
        incidentId,
        at,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const pending = this.execute(id);
    this.running.set(id, pending);
    void pending.finally(() => this.running.delete(id));
    return this.operation(
      this.db
        .prepare("SELECT * FROM source_recovery_operations WHERE id=?")
        .get(id),
    );
  }

  setOperation(id, status, { before, after, result, requestStatus } = {}) {
    const at = this.timestamp(),
      assignments = ["status=?", "updated_at=?"],
      values = [status, at];
    for (const [column, value] of [
      ["before_value", before],
      ["after_value", after],
      ["result", result],
    ])
      if (value !== undefined) {
        assignments.push(column + "=?");
        if (column === "result" && value && typeof value === "object") {
          const prior = this.db
            .prepare("SELECT result FROM source_recovery_operations WHERE id=?")
            .get(id)?.result;
          values.push(
            JSON.stringify({ ...(prior ? JSON.parse(prior) : {}), ...value }),
          );
        } else values.push(value === null ? null : JSON.stringify(value));
      }
    values.push(id);
    this.db
      .prepare(
        `UPDATE source_recovery_operations SET ${assignments.join(",")} WHERE id=?`,
      )
      .run(...values);
    if (requestStatus) {
      const row = this.db
        .prepare(
          "SELECT request_id,incident_id FROM source_recovery_operations WHERE id=?",
        )
        .get(id);
      this.db
        .prepare("UPDATE repair_requests SET status=? WHERE id=?")
        .run(requestStatus, row.request_id);
    }
    return at;
  }

  recordStage(id, name, stage) {
    const row = this.db
        .prepare(
          "SELECT status,created_at,result FROM source_recovery_operations WHERE id=?",
        )
        .get(id),
      prior = row?.result ? JSON.parse(row.result) : {},
      timing = prior.timing || { startedAt: row?.created_at, stages: {} },
      stages = { ...(timing.stages || {}) },
      previous = stages[name] || {};
    stages[name] = { ...previous, label: stageLabels[name] || name, ...stage };
    const at = this.now();
    this.setOperation(id, row.status, {
      result: {
        timing: {
          ...timing,
          startedAt: timing.startedAt || row.created_at,
          totalMs: Math.max(0, at - Date.parse(row.created_at)),
          stages,
        },
      },
    });
  }

  async timedStage(id, name, work) {
    const startedAt = this.timestamp(),
      started = performance.now(),
      details = {};
    this.recordStage(id, name, { status: "running", startedAt });
    try {
      const value = await work(details);
      this.recordStage(id, name, {
        ...details,
        status: "completed",
        startedAt,
        completedAt: this.timestamp(),
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      });
      return value;
    } catch (error) {
      this.recordStage(id, name, {
        ...details,
        status: "failed",
        startedAt,
        completedAt: this.timestamp(),
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        errorCode: error.code || "source_recovery_failed",
      });
      throw error;
    }
  }

  async execute(id) {
    let writeStarted = false,
      apiConfirmed = false;
    const row = this.db
        .prepare("SELECT * FROM source_recovery_operations WHERE id=?")
        .get(id),
      operation = this.operation(row);
    if (!operation || operation.status !== "repairing") return;
    try {
      let context;
      const { beforeRead, preflight } = await this.timedStage(
        id,
        "preflight",
        async () => {
          context = this.context(operation.incidentId);
          if (context.requestId !== operation.requestId)
            fail(
              "source_request_stale",
              "Заявка изменилась до повторного чтения.",
            );
          const live = await this.readLive(context);
          return {
            beforeRead: live,
            preflight: this.validateBefore(context, live),
          };
        },
      );
      if (preflight.alreadyRestored) {
        const dependentRows = this.verifyDependents(
          context,
          beforeRead,
          Object.fromEntries(
            context.productionRows.map((r) => [
              r,
              Object.fromEntries(
                Object.entries(beforeRead.productionCells[r].formulas).map(
                  ([column, cell]) => [
                    column,
                    enteredValue(cell)?.formulaValue,
                  ],
                ),
              ),
            ]),
          ),
        );
        await this.finishDoctorCheck(context, id, {
          changed: false,
          before: beforeRead.sourceCell,
          after: beforeRead.sourceCell,
          dependentRows,
          reason:
            "Значение уже восстановлено до запуска; повторная запись не выполнялась.",
          sourceReadAt: this.timestamp(),
        });
        return;
      }
      const permission = await this.timedStage(id, "writer_access", () =>
        this.writer.verifyIsolation(context.target),
      );
      if (permission?.canEdit !== true)
        fail(
          "writer_access_unverified",
          "Google подтвердил чтение, но не подтвердил право записи; таблица не изменена.",
          403,
        );
      const previousContext = context,
        latest = this.context(operation.incidentId),
        confirmRead = await this.timedStage(id, "pre_write_recheck", () =>
          this.readLive(latest),
        ),
        confirm = this.validateBefore(latest, confirmRead);
      if (
        latest.requestId !== operation.requestId ||
        latest.incidentRow.generation !==
          previousContext.incidentRow.generation ||
        !equal(latest.candidate.value, previousContext.candidate.value) ||
        !sameCellState(beforeRead.sourceCell, confirmRead.sourceCell) ||
        confirm.alreadyRestored ||
        !equal(preflight.formulas, confirm.formulas)
      )
        fail(
          "source_cell_changed",
          "Повторное чтение перед записью выявило изменение источника; запись отменена.",
        );
      context = latest;
      const preWriteAt = this.timestamp();
      this.setOperation(id, "repairing", {
        before: beforeRead.sourceCell,
        result: {
          phase: "write_started",
          at: preWriteAt,
          access: permission,
          sourceSnapshotAt: context.sourceSnapshotAt,
          candidateObservedAt: context.candidateObservedAt,
          dependentRows: context.productionRows,
          formulasBefore: preflight.formulas,
          atomicCompareAndSet: false,
        },
      });
      writeStarted = true;
      const api = await this.timedStage(id, "write", () =>
        this.writer.writeSourceValue({
          operationId: id,
          target: context.target,
          value: context.candidate.value,
          ownerAuthorization: true,
        }),
      );
      apiConfirmed = true;
      this.setOperation(id, "checking", {
        result: {
          phase: "checking",
          writeAt: this.timestamp(),
          api,
          sourceSnapshotAt: context.sourceSnapshotAt,
          candidateObservedAt: context.candidateObservedAt,
          formulasBefore: preflight.formulas,
          atomicCompareAndSet: false,
        },
      });
      const { checked, afterState } = await this.timedStage(
        id,
        "post_write_readback",
        async (timing) => {
          let checked = null,
            afterState = null,
            lastError = null;
          timing.attempts = 0;
          timing.maxAttempts = 5;
          for (let attempt = 0; attempt < 5; attempt++) {
            timing.attempts = attempt + 1;
            try {
              const live = await this.readLive(context);
              const entered = enteredValue(live.sourceCell);
              if (
                entered?.formulaValue !== undefined ||
                !equal(entered, context.candidate.value) ||
                valueOf(live.sourceCell) !== context.candidate.value.stringValue
              )
                fail(
                  "source_value_readback_mismatch",
                  `Повторное чтение ${context.incident.sheet}!${context.incident.cell} не подтвердило записанное значение.`,
                );
              checked = this.verifyDependents(
                context,
                live,
                preflight.formulas,
              );
              afterState = live.sourceCell;
              break;
            } catch (error) {
              lastError = error;
              if (
                ![
                  "dependent_recalculation_failed",
                  "source_value_readback_mismatch",
                ].includes(error.code) ||
                attempt === 4
              )
                throw error;
              await delay(this.retryDelayMs);
            }
          }
          if (!checked) throw lastError || new Error("Readback not confirmed");
          return { checked, afterState };
        },
      );
      await this.finishDoctorCheck(context, id, {
        changed: true,
        before: beforeRead.sourceCell,
        after: afterState,
        dependentRows: checked,
        writeAt: this.timestamp(),
        api,
        sourceReadAt: this.timestamp(),
        formulasBefore: preflight.formulas,
        atomicCompareAndSet: false,
      });
    } catch (error) {
      const latestRow = this.db
          .prepare("SELECT * FROM source_recovery_operations WHERE id=?")
          .get(id),
        prior = this.operation(latestRow),
        uncertain =
          writeStarted && !apiConfirmed && error.code !== "write_rejected",
        status = uncertain
          ? "uncertain"
          : writeStarted && apiConfirmed
            ? "written_unverified"
            : "blocked",
        code = error.code || "source_recovery_failed",
        message = error.message || "Восстановление не выполнено";
      this.setOperation(id, status, {
        result: {
          ...(prior?.result || {}),
          phase: status,
          failedAt: this.timestamp(),
          code,
          message:
            status === "written_unverified"
              ? `Записано, проверка не завершена: ${message}. Повторная запись запрещена.`
              : message,
          writeConfirmed: apiConfirmed,
          writeStarted,
          retryAllowed: false,
        },
        requestStatus: "needs_review",
      });
      this.store.log(
        uncertain
          ? "source_recovery_uncertain"
          : status === "blocked"
            ? "source_recovery_blocked"
            : "source_recovery_written_unverified",
        `${status === "written_unverified" ? "Записано, проверка не завершена. " : ""}${message} Код: ${code}. Повторная запись запрещена.`,
        prior?.incidentId || null,
        this.timestamp(),
      );
    }
  }

  async finishDoctorCheck(context, id, evidence) {
    const checkStartedAt = this.now(),
      result = await this.timedStage(id, "full_doctor_check", () =>
        this.doctor.runDocument(context.incident.sourceId),
      ),
      documentCheck = result?.documents?.find(
        (document) => document.id === context.incident.sourceId,
      )?.check,
      checkAt = documentCheck?.readVerifiedAt,
      documentRun = result?.documentRun,
      explicitRunComplete =
        documentRun?.documentId === context.incident.sourceId &&
        documentRun.complete === true &&
        typeof documentRun.startedAt === "string" &&
        Date.parse(documentRun.startedAt) >= checkStartedAt - 1000 &&
        typeof documentRun.at === "string" &&
        Number.isFinite(Date.parse(documentRun.at)) &&
        Date.parse(documentRun.at) >= Date.parse(documentRun.startedAt) - 1000,
      stateCheckComplete =
        documentCheck?.status === "ok" &&
        !documentCheck.errorCode &&
        typeof checkAt === "string" &&
        Number.isFinite(Date.parse(checkAt)) &&
        Date.parse(checkAt) >= checkStartedAt - 1000,
      fullCheckComplete = explicitRunComplete || stateCheckComplete;
    const incident = this.db
        .prepare("SELECT * FROM incidents WHERE id=?")
        .get(context.incident.id),
      current = incident && this.store.incident(incident),
      errors = evidence.dependentRows.filter(
        (row) =>
          row.norm === null || (row.coefficient === null && row.kpiActive),
      );
    if (
      !fullCheckComplete ||
      !incident ||
      incident.status !== "resolved" ||
      errors.length
    )
      fail(
        "source_full_check_failed",
        "Точечное чтение выполнено, но полный Table Doctor не подтвердил закрытие инцидента и восстановление зависимостей.",
      );
    const at = this.timestamp(),
      operationRow = this.db
        .prepare("SELECT * FROM source_recovery_operations WHERE id=?")
        .get(id),
      authorization = JSON.parse(operationRow.authorization),
      target = JSON.parse(operationRow.target),
      fullDoctorCheck = {
        complete: true,
        sourceId: context.incident.sourceId,
        status: documentRun?.status || documentCheck?.status || "ok",
        startedAt:
          documentRun?.startedAt || new Date(checkStartedAt).toISOString(),
        readVerifiedAt: documentRun?.at || checkAt,
        verification: explicitRunComplete
          ? "document_run_contract"
          : "fresh_document_state_compatibility",
      },
      resolutionCause = evidence.changed
        ? `Исправлено агентом после подтверждения владельца: ${context.incident.sheet}!${context.incident.cell} восстановлена; B/C/AP и полный Table Doctor проверены ${at}.`
        : `Источник уже был восстановлен до записи; повторное чтение и полный Table Doctor подтвердили цепочку ${at}.`;
    return this.timedStage(id, "finalize", () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const payload = JSON.parse(incident.payload);
        payload.resolutionCause = resolutionCause;
        payload.resolutionAt = at;
        payload.resolvedBy = evidence.changed
          ? "agent_after_owner_confirmation"
          : "external_change_verified";
        payload.sourceRecoveryOperationId = id;
        payload.sourceRecoveryEvidence = {
          target,
          owner: authorization.owner,
          ownerConfirmedAt: authorization.at,
          before: evidence.before,
          after: evidence.after,
          dependentRows: evidence.dependentRows,
          fullCheckAt:
            documentRun?.at ||
            result?.at ||
            checkAt ||
            result?.lastSuccessfulCheck ||
            at,
          changedByAgent: evidence.changed,
        };
        this.db
          .prepare(
            "UPDATE incidents SET workflow='resolved',resolved_at=?,payload=? WHERE id=? AND status='resolved'",
          )
          .run(at, JSON.stringify(payload), context.incident.id);
        this.setOperation(
          id,
          evidence.changed ? "verified" : "already_restored",
          {
            after: evidence.after,
            result: {
              ...evidence,
              phase: evidence.changed ? "verified" : "already_restored",
              verifiedAt: at,
              fullDoctorCheck,
              resolutionCause,
              writeSucceeded: evidence.changed,
            },
            requestStatus: "completed",
          },
        );
        this.store.log(
          evidence.changed
            ? "source_recovery_verified"
            : "source_recovery_already_restored",
          resolutionCause,
          context.incident.id,
          at,
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return current;
    });
  }
}
