import test from "node:test";
import assert from "node:assert/strict";
import { formulaInventory } from "../agent/doctorInventory.js";
import { DEMO_DOCUMENT, demoSpreadsheet } from "../agent/doctorDemo.js";
import {
  formulaReferences,
  referencesCell,
  spreadsheetCells,
} from "../agent/formulaReferences.js";
const preview = (scenario, mutate = () => {}) => {
  const doc = structuredClone(DEMO_DOCUMENT);
  doc.sheets[0].rules[0].approval = "pending";
  mutate(doc.sheets[0].rules[0], doc.sheets[0]);
  const before = JSON.stringify(doc),
    result = formulaInventory(doc, demoSpreadsheet(scenario))[0];
  assert.equal(JSON.stringify(doc), before);
  assert.equal(doc.sheets[0].rules[0].approval, "pending");
  return result;
};
test("candidate dry run finds numeric replacement with exact expectation without approving live rules", () => {
  const r = preview("number");
  assert.equal(r.preview.status, "preview");
  assert.equal(r.preview.rowsChecked, 2);
  assert.equal(r.preview.wouldFlag, 1);
  assert.equal(r.preview.issues[0].expected, "=C247/D247");
  assert.equal(r.preview.issues[0].type, "formula_number");
});
test("correct candidate has no violations; mismatched formula is shown in preview", () => {
  assert.equal(preview("healthy").preview.wouldFlag, 0);
  assert.equal(preview("mismatch").preview.issues[0].type, "formula_mismatch");
});
test("unknown template is blocked rather than reporting zero defects", () => {
  const r = preview("number", (r) => (r.templates = [])).preview;
  assert.equal(r.status, "blocked_template");
  assert.equal(r.wouldFlag, null);
  assert.equal(r.rowsChecked, null);
});
test("manual exception excludes row from actual checked count", () => {
  const r = preview("number", (r) =>
    r.exceptions.push({ rows: [247], reason: "manual" }),
  ).preview;
  assert.equal(r.rowsChecked, 1);
  assert.equal(r.wouldFlag, 0);
});
test("changed header blocks candidate interpretation", () => {
  const r = preview(
    "healthy",
    (_, s) => (s.headers = [{ cell: "A1", value: "Unexpected header" }]),
  ).preview;
  assert.equal(r.status, "blocked_structure");
  assert.equal(r.rowsChecked, null);
});
test("unobserved summary exception is disclosed rather than considered proven", () => {
  const r = preview(
    "healthy",
    (r) =>
      (r.exceptions = [
        { when: { column: "A", equals: "Итого" }, templates: ["=SUM(E2:E9)"] },
      ]),
  ).preview;
  assert.equal(r.unusedExceptions, 1);
});
test("A1 dependency parser distinguishes literal strings, qualified sheets, absolute ranges", () => {
  const r = formulaReferences(
    '=SUM(\'По дням\'!$B$2:$Z$2)+E1+IMPORTRANGE("other-id","C16")',
    "Личный",
  );
  assert.equal(r.ranges.length, 2);
  assert.ok(
    r.ranges.some((x) => referencesCell(x, "По дням", "C16") === false),
  );
  assert.ok(r.ranges.some((x) => referencesCell(x, "По дням", "C2")));
  assert.ok(r.ranges.some((x) => referencesCell(x, "Личный", "E1")));
  assert.ok(!r.ranges.some((x) => referencesCell(x, "Личный", "C16")));
});
test("dependency parser preserves Cyrillic, apostrophes and rejects nearby identifier text", () => {
  const r = formulaReferences(
    "=Настя!E1+'Лист ''два'''!C16+variableC16+\"E1\"",
    "Other",
  );
  assert.equal(r.ranges.length, 2);
  assert.ok(r.ranges.some((x) => referencesCell(x, "Настя", "E1")));
  assert.ok(r.ranges.some((x) => referencesCell(x, "Лист 'два'", "C16")));
});
test("whole row/column references and reversed range bounds match correct cell", () => {
  const r = formulaReferences("=SUM(C:C)+SUM(16:16)+SUM(E20:B2)", "Local");
  assert.ok(referencesCell(r.ranges[0], "Local", "C247"));
  assert.ok(!referencesCell(r.ranges[0], "Other", "C247"));
  assert.ok(referencesCell(r.ranges[1], "Local", "Z16"));
  assert.ok(referencesCell(r.ranges[2], "Local", "C16"));
});
test("dynamic formulas are disclosed; text INDIRECT is not classified dynamic", () => {
  assert.equal(formulaReferences('=INDIRECT("C16")', "S").dynamic, true);
  assert.equal(formulaReferences('="INDIRECT(C16)"', "S").dynamic, false);
});
test("dependency audit preserves grid offsets and address", () => {
  const c = spreadsheetCells({
    sheets: [
      {
        properties: { title: "S", sheetId: 4 },
        data: [
          {
            startRow: 246,
            startColumn: 6,
            rowData: [{ values: [{ effectiveValue: { numberValue: 150 } }] }],
          },
        ],
      },
    ],
  })[0];
  assert.equal(c.address, "G247");
  assert.equal(c.gid, 4);
});
