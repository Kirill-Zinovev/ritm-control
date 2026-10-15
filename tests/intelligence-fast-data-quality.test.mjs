import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../agent/config.js";
import { TableDoctor } from "../agent/doctorService.js";
import { PRODUCTION_DOCTOR_DOCUMENTS } from "../agent/productionRegistry.js";
import { IncidentStore } from "../agent/store.js";

const document = structuredClone(
  PRODUCTION_DOCTOR_DOCUMENTS.find((item) => item.id === "doctor-shop-one"),
);

function columnIndex(letters) {
  return (
    [...letters].reduce(
      (number, letter) => number * 26 + letter.charCodeAt(0) - 64,
      0,
    ) - 1
  );
}

function columnLetters(index) {
  let result = "";
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}

function cell(value, effective = value) {
  return {
    ...(value ? { userEnteredValue: value } : {}),
    ...(effective ? { effectiveValue: effective } : {}),
  };
}

function fixture(restored) {
  const production = new Map(),
    catalog = new Map();
  for (const row of [27, 28]) {
    production.set(`A${row}`, cell({ stringValue: "SKU-1" }));
    production.set(`AA${row}`, cell({ numberValue: row === 27 ? 5 : 3 }));
    for (const [column, formula] of [
      ["B", `='${document.sheets[1].name}'!P5`],
      ["C", `=B${row}*1`],
      ["AP", `=C${row}*1`],
    ]) {
      const result = restored
        ? { numberValue: 2 }
        : { errorValue: { type: "N_A", message: "Missing product kind" } };
      production.set(
        `${column}${row}`,
        cell({ formulaValue: formula }, result),
      );
    }
  }
  catalog.set("A5", cell({ stringValue: "SKU-1" }));
  if (restored) catalog.set("P5", cell({ stringValue: "Коробка" }));
  return new Map([
    [document.sheets[0].gid, production],
    [document.sheets[1].gid, catalog],
  ]);
}

function makeReader() {
  let values = fixture(false),
    failGrid = false;
  const definitions = document.dataQuality.flatMap((rule) => [
    {
      gid: rule.production.gid,
      name: document.sheets[0].name,
      rows: 28,
      columns: 50,
    },
    { gid: rule.source.gid, name: rule.source.sheet, rows: 5, columns: 26 },
  ]);
  let readRequests = 0;
  return {
    writes: 0,
    telemetry: () => ({ readRequests, statuses: { 200: readRequests } }),
    metadata: async (id) => {
      readRequests++;
      return {
        spreadsheetId: id,
        sheets: definitions.map((sheet) => ({
          properties: {
            sheetId: sheet.gid,
            title: sheet.name,
            gridProperties: {
              rowCount: sheet.rows,
              columnCount: sheet.columns,
            },
          },
          merges: [],
        })),
      };
    },
    grid: async (id, ranges) => {
      readRequests++;
      if (failGrid) throw new Error("synthetic_read_failure");
      const data = ranges.map((range) => {
        const match = range.match(/^'(.+)'!([A-Z]+)1:\2(\d+)$/);
        assert.ok(match, range);
        const [, sheetName, column, rowText] = match,
          definition = definitions.find((sheet) => sheet.name === sheetName),
          rows = Number(rowText),
          columnNumber = columnIndex(column),
          cells = values.get(definition.gid);
        return {
          startRow: 0,
          startColumn: columnNumber,
          rowData: Array.from({ length: rows }, (_, row) => ({
            values: [cells.get(column + (row + 1)) || {}],
          })),
        };
      });
      const firstName = ranges[0].match(/^'(.+)'!/)[1],
        definition = definitions.find((sheet) => sheet.name === firstName);
      return {
        spreadsheetId: id,
        sheets: [
          {
            properties: {
              sheetId: definition.gid,
              title: definition.name,
              gridProperties: {
                rowCount: definition.rows,
                columnCount: definition.columns,
              },
            },
            data,
          },
        ],
      };
    },
    setRestored(value) {
      values = fixture(value);
    },
    failGrid(value) {
      failGrid = value;
    },
  };
}

