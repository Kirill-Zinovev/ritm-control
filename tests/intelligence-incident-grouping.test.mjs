import test from "node:test";
import assert from "node:assert/strict";
import { IncidentStore } from "../agent/store.js";

function calculationFinding(cell, formula, message, rowContext) {
  return {
    kind: "table_doctor",
    sourceId: "doctor-roll-printing",
    sourceName: "OZON РУЛОННАЯ ПЕЧАТЬ",
    department: "printing",
    sheet: "OZON МОСКВА 10_10",
    gid: 119710351,
    cell,
    type: "calculation_error",
    severity: "warning",
    title: "Ошибка вычисления Google Sheets",
    observed: { formula, error: "N_A", message },
    cause: "Одна формула вернула ошибку.",
    impact: "Влияние на KPI не измерено.",
    verification: "needs_review",
    initialStatus: "review",
    rowContext,
    sourceUrl: `https://docs.google.com/spreadsheets/d/example/edit#gid=119710351&range=${cell}`,
  };
}

test("same proven VLOOKUP root groups J/K symptoms; independent P divide error stays separate", () => {
  const store = new IncidentStore(":memory:");
  try {
    const key = "CT0009.A0190",
      message = `Did not find value '${key}' in VLOOKUP evaluation.`,
      context = {
        row: 14,
        state: "filled",
        cells: {
          E: { value: key, formula: null, error: null },
          F: {
            value: null,
            formula: "=VLOOKUP(E:E;'БДО'!B:F;5;0)",
            error: "N_A",
          },
          J: { value: null, formula: "=F14*H14*I14*O14", error: "N_A" },
          K: { value: null, formula: "=F14*H14*I14*Q14", error: "N_A" },
          P: { value: null, formula: "=O14/M14", error: "DIVIDE_BY_ZERO" },
        },
      };
    store.reconcile("doctor:formula:doctor-roll-printing:119710351", [
      calculationFinding("J14", "=F14*H14*I14*O14", message, context),
      calculationFinding("K14", "=F14*H14*I14*Q14", message, context),
      calculationFinding(
        "P14",
        "=O14/M14",
        "Function DIVIDE parameter 2 cannot be zero.",
        context,
      ),
    ]);

    const page = store.listIncidents({ status: "active", limit: 20 }),
      summary = store.incidentSummary();
    assert.equal(page.total, 2);
    assert.equal(page.rows.length, 2);
    const grouped = page.rows.find((row) => row.groupedRootCause);
    assert.ok(grouped);
    assert.equal(grouped.groupedRootCause.rootCell, "F14");
    assert.deepEqual(
      grouped.groupedRootCause.affectedCells.map((cell) => cell.cell),
      ["J14", "K14"],
    );
    assert.match(grouped.sourceUrl, /range=F14$/);
    assert.equal(
      page.rows.find((row) => row.cell === "P14").groupedRootCause,
      undefined,
    );
    assert.equal(summary.allProblems, 2);
    assert.equal(summary.calculationError, 2);
    assert.equal(summary.needsReview, 2);
  } finally {
    store.close();
  }
});

test("matching lookup text without a shared errored lookup dependency is not grouped", () => {
  const store = new IncidentStore(":memory:");
  try {
    const key = "CT0009.A0190",
      message = `Did not find value '${key}' in VLOOKUP evaluation.`,
      context = {
        row: 14,
        state: "filled",
        cells: {
          E: { value: key, formula: null, error: null },
          F: { value: null, formula: null, error: "N_A" },
        },
      };
    store.reconcile("doctor:formula:test", [
      calculationFinding("J14", "=NA()", message, context),
      calculationFinding("K14", "=NA()", message, context),
    ]);
    assert.equal(store.listIncidents({ status: "active" }).total, 2);
    assert.equal(store.incidentSummary().allProblems, 2);
  } finally {
    store.close();
  }
});

test("active incidents sort critical/high risk before newer lower-priority findings", () => {
  const store = new IncidentStore(":memory:");
  try {
    const finding = (cell, severity, lastSeen, verified = false) => ({
      ...calculationFinding(cell, "=NA()", "Calculation failed", null),
      severity,
      lastSeen,
      kpiImpactVerified: verified,
    });
    store.reconcile("doctor:priority", [
      finding("J2", "low", "2026-10-14T12:00:00.000Z"),
      finding("J3", "critical", "2026-10-13T12:00:00.000Z"),
      finding("J4", "high", "2026-10-14T11:00:00.000Z", true),
      finding("J5", "medium", "2026-10-14T11:30:00.000Z"),
    ]);

    const rows = store.listIncidents({ status: "active" }).rows;
    assert.deepEqual(rows.map((row) => row.severity), [
      "critical",
      "high",
      "medium",
      "low",
    ]);
  } finally {
    store.close();
  }
});
