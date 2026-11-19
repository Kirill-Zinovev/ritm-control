import assert from "node:assert/strict";
import test from "node:test";
import type { PositionSearchPage } from "../shared/position-search";
import { api } from "../server/api";
import { openDatabase } from "../server/local-db";
import { searchPositions } from "../server/position-search";
import { bootstrap, fixture } from "./fixtures";

test("position search returns active exact and prefix matches with their actual supply and packing", async t => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const { cmd, employee, supply: demo } = await bootstrap(db);
  db.sqlite.prepare("update av2_supplies set is_demo=1 where id=?").run(demo.id);
  async function supply(id: string, skus: string[], active = true, positionActive = true) {
    const result = await cmd("supply.import", {
      ...fixture,
      externalId: id,
      title: `OZON Москва ${id} (1 магазин)`,
      sourceActive: active,
      positions: skus.map((sku, i) => ({ ...fixture.positions[0], externalId: `${id}|${i}`, sku, sourceActive: positionActive })),
    });
    return String(result.supplyId);
  }
  const current = await supply("current", ["SKU.A1"]);
  const exact = await supply("exact", ["sku.a1"]);
  const other = await supply("other", ["SKU.A10", "SKUX_A1", "SKU_A1"]);
  await supply("archive", ["SKU.A1"], false);
  await supply("inactive-position", ["SKU.A1"], true, false);
  await supply("many", Array.from({ length: 28 }, (_, i) => `SKU.A1-${i}`));
  const { id: positionId } = db.sqlite.prepare("select id from av2_positions where supply_id=?").get(exact)!;
  await cmd("work.save", { positionId, employeeId: employee.id, operation: "packing", qty: 8 });

  const endpoint = "https://assembly.test/api/positions/search";
  const request = new Request(`${endpoint}?q=%20Sku.a1%20&supply=${current}`);
  assert.equal((await api(request, db, "", "collector")).status, 401);
  const response = await api(request, db, "collector", "collector");
  assert.equal(response.status, 200);
  const page = await response.json() as PositionSearchPage;
  assert.equal(page.items.length, 24);
  assert.equal(page.nextOffset, 24);
  assert.equal(page.items[0].id, positionId);
  assert.equal(page.items[0].supplyId, exact);
  assert.equal(page.items[0].packing, 8);
  assert.equal(page.items[0].store, "1");
  assert.equal(page.items[0].supplyTitle, "OZON Москва exact (1 магазин)");
  const next = await searchPositions(db.store, new URL(request.url + "&offset=24"));
  const all = [...page.items, ...next.items];
  assert.equal(next.nextOffset, null);
  assert.equal(all.length, 30);
  assert.equal(new Set(all.map(item => item.id)).size, all.length);
  assert.ok(all.some(item => item.supplyId === other && item.sku === "SKU.A10"));
  assert.ok(all.every(item => item.sku.toUpperCase().startsWith("SKU.A1")));
  assert.ok(all.every(item => item.supplyId !== current));
  assert.deepEqual((await searchPositions(db.store, new URL(endpoint + "?q=SKU_A"))).items.map(item => item.sku), ["SKU_A1"]);
  assert.deepEqual((await searchPositions(db.store, new URL(endpoint + "?q=ДЕМО"))).items, []);

  const plans: string[] = [];
  await searchPositions({
    ...db.store,
    async all<T>(sql: string, args = []) {
      const query = db.sqlite.prepare(`explain query plan ${sql}`).all(...args);
      plans.push(...query.map(entry => String(entry.detail)));
      return db.store.all<T>(sql, args);
    },
  }, new URL(request.url));
  assert.ok(plans.some(plan => plan.includes("av2_active_positions_sku") && plan.includes(">?")), plans.join("\n"));
});
