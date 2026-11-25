import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { api } from "../server/api";
import { openDatabase } from "../server/local-db";
import { readRitmWarehousePage } from "../server/ritm-warehouse";
import { cartonMergeFingerprint, type CartonMergeReceipt } from "../shared/carton-merge";
import type { Carton, ExportSnapshot, Snapshot } from "../shared/model";
import { accountWorkbook } from "../src/exports/excel";
import { bootstrap } from "./fixtures";

async function setup(t: TestContext) {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  db.sqlite.prepare("update av2_supplies set origin_shipment_id='RITM-ROLL-101' where id=?").run(f.supply.id);
  const state = () => db.snapshot(f.supply.id) as Promise<Snapshot>;
  const carton = async (id: string) => (await state()).cartons.find(box => box.id === id)!;
  async function pack(positionId: string, qty: number, cartonId?: string) {
    await f.cmd("work.save", { positionId, employeeId: f.employee.id, operation: "packing", qty });
    const destination = cartonId ? { cartonId } : { newCarton: true };
    const result = await f.cmd("allocation.add", { positionId, qty, ...destination });
    return carton(String(result.cartonId));
  }
  function markLegacyAllocation(id: string, knownCapacity = true) {
    db.sqlite.prepare(`insert into av2_legacy_allocations
      select id,carton_id,position_id,qty,case when ? then units_per_box end,created_at,removed_at,removal_reason,actor
      from av2_allocations where id=?`).run(Number(knownCapacity), id);
    db.sqlite.prepare("delete from av2_allocations where id=?").run(id);
  }
  const send = (action: string, payload: Record<string, unknown>, key = crypto.randomUUID()) => api(
    new Request("https://assembly.test/api/command", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload, key, supplyId: f.supply.id, directions: true }),
    }),
    db, "workplace:merge-test", "collector",
  );
  const close = (box: Carton) => send("carton.close", {
    cartonId: box.id,
    items: box.items.map(({ id, qty }) => ({ id, qty })).sort((a, b) => a.id.localeCompare(b.id)),
  });
  const readRitm = () => readRitmWarehousePage(db.store, new URL("https://assembly.test/api/ritm/warehouse"));
  return { ...f, db, state, carton, pack, markLegacyAllocation, send, close, readRitm };
}

async function selection(source: Carton, target: Carton, fitConfirmed = false,
  choice?: string[] | { quantities: { sku: string; qty: number }[] }) {
  const picked = Array.isArray(choice) ? { skus: choice } : choice;
  return {
    sourceCartonId: source.id, cartonId: target.id,
    sourceFingerprint: await cartonMergeFingerprint(source, picked !== undefined),
    targetFingerprint: await cartonMergeFingerprint(target, picked !== undefined),
    fitConfirmed,
    ...picked,
  };
}

test("сборщик переносит весь состав, РИТМ и Excel видят новый состав и исходные позиции", async t => {
  const f = await setup(t);
  const source = await f.pack(f.a.id, 5);
  const target = await f.pack(f.b.id, 62);
  const before = await f.state();
  const response = await f.send("carton.merge", await selection(source, target));
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  const { result, state } = await response.json() as { result: { movedQty: number; qty: number }; state: Snapshot };
  assert.deepEqual([result.movedQty, result.qty], [5, 67]);
  assert.equal(state.cartons.find(box => box.id === source.id)?.qty, 0);
  const moved = state.cartons.find(box => box.id === target.id)!;
  assert.equal(moved.qty, 67);
  assert.deepEqual(moved.items.map(item => item.id).sort(), [...source.items, ...target.items].map(item => item.id).sort());
  assert.deepEqual(state.works, before.works);
  assert.deepEqual(state.positions.map(p => p.boxed), before.positions.map(p => p.boxed));
  assert.equal((await f.close(await f.carton(source.id))).status, 409);
  assert.equal((await f.close(moved)).status, 200);

  const ritm = await f.readRitm();
  const receiver = ritm.cartons.find(box => box.assemblyV2Id === target.id)!;
  assert.equal(receiver.ready, true);
  assert.deepEqual(Object.fromEntries(receiver.contents.map(item => [item.article, item.quantity])), { [f.a.sku]: 5, [f.b.sku]: 62 });
  assert.equal(ritm.cartons.find(box => box.assemblyV2Id === source.id)?.quantity, 0);
  const dispatch = await f.cmd("dispatch.create", { cartonIds: [target.id] });
  const saved = await f.cmd("export.create", { dispatchId: dispatch.dispatchId, kind: "account" });
  const file = await f.db.export(String(saved.exportId)) as ExportSnapshot;
  assert.equal(file.payload.cartons[0].qty, 67);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await accountWorkbook(file).xlsx.writeBuffer());
  const quantities = workbook.getWorksheet("Состав")!.getColumn("H").values as unknown[];
  assert.deepEqual(quantities.filter(value => typeof value === "number").sort((a, b) => a - b), [5, 62]);
});

