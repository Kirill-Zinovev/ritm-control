import fs from "node:fs";
import path from "node:path";
export const DEMO_DOCUMENT = {
  id: "doctor-demo",
  adapter: "fixture",
  documentId: "demo-only",
  name: "ДЕМОНСТРАЦИЯ · Сборка QA",
  department: "Сборка",
  enabled: true,
  purpose:
    "Искусственные данные для проверки полного цикла; рабочие Google Sheets не меняются",
  freshness: null,
  sheets: [
    {
      gid: 1,
      name: "Коэффициенты · DEMO",
      maxRows: 248,
      lastColumn: "G",
      headers: [
        { cell: "A1", value: "UID" },
        { cell: "G1", value: "Коэффициент" },
      ],
      rules: [
        {
          id: "demo-coefficient",
          kind: "formula",
          column: "G",
          startRow: 246,
          endRow: 247,
          approval: "approved",
          when: { column: "A", notEmpty: true },
          templates: ["=C{row}/D{row}"],
          exceptions: [
            {
              rows: [246],
              templates: ["=SUM(C246)/D246"],
              reason:
                "Утверждённая альтернативная формула для контрольной строки",
            },
          ],
          result: { kind: "ratio", columns: ["C", "D"], tolerance: 0.000001 },
          impact:
            "Искажение тестового коэффициента; реальные KPI не затрагиваются",
        },
        {
          id: "demo-id",
          kind: "unique",
          column: "A",
          startRow: 246,
          endRow: 247,
          approval: "approved",
          when: { column: "C", notEmpty: true },
          exceptions: [],
          impact: "Потеря идентификатора тестовой записи",
        },
      ],
    },
  ],
};
const number = (n) => ({
  userEnteredValue: { numberValue: n },
  effectiveValue: { numberValue: n },
  formattedValue: String(n),
});
const text = (s) => ({
  userEnteredValue: { stringValue: s },
  effectiveValue: { stringValue: s },
  formattedValue: s,
});
const formula = (s, n) => ({
  userEnteredValue: { formulaValue: s },
  effectiveValue: { numberValue: n },
  formattedValue: String(n),
});
export function demoSpreadsheet(scenario = "healthy") {
  const target = formula("=C247/D247", 1.24);
  if (scenario === "missing") {
    delete target.userEnteredValue;
    delete target.effectiveValue;
    target.formattedValue = "";
  }
  if (scenario === "number") Object.assign(target, number(150));
  if (scenario === "mismatch")
    target.userEnteredValue.formulaValue = "=C247*D247";
  if (["ref", "div_zero"].includes(scenario)) {
    target.effectiveValue = {
      errorValue: {
        type: scenario === "ref" ? "REF" : "DIVIDE_BY_ZERO",
        message: "ДЕМОНСТРАЦИЯ: ошибка вычисления",
      },
    };
  }
  const spreadsheet = {
    spreadsheetId: "demo-only",
    properties: { title: DEMO_DOCUMENT.name },
    sheets: [
      {
        properties: {
          sheetId: 1,
          title: "Коэффициенты · DEMO",
          gridProperties: { rowCount: 248, columnCount: 7 },
        },
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowData: [
              {
                values: [text("UID"), {}, {}, {}, {}, {}, text("Коэффициент")],
              },
            ],
          },
          {
            startRow: 245,
            startColumn: 0,
            rowData: [
              {
                values: [
                  text("demo-246"),
                  {},
                  number(100),
                  number(100),
                  {},
                  {},
                  formula("=SUM(C246)/D246", 1),
                ],
              },
              {
                values: [
                  text("demo-247"),
                  {},
                  number(124),
                  number(100),
                  {},
                  {},
                  target,
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  if (scenario === "schema")
    spreadsheet.sheets[0].data[0].rowData[0].values[6] = text(
      "Изменённый заголовок",
    );
  return spreadsheet;
}
export class DemoFixture {
  constructor(dataDir) {
    this.file = path.join(dataDir, "table-doctor-demo.json");
  }
  read() {
    if (!fs.existsSync(this.file)) this.write("healthy");
    return JSON.parse(fs.readFileSync(this.file, "utf8"));
  }
  write(scenario) {
    if (
      ![
        "healthy",
        "missing",
        "number",
        "mismatch",
        "ref",
        "div_zero",
        "schema",
      ].includes(scenario)
    )
      throw new Error("Invalid demo scenario");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const payload = {
      demonstration: true,
      scenario,
      spreadsheet: demoSpreadsheet(scenario),
    };
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return payload;
  }
}
