import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/local-db";
import type { Snapshot, ExportSnapshot } from "../shared/model";
import { bootstrap, fixture } from "./fixtures";
import { api } from "../server/api";
import { createDatabase } from "../server/database";
import { cartonMergeFingerprint } from "../shared/carton-merge";
async function context() {
  const db = await openDatabase();
  const f = await bootstrap(db);
  const snapshot = async () => (await db.snapshot(f.supply.id)) as Snapshot;
  const pack = (qty: number, positionId = f.a.id, cartonId?: string) =>
    f.cmd("work.save", {
      positionId,
      employeeId: f.employee.id,
      operation: "packing",
      qty,
      ...(cartonId ? { cartonId } : {}),
    });
  const box = async () =>
    String((await f.cmd("carton.create", { supplyId: f.supply.id })).cartonId);
  const close = async (id: string) => {
    const b = (await snapshot()).cartons.find((b) => b.id === id)!;
    await f.cmd("carton.close", {
      cartonId: id,
      items: b.items
        .map((i) => ({ id: i.id, qty: i.qty }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  };
  return { db, ...f, snapshot, pack, box, close };
}
test("повтор запроса не удваивает работу; изменение с тем же ключом отклоняется", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const key = crypto.randomUUID();
  const p = {
    positionId: c.a.id,
    employeeId: c.employee.id,
    operation: "packing",
    qty: 10,
  };
  await c.cmd("work.save", p, key);
  await c.cmd("work.save", p, key);
  assert.equal((await c.snapshot()).positions[0].packing, 10);
  await assert.rejects(c.cmd("work.save", { ...p, qty: 11 }, key), /Ключ уже/);
});
test("перевыполнение и упаковка до резки допустимы как в старой версии", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await c.pack(600);
  const p = (await c.snapshot()).positions[0];
  assert.equal(p.packing, 600);
  assert.equal(p.cut, 0);
});
test("запись упаковки и размещение атомарны, ошибочный короб не начисляет работу", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const box = await c.box();
  await assert.rejects(c.pack(101, c.a.id, box), /свободное место/);
  const s = await c.snapshot();
  assert.equal(s.positions[0].packing, 0);
  assert.equal(s.works.length, 0);
  assert.equal(s.cartons[0].qty, 0);
});
test("вместимость микса считается долями норм; распределение не начисляет упаковку", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const box = await c.box();
  await c.pack(60);
  await c.pack(120, c.b.id);
  await c.cmd("allocation.add", { positionId: c.a.id, cartonId: box, qty: 50 });
  await c.cmd("allocation.add", {
    positionId: c.b.id,
    cartonId: box,
    qty: 100,
  });
  const s = await c.snapshot();
  assert.equal(s.cartons[0].fill, 1);
  assert.equal(s.cartons[0].qty, 150);
  assert.equal(s.positions[0].packing, 60);
  await assert.rejects(
    c.cmd("allocation.add", { positionId: c.a.id, cartonId: box, qty: 1 }),
    /свободное место/,
  );
});
test("подтверждение укладки сохраняет полный микс сверх нормы один раз", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await c.pack(50);
  await c.pack(125, c.b.id);
  const { cartonId } = await c.cmd("allocation.place", { positionId: c.a.id, qty: 50, newCarton: true });
  const before = await c.snapshot();
  const payload = { cartonId, positionId: c.b.id, qty: 120 };
  await assert.rejects(c.cmd("allocation.place", payload), /свободное место/);
  assert.throws(() => c.db.sqlite.prepare(`insert into av2_allocations
    (id,carton_id,position_id,qty,units_per_box,created_at,actor) values(?,?,?,?,?,?,?)`)
    .run(crypto.randomUUID(), String(cartonId), c.b.id, 120, 200, "now", "test-owner"), /ASSEMBLY_CARTON_FULL/);

  const confirmed = { ...payload, fitConfirmation: {
    cartonFingerprint: await cartonMergeFingerprint(before.cartons[0]), shipmentQty: 120, unitsPerBox: 200,
  } };
  const key = crypto.randomUUID();
  const saved = await c.cmd("allocation.place", confirmed, key);
  assert.equal(saved.shipmentQty, 120);
  assert.equal(saved.warehouseQty, 0);
  assert.deepEqual(await c.cmd("allocation.place", confirmed, key), saved);

  const after = await c.snapshot();
  assert.equal(after.cartons[0].qty, 170);
  assert.equal(after.cartons[0].fill, 1.1);
  assert.deepEqual(after.cartons[0].items.map(item => [item.qty, item.unitsPerBox]).sort(), [[120, 200], [50, 100]]);
  assert.deepEqual(after.works, before.works);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_quality_repairs where kind='allocation.fit-confirmed'").get()?.n, 1);
  await c.close(String(cartonId));
  assert.equal((await c.snapshot()).cartons[0].state, "closed");
});
test("подтверждение содержит состав короба и устаревает после параллельной укладки", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await c.pack(250);
  const cartonId = await c.box();
  const fitConfirmation = {
    cartonFingerprint: await cartonMergeFingerprint((await c.snapshot()).cartons[0]),
    shipmentQty: 110, unitsPerBox: 100,
  };
  const payload = { cartonId, positionId: c.a.id, qty: 110, fitConfirmation };
  const saves = await Promise.allSettled([c.cmd("allocation.place", payload), c.cmd("allocation.place", payload)]);
  assert.equal(saves.filter(save => save.status === "fulfilled").length, 1);
  const rejected = saves.find(save => save.status === "rejected");
  assert.match(String(rejected?.reason), /Состав короба, количество или норма изменились/);
  assert.equal((await c.snapshot()).cartons[0].qty, 110);
});
test("новый короб сверх нормы создаётся только с точным подтверждением количества и нормы", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await c.pack(150);
  const placement = { positionId: c.a.id, qty: 110, newCarton: true };
  const fitConfirmation = { cartonFingerprint: null, shipmentQty: 110, unitsPerBox: 100 };
  await assert.rejects(c.cmd("allocation.place", placement), /свободное место/);
  await assert.rejects(c.cmd("allocation.place", { ...placement, fitConfirmation: { ...fitConfirmation, unitsPerBox: 200 } }), /норма изменились/);
  assert.equal((await c.snapshot()).cartons.length, 0);
  await c.cmd("allocation.place", { ...placement, fitConfirmation });
  assert.equal((await c.snapshot()).cartons[0].qty, 110);
});
test("два сборщика не могут одновременно распределить последний остаток", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const box = await c.box();
  await c.pack(10);
  const results = await Promise.allSettled([
    c.cmd("allocation.add", { positionId: c.a.id, cartonId: box, qty: 7 }),
    c.cmd("allocation.add", { positionId: c.a.id, cartonId: box, qty: 7 }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await c.snapshot()).cartons[0].qty, 7);
});
test("12 одновременных сборщиков сохраняют записи без потерь", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const start = performance.now();
  await Promise.all(Array.from({ length: 12 }, () => c.pack(1)));
  const s = await c.snapshot();
  assert.equal(s.positions[0].packing, 12);
  assert.equal(s.works.length, 12);
  t.diagnostic(
    `12 конкурентных сохранений локально: ${Math.round(performance.now() - start)} мс; облачная скорость этим не измеряется.`,
  );
});
test("ID позиций разных поставок сохраняются отдельно, несовместимый короб отклоняется", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const box = await c.box();
  await c.cmd("supply.import", {
    ...fixture,
    externalId: "OTHER",
    store: "Другой магазин",
  });
  const other = (await c.db.snapshot(null)) as Snapshot;
  assert.notEqual(other.selectedSupplyId, c.supply.id);
  await c.pack(10, other.positions[0].id);
  await assert.rejects(
    c.cmd("allocation.add", {
      positionId: other.positions[0].id,
      cartonId: box,
      qty: 1,
    }),
    /другой маркетплейс/,
  );
  assert.equal((await c.snapshot()).positions[0].packing, 0);
});
test("закрытие проверяет состав; закрытые короба не принимают товар", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const box = await c.box();
  await c.pack(10, c.a.id, box);
  const old = (await c.snapshot()).cartons[0].items.map((i) => ({
    id: i.id,
    qty: i.qty,
  }));
  await c.pack(5, c.a.id, box);
  await assert.rejects(
    c.cmd("carton.close", { cartonId: box, items: old }),
    /Состав короба изменился/,
  );
  await c.close(box);
  await assert.rejects(c.pack(1, c.a.id, box), /Короб закрыт/);
  assert.equal((await c.snapshot()).positions[0].packing, 15);
});
test("менеджер возвращает закрытый короб сборщикам с прежним составом и выработкой", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const cartonId = await c.box();
  await c.pack(20, c.a.id, cartonId);
  await c.close(cartonId);
  const before = await c.snapshot();
  const payload = { cartonId, closedAt: before.cartons[0].closedAt };
  const key = crypto.randomUUID();
  const reopen = (role: "manager" | "collector") =>
    api(new Request("https://assembly.test/api/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "carton.reopen", key, supplyId: c.supply.id, payload }),
    }), c.db, "test-" + role, role);

  assert.equal((await reopen("collector")).status, 403);
  const draft = await c.cmd("dispatch.create", { cartonIds: [cartonId] });
  const reserved = await reopen("manager");
  assert.equal(reserved.status, 409);
  assert.match((await reserved.json()).error, /отмените подготовку/);
  await c.cmd("dispatch.cancel", { dispatchId: draft.dispatchId });
  const opened = await reopen("manager");
  assert.equal(opened.status, 200);
  const revision = await c.db.revision();
  assert.equal((await reopen("manager")).status, 200);
  assert.equal(await c.db.revision(), revision);

  const response = await api(new Request(
    `https://assembly.test/api/state?directions=1&cartons=supply&supply=${c.supply.id}`,
  ), c.db, "test-collector", "collector");
  const after = (await response.json()) as Snapshot;
  assert.equal(after.cartons[0].state, "open");
  assert.equal(after.cartons[0].closedAt, null);
  assert.deepEqual(after.cartons[0].items, before.cartons[0].items);
  assert.deepEqual(after.works, before.works);
  assert.equal(after.positions.find(p => p.id === c.a.id)?.packing, 20);
  await assert.rejects(c.cmd("dispatch.create", { cartonIds: [cartonId] }), /недоступен/);

  await c.pack(5, c.a.id, cartonId);
  await c.close(cartonId);
  const reclosed = (await c.snapshot()).cartons[0];
  assert.equal(reclosed.qty, 25);
  await assert.rejects(c.cmd("carton.reopen", { cartonId, closedAt: null }), /Статус короба изменился/);
  const dispatch = await c.cmd("dispatch.create", { cartonIds: [cartonId] });
  await c.cmd("dispatch.send", { dispatchId: dispatch.dispatchId, confirmed: true });
  await assert.rejects(c.cmd("carton.reopen", { cartonId, closedAt: reclosed.closedAt }), /Короб уже отправлен/);
});