test("слияние по артикулам переносит все выбранные строки, сохраняет остаток и состав для РИТМ", async t => {
  const f = await setup(t);
  const initialSource = await f.pack(f.a.id, 12);
  const extra = await f.pack(f.a.id, 8, initialSource.id);
  const legacy = extra.items.find(item => item.qty === 8)!;
  f.markLegacyAllocation(legacy.id);
  const source = await f.pack(f.b.id, 80, initialSource.id);
  const target = await f.pack(f.a.id, 50);
  const before = await f.state();
  assert.ok(source.fill + target.fill > 1);
  const selected = await selection(source, target, false, [f.a.sku.toLocaleLowerCase("ru-RU")]);
  const key = crypto.randomUUID();
  const response = await f.send("carton.merge", selected, key);
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  const { result: saved, state } = await response.json() as { result: CartonMergeReceipt; state: Snapshot };
  assert.deepEqual([saved.movedQty, saved.qty, saved.sourceRemaining?.qty], [20, 70, 80]);
  assert.equal(Math.round(saved.fill * 100), 70);
  assert.equal(Math.round(saved.sourceRemaining!.fill * 100), 40);
  assert.equal(saved.fitConfirmed, false);
  const receiver = state.cartons.find(box => box.id === target.id)!;
  const donor = state.cartons.find(box => box.id === source.id)!;
  assert.deepEqual(donor.items.map(item => [item.sku, item.qty]), [[f.b.sku, 80]]);
  assert.deepEqual(receiver.items.map(item => item.id).sort(), [
    ...source.items.filter(item => item.sku === f.a.sku), ...target.items,
  ].map(item => item.id).sort());
  assert.deepEqual(state.works, before.works);
  assert.deepEqual(state.positions.map(p => p.boxed), before.positions.map(p => p.boxed));
  const retried = await f.send("carton.merge", selected, key);
  assert.equal(retried.status, 200);
  assert.deepEqual((await retried.json()).result, saved);
  assert.equal((await f.close(receiver)).status, 200);
  const ritm = await f.readRitm();
  const ritmReceiver = ritm.cartons.find(box => box.assemblyV2Id === target.id)!;
  assert.equal(ritmReceiver.ready, true);
  assert.equal(ritmReceiver.quantity, 70);
  assert.ok(ritmReceiver.contents.every(item => item.article === f.a.sku));
  const ritmDonor = ritm.cartons.find(box => box.assemblyV2Id === source.id)!;
  assert.deepEqual(ritmDonor.contents.map(item => [item.article, item.quantity]), [[f.b.sku, 80]]);
});

test("выбор артикулов проверяется сервером, переполнение выбранным товаром требует подтверждения", async t => {
  const f = await setup(t);
  const initialSource = await f.pack(f.a.id, 45);
  const source = await f.pack(f.b.id, 20, initialSource.id);
  const target = await f.pack(f.a.id, 90);
  for (const [skus, message] of [
    [[], /Отметьте хотя бы один артикул/],
    [["ЧУЖОЙ-АРТИКУЛ"], /Выбранных артикулов уже нет/],
    [[f.a.sku], /Подтвердите, что весь состав/],
  ] as const) {
    const declined = await f.send("carton.merge", await selection(source, target, false, [...skus]));
    assert.equal(declined.status, 409);
    assert.match(await declined.text(), message);
  }
  assert.equal((await f.carton(source.id)).qty, 65);
  assert.equal((await f.carton(target.id)).qty, 90);
  const response = await f.send("carton.merge", await selection(source, target, true, [f.a.sku]));
  assert.equal(response.status, 200);
  const { result } = await response.json() as { result: CartonMergeReceipt };
  assert.equal(result.fitConfirmed, true);
  assert.deepEqual([result.movedQty, result.qty, result.sourceRemaining?.qty], [45, 135, 20]);
});

test("артикул без нормы может остаться в исходном коробе при выборочном переносе", async t => {
  const f = await setup(t);
  const initialSource = await f.pack(f.a.id, 5);
  const withBoth = await f.pack(f.b.id, 20, initialSource.id);
  const other = withBoth.items.find(item => item.sku === f.b.sku)!;
  f.markLegacyAllocation(other.id, false);
  const source = await f.carton(initialSource.id);
  const target = await f.pack(f.a.id, 30);
  const whole = await f.send("carton.merge", await selection(source, target));
  assert.equal(whole.status, 409);
  assert.match(await whole.text(), /не задана вместимость/);
  const selected = await f.send("carton.merge", await selection(source, target, false, [f.a.sku]));
  assert.equal(selected.status, 200);
  const { result } = await selected.json() as { result: CartonMergeReceipt };
  assert.deepEqual(result.sourceRemaining, { qty: 20, fill: 0, capacityUnknown: true });
});

