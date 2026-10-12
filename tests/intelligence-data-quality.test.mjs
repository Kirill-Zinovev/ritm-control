import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseDataQuality } from "../agent/dataQuality.js";
import { PRODUCTION_DOCTOR_DOCUMENTS } from "../agent/productionRegistry.js";
import { IncidentStore } from "../agent/store.js";

const document = structuredClone(
  PRODUCTION_DOCTOR_DOCUMENTS.find((item) => item.id === "doctor-shop-one"),
);
const formulaSet = (row) => ({
  ["AP" + row]: {
    userEnteredValue: { formulaValue: `=C${row}*1` },
    effectiveValue: { errorValue: { type: "N_A", message: "Synthetic chain" } },
  },
  ["C" + row]: {
    userEnteredValue: { formulaValue: `=B${row}*1` },
    effectiveValue: { errorValue: { type: "N_A", message: "Synthetic chain" } },
  },
  ["B" + row]: {
    userEnteredValue: {
      formulaValue: "='Товары НОВАЯ ПЕЧАТЬ 20.07.2026'!P5",
    },
    effectiveValue: { errorValue: { type: "N_A", message: "Synthetic chain" } },
  },
});

function sheet(gid, title, rowCount, columnCount, entries) {
  const rows = Array.from({ length: rowCount }, () => ({
    values: Array.from({ length: columnCount }, () => ({})),
  }));
  for (const [address, value] of Object.entries(entries)) {
    const [, letters, row] = address.match(/^([A-Z]+)(\d+)$/),
      column =
        [...letters].reduce(
          (number, letter) => number * 26 + letter.charCodeAt(0) - 64,
          0,
        ) - 1;
    rows[Number(row) - 1].values[column] = value;
  }
  return {
    properties: {
      sheetId: gid,
      title,
      gridProperties: { rowCount, columnCount },
    },
    data: [{ startRow: 0, startColumn: 0, rowData: rows }],
  };
}

function spreadsheet({
  productKind = null,
  active = true,
  errors = true,
  productKey = "SKU-1",
} = {}) {
  const working = {
    A27: {
      userEnteredValue: { stringValue: productKey },
      effectiveValue: { stringValue: productKey },
    },
    A28: {
      userEnteredValue: { stringValue: productKey },
      effectiveValue: { stringValue: productKey },
    },
    J27: { effectiveValue: { stringValue: productKey } },
    J28: { effectiveValue: { stringValue: productKey } },
    AA27: {
      userEnteredValue: { numberValue: active ? 5 : 0 },
      effectiveValue: { numberValue: active ? 5 : 0 },
    },
    AA28: {
      userEnteredValue: { numberValue: active ? 3 : 0 },
      effectiveValue: { numberValue: active ? 3 : 0 },
    },
  };
  if (errors) {
    Object.assign(working, formulaSet(27), formulaSet(28));
  } else {
    for (const row of [27, 28]) {
      working["AP" + row] = {
        userEnteredValue: { formulaValue: `=C${row}*1` },
        effectiveValue: { numberValue: 2 },
      };
      working["C" + row] = {
        userEnteredValue: { formulaValue: `=B${row}*1` },
        effectiveValue: { numberValue: 2 },
      };
      working["B" + row] = {
        userEnteredValue: {
          formulaValue: "='Товары НОВАЯ ПЕЧАТЬ 20.07.2026'!P5",
        },
        effectiveValue: { numberValue: 2 },
      };
    }
  }
  const catalog = {
    A5: {
      userEnteredValue: { stringValue: productKey },
      effectiveValue: { stringValue: productKey },
    },
  };
  if (productKind !== null) {
    catalog.P5 = {
      userEnteredValue: { stringValue: productKind },
      effectiveValue: { stringValue: productKind },
    };
  }
  return {
    sheets: [
      sheet(1580315960, document.sheets[0].name, 28, 50, working),
      sheet(1335787439, document.sheets[1].name, 5, 26, catalog),
    ],
  };
}