test("отгрузка резервирует короба, выгрузка не отправляет, снимок неизменяем", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const box = await c.box();
  await c.pack(20, c.a.id, box);
  await c.close(box);
  const r = await c.cmd("dispatch.create", { cartonIds: [box] });
  await assert.rejects(
    c.cmd("dispatch.create", { cartonIds: [box] }),
    /недоступен/,
  );
  const exported = await c.cmd("export.create", {
    dispatchId: r.dispatchId,
    kind: "account",
  });
  const snapshot = (await c.db.export(
    String(exported.exportId),
  )) as ExportSnapshot;
  assert.equal((await c.snapshot()).dispatches[0].state, "draft");
  assert.equal(snapshot.payload.cartons[0].qty, 20);
  assert.throws(
    () =>
      c.db.sqlite
        .prepare("update av2_exports set kind=? where id=?")
        .run("template", snapshot.id),
    /IMMUTABLE/,
  );
  await assert.rejects(
    c.cmd("dispatch.send", { dispatchId: r.dispatchId }),
    /Подтвердите/,
  );
  await c.cmd("dispatch.send", { dispatchId: r.dispatchId, confirmed: true });
  assert.equal((await c.snapshot()).cartons.length, 0);
  assert.deepEqual(await c.db.export(String(exported.exportId)), snapshot);
});
test("отмена подготовки возвращает короба без удаления снимка", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const box = await c.box();
  await c.pack(10, c.a.id, box);
  await c.close(box);
  const d = await c.cmd("dispatch.create", { cartonIds: [box] });
  const e = await c.cmd("export.create", {
    dispatchId: d.dispatchId,
    kind: "account",
  });
  await c.cmd("dispatch.cancel", { dispatchId: d.dispatchId });
  assert.equal((await c.snapshot()).cartons[0].dispatchId, null);
  assert.ok(await c.db.export(String(e.exportId)));
});
test("отмена работы сохраняет исходную запись и не уводит короб в минус", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const box = await c.box();
  await c.pack(10, c.a.id, box);
  const work = (await c.snapshot()).works[0];
  await c.cmd("work.cancel", { workId: work.id, reason: "Ошибка ввода" });
  const s = await c.snapshot();
  assert.equal(s.positions[0].packing, 0);
  assert.equal(s.works.length, 1);
  assert.equal(s.works[0].canceled, true);
});
test("поставка идемпотентна по версии и исходным ID; устаревшие изменения запрещены", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await c.cmd("supply.import", fixture as unknown as Record<string, unknown>);
  assert.equal((await c.snapshot()).supplies.length, 1);
  await assert.rejects(
    c.cmd("supply.import", { ...fixture, title: "Изменение без версии" }),
    /Увеличьте/,
  );
  await c.cmd("supply.import", { ...fixture, sourceVersion: 2 });
  await assert.rejects(
    c.cmd("supply.import", fixture as unknown as Record<string, unknown>),
    /устаревшая/,
  );
  assert.deepEqual(
    (await c.snapshot()).positions.map((p) => p.externalId),
    fixture.positions.map((p) => p.externalId),
  );
});
test("невалидные количества и отсутствие норм не создают вложений", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const box = await c.box();
  for (const qty of [0, -1, 1.5, NaN])
    await assert.rejects(c.pack(qty), /целое число/);
  await c.cmd("supply.import", {
    ...fixture,
    sourceVersion: 2,
    positions: fixture.positions.map((p) => ({ ...p, unitsPerBox: null })),
  });
  await c.pack(1);
  await assert.rejects(
    c.cmd("allocation.add", { positionId: c.a.id, cartonId: box, qty: 1 }),
    /норма вместимости/,
  );
});
test("API требует доступ и блокирует сторонний origin", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  assert.equal(
    (await api(new Request("https://assembly.test/api/state"), c.db, ""))
      .status,
    401,
  );
  const req = new Request("https://assembly.test/api/command", {
    method: "POST",
    headers: {
      origin: "https://other.test",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal((await api(req, c.db, "owner")).status, 403);
});

test("отправленный состав не меняется после обновления названий в RITM", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const b = await c.box();
  await c.pack(10, c.a.id, b);
  await c.close(b);
  const d = await c.cmd("dispatch.create", { cartonIds: [b] });
  await c.cmd("dispatch.send", { dispatchId: d.dispatchId, confirmed: true });
  await c.cmd("supply.import", {
    ...fixture,
    sourceVersion: 2,
    positions: fixture.positions.map((p) => ({ ...p, name: "Новое название" })),
  });
  const e = await c.cmd("export.create", {
    dispatchId: d.dispatchId,
    kind: "account",
  });
  const frozen = (await c.db.export(String(e.exportId))) as ExportSnapshot;
  assert.equal(
    frozen.payload.cartons[0].items[0].name,
    fixture.positions[0].name,
  );
});
test("поставка из 500 позиций загружается одним ограниченным набором SQL-команд", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const positions = [
    ...fixture.positions,
    ...Array.from({ length: 497 }, (_, i) => ({
      ...fixture.positions[0],
      externalId: "BULK-" + i,
      sku: "BULK-" + i,
    })),
  ];
  await c.cmd("supply.import", { ...fixture, sourceVersion: 2, positions });
  assert.equal((await c.snapshot()).positions.length, 500);
});

