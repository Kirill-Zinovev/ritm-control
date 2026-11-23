import assert from "node:assert/strict";
import test from "node:test";
import type { Supply } from "../shared/model";
import type { RitmSchedule } from "../shared/ritm";
import { compareDeadlines, compareShippingDates, deadlineCaption, supplyDeadlines } from "../shared/supply-deadlines";

const now = Date.parse("2026-11-19T18:00:00Z");
const bare: Supply = { id: "a", externalId: "a", sourceVersion: 1, title: "Казань", market: "OZON", store: "2", destination: "Казань" };
const readyAt = "2026-11-19T15:00:00.000Z";
const packingAt = "2026-11-19T19:00:00.000Z";
const shipAt = "2026-11-19T21:30:00.000Z";
const schedule = { readyAt, packingAt, shipAt, printed: true, cut: false, urgent: false };

test("one RITM deadline displays distinct print and cut facts, with Moscow weekdays", () => {
  const deadlines = supplyDeadlines({ ...bare, schedule }, now);
  assert.equal(deadlines.stages[0].at, deadlines.stages[1].at);
  assert.deepEqual(deadlines.stages.map(s => s.state), ["done", "overdue", "today", "tomorrow"]);
  assert.equal(deadlineCaption(deadlines), "Просрочена резка");
  const afterPacking = supplyDeadlines({ ...bare, packingComplete: true, schedule: { ...schedule, cut: true } }, now);
  assert.equal(afterPacking.next?.id, "shipping");
  assert.equal(deadlineCaption(afterPacking, true), "Отправка завтра · 00:30");
});

test("overdue supplies come first, then urgent, next day and undated supplies", () => {
  const make = (changes: Partial<RitmSchedule>, packingComplete = false) =>
    supplyDeadlines({ ...bare, packingComplete, schedule: { ...schedule, ...changes } }, now);
  const missing = supplyDeadlines(bare, now);
  const urgent = make({ readyAt: null, packingAt: null, shipAt: null, urgent: true });
  const tomorrow = make({ cut: true }, true);
  const overdue = make({});
  assert.deepEqual([missing, urgent, tomorrow, overdue].sort(compareDeadlines), [overdue, urgent, tomorrow, missing]);
  assert.equal(deadlineCaption(urgent), "Срочная поставка");
});

test("shipment cards prioritize earlier departures over earlier production deadlines", () => {
  const laterDeparture = supplyDeadlines({ ...bare, schedule }, now);
  const earlierDeparture = supplyDeadlines({ ...bare, schedule: {
    ...schedule, readyAt: null, packingAt: null, shipAt: "2026-11-19T20:30:00.000Z",
  } }, now);
  const undated = supplyDeadlines({ ...bare, schedule: { ...schedule, shipAt: null } }, now);
  assert.deepEqual([undated, laterDeparture, earlierDeparture].sort(compareShippingDates),
    [earlierDeparture, laterDeparture, undated]);
});
