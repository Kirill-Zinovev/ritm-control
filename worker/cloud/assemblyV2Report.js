import { assemblyPeriodStart, validAssemblyDate, summarizeAssembly, summarizeAssemblyDays, workLogRecords } from "../assembly.js";
import { CloudError } from "./access.js";
import { callAssemblyV2 } from "./assemblyV2Transport.js";

const source = "RITM Сборка";
const operationNames = { cut: "Станочная резка", assembly: "Ручная резка", packing: "Упаковка" };
const normReasons = new Set(["catalog", "kind", "sheets", "norm", "ready"]);
const dayAt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
});

function reportEvent(row) {
  const timestamp = Date.parse(row?.createdAt);
  const norm = row?.norm == null ? null : Number(row.norm);
  const coefficient = row?.coefficient == null ? null : Number(row.coefficient);
  if (!row?.id || !row.employeeId || !row.employee || !row.sku || !operationNames[row.operation] ||
      !Number.isFinite(timestamp) || !Number.isSafeInteger(row.qty) || row.qty <= 0 ||
      (norm !== null && (!Number.isFinite(norm) || norm <= 0)) ||
      (coefficient !== null && (!Number.isFinite(coefficient) || coefficient < 0)))
    return null;
  const issue = row.normIssue;
  const normIssue = coefficient === null && normReasons.has(issue?.reason) &&
    ["OZON", "WB"].includes(issue.market)
    ? { reason: issue.reason, market: issue.market,
        store: /^[1-9]\d*$/.test(issue.store) ? String(issue.store) : "", hasCard: issue.hasCard === true }
    : undefined;
  return {
    eventId: row.id, idempotencyKey: row.id, employeeId: row.employeeId, employee: row.employee,
    shipmentId: row.supplyId, shipmentName: row.supply, positionId: row.positionId,
    directionId: "", article: row.sku, operationId: row.operation, operation: operationNames[row.operation],
    quantity: row.qty, createdAt: row.createdAt, date: dayAt.format(new Date(timestamp)),
    norm, coefficient, productType: row.productType || "", source, normIssue,
  };
}

export async function readAssemblyV2Report(url, bindings, { fetcher = fetch, now = Date.now } = {}) {
  const date = url.searchParams.get("date") || dayAt.format(new Date(now()));
  const period = url.searchParams.get("period") || "day";
  if (!validAssemblyDate(date) || !["day", "week", "month"].includes(period))
    throw new CloudError("assembly_report_period_invalid", "Проверьте дату и период отчёта.", 400);
  const from = url.searchParams.get("from") ?? assemblyPeriodStart(date, period);
  const to = url.searchParams.get("to") ?? date;
  if (!validAssemblyDate(from) || !validAssemblyDate(to) || from > to)
    throw new CloudError("assembly_report_period_invalid", "Проверьте начало и конец периода.", 400);
  const params = new URLSearchParams({ from, to });
  const events = [];
  const ids = new Set();
  let revision, cursor, invalidRecords = 0;

  for (let page = 0; page < 24; page++) {
    const response = await callAssemblyV2(bindings, "/api/ritm/work-report?" + params, { fetcher, timeout: 7000 })
      .catch(() => null);
    const data = response?.ok ? await response.json().catch(() => null) : null;
    if (data?.ok !== true || data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) ||
        !Array.isArray(data.events) || data.events.length > 1500)
      throw new CloudError("assembly_report_unavailable", "Не удалось прочитать отчёт «RITM Сборка». Повторите обновление.", 503);
    if (revision !== undefined && revision !== data.revision)
      throw new CloudError("assembly_report_changed", "Во время чтения добавились операции. Обновите отчёт.", 409);
    revision = data.revision;
    for (const row of data.events) {
      const event = reportEvent(row);
      if (!event || event.date < from || event.date > to || ids.has(event.eventId)) invalidRecords++;
      else { events.push(event); ids.add(event.eventId); }
    }
    if (data.next === null) {
      const updatedAt = new Date(now()).toISOString();
      const latest = events.at(-1)?.createdAt ?? null;
      const records = workLogRecords(events);
      const status = invalidRecords ? "partial" : "available";
      return {
        ok: true, schemaVersion: 2, source, date, period, reportRange: { start: from, end: to },
        updatedAt, sourceUpdatedAt: latest, stale: false, issues: [],
        quality: { status: invalidRecords ? "partial" : "valid", invalidRecords },
        sourcePolicy: { mode: "assembly-only", cutover: null, overlap: false },
        sources: { assembly: { status, checkedAt: updatedAt, lastSuccessAt: updatedAt, sourceUpdatedAt: latest,
          eventCount: events.length, invalidRecords, source, message: invalidRecords ? "Часть операций не прошла проверку." : "",
          supportsCorrections: true, correctionsApplied: 0, cancellationsApplied: 0 } },
        rows: summarizeAssembly(records, date, period),
        history: summarizeAssemblyDays(records), events,
      };
    }
    const next = data.next;
    const last = data.events.at(-1);
    if (!next || typeof next.at !== "string" || typeof next.id !== "string" ||
        next.at !== last?.createdAt || next.id !== last?.id ||
        (cursor && (next.at < cursor.at || next.at === cursor.at && next.id <= cursor.id)))
      throw new CloudError("assembly_report_cursor", "Не удалось прочитать отчёт полностью. Повторите обновление.", 503);
    params.set("after", next.at);
    params.set("id", next.id);
    cursor = next;
  }
  throw new CloudError("assembly_report_too_large", "Слишком много операций для одного отчёта. Выберите более короткий период.", 413);
}
