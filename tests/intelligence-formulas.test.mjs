import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { IncidentStore } from "../agent/store.js";
import {
  FormulaIntelligence,
  discoverFormulaSheet,
  formulaFamily,
} from "../agent/formulaIntelligence.js";
import { createAgentServer } from "../agent/server.js";
import { loadConfig } from "../agent/config.js";
import { readDoctorSheet } from "../agent/doctorRead.js";
import { TableDoctor } from "../agent/doctorService.js";
const date = new Date("2026-10-10T07:30:00Z");
const document = {
  id: "fixture-real-adapter",
  documentId: "synthetic_document_123456789",
  name: "ТЕСТ: синтетические данные",
  department: "ТЕСТ",
  adapter: "google",
  enabled: true,
  sheets: [{ gid: 7, name: "Тест", maxRows: 1000, lastColumn: "M", rules: [] }],
};
function grid(entries = [["M11", "=C11/D11"]], merges = [], rowCount = 1000) {
  const data = entries.map(([address, value, error]) => {
    const [, col, row] = address.match(/^([A-Z]+)(\d+)$/);
    let c = 0;
    for (const letter of col) c = c * 26 + letter.charCodeAt(0) - 64;
    const entered =
      typeof value === "number"
        ? { numberValue: value }
        : value?.startsWith("=")
          ? { formulaValue: value }
          : value === null
            ? undefined
            : { stringValue: value };
    return {
      startRow: +row - 1,
      startColumn: c - 1,
      rowData: [
        {
          values: [
            {
              userEnteredValue: entered,
              effectiveValue: error
                ? { errorValue: { type: error } }
                : entered?.formulaValue
                  ? { numberValue: 1.24 }
                  : entered,
            },
          ],
        },
      ],
    };
  });
  return {
    sheets: [
      {
        readBounds: { rows: rowCount, columns: 13, fullGrid: true },
        properties: {
          sheetId: 7,
          title: "Тест",
          gridProperties: { rowCount, columnCount: 13 },
        },
        data,
        merges,
      },
    ],
  };
}
function setup(file = ":memory:") {
  const store = new IncidentStore(file);
  let now = date;
  const config = {
    ...loadConfig({ RITM_OWNER_TOKEN: randomBytes(32).toString("hex") }),
    doctorDocuments: [document],
  };
  const fi = new FormulaIntelligence(store, config, { now: () => now });
  const scan = (g, complete = true) => {
    const at = now.toISOString();
    const findings = fi.inspect(document, g, complete, at);
    store.check(document.id, { status: complete ? "ok" : "unavailable" }, at);
    return findings;
  };
  const approve = () =>
    fi.approve({
      regions: fi
        .state()
        .regions.filter((r) => !r.stale)
        .map((r) => ({ id: r.id, version: r.version })),
      acknowledged: true,
    });
  return { store, config, fi, scan, approve, setTime: (v) => (now = v) };
}
test("discovery groups relative families but preserves absolute references, string literals and individual formulas", () => {
  assert.equal(
    formulaFamily('=IF(C11="A11";$D$2;C11)', "M11"),
    formulaFamily('=IF(C19="A11";$D$2;C19)', "M19"),
  );
  assert.notEqual(
    formulaFamily("=$C$11/D11", "M11"),
    formulaFamily("=$C$19/D19", "M19"),
  );
  const s = grid([
    ["M11", "=C11/D11"],
    ["M12", 1],
    ["M19", "=C19/D19"],
    ["G1", "=SUM(A1:B1)"],
  ]).sheets[0];
  const d = discoverFormulaSheet(document, document.sheets[0], s);
  assert.equal(d.areas.length, 2);
  assert.equal(d.areas.find((a) => a.column === "M").manual, 1);
  assert.equal(d.areas.find((a) => a.column === "G").kind, "individual");
});
test("exact baseline pages honor supported page sizes and preserve immutable formulas", () => {
  const s = setup();
  s.scan(
    grid(
      Array.from({ length: 35 }, (_, i) => [
        `M${i + 11}`,
        `=C${i + 11}/D${i + 11}`,
      ]),
    ),
  );
  const region = s.fi.state().regions[0];
  const page = s.fi.region(region.id, region.version, { page: 1, size: 10 });
  assert.equal(page.total, 35);
  assert.equal(page.cells.length, 10);
  assert.equal(page.cells[0].cell, "M21");
  assert.equal(
    s.fi.region(region.id, region.version, { size: 50 }).cells.length,
    35,
  );
  assert.equal(
    s.fi.region(region.id, region.version, { size: 999 }).cells.length,
    20,
  );
  s.store.close();
});
test("main Table Doctor discovers formulas outside previous registered row and column bounds", async () => {
  const s = setup();
  const payload = grid([["Z1501", "=C1501/D1501"]]);
  s.config.doctorDocuments[0] = structuredClone(document);
  s.config.doctorDocuments[0].sheets[0].headers = [];
  payload.sheets[0].properties.gridProperties = {
    rowCount: 1600,
    columnCount: 26,
  };
  const requested = [];
  const reader = {
    configured: true,
    metadata: async () => ({
      sheets: [{ properties: payload.sheets[0].properties }],
    }),
    grid: async (_, ranges) => {
      requested.push(ranges[0]);
      return payload;
    },
  };
  const doctor = new TableDoctor(s.store, s.config, {
    reader,
    now: () => date,
  });
  await doctor.run();
  assert.deepEqual(requested, ["'Тест'!A1:Z1600"]);
  const metrics = doctor.state().formulaIntelligence.metrics[0];
  assert.equal(metrics.fullSheetRead, true);
  assert.equal(metrics.formulasRead, 1);
  assert.equal(
    doctor.state().formulaIntelligence.regions[0].samples[0].cell,
    "Z1501",
  );
  s.store.close();
});
test("all native formulas are candidates, never auto-approved; history is immutable and versioned", () => {
  const s = setup();
  s.scan(grid());
  assert.equal(s.fi.state().metrics[0].checkedCells, 0);
  assert.equal(s.fi.state().metrics[0].unprotectedFormulas, 1);
  s.scan(grid());
  assert.equal(
    s.store.db.prepare("SELECT count(*) AS n FROM formula_versions").get().n,
    1,
  );
  s.scan(grid([["M11", "=C11/D12"]]));
  assert.equal(
    s.store.db.prepare("SELECT count(*) AS n FROM formula_versions").get().n,
    2,
  );
  assert.equal(
    s.store.db.prepare("SELECT count(*) AS n FROM formula_protected").get().n,
    0,
  );
  s.store.close();
});
test("mass preparation groups safe repeated formulas, includes exact M11, and never approves by itself", () => {
  const s = setup(),
    formula = "=OFFSET('Товары НОВАЯ ПЕЧАТЬ 20.07.2026'!D10;-N11;)";
  s.scan(
    grid([
      ["M11", formula],
      ["M12", "=OFFSET('Товары НОВАЯ ПЕЧАТЬ 20.07.2026'!D11;-N12;)"],
      ["M13", "=OFFSET('Товары НОВАЯ ПЕЧАТЬ 20.07.2026'!D12;-N13;)", "N_A"],
      ["G1", "=SUM(A1:B1)"],
    ]),
  );
  const preview = s.fi.prepareProtection();
  assert.equal(preview.totals.formulasRead, 4);
  assert.equal(preview.totals.protectable, 3);
  assert.equal(preview.totals.review, 1);
  assert.equal(preview.totals.excluded, 0);
  assert.equal(preview.m11[0].formula, formula);
  assert.equal(preview.m11[0].status, "protectable");
  assert.equal(
    s.store.db.prepare("SELECT count(*) AS n FROM formula_protected").get().n,
    0,
  );
  const result = s.fi.approveProtectionPreview({
    previewId: preview.previewId,
    acknowledged: true,
  });
  assert.equal(result.approvedCells, 3);
  assert.equal(
    s.store.db
      .prepare("SELECT formula FROM formula_protected WHERE cell='M11'")
      .get().formula,
    formula,
  );
  assert.throws(() =>
    s.fi.approveProtectionPreview({
      previewId: preview.previewId,
      acknowledged: true,
    }),
  );
  assert.equal(s.fi.state().metrics[0].protectedPercent, 75);
  s.scan(
    grid([
      ["M11", formula],
      ["M12", "=OFFSET('Товары НОВАЯ ПЕЧАТЬ 20.07.2026'!D11;-N12;)"],
      ["M13", "=OFFSET('Товары НОВАЯ ПЕЧАТЬ 20.07.2026'!D12;-N13;)", "N_A"],
      ["G1", "=SUM(A1:B1)"],
    ]),
  );
  assert.equal(s.fi.state().metrics[0].protectedFormulasRead, 3);
  assert.equal(s.fi.state().metrics[0].protectedPercent, 75);
  s.store.close();
});
test("mass preview surfaces a numeric formula hole without treating a family example as M11's exact baseline", () => {
  const s = setup();
  s.scan(
    grid([
      ["M9", "=OFFSET('Товары'!D8;-N9;)"],
      ["M11", 1],
      ["M13", "=OFFSET('Товары'!D12;-N13;)"],
    ]),
  );
  const preview = s.fi.prepareProtection(),
    m11 = preview.m11.find((entry) => entry.cell === "M11");
  assert.equal(preview.totals.formulasRead, 2);
  assert.equal(preview.totals.protectable, 2);
  assert.equal(preview.totals.review, 0);
  assert.equal(m11.status, "manual_value_unprotected");
  assert.deepEqual(m11.currentValue, { numberValue: 1 });
  assert.equal(m11.formula, null);
  assert.equal(m11.range, "M9:M13");
  assert.equal(
    preview.manualSamples.find((entry) => entry.cell === "M11").value
      .numberValue,
    1,
  );
  assert.equal(
    s.store.db.prepare("SELECT count(*) AS n FROM formula_protected").get().n,
    0,
  );
  s.fi.approveProtectionPreview({
    previewId: preview.previewId,
    acknowledged: true,
  });
  assert.equal(
    s.store.db
      .prepare("SELECT count(*) AS n FROM formula_protected WHERE cell='M11'")
      .get().n,
    0,
  );
  s.store.close();
});
test("mass preview approval is invalidated if a manual value in a formula span changes", () => {
  const s = setup();
  s.scan(
    grid([
      ["M9", "=C9/D9"],
      ["M11", 1],
      ["M13", "=C13/D13"],
    ]),
  );
  const preview = s.fi.prepareProtection();
  s.scan(
    grid([
      ["M9", "=C9/D9"],
      ["M11", 2],
      ["M13", "=C13/D13"],
    ]),
  );
  assert.throws(() =>
    s.fi.approveProtectionPreview({
      previewId: preview.previewId,
      acknowledged: true,
    }),
  );
  s.store.close();
});
test("mass preparation allows blank-row N/A formulas but holds populated-row errors for review", () => {
  const s = setup();
  s.scan(
    grid([
      ["M11", "=C11/D11", "N_A"],
      ["M12", "=C12/D12"],
      ["G1", "=SUM(A1:B1)"],
    ]),
  );
  const preview = s.fi.prepareProtection();
  assert.equal(preview.totals.protectable, 2);
  assert.equal(preview.totals.review, 1);
  s.store.close();

  const populated = setup();
  populated.scan(
    grid([
      ["M11", "=C11/D11", "N_A"],
      ["M12", "=C12/D12"],
      ["C11", "SKU-1"],
      ["C12", "SKU-2"],
    ]),
  );
  const populatedPreview = populated.fi.prepareProtection(),
    mArea = populatedPreview.reviewRegions.find((r) => r.range.startsWith("M"));
  assert.ok(mArea);
  assert.ok(mArea.reasons.includes("formula_result_error"));
  assert.equal(populatedPreview.totals.protectable, 0);
  assert.equal(populatedPreview.totals.review, 2);
  populated.store.close();
});
test("mass preparation excludes merge interiors and holds invalid references for review", () => {
  const merged = setup(),
    merge = {
      startRowIndex: 10,
      endRowIndex: 12,
      startColumnIndex: 12,
      endColumnIndex: 13,
    };
  merged.scan(
    grid(
      [
        ["M11", "=C11/D11"],
        ["M12", "=C12/D12"],
      ],
      [merge],
    ),
  );
  const mergeReport = merged.fi.prepareProtection();
  assert.equal(mergeReport.totals.formulasRead, 2);
  assert.equal(mergeReport.totals.review, 1);
  assert.equal(mergeReport.totals.excluded, 1);
  merged.store.close();

  const invalid = setup();
  invalid.scan(
    grid([
      ["M11", "=C11/#REF!"],
      ["M12", "=C12/#REF!"],
    ]),
  );
  const invalidReport = invalid.fi.prepareProtection();
  assert.equal(invalidReport.totals.protectable, 0);
  assert.equal(invalidReport.totals.review, 2);
  assert.ok(
    invalidReport.reviewRegions[0].reasons.includes("invalid_reference_token"),
  );
  invalid.store.close();
});
test("bulk protection does not overwrite approved baselines and requires a new fresh preview after scans", () => {
  const s = setup();
  s.scan(
    grid([
      ["M11", "=C11/D11"],
      ["M12", "=C12/D12"],
    ]),
  );
  const first = s.fi.prepareProtection();
  s.fi.approveProtectionPreview({
    previewId: first.previewId,
    acknowledged: true,
  });
  s.scan(
    grid([
      ["M11", "=C11/D12"],
      ["M12", "=C12/D12"],
    ]),
  );
  assert.equal(
    s.store.db
      .prepare("SELECT formula FROM formula_protected WHERE cell='M11'")
      .get().formula,
    "=C11/D11",
  );
  s.setTime(new Date(date.getTime() + 1000));
  s.scan(
    grid([
      ["M11", "=C11/D12"],
      ["M12", "=C12/D12"],
      ["L11", "=C11+1"],
      ["L12", "=C12+1"],
    ]),
  );
  const stalePreview = s.fi.prepareProtection();
  assert.equal(stalePreview.totals.protectable, 2);
  s.setTime(new Date(date.getTime() + 2000));
  s.scan(
    grid([
      ["M11", "=C11/D13"],
      ["M12", "=C12/D12"],
      ["L11", "=C11+1"],
      ["L12", "=C12+1"],
    ]),
  );
  assert.throws(() =>
    s.fi.approveProtectionPreview({
      previewId: stalePreview.previewId,
      acknowledged: true,
    }),
  );
  s.store.close();
});
test("full-grid discovery expands beyond old rule ranges, with bounded sequential requests and native coordinates", async () => {
  const ranges = [],
    existing = {
      properties: {
        title: "S",
        sheetId: 7,
        gridProperties: { rowCount: 3000, columnCount: 50 },
      },
    };
  const reader = {
    grid: async (_, requested) => {
      ranges.push(requested[0]);
      return {
        sheets: [
          {
            properties: existing.properties,
            data: [
              {
                startRow: ranges.length === 1 ? 0 : 2000,
                rowData: [{ values: [] }],
              },
            ],
          },
        ],
      };
    },
  };
  const s = await readDoctorSheet(
    reader,
    "id",
    { gid: 7, maxRows: 1000, lastColumn: "M" },
    existing,
    undefined,
    { fullGrid: true },
  );
  assert.deepEqual(ranges, ["'S'!A1:AX2000", "'S'!A2001:AX3000"]);
  assert.equal(s.readBounds.fullGrid, true);
  assert.equal(s.data[1].startRow, 2000);
});
test("unapproved history yields a persistent hypothesis, no confirmed original or Telegram notification", () => {
  const s = setup();
  s.scan(grid());
  const f = s.scan(grid([["M11", 150]]))[0];
  assert.equal(f.type, "formula_history_change");
  assert.equal(f.verification, "needs_review");
  assert.equal(f.expected.confidence, "unapproved_history");
  assert.equal(s.scan(grid([["M11", 150]])).length, 1);
  assert.equal(s.store.listIncidents({ status: "active" }).total, 1);
  assert.equal(
    s.store.db.prepare("SELECT count(*) AS n FROM outbox").get().n,
    0,
  );
  s.store.close();
});
test("bulk approved addresses detect numbers, text, deletion and reference changes; dedup, close and reopen", () => {
  for (const value of [150, "manual", null, "=C11/D12"]) {
    const s = setup();
    s.scan(grid());
    s.approve();
    const findings = s.scan(grid([["M11", value]]));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].verification, "rule_confirmed");
    assert.equal(findings[0].expected, "=C11/D11");
    s.scan(grid([["M11", value]]));
    assert.equal(s.store.listIncidents({ status: "active" }).total, 1);
    assert.equal(
      s.store.db.prepare("SELECT count(*) AS n FROM outbox").get().n,
      1,
    );
    const m = s.fi.state().metrics[0];
    assert.equal(m.protectedCells, 1);
    assert.equal(m.checkedCells, 1);
    assert.ok(m.unprotectedFormulas >= 0);
    s.scan(grid());
    assert.equal(s.store.listIncidents({ status: "active" }).total, 0);
    assert.equal(s.store.listIncidents({ status: "fixed" }).total, 1);
    s.scan(grid([["M11", value]]));
    assert.equal(s.store.listIncidents({ status: "active" }).total, 1);
    s.store.close();
  }
});
test("unchanged formula returning N/A or REF is not called a replaced formula", () => {
  const s = setup();
  s.scan(grid([["M11", "=C11/D11", "N_A"]]));
  s.approve();
  assert.equal(s.scan(grid([["M11", "=C11/D11", "REF"]])).length, 0);
  s.store.close();
});

