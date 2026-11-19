import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/local-db";
import { bootstrap, fixture } from "./fixtures";
import { drainWorkOutbox } from "../server/ritm-outbox";
import type { Snapshot } from "../shared/model";
const workbook = "1dn7a7s-Ev9vLuNE2W8lECVwXCdpq8DXvC5Gt_O1sBbI";
test("сборщик загружает только короба своего направления; отправленные старые короба остаются в истории и не доступны к повторной отгрузке", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  const box = await f.cmd("carton.create", { supplyId: f.supply.id });
  const other = await f.cmd("supply.import", {
    ...fixture,
    externalId: "OTHER",
    destination: "Другой склад",
  });
  await f.cmd("carton.create", { supplyId: other.supplyId });
  assert.equal(
    ((await db.snapshot(f.supply.id, true)) as Snapshot).cartons.length,
    1,
  );
  assert.equal(
    ((await db.snapshot(f.supply.id)) as Snapshot).cartons.length,
    2,
  );
  await f.cmd("work.save", {
    positionId: f.a.id,
    employeeId: f.employee.id,
    operation: "packing",
    qty: 10,
  });
  await f.cmd("allocation.add", {
    positionId: f.a.id,
    cartonId: box.cartonId,
    qty: 10,
  });
  const b = ((await db.snapshot(f.supply.id)) as Snapshot).cartons.find(
    (b) => b.id === box.cartonId,
  )!;
  await f.cmd("carton.close", {
    cartonId: b.id,
    items: b.items.map((i) => ({ id: i.id, qty: i.qty })),
  });
  await f.cmd("legacy.restore", {
    sourceWorkbookId: workbook,
    sourceHash: "ab".repeat(32),
    kind: "dispatches",
    rows: [
      {
        sourceId: "old-dispatch",
        id: "legacy:dispatch",
        cartonId: b.id,
        label: "Отправлен",
        sentAt: "2026-11-01T00:00:00Z",
        qty: 10,
      },
    ],
  });
  const current = (await db.snapshot(f.supply.id)) as Snapshot;
  assert.equal(
    current.cartons.some((c) => c.id === b.id),
    false,
  );
  assert.equal(current.dispatches[0].state, "sent");
  await assert.rejects(
    f.cmd("dispatch.create", { cartonIds: [b.id] }),
    /закрыт|отгруз|короб/i,
  );
  await assert.rejects(
    f.cmd("export.create", { dispatchId: "legacy:dispatch", kind: "account" }),
    /не сохранён состав/,
  );
});
test("восстановление сохраняет исходную работу и отмены, не открывает поставки и не отправляет старую работу повторно в РИТМ", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  await f.cmd("work.save", {
    positionId: f.a.id,
    employeeId: f.employee.id,
    operation: "packing",
    qty: 20,
  });
  const native = db.sqlite.prepare("select * from av2_work").all();
  db.sqlite
    .prepare("update av2_positions set ready=0,source_active=0 where id=?")
    .run(f.a.id);
  db.sqlite
    .prepare("update av2_employees set active=0 where id=?")
    .run(f.employee.id);
  const restore = (kind: string, rows: unknown[]) =>
    f.cmd("legacy.restore", {
      sourceWorkbookId: workbook,
      sourceHash: "ab".repeat(32),
      kind,
      rows,
    });
  const work = {
    sourceId: "old-event",
    id: "legacy:old-event",
    positionId: f.a.id,
    employeeId: f.employee.id,
    employee: "Историческое имя",
    operation: "packing",
    qty: 30,
    createdAt: "2026-10-01T00:00:00Z",
    norm: 500,
    coefficient: 0.06,
  };
  await restore("work", [work]);
  await restore("work", [work]);
  assert.deepEqual(
    db.sqlite
      .prepare("select * from av2_work where legacy_event_id is null")
      .all(),
    native,
  );
  assert.equal(
    db.sqlite.prepare("select count(*) n from av2_work").get()!.n,
    2,
  );
  assert.deepEqual(
    {
      ...db.sqlite
        .prepare("select ready,source_active from av2_positions where id=?")
        .get(f.a.id),
    },
    { ready: 0, source_active: 0 },
  );
  assert.equal(
    db.sqlite
      .prepare("select active from av2_employees where id=?")
      .get(f.employee.id)!.active,
    0,
  );
  await restore("corrections", [
    {
      sourceId: "old-cancel",
      eventId: "old-event",
      reason: "Отмена в источнике",
      createdAt: "2026-10-02T00:00:00Z",
    },
  ]);
  assert.equal(
    db.sqlite
      .prepare("select packing from av2_position_totals where position_id=?")
      .get(f.a.id)!.packing,
    20,
  );
  assert.equal(
    db.sqlite.prepare("select count(*) n from av2_ritm_work_outbox").get()!.n,
    0,
  );
  await assert.rejects(restore("work", [{ ...work, qty: 31 }]), /изменилась/);
});
test("исторические вложения входят в остаток, вместимость и выгрузку; неизвестная вместимость запрещает добавление", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  await f.cmd("work.save", {
    positionId: f.a.id,
    employeeId: f.employee.id,
    operation: "packing",
    qty: 200,
  });
  const box = await f.cmd("carton.create", { supplyId: f.supply.id });
  const restore = (kind: string, rows: unknown[]) =>
    f.cmd("legacy.restore", {
      sourceWorkbookId: workbook,
      sourceHash: "ab".repeat(32),
      kind,
      rows,
    });
  await restore("allocations", [
    {
      sourceId: "old-allocation",
      id: "legacy:old-allocation",
      cartonId: box.cartonId,
      positionId: f.a.id,
      qty: 80,
      unitsPerBox: 100,
    },
  ]);
  await assert.rejects(
    f.cmd("allocation.add", {
      positionId: f.a.id,
      cartonId: box.cartonId,
      qty: 21,
    }),
    /место|мест|Количество/,
  );
  await f.cmd("allocation.add", {
    positionId: f.a.id,
    cartonId: box.cartonId,
    qty: 20,
  });
  let state = (await db.snapshot(f.supply.id)) as Snapshot;
  assert.equal(state.cartons[0].qty, 100);
  assert.equal(state.positions[0].boxed, 100);
  await f.cmd("allocation.remove", {
    allocationId: "legacy:old-allocation",
    reason: "Проверка состава",
  });
  await restore("allocations", [
    {
      sourceId: "old-unknown",
      id: "legacy:old-unknown",
      cartonId: box.cartonId,
      positionId: f.a.id,
      qty: 1,
      unitsPerBox: null,
    },
  ]);
  state = (await db.snapshot(f.supply.id)) as Snapshot;
  assert.equal(state.cartons[0].capacityUnknown, true);
  await assert.rejects(
    f.cmd("allocation.add", {
      positionId: f.a.id,
      cartonId: box.cartonId,
      qty: 1,
    }),
    /вместимост/,
  );
  await assert.rejects(
    db.store.batch([
      {
        sql: "insert into av2_allocations(id,carton_id,position_id,qty,units_per_box,created_at,actor) values(?,?,?,?,?,?,?)",
        args: [
          "concurrent",
          String(box.cartonId),
          f.a.id,
          1,
          100,
          "now",
          "test",
        ],
      },
    ]),
    /CARTON_FULL/,
  );
  await f.cmd("carton.close", {
    cartonId: box.cartonId,
    items: state.cartons[0].items
      .map((i) => ({ id: i.id, qty: i.qty }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  const dispatch = await f.cmd("dispatch.create", {
    cartonIds: [box.cartonId],
  });
  const result = await f.cmd("export.create", {
    dispatchId: dispatch.dispatchId,
    kind: "account",
  });
  const exported: any = await db.export(String(result.exportId));
  assert.equal(exported.payload.cartons[0].qty, 21);
  assert.equal(
    exported.payload.cartons[0].items.some(
      (i: any) => i.id === "legacy:old-unknown",
    ),
    true,
  );
});
test("новая работа и отмена атомарно попадают в очередь РИТМ; отказ и потерянный ответ сохраняют те же ID", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  db.sqlite
    .prepare("update av2_supplies set origin_shipment_id=? where id=?")
    .run("RITM-ROLL-10", f.supply.id);
  db.sqlite
    .prepare("update av2_positions set external_id=? where id=?")
    .run("RITM-ROLL-10|uid:test|SKU", f.a.id);
  await f.cmd("work.save", {
    positionId: f.a.id,
    employeeId: f.employee.id,
    operation: "packing",
    qty: 10,
  });
  const w = db.sqlite.prepare("select id from av2_work").get()!;
  await f.cmd("work.cancel", { workId: w.id, reason: "Ошибка количества" });
  assert.equal(
    db.sqlite.prepare("select count(*) n from av2_ritm_work_outbox").get()!.n,
    2,
  );
  const env = { RITM_ASSEMBLY_V2_FEED_SECRET: "ab".repeat(32) };
  await drainWorkOutbox(db.store, env, {
    fetcher: async () => new Response("failure", { status: 503 }),
  });
  assert.equal(
    db.sqlite
      .prepare(
        "select count(*) n from av2_ritm_work_outbox where delivered_at is null and attempts=1",
      )
      .get()!.n,
    2,
  );
  db.sqlite.prepare("update av2_ritm_work_outbox set next_attempt_at=0").run();
  const ids = db.sqlite
    .prepare("select id from av2_ritm_work_outbox order by id")
    .all()
    .map((r) => r.id);
  await drainWorkOutbox(db.store, env, {
    fetcher: async (_url, init) => {
      assert.equal(init?.redirect, "manual");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.events.length, 2);
      return Response.json({
        ok: true,
        acceptedIds: body.events.map((e: any) => e.id),
      });
    },
  });
  assert.deepEqual(
    db.sqlite
      .prepare("select id from av2_ritm_work_outbox order by id")
      .all()
      .map((r) => r.id),
    ids,
  );
  assert.equal(
    db.sqlite
      .prepare(
        "select count(*) n from av2_ritm_work_outbox where delivered_at is not null",
      )
      .get()!.n,
    2,
  );
});