test("required coefficient source keeps P=Вид separate from Q=Вид товара", () => {
  const rule = document.dataQuality[0];
  assert.equal(rule.source.fieldColumn, "P");
  assert.equal(rule.source.fieldLabel, "Вид");
  assert.equal(rule.source.relatedFieldColumn, "Q");
  assert.equal(rule.source.relatedFieldLabel, "Вид товара");
  assert.equal(rule.production.outputGuardColumn, "AN");
});

test("groups AP27/AP28 dependency errors under one missing product-kind root", () => {
  const current = spreadsheet(),
    original = JSON.stringify(current),
    result = diagnoseDataQuality(
      document,
      current,
      null,
      new Date("2026-10-10T08:00:00Z"),
    );
  assert.equal(result.complete, true);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.type, "data_quality_root_cause");
  assert.equal(finding.category, "source_data_quality");
  assert.equal(finding.sheet, document.sheets[1].name);
  assert.equal(finding.cell, "P5");
  assert.deepEqual(
    finding.errorCells.map((cell) => cell.cell),
    ["B27", "C27", "AP27", "B28", "C28", "AP28"].sort(),
  );
  assert.ok(finding.affectedCells.some((cell) => cell.cell === "AP27"));
  assert.ok(finding.affectedCells.some((cell) => cell.cell === "AP28"));
  assert.equal(finding.recoveryStatus, "needs_review");
  assert.equal(finding.recoveryCandidate, null);
  assert.match(finding.recommendation, /Требует проверки/);
  assert.match(finding.impact, /влияние на KPI не измерено/);
  assert.equal(
    JSON.stringify(current),
    original,
    "diagnostics must not edit cells",
  );
});

test("traces the real whole-column lookups from AP27/AP28 through B:B and A:A to catalog P5", () => {
  const actualFormulas = (productKind = null, errors = true) => {
    const current = spreadsheet({ productKind, errors });
    for (const row of [27, 28]) {
      const active = current.sheets[0].data[0].rowData[row - 1].values;
      active[0] = {
        userEnteredValue: { stringValue: "SKU-1" },
        effectiveValue: { stringValue: "SKU-1" },
      };
      active[1] = {
        userEnteredValue: {
          formulaValue:
            "=VLOOKUP(A:A;'Товары НОВАЯ ПЕЧАТЬ 20.07.2026'!A:P;16;0)",
        },
        effectiveValue: errors
          ? { errorValue: { type: "N_A", message: "Missing product kind" } }
          : { stringValue: productKind },
      };
      active[2] = {
        userEnteredValue: {
          formulaValue: "=VLOOKUP(B:B;'Нормы'!A:C;3;0)",
        },
        effectiveValue: errors
          ? { errorValue: { type: "N_A", message: "Missing norm" } }
          : { numberValue: 250 },
      };
      active[41] = {
        userEnteredValue: {
          formulaValue: `=IF(AN${row}>\"\";AR${row}/C${row};\"\")`,
        },
        effectiveValue: errors
          ? { errorValue: { type: "N_A", message: "Broken coefficient" } }
          : { numberValue: row === 27 ? 0.196 : 0.08 },
      };
      active[39] = {
        userEnteredValue: { stringValue: "Оператор" },
        effectiveValue: { stringValue: "Оператор" },
      };
      active[43] = {
        userEnteredValue: { numberValue: row === 27 ? 49 : 20 },
        effectiveValue: { numberValue: row === 27 ? 49 : 20 },
      };
    }
    return current;
  };
  const healthy = diagnoseDataQuality(
      document,
      actualFormulas("Елочные игрушки", false),
      null,
      new Date("2026-10-09T08:00:00Z"),
    ),
    result = diagnoseDataQuality(
      document,
      actualFormulas(),
      healthy.snapshot,
      new Date("2026-10-10T08:00:00Z"),
    );
  assert.equal(healthy.findings.length, 0);
  assert.deepEqual(healthy.snapshot.cells.P5.current, {
    stringValue: "Елочные игрушки",
  });
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.cell, "P5");
  assert.equal(finding.sourceState, "missing");
  assert.deepEqual(finding.errorCells.map((cell) => cell.cell).sort(), [
    "AP27",
    "AP28",
    "B27",
    "B28",
    "C27",
    "C28",
  ]);
  assert.deepEqual(finding.recoveryCandidate.value, {
    stringValue: "Елочные игрушки",
  });
  assert.equal(
    finding.recoveryCandidate.confirmation,
    "Подтверждаю P5: Елочные игрушки",
  );
});

