import test from "node:test";
import assert from "node:assert/strict";
import { globalCalendarEvents, monthDays, monthDistance, moscowDay, moscowMonth } from "../src/globalCalendar";
import type { ForecastRow } from "../src/productionForecastModel";
import type { Planning } from "../shared/productionPlanning";

const at = (value: string) => Date.parse(`${value}+03:00`);
const now = at("2026-11-16T12:00:00");
const row = (): ForecastRow => ({
  key: "s1", name: "Москва", plan: 100, printed: 0, cut: 0, stock: false, urgent: false,
  readyAt: "2026-11-18T16:00:00+03:00", packingAt: null, shipAt: "2026-11-23T15:00:00+03:00",
  printAt: null, finishAt: null, margin: null, status: "unknown", reasons: ["Не подтверждена порезка"], bottleneck: null,
  segments: [], packingFinishAt: null, packingMargin: null, packingStatus: "unknown", packingReasons: ["Нет данных"], packingSegments: [],
});
const planning: Planning = { revision: 0, deadlines: {}, updatedAt: null, updatedBy: null,
  resources: [{ id: "packing", rate: 100, unit: "pieces", start: 540, end: 1080, days: [1, 2, 3, 4, 5, 6] }] };

test("month grid uses Moscow weekdays and handles year and leap-day boundaries", () => {
  const november = monthDays(moscowMonth(now));
  assert.equal(november[6], at("2026-11-01T00:00:00"));
  assert.equal(november[7], at("2026-11-02T00:00:00"));
  const january = monthDays(moscowMonth(now, 2));
  assert.equal(january[4], at("2027-01-01T00:00:00"));
  assert.ok(monthDays(moscowMonth(at("2028-02-15T12:00:00"))).includes(at("2028-02-29T00:00:00")));
  assert.equal(monthDistance(now, at("2027-01-05T00:00:00")), 2);
  assert.equal(moscowDay(Date.parse("2026-11-15T22:00:00Z")), at("2026-11-16T00:00:00"));
});

test("six-month projection preserves deadlines, excludes Sunday packing shifts and invents no packing deadline", () => {
  const start = moscowMonth(now), end = moscowMonth(start, 6);
  const index = globalCalendarEvents([row()], planning, start, end, true);
  assert.ok(index.get(at("2026-11-18T00:00:00"))?.some((event) => event.kind === "production-deadline" && event.start === at("2026-11-18T16:00:00")));
  assert.ok(index.get(at("2026-11-23T00:00:00"))?.some((event) => event.kind === "shipping-deadline"));
  assert.ok(index.get(at("2026-11-21T00:00:00"))?.some((event) => event.kind === "packing-window"));
  assert.ok(!index.get(at("2026-11-22T00:00:00"))?.some((event) => event.kind === "packing-window"));
  assert.ok(![...index.values()].flat().some((event) => event.kind === "packing-deadline"));
});

test("forecast batches group into daily windows and stay marked partial or stale", () => {
  const r = row();
  const segment = { resource: "2-go", supplyKey: r.key, taskId: "one", article: "A", phase: "print" as const, pieces: 10 };
  r.segments = [
    { ...segment, start: at("2026-11-18T09:00:00"), end: at("2026-11-18T09:30:00") },
    { ...segment, taskId: "two", start: at("2026-11-18T11:00:00"), end: at("2026-11-18T12:00:00") },
  ];
  const start = moscowMonth(now), end = moscowMonth(start, 6), day = at("2026-11-18T00:00:00");
  const entries = globalCalendarEvents([r], planning, start, end, true).get(day)!.filter((event) => event.kind === "print-work");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].start, at("2026-11-18T09:00:00"));
  assert.equal(entries[0].end, at("2026-11-18T12:00:00"));
  assert.equal(entries[0].partial, true);
  r.reasons = [];
  assert.equal(globalCalendarEvents([r], planning, start, end, false).get(day)!.find((event) => event.kind === "print-work")!.partial, true);
});

test("missing or invalid dates produce no invented events; dates outside range stay outside", () => {
  const r = row();
  r.readyAt = null; r.shipAt = "not a date"; r.packingAt = "2028-03-01T12:00:00+03:00";
  const start = moscowMonth(now);
  assert.equal(globalCalendarEvents([r], planning, start, moscowMonth(start, 6), true).size, 0);
});