test("fast monitoring reports a calculation error while the protected formula remains unchanged", async () => {
  const s = setup();
  s.scan(grid());
  s.approve();
  const reader = {
    telemetry: () => ({ readRequests: 0, retries: 0, responseBytes: 0 }),
    async metadata(documentId) {
      return {
        spreadsheetId: documentId,
        sheets: [
          {
            properties: {
              sheetId: 7,
              title: "Тест",
              gridProperties: { rowCount: 1000, columnCount: 13 },
            },
            merges: [],
          },
        ],
      };
    },
    async grid() {
      return {
        ...grid([["M11", "=C11/D11", "REF"]]),
        spreadsheetId: document.documentId,
      };
    },
  };
  const damaged = await s.fi.fastCheck(reader);
  assert.equal(damaged.status, "ok");
  assert.equal(damaged.violations, 1);
  const issue = s.store.listIncidents({ status: "active" }).rows[0];
  assert.equal(issue.type, "calculation_error");
  assert.equal(issue.verification, "needs_review");
  assert.equal(
    s.store.db.prepare("SELECT count(*) AS n FROM outbox").get().n,
    0,
  );
  reader.grid = async () => ({
    ...grid([["M11", "=C11/D11"]]),
    spreadsheetId: document.documentId,
  });
  await s.fi.fastCheck(reader);
  assert.equal(s.store.listIncidents({ status: "active" }).total, 0);
  s.store.close();
});

