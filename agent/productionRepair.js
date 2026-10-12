// Owner-confirmed writes reuse the existing proposal/backup/audit execution engine.
import { randomUUID } from "node:crypto";
import { TestRepairService } from "./testRepair.js";
import { TestSheetsWriter, RepairError } from "./testSheetsWriter.js";
import { PRODUCTION_DOCTOR_DOCUMENTS } from "./productionRegistry.js";
import { digest, gridViews } from "./diagnosticGrid.js";
const same = (a, b) => digest(a) === digest(b);
const fail = (code, message, status = 409) => {
  throw new RepairError(code, message, status);
};
const input = (v) =>
  v?.formulaValue ??
  v?.stringValue ??
  v?.numberValue ??
  v?.boolValue ??
  "(пусто)";
export function approvedTarget(target) {
  const doc = PRODUCTION_DOCTOR_DOCUMENTS.find(
    (d) => d.documentId === target?.documentId,
  );
  const tab = doc?.sheets.find(
    (s) => s.gid === target?.sheetId && s.name === target?.sheet,
  );
  if (!tab || !/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(target?.cell || ""))
    fail(
      "target_forbidden",
      "Адрес вне разрешённых трёх документов и семи листов",
      403,
    );
  return tab;
}
// Compatibility for an existing Tailscale read endpoint, NOT proof of private
// network isolation. Repair requests still require loopback Host/Origin/socket.
export function isTailscaleReadOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}
export function validateProductionRepairConfig(config) {
  if (!config.productionRepairEnabled) return;
  if (
    config.port !== 4318 ||
    (config.publicOrigin && !isTailscaleReadOrigin(config.publicOrigin)) ||
    config.testWriterCredentialsFile ||
    config.doctorDemoEnabled ||
    !config.productionWriterCredentialsFile ||
    !config.productionWriterEmail ||
    config.productionWriterEmail ===
      "ritm-table-doctor@ritm-intelligence.iam.gserviceaccount.com" ||
    !/^[a-z0-9-]+@ritm-intelligence\.iam\.gserviceaccount\.com$/.test(
      config.productionWriterEmail,
    ) ||
    !config.googleCredentialsFile ||
    config.productionWriterCredentialsFile === config.googleCredentialsFile
  )
    fail(
      "writer_configuration_invalid",
      "Исправление требует отдельного ключа записи и основного localhost:4318; удалённый адрес допускается только для существующего доступа через Tailscale",
      503,
    );
}
export class ProductionSheetsWriter extends TestSheetsWriter {
  async verifySheetsAccess(target, driveCheck = null) {
    this.metrics.readRequests++;
    let response;
    try {
      response = await this.fetcher(
        `https://sheets.googleapis.com/v4/spreadsheets/${target.documentId}?includeGridData=false&fields=spreadsheetId,sheets(properties(sheetId,title))`,
        {
          method: "GET",
          redirect: "error",
          headers: { authorization: "Bearer " + (await this.token()) },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      fail(
        "writer_sheets_unavailable",
        "Не удалось проверить документ через Google Sheets API",
        503,
      );
    }
    if (!response.ok) {
      let reason = "";
      if (response.status === 404)
        fail(
          "writer_document_not_found",
          "Документ недоступен аккаунту записи через Google Sheets API; проверьте доступ к документу",
          403,
        );
      try {
        const error = await response.json();
        reason = error.error?.errors?.[0]?.reason || error.error?.status || "";
      } catch {}
      if (response.status === 403)
        fail(
          reason === "SERVICE_DISABLED"
            ? "sheets_api_disabled"
            : "writer_sheets_forbidden",
          reason === "SERVICE_DISABLED"
            ? "Google Sheets API отключён для проекта; включите его в Google Cloud Console"
            : "Google Sheets API отказал аккаунту записи; проверьте доступ к документу",
          403,
        );
      fail(
        "writer_sheets_unavailable",
        "Google Sheets API временно недоступен; повторите проверку позже",
        503,
      );
    }
    const data = await response.json();
    const sheet = data.sheets?.find(
      (item) => item.properties?.sheetId === target.sheetId,
    );
    if (
      data.spreadsheetId !== target.documentId ||
      !sheet ||
      sheet.properties?.title !== target.sheet
    )
      fail(
        "writer_sheet_mismatch",
        "Sheets API не подтвердил документ и лист из белого списка",
        403,
      );
    this.verifiedAt = new Date(this.now()).toISOString();
    const audit = {
      verifiedAt: this.verifiedAt,
      googleIsolation: "not_guaranteed",
      applicationScope: "approved_single_cell",
      canEdit: "unverified",
      accessCheck: "sheets_api_metadata_only",
    };
    if (!driveCheck) return audit;
    const reason = String(driveCheck.reason || "");
    const permissionReason =
      reason === "SERVICE_DISABLED" || reason === "accessNotConfigured"
        ? "drive_api_disabled"
        : reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT"
          ? "drive_scope_insufficient"
          : driveCheck.status === 404
            ? "drive_file_not_visible"
            : "drive_capability_check_denied";
    const requiredAction =
      permissionReason === "drive_api_disabled"
        ? "Включить Google Drive API в проекте ritm-intelligence. Это нужно только для предварительного чтения capabilities.canEdit; права доступа к таблице не меняются."
        : permissionReason === "drive_scope_insufficient"
          ? "Проверить, что writer OAuth-токен содержит scope https://www.googleapis.com/auth/drive.metadata.readonly, затем перезапустить агент."
          : permissionReason === "drive_file_not_visible"
            ? "Проверить, что аккаунт записи добавлен к этому документу. Чтение через Sheets API само по себе не подтверждает право редактирования."
            : "Проверить доступ аккаунта записи к Google Drive API и документу. Право редактирования этим ответом не подтверждено. Для точной предварительной проверки включить Google Drive API в проекте ritm-intelligence.";
    return {
      ...audit,
      permissionReason,
      driveApiStatus: driveCheck.status,
      requiredAction,
      message:
        permissionReason === "drive_api_disabled"
          ? "Google Sheets доступен для чтения, но Google Drive API проекта отключён (" +
            reason +
            "). Поэтому canEdit не проверен. Для предварительной проверки включите Google Drive API; это не выдаёт аккаунту новых прав. Любая запись всё равно требует отдельного подтверждения владельца и будет разрешена Google только при наличии Editor-доступа."
          : permissionReason === "drive_scope_insufficient"
            ? "Google Drive не выполнил проверку canEdit: OAuth-токену не хватает scope drive.metadata.readonly. Таблица не изменялась. " +
              requiredAction
            : "Google Drive не подтвердил право canEdit (" +
              (reason || "HTTP " + driveCheck.status) +
              "). Таблица доступна только через Sheets API; право записи остаётся непроверенным. " +
              requiredAction,
    };
  }
  async verifyIsolation(target) {
    approvedTarget(target);
    this.verifiedAt = null;
    this.canEditVerifiedAt = null;
    const token = await this.token();
    this.metrics.readRequests++;
    let response;
    try {
      response = await this.fetcher(
        `https://www.googleapis.com/drive/v3/files/${target.documentId}?fields=id,capabilities(canEdit)`,
        {
          method: "GET",
          redirect: "error",
          headers: { authorization: "Bearer " + token },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      fail(
        "writer_access_unavailable",
        "Не удалось проверить права записи",
        503,
      );
    }
    if (!response.ok) {
      let reason = "";
      try {
        const error = await response.json();
        reason = error.error?.errors?.[0]?.reason || error.error?.status || "";
      } catch {}
      // Drive metadata is optional. Preserve the exact reason when falling
      // back to read-only Sheets metadata; a successful Sheets GET cannot
      // prove edit permission.
      if (response.status === 403 || response.status === 404)
        return this.verifySheetsAccess(target, {
          status: response.status,
          reason,
        });
      if (response.status === 404)
        fail(
          "writer_document_not_found",
          "Google Drive не показывает документ аккаунту записи; проверьте, что документ доступен этому аккаунту",
          403,
        );
      if (reason === "SERVICE_DISABLED")
        fail(
          "drive_api_disabled",
          "Google Drive API отключён для проекта сервисного аккаунта",
          503,
        );
      if (response.status === 403)
        fail(
          "writer_drive_forbidden",
          reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT"
            ? "Google Drive отклонил проверку: не выдано требуемое разрешение OAuth"
            : "Google Drive отказал в проверке прав; проверьте доступ аккаунта и настройки API",
          403,
        );
      fail(
        "writer_drive_unavailable",
        response.status === 429 || response.status >= 500
          ? "Google Drive временно недоступен или ограничил запрос; повторите позже"
          : "Google Drive не подтвердил права аккаунта записи",
        503,
      );
    }
    const data = await response.json();
    if (data.id !== target.documentId || data.capabilities?.canEdit !== true)
      fail(
        "writer_access_denied",
        "Аккаунт записи не может редактировать этот документ",
        403,
      );
    this.verifiedAt = new Date(this.now()).toISOString();
    this.canEditVerifiedAt = this.verifiedAt;
    return {
      verifiedAt: this.verifiedAt,
      googleIsolation: "not_guaranteed",
      applicationScope: "approved_single_cell",
      canEdit: true,
      accessCheck: "drive_capabilities",
    };
  }
  async conditionalReplace(direction, p) {
    approvedTarget(p?.target);
    if (
      !this.verifiedAt ||
      !["repair", "rollback"].includes(direction) ||
      !p?.to ||
      (direction === "repair" &&
        (typeof p.to.formulaValue !== "string" ||
          !p.to.formulaValue.startsWith("=")))
    )
      fail("write_forbidden", "Нет подтверждённого точечного предложения", 403);
    const [, col, r] = p.target.cell.match(/^([A-Z]+)(\d+)$/);
    const ci = [...col].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const row = Number(r) - 1;
    const token = await this.token();
    // ONE native userEnteredValue; preserve formatting/validation. No automatic retry.
    // Sheets has no typed CAS. Acknowledged pre-read/write race remains possible.
    this.metrics.writeRequests++;
    let response;
    try {
      response = await this.fetcher(
        `https://sheets.googleapis.com/v4/spreadsheets/${p.target.documentId}:batchUpdate`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requests: [
              {
                updateCells: {
                  range: {
                    sheetId: p.target.sheetId,
                    startRowIndex: row,
                    endRowIndex: row + 1,
                    startColumnIndex: ci,
                    endColumnIndex: ci + 1,
                  },
                  rows: [{ values: [{ userEnteredValue: p.to }] }],
                  fields: "userEnteredValue",
                },
              },
            ],
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      fail(
        "write_uncertain",
        "Результат записи неизвестен; повтор запрещён",
        503,
      );
    }
    if (response.status === 403)
      fail(
        "write_rejected",
        "Google отклонил запись; ячейка не изменена. Проверьте права аккаунта записи",
        403,
      );
    if (!response.ok)
      fail(
        "write_uncertain",
        "Google не подтвердил запись; повтор запрещён",
        503,
      );
    let result;
    try {
      result = await response.json();
    } catch {
      fail("write_uncertain", "Ответ записи не прочитан; повтор запрещён", 503);
    }
    if (
      result.spreadsheetId !== p.target.documentId ||
      result.replies?.length !== 1
    )
      fail(
        "write_uncertain",
        "Неожиданный ответ записи; нужна ручная проверка",
        503,
      );
    return { changed: 1, ...this.metrics, atomic: false };
  }

  async writeSourceValue({
    operationId,
    target,
    value,
    ownerAuthorization,
  } = {}) {
    approvedTarget(target);
    if (
      !/^[0-9a-f-]{36}$/i.test(operationId || "") ||
      ownerAuthorization !== true ||
      !value ||
      Object.keys(value).length !== 1 ||
      typeof value.stringValue !== "string" ||
      !value.stringValue.trim() ||
      !this.verifiedAt ||
      this.canEditVerifiedAt !== this.verifiedAt ||
      this.now() - Date.parse(this.verifiedAt) > 60000
    )
      fail(
        "source_write_not_authorized",
        "Нет свежего подтверждения права записи и точечного разрешения владельца.",
        403,
      );
    const [, col, rowText] = target.cell.match(/^([A-Z]+)(\d+)$/),
      columnIndex = [...col].reduce(
        (n, c) => n * 26 + c.charCodeAt(0) - 64,
        0,
      ) - 1,
      rowIndex = Number(rowText) - 1,
      token = await this.token();
    this.metrics.writeRequests++;
    let response;
    try {
      response = await this.fetcher(
        `https://sheets.googleapis.com/v4/spreadsheets/${target.documentId}:batchUpdate`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            requests: [
              {
                updateCells: {
                  range: {
                    sheetId: target.sheetId,
                    startRowIndex: rowIndex,
                    endRowIndex: rowIndex + 1,
                    startColumnIndex: columnIndex,
                    endColumnIndex: columnIndex + 1,
                  },
                  rows: [{ values: [{ userEnteredValue: value }] }],
                  fields: "userEnteredValue",
                },
              },
            ],
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      fail(
        "write_uncertain",
        `Google Sheets не вернул подтверждение записи ${target.sheet}!${target.cell}; результат неизвестен, повтор запрещён.`,
        503,
      );
    }
    if ([400, 401, 403].includes(response.status))
      fail(
        "write_rejected",
        `Google Sheets отклонил запись ${target.sheet}!${target.cell} (HTTP ${response.status}); повтор не выполнялся.`,
        response.status === 403 ? 403 : 409,
      );
    if (!response.ok)
      fail(
        "write_uncertain",
        `Google Sheets не подтвердил запись ${target.sheet}!${target.cell} (HTTP ${response.status}); результат неизвестен, повтор запрещён.`,
        503,
      );
    let result;
    try {
      result = await response.json();
    } catch {
      fail(
        "write_uncertain",
        "Ответ Google Sheets после записи не прочитан; повтор запрещён.",
        503,
      );
    }
    if (result.spreadsheetId !== target.documentId || result.replies?.length !== 1)
      fail(
        "write_uncertain",
        "Google Sheets вернул неожиданный ответ; требуется ручная сверка, повтор запрещён.",
        503,
      );
    return {
      changed: 1,
      operationId,
      target,
      ...this.metrics,
      atomicCompareAndSet: false,
    };
  }
}
export class ProductionRepairService extends TestRepairService {
  constructor(store, config, deps) {
    validateProductionRepairConfig(config);
    super(store, config, deps);
    this.production = true;
    this.queueRunning = false;
    this.checkRunning = false;
  }
  event(id, incidentId, type, payload) {
    const at = new Date(this.now()).toISOString();
    this.db
      .prepare(
        "INSERT INTO test_repair_events(proposal_id,at,type,payload) VALUES(?,?,?,?)",
      )
      .run(id, at, type, JSON.stringify(payload));
    const labels = {
      repair_queued: "Исправление поставлено в очередь",
      repair_cell_verified: "Google Sheets подтвердил формулу после записи",
      repair_postcheck_failed: "Повторная проверка требует решения владельца",
      repair_proposed: "Подготовлено точечное исправление; записи не было",
      repair_confirmed: "Владелец подтвердил точное изменение",
      repair_backup: "Исходная ячейка сохранена для отката",
      repair_write_started: "Начата согласованная запись одной ячейки",
      repair_verified: "Повторное чтение и Table Doctor подтвердили результат",
      repair_uncertain:
        "Результат требует ручной проверки; повтор заблокирован",
      repair_cancelled: "Исправление отменено без повторной записи",
    };
    this.store.log(type, labels[type] || type, incidentId, at);
  }
  state(id) {
    return {
      ...super.state(id),
      testOnly: false,
      target: undefined,
      production: true,
      queue: this.queueState(),
    };
  }
  queueState() {
    const rows = this.db
        .prepare(
          "SELECT id,incident_id,status,payload,result FROM test_repair_proposals ORDER BY rowid DESC LIMIT 100",
        )
        .all(),
      today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Moscow",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(this.now()));
    const items = rows.map((row) => {
      const p = JSON.parse(row.payload),
        result = row.result ? JSON.parse(row.result) : null;
      return {
        id: row.id,
        incidentId: row.incident_id,
        status: row.status,
        createdAt: p.createdAt,
        sourceName: p.sourceName,
        direction: p.direction,
        target: p.target,
        confirmation: p.confirmation,
        resultAt: result?.at || null,
        errorCode: result?.errorCode || null,
        message: result?.message || null,
      };
    });
    return {
      awaitingConfirmation: items.filter((x) => x.status === "pending").length,
      queued: items.filter((x) => x.status === "queued").length,
      executing: items.filter((x) => x.status === "executing").length,
      checking: items.filter((x) => x.status === "checking").length,
      needsDecision: items.filter((x) =>
        ["needs_review", "uncertain"].includes(x.status),
      ).length,
      fixedToday: items.filter(
        (x) =>
          x.status === "verified" &&
          x.resultAt &&
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Moscow",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(x.resultAt)) === today,
      ).length,
      items,
    };
  }
  incident(id, open) {
    const row = this.db.prepare("SELECT * FROM incidents WHERE id=?").get(id);
    const i = row && this.store.incident(row);
    const doc = this.config.doctorDocuments.find(
      (d) => d.id === i?.sourceId && d.enabled && d.adapter === "google",
    );
    const sheet = doc?.sheets.find((s) => s.name === i?.sheet);
    const target = {
      documentId: doc?.documentId,
      sheetId: sheet?.gid,
      sheet: i?.sheet,
      cell: i?.cell,
    };
    approvedTarget(target);
    if (
      !i ||
      i.demonstration ||
      !i.baselineVersion ||
      !i.formulaRegionId ||
      i.verification !== "rule_confirmed" ||
      ![
        "formula_number",
        "formula_text",
        "formula_missing",
        "formula_mismatch",
      ].includes(i.type) ||
      (open &&
        (row.status !== "open" || ["ignored", "excepted"].includes(i.status)))
    )
      fail(
        "incident_forbidden",
        "Исправление возможно только для подтверждённого нарушения утверждённого эталона",
        403,
      );
    const b = this.db
      .prepare(
        "SELECT * FROM formula_protected WHERE source_id=? AND gid=? AND cell=?",
      )
      .get(doc.id, sheet.gid, i.cell);
    if (
      !b ||
      b.version !== i.baselineVersion ||
      b.region_id !== i.formulaRegionId ||
      b.formula !== i.expected
    )
      fail(
        "baseline_changed",
        "Эталон изменился или отозван; сначала нужна новая проверка",
      );
    return { generation: row.generation, incident: i, baseline: b, target };
  }
  async snapshot(target) {
    approvedTarget(target);
    const [, col, row] = target.cell.match(/^([A-Z]+)(\d+)$/);
    const ci = [...col].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const ri = Number(row) - 1;
    const result = await this.reader.get(
      target.documentId,
      {
        ranges: [`'${target.sheet.replaceAll("'", "''")}'!${target.cell}`],
        fields:
          "spreadsheetId,sheets(properties(sheetId,title),merges,data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,dataValidation))))",
      },
      undefined,
      80,
    );
    if (result.spreadsheetId !== target.documentId)
      fail("structure_changed", "Документ не подтверждён");
    const view = gridViews(result).get(target.sheetId);
    if (!view || view.sheet.properties.title !== target.sheet)
      fail("structure_changed", "Лист изменился");
    const merge = (view.sheet.merges || []).find(
      (m) =>
        (m.startRowIndex || 0) <= ri &&
        m.endRowIndex > ri &&
        (m.startColumnIndex || 0) <= ci &&
        m.endColumnIndex > ci,
    );
    if (
      merge &&
      ((merge.startRowIndex || 0) !== ri ||
        (merge.startColumnIndex || 0) !== ci)
    )
      fail("merge_interior", "Внутренняя ячейка объединения не разрешена");
    const c = view.cell(col, Number(row));
    return {
      cell: c.userEnteredValue || {},
      effective: c.effectiveValue || {},
      formatted: c.formattedValue || "",
      validation: c.dataValidation || null,
      merge: merge
        ? JSON.stringify([
            merge.startRowIndex || 0,
            merge.endRowIndex,
            merge.startColumnIndex || 0,
            merge.endColumnIndex,
          ])
        : null,
    };
  }
  sourceVersion(p) {
    const { baseline, target } = this.incident(
      p.incidentId,
      p.direction === "repair",
    );
    return digest({ baseline, target });
  }
  async prepare(id, direction = "repair", previousId = null) {
    if (this.busy && !this.production)
      fail(
        "repair_busy",
        "Уже выполняется другое исправление или его контрольный цикл. Дождитесь завершения и повторите; новая запись не выполнялась.",
      );
    if (!["repair", "rollback"].includes(direction))
      fail(
        "direction_forbidden",
        "Для исправления указан недопустимый режим.",
        400,
      );
    this.busy = true;
    try {
      const { incident, baseline, target, generation } = this.incident(
        id,
        direction === "repair",
      );
      if (
        !this.production &&
        this.db
          .prepare(
            "SELECT id FROM test_repair_proposals WHERE status IN ('executing','uncertain')",
          )
          .get()
      )
        fail(
          "unresolved_write",
          "Есть непроверенная запись; сначала проверьте журнал",
        );
      let previous;
      if (direction === "rollback") {
        const r = this.db
          .prepare(
            "SELECT * FROM test_repair_proposals WHERE id=? AND incident_id=? AND status='verified'",
          )
          .get(previousId, id);
        previous = r && JSON.parse(r.payload);
        if (
          !previous ||
          previous.direction !== "repair" ||
          !same(previous.target, target)
        )
          fail("rollback_forbidden", "Нет проверенного изменения для отката");
      }
      try {
        const audit = await this.writer.verifyIsolation(target);
        this.isolation = {
          status: audit.canEdit === "unverified" ? "unverified" : "verified",
          message:
            audit.message ||
            (audit.canEdit === "unverified"
              ? "Документ доступен через Sheets API, но право записи не проверено. До отдельного подтверждения владельца таблица не изменяется."
              : "Права записи проверены. Ограничение одной ячейки действует в RITM; права Google могут быть шире."),
          requiredAction: audit.requiredAction || null,
          permissionReason: audit.permissionReason || null,
          ...audit,
        };
      } catch (e) {
        this.isolation = {
          status: "blocked",
          message: e.code ? e.message : "Доступ записи не подтверждён",
        };
      }
      const snapshot = await this.snapshot(target);
      const from =
        direction === "repair" ? incident.observed?.entered || {} : previous.to;
      const approvedFormula = { formulaValue: baseline.formula };
      if (
        direction === "repair" &&
        same(snapshot.cell, approvedFormula) &&
        snapshot.effective.errorValue
      )
        fail(
          "calculation_error",
          `Ячейка ${target.cell} уже содержит утверждённую формулу, но Google Sheets возвращает ошибку ${snapshot.effective.errorValue.type || "вычисления"}. Повторное исправление не предлагается; проверьте входные данные и зависимости.`,
        );
      if (!same(snapshot.cell, from)) {
        if (direction === "repair" && same(snapshot.cell, approvedFormula)) {
          try {
            if (this.doctor.current) await this.doctor.current;
            await this.doctor.run();
          } catch {
            fail(
              "already_restored_check_failed",
              `Ячейка ${target.cell} уже содержит утверждённую формулу ${baseline.formula}, но повторная проверка Table Doctor не завершилась. Записи не было; запустите проверку таблиц.`,
              503,
            );
          }
          const current = this.db
            .prepare("SELECT status FROM incidents WHERE id=?")
            .get(id);
          if (current?.status === "resolved")
            return {
              ok: true,
              alreadyRestored: true,
              message: `Ячейка ${target.cell} уже содержит утверждённую формулу ${baseline.formula}. Повторная проверка завершена, инцидент закрыт. Google Sheets не изменялись.`,
              ...this.state(id),
            };
          fail(
            "already_restored",
            `Ячейка ${target.cell} уже содержит утверждённую формулу ${baseline.formula}; предложение на запись отменено. Table Doctor не подтвердил закрытие инцидента. Записи не было; проверьте состояние источника и повторите диагностику.`,
          );
        }
        fail(
          "cell_changed",
          `Ячейка ${target.cell} изменилась после обнаружения. Предложение отменено, запись не выполнялась. Текущее значение: ${input(snapshot.cell)}; утверждённая формула: ${baseline.formula}. Обновите диагностику перед новым предложением.`,
        );
      }
      if (snapshot.merge !== baseline.merge_signature)
        fail(
          "merge_changed",
          `Структура объединения ${target.cell} изменилась после обнаружения. Предложение отменено; обновите диагностику. Записи не было.`,
        );
      if (snapshot.validation)
        fail(
          "validation_protected",
          `У ячейки ${target.cell} есть правило проверки данных. RITM не подготовил изменение; проверьте правило и обновите диагностику. Записи не было.`,
        );
      const to =
        direction === "repair"
          ? { formulaValue: baseline.formula }
          : previous.from;
      const p = {
        id: randomUUID(),
        incidentId: id,
        generation,
        direction,
        previousId,
        target,
        sourceName: incident.sourceName,
        snapshot,
        from,
        to,
        expectedResult: null,
        baselineVersion: baseline.version,
        policyVersion: digest({ baseline, target }),
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: this.now() + 10 * 60000,
        confirmation: `Подтверждаю ${target.cell}: ${input(from)} → ${input(to)}`,
        limitation:
          "Повторное чтение и запись Google Sheets не атомарны. Другой редактор может изменить ячейку или зависимости между ними. На время действия согласуйте отсутствие параллельного редактирования. Программный список разрешений не ограничивает права аккаунта в Google. Результат формулы будет проверен на ошибку вычисления; точное значение без утверждённого бизнес-правила заранее неизвестно.",
      };
      p.version = digest(p);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            "UPDATE test_repair_proposals SET status='superseded' WHERE status='pending' AND incident_id=?",
          )
          .run(id);
        const conflict = this.db
          .prepare(
            "SELECT id,status,payload FROM test_repair_proposals WHERE status IN ('pending','queued','executing','checking','uncertain')",
          )
          .all()
          .find((row) => {
            const other = JSON.parse(row.payload).target;
            return (
              other.documentId === target.documentId &&
              other.sheetId === target.sheetId &&
              other.cell === target.cell
            );
          });
        if (conflict)
          fail(
            "cell_operation_conflict",
            `An operation for ${target.sheet}!${target.cell} is already ${conflict.status}. Finish or cancel it first.`,
          );
        this.db
          .prepare(
            "INSERT INTO test_repair_proposals VALUES(?,?,?,'pending',?,NULL)",
          )
          .run(p.id, id, p.version, JSON.stringify(p));
        this.event(p.id, id, "repair_proposed", {
          target,
          from,
          to,
          version: p.version,
        });
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      return { ok: true, ...this.state(id) };
    } finally {
      this.busy = false;
    }
  }
  verifyAfter(after, p) {
    if (
      !same(after.cell, p.to) ||
      after.merge !== p.snapshot.merge ||
      after.validation ||
      (p.direction === "repair" &&
        (after.effective.errorValue ||
          Object.keys(after.effective).length === 0))
    )
      fail(
        "postcondition_failed",
        "Формула или её вычисленный результат не подтверждены; повтор и автоматический откат запрещены",
        503,
      );
  }
  verifyDoctor(p) {
    const { incident } = this.incident(p.incidentId, false);
    const doc = this.doctor
      .state()
      .documents.find((d) => d.id === incident.sourceId);
    const row = this.db
      .prepare("SELECT status FROM incidents WHERE id=?")
      .get(p.incidentId);
    if (
      doc?.check?.status !== "ok" ||
      Date.parse(doc.check.at) < Date.parse(p.createdAt) ||
      (p.direction === "repair" && row.status !== "resolved")
    )
      fail(
        "doctor_recheck_failed",
        "Ячейка прочитана, но свежая диагностика не подтвердила закрытие инцидента",
        503,
      );
    return doc.check.at;
  }
  startQueue() {
    void this.drainQueue();
    void this.finishChecks();
  }
  async confirm(id, payload) {
    const allowed = ["version", "confirmation", "exclusiveEditingAcknowledged"];
    if (
      !payload ||
      typeof payload !== "object" ||
      Object.keys(payload).some((key) => !allowed.includes(key)) ||
      payload.exclusiveEditingAcknowledged !== true
    )
      fail(
        "confirmation_required",
        "Подтвердите точное изменение и подтвердите отсутствие параллельного редактирования ячейки.",
        400,
      );
    const row = this.db
      .prepare("SELECT * FROM test_repair_proposals WHERE id=?")
      .get(id);
    if (!row) fail("proposal_not_found", "Предложение не найдено", 404);
    const p = JSON.parse(row.payload);
    if (
      payload.version !== row.version ||
      payload.confirmation !== p.confirmation
    )
      fail(
        "proposal_version_changed",
        "Текст подтверждения или версия предложения изменились. Подготовьте предложение заново.",
      );
    if (["queued", "executing", "checking", "verified"].includes(row.status))
      return {
        ok: true,
        replayed: true,
        queued: row.status !== "verified",
        ...this.state(p.incidentId),
      };
    if (row.status !== "pending")
      fail(
        "proposal_unavailable",
        "Предложение отменено или требует решения владельца; повторной записи не будет.",
      );
    const { generation, target } = this.incident(
      p.incidentId,
      p.direction === "repair",
    );
    if (
      this.now() >= p.expiresAt ||
      generation !== p.generation ||
      this.sourceVersion(p) !== p.policyVersion
    ) {
      this.db
        .prepare(
          "UPDATE test_repair_proposals SET status='needs_review' WHERE id=? AND status='pending'",
        )
        .run(id);
      this.event(id, p.incidentId, "repair_postcheck_failed", {
        code: "proposal_stale",
      });
      fail(
        "proposal_expired",
        "Предложение устарело. Оно не поставлено в очередь; повторите диагностику.",
      );
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const conflicting = this.db
        .prepare(
          "SELECT id,status,payload FROM test_repair_proposals WHERE status IN ('queued','executing','checking','uncertain')",
        )
        .all()
        .find((candidate) => {
          const other = JSON.parse(candidate.payload).target;
          return (
            other.documentId === target.documentId &&
            other.sheetId === target.sheetId &&
            other.cell === target.cell
          );
        });
      if (conflicting)
        fail(
          "cell_operation_conflict",
          `Для ${target.sheet}!${target.cell} уже выполняется операция. Текущий статус: ${conflicting.status}.`,
        );
      const claim = this.db
        .prepare(
          "UPDATE test_repair_proposals SET status='queued' WHERE id=? AND status='pending' AND version=?",
        )
        .run(id, p.version);
      if (claim.changes !== 1)
        fail("proposal_unavailable", "Предложение уже обработано");
      this.event(id, p.incidentId, "repair_confirmed", {
        owner: "authenticated_local_owner",
        version: p.version,
        confirmation: payload.confirmation,
        exclusiveEditingAcknowledged: true,
      });
      this.event(id, p.incidentId, "repair_queued", {
        target,
        position: this.queueState().queued,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    void this.drainQueue();
    return {
      ok: true,
      queued: true,
      message:
        "Подтверждение сохранено. Исправление выполняется последовательно после повторной проверки ячейки.",
      ...this.state(p.incidentId),
    };
  }
  async drainQueue() {
    if (this.queueRunning) return;
    this.queueRunning = true;
    try {
      while (true) {
        const row = this.db
          .prepare(
            "SELECT * FROM test_repair_proposals WHERE status='queued' ORDER BY rowid LIMIT 1",
          )
          .get();
        if (!row) break;
        await this.executeQueued(row);
      }
    } finally {
      this.queueRunning = false;
      void this.finishChecks();
      if (
        this.db
          .prepare(
            "SELECT 1 FROM test_repair_proposals WHERE status='queued' LIMIT 1",
          )
          .get()
      )
        void this.drainQueue();
    }
  }
  async executeQueued(row) {
    const p = JSON.parse(row.payload);
    let writeStarted = false;
    try {
      const confirmation = this.db
        .prepare(
          "SELECT payload FROM test_repair_events WHERE proposal_id=? AND type='repair_confirmed' ORDER BY id DESC LIMIT 1",
        )
        .get(row.id);
      const approval = confirmation && JSON.parse(confirmation.payload);
      if (
        row.status !== "queued" ||
        !approval ||
        approval.version !== row.version ||
        approval.confirmation !== p.confirmation ||
        approval.exclusiveEditingAcknowledged !== true
      )
        fail(
          "confirmation_stale",
          "Не найдено действительное подтверждение владельца для этой версии. Запись отменена.",
        );
      const { generation, baseline, target } = this.incident(
        p.incidentId,
        p.direction === "repair",
      );
      if (
        row.version !== p.version ||
        this.now() >= p.expiresAt ||
        generation !== p.generation ||
        baseline.version !== p.baselineVersion ||
        this.sourceVersion(p) !== p.policyVersion
      )
        fail(
          "proposal_stale",
          "Предложение, эталон или состояние инцидента изменились. Запись отменена.",
        );
      approvedTarget(target);
      await this.writer.verifyIsolation(target);
      const before = await this.snapshot(target);
      if (!same(before, p.snapshot))
        fail(
          "cell_changed",
          "Содержимое ячейки или связанные признаки изменились после предложения. Запись отменена.",
        );
      const fresh = this.incident(p.incidentId, p.direction === "repair");
      if (
        fresh.generation !== p.generation ||
        fresh.baseline.version !== p.baselineVersion ||
        this.sourceVersion(p) !== p.policyVersion
      )
        fail(
          "proposal_stale",
          "Инцидент или утверждённый эталон изменился перед записью. Запись отменена.",
        );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (
          this.production &&
          this.db
            .prepare(
              "SELECT 1 FROM source_recovery_operations WHERE status IN ('repairing','checking') LIMIT 1",
            )
            .get()
        )
          fail(
            "repair_operation_conflict",
            "Выполняется восстановление исходных данных; исправление формулы не запущено.",
          );
        const claimed = this.db
          .prepare(
            "UPDATE test_repair_proposals SET status='executing' WHERE id=? AND status='queued' AND version=?",
          )
          .run(row.id, row.version);
        if (claimed.changes !== 1)
          fail(
            "proposal_unavailable",
            "Операция больше не находится в очереди",
          );
        this.event(row.id, p.incidentId, "repair_backup", {
          original: before,
          restore: p.from,
          target,
        });
        this.event(row.id, p.incidentId, "repair_write_started", {
          direction: p.direction,
          target,
        });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      writeStarted = true;
      const api = await this.writer.conditionalReplace(p.direction, p),
        after = await this.snapshot(target);
      this.verifyAfter(after, p);
      const result = {
        at: new Date(this.now()).toISOString(),
        after,
        api,
        target,
        baselineVersion: p.baselineVersion,
      };
      this.db
        .prepare(
          "UPDATE test_repair_proposals SET status='checking',result=? WHERE id=? AND status='executing'",
        )
        .run(JSON.stringify(result), row.id);
      this.event(row.id, p.incidentId, "repair_cell_verified", {
        at: result.at,
        after,
        target,
      });
    } catch (error) {
      const status = writeStarted
        ? error?.code === "write_rejected"
          ? "cancelled"
          : "uncertain"
        : "needs_review",
        result = {
          at: new Date(this.now()).toISOString(),
          errorCode: error.code || "repair_failed",
          message: error.message || "Исправление не выполнено",
        };
      this.db
        .prepare(
          "UPDATE test_repair_proposals SET status=?,result=? WHERE id=? AND status IN ('queued','executing')",
        )
        .run(status, JSON.stringify(result), row.id);
      this.event(
        row.id,
        p.incidentId,
        status === "uncertain"
          ? "repair_uncertain"
          : status === "cancelled"
            ? "repair_cancelled"
            : "repair_postcheck_failed",
        { code: result.errorCode },
      );
    }
  }
  async finishChecks() {
    if (this.checkRunning) return;
    const pending = this.db
      .prepare(
        "SELECT * FROM test_repair_proposals WHERE status='checking' ORDER BY rowid",
      )
      .all();
    if (!pending.length) return;
    this.checkRunning = true;
    try {
      const check = await this.doctor.runFast();
      for (const row of pending) {
        const p = JSON.parse(row.payload),
          result = row.result ? JSON.parse(row.result) : {},
          sheet = check.documents
            .find(
              (d) =>
                d.sourceId === p.target.sourceId || d.name === p.sourceName,
            )
            ?.sheets.find((s) => s.gid === p.target.sheetId),
          incident = this.db
            .prepare("SELECT status FROM incidents WHERE id=?")
            .get(p.incidentId);
        if (sheet?.status === "ok" && incident?.status === "resolved") {
          const verified = {
            ...result,
            doctorCheckAt: check.at,
            checkedCells: sheet.checkedCells,
          };
          this.db
            .prepare(
              "UPDATE test_repair_proposals SET status='verified',result=? WHERE id=? AND status='checking'",
            )
            .run(JSON.stringify(verified), row.id);
          this.event(row.id, p.incidentId, "repair_verified", verified);
        } else {
          const failure = {
            ...result,
            errorCode:
              sheet?.status === "ok"
                ? "incident_still_open"
                : "postcheck_unavailable",
            message:
              "Ячейка прочитана после записи, но быстрая диагностика не подтвердила закрытие инцидента. Повторная запись запрещена; требуется решение владельца.",
          };
          this.db
            .prepare(
              "UPDATE test_repair_proposals SET status='needs_review',result=? WHERE id=? AND status='checking'",
            )
            .run(JSON.stringify(failure), row.id);
          this.event(row.id, p.incidentId, "repair_postcheck_failed", {
            code: failure.errorCode,
          });
        }
      }
    } catch (error) {
      for (const row of pending) {
        this.db
          .prepare(
            "UPDATE test_repair_proposals SET status='needs_review' WHERE id=? AND status='checking'",
          )
          .run(row.id);
        this.event(row.id, row.incident_id, "repair_postcheck_failed", {
          code: error.code || "postcheck_unavailable",
        });
      }
    } finally {
      this.checkRunning = false;
    }
  }
}
