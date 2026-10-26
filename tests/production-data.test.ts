import test from "node:test";
import assert from "node:assert/strict";
import type { LiveOrder, LivePrinting } from "../src/livePrinting";
import {
  buildProductionGroups,
  productionStoreCoverage,
  productionStoreName,
} from "../src/productionData";

const order = (overrides: Partial<LiveOrder>): LiveOrder => ({
  uid: "uid",
  sheetId: 10,
  sheetName: "OZON Поставка",
  row: 5,
  article: "SKU",
  quantity: 10,
  plannedArea: 0,
  sourceId: "roll-printing",
  shop: "1",
  shopCatalogStatus: "matched",
  packed: 0,
  ...overrides,
});
const live = (
  supplies: LiveOrder[],
  sheets: LivePrinting["sheets"],
): LivePrinting => ({
  ok: true,
  schemaVersion: 2,
  updatedAt: "2026-01-01T00:00:00.000Z",
  events: [],
  supplies,
  sheets,
  issues: [],
});

test("linked legacy departments are one supply without joining by name", () => {
  const data = live(
    [
      order({ article: "ROLL", quantity: 7 }),
      order({
        sourceId: "box-printing",
        sheetId: 20,
        assemblyShipmentId: "RITM-ROLL-10",
        article: "BOX",
        quantity: 13,
      }),
    ],
    [
      { sourceId: "roll-printing", sheetId: 10, name: "OZON Поставка" },
      {
        sourceId: "box-printing",
        sheetId: 20,
        name: "OZON Поставка",
        assemblyShipmentId: "RITM-ROLL-10",
      },
    ],
  );
  const groups = buildProductionGroups(data);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].plan, 20);
  assert.equal(groups[0].orders.length, 2);
  assert.equal(groups[0].rows.length, 2);
});

test("future multi-department supply uses manifest identity including older snapshot metadata", () => {
  const data = live(
    [
      order({ assemblyShipmentId: "RITM-SUPPLY-future", article: "ROLL" }),
      order({
        sourceId: "box-printing",
        sheetId: 20,
        assemblyShipmentId: "RITM-SUPPLY-future",
        article: "BOX",
      }),
    ],
    [
      { sourceId: "roll-printing", sheetId: 10, name: "ОЗОН Новая" },
      {
        sourceId: "box-printing",
        sheetId: 20,
        name: "ОЗОН Новая",
        assemblyShipmentId: "RITM-SUPPLY-future",
      },
    ],
  );
  const groups = buildProductionGroups(data);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].market, "Ozon");
  assert.equal(groups[0].key, "shipment:RITM-SUPPLY-future");
  assert.equal(groups[0].plan, 20);
});

test("same shipment names with different identities are never merged", () => {
  const data = live(
    [
      order({ assemblyShipmentId: "first" }),
      order({
        sheetId: 20,
        sourceId: "box-printing",
        assemblyShipmentId: "second",
      }),
    ],
    [
      {
        sheetId: 10,
        sourceId: "roll-printing",
        name: "WB одинаковое название",
        assemblyShipmentId: "first",
      },
      {
        sheetId: 20,
        sourceId: "box-printing",
        name: "WB одинаковое название",
        assemblyShipmentId: "second",
      },
    ],
  );
  assert.equal(buildProductionGroups(data).length, 2);
});

test("article totals conserve quantities, keep over-plan work and retain incomplete facts", () => {
  const data = live(
    [
      order({ uid: "one", quantity: 10, packed: 15, printProgress: 5 }),
      order({ uid: "two", quantity: 20, packed: 20, printProgress: null }),
    ],
    [{ sheetId: 10, sourceId: "roll-printing", name: "OZON Поставка" }],
  );
  const [group] = buildProductionGroups(data);
  assert.equal(group.rows.length, 1);
  assert.equal(group.plan, 30);
  assert.equal(group.packed.value, 35);
  assert.equal(group.packed.complete, true);
  assert.equal(group.printed.value, 5);
  assert.equal(group.printed.complete, false);
  assert.equal(group.rows[0].orders.length, 2);
});

test("store warnings only count currently displayed production orders", () => {
  const data = live(
    [
      order({}),
      order({
        sheetId: 30,
        sourceId: "seasonal-printing",
        shopCatalogStatus: "missing",
      }),
    ],
    [
      { sheetId: 10, sourceId: "roll-printing", name: "OZON Поставка" },
      { sheetId: 30, sourceId: "seasonal-printing", name: "OZON Архив" },
    ],
  );
  const displayed = buildProductionGroups(data).flatMap(
    (group) => group.orders,
  );
  assert.deepEqual(productionStoreCoverage(displayed), {
    matched: 1,
    missing: 0,
    ambiguous: 0,
    unavailable: 0,
    unknown_marketplace: 0,
  });
  const missing = order({ shop: "1", shopCatalogStatus: "missing" });
  assert.equal(productionStoreName(missing), "Не указан");
  assert.equal(productionStoreCoverage([missing]).missing, 1);
});