test("fast monitoring batches sparse formulas and trusts complete merge metadata", async () => {
  const s = setup(),
    merge = {
      startRowIndex: 10,
      endRowIndex: 18,
      startColumnIndex: 12,
      endColumnIndex: 13,
    },
    entries = Array.from({ length: 31 }, (_, index) => {
      const row = 11 + index * 10;
      return [`M${row}`, `=C${row}/D${row}`];
    });
  s.scan(grid(entries, [merge]));
  s.approve();
  let metadataReads = 0;
  const gridCalls = [];
  const reader = {
    telemetry: () => ({ readRequests: 0, retries: 0, responseBytes: 0 }),
    async metadata(documentId) {
      metadataReads++;
      return {
        spreadsheetId: documentId,
        sheets: [
          {
            properties: {
              sheetId: 7,
              title: "Тест",
              gridProperties: { rowCount: 1000, columnCount: 13 },
            },
            merges: [merge],
          },
        ],
      };
    },
    async grid(documentId, ranges) {
      gridCalls.push(ranges);
      return {
        ...grid(entries),
        spreadsheetId: documentId,
      };
    },
  };
  const result = await s.fi.fastCheck(reader);
  assert.equal(metadataReads, 1);
  assert.equal(gridCalls.length, 1);
  assert.equal(gridCalls[0].length, 1);
  assert.equal(result.readRequests, 2);
  assert.equal(result.checkedCells, entries.length);
  assert.equal(result.violations, 0);
  assert.ok(
    Math.abs(
      result.dataAcquisitionMs -
        (result.metadataReadMs + result.rangeReadMs),
    ) <= 1,
  );
  assert.ok(result.durationMs >= result.dataAcquisitionMs);
  assert.equal(result.comparisonMs >= 0, true);
  assert.equal(s.store.listIncidents({ status: "active" }).total, 0);
  s.store.close();
});
test("two fast cycles do not reopen 7,775 healthy protected formulas when range reads omit merge metadata", async () => {
  const s = setup(),
    protectedCount = 7775,
    rowCount = protectedCount * 2,
    entries = Array.from({ length: protectedCount }, (_, index) => {
      const row = index * 2 + 1;
      return [`M${row}`, `=C${row}/D${row}`];
    }),
    merges = Array.from({ length: protectedCount }, (_, index) => ({
      startRowIndex: index * 2,
      endRowIndex: index * 2 + 2,
      startColumnIndex: 12,
      endColumnIndex: 13,
    })),
    approved = grid(entries, merges, rowCount);
  s.scan(approved);
  s.approve();
  let metadataReads = 0;
  const rangeReads = [];
  const reader = {
    telemetry: () => ({ readRequests: 0, retries: 0, responseBytes: 0 }),
    async metadata(documentId) {
      metadataReads++;
      return {
        spreadsheetId: documentId,
        sheets: [
          {
            properties: {
              sheetId: 7,
              title: "Тест",
              gridProperties: { rowCount, columnCount: 13 },
            },
            merges,
          },
        ],
      };
    },
    async grid(documentId, ranges) {
      rangeReads.push(ranges);
      // A bounded Google grid response can omit merges outside its returned data.
      return {
        ...grid(entries, [], rowCount),
        spreadsheetId: documentId,
      };
    },
  };
  for (let cycle = 0; cycle < 2; cycle++) {
    const result = await s.fi.fastCheck(reader);
    assert.equal(result.status, "ok");
    assert.equal(result.checkedCells, protectedCount);
    assert.equal(result.violations, 0);
  }
  assert.equal(metadataReads, 2);
  assert.equal(rangeReads.length, 4);
  assert.equal(s.store.listIncidents({ status: "active" }).total, 0);
  assert.equal(
    s.store.db
      .prepare(
        "SELECT count(*) AS n FROM incidents WHERE json_extract(payload,'$.type')='structure_changed'",
      )
      .get().n,
    0,
  );
  s.store.close();
});
test("fast monitoring without complete merge metadata skips structure claims but still finds formula damage", async () => {
  const s = setup(),
    merge = {
      startRowIndex: 10,
      endRowIndex: 18,
      startColumnIndex: 12,
      endColumnIndex: 13,
    };
  s.scan(grid([["M11", "=C11/D11"]], [merge]));
  s.approve();
  const reader = {
    telemetry: () => ({ readRequests: 0, retries: 0, responseBytes: 0 }),
    async grid(documentId) {
      return {
        ...grid([["M11", "=C11/D11"]]),
        spreadsheetId: documentId,
      };
    },
  };
  const healthy = await s.fi.fastCheck(reader);
  assert.equal(healthy.violations, 0);
  assert.equal(s.store.listIncidents({ status: "active" }).total, 0);
  reader.grid = async (documentId) => ({
    ...grid([["M11", 123]]),
    spreadsheetId: documentId,
  });
  const damaged = await s.fi.fastCheck(reader);
  assert.equal(damaged.violations, 1);
  assert.equal(
    s.store.listIncidents({ status: "active" }).rows[0].type,
    "formula_number",
  );
  reader.metadata = async (documentId) => ({
    spreadsheetId: documentId,
    sheets: [
      {
        properties: {
          sheetId: 7,
          title: "Тест",
          gridProperties: { rowCount: 1000, columnCount: 13 },
        },
        merges: [],
      },
    ],
  });
  reader.grid = async (documentId) => ({
    ...grid([["M11", "=C11/D11"]]),
    spreadsheetId: documentId,
  });
  const changedMerge = await s.fi.fastCheck(reader);
  assert.equal(changedMerge.violations, 1);
  assert.equal(
    s.store.listIncidents({ status: "active" }).rows[0].type,
    "structure_changed",
  );
  s.store.close();
});
test("manual values and merge interiors are not protected; merge changes require structural review", () => {
  const merge = {
    startRowIndex: 10,
    endRowIndex: 18,
    startColumnIndex: 12,
    endColumnIndex: 13,
  };
  const s = setup();
  s.scan(
    grid(
      [
        ["M11", "=C11/D11"],
        ["M12", null],
        ["M19", 1],
      ],
      [merge],
    ),
  );
  s.approve();
  assert.equal(
    s.store.db.prepare("SELECT count(*) AS n FROM formula_protected").get().n,
    1,
  );
  assert.equal(s.scan(grid([["M11", "=C11/D11"]], [merge])).length, 0);
  const f = s.scan(grid([["M11", "=C11/D11"]]));
  assert.equal(f[0].type, "structure_changed");
  assert.equal(f[0].verification, "needs_review");
  s.store.close();
});
test("stale/failed reads and partial source cannot approve baselines or close a known incident", () => {
  const s = setup();
  s.scan(grid());
  s.approve();
  s.scan(grid([["M11", 1]]));
  s.scan(grid(), false);
  assert.equal(s.store.listIncidents({ status: "active" }).total, 1);
  assert.throws(s.approve);
  s.scan(grid());
  s.setTime(new Date(date.getTime() + 2000000));
  assert.throws(s.approve);
  s.store.close();
});
test("owner reviewed changed business logic creates a new immutable baseline without Google writes", () => {
  const s = setup();
  s.scan(grid());
  s.approve();
  s.scan(grid([["M11", "=C11/D12"]]));
  s.approve();
  assert.equal(
    s.store.db.prepare("SELECT formula FROM formula_protected").get().formula,
    "=C11/D12",
  );
  assert.equal(s.store.listIncidents({ status: "fixed" }).total, 0);
  assert.equal(s.scan(grid([["M11", "=C11/D12"]])).length, 0);
  s.store.close();
});
test("point exceptions are content/version-bound, expire, revoke and do not describe repair", () => {
  const s = setup();
  s.scan(grid());
  s.approve();
  s.scan(grid([["M11", 150]]));
  const incidentId = s.store.listIncidents({ status: "active" }).rows[0].id;
  const e = s.fi.addException({
    incidentId,
    reason: "Согласованная ручная корректировка",
    expiresAt: "2026-10-11T07:30:00Z",
  });
  assert.equal(s.scan(grid([["M11", 150]])).length, 0);
  assert.equal(s.store.listIncidents({ status: "fixed" }).total, 0);
  assert.equal(s.scan(grid([["M11", 151]])).length, 1);
  s.fi.revokeException(e.id);
  assert.equal(s.scan(grid([["M11", 150]])).length, 1);
  s.store.close();
});
test("protection, snapshot versions and incident history survive restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ritm-formulas-")),
    file = path.join(dir, "db.sqlite");
  try {
    const s = setup(file);
    s.scan(grid());
    s.approve();
    s.scan(grid([["M11", 150]]));
    s.store.close();
    const next = setup(file);
    assert.equal(next.scan(grid([["M11", 150]])).length, 1);
    assert.equal(next.store.listIncidents({ status: "active" }).total, 1);
    assert.equal(
      next.store.db.prepare("SELECT count(*) AS n FROM formula_versions").get()
        .n,
      1,
    );
    next.store.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("approval rejects missing acknowledgments, address injection, replayed changed manifests and >50 regions", () => {
  const s = setup();
  s.scan(grid());
  const a = s.fi.state().regions[0];
  assert.throws(() =>
    s.fi.approve({
      regions: [{ id: a.id, version: a.version }],
      acknowledged: false,
    }),
  );
  assert.throws(() =>
    s.fi.approve({
      regions: [{ id: a.id, version: a.version, cell: "M12" }],
      acknowledged: true,
    }),
  );
  s.scan(grid([["M11", "=C11/D12"]]));
  assert.throws(
    () =>
      s.fi.approve({
        regions: [{ id: a.id, version: a.version }],
        acknowledged: true,
      }),
    /устарел/,
  );
  assert.throws(() =>
    s.fi.approve({
      regions: Array.from({ length: 51 }, () => ({
        id: a.id,
        version: a.version,
      })),
      acknowledged: true,
    }),
  );
  s.store.close();
});
test("private endpoints require authentication; bearer read access cannot approve; valid owner cookie with Origin can", async () => {
  const s = setup();
  s.scan(
    grid([
      ["M11", "=C11/D11"],
      ["M12", "=C12/D12"],
    ]),
  );
  let freshRuns = 0;
  const server = createAgentServer(s.store, s.config, {
    doctor: {
      formulas: s.fi,
      current: null,
      run: async () => {
        freshRuns++;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  s.config.allowedOrigins.push(base);
  const a = s.fi.state().regions[0],
    payload = JSON.stringify({
      regions: [{ id: a.id, version: a.version }],
      acknowledged: true,
    });
  try {
    const url = base + "/api/intelligence/doctor/formulas/approve";
    assert.equal(
      (await fetch(url, { method: "POST", body: payload })).status,
      401,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            authorization: "Bearer " + s.config.ownerToken,
            Origin: base,
            "content-type": "application/json",
          },
          body: payload,
        })
      ).status,
      403,
    );
    const login = await fetch(base + "/api/intelligence/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: s.config.ownerToken }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const prepareUrl = base + "/api/intelligence/doctor/formulas/prepare";
    const preparedResponse = await fetch(prepareUrl, {
      method: "POST",
      headers: {
        cookie,
        Origin: base,
        "content-type": "application/json",
      },
      body: "{}",
    });
    const prepared = await preparedResponse.json();
    assert.equal(preparedResponse.status, 200);
    assert.equal(prepared.totals.protectable, 2);
    assert.equal(freshRuns, 1);
    assert.equal(
      (
        await fetch(prepareUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    const bulk = await fetch(
      base + "/api/intelligence/doctor/formulas/bulk-approve",
      {
        method: "POST",
        headers: {
          cookie,
          Origin: base,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          previewId: prepared.previewId,
          acknowledged: true,
        }),
      },
    );
    assert.equal(bulk.status, 200);
    assert.equal(freshRuns, 2);
    assert.equal(
      s.store.db.prepare("SELECT count(*) AS n FROM formula_protected").get().n,
      2,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { cookie, Origin: base, "content-type": "application/json" },
          body: payload,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            cookie,
            Origin: "https://attacker.invalid",
            "content-type": "application/json",
          },
          body: payload,
        })
      ).status,
      403,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    s.store.close();
  }
});
