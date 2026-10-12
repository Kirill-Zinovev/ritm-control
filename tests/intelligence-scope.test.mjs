import test from "node:test";
import assert from "node:assert/strict";
import { IncidentStore } from "../agent/store.js";
import { PRODUCTION_DOCTOR_DOCUMENTS as docs } from "../agent/productionRegistry.js";
import { businessPreview } from "../agent/businessDoctor.js";
import { readDoctorSheet } from "../agent/doctorRead.js";
import { validateDoctorDocuments } from "../agent/doctorRegistry.js";
const source = [{ id: "assembly-fbo", documentId: docs[0].documentId }];
const finding = (sheet, kind = "table_doctor", sourceId = "doctor-fbo") => ({
  kind,
  sourceId,
  sheet,
  cell: "E1",
  type: "calculation_error",
  title: "Synthetic error",
  verification: "needs_review",
  initialStatus: "review",
});
test("exact production scope is three documents/seven distinct ID pairs and KPI history is not a doctor sheet", () => {
  assert.equal(docs.length, 3);
  assert.equal(
    new Set(
      docs.flatMap((d) => d.sheets.map((s) => d.documentId + ":" + s.gid)),
    ).size,
    7,
  );
  assert.ok(!docs[0].sheets.some((s) => s.name === "История производства"));
  assert.ok(
    docs
      .flatMap((d) => d.sheets)
      .flatMap((s) => s.businessChecks || [])
      .every((r) => r.approval === "pending"),
  );
});
test("scope removes old issue from active list without resolving/deleting it or its history, cancels notification, persists idempotently", () => {
  const store = new IncidentStore(":memory:");
  store.reconcile("doctor:data:doctor-fbo", [finding("Исключённый лист")]);
  const id = store.listIncidents().rows[0].id;
  store.setMonitoringScope(docs, source);
  const count = store.history().total;
  assert.equal(store.getIncident(id).status, "out_of_scope");
  assert.equal(store.getIncident(id).resolvedAt, null);
  assert.equal(store.overview().active, 0);
  assert.equal(store.overview().resolved, 0);
  store.setMonitoringScope(docs, source);
  assert.equal(store.history().total, count);
  store.reconcile("doctor:data:doctor-fbo", [finding("Исключённый лист")]);
  assert.equal(store.listIncidents().total, 1);
  assert.equal(store.getIncident(id).occurrences, 1);
  store.close();
});
test("KPI dependencies remain readable but cannot reintroduce cell incidents outside scope", () => {
  const store = new IncidentStore(":memory:");
  store.setMonitoringScope(docs, source);
  store.reconcile("assembly-fbo:data", [
    finding("История производства", undefined, "assembly-fbo"),
    finding("Все коэффициенты", undefined, "assembly-fbo"),
  ]);
  assert.equal(store.listIncidents().total, 1);
  store.snapshot("assembly-fbo", { history: [{ coefficient: 1.24 }] });
  assert.equal(
    store.getSnapshot("assembly-fbo").value.history[0].coefficient,
    1.24,
  );
  store.close();
});
test("sheet filter is exact, active excludes archive, and out-of-scope actions cannot request repair", () => {
  const store = new IncidentStore(":memory:");
  store.reconcile("doctor:data:doctor-fbo", [
    finding("Excluded"),
    finding("Все коэффициенты"),
  ]);
  store.setMonitoringScope(docs, source);
  assert.equal(store.listIncidents({ status: "active" }).total, 1);
  assert.equal(store.listIncidents({ sheet: "Все коэффициенты" }).total, 1);
  const archived = store.listIncidents({ status: "out_of_scope" }).rows[0];
  assert.equal(store.incidentAction(archived.id, "request-repair"), null);
  store.close();
});
test("sequential chunks cover entire sheet without overlap and preserve grid offsets", async () => {
  const ranges = [];
  const reader = {
    grid: async (_, r) => {
      ranges.push(r[0]);
      const first = Number(r[0].match(/!A(\d+)/)[1]);
      return {
        sheets: [
          {
            properties: { sheetId: 1, title: "S" },
            data: [
              {
                startRow: first - 1,
                rowData: [
                  { values: [{ effectiveValue: { numberValue: first } }] },
                ],
              },
            ],
          },
        ],
      };
    },
  };
  const r = await readDoctorSheet(
    reader,
    "id",
    { gid: 1, maxRows: 450, lastColumn: "AX", chunkRows: 200 },
    { properties: { title: "S", gridProperties: { rowCount: 420 } } },
  );
  assert.deepEqual(ranges, [
    "'S'!A1:AX200",
    "'S'!A201:AX400",
    "'S'!A401:AX420",
  ]);
  assert.equal(r.data[2].startRow, 400);
  assert.ok(r.readAt);
});
test("large registered sheet requires bounded request chunks, not an unrestricted giant request", () => {
  const d = structuredClone(docs);
  delete d[1].sheets[0].chunkRows;
  assert.throws(() => validateDoctorDocuments(d), /sheet/);
  assert.doesNotThrow(() => validateDoctorDocuments(docs));
});
const sheet = (gid, title, entries) => ({
  properties: { sheetId: gid, title, gridProperties: { rowCount: 100 } },
  data: entries.map(([cell, value]) => {
    const m = cell.match(/^([A-Z]+)(\d+)$/);
    let col = 0;
    for (const c of m[1]) col = col * 26 + c.charCodeAt(0) - 64;
    return {
      startRow: Number(m[2]) - 1,
      startColumn: col - 1,
      rowData: [
        {
          values: [
            {
              effectiveValue:
                typeof value === "number"
                  ? { numberValue: value }
                  : { stringValue: value },
            },
          ],
        },
      ],
    };
  }),
});
test("business mismatch is a pending preview, never a confirmed incident or mutation", () => {
  const doc = docs[0];
  const grid = {
    sheets: [
      sheet(0, "Все коэффициенты", [
        ["A2", "Synthetic"],
        ["B2", 0.4],
        ["C2", 0.5],
        ["D2", 0.3],
        ["E2", 150],
      ]),
    ],
  };
  const before = JSON.stringify(grid);
  const r = businessPreview(doc, grid, new Date("2026-10-09T12:00:00Z"));
  const sum = r.checks.find((r) => r.id === "fbo-sum");
  assert.equal(sum.observations, 1);
  assert.equal(sum.approval, "pending");
  assert.equal(sum.samples[0].classification, "requires_review");
  assert.equal(r.findings.length, 0);
  assert.equal(JSON.stringify(grid), before);
});
test("missing calendar/current shift never triggers a fabricated productivity anomaly; missing snapshot is not zero", () => {
  const r = businessPreview(
    docs[2],
    {
      sheets: [
        sheet(725126844, "Журнал выпуска", []),
        sheet(572942359, "Выпуск по дням", []),
      ],
    },
    new Date("2026-10-11T12:00:00Z"),
  );
  const trend = r.checks.find((r) => r.id === "printing-trend");
  assert.equal(trend.status, "insufficient_context");
  assert.equal(trend.metrics.alertsEnabled, false);
  assert.equal(r.findings.length, 0);
});
test("QUERY comparison separates cutting, matches journal area and flags a missing summary group for review only", () => {
  const grid = {
    sheets: [
      sheet(725126844, "Журнал выпуска", [
        ["A2", "id1"],
        ["B2", "08.10.2026"],
        ["C2", "Synthetic"],
        ["D2", "Печать"],
        ["H2", "uid"],
        ["J2", 5],
        ["L2", 12.3],
        ["A3", "id2"],
        ["B3", "08.10.2026"],
        ["C3", "Synthetic"],
        ["D3", "Порезка"],
        ["L3", 4],
      ]),
      sheet(572942359, "Выпуск по дням", [
        ["A5", "08.10.2026"],
        ["B5", "Synthetic"],
        ["C5", "Печать"],
        ["D5", 12.3],
      ]),
    ],
  };
  const r = businessPreview(docs[2], grid).checks.find(
    (c) => c.id === "daily-journal",
  );
  assert.equal(r.rowsChecked, 1);
  assert.equal(r.observations, 1);
  assert.ok(r.samples[0].expected.group.endsWith("Порезка"));
});
test("partial rolls share an order UID without being duplicate record IDs", () => {
  const grid = {
    sheets: [
      sheet(725126844, "Журнал выпуска", [
        ["A2", "part1"],
        ["B2", "08.10.2026"],
        ["C2", "Synthetic"],
        ["D2", "Печать"],
        ["H2", "same-order"],
        ["J2", 5],
        ["L2", 1],
        ["A3", "part2"],
        ["B3", "08.10.2026"],
        ["C3", "Synthetic"],
        ["D3", "Печать"],
        ["H3", "same-order"],
        ["J3", 5],
        ["L3", 1],
      ]),
    ],
  };
  const r = businessPreview(docs[2], grid).checks.find(
    (c) => c.id === "journal-coverage",
  );
  assert.equal(r.observations, 0);
  assert.equal(r.metrics.duplicateRecordIds, 0);
});

test("600-second schedule follows start times; long checks skip occupied windows instead of overlapping", async () => {
  const { nextScheduledCheck } = await import("../agent/schedule.js");
  assert.equal(nextScheduledCheck(1000000, 1060000, 600000), 1600000);
  assert.equal(nextScheduledCheck(1000000, 1660000, 600000), 2200000);
});

test("missing dashboard employee is disclosed even if XLOOKUP masks it as zero, without declaring bad work", () => {
  const grid = {
    sheets: [
      sheet(0, "Все коэффициенты", [
        ["A2", "Known"],
        ["B2", 0],
        ["C2", 0],
        ["D2", 0],
        ["E2", 0],
      ]),
      sheet(605337763, "По дням · Дашборд", [
        ["B6", "09.10.2026"],
        ["A7", "Missing"],
        ["B7", 0],
      ]),
    ],
  };
  const r = businessPreview(
    docs[0],
    grid,
    new Date("2026-10-09T12:00:00Z"),
  ).checks.find((c) => c.id === "fbo-current");
  assert.equal(r.observations, 1);
  assert.equal(r.samples[0].gid, 605337763);
  assert.equal(r.samples[0].observed.value, 0);
  assert.equal(r.approval, "pending");
});
