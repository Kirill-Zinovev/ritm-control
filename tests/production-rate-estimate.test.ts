import test from "node:test";
import assert from "node:assert/strict";
import {
  productionRateHistory,
  estimateProductionRate,
  planningWithAutomaticRates,
} from "../src/productionRateEstimate";
import {
  buildForecast,
  type ForecastInput,
} from "../src/productionForecastModel";
import type {
  LivePrinting,
  LiveEvent,
  BoxPrintingEvent,
} from "../src/livePrinting";
import type { Resource, Planning } from "../shared/productionPlanning";
import type { LiveAssembly } from "../src/liveAssembly";
const now = Date.parse("2026-11-13T12:00:00+03:00");
const resource = (
  id = "2-go",
  unit: Resource["unit"] = "pieces",
): Resource => ({
  id,
  rate: 0,
  rateMode: "auto",
  unit,
  days: [1, 2, 3, 4, 5],
  start: 540,
  end: 1080,
});
const events = (amounts = [900, 1800, 90000]): LiveEvent[] =>
  amounts.map((quantity, i) => ({
    id: "e" + i,
    date: "2026-11-" + (10 + i),
    sourceId: "roll-printing",
    spreadsheetId: "main",
    machine: "2-GO",
    quantity,
    area: quantity / 10,
    uid: "order",
    roll: "Д1",
    employee: "Дмитрий",
    article: "A",
    sheetId: 5,
    sheetName: "OZON",
  }));
