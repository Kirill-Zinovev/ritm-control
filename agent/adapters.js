import { loadBoxPrinting, loadStockBoxPrinting } from './boxPrintingJournal.js';
import { readBoxSheetReport } from "./boxSheetReport.js";
import { loadAssembly } from "../worker/assembly.js";
import {
  loadPrinting,
  loadStockRollPrinting,
  loadStockBoxOrders,
  assignCatalogStores,
  assignWorkloadDetails,
  parseCsv,
  CATALOG_ID,
  ROLL_PRINTING_SHEET_ID,
  BOX_PRINTING_SHEET_ID,
} from "../worker/printing.js";
import { loadAssemblyPacking, unavailableAssemblyPacking } from "./assemblyPacking.js";
import { parseNonnegative, parseDay } from "../worker/assemblyDiagnostics.js";
import { sourceTimestamp } from "../worker/timestamps.js";
export function todayMoscow(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function columnIndex(column) {
  return (
    [...column].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1
  );
}
export function inspectGeneric(rows, sheet) {
  const issues = [],
    active = rows.slice(sheet.dataStartRow - 1);
  for (const check of sheet.checks) {
    const col = columnIndex(check.column);
    if (check.header && rows[sheet.headerRow - 1]?.[col] !== check.header) {
      const error = new Error("CSV schema changed");
      error.issue = {
        code: "schema_changed",
        source: sheet.name,
        cell: check.column + sheet.headerRow,
        found: rows[sheet.headerRow - 1]?.[col] || "",
        expected: check.header,
        message: "Изменился утверждённый заголовок",
      };
      throw error;
    }
    const counts = new Map();
    if (check.type === "unique")
      for (const row of active) {
        const key = String(row[col] || "").trim();
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
      }
    active.forEach((row, index) => {
      if (row.every((v) => !String(v).trim())) return;
      const raw = String(row[col] ?? "").trim();
      const bad =
        check.type === "required"
          ? !raw
          : check.type === "unique"
            ? !raw || counts.get(raw) > 1
            : check.type === "date"
              ? !parseDay(raw)
              : parseNonnegative(raw, check.type === "integer") === null;
      if (bad)
        issues.push({
          code:
            check.type === "unique"
              ? raw
                ? "duplicate_uid"
                : "missing_uid"
              : "invalid_" + check.type,
          source: sheet.name,
          row: sheet.dataStartRow + index,
          cell: check.column + (sheet.dataStartRow + index),
          found: raw.slice(0, 500),
          expected: check.expected || check.type,
          message: "Нарушено утверждённое правило столбца " + check.column,
        });
    });
  }
  return issues;
}

export async function readProductionShopCatalog(googleReader, signal) {
  if (!googleReader || !CATALOG_ID) return null;
  const token = await googleReader.accessToken(signal);
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${CATALOG_ID}/values:batchGet`,
  );
  const requestedRanges = [
    { sheet: "WB", startColumn: "A", endColumn: "T", query: "'WB'!A:T" },
    {
      sheet: "OZON",
      startColumn: "A",
      endColumn: "P",
      query: "'OZON'!A:P",
    },
  ];
  for (const range of requestedRanges)
    url.searchParams.append("ranges", range.query);
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  url.searchParams.set("majorDimension", "ROWS");
  const response = await googleReader.request(url, {
    method: "GET",
    redirect: "error",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.any(
      [signal, AbortSignal.timeout(25000)].filter(Boolean),
    ),
    ritmPriority: -1,
  });
  if (!response.ok) throw new Error("Shop catalog unavailable");
  const data = await response.json();
  const returnedRangeMatches = (value, expected) => {
    const match = String(value || "").match(
      /^(?:'((?:[^']|'')+)'|([^!]+))!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/u,
    );
    if (!match) return false;
    const sheet = (match[1] || match[2]).replaceAll("''", "'"),
      startColumn = match[3],
      startRow = Number(match[4] || 1),
      endColumn = match[5] || startColumn,
      endRow = match[6] ? Number(match[6]) : null;
    return (
      sheet === expected.sheet &&
      startColumn === expected.startColumn &&
      endColumn === expected.endColumn &&
      startRow === 1 &&
      (endRow === null || endRow >= startRow)
    );
  };
  if (
    data.spreadsheetId !== CATALOG_ID ||
    !Array.isArray(data.valueRanges) ||
    data.valueRanges.length !== requestedRanges.length ||
    !requestedRanges.every(
      (range, index) =>
        returnedRangeMatches(data.valueRanges[index]?.range, range),
    )
  )
    throw new Error("Shop catalog response invalid");
  const rowsFromColumns = (columns, width, placements) => {
    const rowCount = Math.max(
      0,
      ...columns.map((column) => column.length),
    );
    return Array.from({ length: rowCount }, (_, index) => {
      const row = Array(width).fill("");
      columns.forEach((column, columnIndex) => {
        const values = column[index] || [];
        for (let offset = 0; offset < placements[columnIndex].count; offset++)
          row[placements[columnIndex].start + offset] = values[offset] || "";
      });
      return row;
    });
  };
  return {
    WB: rowsFromColumns(
      [data.valueRanges[0].values || []],
      20,
      [
        { start: 0, count: 20 },
      ],
    ),
    OZON: rowsFromColumns(
      [data.valueRanges[1].values || []],
      16,
      [
        { start: 0, count: 16 },
      ],
    ),
  };
}

export async function readWorkloadPhotos(reader, documentId, signal) {
  if (!reader || !/^[A-Za-z0-9_-]{20,100}$/.test(documentId || "")) return null;
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${documentId}/values:batchGet`);
  url.searchParams.set("ranges", "'Фото'!A:D");
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  const response = await reader.request(url, { method: "GET", signal });
  if (!response.ok) throw new Error("Photo catalog unavailable");
  const data = await response.json();
  const result = data.valueRanges?.[0];
  if (data.spreadsheetId !== documentId || data.valueRanges?.length !== 1 || !/^(?:'Фото'|Фото)!A1:D\d+$/.test(result?.range || "")) throw new Error("Photo catalog response invalid");
  const rows = result.values || [];
  if (String(rows[0]?.[0] || "").trim().toLowerCase() !== "артикул" || String(rows[0]?.[1] || "").trim().toLowerCase() !== "магазин") throw new Error("Photo catalog headers invalid");
  return rows.slice(1);
}

