// Browser QA only. All /api responses are intercepted with explicitly synthetic data.
// Never uses an owner secret or modifies a real source/agent database.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { IncidentStore } from "../agent/store.js";
import { FormulaIntelligence } from "../agent/formulaIntelligence.js";
const { chromium } = await import(
  pathToFileURL(process.env.RITM_QA_PLAYWRIGHT_MODULE).href
);
const doc = {
  id: "ui-synthetic",
  name: "ТЕСТ интерфейса — синтетический документ",
  documentId: "synthetic_document_not_google",
  adapter: "google",
  enabled: true,
  department: "ТЕСТ",
  sheets: [
    { gid: 7, name: "Тестовый лист", maxRows: 50, lastColumn: "M", rules: [] },
  ],
};
const store = new IncidentStore(":memory:"),
  at = new Date().toISOString();
const fi = new FormulaIntelligence(store, {
  doctorDocuments: [doc],
  snapshotMaxAgeMs: 1200000,
});
fi.inspect(
  doc,
  {
    sheets: [
      {
        properties: {
          sheetId: 7,
          title: "Тестовый лист",
          gridProperties: { rowCount: 50, columnCount: 13 },
        },
        merges: [],
        data: [
          {
            startRow: 10,
            startColumn: 12,
            rowData: Array.from({ length: 35 }, (_, i) => ({
              values: [
                {
                  userEnteredValue: { formulaValue: `=C${i + 11}/D${i + 11}` },
                  effectiveValue: { numberValue: 1.24 },
                },
              ],
            })),
          },
        ],
      },
    ],
  },
  true,
  at,
);
store.check(doc.id, { status: "ok" }, at);
const state = {
  ok: true,
  running: false,
  lastCheck: at,
  lastSuccessfulCheck: at,
  fastRunning: false,
  productionRepairEnabled: true,
  repairQueue: {
    awaitingConfirmation: 1,
    queued: 1,
    executing: 0,
    checking: 0,
    needsDecision: 0,
    fixedToday: 0,
    items: [
      {
        id: "synthetic-queued-operation",
        incidentId: "synthetic-incident",
        status: "queued",
        direction: "repair",
        sourceName: "ТЕСТ UI",
        target: {
          documentId: "synthetic",
          sheetId: 7,
          sheet: "Тестовый лист",
          cell: "M11",
        },
        createdAt: at,
        resultAt: null,
        errorCode: null,
        message: null,
      },
    ],
  },
  connection: "verified",
  formulasRead: 1,
  checkedFormulas: 0,
  demoEnabled: false,
  demoCheckedFormulas: 0,
  documents: [
    {
      ...doc,
      sourceUrl: null,
      pendingRules: 0,
      check: {
        status: "ok",
        at,
        message: "ТЕСТ UI",
        checkedFormulas: 0,
        issueCount: 0,
      },
      sheets: [
        {
          name: "Тестовый лист",
          gid: 7,
          purpose: "ТЕСТ",
          activeChecks: [],
          pendingChecks: [],
        },
      ],
    },
  ],
  formulaIntelligence: fi.state(),
};
const status = {
  ok: true,
  fetchedAt: at,
  agent: { status: "running" },
  controlledSources: 1,
  active: 0,
  resolved: 0,
  corrections: 0,
  recommendations: [],
  checks: [],
  notifications: { status: "not_configured", uncertain: 0, failed: 0 },
  lastCheck: at,
  config: {
    sources: [],
    telegram: "not_configured",
    formulaAccess: "verified",
    intervalSeconds: 600,
    deployment: "local",
  },
};
const output = process.env.RITM_QA_OUTPUT_DIR || ".checks/formula-ui";
const uiIncident = {
  id: "ui-card",
  kind: "table_doctor",
  type: "formula_number",
  sourceId: doc.id,
  sourceName: doc.name,
  sheet: "Тестовый лист",
  cell: "M11",
  department: "ТЕСТ",
  title: "ТЕСТ UI: формула заменена числом",
  observed: { entered: { numberValue: 150 } },
  expected: "=C11/D11",
  previousFormula: "=C11/D11",
  verification: "rule_confirmed",
  category: "confirmed_formula",
  status: "confirmed",
  monitorStatus: "open",
  severity: "high",
  firstSeen: at,
  lastSeen: at,
  occurrences: 1,
  sourceUrl: "",
  cause: "ТЕСТ: отличие от эталона; ручное редактирование — гипотеза",
  impact: "ТЕСТ: влияние на KPI не измерено",
  recommendation: "ТЕСТ: предложено восстановить =C11/D11",
};
const uiDataIncident = {
  id: "ui-data-quality",
  kind: "table_doctor",
  type: "data_quality_root_cause",
  sourceId: "doctor-shop-one",
  sourceName: "ТЕСТ OZON Первый магазин",
  sheet: "Товары НОВАЯ ПЕЧАТЬ 20.07.2026",
  gid: 1335787439,
  cell: "P5",
  sourceCell: "P5",
  sourceField: "Вид товара",
  sourceState: "missing",
  recoveryStatus: "candidate",
  department: "Сборка",
  title: "ТЕСТ: отсутствует Вид товара; затронуты AP27 и AP28",
  observed: {
    entered: null,
    field: "Вид товара",
    productKey: "SKU-1",
  },
  expected: "Заполненное поле «Вид товара» для активного товара",
  verification: "rule_confirmed",
  category: "source_data_quality",
  status: "confirmed",
  monitorStatus: "open",
  severity: "critical",
  firstSeen: at,
  lastSeen: at,
  occurrences: 1,
  sourceUrl: "",
  cause: "ТЕСТ: AP27/AP28 зависят от пустого P5 через C27/C28 и B27/B28",
  impact: "ТЕСТ: коэффициент упаковки может повлиять на KPI сборки",
  recommendation: "ТЕСТ: подтвердите точное значение и адрес отдельно",
  affectedCells: [
    { gid: 1580315960, sheet: "Рабочий лист", cell: "AP27", error: "N_A" },
    { gid: 1580315960, sheet: "Рабочий лист", cell: "C27", error: "N_A" },
    { gid: 1580315960, sheet: "Рабочий лист", cell: "B27", error: "N_A" },
    { gid: 1580315960, sheet: "Рабочий лист", cell: "AP28", error: "N_A" },
    { gid: 1580315960, sheet: "Рабочий лист", cell: "C28", error: "N_A" },
    { gid: 1580315960, sheet: "Рабочий лист", cell: "B28", error: "N_A" },
  ],
  errorCells: [
    { gid: 1580315960, sheet: "Рабочий лист", cell: "AP27", error: "N_A" },
    { gid: 1580315960, sheet: "Рабочий лист", cell: "AP28", error: "N_A" },
  ],
  recoveryCandidate: {
    status: "candidate",
    value: { stringValue: "Коробка" },
    observedAt: "2026-10-09T08:00:00.000Z",
    confirmation: "Подтверждаю P5: Коробка",
    evidence: "ТЕСТ: значение из предыдущего успешного снимка",
  },
  recoveryNote: "ТЕСТ: кандидат требует подтверждения владельца",
};
let sourceCandidate = true;
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.RITM_QA_BROWSER,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }),
  errors = [];