function setup(reader) {
  const store = new IncidentStore(":memory:"),
    config = {
      ...loadConfig({
        RITM_OWNER_TOKEN: randomBytes(32).toString("hex"),
      }),
      doctorDocuments: [document],
    },
    doctor = new TableDoctor(store, config, { reader });
  return { store, doctor };
}

test("legacy external registry without dependencyColumns still reads B/C and resolves the root", async () => {
  const previous = document.dataQuality[0].production.dependencyColumns;
  delete document.dataQuality[0].production.dependencyColumns;
  const reader = makeReader(), { store, doctor } = setup(reader);
  try {
    const result = await doctor.runFast();
    assert.equal(result.dataQuality.status, "ok");
    assert.equal(result.dataQuality.findings, 1);
    assert.equal(store.listIncidents({ status: "active" }).rows[0].cell, "P5");
    assert.equal(reader.writes, 0);
  } finally { document.dataQuality[0].production.dependencyColumns = previous; store.close(); }
});

test("fast checks use a 1s serialized Sheets pacing default and preserve overrides", () => {
  assert.equal(
    loadConfig({ RITM_OWNER_TOKEN: randomBytes(32).toString("hex") })
      .googleMinIntervalMs,
    1000,
  );
  assert.equal(
    loadConfig({
      RITM_OWNER_TOKEN: randomBytes(32).toString("hex"),
      RITM_GOOGLE_MIN_INTERVAL_MS: "2000",
    }).googleMinIntervalMs,
    2000,
  );
});

test("fast source scan opens one root incident, then closes it after a verified recovery", async () => {
  const reader = makeReader(),
    { store, doctor } = setup(reader);
  try {
    const missing = await doctor.runFast(),
      active = store.listIncidents({ status: "active" });
    assert.equal(missing.status, "ok", JSON.stringify(missing.dataQuality));
    assert.equal(missing.dataQuality.status, "ok");
    assert.equal(missing.dataQuality.findings, 1);
    assert.equal(active.total, 1);
    assert.equal(active.rows[0].cell, "P5");
    assert.deepEqual(
      active.rows[0].errorCells.map((item) => item.cell),
      ["B27", "B28", "C27", "C28", "AP27", "AP28"].sort(),
    );
    assert.equal(missing.dataQuality.readRequests, 3);
    assert.equal(
      missing.readRequests,
      3,
      "cached metadata avoids a repeat API read",
    );
    assert.equal(missing.readRequests, missing.apiReadRequests);

    reader.setRestored(true);
    const recovered = await doctor.runFast(),
      closed = store.getIncident(active.rows[0].id);
    assert.equal(recovered.dataQuality.status, "ok");
    assert.equal(recovered.dataQuality.findings, 0);
    assert.equal(store.listIncidents({ status: "active" }).total, 0);
    assert.equal(closed.monitorStatus, "resolved");
    assert.match(closed.resolutionCause, /зависимых расчётов/);
    assert.equal(
      closed.resolutionEvidence.kind,
      "google_sheets_fast_dependency_ranges_read_only",
    );
    assert.equal(reader.writes, 0);
  } finally {
    store.close();
  }
});

test("a failed fast read leaves an existing data-quality incident open", async () => {
  const reader = makeReader(),
    { store, doctor } = setup(reader);
  try {
    await doctor.runFast();
    const active = store.listIncidents({ status: "active" });
    reader.setRestored(true);
    reader.failGrid(true);
    const unavailable = await doctor.runFast();
    assert.equal(unavailable.status, "partial");
    assert.equal(unavailable.dataQuality.status, "partial");
    assert.equal(store.listIncidents({ status: "active" }).total, 1);
    assert.equal(store.getIncident(active.rows[0].id).monitorStatus, "open");
    assert.equal(reader.writes, 0);
  } finally {
    store.close();
  }
});
