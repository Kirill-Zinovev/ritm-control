import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { digest, gridViews, scalar } from "./diagnosticGrid.js";
import { doctorColumnIndex } from "./doctorRegistry.js";
import { formulaReferences } from "./formulaReferences.js";
import { observedFormulaCells } from "./formulaHistory.js";

const letters = (n) => {
  let s = "";
  for (n++; n; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const unpack = (v) => JSON.parse(gunzipSync(v).toString("utf8"));
const point = (address) => {
  const [, c, r] = address.match(/^([A-Z]+)([1-9]\d*)$/);
  return [doctorColumnIndex(c), +r - 1];
};
const link = (doc, gid, cell) =>
  `https://docs.google.com/spreadsheets/d/${doc}/edit#gid=${gid}&range=${cell}`;
const mergeAt = (sheet, col, row) => {
  const merge = (sheet.merges || []).find(
    (m) =>
      (m.startRowIndex || 0) <= row &&
      m.endRowIndex > row &&
      (m.startColumnIndex || 0) <= col &&
      m.endColumnIndex > col,
  );
  return merge
    ? JSON.stringify([
        merge.startRowIndex || 0,
        merge.endRowIndex,
        merge.startColumnIndex || 0,
        merge.endColumnIndex,
      ])
    : null;
};
const FAST_RANGE_ROWS = 500;

// Classification aid only. Exact approved strings, never these patterns, determine violations.
// Quoted strings, sheet names, absolute references and function names are retained.
export function formulaFamily(formula, address) {
  const [col, row] = point(address);
  return formula.replace(
    /"(?:[^"]|"")*"|'(?:[^']|'')+'!|[\p{L}_][\p{L}\p{N}_ .]*!|(?<![\p{L}\p{N}_])\$?[A-Z]{1,3}\$?[1-9]\d*(?![\p{L}\p{N}_(]|!)/gu,
    (token) => {
      const m = token.match(/^(\$?)([A-Z]+)(\$?)([1-9]\d*)$/);
      if (!m) return token;
      return `R${m[3] ? "=" + m[4] : "[" + (+m[4] - 1 - row) + "]"}C${m[1] ? "=" + m[2] : "[" + (doctorColumnIndex(m[2]) - col) + "]"}`;
    },
  );
}

export function discoverFormulaSheet(document, schema, sheet) {
  const cells = new Map(),
    formulas = new Map(),
    merges = new Map();
  const limit =
    sheet.readBounds?.rows ??
    Math.min(schema.maxRows, sheet.properties.gridProperties.rowCount);
  const maxCol =
    (sheet.readBounds?.columns ?? doctorColumnIndex(schema.lastColumn) + 1) - 1;
  for (const m of sheet.merges || []) {
    const sig = JSON.stringify([
      m.startRowIndex || 0,
      m.endRowIndex,
      m.startColumnIndex || 0,
      m.endColumnIndex,
    ]);
    for (let r = m.startRowIndex || 0; r < Math.min(m.endRowIndex, limit); r++)
      for (
        let c = m.startColumnIndex || 0;
        c < Math.min(m.endColumnIndex, maxCol + 1);
        c++
      )
        merges.set(letters(c) + (r + 1), {
          signature: sig,
          anchor:
            letters(m.startColumnIndex || 0) + ((m.startRowIndex || 0) + 1),
        });
  }
  for (const block of sheet.data || [])
    for (const [ri, row] of (block.rowData || []).entries())
      for (const [ci, native] of (row.values || []).entries()) {
        const r = (block.startRow || 0) + ri,
          c = (block.startColumn || 0) + ci;
        if (r >= limit || c > maxCol) continue;
        const address = letters(c) + (r + 1);
        if (native.userEnteredValue || native.effectiveValue)
          cells.set(address, native);
        if (native.userEnteredValue?.formulaValue)
          formulas.set(address, native.userEnteredValue.formulaValue);
      }
  const rowsWithManualInputs = new Set();
  for (const [address, native] of cells) {
    if (native.userEnteredValue && !native.userEnteredValue.formulaValue)
      rowsWithManualInputs.add(point(address)[1] + 1);
  }
  const mergeInteriorFormulas = [...formulas.keys()].filter((address) => {
    const merge = merges.get(address);
    return merge && merge.anchor !== address;
  }).length;
  const groups = new Map();
  for (const [address, formula] of formulas) {
    const m = merges.get(address);
    if (m && m.anchor !== address) continue; // Only a native merge anchor can be protected.
    const [col] = point(address),
      family = formulaFamily(formula, address);
    const id = digest([document.id, schema.gid, col, family]);
    const g = groups.get(id) || {
      id,
      sourceId: document.id,
      documentId: document.documentId,
      document: document.name,
      gid: schema.gid,
      sheet: sheet.properties.title,
      column: letters(col),
      family,
      cells: [],
      samples: [],
      errors: 0,
      merged: 0,
      dependencies: [],
    };
    const native = cells.get(address),
      error = native?.effectiveValue?.errorValue;
    g.cells.push([
      address,
      formula,
      m?.signature || null,
      error?.type || null,
      rowsWithManualInputs.has(point(address)[1] + 1),
    ]);
    if (error) g.errors++;
    if (m) g.merged++;
    if (g.samples.length < 4 || address === "M11")
      g.samples.push({
        cell: address,
        formula,
        result: scalar(native),
        error: error || null,
        url: link(document.documentId, schema.gid, address),
        merge: m?.signature || null,
      });
    groups.set(id, g);
  }
  const areas = [];
  for (const g of groups.values()) {
    g.cells.sort((a, b) => point(a[0])[1] - point(b[0])[1]);
    g.range = g.cells[0][0] + ":" + g.cells.at(-1)[0];
    g.count = g.cells.length;
    g.kind = g.count === 1 ? "individual" : "typical";
    g.dependencies = [
      ...new Set(
        g.cells[0][1].match(
          /'(?:[^']|'')+'!|[\p{L}_][\p{L}\p{N}_ .]*!|IMPORTRANGE|INDIRECT|OFFSET|ARRAYFORMULA|QUERY/giu,
        ) || [],
      ),
    ];
    g.referenceExamples = g.cells.slice(0, 3).map(([cell, formula]) => ({
      cell,
      ...formulaReferences(formula, g.sheet),
    }));
    // Holes are not assumed to be broken. Non-formula, non-merge-interior values remain unprotected.
    const covered = new Set(g.cells.map((c) => c[0]));
    g.manual = 0;
    g.manualSamples = [];
    const [c, first] = point(g.cells[0][0]),
      [, last] = point(g.cells.at(-1)[0]);
    for (let r = first; r <= last; r++) {
      const a = letters(c) + (r + 1),
        n = cells.get(a),
        m = merges.get(a);
      if (
        covered.has(a) ||
        (m && m.anchor !== a) ||
        !n?.userEnteredValue ||
        n.userEnteredValue.formulaValue
      )
        continue;
      g.manual++;
      if (g.manualSamples.length < 6)
        g.manualSamples.push({
          cell: a,
          value: n.userEnteredValue,
          url: link(document.documentId, schema.gid, a),
        });
    }
    const manualEvidence = [];
    for (let r = first; r <= last; r++) {
      const a = letters(c) + (r + 1),
        n = cells.get(a),
        m = merges.get(a);
      if (
        !covered.has(a) &&
        !(m && m.anchor !== a) &&
        n?.userEnteredValue &&
        !n.userEnteredValue.formulaValue
      )
        manualEvidence.push([a, n.userEnteredValue, m?.signature || null]);
    }
    g.manualSignature = digest(manualEvidence);
    g.diagnosticSignature = digest(
      g.cells.map(([address, , , errorType, rowHasInputs]) => [
        address,
        errorType,
        rowHasInputs,
      ]),
    );
    g.version = digest([
      2,
      g.id,
      g.sheet,
      g.cells.map(([address, formula, merge]) => [address, formula, merge]),
    ]);
    areas.push(g);
  }
  return {
    areas,
    cells,
    formulas,
    merges,
    limit,
    maxCol,
    mergeInteriorFormulas,
  };
}

