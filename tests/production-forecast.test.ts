import test from "node:test";
import assert from "node:assert/strict";
import {
  buildForecast,
  overallForecastStatus,
  workSegments,
  moscowInput,
  inputInstant,
  confirmedStockPacked,
  type ForecastInput,
  type ForecastTask,
} from "../src/productionForecastModel";
import { forecastInput, applyConfirmedPackingStock, applyConfirmedProductionCuts } from "../src/productionForecastData";
import { supplyCalendarAxis, groupCalendarPeriods, calendarWorkWindow, calendarShippingView, packingPlanWindow } from "../src/supplyCalendarAxis";
import type { LiveOrder, LivePrinting } from "../src/livePrinting";
const now = Date.parse("2026-11-12T09:00:00+03:00");
const resource = (id: string, rate = 100, unit = "pieces") => ({
  id,
  rate,
  unit: unit as "pieces" | "area" | "sheets",
  start: 9 * 60,
  end: 18 * 60,
  days: [1, 2, 3, 4, 5],
});
const task = (override: Partial<ForecastTask> = {}): ForecastTask => ({
  id: "id1",
  supplyKey: "s1",
  name: "Test",
  article: "SKU1",
  machine: "2-go",
  department: "roll",
  plan: 100,
  printed: 0,
  cut: 0,
  areaPerPiece: 0.1,
  sheetsPerPiece: null,
  stock: false,
  urgent: false,
  ...override,
});
const input = (tasks: ForecastTask[]): ForecastInput => ({
  tasks,
  issues: [],
  fresh: true,
  supplies: [...new Set(tasks.map((t) => t.supplyKey))].map((key) => ({
    key,
    name: key,
    plan: tasks
      .filter((t) => t.supplyKey === key)
      .reduce((a, t) => a + t.plan, 0),
    printed: tasks
      .filter((t) => t.supplyKey === key)
      .some((t) => t.printed === null)
      ? null
      : tasks
          .filter((t) => t.supplyKey === key)
          .reduce((a, t) => a + t.printed!, 0),
    cut: tasks.filter((t) => t.supplyKey === key).some((t) => t.cut === null)
      ? null
      : tasks
          .filter((t) => t.supplyKey === key)
          .reduce((a, t) => a + t.cut!, 0),
    stock: tasks.find((t) => t.supplyKey === key)!.stock,
    urgent: tasks.find((t) => t.supplyKey === key)!.urgent,
  })),
});
const settings = (resources = [resource("2-go"), resource("cut-roll")]) => ({
  revision: 0,
  resources,
  deadlines: {
    s1: {
      readyAt: "2026-11-12T13:00:00+03:00",
      shipAt: "2026-11-13T12:00:00+03:00",
    },
  },
  updatedAt: null,
  updatedBy: null,
});
test("a provisional cutting queue retains the actual missing printer rate as its cause", () => {
  const jobs = [
    task({ id: "a", supplyKey: "s1", article: "JD0019.A3520", machine: "uv-white" }),
    task({ id: "b", supplyKey: "s2", article: "SKU2", printed: 100, cut: 0 }),
  ];
  const rows = buildForecast(input(jobs), settings([resource("uv-white", 0, "area"), resource("cut-roll")]), now,
    { "uv-white": { label: "УФ белый", reason: "Недостаточно данных журнала для автоматической скорости." } });
  const affected = rows.find((item) => item.key === "s2")!;
  assert.match(affected.reasons.join(" "), /JD0019\.A3520: срок печати не определён.*УФ белый.*Недостаточно данных журнала/);
  assert.equal(affected.finishAt, null, "a partial queue does not become a confirmed finish");
  assert.ok(affected.segments.some((segment) => segment.phase === "cut"), "known work remains visible as partial");
});
test("batches overlap printing and cutting, finish is not a sum of complete stages", () => {
  const [r] = buildForecast(input([task()]), settings(), now);
  assert.equal(r.printAt, now + 3600000);
  assert.equal(r.finishAt, now + 3960000);
  assert.equal(r.status, "on-time");
  assert.equal(r.bottleneck, "cut-roll");
  assert.equal(
    Math.round(
      r.segments
        .filter((s) => s.phase === "cut")
        .reduce((n, s) => n + s.pieces, 0),
    ),
    100,
  );
});
test("packing reserves a single shared queue and respects the packing deadline", () => {
  const jobs = [
    task({ id: "a", supplyKey: "s1", printed: 100, cut: 100, packed: 0 }),
    task({ id: "b", supplyKey: "s2", printed: 100, cut: 100, packed: 0 }),
  ];
  const data = { ...input(jobs), packingFresh: true };
  const plan = {
    ...settings([resource("packing", 100)]),
    deadlines: {
      s1: {
        readyAt: null,
        packingAt: "2026-11-12T10:30:00+03:00",
        shipAt: null,
      },
      s2: {
        readyAt: null,
        packingAt: "2026-11-12T10:30:00+03:00",
        shipAt: null,
      },
    },
  };
  const rows = buildForecast(data, plan, now);
  assert.equal(rows[0].packingFinishAt, now + 3600000);
  assert.equal(rows[1].packingFinishAt, now + 7200000);
  assert.equal(rows[0].packingStatus, "risk");
  assert.equal(rows[1].packingStatus, "late");
  assert.equal(overallForecastStatus(rows[1]), "late");
  assert.equal(rows[0].packingSegments[0].start, now);
  assert.equal(rows[1].packingSegments[0].start, rows[0].packingFinishAt);
});
test("stock tasks outside Assembly do not fabricate a packing plan or block completed production", () => {
  const jobs = [
    task({
      id: "urgent",
      stock: true,
      urgent: true,
      packingExcluded: true,
      printed: 100,
      cut: 100,
      packed: null,
    }),
  ];
  const [row] = buildForecast(
    { ...input(jobs), packingFresh: true },
    settings(),
    now,
  );
  assert.equal(row.status, "done");
  assert.equal(row.packingExcluded, true);
  assert.equal(overallForecastStatus(row), "done");
  assert.deepEqual(row.packingReasons, []);
});
test("unconfirmed packing queue does not create a packing warning for excluded urgent stock", () => {
  const jobs = [
    task({ id: "urgent", stock: true, urgent: true, supplyKey: "s1", packingExcluded: true, printed: 100, cut: 100, packed: null }),
    task({ id: "other", supplyKey: "s2", printed: 100, cut: 100, packed: null }),
  ];
  const rows = buildForecast({ ...input(jobs), packingFresh: true }, settings(), now);
  const excluded = rows.find((row) => row.key === "s1")!;
  assert.equal(excluded.packingExcluded, true);
  assert.deepEqual(excluded.packingReasons, []);
  assert.ok(rows.find((row) => row.key === "s2")!.packingReasons.length > 0);
});
test("an unavailable automatic rate shows the actual journal diagnosis", () => {
  const r = { ...resource("2-go", 0), rateMode: "auto" as const };
  const [row] = buildForecast(
    input([task()]),
    settings([r, resource("cut-roll")]),
    now,
    {
      "2-go": {
        label: "Печать · 2-GO",
        reason: "Найдено только 2 рабочих дня.",
      },
    },
  );
  assert.ok(
    row.reasons.some((text) =>
      text.includes("Печать · 2-GO: Найдено только 2 рабочих дня."),
    ),
  );
});
test("catalog lane changes never move an active job away from its source department", () => {
  const order = {
    uid: "source-id",
    rawUid: "source-id",
    sheetId: 7,
    sheetName: "OZON Test",
    row: 5,
    article: "TEST",
    sourceId: "roll-printing",
    machine: "XEROX",
    machineSource: "catalog",
    sourceMachine: "2-GO",
    quantity: 100,
    plannedArea: 10,
    planningPrinted: 0,
    planningCut: 0,
    planningPhysicalUnits: false,
  } as LiveOrder;
  const live = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    supplies: [order],
    sheets: [{ sheetId: 7, sourceId: "roll-printing", name: "OZON Test" }],
    events: [],
    issues: [],
    stockRoll: { status: "available", orders: [] },
    stockBox: { status: "available", orders: [] },
  } as unknown as LivePrinting;
  const data = forecastInput(live, now);
  assert.equal(data.tasks[0].department, "roll");
  assert.equal(data.tasks[0].machine, "2-go");
  const row = buildForecast(data, settings(), now)[0];
  assert.ok(row.segments.some((part) => part.resource === "cut-roll"));
  assert.ok(!row.segments.some((part) => part.resource === "cut-box"));
  const unclear = forecastInput(
    { ...live, supplies: [{ ...order, sourceMachine: null }] },
    now,
  );
  assert.equal(unclear.tasks[0].machine, "");
  assert.equal(unclear.tasks[0].department, "roll");
});
test("a box order with matching source and catalog UV uses that printer and box cutting", () => {
  const order = {
    uid: "confirmed-uv",
    rawUid: "confirmed-uv",
    sheetId: 7,
    sheetName: "OZON Test",
    row: 5,
    article: "UV-BOX",
    sourceId: "box-printing",
    machine: "УФ",
    machineSource: "catalog",
    sourceMachine: "УФ",
    quantity: 8,
    plannedArea: 8,
    planningPrinted: 0,
    planningCut: 0,
    planningPhysicalUnits: false,
  } as LiveOrder;
  const live = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    supplies: [order],
    sheets: [{ sheetId: 7, sourceId: "box-printing", name: "OZON Test" }],
    events: [],
    issues: [],
    stockRoll: { status: "available", orders: [] },
    stockBox: { status: "available", orders: [] },
  } as unknown as LivePrinting;
  const data = forecastInput(live, now);
  assert.equal(data.tasks[0].department, "box");
  assert.equal(data.tasks[0].machine, "uv");
  const row = buildForecast(data, settings([resource("uv"), resource("cut-box")]), now)[0];
  assert.ok(row.segments.some((part) => part.phase === "print" && part.resource === "uv"));
  assert.ok(row.segments.some((part) => part.phase === "cut" && part.resource === "cut-box"));
  assert.ok(!row.segments.some((part) => part.resource === "cut-roll"));
  const unknown = forecastInput({ ...live, supplies: [{ ...order, sourceMachine: null }] }, now);
  assert.equal(unknown.tasks[0].machine, "");
});
test("a finished cutting mark does not block other cuts or packing while print is disputed", () => {
  const jobs = [
    task({ id: "disputed", supplyKey: "s1", article: "WS", department: "box", machine: "xerox", plan: 20, printed: 0, cut: 20, packed: 4 }),
    task({ id: "other", supplyKey: "s2", department: "box", machine: "uv-flatbed", plan: 20, printed: 20, cut: 0, packed: 0 }),
  ];
  const rows = buildForecast(
    { ...input(jobs), packingFresh: true },
    settings([resource("xerox"), resource("uv-flatbed"), resource("cut-box"), resource("packing")]),
    now,
  );
  const disputed = rows.find((row) => row.key === "s1")!;
  const other = rows.find((row) => row.key === "s2")!;
  assert.equal(disputed.status, "unknown");
  assert.equal(disputed.finishAt, null);
  assert.match(disputed.reasons.join(" "), /WS: порезано 20 шт., а печать отмечена на 0 шт/);
  assert.equal(disputed.segments.length, 0);
  assert.ok(other.segments.some((part) => part.phase === "cut" && part.resource === "cut-box"));
  assert.equal(disputed.packingSegments.reduce((total, part) => total + part.pieces, 0), 16);
  assert.equal(other.packingSegments.reduce((total, part) => total + part.pieces, 0), 20);
});
test("confirmed packed stock does not invent cutting or double schedule packing", () => {
  const jobs = [task({ id: "stock-part", plan: 10, printed: 10, cut: 0, packed: 5, packingEventIds: ["packing-1"] })];
  const source = { taskId: "stock-part", article: "SKU1", quantity: 5, packingEventIds: ["packing-1"], recordedAt: new Date(now).toISOString(), recordedBy: "Owner" };
  const withStock = applyConfirmedPackingStock({ ...input(jobs), packingFresh: true }, [source]);
  const [row] = buildForecast(withStock, settings([resource("cut-roll"), resource("packing")]), now);
  assert.equal(withStock.tasks[0].cut, 0);
  assert.equal(withStock.tasks[0].stockPacked, 5);
  assert.equal(row.segments.filter((s) => s.phase === "cut").reduce((n, s) => n + s.pieces, 0), 10);
  assert.equal(row.packingSegments.reduce((n, s) => n + s.pieces, 0), 5);
  assert.ok(!row.packingReasons.length);
  const stale = applyConfirmedPackingStock({ ...input([{ ...jobs[0], packed: 4 }]), packingFresh: true }, [source]);
  assert.equal(stale.tasks[0].stockPacked, undefined);
  assert.match(stale.packingIssues!.join(), /не совпадает/);
  const replaced = applyConfirmedPackingStock(input([{ ...jobs[0], packingEventIds: ["new-packing"] }]), [source]);
  assert.equal(replaced.tasks[0].stockPacked, undefined);
  assert.match(replaced.packingIssues!.join(), /не совпадает/);
  const extended = applyConfirmedPackingStock(input([{ ...jobs[0], packed: 7, packingEventIds: ["packing-1", "new-packing"] }]), [source]);
  assert.equal(extended.tasks[0].stockPacked, 5);
  const revoked = applyConfirmedPackingStock(input(jobs), [source, { ...source, quantity: 0 }]);
  assert.equal(revoked.tasks[0].stockPacked, undefined);
});
test("over-plan stock is retained as fact while the forecast is capped at plan", () => {
  const job = task({ id: "over-plan-stock", plan: 20, printed: 20, cut: 0, packed: 24, packingEventIds: ["packing-1"] });
  const source = { taskId: job.id, article: job.article, quantity: 24, packingEventIds: ["packing-1"], recordedAt: new Date(now).toISOString(), recordedBy: "Owner" };
  const data = applyConfirmedPackingStock({ ...input([job]), packingFresh: true }, [source]);
  assert.equal(data.tasks[0].stockPacked, 24);
  assert.equal(confirmedStockPacked(data.tasks[0]), 20);
  assert.deepEqual(data.packingIssues, []);
  const [row] = buildForecast(data, settings([resource("cut-roll"), resource("packing")]), now);
  assert.equal(row.segments.filter((part) => part.phase === "cut").reduce((sum, part) => sum + part.pieces, 0), 20);
  assert.equal(row.packingStatus, "done");
  assert.equal(row.packingSegments.length, 0);
  const corrected = applyConfirmedPackingStock(input([{ ...job, packed: 23 }]), [source]);
  assert.equal(corrected.tasks[0].stockPacked, undefined);
  assert.match(corrected.packingIssues!.join(), /не совпадает/);
});
test("owner-confirmed cutting affects only the forecast for the exact unchanged plan", () => {
  const job = task({ id: "confirmed-cut", plan: 10, printed: 10, cut: 0, packed: 10 });
  const event = { taskId: job.id, article: job.article, quantity: 10, sourcePlan: 10, recordedAt: new Date(now).toISOString(), recordedBy: "Owner" };
  const original = input([job]);
  const data = applyConfirmedProductionCuts(original, [event]);
  assert.equal(original.tasks[0].cut, 0);
  assert.equal(original.supplies[0].cut, 0);
  assert.equal(data.tasks[0].cut, 10);
  assert.equal(data.tasks[0].cutConfirmation?.sourceCut, 0);
  assert.equal(data.supplies[0].cut, 10);
  const [row] = buildForecast({ ...data, packingFresh: true }, settings([resource("cut-roll"), resource("packing")]), now);
  assert.equal(row.status, "done");
  assert.equal(row.segments.length, 0);
  assert.equal(row.packingSegments.length, 0);
  const updated = applyConfirmedProductionCuts(input([{ ...job, cut: 10 }]), [event]);
  assert.equal(updated.tasks[0].cut, 10);
  assert.equal(updated.tasks[0].cutConfirmation, undefined);
  assert.equal(updated.supplies[0].cut, 10);
  const changedPlan = applyConfirmedProductionCuts(input([{ ...job, plan: 20 }]), [event]);
  assert.equal(changedPlan.tasks[0].cut, 0);
  const duplicate = applyConfirmedProductionCuts(input([job, { ...job }]), [event]);
  assert.ok(duplicate.tasks.every((item) => item.cut === 0));
  const revoked = applyConfirmedProductionCuts(input([job]), [event, { ...event, quantity: 0 }]);
  assert.equal(revoked.tasks[0].cut, 0);
});
test("an unknown cutting mark does not block a printer whose own work is complete", () => {
  const rows = buildForecast(
    input([
      task({ id: "uncertain-cut", supplyKey: "s1", printed: 100, cut: null }),
      task({ id: "next-print", supplyKey: "s2", printed: 0, cut: 0 }),
    ]),
    settings(),
    now,
  );
  assert.equal(rows.find((row) => row.key === "s1")!.status, "unknown");
  assert.ok(rows.find((row) => row.key === "s2")!.segments.some((part) => part.phase === "print"));
  assert.equal(rows.find((row) => row.key === "s2")!.finishAt, null);
});
test("available cutting batches remain provisional when another print date is unknown", () => {
  const jobs = [
    task({ id: "available", supplyKey: "s1", article: "READY", printed: 100, cut: 0, packed: 0 }),
    task({ id: "uncertain", supplyKey: "s2", article: "UNKNOWN", machine: "not-configured", printed: 0, cut: 0, packed: 0 }),
  ];
  const rows = buildForecast(
    { ...input(jobs), packingFresh: true },
    settings([resource("cut-roll"), resource("packing")]),
    now,
  );
  const available = rows.find((row) => row.key === "s1")!;
  assert.equal(available.status, "unknown");
  assert.equal(available.finishAt, null);
  assert.equal(available.packingFinishAt, null);
  assert.match(available.reasons.join(" "), /Очередь рассчитана частично/);
  assert.equal(available.segments.filter((part) => part.phase === "cut").reduce((n, part) => n + part.pieces, 0), 100);
  assert.ok(available.packingReasons.length > 0);
  assert.equal(available.packingSegments.length, 0);
  const withoutCutter = buildForecast(input(jobs), settings([resource("packing")]), now);
  assert.ok(!withoutCutter.find((row) => row.key === "s1")!.segments.some((part) => part.phase === "cut"));
});
test("calendar compresses nights and days without shifts while preserving actual work positions", () => {
  const start = Date.parse("2026-11-13T00:00:00+03:00"),
    axis = supplyCalendarAxis(start, 4, [resource("2-go")]);
  assert.equal(axis.columns[0].active, true);
  assert.equal(axis.columns[1].active, false);
  assert.equal(axis.columns[2].active, false);
  assert.equal(axis.columns[3].active, true);
  assert.ok(axis.columns[1].width < axis.columns[0].width);
  assert.equal(
    axis.position(Date.parse("2026-11-13T09:00:00+03:00")),
    axis.columns[0].left,
  );
  assert.equal(
    axis.position(Date.parse("2026-11-13T18:00:00+03:00")),
    axis.columns[1].left,
  );
  assert.equal(
    axis.position(Date.parse("2026-11-16T09:00:00+03:00")),
    axis.columns[3].left,
  );
  assert.ok(
    Math.abs(
      supplyCalendarAxis(start, 3, []).position(start + 86400000) - 100 / 3,
    ) < 1e-10,
  );
});
test("calendar finds shipping dates without hiding nearby production deadlines", () => {
  const now = Date.parse("2026-11-16T10:00:00+03:00");
  const at = (date: string) => Date.parse(`${date}T15:00:00+03:00`);
  assert.deepEqual(calendarShippingView(now, at("2026-11-18"), 7, -1), { range: 7, offset: -1 });
  assert.deepEqual(calendarShippingView(now, at("2026-11-23"), 7, -1), { range: 14, offset: -1 });
  assert.deepEqual(calendarShippingView(now, at("2026-11-10"), 7, -1), { range: 14, offset: -6 });
  assert.deepEqual(calendarShippingView(now, at("2027-01-15"), 7, -1), { range: 7, offset: 60 });
  assert.deepEqual(calendarShippingView(now, NaN, 7, -1), { range: 7, offset: -1 });
});
test("packing planning window counts only scheduled shifts and never invents a packing deadline", () => {
  const start = "2026-11-18T16:00:00+03:00", shipment = "2026-11-23T15:00:00+03:00";
  const schedule = { ...resource("packing"), days: [1,2,3,4,5,6] };
  const plan = packingPlanWindow(start, null, shipment, schedule)!;
  assert.equal(plan.status, "ready"); assert.equal(plan.endsAt, "shipping"); assert.equal(plan.hours, 35);
  assert.equal(plan.shifts.length, 5);
  assert.equal(new Date(plan.shifts[0].start).toISOString(), new Date(start).toISOString());
  assert.equal(new Date(plan.shifts.at(-1)!.end).toISOString(), new Date(shipment).toISOString());
  assert.ok(!plan.shifts.some(shift => new Date(shift.start + 10800000).getUTCDay() === 0), "Sunday is not scheduled");
  const deadline = packingPlanWindow(start, "2026-11-20T12:00:00+03:00", shipment, schedule)!;
  assert.equal(deadline.endsAt, "packing"); assert.equal(deadline.hours, 14);
  assert.equal(packingPlanWindow(start, null, shipment, undefined)?.status, "schedule-missing");
  assert.equal(packingPlanWindow(null, null, shipment, schedule), null);
  assert.equal(packingPlanWindow(start, null, "2026-11-17T15:00:00+03:00", schedule)?.status, "invalid");
  assert.equal(packingPlanWindow("2026-11-21T19:00:00+03:00", null, "2026-11-22T18:00:00+03:00", schedule)?.status, "no-work");
});
test("calendar groups nearby cutting batches for display without changing work or crossing days", () => {
  const base = { resource: "cut-box", taskId: "a", supplyKey: "s1", article: "SKU", phase: "cut" as const, start: now, end: now + 5 * 60000, pieces: 5 };
  const parts = [
    base,
    { ...base, taskId: "b", article: "OTHER", start: now + 10 * 60000, end: now + 15 * 60000, pieces: 7 },
    { ...base, taskId: "c", start: now + 40 * 60000, end: now + 45 * 60000, pieces: 3 },
    { ...base, taskId: "d", start: now + 86400000, end: now + 86400000 + 60000, pieces: 2 },
  ];
  const original = structuredClone(parts), grouped = groupCalendarPeriods(parts);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].batches, 2);
  assert.equal(grouped[0].pieces, 12);
  assert.equal(grouped[0].article, "Несколько партий");
  assert.deepEqual(parts, original);
});
test("calendar work window combines batches without changing quantities or concealing gaps", () => {
  const base = { resource: "cut-box", taskId: "a", supplyKey: "s1", article: "SKU", phase: "cut" as const, start: now, end: now + 10 * 60000, pieces: 5 };
  const parts = [
    { ...base, taskId: "later", start: now + 40 * 60000, end: now + 60 * 60000, pieces: 3 },
    base,
    { ...base, taskId: "overlap", start: now + 5 * 60000, end: now + 12 * 60000, pieces: 2 },
  ];
  const original = structuredClone(parts), window = calendarWorkWindow(parts);
  assert.deepEqual(window, { start: now, end: now + 60 * 60000, pieces: 10, batches: 3, hasGaps: true });
  assert.equal(calendarWorkWindow([parts[1], parts[2]])?.hasGaps, false);
  assert.equal(calendarWorkWindow([]), null);
  assert.equal(calendarWorkWindow([{ ...base, end: NaN }]), null);
  assert.deepEqual(parts, original);
});
test("packing cannot make an unconfirmed production deadline look on time", () => {
  const jobs = [task({ id: "a", printed: 100, cut: 100, packed: 0 })];
  const plan = {
    ...settings([resource("packing")]),
    deadlines: {
      s1: {
        readyAt: null,
        packingAt: "2026-11-13T18:00:00+03:00",
        shipAt: null,
      },
    },
  };
  const [row] = buildForecast(
    { ...input(jobs), packingFresh: true },
    plan,
    now,
  );
  assert.equal(row.packingStatus, "on-time");
  assert.equal(overallForecastStatus(row), "on-time");
  const unknown = { ...row, status: "unknown" as const };
  assert.equal(overallForecastStatus(unknown), "unknown");
});
test("packing starts with cut batches without waiting for the entire supply", () => {
  const data = { ...input([task({ packed: 0 })]), packingFresh: true };
  const [row] = buildForecast(
    data,
    settings([resource("2-go"), resource("cut-roll"), resource("packing")]),
    now,
  );
  assert.ok(row.packingFinishAt);
  assert.ok(
    row.packingSegments[0].start >=
      row.segments.filter((s) => s.phase === "cut")[0].end,
  );
  assert.ok(row.packingSegments[0].start < row.finishAt!);
  assert.equal(
    Math.round(row.packingSegments.reduce((n, s) => n + s.pieces, 0)),
    100,
  );
});
test("packing queue prioritizes the nearest packing deadline independently of print deadline", () => {
  const jobs = [
    task({ id: "a", supplyKey: "s1", printed: 100, cut: 100, packed: 0 }),
    task({ id: "b", supplyKey: "s2", printed: 100, cut: 100, packed: 0 }),
  ];
  const plan = {
    ...settings([resource("packing")]),
    deadlines: {
      s1: {
        readyAt: null,
        packingAt: "2026-11-13T12:00:00+03:00",
        shipAt: null,
      },
      s2: {
        readyAt: null,
        packingAt: "2026-11-12T12:00:00+03:00",
        shipAt: null,
      },
    },
  };
  const rows = buildForecast({ ...input(jobs), packingFresh: true }, plan, now);
  assert.equal(rows.find((r) => r.key === "s2")!.packingSegments[0].start, now);
  assert.equal(
    rows.find((r) => r.key === "s1")!.packingSegments[0].start,
    now + 3600000,
  );
});
test("unconfirmed stock or stale packing source blocks all unfinished shared packing forecasts", () => {
  const jobs = [
    task({ id: "a", printed: 100, cut: 100, packed: 0 }),
    task({
      id: "stock",
      supplyKey: "stock",
      stock: true,
      printed: 100,
      cut: 100,
      packed: null,
    }),
  ];
  const config = settings([resource("packing")]);
  const rows = buildForecast(
    { ...input(jobs), packingFresh: true },
    config,
    now,
  );
  assert.equal(rows.find((r) => r.key === "s1")?.packingFinishAt, null);
  assert.match(
    rows.find((r) => r.key === "s1")!.packingReasons.join(" "),
    /не подтверждены/,
  );
  const stale = buildForecast(
    { ...input([jobs[0]]), packingFresh: false },
    config,
    now,
  )[0];
  assert.equal(stale.packingFinishAt, null);
  assert.match(stale.packingReasons.join(" "), /свежих/);
  assert.deepEqual(stale.packingSegments, []);
});
test("one conflicting packing position leaves other confirmed work visible only provisionally", () => {
  const jobs = [
    task({ id: "known", supplyKey: "s1", printed: 100, cut: 100, packed: 0 }),
    task({ id: "uncertain", supplyKey: "s2", name: "Kazan", article: "SKU-B", printed: 100, cut: 0, packed: 5 }),
  ];
  const rows = buildForecast(
    { ...input(jobs), packingFresh: true },
    settings([resource("cut-roll"), resource("packing")]), now,
  );
  const known = rows.find((row) => row.key === "s1")!;
  const uncertain = rows.find((row) => row.key === "s2")!;
  assert.match(known.packingReasons.join(" "), /Kazan · SKU-B/);
  assert.equal(known.packingStatus, "unknown");
  assert.equal(known.packingFinishAt, null);
  assert.equal(known.packingSegments.reduce((sum, part) => sum + part.pieces, 0), 100);
  assert.equal(uncertain.packingSegments.length, 0);
});
test("packing diagnostics identify the shipment and the conflicting recorded quantities", () => {
  const job = task({name: "OZON Test", article: "SKU", printed: 20, cut: 10, packed: 15});
  const [row] = buildForecast(
    { ...input([job]), packingFresh: true },
    settings([resource("2-go"), resource("cut-roll"), resource("packing")]),
    now,
  );
  assert.match(row.packingReasons.join(" "), /OZON Test · SKU.*упаковано 15.*порезано 10/);
  assert.equal(row.packingFinishAt, null);
});
test("fully packed goods do not block the future shared queue when production marks lag", () => {
  const jobs = [
    task({ id: "from-stock", supplyKey: "s1", plan: 50, printed: 0, cut: 0, packed: 50 }),
    task({ id: "waiting", supplyKey: "s2", plan: 100, printed: 100, cut: 100, packed: 0 }),
  ];
  const rows = buildForecast(
    { ...input(jobs), packingFresh: true }, settings([resource("packing", 100)]), now,
  );
  assert.equal(rows.find((row) => row.key === "s1")!.packingStatus, "done");
  assert.equal(rows.find((row) => row.key === "s2")!.packingFinishAt, now + 3600000);
  assert.deepEqual(rows.find((row) => row.key === "s2")!.packingReasons, []);
});
test("Moscow schedule crosses Friday into Monday without consuming weekend capacity", () => {
  const result = workSegments(
    Date.parse("2026-11-13T17:30:00+03:00"),
    90,
    resource("2-go"),
  )!;
  assert.equal(result.length, 2);
  assert.equal(result[1].end, Date.parse("2026-11-16T10:00:00+03:00"));
});
test("fully printed supply starts cutting now; no repeat printing or historical ETA fabrication", () => {
  const [r] = buildForecast(
    input([task({ printed: 100, cut: 40 })]),
    settings(),
    now,
  );
  assert.equal(r.segments.filter((s) => s.phase === "print").length, 0);
  assert.equal(r.finishAt, now + 2160000);
  const [done] = buildForecast(
    input([task({ printed: 105, cut: 102 })]),
    settings(),
    now,
  );
  assert.equal(done.status, "done");
  assert.equal(done.finishAt, null);
  assert.equal(done.segments.length, 0);
});
test("urgent reserves compete for the same machine before ordinary shipments", () => {
  const result = buildForecast(
    input([
      task(),
      task({ id: "stock", supplyKey: "stock1", stock: true, urgent: true }),
    ]),
    settings(),
    now,
  );
  assert.equal(result[0].key, "stock1");
  assert.equal(result.find((r) => r.key === "s1")!.printAt, now + 7200000);
});
test("separate machines run in parallel, sharing cutting queue with no overlapping reservations", () => {
  const result = buildForecast(
    input([task(), task({ id: "id2", supplyKey: "s2", machine: "uv" })]),
    settings([resource("2-go"), resource("uv"), resource("cut-roll")]),
    now,
  );
  assert.equal(result[0].printAt, result[1].printAt);
  const spans = result
    .flatMap((r) => r.segments)
    .filter((s) => s.resource === "cut-roll")
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++)
    assert.ok(spans[i].start >= spans[i - 1].end);
});
test("Xerox sheet capacity converts from piece plan, other equipment needs no multiplicity", () => {
  const [r] = buildForecast(
    input([task({ machine: "xerox", department: "box", sheetsPerPiece: 2 })]),
    settings([resource("xerox", 100, "sheets"), resource("cut-box")]),
    now,
  );
  assert.equal(r.printAt, now + 7200000);
  const [missing] = buildForecast(
    input([task({ machine: "xerox", department: "box" })]),
    settings([resource("xerox", 100, "sheets"), resource("cut-box")]),
    now,
  );
  assert.equal(missing.status, "unknown");
  assert.match(missing.reasons.join(), /кратности/);
  assert.ok(buildForecast(input([task()]), settings(), now)[0].finishAt);
});
test("area capacity uses authoritative plan area per piece", () => {
  const [r] = buildForecast(
    input([task({ areaPerPiece: 0.2 })]),
    settings([resource("2-go", 10, "area"), resource("cut-roll")]),
    now,
  );
  assert.equal(r.printAt, now + 7200000);
  const [missing] = buildForecast(
    input([task({ areaPerPiece: null })]),
    settings([resource("2-go", 10, "area"), resource("cut-roll")]),
    now,
  );
  assert.equal(missing.finishAt, null);
});
test("stale, missing stock queue, unknown equipment and duplicate IDs cannot promise a finish", () => {
  for (const change of [
    { fresh: false },
    { issues: ["Запасы недоступны"] },
    { tasks: [task({ machine: "" })] },
    { tasks: [task(), task()] },
  ]) {
    const [r] = buildForecast(
      { ...input([task()]), ...change },
      settings(),
      now,
    );
    assert.equal(r.status, "unknown");
    assert.equal(r.finishAt, null);
    assert.ok(r.reasons.length);
  }
});
test("excess output on one SKU does not hide an unfinished SKU", () => {
  const [r] = buildForecast(
    input([
      task({ printed: 200, cut: 200 }),
      task({ id: "id2", printed: 0, cut: 0 }),
    ]),
    settings(),
    now,
  );
  assert.notEqual(r.status, "done");
  assert.equal(r.printAt, now + 3600000);
});
test("unknown earlier work blocks subsequent queue estimates on that machine", () => {
  const result = buildForecast(
    input([task({ printed: null }), task({ id: "id2", supplyKey: "s2" })]),
    settings(),
    now,
  );
  assert.equal(result[1].finishAt, null);
  assert.match(result[1].reasons.join(), /Очередь/);
  assert.ok(result[1].segments.some((part) => part.phase === "print"));
  assert.ok(result[1].segments.some((part) => part.phase === "cut"));
  assert.match(result[1].reasons.join(), /частично/);
});
test("a disputed printer mark keeps later printer and cutter work provisional", () => {
  const jobs = [
    task({ id: "disputed", supplyKey: "s1", article: "WS", department: "box", machine: "xerox", plan: 20, printed: 0, cut: 20, packed: 4 }),
    task({ id: "next-print", supplyKey: "s2", department: "box", machine: "xerox", plan: 20, printed: 0, cut: 0, packed: 0 }),
    task({ id: "other-cut", supplyKey: "s3", department: "box", machine: "uv-flatbed", plan: 20, printed: 20, cut: 0, packed: 0 }),
  ];
  const rows = buildForecast({ ...input(jobs), packingFresh: true }, settings([resource("xerox"), resource("uv-flatbed"), resource("cut-box"), resource("packing")]), now);
  const disputed = rows.find((row) => row.key === "s1")!;
  const next = rows.find((row) => row.key === "s2")!;
  const other = rows.find((row) => row.key === "s3")!;
  assert.equal(disputed.finishAt, null);
  assert.equal(next.finishAt, null);
  assert.equal(other.finishAt, null);
  assert.ok(next.segments.some((part) => part.phase === "print" && part.resource === "xerox"));
  assert.ok(next.segments.some((part) => part.phase === "cut" && part.resource === "cut-box"));
  assert.ok(other.segments.some((part) => part.phase === "cut" && part.resource === "cut-box"));
  assert.match(next.reasons.join(" "), /частично/);
  assert.match(other.reasons.join(" "), /частично/);
  assert.equal(next.packingFinishAt, null);
  assert.equal(other.packingFinishAt, null);
});
test("deadline statuses and absent deadline remain distinct", () => {
  assert.equal(
    buildForecast(input([task()]), settings(), now)[0].status,
    "on-time",
  );
  const risk = settings();
  risk.deadlines.s1.readyAt = "2026-11-12T11:00:00+03:00";
  assert.equal(buildForecast(input([task()]), risk, now)[0].status, "risk");
  risk.deadlines.s1.readyAt = "2026-11-12T09:30:00+03:00";
  assert.equal(buildForecast(input([task()]), risk, now)[0].status, "late");
  assert.equal(
    buildForecast(input([task()]), { ...settings(), deadlines: {} }, now)[0]
      .status,
    "no-deadline",
  );
});
test("Moscow form dates roundtrip independently of host timezone", () => {
  const utc = "2026-11-12T06:30:00.000Z";
  assert.equal(moscowInput(utc), "2026-11-12T09:30");
  assert.equal(inputInstant(moscowInput(utc)), utc);
});
test("unreasonably small speed is bounded to a one year horizon", () => {
  const [r] = buildForecast(
    input([task()]),
    settings([resource("2-go", 0.00001), resource("cut-roll")]),
    now,
  );
  assert.equal(r.finishAt, null);
  assert.match(r.reasons.join(), /горизонт/);
});
test("adapter keeps stock out of supply registry, excludes archived work, and uses partial physical totals", () => {
  const order: LiveOrder = {
    uid: "uid",
    rawUid: "uid",
    spreadsheetId: "doc",
    sheetId: 5,
    sheetName: "OZON Test",
    assemblyShipmentId: "shipment1",
    row: 5,
    article: "SKU",
    sourceId: "box-printing",
    machine: "XEROX",
    quantity: 100,
    plannedArea: 10,
    areaKnown: true,
    sheetsInProduct: 4,
    multiplicity: 2,
    planningPrinted: 60,
    planningCut: 20,
    planningPhysicalUnits: true,
    printProgress: 0,
    cutProgress: 0,
  };
  const live = {
    ok: true,
    schemaVersion: 2,
    updatedAt: new Date(now).toISOString(),
    supplies: [order],
    events: [],
    issues: [],
    sheets: [
      {
        sheetId: 5,
        sourceId: "box-printing",
        name: "OZON Test",
        assemblyShipmentId: "shipment1",
      },
    ],
    stockRoll: { status: "available", orders: [] },
    stockBox: {
      status: "available",
      orders: [
        {
          ...order,
          uid: "stock1",
          rawUid: "stock1",
          sheetId: 7,
          sheetName: "Срочные 2 этаж",
        },
        { ...order, uid: "archive1", archived: true },
      ],
    },
  } as LivePrinting;
  const result = forecastInput(live, now);
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].printed, 30);
  assert.equal(result.tasks[0].cut, 10);
  assert.equal(result.tasks[0].sheetsPerPiece, 2);
  assert.equal(result.supplies.length, 2);
  assert.ok(result.supplies.some((s) => s.key === "shipment:shipment1"));
  assert.equal(live.supplies.length, 1);
  assert.equal(result.issues.length, 0);
});
test("completed Xerox work uses the same-sheet active journal when its historical conversion differs", () => {
  const order = { uid: "uid", rawUid: "uid", spreadsheetId: "doc", sheetId: 5, sheetName: "OZON Test", row: 5,
    article: "SKU", sourceId: "box-printing", machine: "XEROX", quantity: 48, plannedArea: 10,
    sheetsInProduct: 20, multiplicity: 8, planningPrinted: 48, planningCut: 48,
    planningPhysicalUnits: true, printProgress: 48, cutProgress: 48 } as LiveOrder;
  const event = { id: "print-1", positionId: "historical-position", spreadsheetId: "doc", sheetId: 5,
    shipment: "OZON Test", article: "SKU", employee: "Operator", date: "2026-11-10", quantity: 48, sheets: 48, area: 1 };
  const live = { ok: true, updatedAt: new Date(now).toISOString(), supplies: [order], events: [], issues: [],
    sheets: [{ sheetId: 5, sourceId: "box-printing", name: "OZON Test" }],
    stockRoll: { status: "available", orders: [] }, stockBox: { status: "available", orders: [] },
    boxPrinting: { status: "available", stockStatus: "available", events: [event], cutEvents: [{ ...event, id: "cut-1" }] } } as unknown as LivePrinting;
  const before = structuredClone(live), result = forecastInput(live, now);
  assert.equal(result.tasks[0].printed, 48);
  assert.equal(result.tasks[0].cut, 48);
  assert.deepEqual(live, before);
  const unmatched = forecastInput({ ...live, boxPrinting: { ...live.boxPrinting!, cutEvents: [{ ...event, id: "cut-1", positionId: "old" }, { ...event, id: "cut-2", positionId: "other" }] } }, now);
  assert.equal(unmatched.tasks[0].cut, 19.2);
  const incomplete = forecastInput({ ...live, boxPrinting: { ...live.boxPrinting!, cutEvents: [{ ...event, id: "cut-1", quantity: 20 }] } }, now);
  assert.equal(incomplete.tasks[0].cut, 19.2);
  const duplicatedSku = forecastInput({ ...live, supplies: [order, { ...order, uid: "other", rawUid: "other", row: 6 }] }, now);
  assert.ok(duplicatedSku.tasks.every((task) => task.cut === 19.2));
});
test("large queue is deterministic and does not reserve cutting twice", () => {
  const tasks = Array.from({ length: 500 }, (_, i) =>
    task({ id: "id" + String(i).padStart(4, "0"), plan: 20 }),
  );
  const start = performance.now(),
    [r] = buildForecast(input(tasks), settings(), now);
  assert.ok(performance.now() - start < 5000);
  assert.equal(
    Math.round(
      r.segments
        .filter((s) => s.phase === "cut")
        .reduce((n, s) => n + s.pieces, 0),
    ),
    10000,
  );
});