let approvals = 0,
  writes = 0,
  showIncident = false;
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") writes++;
    const url = new URL(route.request().url());
    let payload = { ok: true, rows: [], total: 0, page: 0, limit: 20 };
    if (url.pathname.endsWith("/status")) payload = status;
    else if (url.pathname.endsWith("/formula-repair"))
      payload = {
        ok: true,
        enabled: true,
        production: true,
        testOnly: false,
        isolation: {
          status: "unverified",
          message:
            "ТЕСТ интерфейса: право записи не проверено; Google не вызывается",
        },
        proposals: [
          {
            id: "synthetic-proposal",
            version: "synthetic-version",
            status: "pending",
            expired: false,
            direction: "repair",
            confirmation: "Подтверждаю M11: 150 → =C11/D11",
            limitation: "ТЕСТ: чтение и запись не атомарны",
            from: { numberValue: 150 },
            to: { formulaValue: "=C11/D11" },
            expectedResult: null,
            sourceName: "ТЕСТ UI",
            createdAt: at,
            expiresAt: Date.now() + 600000,
            target: {
              documentId: "synthetic",
              sheetId: 7,
              sheet: "ТЕСТ",
              cell: "M11",
            },
            events: [],
            result: null,
          },
        ],
      };
    else if (url.pathname.endsWith("/doctor")) payload = state;
    else if (url.pathname.endsWith("/incidents/ui-card"))
      payload = { ok: true, incident: uiIncident };
    else if (url.pathname.endsWith("/incidents/ui-data-quality"))
      payload = {
        ok: true,
        incident: sourceCandidate
          ? uiDataIncident
          : {
              ...uiDataIncident,
              recoveryCandidate: null,
              recoveryStatus: "needs_review",
              recoveryNote: "Предыдущее значение не найдено",
              recommendation: "Требует проверки; не восстанавливать по догадке",
            },
      };
    else if (
      url.pathname.endsWith("/incidents") &&
      showIncident &&
      ["active", "confirmed"].includes(url.searchParams.get("status"))
    ) {
      assert.equal(url.searchParams.has("kind"), false);
      payload = {
        ok: true,
        rows: [uiIncident, uiDataIncident],
        total: 2,
        page: 0,
        limit: 20,
      };
    } else if (url.pathname.includes("/formulas/regions/"))
      payload = {
        ok: true,
        ...fi.region(
          url.pathname.split("/").at(-1),
          url.searchParams.get("version"),
          {
            page: Number(url.searchParams.get("p")),
            size: Number(url.searchParams.get("limit")),
            search: url.searchParams.get("search") || "",
          },
        ),
      };
    else if (url.pathname.endsWith("/formulas/approve")) {
      approvals++;
      payload = fi.approve(route.request().postDataJSON());
    }
    await route.fulfill({ json: payload });
  });
  await page.goto("http://localhost:4318/?page=intelligence");
  await page
    .getByRole("heading", {
      name: "Контроль производственных таблиц",
      exact: true,
    })
    .waitFor();
  await page.getByRole("region", { name: "Очередь исправлений" }).waitFor();
  assert.equal(await page.getByText("В очереди", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Проверить сейчас" }).waitFor();
  assert.ok((await page.title()).includes("RITM"));
  const navigation = page.getByRole("group", { name: "Раздел AI Center" });
  assert.equal(await navigation.getByRole("button").count(), 3);
  assert.equal(
    await page
      .getByRole("heading", { name: "Formula Intelligence", exact: true })
      .isVisible(),
    false,
  );
  await page.evaluate(() => {
    const label = document.createElement("div");
    label.textContent =
      "ТЕСТ ИНТЕРФЕЙСА — синтетические данные, Google Sheets не изменяется";
    label.style.cssText =
      "position:fixed;bottom:0;left:220px;right:0;z-index:1000;padding:8px;background:#fff7ed;color:#92400e;text-align:center";
    document.body.append(label);
  });
  await page.screenshot({
    path: join(output, "00-monitoring.png"),
    fullPage: false,
  });
  showIncident = true;
  await page
    .getByText("ТЕСТ UI · Тестовый лист · M11", { exact: true })
    .waitFor({ timeout: 8000 }); // Main issue list refreshes from the API without reloading the page.
  await page
    .getByText(
      "ТЕСТ OZON Первый магазин · Товары НОВАЯ ПЕЧАТЬ 20.07.2026 · P5",
      {
        exact: true,
      },
    )
    .waitFor();
  await page
    .getByRole("button", { name: "Проверить источник", exact: true })
    .click();
  const dataDialog = page.getByRole("dialog", {
    name: "Проблема и предлагаемое действие",
  });
  await dataDialog
    .getByText("Качество исходных данных может повлиять на KPI сборки")
    .waitFor();
  await dataDialog.getByText("Рабочий лист!AP27", { exact: false }).waitFor();
  await dataDialog.getByText("Рабочий лист!AP28", { exact: false }).waitFor();
  const dataConfirmation = dataDialog.getByRole("button", {
    name: "Подтвердить значение и создать заявку",
    exact: true,
  });
  assert.equal(await dataConfirmation.isDisabled(), true);
  await dataDialog.getByRole("checkbox", { name: /P5 = Коробка/ }).check();
  assert.equal(await dataConfirmation.isEnabled(), true);
  await dataDialog.screenshot({
    path: join(output, "06-data-quality-confirmation.png"),
  });
  await page.keyboard.press("Escape");
  sourceCandidate = false;
  await page.reload();
  await page
    .getByRole("button", { name: "Контроль таблиц", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Проверить источник", exact: true })
    .click();
  const unknownDataDialog = page.getByRole("dialog", {
    name: "Проблема и предлагаемое действие",
  });
  await unknownDataDialog.getByText("Предыдущее значение неизвестно").waitFor();
  assert.equal(
    await unknownDataDialog
      .getByRole("button", {
        name: "Подтвердить значение и создать заявку",
      })
      .count(),
    0,
  );
  await unknownDataDialog.screenshot({
    path: join(output, "07-data-quality-needs-review.png"),
  });
  await page.keyboard.press("Escape");
  await page.getByText("Настроить защиту формул", { exact: true }).click();
  const panel = page.getByRole("region", {
    name: "Formula Intelligence",
    exact: true,
  });
  await panel
    .getByRole("heading", { name: "Formula Intelligence", exact: true })
    .waitFor();
  await page
    .getByText("в последнем цикле защищено эталонами 0 ячеек", { exact: false })
    .waitFor();
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: join(output, "01-candidates.png") });
  await panel
    .getByRole("button", { name: "Выбрать до 50 областей по фильтру" })
    .click();
  await panel
    .getByRole("button", { name: "Утвердить выбранные (1)", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Утверждение формульных областей",
  });
  assert.equal(
    await dialog
      .getByRole("button", { name: "Подтвердить эталоны" })
      .isDisabled(),
    true,
  );
  await dialog.screenshot({
    path: join(output, "02-owner-confirmation.png"),
  });
  await dialog.getByRole("checkbox").check();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Подтвердить эталоны" })
      .isEnabled(),
    true,
  );
  await page.keyboard.press("Escape"); // Owner never approves production or even this UI fixture.
  assert.equal(approvals, 0);
  await panel
    .getByRole("button", { name: "Тестовый лист", exact: false })
    .click();
  const detail = page.getByRole("dialog", { name: "Точные формулы области" });
  await detail.getByRole("link", { name: "M11", exact: true }).waitFor();
  await detail.getByLabel("Строк на странице").selectOption("50");
  await detail.getByRole("link", { name: "M45", exact: true }).waitFor();
  await detail.getByLabel("Поиск ячейки или формулы").fill("M11");
  await detail.getByRole("link", { name: "M11", exact: true }).waitFor();
  assert.ok((await detail.innerText()).includes("=C11/D11"));
  await detail.screenshot({ path: join(output, "03-exact-baseline.png") });
  await page.keyboard.press("Escape");
  const formulaState = state.formulaIntelligence;
  delete state.formulaIntelligence;
  await page.reload();
  await page
    .getByRole("button", { name: "Контроль таблиц", exact: true })
    .click();
  await page
    .getByText("текущий агент не сообщает состояние Formula Intelligence", {
      exact: false,
    })
    .waitFor();
  state.formulaIntelligence = formulaState;
  showIncident = true;
  await page
    .getByRole("button", { name: "Подтверждённые ошибки", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "ТЕСТ UI: формула заменена числом",
      exact: false,
    })
    .click();
  const incidentDialog = page.getByRole("dialog", {
    name: "Проблема и предлагаемое действие",
  });
  await incidentDialog
    .getByRole("button", { name: "Создать заявку на исправление", exact: true })
    .waitFor();
  assert.ok((await incidentDialog.innerText()).includes("150"));
  assert.ok((await incidentDialog.innerText()).includes("=C11/D11"));
  await incidentDialog.screenshot({
    path: join(output, "04-problem-card.png"),
  });
  await page.keyboard.press("Escape");
  state.productionRepairEnabled = true;
  uiIncident.baselineVersion = "synthetic-approved-version";
  await page.reload();
  await page
    .getByRole("button", { name: "Подтверждённые ошибки", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "ТЕСТ UI: формула заменена числом",
      exact: false,
    })
    .click();
  const confirmationPanel = page.getByRole("dialog", {
    name: "Проблема и предлагаемое действие",
  });
  await confirmationPanel
    .getByRole("heading", { name: "Исправление по твоему подтверждению" })
    .waitFor();
  const confirmRepair = confirmationPanel.getByRole("button", {
    name: "Подтвердить 150 → =C11/D11",
    exact: true,
  });
  assert.equal(await confirmRepair.isDisabled(), true);
  await confirmationPanel.getByRole("checkbox").check();
  assert.equal(await confirmRepair.isEnabled(), true);
  await confirmationPanel.screenshot({
    path: join(output, "05-specific-repair-confirmation.png"),
  });
  // Do not press confirm: this verifies the UI gate, not a real Google write.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page
    .getByText("Дополнительные инструменты и технические сведения", {
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Обзор состояния", exact: true })
    .waitFor();
  assert.equal(writes, 0);
  assert.deepEqual(errors, []);
  const report = {
    demonstration: true,
    approvalsSubmitted: approvals,
    pageErrors: errors,
    checks: [
      "candidate coverage visible",
      "three primary tabs and advanced setup collapsed by default",
      "repair queue and queued status visible on the main screen",
      "new incident appears without reloading the page",
      "data-quality root cause groups AP27/AP28 and explains KPI impact",
      "exact source value confirmation is required before a local request; no write submitted",
      "unknown historical source value stays marked as requiring review",
      "all incident kinds allowed; readable problem card and request-only action",
      "bulk selection",
      "acknowledgement required",
      "exact formula page size changes",
      "exact formula search M11",
      "missing backend and zero protection are explicitly disclosed",
      "no production requests or writes",
      "specific formula repair confirmation requires explicit acknowledgement; no write submitted",
    ],
  };
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  store.close();
}
