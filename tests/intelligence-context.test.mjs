import assert from "node:assert/strict";
import test from "node:test";
import { inspectDocument } from "../agent/doctor.js";
import {
  doctorColumnIndex,
  validateDoctorDocuments,
} from "../agent/doctorRegistry.js";
import { formulaInventory } from "../agent/doctorInventory.js";
import { IncidentStore } from "../agent/store.js";
import { PRODUCTION_DOCTOR_DOCUMENTS } from "../agent/productionRegistry.js";
const rollRowColumns = [
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "O",
  "P",
  "Q",
  "R",
];
function sample({
  article = "",
  quantity = 0,
  fError = null,
  extraErrors = {},
  extraFormulas = {},
  formula = "=VLOOKUP(E4;A1:B2;2;FALSE)",
  error = "N_A",
  approval = "pending",
  templates = ["=F{row}*H{row}*I{row}*O{row}"],
} = {}) {
  const doc = {
    id: "context-test",
    name: "Synthetic only",
    department: "Печать",
    adapter: "fixture",
    enabled: true,
    sheets: [
      {
        gid: 1,
        name: "Orders",
        maxRows: 4,
        lastColumn: "R",
        headers: [],
        context: {
          startRow: 4,
          columns: rollRowColumns,
          activeColumns: ["E"],
          errorColumns: rollRowColumns,
          emptyLookupNAColumns: ["F", "J"],
          emptyRowPropagatedNAColumns: [],
          ignoreCalculationErrorsWhenInactive: true,
          suppressErrorsWithSameRowErrorDependency: true,
        },
        rules: [
          {
            id: "area",
            kind: "formula",
            column: "J",
            startRow: 4,
            endRow: 4,
            when: { column: "E", notEmpty: true },
            approval,
            templates,
            exceptions: [],
          },
        ],
      },
    ],
  };
  const cells = Array.from({ length: 18 }, () => ({}));
  cells[4] = {
    userEnteredValue: { stringValue: article },
    effectiveValue: { stringValue: article },
  };
  if (fError)
    cells[5] = {
      userEnteredValue: { formulaValue: "=H4/I4" },
      effectiveValue: { errorValue: { type: fError, message: "Synthetic" } },
    };
  cells[14] = {
    userEnteredValue: { numberValue: quantity },
    effectiveValue: { numberValue: quantity },
  };
  cells[9] = {
    userEnteredValue: { formulaValue: formula },
    effectiveValue: error
      ? { errorValue: { type: error, message: "Synthetic" } }
      : { numberValue: 0 },
  };
  for (const [column, error] of Object.entries(extraErrors))
    cells[doctorColumnIndex(column)] = {
      userEnteredValue: {
        formulaValue: extraFormulas[column] || "=A1",
      },
      effectiveValue: { errorValue: { type: error, message: "Synthetic" } },
    };
  const grid = {
    sheets: [
      {
        properties: {
          sheetId: 1,
          title: "Orders",
          gridProperties: { rowCount: 4 },
        },
        data: [{ startRow: 3, startColumn: 0, rowData: [{ values: cells }] }],
      },
    ],
  };
  return { doc, grid, cells, rule: doc.sheets[0].rules[0] };
}
const run = (x) => inspectDocument(x.doc, x.grid);
test("empty lookup N/A in declared production column is normal and never altered", () => {
  const x = sample();
  x.doc.sheets[0].context.ignoreCalculationErrorsWhenInactive = false;
  const r = run(x);
  assert.equal(r.findings.length, 0);
  assert.equal(r.stats.expectedNA, 1);
  assert.equal(
    x.cells[9].userEnteredValue.formulaValue,
    "=VLOOKUP(E4;A1:B2;2;FALSE)",
  );
});
test("filled row N/A is manual business review, not proof of a broken formula", () => {
  const r = run(sample({ article: "TEST" }));
  assert.equal(r.findings[0].category, "business_review");
  assert.equal(r.findings[0].initialStatus, "review");
  assert.equal(r.findings[0].expected, null);
  assert.equal(r.stats.expectedNA, 0);
  assert.equal(r.findings[0].rowContext.state, "filled");
});
test("empty article keeps the row inactive even when quantity and formulas contain errors", () => {
  const r = run(
    sample({ quantity: 150, fError: "DIVIDE_BY_ZERO", error: "N_A" }),
  );
  assert.equal(r.findings.length, 0);
  assert.equal(r.stats.expectedNA, 1);
});
test("filled article activates the row and reports an error in column F", () => {
  const r = run(
    sample({
      article: "ROLL-001",
      fError: "DIVIDE_BY_ZERO",
      formula: "=F4*H4*I4*O4",
      error: null,
    }),
  );
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].cell, "F4");
  assert.equal(r.findings[0].type, "calculation_error");
  assert.equal(r.findings[0].rowContext.state, "filled");
});
test("same-row calculation errors are grouped at their failing dependency", () => {
  const r = run(
    sample({
      article: "ROLL-001",
      formula: "=F4*H4*I4*O4",
      error: "N_A",
      extraErrors: {
        F: "N_A",
        G: "N_A",
        I: "N_A",
        K: "N_A",
        L: "N_A",
      },
      extraFormulas: {
        F: "=VLOOKUP(E:E;A:F;5;0)",
        G: "=VLOOKUP(E:E;A:G;6;0)",
        I: "=G4/100",
        K: "=F4*H4*I4*Q4",
        L: "=J4+K4",
      },
    }),
  );
  assert.deepEqual(
    r.findings.map((finding) => finding.cell),
    ["F4", "G4"],
  );
  assert.equal(r.stats.propagatedErrors, 4);
});
test("N/A is not ignored outside explicit columns or with arbitrary formula", () => {
  const x = sample({ article: "ROLL-001" });
  x.doc.sheets[0].context.emptyLookupNAColumns = [];
  assert.equal(run(x).findings.length, 1);
  assert.equal(
    run(sample({ article: "ROLL-001", formula: "=E4+1" })).findings.length,
    1,
  );
});
test("explicit empty-row policy suppresses propagated N/A but preserves active and other errors", () => {
  const empty = sample({
    formula: "=F4*H4*I4*O4",
    error: "N_A",
  });
  empty.doc.sheets[0].context.emptyLookupNAColumns = [];
  empty.doc.sheets[0].context.emptyRowPropagatedNAColumns = ["J"];
  const expected = run(empty);
  assert.equal(expected.findings.length, 0);
  assert.equal(expected.stats.expectedNA, 1);

  assert.equal(
    run(sample({ article: "ACTIVE", formula: "=F4*H4*I4*O4" })).findings.length,
    1,
  );
  assert.equal(
    run(
      sample({
        article: "ROLL-001",
        formula: "=F4*H4*I4*O4",
        error: "DIVIDE_BY_ZERO",
      }),
    ).findings.length,
    1,
  );
  assert.equal(
    run(
      sample({
        article: "ROLL-001",
        formula: "=#REF!",
        error: "REF",
      }),
    ).findings.length,
    1,
  );
});
test("a verified empty-row recheck closes the old propagated N/A incident", () => {
  const store = new IncidentStore(":memory:");
  try {
    const x = sample({
      article: "ROLL-001",
      formula: "=F4*H4*I4*O4",
      error: "N_A",
    });
    const scope = "doctor:roll-order:1",
      onlyCells = new Set(["J4"]);
    const first = run(x);
    assert.equal(first.findings.length, 1);
    store.reconcile(scope, first.findings, {
      verified: true,
      at: "2026-10-13T08:00:00.000Z",
      onlyCells,
    });
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM incidents WHERE status='open'").get().n,
      1,
    );

    x.doc.sheets[0].context.emptyRowPropagatedNAColumns = ["J"];
    x.cells[4] = {};
    const second = run(x);
    assert.equal(second.findings.length, 0);
    store.reconcile(scope, second.findings, {
      verified: true,
      at: "2026-10-13T08:02:00.000Z",
      onlyCells,
    });
    const closed = store.db.prepare("SELECT status,resolved_at FROM incidents").get();
    assert.equal(closed.status, "resolved");
    assert.equal(closed.resolved_at, "2026-10-13T08:02:00.000Z");
    assert.equal(store.overview().corrections, 0);
  } finally {
    store.close();
  }
});
test("inactive-row REF is ignored, while active-row REF remains review", () => {
  const inactive = run(
      sample({ error: "REF", formula: "=VLOOKUP(E4;#REF!;2;FALSE)" }),
    ),
    active = run(
      sample({
        article: "ROLL-001",
        error: "REF",
        formula: "=VLOOKUP(E4;#REF!;2;FALSE)",
      }),
    );
  assert.equal(inactive.findings.length, 0);
  const r = active;
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].initialStatus, "review");
  assert.equal(r.stats.expectedNA, 0);
});
test("correct approved formula with DIV/0 needs input review rather than formula restoration", () => {
  const r = run(
    sample({
      article: "TEST",
      approval: "approved",
      formula: "=H4/I4",
      templates: ["=H{row}/I{row}"],
      error: "DIVIDE_BY_ZERO",
    }),
  );
  assert.equal(r.findings[0].category, "business_review");
  assert.equal(r.findings[0].verification, "needs_review");
  assert.equal(r.findings[0].expected, null);
  assert.deepEqual(r.baseline, {});
});
test("approved wrong formula with computation error still proves a template violation", () => {
  const r = run(
    sample({
      article: "TEST",
      approval: "approved",
      formula: "=#REF!",
      error: "REF",
    }),
  );
  assert.equal(r.findings[0].category, "confirmed_formula");
  assert.equal(r.findings[0].type, "formula_mismatch");
  assert.equal(r.findings[0].verification, "rule_confirmed");
  assert.equal(r.findings[0].expected, "=F4*H4*I4*O4");
});
test("pending formula with computation error never acquires approved status", () => {
  const x = sample({ article: "TEST", formula: "=#REF!", error: "REF" });
  assert.equal(run(x).findings[0].verification, "needs_review");
  assert.equal(x.rule.approval, "pending");
});
test("explicit owner exception allows filled-row N/A only for its exact row", () => {
  const x = sample({ article: "TEST" });
  x.rule.exceptions = [
    { rows: [4], reason: "Approved lookup exception for synthetic row only" },
  ];
  assert.equal(run(x).findings.length, 0);
});
test("zero result is accepted, not automatically a production anomaly", () => {
  const r = run(
    sample({
      article: "TEST",
      error: null,
      formula: "=F4*H4*I4*O4",
      approval: "approved",
    }),
  );
  assert.deepEqual(r.findings, []);
  assert.equal(r.stats.classifications.normal, 1);
});
test("context registry validates bounds and refuses accidental global exemption", () => {
  const x = sample();
  validateDoctorDocuments([x.doc]);
  x.doc.sheets[0].context.emptyLookupNAColumns = ["AF"];
  assert.throws(() => validateDoctorDocuments([x.doc]), /Context/);
  x.doc.sheets[0].context.emptyLookupNAColumns = ["F", "J"];
  x.doc.sheets[0].context.emptyRowPropagatedNAColumns = ["S"];
  assert.throws(() => validateDoctorDocuments([x.doc]), /Context/);
});
test("roll-printing registry uses article E as the activity gate and checks F errors", () => {
  const roll = PRODUCTION_DOCTOR_DOCUMENTS.find(
      (document) => document.id === "doctor-roll-printing",
    ),
    orders = roll.sheets.find((sheet) => sheet.gid === 119710351);
  assert.deepEqual(orders.context.activeColumns, ["E"]);
  assert.deepEqual(orders.context.errorColumns, orders.context.columns);
  assert.equal(orders.context.ignoreCalculationErrorsWhenInactive, true);
});
test("actual IMPORTRANGE row mapping retains source IDs and distinct source row numbers", () => {
  const x = sample({
    article: "TEST",
    error: null,
    formula:
      '=IMPORTRANGE("1example-C3-source-document-long";"Coefficients!B9")',
  });
  const before = JSON.stringify(x.doc);
  const rules = formulaInventory(x.doc, x.grid);
  assert.equal(
    rules[0].importRows[0].references[0].documentId,
    "1example-C3-source-document-long",
  );
  assert.equal(rules[0].importRows[0].references[0].range, "Coefficients!B9");
  assert.equal(JSON.stringify(x.doc), before);
  assert.equal(rules[0].approval, "pending");
});
test("known issue is deduplicated; context correction closes observation without claiming agent repair", () => {
  const store = new IncidentStore(":memory:");
  try {
    const x = sample({ article: "TEST" });
    store.reconcile("context", run(x).findings);
    store.reconcile("context", run(x).findings);
    const open = store.db
      .prepare("SELECT * FROM incidents WHERE status='open'")
      .all();
    assert.equal(open.length, 1);
    assert.equal(open[0].occurrences, 2);
    x.cells[4] = {};
    store.reconcile("context", run(x).findings);
    assert.equal(
      store.db
        .prepare("SELECT count(*) AS n FROM incidents WHERE status='open'")
        .get().n,
      0,
    );
    assert.equal(store.overview().corrections, 0);
  } finally {
    store.close();
  }
});
