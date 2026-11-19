import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/local-db";
import { bootstrap, fixture } from "./fixtures";
import type { Snapshot } from "../shared/model";
import { groupDirections } from "../shared/directions";
import { readRitmWarehousePage } from "../server/ritm-warehouse";

async function setup(t: { after(fn: () => void): void }) {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  const state = async () => (await db.snapshot(f.supply.id)) as Snapshot;
  const pack = async (qty: number) => {
    await f.cmd("work.save", {
      positionId: f.a.id,
      employeeId: f.employee.id,
      operation: "packing",
      qty,
    });
    return (await state()).works.find((w) => !w.canceled)!;
  };
  const box = async () =>
    String((await f.cmd("carton.create", { supplyId: f.supply.id })).cartonId);
  const add = (qty: number, cartonId: string) =>
    f.cmd("allocation.add", { positionId: f.a.id, qty, cartonId });
  return { ...f, db, state, pack, box, add };
}
test("cancel packing removes only that FIFO share, including partial allocations; replay retains history and coefficients", async (t) => {
  const f = await setup(t),
    first = await f.pack(30);
  await new Promise((r) => setTimeout(r, 3));
  const second = await f.pack(20),
    box = await f.box();
  await f.add(40, box);
  const before = await f.state(),
    key = crypto.randomUUID(),
    payload = { workId: first.id, reason: "Ошибка упаковки" };
  await Promise.all([
    f.cmd("work.cancel", payload, key),
    f.cmd("work.cancel", payload, key),
  ]);
  const s = await f.state();
  assert.equal(s.positions[0].packing, 20);
  assert.equal(s.positions[0].boxed, 10);
  assert.equal(s.cartons[0].qty, 10);
  assert.equal(s.works.find((w) => w.id === first.id)?.canceled, true);
  assert.equal(s.works.find((w) => w.id === second.id)?.canceled, false);
  assert.equal(
    f.db.sqlite
      .prepare("select count(*) n from av2_corrections where work_id=?")
      .get(first.id)?.n,
    1,
  );
  assert.equal(
    f.db.sqlite.prepare("select count(*) n from av2_quality_repairs").get()?.n,
    1,
  );
  assert.equal(s.cartons[0].items[0].id, before.cartons[0].items[0].id);
});
test("packing across two boxes is removed atomically and closed cartons reopen; other products remain", async (t) => {
  const f = await setup(t),
    work = await f.pack(30),
    one = await f.box(),
    two = await f.box();
  await f.add(10, one);
  await f.add(20, two);
  await f.cmd("work.save", {
    positionId: f.b.id,
    employeeId: f.employee.id,
    operation: "packing",
    qty: 5,
    cartonId: one,
  });
  const b = (await f.state()).cartons.find((c) => c.id === one)!;
  await f.cmd("carton.close", {
    cartonId: one,
    items: b.items
      .map((i) => ({ id: i.id, qty: i.qty }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  await f.cmd("work.cancel", { workId: work.id, reason: "Ошибка ввода" });
  const s = await f.state();
  assert.equal(s.positions.find((p) => p.id === f.a.id)?.packing, 0);
  assert.equal(s.positions.find((p) => p.id === f.a.id)?.boxed, 0);
  assert.equal(s.cartons.find((c) => c.id === one)?.state, "open");
  assert.equal(s.cartons.find((c) => c.id === one)?.qty, 5);
  assert.equal(s.cartons.find((c) => c.id === two)?.qty, 0);
  assert.equal(s.positions.find((p) => p.id === f.b.id)?.packing, 5);
});
test("a selected departure blocks the entire cancellation without changing any other carton or work", async (t) => {
  const f = await setup(t),
    work = await f.pack(20),
    one = await f.box(),
    two = await f.box();
  await f.add(10, one);
  await f.add(10, two);
  const b = (await f.state()).cartons.find((c) => c.id === two)!;
  await f.cmd("carton.close", {
    cartonId: two,
    items: b.items.map((i) => ({ id: i.id, qty: i.qty })),
  });
  await f.cmd("dispatch.create", { cartonIds: [two] });
  const before = await f.state();
  await assert.rejects(
    f.cmd("work.cancel", { workId: work.id, reason: "Ошибка ввода" }),
    /отгруз/,
  );
  assert.deepEqual(await f.state(), before);
  assert.equal(
    f.db.sqlite.prepare("select count(*) n from av2_quality_repairs").get()?.n,
    0,
  );
});
test("partial imported carton corrections are visible as native changes to RITM; cutting never removes packing", async (t) => {
  const f = await setup(t),
    work = await f.pack(10);
  await f.pack(20);
  const box = await f.box();
  await f.add(25, box);
  const row = f.db.sqlite.prepare("select * from av2_allocations").get()!;
  f.db.sqlite.prepare("delete from av2_allocations where id=?").run(row.id);
  f.db.sqlite
    .prepare(
      "insert into av2_legacy_allocations(id,carton_id,position_id,qty,units_per_box,created_at,actor) values(?,?,?,?,?,?,?)",
    )
    .run(row.id, box, f.a.id, 25, row.units_per_box, row.created_at, "legacy");
  await f.cmd("work.cancel", { workId: work.id, reason: "Ошибка упаковки" });
  assert.equal((await f.state()).cartons[0].qty, 15);
  await f.cmd("work.save", {
    positionId: f.a.id,
    employeeId: f.employee.id,
    operation: "cut",
    qty: 10,
  });
  const cut = (await f.state()).works.find((w) => w.operation === "cut")!;
  await f.cmd("work.cancel", { workId: cut.id, reason: "Ошибка резки" });
  assert.equal((await f.state()).cartons[0].qty, 15);
  const page = await readRitmWarehousePage(
    f.db.store,
    new URL("https://test/api/ritm/warehouse"),
  );
  assert.equal(
    (page as { cartons: { quantity: number; modifiedInV2: boolean }[] })
      .cartons[0].quantity,
    15,
  );
  assert.equal(
    (page as { cartons: { modifiedInV2: boolean }[] }).cartons[0].modifiedInV2,
    true,
  );
});
test("directions group only the old recognized city/market/store combinations and preserve every original position", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  for (const [id, title, store] of [
    ["spb-a", "OZON СПБ (1-й Магазин)", "1"],
    ["spb-b", "OZON Санкт-Петербург XEROX", "1"],
    ["spb-c", "OZON СПБ", "2"],
  ])
    await f.cmd("supply.import", {
      ...fixture,
      externalId: id,
      title,
      destination: title,
      store,
    });
  const ungrouped = (await db.snapshot(null)) as Snapshot,
    chosen = ungrouped.supplies.find((s) => s.externalId === "spb-a")!;
  const s = (await db.snapshot(chosen.id, true, true)) as Snapshot,
    g = s.supplies.find((s) => s.id === chosen.id)!;
  assert.equal(g.title, "OZON СПБ · Магазин 1");
  assert.equal(g.sources?.length, 2);
  assert.equal(s.positions.length, fixture.positions.length * 2);
  assert.equal(new Set(s.positions.map((p) => p.id)).size, s.positions.length);
  assert.equal(new Set(s.positions.map((p) => p.supplyId)).size, 2);
  assert.equal(
    s.progress.plan,
    s.positions.reduce((n, p) => n + p.plan, 0),
  );
  assert.equal(s.sourceSupplies?.length, ungrouped.supplies.length);
  assert(s.supplies.some((g) => g.store === "2" && g.title.includes("СПБ")));
  const unknown = { ...chosen, title: "OZON Неизвестный склад" };
  assert.equal(
    groupDirections(
      [
        { ...unknown, id: "u1" },
        { ...unknown, id: "u2" },
      ],
      null,
    ).length,
    2,
  );
  assert.equal(
    groupDirections([chosen, { ...chosen, id: "wb", market: "WB" }], null)
      .length,
    2,
  );
  const p = s.positions.find((p) => p.supplyId !== chosen.id)!;
  await f.cmd("work.save", {
    positionId: p.id,
    employeeId: f.employee.id,
    operation: "packing",
    qty: 3,
  });
  const updated = (await db.snapshot(chosen.id, true, true)) as Snapshot;
  assert.equal(updated.positions.find((x) => x.id === p.id)?.packing, 3);
  const archived = ungrouped.supplies.find((x) => x.externalId === "spb-b")!;
  db.sqlite
    .prepare("update av2_supplies set source_active=0 where id=?")
    .run(archived.id);
  const current = (await db.snapshot(chosen.id, true, true)) as Snapshot;
  assert.equal(current.positions.length, fixture.positions.length);
  assert(current.positions.every((p) => p.supplyId === chosen.id));
  assert(
    !current.supplies
      .flatMap((s) => s.sources || [])
      .some((s) => s.id === archived.id),
  );
  await f.cmd("supply.import", {
    ...fixture,
    externalId: "closed-wb",
    title: "WB Кострома",
    market: "WB",
    destination: "Кострома",
  });
  db.sqlite
    .prepare(
      "update av2_supplies set source_active=0 where external_id='closed-wb'",
    )
    .run();
  const noClosed = (await db.snapshot(chosen.id, true, true)) as Snapshot;
  assert(!noClosed.supplies.some((s) => s.market === "WB"));
  assert(noClosed.sourceSupplies?.some((s) => s.externalId === "closed-wb"));
  const historical = (await db.snapshot(archived.id, true, true)) as Snapshot;
  assert(historical.positions.every((p) => p.supplyId === archived.id));
  assert.equal(
    updated.positions.find((x) => x.supplyId === chosen.id && x.sku === p.sku)
      ?.packing,
    0,
  );
});