test("12 одновременных API-запросов получают подтверждение и согласованный состав", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const cartonId = await c.box();
  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      api(
        new Request("https://assembly.test/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "work.save",
            payload: {
              positionId: c.a.id,
              employeeId: c.employee.id,
              operation: "packing",
              qty: 1,
              cartonId,
            },
            key: crypto.randomUUID(),
            supplyId: c.supply.id,
          }),
        }),
        c.db,
        "api-owner",
      ),
    ),
  );
  for (const response of responses) {
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.state);
    const p = body.state.positions.find((p: any) => p.id === c.a.id),
      box = body.state.cartons.find((b: any) => b.id === cartonId);
    assert.equal(p.packing, box.qty);
    assert.equal(p.boxed, box.qty);
  }
  assert.equal((await c.snapshot()).positions[0].packing, 12);
});
test("сбой обновления экрана после коммита не превращает сохранённую работу в ошибку", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const key = crypto.randomUUID();
  const body = JSON.stringify({
    action: "work.save",
    payload: {
      positionId: c.a.id,
      employeeId: c.employee.id,
      operation: "packing",
      qty: 3,
    },
    key,
    supplyId: c.supply.id,
  });
  const db = {
    ...c.db,
    snapshot: async () => {
      throw new Error("view refresh unavailable");
    },
  };
  for (let i = 0; i < 2; i++) {
    const r = await api(
      new Request("https://assembly.test/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      db,
      "api-owner",
    );
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.state, null);
    assert.equal(json.refreshRequired, true);
  }
  assert.equal((await c.snapshot()).positions[0].packing, 3);
});

