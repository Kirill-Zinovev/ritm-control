import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../server/api";
import { openDatabase } from "../server/local-db";
import type { PreparedDispatch, Snapshot } from "../shared/model";
import { ozonCodesByCarton } from "../shared/ozon-shipment";
import { readRitmWarehousePage } from "../server/ritm-warehouse";
import { bootstrap, fixture } from "./fixtures";

test("выезд выбранных коробов разделяет подготовку Ozon и сохраняет пары и оставшиеся резервы", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  await f.cmd("work.save", { positionId: f.a.id, employeeId: f.employee.id, operation: "packing", qty: 60 });
  for (const qty of [10, 20, 30]) await f.cmd("allocation.add", { positionId: f.a.id, qty, newCarton: true });
  const externalId = "TEST-OZON-CITY-STORE-2";
  await f.cmd("supply.import", {
    ...fixture, externalId, store: "2", title: "Москва 2 магазин", destination: "Москва 2 магазин",
    positions: [{ ...fixture.positions[0], externalId: externalId + "|sku" }],
  });
  const initial = await db.snapshot(null) as Snapshot;
  const otherSupply = initial.supplies.find((supply) => supply.externalId === externalId)!;
  const otherPosition = (await db.snapshot(otherSupply.id) as Snapshot).positions[0];
  await f.cmd("work.save", { positionId: otherPosition.id, employeeId: f.employee.id, operation: "packing", qty: 7 });
  await f.cmd("allocation.add", { positionId: otherPosition.id, qty: 7, newCarton: true });
  const boxes = (await db.snapshot(null) as Snapshot).cartons;
  const ozon = db.ozon!;
  const preview = await ozon.preview(boxes.map((box) => box.label).reverse().join("\n"));
  assert.equal(preview.issues.length, 0);
  const result = await f.cmd("ozon.prepare", {
    boxes: preview.groups.flatMap((group) => group.boxes.map(({ id, proof }) => ({ id, proof, cluster: group.cluster }))),
  });
  const batchId = String(result.batchId);
  const batch = (await ozon.batch(batchId))!;
  const first = batch.groups.find((group) => group.dispatch.store === "1")!;
  const second = batch.groups.find((group) => group.dispatch.store === "2")!;
  const codes = ["1022124184350001", "1022124184350002", "1022124184350003"];
  await f.cmd("ozon.assign", { dispatchId: first.dispatch.id, codes, previousLabelId: null });
  const third = first.boxes[2];
  const remaining = first.boxes.slice(0, 2);
  const list = (role: "manager" | "collector") =>
    api(new Request("https://assembly.test/api/dispatches/prepared"), db, "tester", role);
  assert.equal((await list("collector")).status, 403);
  assert.deepEqual(new Set(((await (await list("manager")).json()) as PreparedDispatch[]).flatMap((d) => d.cartons.map((b) => b.label))),
    new Set(boxes.map((box) => box.label)));

  const payload = {
    confirmed: true,
    departures: [
      { dispatchId: first.dispatch.id, cartonIds: [third.id] },
      { dispatchId: second.dispatch.id, cartonIds: [second.boxes[0].id] },
    ],
  };
  await assert.rejects(f.cmd("dispatch.send", {
    ...payload, departures: [payload.departures[0], { ...payload.departures[1], cartonIds: [third.id] }],
  }), /уже не входит/);
  assert.equal((await db.preparedDispatches!()).length, 2);

  const key = crypto.randomUUID();
  const departure = await f.cmd("dispatch.send", payload, key);
  assert.deepEqual(await f.cmd("dispatch.send", payload, key), departure);
  assert.equal(departure.cartonCount, 2);
  const [partialId, fullId] = departure.dispatchIds as string[];
  assert.notEqual(partialId, first.dispatch.id);
  assert.equal(fullId, second.dispatch.id);
  await assert.rejects(f.cmd("dispatch.send", payload), /только подготовленной/);
  const [draft] = await db.preparedDispatches!();
  assert.equal(draft.id, first.dispatch.id);
  assert.deepEqual(draft.cartonIds, remaining.map((box) => box.id));
  assert.equal(draft.qty, remaining.reduce((total, box) => total + box.qty, 0));
  const archive = await db.dispatchHistory!.detail(partialId);
  assert.deepEqual(archive?.archive?.payload.cartons.map((carton) => [carton.id, carton.qty]), [[third.id, third.qty]]);
  assert.equal(ozonCodesByCarton(archive!.ozon).get(third.id), codes[2]);
  assert.equal((await db.dispatchHistory!.page(0, codes[2])).entries[0].id, partialId);
  const split = (await ozon.batch(batchId))!;
  assert.equal(split.groups.length, 3);
  assert.equal((await ozon.list())[0].boxCount, 4);
  assert.deepEqual(split.groups.find((group) => group.dispatch.id === draft.id)?.labels?.codes, codes.slice(0, 2));

  await f.cmd("dispatch.send", { confirmed: true, dispatchId: draft.id });
  assert.deepEqual(await db.preparedDispatches!(), []);
  assert.deepEqual((await db.dispatchHistory!.detail(draft.id))?.dispatch.cartonIds, draft.cartonIds);
  assert.deepEqual((await db.dispatchHistory!.detail(partialId))?.dispatch.cartonIds, [third.id]);
});