test("does not report intentionally blank catalog or inactive production rows", () => {
  const inactive = diagnoseDataQuality(
    document,
    spreadsheet({ active: false }),
  );
  assert.deepEqual(inactive.findings, []);
  assert.equal(inactive.complete, true);

  const noCatalogKey = spreadsheet();
  noCatalogKey.sheets[1].data[0].rowData[4].values[0] = {};
  const missingOptionalProduct = diagnoseDataQuality(document, noCatalogKey);
  assert.deepEqual(missingOptionalProduct.findings, []);
  assert.equal(missingOptionalProduct.complete, false);
});

test("a previous successful snapshot supplies a candidate, but never auto-restores it", () => {
  const first = diagnoseDataQuality(
      document,
      spreadsheet({ productKind: "Коробка", errors: false }),
      null,
      new Date("2026-10-09T08:00:00Z"),
    ),
    current = diagnoseDataQuality(
      document,
      spreadsheet({ errors: true }),
      first.snapshot,
      new Date("2026-10-10T08:00:00Z"),
    );
  assert.equal(first.findings.length, 0);
  assert.equal(current.findings.length, 1);
  assert.deepEqual(current.findings[0].recoveryCandidate.value, {
    stringValue: "Коробка",
  });
  assert.equal(
    current.findings[0].recoveryCandidate.observedAt,
    "2026-10-09T08:00:00.000Z",
  );
  assert.match(
    current.findings[0].recommendation,
    /отдельного подтверждения владельца/,
  );
  assert.equal(current.findings[0].recoveryStatus, "candidate");
});

test("formula-backed populated source uses its effective value and is never offered as a literal repair", () => {
  const current = spreadsheet({ productKind: "Коробка", errors: false }),
    source = current.sheets[1].data[0].rowData[4].values;
  source[15] = {
    userEnteredValue: { formulaValue: "=VLOOKUP(A5;Cash!A:E;5;0)" },
    effectiveValue: { stringValue: "Коробка" },
  };
  const healthy = diagnoseDataQuality(
      document,
      current,
      null,
      new Date("2026-10-09T08:00:00Z"),
    ),
    failed = structuredClone(current);
  assert.deepEqual(healthy.findings, []);
  assert.deepEqual(healthy.snapshot.cells.P5.current, {
    stringValue: "Коробка",
  });
  assert.equal(healthy.snapshot.cells.P5.currentOrigin, "formula_result");
  assert.equal(healthy.snapshot.cells.P5.history[0].origin, "formula_result");

  failed.sheets[1].data[0].rowData[4].values[15].effectiveValue = {
    errorValue: { type: "N_A", message: "Cash lookup failed" },
  };
  for (const row of [27, 28])
    failed.sheets[0].data[0].rowData[row - 1].values[1].effectiveValue = {
      errorValue: { type: "N_A", message: "Missing product kind" },
    };
  const result = diagnoseDataQuality(
    document,
    failed,
    healthy.snapshot,
    new Date("2026-10-10T08:00:00Z"),
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].sourceState, "dependent_formula_error");
  assert.equal(result.findings[0].severity, "high");
  assert.equal(result.findings[0].observed.effective, null);
  assert.equal(result.findings[0].recoveryCandidate, null);
});