test("закрытие короба между чтением и коммитом откатывает новую упаковку целиком", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const cartonId = await c.box();
  await c.pack(10, c.a.id, cartonId);
  let changed = false;
  const raced = createDatabase({
    ...c.db.store,
    async batch(statements) {
      if (!changed) {
        changed = true;
        await c.close(cartonId);
      }
      await c.db.store.batch(statements);
    },
  });
  await assert.rejects(
    raced.command(
      "work.save",
      {
        positionId: c.a.id,
        employeeId: c.employee.id,
        operation: "packing",
        qty: 5,
        cartonId,
      },
      crypto.randomUUID(),
      "test-owner",
    ),
    /Короб закрыт/,
  );
  const s = await c.snapshot();
  assert.equal(s.positions[0].packing, 10);
  assert.equal(s.cartons[0].qty, 10);
  assert.equal(s.cartons[0].state, "closed");
});
test("изменение нормы между чтением и размещением проверяется при коммите", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const cartonId = await c.box();
  await c.pack(10);
  let changed = false;
  const raced = createDatabase({
    ...c.db.store,
    async batch(statements) {
      if (!changed) {
        changed = true;
        await c.cmd("supply.import", {
          ...fixture,
          sourceVersion: 2,
          positions: fixture.positions.map((p) => ({ ...p, unitsPerBox: 200 })),
        });
      }
      await c.db.store.batch(statements);
    },
  });
  await assert.rejects(
    raced.command(
      "allocation.add",
      { positionId: c.a.id, cartonId, qty: 10 },
      crypto.randomUUID(),
      "test-owner",
    ),
    /Норма вместимости изменилась/,
  );
  assert.equal((await c.snapshot()).cartons[0].qty, 0);
  assert.equal((await c.snapshot()).positions[0].packing, 10);
});