test("смена артикула после предпросмотра останавливает выборочный перенос", async t => {
  const f = await setup(t);
  const initialSource = await f.pack(f.a.id, 5);
  const source = await f.pack(f.b.id, 20, initialSource.id);
  const target = await f.pack(f.a.id, 30);
  const oldChoice = await selection(source, target, false, [f.a.sku]);
  f.db.sqlite.prepare("update av2_positions set sku=? where id=?").run(f.a.sku, f.b.id);
  const response = await f.send("carton.merge", oldChoice);
  assert.equal(response.status, 409);
  assert.match(await response.text(), /Состав коробов изменился/);
  assert.equal((await f.carton(source.id)).qty, 25);
  assert.equal((await f.carton(target.id)).qty, 30);
});

test("из 50 штук переносит ровно 20, сохраняет исходную норму и отмену упаковки", async t => {
  const f = await setup(t);
  const source = await f.pack(f.a.id, 50);
  const target = await f.pack(f.b.id, 62);
  const workId = String(f.db.sqlite.prepare("select id from av2_work where position_id=?").get(f.a.id)!.id);
  const before = await f.state();
  const payload = await selection(source, target, false, { quantities: [{ sku: f.a.sku, qty: 20 }] });
  const key = crypto.randomUUID();
  const response = await f.send("carton.merge", payload, key);
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  const { result, state } = await response.json() as {
    result: CartonMergeReceipt & { items: { id: string; splitFromId: string; qty: number }[] };
    state: Snapshot;
  };
  assert.deepEqual([result.movedQty, result.qty, result.sourceRemaining?.qty], [20, 82, 30]);
  assert.equal(Math.round(result.fill * 100), 51);
  assert.equal(result.items[0].splitFromId, source.items[0].id);
  const donor = state.cartons.find(box => box.id === source.id)!;
  const receiver = state.cartons.find(box => box.id === target.id)!;
  assert.deepEqual(donor.items.map(item => [item.id, item.qty]), [[source.items[0].id, 30]]);
  const fragment = receiver.items.find(item => item.id === result.items[0].id)!;
  assert.deepEqual([fragment.qty, fragment.positionId, fragment.unitsPerBox], [20, f.a.id, f.a.unitsPerBox]);
  assert.deepEqual(state.works, before.works);
  assert.deepEqual(state.positions.map(item => item.boxed), before.positions.map(item => item.boxed));
  const replay = await f.send("carton.merge", payload, key);
  assert.equal(replay.status, 200);
  assert.deepEqual((await replay.json()).result, result);
  const ritm = await f.readRitm();
  assert.deepEqual(
    [source, target].map(box =>
      ritm.cartons.find(row => row.assemblyV2Id === box.id)?.contents.find(item => item.article === f.a.sku)?.quantity),
    [30, 20],
  );
  await f.cmd("work.cancel", { workId, reason: "Проверка отмены после переноса" });
  assert.equal((await f.carton(source.id)).qty, 0);
  assert.deepEqual((await f.carton(target.id)).items.map(item => [item.sku, item.qty]), [[f.b.sku, 62]]);
});

test("количества по двум артикулам проверяются и переносятся атомарно при подтверждённом переполнении", async t => {
  const f = await setup(t);
  const initial = await f.pack(f.a.id, 50);
  const combined = await f.pack(f.b.id, 40, initial.id);
  f.markLegacyAllocation(combined.items.find(item => item.sku === f.b.sku)!.id);
  const source = await f.carton(initial.id);
  const target = await f.pack(f.a.id, 90);
  const amounts = [{ sku: f.a.sku, qty: 20 }, { sku: f.b.sku, qty: 10 }];
  for (const invalid of [0, 51, 1.5]) {
    const response = await f.send("carton.merge", await selection(source, target, true, {
      quantities: [{ sku: f.a.sku, qty: invalid }, amounts[1]],
    }));
    assert.equal(response.status, 409);
  }
  const unconfirmed = await f.send("carton.merge", await selection(source, target, false, { quantities: amounts }));
  assert.equal(unconfirmed.status, 409);
  assert.match(await unconfirmed.text(), /Подтвердите, что весь состав/);
  assert.equal((await f.carton(source.id)).qty, 90);
  assert.equal((await f.carton(target.id)).qty, 90);
  const confirmed = await f.send("carton.merge", await selection(source, target, true, { quantities: amounts }));
  assert.equal(confirmed.status, 200, confirmed.status === 200 ? "" : await confirmed.text());
  const { result } = await confirmed.json() as { result: CartonMergeReceipt };
  assert.deepEqual([result.movedQty, result.qty, result.sourceRemaining?.qty, result.fitConfirmed], [30, 120, 60, true]);
  assert.equal(Math.round(result.fill * 100), 115);
  assert.deepEqual((await f.carton(source.id)).items.map(item => item.qty).sort(), [30, 30]);
  assert.equal(f.db.sqlite.prepare("select qty from av2_legacy_allocations where carton_id=?").get(target.id)?.qty, 10);
});