test("missing source incident closes after a formula-backed value and full dependency chain recover", () => {
  const store = new IncidentStore(":memory:"),
    missing = diagnoseDataQuality(document, spreadsheet()),
    scope = "doctor:data-quality:" + document.id;
  try {
    store.reconcile(scope, missing.findings, {
      verified: missing.complete,
      at: "2026-10-10T08:00:00.000Z",
    });
    const id = store.listIncidents({ status: "active" }).rows[0].id,
      restored = spreadsheet({ productKind: "Коробка", errors: false });
    restored.sheets[1].data[0].rowData[4].values[15] = {
      userEnteredValue: { formulaValue: "=VLOOKUP(A5;Cash!A:E;5;0)" },
      effectiveValue: { stringValue: "Коробка" },
    };
    const checked = diagnoseDataQuality(
      document,
      restored,
      missing.snapshot,
      new Date("2026-10-12T08:00:00.000Z"),
    );
    assert.equal(checked.complete, true);
    assert.deepEqual(checked.findings, []);
    store.reconcile(scope, checked.findings, {
      verified: checked.complete,
      at: "2026-10-12T08:00:00.000Z",
      resolution: {
        cause: "Значение P5 и расчёт коэффициента подтверждены",
        evidence: { kind: "successful_read_only_dependency_check" },
      },
    });
    assert.equal(store.listIncidents({ status: "active" }).total, 0);
    const closed = store.getIncident(id);
    assert.equal(closed.monitorStatus, "resolved");
    assert.equal(closed.lifecycleState, "resolved");
    assert.equal(closed.resolutionAt, "2026-10-12T08:00:00.000Z");
    assert.match(closed.resolutionCause, /P5/);
    assert.equal(store.history(0, 20).rows[0].type, "incident_resolved");
  } finally {
    store.close();
  }
});

test("blank output guarded by an empty production marker is not a KPI incident", () => {
  const current = spreadsheet({ errors: true });
  for (const row of [27, 28]) {
    const cells = current.sheets[0].data[0].rowData[row - 1].values;
    cells[41] = {
      userEnteredValue: {
        formulaValue: `=IF(AN${row}>\"\";AR${row}/C${row};\"\")`,
      },
      effectiveValue: { stringValue: "" },
    };
  }
  const result = diagnoseDataQuality(document, current);
  assert.deepEqual(result.findings, []);
  assert.equal(result.complete, true);
});

test("filled sources with errors or unknown results remain open, then resolve after a verified coefficient", () => {
  const store = new IncidentStore(":memory:");
  try {
    const missing = diagnoseDataQuality(document, spreadsheet());
    store.reconcile("doctor:data-quality:" + document.id, missing.findings, {
      verified: missing.complete,
    });
    const id = store.listIncidents({ status: "active" }).rows[0].id;
    const restoredButStale = diagnoseDataQuality(
      document,
      spreadsheet({ productKind: "Коробка", errors: true }),
      missing.snapshot,
    );
    assert.equal(restoredButStale.findings.length, 1);
    assert.equal(
      restoredButStale.findings[0].sourceState,
      "dependent_formula_error",
    );
    assert.match(restoredButStale.findings[0].title, /Источник заполнен/);
    assert.doesNotMatch(restoredButStale.findings[0].title, /Отсутствует/);
    assert.match(restoredButStale.findings[0].impact, /не измерено/);
    store.reconcile(
      "doctor:data-quality:" + document.id,
      restoredButStale.findings,
      {
        verified: restoredButStale.complete,
      },
    );
    assert.equal(store.listIncidents({ status: "active" }).rows[0].id, id);

    const awaitingCoefficient = spreadsheet({
      productKind: "Коробка",
      errors: false,
    });
    awaitingCoefficient.sheets[0].data[0].rowData[26].values[41].effectiveValue =
      {
        stringValue: "",
      };
    const waiting = diagnoseDataQuality(
      document,
      awaitingCoefficient,
      restoredButStale.snapshot,
    );
    assert.equal(waiting.findings.length, 1);
    assert.equal(waiting.findings[0].sourceState, "insufficient_data");
    assert.match(waiting.findings[0].title, /результат расчёта не подтверждён/);
    assert.match(waiting.findings[0].cause, /нельзя определить/);
    assert.match(waiting.findings[0].recommendation, /нельзя отличить/);
    assert.equal(waiting.findings[0].recoveryStatus, "needs_review");
    assert.deepEqual(waiting.findings[0].errorCells, []);
    store.reconcile("doctor:data-quality:" + document.id, waiting.findings, {
      verified: waiting.complete,
    });
    assert.equal(store.listIncidents({ status: "active" }).rows[0].id, id);

    const verified = diagnoseDataQuality(
      document,
      spreadsheet({ productKind: "Коробка", errors: false }),
      waiting.snapshot,
      new Date("2026-10-11T08:00:00Z"),
    );
    store.reconcile("doctor:data-quality:" + document.id, verified.findings, {
      verified: verified.complete,
      at: "2026-10-11T08:00:00.000Z",
      resolution: {
        cause: "Свежая проверка подтвердила значение и коэффициент",
        evidence: { kind: "test_read_only_snapshot" },
      },
    });
    assert.equal(store.listIncidents({ status: "active" }).total, 0);
    assert.equal(store.listIncidents({ status: "fixed" }).total, 1);
    const closed = store.getIncident(id);
    assert.equal(closed.lifecycleState, "resolved");
    assert.equal(
      closed.resolutionCause,
      "Свежая проверка подтвердила значение и коэффициент",
    );
    assert.equal(closed.resolutionAt, "2026-10-11T08:00:00.000Z");
    assert.equal(closed.monitorStatus, "resolved");
  } finally {
    store.close();
  }
});