const live = (overrides: Partial<LivePrinting> = {}): LivePrinting => ({
  ok: true,
  schemaVersion: 2,
  updatedAt: new Date(now).toISOString(),
  events: events(),
  cutEvents: [],
  supplies: [],
  sheets: [],
  issues: [],
  stockRoll: { status: "available", orders: [] },
  stockBox: { status: "available", orders: [] },
  boxPrinting: {
    status: "available",
    stockStatus: "available",
    events: [],
    cutEvents: [],
    reason: null,
  },
  ...overrides,
});
test("median shift-hour throughput uses completed days and resists one bulk spike", () => {
  const data = live(),
    before = structuredClone(data),
    history = productionRateHistory(data),
    r = estimateProductionRate(history, resource(), now);
  assert.equal(r.rate, 200);
  assert.equal(r.days, 3);
  assert.equal(r.records, 3);
  assert.equal(r.firstDay, "2026-11-10");
  assert.equal(r.lastDay, "2026-11-12");
  assert.deepEqual(data, before);
  assert.equal(
    estimateProductionRate(history, resource("2-go", "area"), now).rate,
    20,
  );
});
test("packing speed uses distinct confirmed Assembly work and preserves manual override", () => {
  const source = {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    stale: false,
    sources: { assembly: { status: "available", invalidRecords: 0 } },
    events: [900, 1800, 90000].map((quantity, i) => ({
      eventId: `a${i}`,
      operationId: "packing",
      date: `2026-11-${10 + i}`,
      quantity,
    })),
  } as unknown as LiveAssembly;
  const history = productionRateHistory(live(), source);
  assert.equal(
    estimateProductionRate(history, resource("packing"), now).rate,
    200,
  );
  const duplicate = {
    ...source,
    events: [...source.events!, source.events![0]],
  };
  assert.equal(
    estimateProductionRate(
      productionRateHistory(live(), duplicate),
      resource("packing"),
      now,
    ).rate,
    200,
  );
  const stale = { ...source, stale: true };
  assert.equal(
    estimateProductionRate(
      productionRateHistory(live(), stale),
      resource("packing"),
      now,
    ).rate,
    null,
  );
  const planning = {
    revision: 0,
    resources: [
      { ...resource("packing"), rateMode: "manual" as const, rate: 123 },
    ],
    deadlines: {},
    updatedAt: null,
    updatedBy: null,
  };
  assert.equal(
    planningWithAutomaticRates(planning, history, now).resources[0].rate,
    123,
  );
});
test("today, future, old, impossible dates and non-working days cannot distort the rate", () => {
  const extra = [
    "2026-11-13",
    "2026-11-14",
    "2026-10-01",
    "2026-02-31",
    "2026-11-08",
  ].map((date, i) => ({ ...events()[0], id: "skip" + i, date, quantity: 1e7 }));
  assert.equal(
    estimateProductionRate(
      productionRateHistory(live({ events: [...events(), ...extra] })),
      resource(),
      now,
    ).rate,
    200,
  );
  // At 00:30 Moscow, a UTC-yesterday/today distinction must still exclude local today.
  const midnight = Date.parse("2026-11-13T00:30:00+03:00");
  assert.equal(
    estimateProductionRate(
      productionRateHistory(
        live({
          updatedAt: new Date(midnight).toISOString(),
          events: [...events(), extra[0]],
        }),
      ),
      resource(),
      midnight,
    ).rate,
    200,
  );
});
test("less than three days, stale journals, unknown stock and missing shifts stay unknown", () => {
  for (const data of [
    live({ events: events().slice(0, 2) }),
    live({ stale: true }),
    live({ stockRoll: { status: "unavailable", orders: [] } }),
    live({ quality: { status: "partial", invalidRecords: 1 } }),
    live({ updatedAt: new Date(now - 16 * 60000).toISOString() }),
  ])
    assert.equal(
      estimateProductionRate(productionRateHistory(data), resource(), now).rate,
      null,
    );
  assert.match(
    estimateProductionRate(
      productionRateHistory(live()),
      { ...resource(), start: NaN },
      now,
    ).reason,
    /часы/,
  );
  assert.match(
    estimateProductionRate(
      productionRateHistory(live({ stale: true })),
      resource(),
      now,
    ).reason,
    /устарел/,
  );
  assert.match(
    estimateProductionRate(
      productionRateHistory(
        live({ stockRoll: { status: "unavailable", orders: [] } }),
      ),
      resource(),
      now,
    ).reason,
    /запасов рулонной печати/,
  );
});
test("same event counts once; conflicting duplicate invalidates the day", () => {
  const list = events();
  assert.equal(
    estimateProductionRate(
      productionRateHistory(live({ events: [...list, list[1]] })),
      resource(),
      now,
    ).rate,
    200,
  );
  const r = estimateProductionRate(
    productionRateHistory(
      live({ events: [...list, { ...list[1], quantity: 9 }] }),
    ),
    resource(),
    now,
  );
  assert.equal(r.rate, null);
  assert.equal(r.days, 2);
  assert.equal(r.excludedDays, 1);
});
test("missing area invalidates the full daily area sample, not the pieces sample", () => {
  const bad = { ...events()[0], id: "missing-area", area: 0 };
  const h = productionRateHistory(live({ events: [...events(), bad] }));
  assert.equal(
    estimateProductionRate(h, resource("2-go", "area"), now).rate,
    null,
  );
  assert.equal(estimateProductionRate(h, resource(), now).rate, 200);
});
test("main and stock journals count independently; summaries and seasonal output do not", () => {
  const stock = events().map((e) => ({ ...e, spreadsheetId: "stock" }));
  const other = events().map((e) => ({
    ...e,
    sourceId: "seasonal-printing",
    quantity: 1e7,
  }));
  const h = productionRateHistory(
    live({ events: [...events(), ...stock, ...other] }),
  );
  assert.equal(estimateProductionRate(h, resource(), now).rate, 400);
  assert.equal(h.samples.length, 6);
});
test("cutting has its own rate and does not add printing or rely on machine identity", () => {
  const cuts = events([450, 900, 45000]).map((e) => ({ ...e, machine: null }));
  const h = productionRateHistory(live({ cutEvents: cuts }));
  assert.equal(estimateProductionRate(h, resource("cut-roll"), now).rate, 100);
  assert.equal(estimateProductionRate(h, resource(), now).rate, 200);
});
test("Xerox uses actual saved sheets independently of product quantities", () => {
  const box: BoxPrintingEvent[] = events([30, 60, 3000]).map((e) => ({
    id: e.id,
    date: e.date,
    employee: "Артём",
    shipment: "OZON",
    sheetId: 7,
    spreadsheetId: "box",
    article: "X",
    machine: "XEROX",
    quantity: e.quantity,
    sheets: e.quantity * 2,
    area: e.area,
  }));
  const h = productionRateHistory(
    live({
      boxPrinting: {
        status: "available",
        stockStatus: "available",
        reason: null,
        events: box,
        cutEvents: box.map((e) => ({
          ...e,
          quantity: e.quantity / 2,
          sheets: e.sheets! / 2,
        })),
      },
    }),
  );
  assert.equal(
    estimateProductionRate(h, resource("xerox", "sheets"), now).rate,
    120 / 9,
  );
  assert.equal(estimateProductionRate(h, resource("xerox"), now).rate, 60 / 9);
  assert.equal(
    estimateProductionRate(h, resource("cut-box"), now).rate,
    30 / 9,
  );
});
test("unknown or cross-department machines never get reassigned by article", () => {
  const h = productionRateHistory(
    live({ events: events().map((e) => ({ ...e, machine: "XEROX" })) }),
  );
  assert.equal(h.samples.length, 0);
});
test("auto speed updates forecast from journals; manual and legacy rates have priority", () => {
  const planning: Planning = {
    revision: 1,
    resources: [resource(), resource("cut-roll")],
    deadlines: {},
    updatedAt: null,
    updatedBy: null,
  };
  const snapshot = live({ cutEvents: events() }),
    history = productionRateHistory(snapshot),
    before = structuredClone(planning);
  const resolved = planningWithAutomaticRates(planning, history, now);
  assert.equal(resolved.resources[0].rate, 200);
  assert.deepEqual(planning, before);
  const input: ForecastInput = {
    fresh: true,
    issues: [],
    supplies: [
      {
        key: "s",
        name: "New",
        plan: 100,
        printed: 0,
        cut: 0,
        stock: false,
        urgent: false,
      },
    ],
    tasks: [
      {
        id: "t",
        supplyKey: "s",
        name: "New",
        article: "A",
        machine: "2-go",
        department: "roll",
        plan: 100,
        printed: 0,
        cut: 0,
        areaPerPiece: 1,
        sheetsPerPiece: null,
        stock: false,
        urgent: false,
      },
    ],
  };
  const auto = buildForecast(input, resolved, now)[0];
  assert.ok(auto.finishAt);
  const manual = planningWithAutomaticRates(
    {
      ...planning,
      resources: planning.resources.map((r) => ({
        ...r,
        rateMode: "manual",
        rate: 50,
      })),
    },
    history,
    now,
  );
  assert.equal(manual.resources[0].rate, 50);
  assert.ok(buildForecast(input, manual, now)[0].finishAt! > auto.finishAt!);
  const legacy = { ...resource(), rate: 75 };
  delete legacy.rateMode;
  assert.equal(
    planningWithAutomaticRates(
      { ...planning, resources: [legacy] },
      history,
      now,
    ).resources[0].rate,
    75,
  );
  const unknown = buildForecast(
    input,
    planningWithAutomaticRates(planning, productionRateHistory(null), now),
    now,
  )[0];
  assert.equal(unknown.status, "unknown");
  assert.match(unknown.reasons.join(" "), /автоматической скорости/);
});