test("превышение нормы требует явного подтверждения, повтор сохраняет перенос один раз", async t => {
  const f = await setup(t);
  const source = await f.pack(f.a.id, 45);
  const target = await f.pack(f.a.id, 90);
  const declined = await f.send("carton.merge", await selection(source, target));
  assert.equal(declined.status, 409);
  assert.match(await declined.text(), /Подтвердите, что весь состав/);
  assert.equal((await f.carton(source.id)).qty, 45);
  assert.equal((await f.carton(target.id)).qty, 90);

  const payload = await selection(source, target, true), key = crypto.randomUUID();
  const responses = await Promise.all([f.send("carton.merge", payload, key), f.send("carton.merge", payload, key)]);
  for (const response of responses) {
    assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
    const { result } = await response.json() as { result: { qty: number; fill: number; fitConfirmed: boolean } };
    assert.deepEqual(result.qty, 135);
    assert.equal(result.fitConfirmed, true);
    assert.equal(Math.round(result.fill * 100), 135);
  }
  const merged = await f.carton(target.id);
  assert.equal(merged.qty, 135);
  assert.ok(merged.items.every(item => item.unitsPerBox === f.a.unitsPerBox));
  assert.equal(f.db.sqlite.prepare("select count(*) n from av2_commands where action='carton.merge'").get()?.n, 1);
  assert.equal((await f.close(merged)).status, 200);
  assert.equal((await f.readRitm()).cartons.find(box => box.assemblyV2Id === target.id)?.ready, true);
});

test("подтверждение не разрешает перенос изменившегося состава и в чужой магазин", async t => {
  const f = await setup(t);
  const source = await f.pack(f.a.id, 20);
  const target = await f.pack(f.b.id, 30);
  const stale = await selection(source, target, true);
  await f.cmd("work.save", { positionId: f.b.id, employeeId: f.employee.id, operation: "packing", qty: 1 });
  await f.cmd("allocation.add", { positionId: f.b.id, qty: 1, cartonId: target.id });
  const changed = await f.send("carton.merge", stale);
  assert.equal(changed.status, 409);
  assert.match(await changed.text(), /Состав коробов изменился/);
  f.db.sqlite.prepare("update av2_cartons set store='2' where id=?").run(target.id);
  const otherStore = await f.send("carton.merge", await selection(source, await f.carton(target.id), true));
  assert.equal(otherStore.status, 409);
  assert.match(await otherStore.text(), /подтверждённого магазина/);
  assert.equal((await f.carton(source.id)).qty, 20);
  assert.equal((await f.carton(target.id)).qty, 31);
});

test("после слияния перенесённых из старой Сборки коробов РИТМ выбирает обновлённый состав", async t => {
  const f = await setup(t);
  const [source, target] = [await f.pack(f.a.id, 5), await f.pack(f.b.id, 62)];
  const legacy = f.db.sqlite.prepare("insert into av2_legacy_records values(?,?,?,?,'now')");
  for (const box of [source, target]) {
    const legacyId = "imported-" + box.label;
    legacy.run("cartonAlias", box.id, "fixture", JSON.stringify({ legacySourceId: legacyId }));
    legacy.run("cartons", legacyId, "fixture", JSON.stringify({
      sourceId: legacyId, label: box.label, state: "open", raw: { shipmentId: "RITM-ROLL-101" },
    }));
    f.db.sqlite.prepare(`insert into av2_legacy_allocations
      select id,carton_id,position_id,qty,units_per_box,created_at,removed_at,removal_reason,actor
      from av2_allocations where carton_id=?`).run(box.id);
    f.db.sqlite.prepare("delete from av2_allocations where carton_id=?").run(box.id);
  }
  assert.ok((await f.readRitm()).cartons.every(box => !box.modifiedInV2));
  assert.equal((await f.send("carton.merge", await selection(source, target))).status, 200);
  const touched = (await f.readRitm()).cartons;
  assert.equal(touched.find(box => box.assemblyV2Id === source.id)?.quantity, 0);
  assert.equal(touched.find(box => box.assemblyV2Id === target.id)?.quantity, 67);
  assert.ok(touched.every(box => box.modifiedInV2 && box.legacyId));
});