test("после частичного выезда отменённая подготовка показывает только остаток из старой выгрузки", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  await f.cmd("work.save", { positionId: f.a.id, employeeId: f.employee.id, operation: "packing", qty: 20 });
  for (const qty of [8, 12]) await f.cmd("allocation.add", { positionId: f.a.id, qty, newCarton: true });
  const [first, second] = (await db.snapshot(null) as Snapshot).cartons;
  for (const box of [first, second]) await f.cmd("carton.close", {
    cartonId: box.id, items: box.items.map(({ id, qty }) => ({ id, qty })),
  });
  const prepared = await f.cmd("dispatch.create", { cartonIds: [first.id, second.id] });
  const dispatchId = String(prepared.dispatchId);
  const saved = await f.cmd("export.create", { dispatchId, kind: "account" });
  await f.cmd("dispatch.send", { dispatchId, confirmed: true, cartonIds: [first.id] });
  await f.cmd("dispatch.cancel", { dispatchId });
  const detail = await db.dispatchHistory!.detail(dispatchId);
  assert.deepEqual(detail?.archive?.payload.cartons.map((box) => box.id), [second.id]);
  assert.equal((await db.dispatchHistory!.page(0, first.label)).total, 1);
  assert.equal(((await db.export(String(saved.exportId))) as { payload: { cartons: unknown[] } }).payload.cartons.length, 2);
});

