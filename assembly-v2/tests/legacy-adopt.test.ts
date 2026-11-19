import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/local-db";
import { readRitmWarehousePage } from "../server/ritm-warehouse";
import { bootstrap } from "./fixtures";
import type { Snapshot } from "../shared/model";

const workbook = "1dn7a7s-Ev9vLuNE2W8lECVwXCdpq8DXvC5Gt_O1sBbI";

async function fixture() {
  const db = await openDatabase();
  const f = await bootstrap(db);
  db.sqlite.prepare("update av2_supplies set origin_shipment_id='RITM-ROLL-10' where id=?").run(f.supply.id);
  await f.cmd("work.save", { positionId: f.a.id, employeeId: f.employee.id, operation: "packing", qty: 44 });
  await f.cmd("work.save", { positionId: f.b.id, employeeId: f.employee.id, operation: "packing", qty: 60 });
  const created = await f.cmd("carton.create", { supplyId: f.supply.id });
  await f.cmd("allocation.add", { positionId: f.a.id, cartonId: created.cartonId, qty: 44 });
  const state = await db.snapshot(f.supply.id) as Snapshot;
  const carton = state.cartons.find((b) => b.id === created.cartonId)!;
  const sourceId = "carton-original", allocationId = "allocation-original";
  const payload = {
    sourceWorkbookId: workbook,
    sourceHash: "ab".repeat(32),
    confirmed: true,
    reason: "Владелец подтвердил состав старого Assembly",
    box: { sourceId, id: carton.id, label: carton.label, market: carton.market, store: carton.store, destination: carton.destination, state: "open", createdAt: "2026-11-16T08:00:00Z", raw: { cartonId: sourceId, "Номер": carton.label, "Статус": "Открыт", "Занято, шт": 60, shipmentId: "RITM-ROLL-10" } },
    expected: carton.items.map((i) => ({ id: i.id, positionId: i.positionId, qty: i.qty })),
    placements: [{ sourceId: allocationId, id: "legacy:" + allocationId, cartonId: carton.id, positionId: f.b.id, qty: 60, unitsPerBox: 200, createdAt: "2026-11-16T08:01:00Z", raw: { allocationId, cartonId: sourceId, shipmentId: "RITM-ROLL-10", positionId: f.b.externalId, "Артикул": f.b.sku } }],
  };
  return { db, f, carton, payload };
}

test("сверка совпавшего номера сохраняет работу и передаёт в РИТМ исходную идентичность короба", async (t) => {
  const { db, f, carton, payload } = await fixture();
  t.after(() => db.sqlite.close());
  const workBefore = db.sqlite.prepare("select * from av2_work order by id").all();
  const outboxBefore = db.sqlite.prepare("select * from av2_ritm_work_outbox order by id").all();
  const key = crypto.randomUUID();
  const result = await f.cmd("legacy.adoptCarton", payload, key);
  assert.equal(result.removedQty, 44);
  assert.equal(result.importedQty, 60);
  assert.deepEqual(await f.cmd("legacy.adoptCarton", payload, key), result);
  assert.deepEqual(db.sqlite.prepare("select * from av2_work order by id").all(), workBefore);
  assert.deepEqual(db.sqlite.prepare("select * from av2_ritm_work_outbox order by id").all(), outboxBefore);
  assert.equal(db.sqlite.prepare("select count(*) n from av2_allocations where removed_at is not null").get()?.n, 1);
  assert.equal(db.sqlite.prepare("select count(*) n from av2_quality_repairs where kind='legacy.carton.adoption'").get()?.n, 1);
  const after = await db.snapshot(f.supply.id) as Snapshot;
  const adopted = after.cartons.find((b) => b.id === carton.id)!;
  assert.equal(adopted.qty, 60);
  assert.deepEqual(adopted.items.map((i) => [i.positionId, i.qty]), [[f.b.id, 60]]);
  assert.equal(after.positions.find((p) => p.id === f.a.id)?.packing, 44);
  assert.equal(after.positions.find((p) => p.id === f.a.id)?.boxed, 0);
  assert.equal(after.positions.find((p) => p.id === f.b.id)?.boxed, 60);
  const fromRitm = await readRitmWarehousePage(db.store, new URL("https://assembly.test/api/ritm/warehouse"));
  const linked = fromRitm.cartons.find((b) => b.assemblyV2Id === carton.id)!;
  assert.equal(linked.id, "carton-original");
  assert.equal(linked.legacyId, "carton-original");
  assert.equal(linked.quantity, 60);
});

test("изменившийся состав останавливает перенос без частичных изменений", async (t) => {
  const { db, f, carton, payload } = await fixture();
  t.after(() => db.sqlite.close());
  await f.cmd("work.save", { positionId: f.a.id, employeeId: f.employee.id, operation: "packing", qty: 1 });
  await f.cmd("allocation.add", { positionId: f.a.id, cartonId: carton.id, qty: 1 });
  const before = await db.snapshot(f.supply.id);
  await assert.rejects(f.cmd("legacy.adoptCarton", payload), /изменился/);
  assert.deepEqual(await db.snapshot(f.supply.id), before);
  assert.equal(db.sqlite.prepare("select count(*) n from av2_legacy_records where kind='cartonAlias'").get()?.n, 0);
  assert.equal(db.sqlite.prepare("select count(*) n from av2_quality_repairs where kind='legacy.carton.adoption'").get()?.n, 0);
});