export async function loadSource(
  source,
  fetcher,
  now = new Date(),
  options = {},
) {
  if (source.adapter === "assembly")
    return loadAssembly(todayMoscow(now), "day", fetcher, { includeHistory: true });
  if (source.adapter === "printing") {
    const boxSheetReport = !options.supplyTarget && BOX_PRINTING_SHEET_ID && typeof options.googleReader?.get === "function"
      ? readBoxSheetReport(options.googleReader, BOX_PRINTING_SHEET_ID, options.signal)
        .catch(() => ({ status: "unavailable", rows: [], entered: 0, total: null }))
      : null;
    const authenticatedFetcher = options.googleReader
      ? async (url, init = {}) => {
          const parsed = new URL(url),
            documentMatch = parsed.pathname.match(
              /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)\/export$/,
            );
          if (
            parsed.hostname !== "docs.google.com" ||
            !documentMatch ||
            ![source.documentId, ROLL_PRINTING_SHEET_ID, BOX_PRINTING_SHEET_ID,
              options.stockRollPrintingId, options.stockBoxPrintingId].includes(
              documentMatch[1],
            ) ||
            parsed.searchParams.get("format") !== "csv" ||
            !/^\d+$/.test(parsed.searchParams.get("gid") || "")
          )
            throw new Error("Unapproved printing export URL");
          const token = await options.googleReader.accessToken(init.signal),
            headers = new Headers(init.headers);
          headers.set("authorization", "Bearer " + token);
          return fetcher(url, { ...init, headers });
        }
      : fetcher;
    let shopCatalogRows = null;
    let photoCatalogRows = null;
    if (options.googleReader && !options.supplyTarget && !options.workloadCatalog) {
      const [shops, photos] = await Promise.allSettled([
        readProductionShopCatalog(options.googleReader, options.signal),
        options.photoSourceId ? readWorkloadPhotos(options.googleReader, options.photoSourceId, options.signal) : null,
      ]);
      options.signal?.throwIfAborted();
      if (shops.status === "fulfilled") shopCatalogRows = shops.value;
      if (photos.status === "fulfilled") photoCatalogRows = photos.value;
    }
    let printing = await loadPrinting(authenticatedFetcher, {
      additionalSheets: options.printingAdditionalSheets || [],
      productionSupplies: options.productionSupplies || [],
      assemblyBoxLinks: options.assemblyBoxLinks || [],
      shopCatalogRows,
      photoCatalogRows,
      supplyTarget: options.supplyTarget,
      readHiddenSupply: typeof options.googleReader?.hiddenSupplyRows === "function" ?
        (documentId, sheetId, name) => options.googleReader.hiddenSupplyRows(documentId, sheetId, name, options.signal) : null,
    });
    async function stockSheets(id, withJournal) {
      const meta=await options.googleReader.metadata(id,options.signal,5);
      if(meta.spreadsheetId!==id)throw new Error('stock source mismatch');
      const names=['Запасы склад','Срочные 2 этаж'];
      const sheets=names.map(name=>{
        const found=(meta.sheets||[]).filter(s=>s.properties?.title===name&&!s.properties.hidden);
        if(found.length!==1||!Number.isSafeInteger(found[0].properties.sheetId))throw new Error('stock sheet mismatch');
        return {gid:found[0].properties.sheetId,name};
      });
      const journal=withJournal?(meta.sheets||[]).find(s=>s.properties?.title==='Журнал выпуска'):null;
      if(withJournal&&!Number.isSafeInteger(journal?.properties?.sheetId))throw new Error('stock journal missing');
      const archives=(meta.sheets||[]).filter(s=>s.properties?.title==='_RITM_STOCK_ARCHIVE');
      if(archives.length>1 || (archives.length && !Number.isSafeInteger(archives[0].properties?.sheetId)))throw new Error('stock archive mismatch');
      const historyNames=['ROLLS_V2','ROLLS_V2_PROGRESS'];
      const history=historyNames.map(name=>(meta.sheets||[]).filter(s=>s.properties?.title===name));
      const historyIds=withJournal && history.every(matches=>matches.length===1&&Number.isSafeInteger(matches[0].properties?.sheetId))
        ? history.map(matches=>matches[0].properties.sheetId) : undefined;
      return {sheets,journalId:journal?.properties?.sheetId,archiveId:archives[0]?.properties?.sheetId,historyIds};
    }
    if(!options.supplyTarget&&options.googleReader&&options.stockRollPrintingId)try{
      const stock=await stockSheets(options.stockRollPrintingId,true);
      printing=await loadStockRollPrinting(authenticatedFetcher,printing,{spreadsheetId:options.stockRollPrintingId,...stock});
    }catch(error){if(options.signal?.aborted)throw error;printing={...printing,stockRoll:{status:'unavailable',orders:[],reason:'Не удалось подтвердить таблицу запасов рулонной печати.'}};}
    if(!options.supplyTarget&&options.googleReader&&options.stockBoxPrintingId)try{
      const stock=await stockSheets(options.stockBoxPrintingId,false);
      printing=await loadStockBoxOrders(authenticatedFetcher,printing,{spreadsheetId:options.stockBoxPrintingId,...stock});
    }catch(error){if(options.signal?.aborted)throw error;printing={...printing,stockBox:{status:'unavailable',orders:[],reason:'Не удалось подтвердить таблицу запасов бокса.'}};}
    const stockOrders = [printing.stockRoll, printing.stockBox].flatMap(source => (source?.orders || []).filter(order => !order.archived));
    const workloadCatalog = options.workloadCatalog?.(printing.supplies, stockOrders);
    printing = await loadBoxPrinting(options.googleReader, printing, {journalId: options.boxJournalId || source.boxJournalId || (typeof process !== "undefined" ? process.env.RITM_BOX_JOURNAL_ID : ""), signal: options.signal});
    if (!options.supplyTarget) printing = await loadStockBoxPrinting(options.googleReader, printing, {journalId: options.stockBoxJournalId, sourceId: options.stockBoxPrintingId, signal: options.signal});
    if (workloadCatalog) {
      shopCatalogRows = await workloadCatalog;
      printing.shopCatalog = assignCatalogStores(printing.supplies, shopCatalogRows);
      assignWorkloadDetails(printing.supplies, shopCatalogRows, null, {preferCatalog: true});
    }
    if (boxSheetReport) printing.boxSheetReport = await boxSheetReport;
    assignStockPlanningMachines(printing, shopCatalogRows, photoCatalogRows);
    const checkedAt = now instanceof Date ? now.toISOString() : new Date().toISOString();
    return options.googleReader
      ? loadAssemblyPacking(options.googleReader, printing, {
          signal: options.signal,
          checkedAt,
        })
      : unavailableAssemblyPacking(
          printing,
          checkedAt,
          "Источник WorkLog не подключён к этому экземпляру RITM.",
        );
  }
  const exports = await Promise.all(
    source.sheets
      .filter((s) => s.status !== "not_configured")
      .map(async (sheet) => {
        const response = await fetcher(
          "https://docs.google.com/spreadsheets/d/" +
            source.documentId +
            "/export?format=csv&gid=" +
            sheet.gid,
        );
        if (!response.ok) throw new Error("CSV source unavailable");
        const rows = parseCsv(await response.text());
        return { sheet, rows, issues: inspectGeneric(rows, sheet) };
      }),
  );
  const issues = exports.flatMap((s) => s.issues);
  const times = exports.flatMap(({ sheet, rows }) =>
    sheet.updatedAtColumn
      ? rows
          .slice(sheet.dataStartRow - 1)
          .map((r) => sourceTimestamp(r[columnIndex(sheet.updatedAtColumn)]))
          .filter(Boolean)
      : [],
  );
  return {
    ok: true,
    updatedAt: now.toISOString(),
    sourceUpdatedAt: times.sort().at(-1) || null,
    issues,
    quality: { status: issues.length ? "partial" : "valid" },
    recordCount: exports.reduce(
      (n, s) => n + s.rows.length - s.sheet.dataStartRow + 1,
      0,
    ),
  };
}

