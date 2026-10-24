import { inspectAssemblyRows } from "./assemblyDiagnostics.js";
import { parseCsv } from "./printing.js";
import { privateGoogleSource } from "./privateGoogleConfig.js";
import { parseFboCurrent } from "./assemblyFboCurrent.js";
import { reconcileAssemblySources } from "./assemblyReconciliation.js";
import {
  attachAssemblyProductTypes,
  parseAssemblyArticleCatalog,
  parseAssemblyWorkLog,
  RITM_ASSEMBLY_CURRENT_CATALOG_GID,
  RITM_ASSEMBLY_SOURCE_ID,
  RITM_ASSEMBLY_WORKLOG_GID,
  RITM_ASSEMBLY_WORK_CORRECTIONS_GID,
} from "./assemblyWorkLog.js";

export const FBO_SOURCE_ID = privateGoogleSource("fboSourceId");
export const FBO_CURRENT_GID = 0;
export const FBO_HISTORY_GID = 2070043218;
export const FBO_NORMS_GID = 130670756;

export function parseAssemblyRows(csv) {
  return inspectAssemblyRows(csv).records;
}

function periodStart_(date, period) {
  const [year, month, day] = date.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day, 12));
  if (period === "month") start.setUTCDate(1);
  else if (period === "week") {
    const offset = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - offset);
  }
  return start.toISOString().slice(0, 10);
}