export class FormulaDecisionError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}
export class FormulaIntelligence {
  constructor(store, config, { now = () => new Date() } = {}) {
    this.store = store;
    this.config = config;
    this.now = now;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS formula_versions(version TEXT PRIMARY KEY,region_id TEXT NOT NULL,at TEXT NOT NULL,payload BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS formula_regions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,gid INTEGER NOT NULL,version TEXT NOT NULL,at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS formula_protected(source_id TEXT NOT NULL,gid INTEGER NOT NULL,cell TEXT NOT NULL,formula TEXT NOT NULL,merge_signature TEXT,region_id TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(source_id,gid,cell));
      CREATE INDEX IF NOT EXISTS formula_protected_region ON formula_protected(region_id);
      CREATE TABLE IF NOT EXISTS formula_decisions(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS formula_exceptions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,gid INTEGER NOT NULL,cell TEXT NOT NULL,version TEXT NOT NULL,evidence TEXT NOT NULL,expires_at TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS formula_protection_previews(id TEXT PRIMARY KEY,at TEXT NOT NULL,expires_at TEXT NOT NULL,manifest TEXT NOT NULL,report TEXT NOT NULL,status TEXT NOT NULL);
    `);
  }
  activeDocument(id) {
    return this.config.doctorDocuments.find(
      (d) => d.id === id && d.enabled && d.adapter === "google",
    );
  }
  pause(sourceId, gid, cell = null, state = "rule_paused") {
    const scope = `doctor:formula:${sourceId}:${gid}`;
    for (const r of this.store.db
      .prepare(
        "SELECT id,payload FROM incidents WHERE scope=? AND status='open'",
      )
      .all(scope)) {
      if (cell && JSON.parse(r.payload).cell !== cell) continue;
      this.store.db
        .prepare(
          "UPDATE incidents SET status=?,workflow=?,resolved_at=NULL WHERE id=?",
        )
        .run(state, state, r.id);
      this.store.db
        .prepare(
          "UPDATE outbox SET status='cancelled' WHERE incident_id=? AND status='pending'",
        )
        .run(r.id);
      this.store.log(
        "formula_incident_suspended",
        "Эталон или исключение изменён владельцем; ячейка не исправлялась",
        r.id,
        this.now().toISOString(),
      );
    }
  }
  inspect(document, spreadsheet, complete, at) {
    if (!complete || document.adapter !== "google") return [];
    const findings = [],
      metrics = [];
    for (const schema of document.sheets) {
      const sheet = spreadsheet.sheets.find(
        (s) => s.properties.sheetId === schema.gid,
      );
      if (!sheet || (!sheet.data?.length && !sheet.readBounds)) continue;
      const started = performance.now(),
        discovered = discoverFormulaSheet(document, schema, sheet);
      const {
        areas,
        cells,
        formulas,
        merges,
        limit,
        maxCol,
        mergeInteriorFormulas,
      } = discovered;
      const protectedCells = this.store.db
        .prepare("SELECT * FROM formula_protected WHERE source_id=? AND gid=?")
        .all(document.id, schema.gid);
      const protectedMap = new Map(protectedCells.map((p) => [p.cell, p]));
      const exceptions = new Map(
        this.store.db
          .prepare(
            "SELECT * FROM formula_exceptions WHERE source_id=? AND gid=? AND status='active'",
          )
          .all(document.id, schema.gid)
          .map((e) => [e.cell, e]),
      );
      const local = [];
      let checked = 0,
        protectedRead = 0,
        excepted = 0;
      const hypotheses = new Map();
      // Unapproved history is evidence of a change, not a verified original or permission to repair.
      for (const old of this.store.db
        .prepare(
          "SELECT version,payload FROM formula_regions WHERE source_id=? AND gid=?",
        )
        .all(document.id, schema.gid)) {
        if (!JSON.parse(old.payload).current) continue;
        const version = this.store.db
          .prepare("SELECT payload FROM formula_versions WHERE version=?")
          .get(old.version);
        for (const [cell, formula] of unpack(version.payload).cells) {
          if (!protectedMap.has(cell) && formulas.get(cell) !== formula)
            hypotheses.set(cell, formula);
        }
      }
      for (const old of this.store.db
        .prepare(
          "SELECT payload FROM incidents WHERE scope=? AND status='open'",
        )
        .all(`doctor:formula:${document.id}:${schema.gid}`)) {
        const finding = JSON.parse(old.payload);
        if (
          finding.type === "formula_history_change" &&
          !protectedMap.has(finding.cell)
        )
          hypotheses.set(finding.cell, finding.expected?.candidateFormula);
      }
      for (const [cell, candidate] of hypotheses) {
        if (!candidate || formulas.get(cell) === candidate) continue;
        const native = cells.get(cell) || {};
        local.push({
          kind: "table_doctor",
          sourceId: document.id,
          sourceName: document.name,
          department: document.department,
          sheet: sheet.properties.title,
          cell,
          row: point(cell)[1] + 1,
          type: "formula_history_change",
          severity: "warning",
          title: "Формула изменилась относительно неутверждённого снимка",
          observed: {
            entered: native.userEnteredValue || null,
            result: scalar(native),
          },
          expected: {
            candidateFormula: candidate,
            confidence: "unapproved_history",
          },
          cause:
            "Подтверждён только факт изменения. Предыдущая формула не утверждена владельцем; её правильность и причина изменения неизвестны",
          impact: "Влияние на KPI не подтверждено",
          recommendation: `Возможный вариант из истории: ${candidate}. Это гипотеза, а не подтверждённый оригинал; сначала согласуйте бизнес-логику`,
          verification: "needs_review",
          initialStatus: "review",
          category: "suspicious",
          sourceUrl: link(document.documentId, schema.gid, cell),
        });
      }
      for (const p of protectedCells) {
        const [col, row] = point(p.cell),
          native = cells.get(p.cell) || {};
        const observed = native.userEnteredValue || null,
          current = native.userEnteredValue?.formulaValue || null;
        const merge = merges.get(p.cell)?.signature || null;
        const structural =
          row >= limit || col > maxCol || merge !== p.merge_signature;
        const e = exceptions.get(p.cell);
        if (
          e &&
          e.version === p.version &&
          e.evidence === digest([observed, merge]) &&
          Date.parse(e.expires_at) > this.now().getTime()
        ) {
          excepted++;
          this.pause(document.id, schema.gid, p.cell, "excepted");
          continue;
        }
        if (!structural) {
          checked++;
          if (current === p.formula && merge === p.merge_signature)
            protectedRead++;
        }
        if (!structural && current === p.formula) continue;
        local.push({
          kind: "table_doctor",
          sourceId: document.id,
          sourceName: document.name,
          department: document.department,
          sheet: sheet.properties.title,
          cell: p.cell,
          row: row + 1,
          type: structural
            ? "structure_changed"
            : current
              ? "formula_mismatch"
              : observed?.numberValue !== undefined
                ? "formula_number"
                : observed?.stringValue !== undefined
                  ? "formula_text"
                  : "formula_missing",
          severity: structural ? "warning" : "high",
          title: structural
            ? "Изменена область защищённой формулы"
            : "Нарушен утверждённый эталон формулы",
          observed: {
            entered: observed,
            merge,
            result: scalar(native),
            error: native.effectiveValue?.errorValue || null,
          },
          expected: p.formula,
          previousFormula: p.formula,
          cause: structural
            ? "Изменилась геометрия объединения или граница чтения; адрес восстановления требует проверки"
            : "Факт: содержимое отличается от утверждённого снимка. Ручная замена — гипотеза; автор и причина изменения неизвестны",
          impact:
            "Изменён расчёт в защищённой ячейке. Влияние на KPI требует анализа зависимостей; числовой ущерб не рассчитан",
          recommendation: structural
            ? "Проверить структуру; не восстанавливать формулу по старому адресу автоматически"
            : `Предлагаемая формула: ${p.formula}. Она взята из утверждённого снимка, не из соседней строки. Точечное восстановление требует настроенного аккаунта записи и отдельного подтверждения владельца`,
          verification: structural ? "needs_review" : "rule_confirmed",
          initialStatus: structural ? "review" : "confirmed",
          category: structural ? "business_review" : "confirmed_formula",
          sourceUrl: link(document.documentId, schema.gid, p.cell),
          baselineVersion: p.version,
          formulaRegionId: p.region_id,
        });
      }
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        const currentIds = new Set(areas.map((a) => a.id));
        for (const old of this.store.db
          .prepare(
            "SELECT id,payload FROM formula_regions WHERE source_id=? AND gid=?",
          )
          .all(document.id, schema.gid)) {
          if (!currentIds.has(old.id))
            this.store.db
              .prepare("UPDATE formula_regions SET payload=? WHERE id=?")
              .run(
                JSON.stringify({ ...JSON.parse(old.payload), current: false }),
                old.id,
              );
        }
        const addVersion = this.store.db.prepare(
          "INSERT OR IGNORE INTO formula_versions VALUES(?,?,?,?)",
        );
        const put = this.store.db.prepare(
          "INSERT INTO formula_regions VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,at=excluded.at,payload=excluded.payload",
        );
        for (const area of areas) {
          if (
            !this.store.db
              .prepare("SELECT 1 FROM formula_versions WHERE version=?")
              .get(area.version)
          )
            addVersion.run(
              area.version,
              area.id,
              at,
              gzipSync(JSON.stringify(area)),
            );
          const { cells: ignored, ...summary } = area;
          summary.current = true;
          summary.protected = area.cells.filter(([a]) =>
            protectedMap.has(a),
          ).length;
          summary.diagnosticErrors = area.cells
            .filter(([, , , errorType]) => errorType)
            .map(([cell, formula, merge, errorType, rowHasInputs]) => ({
              cell,
              formula,
              merge,
              errorType,
              rowHasInputs,
            }));
          summary.changed = area.cells.filter(([a, f, m]) => {
            const p = protectedMap.get(a);
            return p && (p.formula !== f || p.merge_signature !== m);
          }).length;
          summary.unprotected = area.count - summary.protected;
          put.run(
            area.id,
            document.id,
            schema.gid,
            area.version,
            at,
            JSON.stringify(summary),
          );
        }
        this.store.db.exec("COMMIT");
      } catch (e) {
        this.store.db.exec("ROLLBACK");
        throw e;
      }
      this.store.reconcile(
        `doctor:formula:${document.id}:${schema.gid}`,
        local,
        { verified: true, at },
      );
      findings.push(...local);
      metrics.push({
        sourceId: document.id,
        document: document.name,
        gid: schema.gid,
        sheet: sheet.properties.title,
        at,
        formulasRead: formulas.size,
        mergeInteriorFormulas,
        protectedCells: protectedCells.length,
        checkedCells: checked,
        protectedFormulasRead: protectedRead,
        unprotectedFormulas: formulas.size - protectedRead,
        protectedPercent: formulas.size
          ? Math.round((10000 * protectedRead) / formulas.size) / 100
          : null,
        damage: local.filter((f) => f.verification === "rule_confirmed").length,
        structural: local.filter((f) => f.type === "structure_changed").length,
        exceptions: excepted,
        regions: areas.length,
        fullSheetRead: sheet.readBounds?.fullGrid === true,
        readRows: limit,
        readColumns: maxCol + 1,
        durationMs: Math.round(performance.now() - started),
      });
    }
    this.store.snapshot("formula-metrics:" + document.id, metrics, at);
    return findings;
  }
  async fastCheck(
    reader,
    signal,
    at = new Date(),
    { metadataByDocument = new Map() } = {},
  ) {
    const started = performance.now(),
      before = reader.telemetry?.() || {};
    const documents = [];
    let metadataReadRequests = 0,
      metadataDurationMs = 0,
      rangeReadDurationMs = 0,
      comparisonDurationMs = 0;
    for (const document of this.config.doctorDocuments.filter(
      (d) => d.enabled && d.adapter === "google",
    )) {
      let metadataSheets = null,
        metadataError = null;
      const reusedMetadata = metadataByDocument.get(document.id);
      if (reusedMetadata) {
        if (reusedMetadata.spreadsheetId !== document.documentId)
          metadataError = new Error("spreadsheet_mismatch");
        else
          metadataSheets = new Map(
            (reusedMetadata.sheets || []).map((sheet) => [
              sheet.properties.sheetId,
              sheet,
            ]),
          );
      } else if (typeof reader.metadata === "function") {
        const metadataStarted = performance.now();
        metadataReadRequests++;
        try {
          const metadata = await reader.metadata(
            document.documentId,
            signal,
            100,
          );
          if (metadata.spreadsheetId !== document.documentId)
            throw new Error("spreadsheet_mismatch");
          metadataSheets = new Map(
            (metadata.sheets || []).map((sheet) => [
              sheet.properties.sheetId,
              sheet,
            ]),
          );
        } catch (error) {
          metadataError = error;
        } finally {
          metadataDurationMs += performance.now() - metadataStarted;
        }
      }
      const groupedCalculationErrors = new Set(
        this.store.db
          .prepare(
            "SELECT payload FROM incidents WHERE scope=? AND status='open'",
          )
          .all("doctor:data-quality:" + document.id)
          .flatMap((row) => {
            const finding = JSON.parse(row.payload);
            return (finding.errorCells || []).map(
              (cell) => cell.gid + ":" + cell.cell,
            );
          }),
      );
      const sheets = [];
      for (const schema of document.sheets) {
        if (signal?.aborted) break;
        const protectedCells = this.store.db
          .prepare(
            "SELECT cell,formula,merge_signature,region_id,version FROM formula_protected WHERE source_id=? AND gid=? ORDER BY cell",
          )
          .all(document.id, schema.gid);
        const historicalCells = observedFormulaCells(this.store.db, document.id, schema.gid, protectedCells);
        const monitoredCells = [...protectedCells, ...historicalCells];
        if (!monitoredCells.length) {
          const meta = metadataSheets?.get(schema.gid), valid = meta?.properties.title === schema.name;
          sheets.push({ sourceId: document.id, document: document.name, gid: schema.gid, sheet: schema.name,
            status: valid ? "ok" : "degraded", checkedCells: 0, protectedCells: 0, historicalCheckedCells: 0,
            matchingCells: 0, violations: 0, readRequests: 0, at: at.toISOString(),
            errorCode: valid ? null : "sheet_metadata_unavailable" });
          continue;
        }
        const startedSheet = performance.now();
        let requestCount = 0;
        try {
          const metadataSheet = metadataSheets?.get(schema.gid) || null;
          if (metadataSheets && !metadataSheet)
            throw new Error("sheet_metadata_missing");
          if (metadataSheet && metadataSheet.properties.title !== schema.name)
            throw new Error("sheet_mismatch");
          const protectedBounds = monitoredCells.reduce(
              (bounds, p) => {
                const [col, row] = point(p.cell);
                return {
                  rows: Math.max(bounds.rows, row + 1),
                  columns: Math.max(bounds.columns, col + 1),
                };
              },
              { rows: 0, columns: 0 },
            ),
            gridRows =
              metadataSheet?.properties.gridProperties?.rowCount ||
              Math.max(schema.maxRows || 0, protectedBounds.rows),
            gridColumns =
              metadataSheet?.properties.gridProperties?.columnCount ||
              Math.max(
                doctorColumnIndex(schema.lastColumn) + 1,
                protectedBounds.columns,
              );
          const ordered = monitoredCells
            .map((p) => ({ p, col: point(p.cell)[0], row: point(p.cell)[1] }))
            .sort((a, b) => a.col - b.col || a.row - b.row);
          const chunks = new Map();
          for (const item of ordered) {
            if (item.row >= gridRows || item.col >= gridColumns) continue;
            const start =
                Math.floor(item.row / FAST_RANGE_ROWS) * FAST_RANGE_ROWS,
              key = item.col + ":" + start;
            let chunk = chunks.get(key);
            if (!chunk) {
              chunk = {
                col: item.col,
                start,
                end: Math.min(start + FAST_RANGE_ROWS, gridRows),
                items: [],
              };
              chunks.set(key, chunk);
            }
            chunk.items.push(item);
          }
          const quote = schema.name.replaceAll("'", "''"),
            ranges = [...chunks.values()].map((chunk) => ({
              ...chunk,
              range: `'${quote}'!${letters(chunk.col)}${chunk.start + 1}:${letters(chunk.col)}${chunk.end}`,
            })),
            cellViews = new Map();
          const completeStructureMetadata =
            metadataSheets !== null &&
            !!metadataSheet &&
            Array.isArray(metadataSheet.merges) &&
            Number.isInteger(
              metadataSheet.properties?.gridProperties?.rowCount,
            ) &&
            Number.isInteger(
              metadataSheet.properties?.gridProperties?.columnCount,
            );
          for (let offset = 0; offset < ranges.length; offset += 30) {
            const batch = ranges.slice(offset, offset + 30),
              readStarted = performance.now();
            requestCount++;
            let grid;
            try {
              grid = await reader.grid(
                document.documentId,
                batch.map((range) => range.range),
                signal,
                100,
              );
            } finally {
              rangeReadDurationMs += performance.now() - readStarted;
            }
            if (grid.spreadsheetId !== document.documentId)
              throw new Error("spreadsheet_mismatch");
            const view = gridViews(grid).get(schema.gid);
            if (!view || view.sheet.properties.title !== schema.name)
              throw new Error("sheet_mismatch");
            for (let i = 0; i < batch.length; i++) {
              const chunk = batch[i];
              for (const item of chunk.items)
                cellViews.set(
                  item.p.cell,
                  view.cell(letters(item.col), item.row + 1),
                );
            }
          }
          const exceptions = new Map(
            this.store.db
              .prepare(
                "SELECT * FROM formula_exceptions WHERE source_id=? AND gid=? AND status='active'",
              )
              .all(document.id, schema.gid)
              .map((e) => [e.cell, e]),
          );
          const findings = [],
            nowMs = at.getTime(),
            comparisonStarted = performance.now();
          for (const p of protectedCells) {
            const [col, row] = point(p.cell),
              native = cellViews.get(p.cell) || {},
              observed = native.userEnteredValue || null,
              merge = completeStructureMetadata
                ? mergeAt(metadataSheet, col, row)
                : null,
              exception = exceptions.get(p.cell);
            if (
              exception &&
              exception.version === p.version &&
              exception.evidence === digest([observed, merge]) &&
              Date.parse(exception.expires_at) > nowMs
            ) {
              this.pause(document.id, schema.gid, p.cell, "excepted");
              continue;
            }
            const current = observed?.formulaValue || null,
              structural =
                completeStructureMetadata &&
                (row >= gridRows ||
                  col >= gridColumns ||
                  merge !== p.merge_signature),
              resultError = native.effectiveValue?.errorValue || null,
              calculationError =
                !structural && current === p.formula && !!resultError;
            if (!structural && current === p.formula && !resultError) continue;
            findings.push({
              kind: "table_doctor",
              sourceId: document.id,
              sourceName: document.name,
              department: document.department,
              sheet: schema.name,
              gid: schema.gid,
              cell: p.cell,
              row: row + 1,
              type: structural
                ? "structure_changed"
                : calculationError
                  ? "calculation_error"
                  : current
                    ? "formula_mismatch"
                    : observed?.numberValue !== undefined
                      ? "formula_number"
                      : observed?.stringValue !== undefined
                        ? "formula_text"
                        : "formula_missing",
              severity: structural ? "warning" : "high",
              title: structural
                ? "Изменена структура защищённой ячейки"
                : calculationError
                  ? "Ошибка вычисления при сохранённой формуле"
                  : "Нарушен эталон утверждённой формулы",
              observed: {
                entered: observed,
                merge,
                result: scalar(native),
                error: native.effectiveValue?.errorValue || null,
              },
              expected: calculationError
                ? { formula: p.formula, result: "без ошибки вычисления" }
                : p.formula,
              previousFormula: p.formula,
              cause: structural
                ? "Геометрия объединения ячейки отличается от утверждённого эталона; автоматическое исправление заблокировано."
                : calculationError
                  ? `Сама формула совпадает с эталоном, но Google Sheets вернул ошибку ${resultError.type || "вычисления"}. Причина может быть во входных данных или зависимости; замена эталонной формулы не предлагается.`
                  : "Содержимое ячейки отличается от точной формулы утверждённой версии. Это подтверждает нарушение эталона, но не устанавливает, кто и почему изменил ячейку.",
              impact:
                "Защищённый расчёт может быть искажён. Фактическое влияние на KPI требует проверки зависимых показателей.",
              recommendation: structural
                ? "Проверьте объединение ячеек и повторите глубокий аудит. Запись заблокирована."
                : calculationError
                  ? "Проверьте входные данные, ссылки и контекст ошибки. Формула совпадает с эталоном; автоматическое исправление недоступно."
                  : `Предлагаемая формула восстановления: ${p.formula}. Запись возможна только после отдельного подтверждения владельца.`,
              verification:
                structural || calculationError
                  ? "needs_review"
                  : "rule_confirmed",
              initialStatus:
                structural || calculationError ? "review" : "confirmed",
              category:
                structural || calculationError
                  ? "business_review"
                  : "confirmed_formula",
              sourceUrl: link(document.documentId, schema.gid, p.cell),
              baselineVersion: p.version,
              formulaRegionId: p.region_id,
            });
          }
          for (const p of historicalCells) {
            const native = cellViews.get(p.cell) || {};
            if (native.userEnteredValue?.formulaValue === p.formula) continue;
            findings.push({ kind: "table_doctor", sourceId: document.id, sourceName: document.name,
              department: document.department, sheet: schema.name, gid: schema.gid, cell: p.cell,
              row: point(p.cell)[1] + 1, type: "formula_history_change", severity: "warning",
              title: "Формула изменена относительно сохранённой версии",
              observed: { entered: native.userEnteredValue || null, result: scalar(native) },
              expected: { candidateFormula: p.formula, confidence: "unapproved_history" },
              cause: "Подтверждён факт изменения; прежняя формула требует проверки владельцем.",
              impact: "Влияние на KPI не подтверждено",
              recommendation: "Проверьте прежнюю формулу в предложении восстановления. Запись требует вашего явного разрешения.",
              verification: "needs_review", initialStatus: "review", category: "suspicious",
              sourceUrl: link(document.documentId, schema.gid, p.cell) });
          }
          comparisonDurationMs += performance.now() - comparisonStarted;
          const standaloneFindings = findings.filter(
            (finding) =>
              finding.type !== "calculation_error" ||
              !groupedCalculationErrors.has(schema.gid + ":" + finding.cell),
          );
          this.store.reconcile(
            `doctor:formula:${document.id}:${schema.gid}`,
            standaloneFindings,
            {
              verified: true,
              at: at.toISOString(),
              onlyCells: new Set(monitoredCells.map((p) => p.cell)),
            },
          );
          sheets.push({
            sourceId: document.id,
            document: document.name,
            gid: schema.gid,
            sheet: schema.name,
            status: completeStructureMetadata ? "ok" : "degraded",
            structureMetadata: completeStructureMetadata
              ? "verified"
              : "unavailable",
            errorCode: completeStructureMetadata
              ? null
              : metadataError?.code || "structure_metadata_unavailable",
            checkedCells: protectedCells.length,
            protectedCells: protectedCells.length,
            historicalCheckedCells: historicalCells.length,
            matchingCells: protectedCells.length - findings.filter((f) => f.type !== "formula_history_change").length,
            historicalMatchingCells: historicalCells.length - findings.filter((f) => f.type === "formula_history_change").length,
            violations: standaloneFindings.length,
            groupedCalculationErrors: findings.length - standaloneFindings.length,
            readRequests: requestCount,
            durationMs: Math.round(performance.now() - startedSheet),
            at: at.toISOString(),
          });
        } catch (error) {
          sheets.push({
            sourceId: document.id,
            document: document.name,
            gid: schema.gid,
            sheet: schema.name,
            status: "unavailable",
            checkedCells: 0,
            protectedCells: protectedCells.length,
            matchingCells: null,
            violations: null,
            readRequests: requestCount,
            errorCode:
              typeof error?.code === "string"
                ? error.code
                : error instanceof Error
                  ? error.message.slice(0, 80)
                  : "read_failed",
            durationMs: Math.round(performance.now() - startedSheet),
            at: at.toISOString(),
          });
        }
      }
      documents.push({ sourceId: document.id, name: document.name, sheets });
    }
    const after = reader.telemetry?.() || {},
      durationMs = Math.round(performance.now() - started),
      apiStatuses = Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(before.statuses || {}),
            ...Object.keys(after.statuses || {}),
          ]),
        ]
          .map((status) => [
            status,
            Math.max(
              0,
              (after.statuses?.[status] || 0) -
                (before.statuses?.[status] || 0),
            ),
          ])
          .filter(([, count]) => count > 0),
      ),
      report = {
        at: at.toISOString(),
        status: documents.every((d) => d.sheets.every((s) => s.status === "ok"))
          ? "ok"
          : "partial",
        durationMs,
        readRequests: Math.max(
          0,
          metadataReadRequests +
            documents
              .flatMap((d) => d.sheets)
              .reduce((n, sheet) => n + (sheet.readRequests || 0), 0),
        ),
        apiReadRequests: Math.max(
          0,
          (after.readRequests || 0) - (before.readRequests || 0),
        ),
        oauthRequests: Math.max(
          0,
          (after.oauthRequests || 0) - (before.oauthRequests || 0),
        ),
        apiStatuses,
        dataAcquisitionMs: Math.round(metadataDurationMs + rangeReadDurationMs),
        metadataReadMs: Math.round(metadataDurationMs),
        rangeReadMs: Math.round(rangeReadDurationMs),
        comparisonMs: Math.round(comparisonDurationMs),
        otherProcessingMs: Math.max(
          0,
          durationMs -
            Math.round(metadataDurationMs + rangeReadDurationMs) -
            Math.round(comparisonDurationMs),
        ),
        retries: Math.max(0, (after.retries || 0) - (before.retries || 0)),
        responseBytes: Math.max(
          0,
          (after.responseBytes || 0) - (before.responseBytes || 0),
        ),
        checkedCells: documents
          .flatMap((d) => d.sheets)
          .reduce((n, s) => n + (s.checkedCells || 0), 0),
        protectedCells: documents
          .flatMap((d) => d.sheets)
          .reduce((n, s) => n + (s.protectedCells || 0), 0),
        historicalCheckedCells: documents.flatMap((d) => d.sheets).reduce((n, s) => n + (s.historicalCheckedCells || 0), 0),
        violations: documents
          .flatMap((d) => d.sheets)
          .reduce((n, s) => n + (s.violations || 0), 0),
        documents,
      };
    this.store.snapshot("formula-fast-check", report, at.toISOString());
    return report;
  }
  state() {
    const checks = this.store.overview().checks,
      documents = this.config.doctorDocuments.filter(
        (d) => d.enabled && d.adapter === "google",
      );
    const available = new Set(
      documents.flatMap((d) => d.sheets.map((s) => d.id + ":" + s.gid)),
    );
    const metrics = documents.flatMap((d) =>
      (this.store.getSnapshot("formula-metrics:" + d.id)?.value || []).map(
        (m) => ({
          ...m,
          stale:
            checks.find((c) => c.id === d.id)?.status !== "ok" ||
            checks.find((c) => c.id === d.id)?.at !== m.at ||
            this.now().getTime() - Date.parse(m.at) >
              this.config.snapshotMaxAgeMs,
        }),
      ),
    );
    const regions = this.store.db
      .prepare("SELECT * FROM formula_regions ORDER BY source_id,gid,id")
      .all()
      .filter((r) => available.has(r.source_id + ":" + r.gid))
      .map((r) => {
        const p = JSON.parse(r.payload),
          metric = metrics.find(
            (m) => m.sourceId === r.source_id && m.gid === r.gid,
          );
        return {
          ...p,
          at: r.at,
          stale: !p.current || !metric || metric.stale || metric.at !== r.at,
        };
      });
    return {
      fastCheck: this.store.getSnapshot("formula-fast-check")?.value || null,
      metrics,
      regions,
      productionWritesEnabled: !!this.config.productionRepairEnabled,
      exceptions: this.store.db
        .prepare(
          "SELECT id,source_id AS sourceId,gid,cell,reason,expires_at AS expiresAt,status FROM formula_exceptions ORDER BY expires_at DESC LIMIT 200",
        )
        .all(),
      decisions: this.store.db
        .prepare(
          "SELECT id,at,action FROM formula_decisions ORDER BY id DESC LIMIT 20",
        )
        .all(),
    };
  }
  region(id, version, { page = 0, search = "", size = 20 } = {}) {
    if (![10, 20, 50].includes(size)) size = 20;
    const head = this.store.db
      .prepare("SELECT * FROM formula_regions WHERE id=?")
      .get(id);
    if (
      !head ||
      !this.activeDocument(head.source_id)?.sheets.some(
        (s) => s.gid === head.gid,
      )
    )
      throw new FormulaDecisionError("Область вне мониторинга", 404);
    const stored = this.store.db
      .prepare("SELECT * FROM formula_versions WHERE region_id=? AND version=?")
      .get(id, version);
    if (!stored) throw new FormulaDecisionError("Версия не найдена", 404);
    const area = unpack(stored.payload),
      filtered = area.cells.filter(
        ([cell, f]) =>
          !search ||
          (cell + " " + f)
            .toLocaleLowerCase()
            .includes(search.toLocaleLowerCase()),
      );
    const { cells: ignored, ...summary } = area;
    return {
      ...summary,
      version,
      at: stored.at,
      total: filtered.length,
      cells: filtered
        .slice(page * size, (page + 1) * size)
        .map(([cell, formula, merge]) => ({
          cell,
          formula,
          merge,
          url: link(area.documentId, area.gid, cell),
        })),
      history: this.store.db
        .prepare(
          "SELECT version,at FROM formula_versions WHERE region_id=? ORDER BY at DESC LIMIT 20",
        )
        .all(id),
    };
  }
  _buildProtectionReport() {
    const state = this.state(),
      metrics = new Map(
        state.metrics.map((m) => [m.sourceId + ":" + m.gid, m]),
      ),
      openCells = new Set(),
      protectedBySheet = new Map(),
      activeExceptions = new Map(),
      manualReviewSamples = new Map();
    for (const row of this.store.db
      .prepare(
        "SELECT source_id,gid,cell,formula,merge_signature,region_id,version FROM formula_protected",
      )
      .all()) {
      const key = row.source_id + ":" + row.gid;
      const rows = protectedBySheet.get(key) || new Map();
      rows.set(row.cell, row);
      protectedBySheet.set(key, rows);
    }
    for (const row of this.store.db
      .prepare(
        "SELECT source_id,gid,cell,version,evidence,expires_at FROM formula_exceptions WHERE status='active'",
      )
      .all())
      activeExceptions.set(row.source_id + ":" + row.gid + ":" + row.cell, row);
    for (const row of this.store.db
      .prepare(
        "SELECT payload FROM incidents WHERE scope LIKE 'doctor:formula:%' AND status='open'",
      )
      .all()) {
      try {
        const finding = JSON.parse(row.payload),
          doc = this.activeDocument(finding.sourceId),
          schema = doc?.sheets.find((s) => s.name === finding.sheet),
          gid = Number.isInteger(finding.gid) ? finding.gid : schema?.gid;
        if (finding.sourceId && Number.isInteger(gid) && finding.cell)
          openCells.add(finding.sourceId + ":" + gid + ":" + finding.cell);
      } catch {
        // A malformed legacy incident is not trusted as approval evidence.
      }
    }
    const sheets = [];
    for (const document of this.config.doctorDocuments.filter(
      (d) => d.enabled && d.adapter === "google",
    ))
      for (const schema of document.sheets) {
        const metric = metrics.get(document.id + ":" + schema.gid);
        sheets.push({
          sourceId: document.id,
          document: document.name,
          gid: schema.gid,
          sheet: schema.name,
          at: metric?.at || null,
          stale: !metric || metric.stale || !metric.fullSheetRead,
          fullSheetRead: !!metric?.fullSheetRead,
          formulasRead: metric?.formulasRead ?? null,
          protectedCells: metric?.protectedCells ?? 0,
          protectedNow: metric?.protectedFormulasRead ?? 0,
          protectable: 0,
          review: 0,
          excluded: metric?.mergeInteriorFormulas || 0,
          knownDamage: metric?.damage || 0,
          manualValuesObserved: 0,
          coverageNow: metric?.protectedPercent ?? null,
          coverageAfterApproval: null,
          reasons: [],
        });
      }
    const sheetRows = new Map(sheets.map((s) => [s.sourceId + ":" + s.gid, s])),
      safeRegions = [],
      reviewRegions = [];
    for (const region of state.regions) {
      if (!region.current) continue;
      const key = region.sourceId + ":" + region.gid,
        result = sheetRows.get(key),
        metric = metrics.get(key),
        head = this.store.db
          .prepare("SELECT version,at,payload FROM formula_regions WHERE id=?")
          .get(region.id),
        stored = this.store.db
          .prepare("SELECT payload FROM formula_versions WHERE version=?")
          .get(region.version);
      if (!result || !head || !stored) continue;
      const area = unpack(stored.payload),
        protectedMap = protectedBySheet.get(key) || new Map(),
        candidates = [],
        conflicts = [],
        reasons = new Set(),
        exceptionCells = [];
      for (const sample of area.manualSamples || []) {
        const sampleKey = key + ":" + sample.cell;
        if (!manualReviewSamples.has(sampleKey))
          manualReviewSamples.set(sampleKey, {
            sourceId: region.sourceId,
            document: region.document,
            gid: region.gid,
            sheet: region.sheet,
            cell: sample.cell,
            value: sample.value,
            url: sample.url,
            range: region.range,
            formulaCells: area.count,
            sampleFormula: area.cells[0]?.[1] || "",
            manualSignature: area.manualSignature || null,
          });
      }
      const fresh =
        !region.stale &&
        !!metric &&
        !metric.stale &&
        metric.fullSheetRead === true &&
        metric.at === head.at &&
        head.version === region.version;
      if (!fresh) reasons.add("stale_snapshot");
      if (area.kind !== "typical" || area.count < 2)
        reasons.add("individual_formula");
      const mergeShapes = new Set();
      let mergedCount = 0;
      const currentErrors = new Map(
        (region.diagnosticErrors || []).map((error) => [error.cell, error]),
      );
      for (const [cell, formula, merge] of area.cells) {
        const diagnostic = currentErrors.get(cell),
          errorType = diagnostic?.errorType,
          rowHasInputs = diagnostic?.rowHasInputs;
        const baseline = protectedMap.get(cell),
          exception = activeExceptions.get(key + ":" + cell),
          exceptionMatches =
            exception &&
            baseline &&
            exception.version === baseline.version &&
            exception.evidence === digest([{ formulaValue: formula }, merge]) &&
            Date.parse(exception.expires_at) > this.now().getTime();
        if (merge) {
          mergedCount++;
          try {
            const [startRow, endRow, startColumn, endColumn] =
              JSON.parse(merge);
            mergeShapes.add(
              JSON.stringify([endRow - startRow, endColumn - startColumn]),
            );
          } catch {
            reasons.add("invalid_merge_metadata");
          }
        }
        if (formula.includes("#REF!")) reasons.add("invalid_reference_token");
        if (errorType && !(errorType === "N_A" && rowHasInputs === false))
          reasons.add("formula_result_error");
        if (openCells.has(key + ":" + cell)) reasons.add("open_incident");
        if (baseline) {
          if (
            baseline.formula !== formula ||
            baseline.merge_signature !== merge
          )
            conflicts.push(cell);
          if (exceptionMatches) exceptionCells.push(cell);
        } else {
          candidates.push([cell, formula, merge]);
        }
      }
      if (conflicts.length) reasons.add("approved_baseline_changed");
      if (
        mergedCount > 0 &&
        (mergedCount !== area.cells.length || mergeShapes.size !== 1)
      )
        reasons.add("mixed_merge_layout");
      for (const [cell] of candidates)
        if (activeExceptions.has(key + ":" + cell)) exceptionCells.push(cell);
      const excludedCandidates = new Set(exceptionCells);
      const available = candidates.filter(
        ([cell]) => !excludedCandidates.has(cell),
      );
      result.manualValuesObserved += area.manual || 0;
      if (reasons.size && (available.length || conflicts.length)) {
        result.review += available.length + conflicts.length;
        result.reasons.push(...reasons);
        reviewRegions.push({
          id: region.id,
          version: region.version,
          at: region.at,
          sourceId: region.sourceId,
          document: region.document,
          gid: region.gid,
          sheet: region.sheet,
          range: region.range,
          formulaCells: area.count,
          newCells: available.length,
          protected: area.protected || 0,
          changedProtected: conflicts.length,
          kind: region.kind,
          reasons: [...reasons],
          sampleFormula: available[0]?.[1] || area.cells[0]?.[1] || "",
          manual: area.manual || 0,
          merged: mergedCount,
          manualSamples: area.manualSamples || [],
          manualSignature: area.manualSignature || null,
          diagnosticSignature: area.diagnosticSignature || null,
          m11: area.cells.find(([cell]) => cell === "M11")?.[1] || null,
        });
      } else if (available.length && reasons.size === 0) {
        result.protectable += available.length;
        safeRegions.push({
          id: region.id,
          version: region.version,
          at: region.at,
          sourceId: region.sourceId,
          document: region.document,
          gid: region.gid,
          sheet: region.sheet,
          range: region.range,
          formulaCells: area.count,
          newCells: available.length,
          alreadyProtected: area.protected || 0,
          manual: area.manual || 0,
          merged: area.merged || 0,
          manualSamples: area.manualSamples || [],
          manualSignature: area.manualSignature || null,
          diagnosticSignature: area.diagnosticSignature || null,
          sampleFormula: available[0]?.[1] || "",
          includesM11: area.cells.some(([cell]) => cell === "M11"),
          m11: area.cells.find(([cell]) => cell === "M11")?.[1] || null,
        });
      }
      result.excluded += excludedCandidates.size;
    }
    for (const row of sheets) {
      if (row.formulasRead === null) continue;
      const classified =
        row.protectedNow + row.protectable + row.review + row.excluded;
      if (classified < row.formulasRead)
        row.review += row.formulasRead - classified;
      row.reasons = [...new Set(row.reasons)];
      row.coverageAfterApproval = row.formulasRead
        ? Math.round(
            (10000 * (row.protectedNow + row.protectable)) / row.formulasRead,
          ) / 100
        : null;
    }
    const totals = sheets.reduce(
      (sum, row) => {
        if (row.formulasRead !== null) {
          sum.formulasRead += row.formulasRead;
          sum.protectedNow += row.protectedNow;
          sum.protectable += row.protectable;
          sum.review += row.review;
          sum.excluded += row.excluded;
          sum.knownDamage += row.knownDamage;
          sum.staleSheets += row.stale ? 1 : 0;
        } else sum.staleSheets++;
        return sum;
      },
      {
        formulasRead: 0,
        protectedNow: 0,
        protectable: 0,
        review: 0,
        excluded: 0,
        knownDamage: 0,
        staleSheets: 0,
      },
    );
    totals.coverageNow = totals.formulasRead
      ? Math.round((10000 * totals.protectedNow) / totals.formulasRead) / 100
      : null;
    totals.coverageAfterApproval = totals.formulasRead
      ? Math.round(
          (10000 * (totals.protectedNow + totals.protectable)) /
            totals.formulasRead,
        ) / 100
      : null;
    const manifest = {
      sheets: sheets.map((row) => [
        row.sourceId,
        row.gid,
        row.formulasRead,
        row.fullSheetRead,
      ]),
      regions: state.regions
        .filter((region) => region.current)
        .map((region) => [
          region.id,
          region.version,
          region.manualSignature || null,
          region.diagnosticSignature || null,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    };
    const manualSamples = [...manualReviewSamples.values()];
    const formulaM11 = [...safeRegions, ...reviewRegions]
      .filter((region) => region.m11)
      .map((region) => ({
        sourceId: region.sourceId,
        document: region.document,
        sheet: region.sheet,
        gid: region.gid,
        cell: "M11",
        formula: region.m11,
        status: safeRegions.includes(region) ? "protectable" : "review",
        reasons: region.reasons || [],
      }));
    for (const sample of manualSamples.filter((entry) => entry.cell === "M11"))
      formulaM11.push({
        sourceId: sample.sourceId,
        document: sample.document,
        sheet: sample.sheet,
        gid: sample.gid,
        cell: "M11",
        formula: null,
        currentValue: sample.value,
        formulaExample: sample.sampleFormula,
        range: sample.range,
        url: sample.url,
        status: "manual_value_unprotected",
        reasons: ["manual_value_inside_formula_area", "no_exact_baseline"],
      });
    return {
      generatedAt: this.now().toISOString(),
      sheets,
      totals,
      safeRegions,
      reviewRegions,
      manifest,
      manualSamples,
      m11: formulaM11,
    };
  }
  prepareProtection() {
    const built = this._buildProtectionReport(),
      id = randomUUID(),
      at = this.now().toISOString(),
      expiresAt = new Date(this.now().getTime() + 30 * 60 * 1000).toISOString(),
      manifest = built.manifest;
    const report = { ...built };
    delete report.manifest;
    this.store.db
      .prepare(
        "INSERT INTO formula_protection_previews(id,at,expires_at,manifest,report,status) VALUES(?,?,?,?,?,'prepared')",
      )
      .run(id, at, expiresAt, JSON.stringify(manifest), JSON.stringify(report));
    return { ...report, previewId: id, expiresAt };
  }
  approveProtectionPreview({ previewId, acknowledged }) {
    if (
      acknowledged !== true ||
      typeof previewId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(previewId)
    )
      throw new FormulaDecisionError(
        "Требуется подтверждение владельца и актуальный preview",
        400,
      );
    const preview = this.store.db
      .prepare("SELECT * FROM formula_protection_previews WHERE id=?")
      .get(previewId);
    if (
      !preview ||
      preview.status !== "prepared" ||
      Date.parse(preview.expires_at) <= this.now().getTime()
    )
      throw new FormulaDecisionError(
        "Предварительный отчёт отсутствует или устарел. Подготовьте новый.",
      );
    const current = this._buildProtectionReport();
    if (current.totals.staleSheets > 0)
      throw new FormulaDecisionError(
        "Не все листы удалось перечитать. Подготовьте новый preview после успешного сканирования.",
      );
    if (digest(current.manifest) !== digest(JSON.parse(preview.manifest)))
      throw new FormulaDecisionError(
        "Снимок изменился после предварительного просмотра. Обновите отчёт.",
      );
    const selected = current.safeRegions;
    if (!selected.length)
      throw new FormulaDecisionError(
        "Нет свежих безопасных областей для защиты.",
      );
    let approvedCells = 0,
      unchangedCells = 0;
    const approvedByRegion = new Map(),
      approvedBySheet = new Map();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.store.db.prepare(
          "INSERT INTO formula_protected(source_id,gid,cell,formula,merge_signature,region_id,version) VALUES(?,?,?,?,?,?,?)",
        ),
        get = this.store.db.prepare(
          "SELECT formula,merge_signature FROM formula_protected WHERE source_id=? AND gid=? AND cell=?",
        );
      for (const region of selected) {
        const head = this.store.db
            .prepare(
              "SELECT version,at,payload FROM formula_regions WHERE id=?",
            )
            .get(region.id),
          stored = this.store.db
            .prepare("SELECT payload FROM formula_versions WHERE version=?")
            .get(region.version);
        if (
          !head ||
          !stored ||
          head.version !== region.version ||
          head.at !== region.at ||
          !JSON.parse(head.payload).current
        )
          throw new FormulaDecisionError(
            "Область изменилась во время утверждения. Защита отменена.",
          );
        const area = unpack(stored.payload);
        for (const [cell, formula, merge] of area.cells) {
          const old = get.get(region.sourceId, region.gid, cell);
          if (old) {
            if (old.formula !== formula || old.merge_signature !== merge)
              throw new FormulaDecisionError(
                "Обнаружен действующий эталон с другим содержимым. Массовая защита отменена.",
              );
            unchangedCells++;
            continue;
          }
          insert.run(
            region.sourceId,
            region.gid,
            cell,
            formula,
            merge,
            region.id,
            region.version,
          );
          approvedCells++;
          approvedByRegion.set(
            region.id,
            (approvedByRegion.get(region.id) || 0) + 1,
          );
          const sheetKey = JSON.stringify([region.sourceId, region.gid]);
          approvedBySheet.set(
            sheetKey,
            (approvedBySheet.get(sheetKey) || 0) + 1,
          );
        }
      }
      for (const region of selected) {
        const count = approvedByRegion.get(region.id) || 0;
        if (!count) continue;
        const row = this.store.db
          .prepare("SELECT payload FROM formula_regions WHERE id=?")
          .get(region.id);
        if (row) {
          const summary = JSON.parse(row.payload);
          summary.protected = (summary.protected || 0) + count;
          summary.unprotected = Math.max(0, (summary.unprotected || 0) - count);
          this.store.db
            .prepare("UPDATE formula_regions SET payload=? WHERE id=?")
            .run(JSON.stringify(summary), region.id);
        }
      }
      for (const [key, count] of approvedBySheet) {
        const [sourceId, gid] = JSON.parse(key);
        const snapshot = this.store.getSnapshot("formula-metrics:" + sourceId);
        if (!snapshot) continue;
        let changed = false;
        const updated = snapshot.value.map((metric) => {
          if (metric.gid !== gid) return metric;
          changed = true;
          const protectedFormulasRead = metric.protectedFormulasRead + count,
            formulasRead = metric.formulasRead;
          return {
            ...metric,
            protectedCells: metric.protectedCells + count,
            checkedCells: metric.checkedCells + count,
            protectedFormulasRead,
            unprotectedFormulas: Math.max(
              0,
              metric.unprotectedFormulas - count,
            ),
            protectedPercent: formulasRead
              ? Math.round((10000 * protectedFormulasRead) / formulasRead) / 100
              : null,
          };
        });
        if (changed)
          this.store.snapshot(
            "formula-metrics:" + sourceId,
            updated,
            snapshot.at,
          );
      }
      this.store.db
        .prepare(
          "INSERT INTO formula_decisions(at,action,payload) VALUES(?,'mass_protection_approve',?)",
        )
        .run(
          this.now().toISOString(),
          JSON.stringify({
            actor: "owner",
            previewId,
            regions: selected.map((r) => ({ id: r.id, version: r.version })),
            approvedCells,
            unchangedCells,
            permission: "diagnosis_only",
          }),
        );
      this.store.db
        .prepare(
          "UPDATE formula_protection_previews SET status='approved' WHERE id=? AND status='prepared'",
        )
        .run(previewId);
      this.store.log(
        "formula_mass_protection_approved",
        `Владелец включил контроль точных эталонов: ${approvedCells} новых ячеек в ${selected.length} безопасных областях. Запись в Google Sheets не выполнялась.`,
        null,
        this.now().toISOString(),
      );
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    return {
      ok: true,
      approvedCells,
      unchangedCells,
      approvedRegions: selected.length,
      message: `Защита включена для ${approvedCells} новых точных эталонов. Google Sheets не изменялись.`,
    };
  }
  approve({ regions, acknowledged }) {
    if (
      acknowledged !== true ||
      !Array.isArray(regions) ||
      !regions.length ||
      regions.length > 50 ||
      regions.some((r) => !r || typeof r !== "object" || Array.isArray(r)) ||
      new Set(regions.map((r) => r.id)).size !== regions.length
    )
      throw new FormulaDecisionError(
        "Подтвердите просмотр 1–50 выбранных областей",
        400,
      );
    const at = this.now().toISOString(),
      selected = [],
      metrics = this.state().metrics;
    for (const request of regions) {
      if (
        !request ||
        !/^[a-f0-9]{64}$/.test(request.id || "") ||
        !/^[a-f0-9]{64}$/.test(request.version || "") ||
        Object.keys(request).some((k) => !["id", "version"].includes(k))
      )
        throw new FormulaDecisionError("Подмена адреса запрещена", 400);
      const head = this.store.db
        .prepare("SELECT * FROM formula_regions WHERE id=?")
        .get(request.id);
      const metric = metrics.find(
        (m) => m.sourceId === head?.source_id && m.gid === head?.gid,
      );
      if (
        !head ||
        !JSON.parse(head.payload).current ||
        head.version !== request.version ||
        !metric ||
        metric.stale ||
        metric.at !== head.at
      )
        throw new FormulaDecisionError(
          "Снимок изменился или устарел. Обновите проверку и просмотрите новую версию",
        );
      const doc = this.activeDocument(head.source_id);
      if (!doc?.sheets.some((s) => s.gid === head.gid))
        throw new FormulaDecisionError("Лист вне мониторинга", 403);
      const area = unpack(
        this.store.db
          .prepare("SELECT payload FROM formula_versions WHERE version=?")
          .get(head.version).payload,
      );
      selected.push({ head, area });
    }
    let approvedCells = 0;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const put = this.store.db.prepare(
        "INSERT INTO formula_protected VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,gid,cell) DO UPDATE SET formula=excluded.formula,merge_signature=excluded.merge_signature,region_id=excluded.region_id,version=excluded.version",
      );
      const get = this.store.db.prepare(
        "SELECT * FROM formula_protected WHERE source_id=? AND gid=? AND cell=?",
      );
      const historyCells = new Set(
        this.store.db
          .prepare(
            "SELECT payload FROM incidents WHERE scope LIKE 'doctor:formula:%' AND status='open'",
          )
          .all()
          .map((r) => {
            const p = JSON.parse(r.payload);
            return p.sourceId + ":" + p.sheet + ":" + p.cell;
          }),
      );
      for (const { head, area } of selected) {
        for (const [cell, formula, merge] of area.cells) {
          const old = get.get(head.source_id, head.gid, cell);
          if (
            historyCells.has(head.source_id + ":" + area.sheet + ":" + cell) ||
            (old && (old.formula !== formula || old.merge_signature !== merge))
          )
            this.pause(head.source_id, head.gid, cell);
          put.run(
            head.source_id,
            head.gid,
            cell,
            formula,
            merge,
            head.id,
            head.version,
          );
          approvedCells++;
        }
      }
      this.store.db
        .prepare(
          "INSERT INTO formula_decisions(at,action,payload) VALUES(?,'approve',?)",
        )
        .run(
          at,
          JSON.stringify({
            actor: "owner",
            regions,
            approvedCells,
            permission: "diagnosis_only",
          }),
        );
      this.store.log(
        "formula_areas_approved",
        `Владелец утвердил областей: ${regions.length}; формульных ячеек: ${approvedCells}. Запись Google Sheets не разрешена`,
        null,
        at,
      );
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    return {
      ok: true,
      approvedCells,
      message:
        "Эталоны сохранены. Реальное покрытие обновится после следующей проверки",
    };
  }
  revoke({ id, reason }) {
    if (
      !/^[a-f0-9]{64}$/.test(id || "") ||
      typeof reason !== "string" ||
      reason.trim().length < 5 ||
      reason.length > 1000
    )
      throw new FormulaDecisionError("Укажите область и причину отмены", 400);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of this.store.db
        .prepare("SELECT * FROM formula_protected WHERE region_id=?")
        .all(id))
        this.pause(p.source_id, p.gid, p.cell);
      this.store.db
        .prepare("DELETE FROM formula_protected WHERE region_id=?")
        .run(id);
      this.store.db
        .prepare(
          "INSERT INTO formula_decisions(at,action,payload) VALUES(?,'revoke',?)",
        )
        .run(
          this.now().toISOString(),
          JSON.stringify({ id, reason, actor: "owner" }),
        );
      this.store.log(
        "formula_areas_revoked",
        "Владелец отменил защиту области: " + reason.trim(),
      );
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    return { ok: true };
  }
  addException({ incidentId, reason, expiresAt }) {
    if (
      !/^[a-f0-9]{64}$/.test(incidentId || "") ||
      typeof reason !== "string" ||
      reason.trim().length < 5 ||
      reason.length > 1000 ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= this.now().getTime() ||
      Date.parse(expiresAt) > this.now().getTime() + 90 * 86400000
    )
      throw new FormulaDecisionError(
        "Нужны конкретный инцидент, причина и срок до 90 дней",
        400,
      );
    const row = this.store.db
      .prepare(
        "SELECT * FROM incidents WHERE id=? AND status='open' AND scope LIKE 'doctor:formula:%'",
      )
      .get(incidentId);
    if (!row)
      throw new FormulaDecisionError("Активный инцидент не найден", 404);
    const p = JSON.parse(row.payload),
      doc = this.activeDocument(p.sourceId),
      gid = doc?.sheets.find((s) => s.name === p.sheet)?.gid;
    const metric = this.state().metrics.find(
      (m) => m.sourceId === p.sourceId && m.gid === gid,
    );
    const baseline = this.store.db
      .prepare(
        "SELECT * FROM formula_protected WHERE source_id=? AND gid=? AND cell=?",
      )
      .get(p.sourceId, gid ?? -1, p.cell);
    if (
      !metric ||
      metric.stale ||
      !baseline ||
      baseline.version !== p.baselineVersion ||
      row.last_seen !== metric.at
    )
      throw new FormulaDecisionError(
        "Доказательства устарели; повторите проверку",
      );
    const evidence = digest([p.observed.entered, p.observed.merge || null]),
      id = digest([p.sourceId, gid, p.cell, baseline.version, evidence]);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare(
          "INSERT INTO formula_exceptions VALUES(?,?,?,?,?,?,?,?,'active') ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at,reason=excluded.reason,status='active'",
        )
        .run(
          id,
          p.sourceId,
          gid,
          p.cell,
          baseline.version,
          evidence,
          expiresAt,
          reason.trim(),
        );
      this.pause(p.sourceId, gid, p.cell, "excepted");
      this.store.log(
        "formula_exception_added",
        p.sheet + "!" + p.cell + " · " + reason.trim(),
      );
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    return { ok: true, id };
  }
  revokeException(id) {
    if (!/^[a-f0-9]{64}$/.test(id || ""))
      throw new FormulaDecisionError("Неизвестное исключение", 400);
    this.store.db
      .prepare("UPDATE formula_exceptions SET status='revoked' WHERE id=?")
      .run(id);
    this.store.log(
      "formula_exception_revoked",
      "Владелец отменил точечное исключение",
    );
    return { ok: true };
  }
}
