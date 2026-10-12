import assert from "node:assert/strict";
import test from "node:test";
import { inspectDocument } from "../agent/doctor.js";
import { validateDoctorDocuments } from "../agent/doctorRegistry.js";
import { formulaInventory } from "../agent/doctorInventory.js";
import { IncidentStore } from "../agent/store.js";
function sample({
  article = "",
  quantity = 0,
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
        lastColumn: "J",
        headers: [],
        context: {
          startRow: 4,
          columns: ["E", "F", "H", "I", "J"],
          activeColumns: ["E", "I"],
          errorColumns: ["F", "J"],
          emptyLookupNAColumns: ["F", "J"],
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
  const cells = Array.from({ length: 10 }, () => ({}));
  cells[4] = {
    userEnteredValue: { stringValue: article },
    effectiveValue: { stringValue: article },
  };
  cells[8] = {
    userEnteredValue: { numberValue: quantity },
    effectiveValue: { numberValue: quantity },
  };
  cells[9] = {
    userEnteredValue: { formulaValue: formula },
    effectiveValue: error
      ? { errorValue: { type: error, message: "Synthetic" } }
      : { numberValue: 0 },
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
  const x = sample(),
    r = run(x);
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
test("positive quantity prevents blank-row N/A suppression even without article", () => {
  const r = run(sample({ quantity: 150 }));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rowContext.state, "filled");
});
test("N/A is not ignored outside explicit columns or with arbitrary formula", () => {
  const x = sample();
  x.doc.sheets[0].context.emptyLookupNAColumns = [];
  assert.equal(run(x).findings.length, 1);
  assert.equal(run(sample({ formula: "=E4+1" })).findings.length, 1);
});
test("REF in empty row remains review; not an expected lookup failure", () => {
  const r = run(
    sample({ error: "REF", formula: "=VLOOKUP(E4;#REF!;2;FALSE)" }),
  );
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