export function assignStockPlanningMachines(printing, catalog, photos) {
  const orders = [printing.stockRoll, printing.stockBox].flatMap(source => (source?.orders || []).filter(order => !order.archived));
  if (!orders.length) return;
  const lookups = orders.map(order => ({...order, sheetName:'OZON '+order.sheetName}));
  // Build the catalog/photo indices once for all stock orders. Rebuilding
  // a full marketplace catalog for every article dominated refresh CPU time.
  assignWorkloadDetails(lookups, catalog, photos);
  orders.forEach((order, index) => {
    const lookup = lookups[index];
    order.planningMachine = lookup.machineSource === 'catalog' ? lookup.machine : null;
  });
}
export function validateApi(payload, kind) {
  if (
    !payload ||
    payload.ok !== true ||
    !Number.isFinite(Date.parse(payload.updatedAt))
  )
    throw new Error("API schema changed");
  const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (kind === "assembly") {
    if (
      ![1, 2].includes(payload.schemaVersion) ||
      !Array.isArray(payload.rows) ||
      !Array.isArray(payload.history)
    )
      throw new Error("API schema changed");
    for (const row of [...payload.rows, ...payload.history]) {
      if (
        !row ||
        typeof row.employee !== "string" ||
        !row.employee.trim() ||
        (row.coefficient !== null && !finite(row.coefficient)) ||
        ![
          "machineCut",
          "manualCut",
          "cut",
          "packed",
          "total",
          "days",
        ].every((k) => finite(row[k])) ||
        !Array.isArray(row.cutTypes) ||
        !Array.isArray(row.packTypes) ||
        [...row.cutTypes, ...row.packTypes].some(
          (x) => !x || typeof x.name !== "string" || !finite(x.quantity),
        )
      )
        throw new Error("API numeric/schema violation");
    }
    if (payload.history.some((r) => !parseDay(r.date)))
      throw new Error("API date violation");
    if (
      new Set(
        payload.history.map(
          (r) => r.date + "|" + (r.identityKey || r.employee),
        ),
      ).size !== payload.history.length
    )
      throw new Error("API duplicate daily records");
  } else {
    if (
      payload.schemaVersion !== 2 ||
      !Array.isArray(payload.events) ||
      !Array.isArray(payload.supplies) ||
      !Array.isArray(payload.issues) ||
      !Array.isArray(payload.sheets)
    )
      throw new Error("API schema changed");
    const ids = new Set();
    for (const e of payload.events) {
      if (
        !e?.id ||
        ids.has(e.id) ||
        !e.uid ||
        !e.employee ||
        !parseDay(e.date) ||
        !finite(e.area) ||
        e.area <= 0 ||
        !Number.isSafeInteger(e.quantity) ||
        e.quantity <= 0
      )
        throw new Error("API invalid or duplicate printing event");
      ids.add(e.id);
    }
    if (
      payload.supplies.some(
        (r) =>
          !r?.uid ||
          !Number.isSafeInteger(r.quantity) ||
          r.quantity < 0 ||
          !finite(r.plannedArea),
      )
    )
      throw new Error("API order schema violation");
    if (
      payload.packing &&
      (![
        "available",
        "partial",
        "unavailable",
      ].includes(payload.packing.status) ||
        typeof payload.packing.source !== "string" ||
        !Number.isFinite(Date.parse(payload.packing.checkedAt)) ||
        !Number.isSafeInteger(payload.packing.eventCount) ||
        payload.packing.eventCount < 0 ||
        !Number.isSafeInteger(payload.packing.invalidRecords) ||
        payload.packing.invalidRecords < 0 ||
        (payload.packing.sourceUpdatedAt != null &&
          !Number.isFinite(Date.parse(payload.packing.sourceUpdatedAt))))
    )
      throw new Error("API packing source schema violation");
    if (
      payload.supplies.some(
        (order) =>
          order.packed !== undefined &&
          order.packed !== null &&
          (!Number.isSafeInteger(order.packed) || order.packed < 0),
      )
    )
      throw new Error("API packing quantity violation");
  }
  return payload;
}