test("explicit new-roll planning zeros enter the shared queue without changing nullable historical readiness", () => {
  const o = {
    uid: "new",
    rawUid: "new",
    sheetId: 7,
    sheetName: "OZON New",
    sourceId: "roll-printing",
    machine: "2-GO",
    article: "NEW",
    quantity: 20,
    plannedArea: 2,
    areaKnown: true,
    planningPrinted: 0,
    planningCut: 0,
    planningPhysicalUnits: false,
    printProgress: 0,
    cutProgress: null,
    remainingPrint: 20,
  } as LiveOrder;
  const live = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    supplies: [o],
    sheets: [{ sheetId: 7, sourceId: "roll-printing", name: "OZON New" }],
    events: [],
    issues: [],
    stockRoll: { status: "available", orders: [] },
    stockBox: { status: "available", orders: [] },
  } as unknown as LivePrinting;
  const before = structuredClone(live),
    data = forecastInput(live, now);
  assert.equal(data.tasks[0].printed, 0);
  assert.equal(data.tasks[0].cut, 0);
  const [row] = buildForecast(data, { ...settings(), deadlines: {} }, now);
  assert.equal(row.status, "no-deadline");
  assert.ok(row.finishAt);
  assert.deepEqual(live, before);
  const unknown = forecastInput(
    { ...live, supplies: [{ ...o, planningCut: null }] },
    now,
  );
  assert.equal(buildForecast(unknown, settings(), now)[0].status, "unknown");
});
