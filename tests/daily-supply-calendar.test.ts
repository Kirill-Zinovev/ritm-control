import test from "node:test";
import assert from "node:assert/strict";
import { dailyForecastIssues, forecastIssueSource, suppliesOnDay, summarizeDailyEvents } from "../src/dailySupplyIndex";
import { globalCalendarEvents } from "../src/globalCalendar";
import type { GlobalCalendarEvent } from "../src/globalCalendar";
import type { ForecastRow, ForecastTask } from "../src/productionForecastModel";
import type { Planning } from "../shared/productionPlanning";

const at = (value: string) => Date.parse(`${value}+03:00`);
const row = (key: string): ForecastRow => ({
  key, name: "Одинаковое название", plan: 100, printed: 0, cut: 0, stock: false, urgent: false,
  readyAt: "2026-11-18T16:00:00+03:00", packingAt: null, shipAt: "2026-11-23T15:00:00+03:00",
  printAt: null, finishAt: null, margin: null, status: "unknown", reasons: ["Нет данных"], bottleneck: null,
  segments: [], packingFinishAt: null, packingMargin: null, packingStatus: "unknown", packingReasons: ["Нет данных"], packingSegments: [],
});
const planning: Planning = { revision: 0, deadlines: {}, updatedAt: null, updatedBy: null,
  resources: [{ id: "packing", rate: 100, unit: "pieces", start: 540, end: 1080, days: [1, 2, 3, 4, 5, 6] }] };

test("day cards retain supply identities and group several events without duplicates", () => {
  const rows = [row("one"), row("two")], before = JSON.stringify(rows);
  const index = globalCalendarEvents(rows, planning, at("2026-11-16T00:00:00"), at("2026-11-24T00:00:00"), true);
  const events = index.get(at("2026-11-18T00:00:00"))!;
  const cards = suppliesOnDay(rows, events);
  assert.deepEqual(cards.map((card) => card.row.key), ["one", "two"]);
  assert.equal(cards[0].events.length, 2, "deadline and shift window remain distinct inside one card");
  assert.deepEqual(summarizeDailyEvents(events), { supplies: 2, deadlines: 2, shipments: 0, forecast: 0, windows: 2 });
  assert.equal(JSON.stringify(rows), before, "calendar projection does not mutate production input");
});

test("shipping deadline and scheduled packing remain distinct; Sunday creates no invented work", () => {
  const rows = [row("one")];
  const index = globalCalendarEvents(rows, planning, at("2026-11-16T00:00:00"), at("2026-11-24T00:00:00"), true);
  assert.deepEqual(suppliesOnDay(rows, index.get(at("2026-11-22T00:00:00")) || []), []);
  const shipping = index.get(at("2026-11-23T00:00:00"))!;
  assert.deepEqual(summarizeDailyEvents(shipping), { supplies: 1, deadlines: 0, shipments: 1, forecast: 0, windows: 1 });
  assert.equal(shipping.find((event) => event.kind === "shipping-deadline")!.start, at("2026-11-23T15:00:00"));
  assert.ok(!shipping.some((event) => event.kind === "packing-deadline"));
});

test("an empty day does not turn missing plans into zero work or invented supplies", () => {
  assert.deepEqual(suppliesOnDay([row("one")], []), []);
  assert.deepEqual(summarizeDailyEvents([]), { supplies: 0, deadlines: 0, shipments: 0, forecast: 0, windows: 0 });
});

test("a shared forecast reason is shown once and counts affected supplies, not windows", () => {
  const event = (id: string, rowKey: string, reasons: string[], partial = true): GlobalCalendarEvent => ({
    id, rowKey, reasons, partial, day: 0, kind: "cut-work", name: rowKey, start: 1, end: 2,
  });
  const events = [
    event("1", "one", ["Очередь рассчитана частично: SKU: нет отметки", "Нет данных упаковки"]),
    event("2", "one", ["SKU: нет отметки"]),
    event("3", "two", ["Очередь не рассчитана: SKU: нет отметки"]),
    event("4", "three", []),
    event("5", "four", ["Не предупреждение"], false),
  ];
  assert.deepEqual(dailyForecastIssues(events), { affected: 3, reasons: [
    { message: "SKU: нет отметки", affected: 2 },
    { message: "Нет данных упаковки", affected: 1 },
  ] });
});

test("an issue opens its actual source only if the article and supply identify it uniquely", () => {
  const tasks = [
    { article: "LT0001.A4974", supplyKey: "moscow", name: "Москва" },
    { article: "LT0001.A4974", supplyKey: "spb", name: "СПБ" },
    { article: "JD0019.A3520", supplyKey: "white", name: "Москва 2" },
  ] as ForecastTask[];
  assert.equal(forecastIssueSource("Москва · LT0001.A4974: порезка не отмечена", tasks), "moscow");
  assert.equal(forecastIssueSource("LT0001.A4974: порезка не отмечена", tasks), null);
  assert.equal(forecastIssueSource("JD0019.A3520: срок печати не определён", tasks), "white");
  assert.equal(forecastIssueSource("JD0019.A35201: другая позиция", tasks), null);
  assert.equal(forecastIssueSource("Снимок устарел", tasks), null);
});