test("most recently discovered incidents stay above older severe incidents", () => {
  const store = new IncidentStore(":memory:");
  try {
    store.reconcile(
      "doctor:data-quality:ordering-old",
      [
        {
          kind: "table_doctor",
          sourceId: "doctor-shop-one",
          type: "data_quality_root_cause",
          severity: "critical",
          title: "Старая критическая проблема",
          sourceCell: "P41",
          cell: "P41",
          observed: { productKey: "OLD" },
          initialStatus: "confirmed",
        },
      ],
      { verified: true, at: "2026-10-10T08:00:00.000Z" },
    );
    store.reconcile(
      "doctor:data-quality:ordering-new",
      [
        {
          kind: "table_doctor",
          sourceId: "doctor-shop-one",
          type: "data_quality_root_cause",
          severity: "medium",
          title: "Новая проблема",
          sourceCell: "P54",
          cell: "P54",
          observed: { productKey: "NEW" },
          initialStatus: "confirmed",
        },
      ],
      { verified: true, at: "2026-10-12T08:00:00.000Z" },
    );
    const rows = store.listIncidents({ status: "active" }).rows;
    assert.equal(rows[0].title, "Новая проблема");
    assert.equal(rows[1].title, "Старая критическая проблема");
  } finally {
    store.close();
  }
});

test("incident dispatcher counts source states and keeps verified resolutions separate", () => {
  const store = new IncidentStore(":memory:"),
    missing = diagnoseDataQuality(document, spreadsheet());
  try {
    store.reconcile("doctor:data-quality:" + document.id, missing.findings, {
      verified: missing.complete,
    });
    const active = store.incidentSummary();
    assert.equal(active.allProblems, 1);
    assert.equal(active.critical, 1);
    assert.equal(active.missingSource, 1);
    assert.equal(active.calculationError, 1);
    assert.equal(active.needsReview, 1);
    assert.equal(active.fixed, 0);
    assert.equal(
      store.listIncidents({ status: "active", group: "missing_source" }).total,
      1,
    );

    const restored = diagnoseDataQuality(
      document,
      spreadsheet({ productKind: "Коробка", errors: false }),
      missing.snapshot,
    );
    store.reconcile("doctor:data-quality:" + document.id, restored.findings, {
      verified: restored.complete,
    });
    const closed = store.incidentSummary();
    assert.equal(closed.allProblems, 0);
    assert.equal(closed.fixed, 1);
    assert.equal(store.listIncidents({ status: "fixed" }).total, 1);
  } finally {
    store.close();
  }
});

test("resolved structure observations are not presented as repaired incidents", () => {
  const store = new IncidentStore(":memory:"),
    incident = {
      kind: "table_doctor",
      sourceId: "doctor-shop-one",
      type: "structure_changed",
      severity: "warning",
      title: "Изменена структура листа",
      verification: "needs_review",
      initialStatus: "review",
    };
  try {
    store.reconcile("doctor:structure", [incident], { verified: true });
    store.reconcile("doctor:structure", [], { verified: true });
    assert.equal(store.listIncidents({ status: "fixed" }).total, 0);
    assert.equal(store.incidentSummary().fixed, 0);
  } finally {
    store.close();
  }
});

