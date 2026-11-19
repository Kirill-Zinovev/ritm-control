import test from "node:test";
import assert from "node:assert/strict";
import { nextCartonLabel } from "../shared/carton-number";
import { openDatabase } from "../server/local-db";
import { bootstrap } from "./fixtures";
import type { Snapshot } from "../shared/model";

test("номера совпадают со старым Assembly: магазин, три буквы и общий занятый максимум", () => {
  assert.equal(
    nextCartonLabel({ store: "1", title: "OZON МОСКВА 10_10" }, [
      "1мос211",
      "1МОС212",
      "2мос999",
    ]),
    "1мос213",
  );
  assert.equal(
    nextCartonLabel({ store: "2", title: "OZON Екатеринбург 2-й магазин" }, [
      "2ека10",
    ]),
    "2ека11",
  );
  assert.equal(
    nextCartonLabel({ store: "1", title: "OZON индивидуалка" }, []),
    "1инд1",
  );
  assert.equal(
    nextCartonLabel({ store: "2", title: "WB Кострома 06_10" }, []),
    "2кос1",
  );
  assert.throws(
    () =>
      nextCartonLabel({ store: "Не подтверждён", title: "OZON Москва" }, []),
    /Магазин/,
  );
});

test("новый короб и первое вложение сохраняются вместе; отказ и повтор не оставляют пустых коробов", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const c = await bootstrap(db);
  const payload = { positionId: c.a.id, newCarton: true, qty: 20 };
  await assert.rejects(c.cmd("allocation.add", payload), /Недостаточно/);
  assert.equal(
    ((await db.snapshot(c.supply.id)) as Snapshot).cartons.length,
    0,
  );
  await c.cmd("work.save", {
    positionId: c.a.id,
    employeeId: c.employee.id,
    operation: "packing",
    qty: 20,
  });
  db.sqlite
    .prepare(
      "insert into av2_carton_number_reservations(label,source) values('1тес217','legacy')",
    )
    .run();
  const key = crypto.randomUUID();
  const first = await c.cmd("allocation.add", payload, key);
  const second = await c.cmd("allocation.add", payload, key);
  assert.deepEqual(first, second);
  const s = (await db.snapshot(c.supply.id)) as Snapshot;
  assert.equal(s.cartons.length, 1);
  assert.equal(s.cartons[0].label, "1тес218");
  assert.equal(s.cartons[0].qty, 20);
  assert.equal(s.works.length, 1);
  assert.equal(s.positions[0].packing, 20);
  assert.equal(s.positions[0].boxed, 20);
});

test("12 сборщиков создают короба с разными номерами без повторного начисления упаковки", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const c = await bootstrap(db);
  await c.cmd("work.save", {
    positionId: c.a.id,
    employeeId: c.employee.id,
    operation: "packing",
    qty: 12,
  });
  await Promise.all(
    Array.from({ length: 12 }, () =>
      c.cmd("allocation.add", { positionId: c.a.id, newCarton: true, qty: 1 }),
    ),
  );
  const s = (await db.snapshot(c.supply.id)) as Snapshot;
  assert.equal(s.cartons.length, 12);
  assert.equal(new Set(s.cartons.map((b) => b.label)).size, 12);
  assert.equal(s.positions[0].packing, 12);
  assert.equal(s.positions[0].boxed, 12);
  assert.equal(s.works.length, 1);
});

test("перенос имён и занятых номеров повторяем; тестовая история и другие сотрудники остаются", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const c = await bootstrap(db);
  await c.cmd("employee.create", { name: "Другой сотрудник" });
  await c.cmd("work.save", {
    positionId: c.a.id,
    employeeId: c.employee.id,
    operation: "packing",
    qty: 7,
  });
  const before = (await db.snapshot(c.supply.id)) as Snapshot;
  const payload = {
    sourceWorkbookId: "1dn7a7s-Ev9vLuNE2W8lECVwXCdpq8DXvC5Gt_O1sBbI",
    employees: [
      { id: "emp-001", name: "Оля" },
      { id: "emp-002", name: "Вика" },
    ],
    cartonNumbers: ["1мос211", "1мос212"],
  };
  await c.cmd("legacy.references.import", payload);
  await c.cmd("legacy.references.import", payload);
  const after = (await db.snapshot(c.supply.id)) as Snapshot;
  assert.deepEqual(after.works, before.works);
  assert.deepEqual(after.cartons, before.cartons);
  assert.deepEqual(after.positions, before.positions);
  assert.deepEqual(
    after.employees
      .filter((e) => e.active)
      .map((e) => e.name)
      .sort(),
    ["Вика", "Другой сотрудник", "Оля"].sort(),
  );
  assert.equal(
    db.sqlite
      .prepare("select count(*) n from av2_carton_number_reservations")
      .get()!.n,
    2,
  );
});