function validDate_(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return false;
  const parsed = new Date(date + "T12:00:00Z");
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function summarizeAssembly(records, date, period = "day") {
  if (!validDate_(date)) throw new Error("Invalid assembly date");
  if (!["day", "week", "month"].includes(period))
    throw new Error("Invalid assembly period");

  const start = periodStart_(date, period);
  const employees = new Map();
  records.forEach((record) => {
    if (record.date < start || record.date > date) return;
    const sourceKind =
      record.sourceKind || (record.employeeId ? "assembly" : "fbo");
    const reconciliationStatus = record.reconciliationStatus || "clear";
    const identityKey =
      record.identityKey ||
      (record.employeeId
        ? "assembly:" + record.employeeId
        : "fbo:" + record.employee);
    const entry = employees.get(identityKey) || {
      employee: record.employee,
      employeeId: record.employeeId || null,
      identityKey,
      sourceKind,
      mappingStatus:
        record.mappingStatus || (record.employeeId ? "confirmed" : "unmapped"),
      reconciliationStatus,
      reconciliationReason: record.reconciliationReason || "",
      lastUpdatedAt: record.updatedAt || null,
      coefficientTotal: 0,
      coefficientComplete: true,
      machineCut: 0,
      manualCut: 0,
      cut: 0,
      packed: 0,
      total: 0,
      days: 0,
      activeDates: new Set(),
      cutTypes: new Map(),
      packTypes: new Map(),
      sourceContributions: new Map(),
    };
    if (sourceKind === "assembly") {
      entry.employee = record.employee;
      entry.employeeId = record.employeeId || null;
    }
    if (record.coefficient === null || record.coefficient === undefined)
      entry.coefficientComplete = false;
    else entry.coefficientTotal += record.coefficient;
    entry.machineCut += record.machineCut;
    entry.manualCut += record.manualCut;
    entry.cut += record.cut;
    entry.packed += record.packed;
    entry.total += record.total;
    entry.activeDates.add(record.date);
    const sourceContribution = entry.sourceContributions.get(sourceKind) || {
      sourceKind,
      employeeLabel:
        sourceKind === "fbo"
          ? record.sourceEmployee || record.employee
          : record.employee,
      employeeId: sourceKind === "assembly" ? record.employeeId || null : null,
      coefficientTotal: 0,
      coefficientComplete: true,
      machineCut: 0,
      manualCut: 0,
      cut: 0,
      packed: 0,
      total: 0,
      recordCount: 0,
      cutTypes: new Map(),
      packTypes: new Map(),
      reconciliationStatus: "clear",
    };
    sourceContribution.machineCut += record.machineCut;
    sourceContribution.manualCut += record.manualCut;
    sourceContribution.cut += record.cut;
    sourceContribution.packed += record.packed;
    sourceContribution.total += record.total;
    sourceContribution.recordCount += 1;
    if (record.coefficient === null || record.coefficient === undefined)
      sourceContribution.coefficientComplete = false;
    else sourceContribution.coefficientTotal += record.coefficient;
    if (reconciliationStatus !== "clear")
      sourceContribution.reconciliationStatus = reconciliationStatus;
    for (const [target, types] of [
      [sourceContribution.cutTypes, record.cutTypes],
      [sourceContribution.packTypes, record.packTypes],
    ]) {
      types.forEach((type) => {
        const key = type.name.toLocaleLowerCase("ru-RU");
        const existing = target.get(key) || { name: type.name, quantity: 0 };
        existing.quantity += type.quantity;
        target.set(key, existing);
      });
    }
    entry.sourceContributions.set(sourceKind, sourceContribution);
    if (reconciliationStatus !== "clear") {
      entry.reconciliationStatus = reconciliationStatus;
      entry.reconciliationReason = record.reconciliationReason || "";
    }
    if (
      record.updatedAt &&
      (!entry.lastUpdatedAt || record.updatedAt > entry.lastUpdatedAt)
    )
      entry.lastUpdatedAt = record.updatedAt;
    [
      [entry.cutTypes, record.cutTypes],
      [entry.packTypes, record.packTypes],
    ].forEach(([target, types]) => {
      types.forEach((type) => {
        const key = type.name.toLocaleLowerCase("ru-RU");
        const existing = target.get(key) || { name: type.name, quantity: 0 };
        existing.quantity += type.quantity;
        target.set(key, existing);
      });
    });
    employees.set(identityKey, entry);
  });

  return [...employees.values()].map((entry) => ({
    employee: entry.employee,
    employeeId: entry.employeeId,
    identityKey: entry.identityKey,
    sourceKind: entry.sourceContributions.size > 1 ? "both" : entry.sourceKind,
    sourceKinds: [...entry.sourceContributions.keys()],
    mappingStatus: entry.mappingStatus,
    reconciliationStatus: entry.reconciliationStatus || "clear",
    reconciliationReason: entry.reconciliationReason || "",
    sourceContributions: [...entry.sourceContributions.values()].map(
      (source) => ({
        sourceKind: source.sourceKind,
        employeeLabel: source.employeeLabel,
        employeeId: source.employeeId,
        coefficient: source.coefficientComplete
          ? source.coefficientTotal
          : null,
        machineCut: source.machineCut,
        manualCut: source.manualCut,
        cut: source.cut,
        packed: source.packed,
        total: source.total,
        recordCount: source.recordCount,
        cutTypes: [...source.cutTypes.values()],
        packTypes: [...source.packTypes.values()],
        reconciliationStatus: source.reconciliationStatus,
      }),
    ),
    lastUpdatedAt: entry.lastUpdatedAt,
    coefficient:
      entry.reconciliationStatus !== "clear"
        ? null
        : entry.coefficientComplete
          ? entry.coefficientTotal
          : null,
    cutTypes: [...entry.cutTypes.values()],
    packTypes: [...entry.packTypes.values()],
    machineCut: entry.machineCut,
    manualCut: entry.manualCut,
    cut: entry.cut,
    packed: entry.packed,
    total: entry.total,
    days: entry.activeDates.size,
  }));
}

export function summarizeAssemblyDays(records) {
  const days = new Map();
  records.forEach((record) => {
    const sourceKind =
      record.sourceKind || (record.employeeId ? "assembly" : "fbo");
    const reconciliationStatus = record.reconciliationStatus || "clear";
    const identityKey =
      record.identityKey ||
      (record.employeeId
        ? "assembly:" + record.employeeId
        : "fbo:" + record.employee);
    const key = record.date + "|" + identityKey;
    let entry = days.get(key);
    if (!entry) {
      entry = {
        date: record.date,
        employee: record.employee,
        employeeId: record.employeeId || null,
        identityKey,
        sourceKind,
        mappingStatus:
          record.mappingStatus ||
          (record.employeeId ? "confirmed" : "unmapped"),
        reconciliationStatus,
        reconciliationReason: record.reconciliationReason || "",
        sourceIds: record.id ? [record.id] : [],
        lastUpdatedAt: record.updatedAt || null,
        coefficientTotal: 0,
        coefficientComplete: true,
        machineCut: 0,
        manualCut: 0,
        cut: 0,
        packed: 0,
        total: 0,
        days: 1,
        cutTypes: new Map(),
        packTypes: new Map(),
        events: [],
        sourceContributions: new Map(),
      };
      days.set(key, entry);
    }
    if (sourceKind === "assembly") {
      entry.employee = record.employee;
      entry.employeeId = record.employeeId || null;
    }
    if (record.id && !entry.sourceIds.includes(record.id))
      entry.sourceIds.push(record.id);
    if (record.coefficient === null || record.coefficient === undefined)
      entry.coefficientComplete = false;
    else entry.coefficientTotal += record.coefficient;
    entry.machineCut += record.machineCut;
    entry.manualCut += record.manualCut;
    entry.cut += record.cut;
    entry.packed += record.packed;
    entry.total += record.total;
    if (record.events?.length) entry.events.push(...record.events);
    const sourceContribution = entry.sourceContributions.get(sourceKind) || {
      sourceKind,
      employeeLabel:
        sourceKind === "fbo"
          ? record.sourceEmployee || record.employee
          : record.employee,
      employeeId: sourceKind === "assembly" ? record.employeeId || null : null,
      coefficientTotal: 0,
      coefficientComplete: true,
      machineCut: 0,
      manualCut: 0,
      cut: 0,
      packed: 0,
      total: 0,
      recordCount: 0,
      cutTypes: new Map(),
      packTypes: new Map(),
      reconciliationStatus: "clear",
    };
    sourceContribution.machineCut += record.machineCut;
    sourceContribution.manualCut += record.manualCut;
    sourceContribution.cut += record.cut;
    sourceContribution.packed += record.packed;
    sourceContribution.total += record.total;
    sourceContribution.recordCount += 1;
    if (record.coefficient === null || record.coefficient === undefined)
      sourceContribution.coefficientComplete = false;
    else sourceContribution.coefficientTotal += record.coefficient;
    if (reconciliationStatus !== "clear")
      sourceContribution.reconciliationStatus = reconciliationStatus;
    for (const [target, types] of [
      [sourceContribution.cutTypes, record.cutTypes],
      [sourceContribution.packTypes, record.packTypes],
    ]) {
      types.forEach((type) => {
        const key = type.name.toLocaleLowerCase("ru-RU");
        const existing = target.get(key) || { name: type.name, quantity: 0 };
        existing.quantity += type.quantity;
        target.set(key, existing);
      });
    }
    entry.sourceContributions.set(sourceKind, sourceContribution);
    if (reconciliationStatus !== "clear") {
      entry.reconciliationStatus = reconciliationStatus;
      entry.reconciliationReason = record.reconciliationReason || "";
    }
    if (
      record.updatedAt &&
      (!entry.lastUpdatedAt || record.updatedAt > entry.lastUpdatedAt)
    )
      entry.lastUpdatedAt = record.updatedAt;
    [
      [entry.cutTypes, record.cutTypes],
      [entry.packTypes, record.packTypes],
    ].forEach(([target, types]) => {
      types.forEach((type) => {
        const typeKey = type.name.toLocaleLowerCase("ru-RU");
        const existing = target.get(typeKey) || {
          name: type.name,
          quantity: 0,
        };
        existing.quantity += type.quantity;
        target.set(typeKey, existing);
      });
    });
  });
  return [...days.values()]
    .map((entry) => ({
      date: entry.date,
      employee: entry.employee,
      employeeId: entry.employeeId,
      identityKey: entry.identityKey,
      sourceKind:
        entry.sourceContributions.size > 1 ? "both" : entry.sourceKind,
      sourceKinds: [...entry.sourceContributions.keys()],
      mappingStatus: entry.mappingStatus,
      reconciliationStatus: entry.reconciliationStatus || "clear",
      reconciliationReason: entry.reconciliationReason || "",
      sourceIds: entry.sourceIds,
      lastUpdatedAt: entry.lastUpdatedAt,
      coefficient:
        entry.reconciliationStatus !== "clear"
          ? null
          : entry.coefficientComplete
            ? entry.coefficientTotal
            : null,
      machineCut: entry.machineCut,
      manualCut: entry.manualCut,
      cut: entry.cut,
      packed: entry.packed,
      total: entry.total,
      days: entry.days,
      cutTypes: [...entry.cutTypes.values()],
      packTypes: [...entry.packTypes.values()],
      events: entry.events,
      sourceContributions: [...entry.sourceContributions.values()].map(
        (source) => ({
          sourceKind: source.sourceKind,
          employeeLabel: source.employeeLabel,
          employeeId: source.employeeId,
          coefficient: source.coefficientComplete
            ? source.coefficientTotal
            : null,
          machineCut: source.machineCut,
          manualCut: source.manualCut,
          cut: source.cut,
          packed: source.packed,
          total: source.total,
          recordCount: source.recordCount,
          cutTypes: [...source.cutTypes.values()],
          packTypes: [...source.packTypes.values()],
          reconciliationStatus: source.reconciliationStatus,
        }),
      ),
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.employee.localeCompare(b.employee, "ru-RU"),
    );
}

function todayMoscow_() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function parseFboNorms_(csv) {
  const rows = parseCsv(csv);
  const headers = (rows[0] || []).map((value) =>
    String(value ?? "")
      .replace(/^\uFEFF/, "")
      .trim()
      .toLocaleLowerCase("ru-RU"),
  );
  const labelIndex = headers.findIndex(
    (value) => value === "вид" || value.includes("вид товара"),
  );
  const normIndex = headers.findIndex(
    (value) => value === "норма" || value.includes("норм"),
  );
  if (labelIndex < 0 || normIndex < 0)
    return {
      status: "unavailable",
      rows: [],
      message: "Формат листа норм изменился.",
    };

  const values = [];
  for (const row of rows.slice(1)) {
    const label = String(row[labelIndex] ?? "").trim();
    const rawNorm = String(row[normIndex] ?? "")
      .trim()
      .replace(/[\s\u00a0\u202f]/g, "")
      .replace(",", ".");
    if (!label || !rawNorm) continue;
    const norm = Number(rawNorm);
    if (!Number.isFinite(norm) || norm <= 0) continue;
    const operationMatch = label.match(
      /ручн(?:ая|ой)\s+резк[а-я]*|резк[а-я]*\s+(?:вручн[а-я]*|врунч[а-я]*|на\s+станк[а-я]*)|упаковк[а-я]*|сборк[а-я]*(?:\s+[а-я]+)?|накатк[а-я]*|натяжк[а-я]*|резк[а-я]*/i,
    );
    const operationLabel = operationMatch?.[0] || "";
    const operation = /упаковк/i.test(operationLabel)
      ? "Упаковка"
      : /ручн|вручн|врунч/i.test(operationLabel)
        ? "Ручная резка"
        : /резк/i.test(operationLabel)
          ? /на\s+станк/i.test(operationLabel)
            ? "Резка на станке"
            : "Резка · способ не указан"
          : /сборк/i.test(operationLabel)
            ? "Сборка"
            : /накатк/i.test(operationLabel)
              ? "Накатка"
              : /натяжк/i.test(operationLabel)
                ? "Натяжка"
                : "Не сопоставлено";
    const productType = operationLabel
      ? label.replace(operationMatch[0], "").replace(/\s+/g, " ").trim() ||
        label
      : label;
    const unit =
      operation === "Упаковка"
        ? "шт./смену"
        : operation === "Резка на станке" || operation === "Ручная резка"
          ? "листов/смену"
          : "Не указана";
    values.push({ productType, operation, norm, unit, sourceLabel: label });
  }
  return values.length
    ? { status: "available", rows: values, message: "" }
    : {
        status: "unavailable",
        rows: [],
        message: "В листе норм нет распознаваемых значений.",
      };
}

async function loadFboNorms_(fetcher) {
  try {
    const response = await fetcher(
      "https://docs.google.com/spreadsheets/d/" +
        FBO_SOURCE_ID +
        "/export?format=csv&gid=" +
        FBO_NORMS_GID,
      { signal: AbortSignal.timeout(12000) },
    );
    if (!response.ok) throw new Error("FBO norms unavailable");
    return parseFboNorms_(await response.text());
  } catch {
    return {
      status: "unavailable",
      rows: [],
      message: "Лист норм сейчас недоступен.",
    };
  }
}

function workLogRecords(events) {
  return events.map((event) => ({
    id: event.eventId,
    identityKey: "assembly:" + event.employeeId,
    employeeId: event.employeeId,
    sourceKind: "assembly",
    employee: event.employee,
    date: event.date,
    updatedAt: event.createdAt,
    coefficient: event.coefficient,
    machineCut: event.operationId === "cut" ? event.quantity : 0,
    manualCut: event.operationId === "assembly" ? event.quantity : 0,
    cut:
      event.operationId === "cut" || event.operationId === "assembly"
        ? event.quantity
        : 0,
    packed: event.operationId === "packing" ? event.quantity : 0,
    total: event.quantity,
    days: 1,
    cutTypes:
      event.operationId !== "packing" && event.productType
        ? [{ name: event.productType, quantity: event.quantity }]
        : [],
    packTypes:
      event.operationId === "packing" && event.productType
        ? [{ name: event.productType, quantity: event.quantity }]
        : [],
    events: [event],
  }));
}

async function readCsv(fetcher, spreadsheetId, gid, timeoutMs) {
  const response = await fetcher(
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!response.ok) throw new Error("Google Sheet source unavailable");
  return response.text();
}

async function readFboCurrent(fetcher) {
  const url =
    `https://docs.google.com/spreadsheets/d/${FBO_SOURCE_ID}/gviz/tq` +
    `?tqx=out:json&gid=${FBO_CURRENT_GID}&range=A1:O100`;
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("FBO live coefficients unavailable");
  return response.text();
}

function settledRead(promise) {
  return promise
    .then((value) => ({ value, error: null }))
    .catch((error) => ({ value: null, error }));
}

function liveSheetTimestamp(date, time) {
  if (!time || !validDate_(date)) return null;
  const parsed = new Date(`${date}T${time}:00+03:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function coefficientLatest(records) {
  return (
    records
      .map((record) => record.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null
  );
}

export function selectAssemblyPeriod(snapshot, date, period = "day") {
  // Period changes use the verified local snapshot, without another Sheets read.
  const rows = summarizeAssembly(snapshot.history, date, period);
  const records = snapshot.recordsBySource;
  const { recordsBySource, ...publicSnapshot } = snapshot;
  if (!records) return { ...publicSnapshot, date, period, rows };
  const startDate = periodStart_(date, period);
  const syncDate = snapshot.date;
  const fbo = snapshot.sources.fbo;
  const includesCurrent = startDate <= syncDate && date >= syncDate;
  const includesHistory = startDate < syncDate;
  const statuses = [
    includesCurrent ? fbo.currentStatus : null,
    includesHistory ? fbo.historyStatus : null,
  ].filter(Boolean);
  const fboStatus = statuses.every((status) => status === "available")
    ? "available"
    : statuses.every((status) => status === "unavailable")
      ? "unavailable"
      : "partial";
  const reconciliation = reconcileAssemblySources({
    fboRecords: records.fbo,
    assemblyRecords: records.assembly,
    fboStatus,
    assemblyStatus: snapshot.sources.assembly.status,
    startDate,
    endDate: date,
  });
  return {
    ...publicSnapshot,
    date,
    period,
    reconciliation,
    rows: summarizeAssembly(
      [...reconciliation.fboRecords, ...reconciliation.assemblyRecords],
      date,
      period,
    ),
    sources: {
      ...snapshot.sources,
      fbo: { ...fbo, status: fboStatus, recordCount: reconciliation.sourceTotals.fbo.recordCount },
      assembly: {
        ...snapshot.sources.assembly,
        eventCount: snapshot.events.filter((event) => event.date >= startDate && event.date <= date).length,
      },
    },
  };
}

export async function loadAssembly(
  date,
  period,
  fetcher = fetch,
  { includeHistory = false, today: todayOverride = null } = {},
) {
  const selectedDate = date || todayMoscow_();
  const selectedPeriod = period || "day";
  summarizeAssembly([], selectedDate, selectedPeriod);
  const checkedAt = new Date().toISOString();
  const periodStart = periodStart_(selectedDate, selectedPeriod);
  const today = todayOverride || todayMoscow_();
  const needsFboCurrent = periodStart <= today && selectedDate >= today;
  const needsFboHistory = includeHistory || periodStart < today;
  const [historyRead, currentRead, norms, workLogRead, catalogRead, correctionsRead] =
    await Promise.all([
      settledRead(
        needsFboHistory
          ? readCsv(fetcher, FBO_SOURCE_ID, FBO_HISTORY_GID, 20000)
          : Promise.resolve(null),
      ),
      settledRead(
        needsFboCurrent ? readFboCurrent(fetcher) : Promise.resolve(null),
      ),
      loadFboNorms_(fetcher),
      settledRead(
        readCsv(
          fetcher,
          RITM_ASSEMBLY_SOURCE_ID,
          RITM_ASSEMBLY_WORKLOG_GID,
          12000,
        ),
      ),
      settledRead(
        readCsv(
          fetcher,
          RITM_ASSEMBLY_SOURCE_ID,
          RITM_ASSEMBLY_CURRENT_CATALOG_GID,
          12000,
        ),
      ),
      settledRead(
        readCsv(fetcher, RITM_ASSEMBLY_SOURCE_ID, RITM_ASSEMBLY_WORK_CORRECTIONS_GID, 12000),
      ),
    ]);

  let fboHistory = {
    records: [],
    issues: [],
    sourceUpdatedAt: null,
    quality: { status: "valid", invalidRecords: 0 },
  };
  let fboHistoryStatus = needsFboHistory ? "unavailable" : "available";
  let fboHistoryMessage = "";
  if (historyRead.value !== null) {
    try {
      fboHistory = inspectAssemblyRows(historyRead.value);
      fboHistoryStatus =
        fboHistory.quality.status === "partial" ? "partial" : "available";
      if (fboHistoryStatus === "partial")
        fboHistoryMessage =
          "В истории FBO есть строки с ошибками; они исключены из расчёта.";
    } catch (error) {
      fboHistoryStatus = "unavailable";
      fboHistoryMessage =
        error?.message === "FBO history schema changed"
          ? "Структура «Истории производства» изменилась. Исторические данные недоступны."
          : "История производства FBO временно недоступна.";
      fboHistory = {
        records: [],
        issues: [error.issue].filter(Boolean),
        sourceUpdatedAt: null,
        quality: { status: "partial", invalidRecords: 0 },
      };
    }
  } else if (needsFboHistory) {
    fboHistoryMessage = "История производства FBO временно недоступна.";
  }

  let fboCurrent = {
    records: [],
    invalid: [],
    updateTime: null,
    status: "unavailable",
  };
  let fboCurrentStatus = needsFboCurrent ? "unavailable" : "available";
  let fboCurrentMessage = "";
  if (currentRead.value !== null) {
    try {
      fboCurrent = parseFboCurrent(currentRead.value, today);
      fboCurrentStatus = fboCurrent.status;
      if (fboCurrent.status === "partial")
        fboCurrentMessage = `В «Все коэффициенты» пропущено строк с ошибками: ${fboCurrent.invalid.length}.`;
    } catch (error) {
      fboCurrentStatus = "unavailable";
      fboCurrentMessage =
        error?.message === "fbo_live_schema_changed"
          ? "Структура листа «Все коэффициенты» изменилась."
          : "Лист «Все коэффициенты» временно недоступен.";
    }
  } else if (needsFboCurrent) {
    fboCurrentMessage = "Лист «Все коэффициенты» временно недоступен.";
  }

  const historyRecords = fboHistory.records.filter(
    (record) => record.date <= selectedDate,
  );
  let fboRecords;
  if (needsFboCurrent && fboCurrentStatus !== "unavailable") {
    fboRecords = [
      ...historyRecords.filter((record) => record.date < today),
      ...fboCurrent.records,
    ];
  } else if (needsFboCurrent) {
    // Today's history rows are snapshots, and zero rows are not evidence of no work.
    fboRecords = historyRecords.filter(
      (record) =>
        record.date < today ||
        (record.date === today && (record.total > 0 || record.coefficient > 0)),
    );
  } else {
    fboRecords = historyRecords;
  }
  const baseFboStatus = needsFboCurrent ? fboCurrentStatus : fboHistoryStatus;
  const fboStatus =
    needsFboCurrent && needsFboHistory
      ? fboCurrentStatus === "available" && fboHistoryStatus === "available"
        ? "available"
        : fboCurrentStatus === "unavailable" &&
            fboHistoryStatus === "unavailable"
          ? "unavailable"
          : "partial"
      : baseFboStatus;
  const fboMessage = [fboHistoryMessage, fboCurrentMessage]
    .filter(Boolean)
    .join(" ");

  let workLog = null;
  let workLogStatus = "unavailable";
  let workLogMessage = "Журнал WorkLog временно недоступен.";
  if (workLogRead.value !== null) {
    try {
      if (correctionsRead.value === null)
        throw new Error("assembly_corrections_unavailable");
      workLog = parseAssemblyWorkLog(workLogRead.value, correctionsRead.value);
      workLogStatus = workLog.invalid.length ? "partial" : "available";
      workLogMessage = workLog.invalid.length
        ? `В WorkLog есть ${workLog.invalid.length} строк, которые не удалось проверить; они исключены из расчёта.`
        : "";
    } catch (error) {
      workLog = null;
      workLogMessage =
        String(error?.message || "").startsWith("assembly_corrections_")
          ? "Журнал отмен WorkLogCorrections не удалось проверить. Данные Assembly не пересчитаны; предыдущий снимок может быть устаревшим."
          : error?.message === "assembly_worklog_schema_changed"
          ? "Структура WorkLog изменилась. Обновите подключение источника."
          : "WorkLog временно недоступен. Показаны последние полученные данные.";
    }
  }

  let catalog = new Map();
  let catalogStatus = "unavailable";
  if (catalogRead.value !== null) {
    try {
      catalog = parseAssemblyArticleCatalog(catalogRead.value);
      catalogStatus = "available";
    } catch {
      catalogStatus = "unavailable";
    }
  }
  if (workLog) {
    workLog = attachAssemblyProductTypes(workLog, catalog);
    if (catalogStatus === "unavailable") workLog.catalog.status = "unavailable";
  }

  const acceptedEvents = (workLog?.events || []).filter(
    (event) => event.date <= selectedDate,
  );
  const assemblyRecords = workLogRecords(acceptedEvents);
  const allRecords = [...fboRecords, ...assemblyRecords];
  const earliestRecordDate =
    allRecords.map((record) => record.date).sort()[0] || selectedDate;
  const allReconciled = reconcileAssemblySources({
    fboRecords,
    assemblyRecords,
    fboStatus,
    assemblyStatus: workLogStatus,
    startDate: earliestRecordDate,
    endDate: selectedDate,
  });
  const periodReconciliation = reconcileAssemblySources({
    fboRecords,
    assemblyRecords,
    fboStatus,
    assemblyStatus: workLogStatus,
    startDate: periodStart,
    endDate: selectedDate,
  });
  const reconciledRecords = [
    ...allReconciled.fboRecords,
    ...allReconciled.assemblyRecords,
  ];
  const history = summarizeAssemblyDays(reconciledRecords);
  const latestAssemblyEvent =
    acceptedEvents
      .map((event) => event.createdAt)
      .sort()
      .at(-1) || null;
  const latestFboRecordAt = coefficientLatest(fboRecords);
  const latestFboSourceAt =
    needsFboCurrent && fboCurrentStatus !== "unavailable"
      ? liveSheetTimestamp(today, fboCurrent.updateTime)
      : fboHistory.sourceUpdatedAt || latestFboRecordAt;
  const assemblyEventsInPeriod = acceptedEvents.filter(
    (event) => event.date >= periodStart,
  );
  const fboSourceUpdatedAt =
    latestFboSourceAt || fboHistory.sourceUpdatedAt || null;
  const sources = {
    fbo: {
      status: fboStatus,
      checkedAt,
      lastSuccessAt: fboStatus === "unavailable" ? null : checkedAt,
      sourceUpdatedAt: fboSourceUpdatedAt,
      currentSheetUpdatedAt: latestFboSourceAt,
      currentSheetUpdateTime: fboCurrent.updateTime,
      historyStatus: fboHistoryStatus,
      currentStatus: fboCurrentStatus,
      recordCount: periodReconciliation.sourceTotals.fbo.recordCount,
      source: FBO_SOURCE_ID,
      sheet:
        needsFboCurrent && needsFboHistory
          ? "Все коэффициенты + История производства"
          : needsFboCurrent
            ? "Все коэффициенты"
            : "История производства",
      message: fboMessage,
      invalidRecords:
        fboHistory.quality.invalidRecords + fboCurrent.invalid.length,
    },
    assembly: {
      status: workLogStatus,
      checkedAt,
      lastSuccessAt: workLog ? checkedAt : null,
      sourceUpdatedAt: latestAssemblyEvent,
      eventCount: assemblyEventsInPeriod.length,
      invalidRecords: workLog?.invalid.length || 0,
      message: workLogMessage,
      source: "RITM Assembly · WorkLog",
      supportsCorrections: Boolean(workLog?.audit?.supportsCorrections),
      correctionsApplied: workLog?.audit?.correctionsApplied || 0,
      cancellationsApplied: workLog?.audit?.cancellationsApplied || 0,
    },
    catalog: {
      status:
        catalogStatus === "unavailable"
          ? "unavailable"
          : assemblyEventsInPeriod.some((event) => !event.productType)
            ? "partial"
            : "available",
      missingRecords: assemblyEventsInPeriod.filter(
        (event) => !event.productType,
      ).length,
      message:
        catalogStatus === "unavailable"
          ? "Каталог поставки временно недоступен; вид товара может отсутствовать."
          : assemblyEventsInPeriod.some((event) => !event.productType)
            ? "Не для всех записей WorkLog найден вид товара в поставке."
            : "",
    },
  };
  const quality = {
    status:
      fboHistory.quality.status === "partial" ||
      fboCurrentStatus === "partial" ||
      workLogStatus === "partial"
        ? "partial"
        : "valid",
    invalidRecords:
      fboHistory.quality.invalidRecords +
      fboCurrent.invalid.length +
      (workLog?.invalid.length || 0),
  };
  const fboHistoryIssues = fboHistory.issues || [];
  return {
    ok: true,
    schemaVersion: 2,
    source: FBO_SOURCE_ID,
    date: selectedDate,
    period: selectedPeriod,
    updatedAt: checkedAt,
    sourceUpdatedAt: latestAssemblyEvent || fboSourceUpdatedAt,
    stale: fboStatus !== "available" || workLogStatus !== "available",
    issues: fboHistoryIssues,
    quality,
    norms,
    sources,
    sourcePolicy: { mode: "simultaneous", cutover: null, overlap: true },
    reconciliation: periodReconciliation,
    rows: summarizeAssembly(reconciledRecords, selectedDate, selectedPeriod),
    history,
    events: acceptedEvents,
    ...(includeHistory ? { recordsBySource: { fbo: fboRecords, assembly: assemblyRecords } } : {}),
  };
}