test("dispatcher search matches product keys and exact root cells, not dependency details", () => {
  const store = new IncidentStore(":memory:");
  try {
    store.reconcile(
      "doctor:data-quality:search",
      [
        {
          kind: "table_doctor",
          sourceId: "doctor-shop-one",
          type: "data_quality_root_cause",
          severity: "critical",
          title: "Проверить источник",
          sourceCell: "P68",
          cell: "P68",
          observed: { productKey: "SKU-68", entered: { stringValue: "Вид" } },
          affectedCells: [
            { sheet: "Первый магазин", cell: "AP68" },
            { sheet: "Каталог", cell: "P54" },
          ],
          initialStatus: "confirmed",
        },
        {
          kind: "table_doctor",
          sourceId: "doctor-shop-one",
          type: "data_quality_root_cause",
          severity: "critical",
          title: "Проверить источник",
          sourceCell: "P54",
          cell: "P54",
          observed: { productKey: "SKU-54", entered: null },
          affectedCells: [{ sheet: "Первый магазин", cell: "AP54" }],
          initialStatus: "confirmed",
        },
      ],
      { verified: true },
    );
    const exactCell = store.listIncidents({ status: "active", search: "P54" });
    assert.equal(exactCell.total, 1);
    assert.equal(exactCell.rows[0].cell, "P54");
    const product = store.listIncidents({ status: "active", search: "sku-68" });
    assert.equal(product.total, 1);
    assert.equal(product.rows[0].cell, "P68");
  } finally {
    store.close();
  }
});

test("unknown dependency paths cannot close an existing root incident", () => {
  const store = new IncidentStore(":memory:"),
    missing = diagnoseDataQuality(document, spreadsheet());
  store.reconcile("doctor:data-quality:" + document.id, missing.findings, {
    verified: missing.complete,
  });
  const broken = spreadsheet();
  broken.sheets[0].data[0].rowData[26].values[41] = {
    userEnteredValue: { formulaValue: "=NOW()" },
    effectiveValue: { errorValue: { type: "N_A", message: "Synthetic" } },
  };
  const result = diagnoseDataQuality(document, broken);
  assert.equal(result.complete, false);
  assert.equal(result.findings.length, 1);
  store.reconcile("doctor:data-quality:" + document.id, result.findings, {
    verified: result.complete,
  });
  assert.equal(store.listIncidents({ status: "active" }).total, 1);
  store.close();
});

test("source recovery requires the exact owner-confirmed cell and value and stores no write", () => {
  const first = diagnoseDataQuality(
      document,
      spreadsheet({ productKind: "Коробка", errors: false }),
      null,
      new Date("2026-10-09T08:00:00Z"),
    ),
    result = diagnoseDataQuality(
      document,
      spreadsheet(),
      first.snapshot,
      new Date("2026-10-10T08:00:00Z"),
    ),
    finding = result.findings[0],
    store = new IncidentStore(":memory:");
  try {
    store.reconcile("doctor:data-quality:" + document.id, [finding]);
    const incident = store.listIncidents({ status: "active" }).rows[0];
    assert.equal(
      store.incidentAction(incident.id, "request-repair", undefined, {
        sourceCell: "P6",
        value: finding.recoveryCandidate.value,
        confirmation: finding.recoveryCandidate.confirmation,
      }),
      null,
    );
    assert.equal(
      store.incidentAction(incident.id, "request-repair", undefined, {
        sourceCell: finding.cell,
        value: { stringValue: "Другой вид" },
        confirmation: finding.recoveryCandidate.confirmation,
      }),
      null,
    );
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM repair_requests").get().n,
      0,
    );

    const confirmed = store.incidentAction(
      incident.id,
      "request-repair",
      undefined,
      {
        sourceCell: finding.cell,
        value: finding.recoveryCandidate.value,
        confirmation: finding.recoveryCandidate.confirmation,
      },
    );
    assert.ok(confirmed);
    const request = JSON.parse(
      store.db.prepare("SELECT payload FROM repair_requests").get().payload,
    );
    assert.equal(request.ownerConfirmation.sourceCell, "P5");
    assert.deepEqual(request.ownerConfirmation.value, {
      stringValue: "Коробка",
    });
    assert.equal(request.ownerConfirmation.googleSheetsChanged, false);
    assert.equal(store.incidentAction(incident.id, "ignore"), null);
  } finally {
    store.close();
  }
});