test("возврат из истории освобождает только выбранный короб и сохраняет исходную отгрузку Ozon", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  await f.cmd("work.save", { positionId: f.a.id, employeeId: f.employee.id, operation: "packing", qty: 20 });
  for (const qty of [8, 12]) await f.cmd("allocation.add", { positionId: f.a.id, qty, newCarton: true });
  const cartons = (await db.snapshot(null) as Snapshot).cartons;
  const preview = await db.ozon!.preview(cartons.map((box) => box.label).join("\n"));
  const { batchId } = await f.cmd("ozon.prepare", {
    boxes: preview.groups.flatMap(({ boxes, cluster }) => boxes.map(({ id, proof }) => ({ id, proof, cluster }))),
  });
  const { boxes: [first, second], dispatch } = (await db.ozon!.batch(String(batchId)))!.groups[0];
  const codes = ["1022124184350001", "1022124184350002"];
  await f.cmd("ozon.assign", { dispatchId: dispatch.id, codes, previousLabelId: null });
  await f.cmd("dispatch.send", { dispatchId: dispatch.id, confirmed: true });
  const archiveBefore = (await db.dispatchHistory!.detail(dispatch.id))!;
  assert.deepEqual(archiveBefore.cartonStates, { [first.id]: "sent", [second.id]: "sent" });

  const payload = { cartonId: first.id, dispatchId: dispatch.id, confirmed: true };
  const returnFromHistory = (role: "manager" | "collector", data: typeof payload, key = crypto.randomUUID()) =>
    api(new Request("https://assembly.test/api/command", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dispatch.returnCarton", key, payload: data }),
    }), db, "test-actor", role);
  assert.equal((await returnFromHistory("collector", payload)).status, 403);
  assert.equal((await returnFromHistory("manager", { ...payload, confirmed: false })).status, 409);

  const key = crypto.randomUUID();
  const response = await returnFromHistory("manager", payload, key);
  assert.equal(response.status, 200);
  const { result, state } = await response.json() as { result: Record<string, unknown>; state: Snapshot };
  assert.deepEqual(result, { cartonId: first.id, dispatchId: dispatch.id, status: "pending", sentAt: null });
  assert.deepEqual((await (await returnFromHistory("manager", payload, key)).json()).result, result);
  assert.deepEqual(state.cartons.map((box) => [box.id, box.qty, box.state, box.dispatchId]), [[first.id, first.qty, "closed", null]]);
  assert.equal(state.positions.find((position) => position.id === f.a.id)?.packing, 20);
  const ritm = await readRitmWarehousePage(db.store, new URL("https://assembly.test/api/ritm/warehouse"));
  assert.equal(ritm.cartons.find((box) => box.assemblyV2Id === first.id)?.dispatchStatus, "pending");
  assert.equal(ritm.cartons.find((box) => box.assemblyV2Id === second.id)?.dispatchStatus, "sent");

  const history = (await db.dispatchHistory!.detail(dispatch.id))!;
  assert.deepEqual(history.archive, archiveBefore.archive);
  assert.deepEqual(history.cartonStates, { [first.id]: "returned", [second.id]: "sent" });
  assert.equal((await db.dispatchHistory!.page(0, codes[0])).entries[0].returnedCartonCount, 1);
  assert.equal(ozonCodesByCarton(history.ozon).get(first.id), codes[0]);
  assert.equal((await db.ozon!.preview(first.label)).issues.length, 0);

  const next = await f.cmd("dispatch.create", { cartonIds: [first.id] });
  await f.cmd("dispatch.send", { dispatchId: next.dispatchId, confirmed: true });
  assert.equal((await returnFromHistory("manager", payload)).status, 409);
  assert.deepEqual((await db.dispatchHistory!.detail(String(next.dispatchId)))?.cartonStates, { [first.id]: "sent" });
});

test("возврат старого короба сохраняет его номер в истории без архивного состава", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  await f.cmd("work.save", { positionId: f.a.id, employeeId: f.employee.id, operation: "packing", qty: 10 });
  await f.cmd("allocation.add", { positionId: f.a.id, qty: 10, newCarton: true });
  const [box] = (await db.snapshot(null) as Snapshot).cartons;
  await f.cmd("carton.close", { cartonId: box.id, items: box.items.map(({ id, qty }) => ({ id, qty })) });
  const { dispatchId } = await f.cmd("dispatch.create", { cartonIds: [box.id] });
  await f.cmd("dispatch.send", { dispatchId, confirmed: true });
  await db.store.batch([{
    sql: "update av2_dispatches set carton_ids=null,sent_payload=null,qty=null where id=?",
    args: [String(dispatchId)],
  }]);
  await f.cmd("dispatch.returnCarton", { dispatchId, cartonId: box.id, confirmed: true });
  const detail = await db.dispatchHistory!.detail(String(dispatchId));
  assert.deepEqual(detail?.dispatch.cartonIds, [box.id]);
  assert.equal(detail?.dispatch.qty, 10);
  assert.equal(detail?.archive, null);
  assert.equal(detail?.cartonLabels[box.id], box.label);
  assert.equal(detail?.cartonStates[box.id], "returned");
  const byCarton = await db.dispatchHistory!.page(0, box.label);
  assert.equal(byCarton.entries[0].returnedCartonCount, 1);
});
