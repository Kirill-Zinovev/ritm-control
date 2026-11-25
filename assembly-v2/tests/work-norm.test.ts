import test from "node:test";
import assert from "node:assert/strict";
import { effectiveWorkNorms, savedCoefficient } from "../shared/work-norm";
import { openDatabase } from "../server/local-db";
import { bootstrap, fixture } from "./fixtures";
import type { Snapshot } from "../shared/model";
import { readRitmWorkReport } from "../server/work-history";
import { api } from "../server/api";
import {catalogDetail} from '../server/catalog-store';
test("нормы совпадают со старым Assembly: листы при станочной резке, штуки при ручной резке и упаковке; конфликт остаётся неизвестным", () => {
  const norms = [
    { type: "Наклейки", cut: 7000, packing: 850, assembly: 650, row: 2 },
  ];
  const effective = effectiveWorkNorms(
    { kind: " наклейки ", sheetsPerUnit: "3" },
    norms,
  );
  assert.equal(savedCoefficient(effective, "cut", 70), 210 / 7000);
  assert.equal(savedCoefficient(effective, "packing", 85), 0.1);
  assert.equal(savedCoefficient(effective, "assembly", 65), 0.1);
  assert.equal(
    effectiveWorkNorms({ kind: "Наклейки", sheetsPerUnit: "" }, norms).cut,
    7000,
  );
  assert.equal(
    effectiveWorkNorms({ kind: "Наклейки", sheetsPerUnit: "#N/A" }, norms).cut,
    null,
  );
  for(const error of ["#NAME?","#NUM!","#NULL!","#VALUE!"," #REF!"])
    assert.equal(effectiveWorkNorms({kind:"Наклейки",sheetsPerUnit:"",rows:[{raw:{sheetsPerUnit:error}}]},norms).cut,null);
  assert.equal(
    effectiveWorkNorms({ kind: "Наклейки", sheetsPerUnit: "1" }, [
      { ...norms[0], conflict: true },
    ]).packing,
    null,
  );
});
test("сохранённые коэффициенты не пересчитываются при изменении нормы и попадают в событие РИТМ", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  db.sqlite
    .prepare("insert into av2_catalog_imports values(?,?,?,?,?)")
    .run("norm-catalog", "{}", "active", "2026-11-14T00:00:00Z", "test");
  db.sqlite
    .prepare("insert into av2_catalog_entries values(?,?,?,?,?,?,?,?,?,?)")
    .run(
      "norm-entry",
      "norm-catalog",
      "norm-entry",
      "OZON",
      "1",
      "SKU",
      "SKU",
      "",
      0,
      JSON.stringify({ kind: "Наклейки", sheetsPerUnit: "3" }),
    );
  db.sqlite
    .prepare(
      "update av2_positions set catalog_import_id=?,catalog_entry_id=? where id=?",
    )
    .run("norm-catalog", "norm-entry", f.a.id);
  db.sqlite
    .prepare("update av2_supplies set origin_shipment_id=? where id=?")
    .run("RITM-ROLL-10", f.supply.id);
  db.sqlite
    .prepare("insert into av2_shift_norms values(?,?,?,?)")
    .run(
      "наклейки",
      JSON.stringify({
        type: "Наклейки",
        cut: 7000,
        packing: 850,
        assembly: 650,
        row: 2,
      }),
      "ab".repeat(32),
      "now",
    );
  await f.cmd("work.save", {
    positionId: f.a.id,
    employeeId: f.employee.id,
    operation: "packing",
    qty: 85,
  });
  assert.equal(
    db.sqlite.prepare("select coefficient from av2_work").get()!.coefficient,
    "0.1",
  );
  db.sqlite.prepare("update av2_catalog_entries set data=? where entry_id='norm-entry'").run(JSON.stringify({kind:'',sheetsPerUnit:'3'}));
  await f.cmd('work.save',{positionId:f.a.id,employeeId:f.employee.id,operation:'packing',qty:1});
  const unknown=db.sqlite.prepare('select id from av2_work where coefficient is null').get()!.id;
  db.sqlite.prepare("update av2_meta set active_catalog_id='norm-catalog' where id=1").run();
  await f.cmd('catalog.correctKind',{entryId:'norm-entry',kind:'Наклейки',reason:'Подтверждено владельцем'});
  const corrected=await catalogDetail(db.store,'norm-catalog','norm-entry');
  assert.equal(corrected!.kind,'Наклейки');assert.equal(corrected!.kindCorrection,'Подтверждено владельцем');
  assert.equal(JSON.parse(String(db.sqlite.prepare("select data from av2_catalog_entries where entry_id='norm-entry'").get()!.data)).kind,'','Raw source remains immutable');
  assert.equal(db.sqlite.prepare('select coefficient from av2_work where id=?').get(unknown)!.coefficient,null,'Historical unknown coefficient is not retroactively repriced');
  await f.cmd('work.save',{positionId:f.a.id,employeeId:f.employee.id,operation:'packing',qty:85});
  assert.equal(db.sqlite.prepare('select coefficient from av2_work order by rowid desc limit 1').get()!.coefficient,'0.1');
  const event = JSON.parse(
    String(
      db.sqlite.prepare("select payload from av2_ritm_work_outbox").get()!
        .payload,
    ),
  );
  assert.equal(event.coefficient, "0.1");
  db.sqlite
    .prepare("update av2_shift_norms set data=?")
    .run(
      JSON.stringify({
        type: "Наклейки",
        cut: 7000,
        packing: 1700,
        assembly: 650,
        row: 2,
      }),
    );
  assert.equal(
    db.sqlite.prepare("select coefficient from av2_work").get()!.coefficient,
    "0.1",
  );
});

test("новая работа берёт норму однозначной карточки, сохраняя магазин и предыдущий журнал", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  const origin = "RITM-ROLL-41";
  const sku = "TEST-3-SHEETS";
  const kind = "Наклейки А4 3-4 листа";
  const rawPosition = {
    ...fixture.positions[0], sku,
    externalId: `${origin}|uid:fixture|${sku}`,
    barcode: "", unitsPerBox: null,
  };
  const imported = await f.cmd("supply.import", {
    ...fixture, externalId: "norms-unlinked", originShipmentId: origin,
    title: "Поставка для проверки нормы", store: "Не подтверждён",
    positions: [rawPosition],
  });
  const supplyId = String(imported.supplyId);
  const snapshot = () => db.snapshot(supplyId) as Promise<Snapshot>;
  const position = (await snapshot()).positions[0];
  const save = (operation: "cut" | "packing") =>
    f.cmd("work.save", { positionId: position.id, employeeId: f.employee.id, operation, qty: 9 });
  await save("packing");
  db.sqlite.prepare("insert into av2_catalog_imports values(?,?,?,?,?)")
    .run("test-current", "{}", "active", "2026-11-23T00:00:00Z", "test");
  db.sqlite.prepare("update av2_meta set active_catalog_id='test-current' where id=1").run();
  db.sqlite.prepare("insert into av2_shift_norms values(?,?,?,?)")
    .run(kind.toLowerCase(), JSON.stringify({
      type: kind, cut: 7000, packing: 825, assembly: 550, row: 7,
    }), "test", "now");

  const addCard = (market: "OZON" | "WB", shop: string, sheetsPerUnit: string) => {
    const cardSku = market === "OZON" ? sku + "(OZ)" : sku;
    const entryId = JSON.stringify([market, shop, cardSku]);
    const data = JSON.stringify({ id: entryId, market, store: shop, kind, sheetsPerUnit, barcode: "0012", aliases: [sku, cardSku] });
    db.sqlite.prepare("insert into av2_catalog_entries values(?,?,?,?,?,?,?,?,?,?)")
      .run(entryId, "test-current", entryId, market, shop, cardSku, cardSku, "", 0, data);
    db.sqlite.prepare("insert into av2_catalog_aliases values(?,?,?,?,?,?,?)")
      .run(entryId, "test-current", market, shop, sku, entryId, Number(sku === cardSku));
    return entryId;
  };
  const wbCard = addCard("WB", "2", "5");
  assert.equal((await snapshot()).positions[0].workNorms?.packing, null);
  const ozonCard = addCard("OZON", "2", "3");

  const ready = (await snapshot()).positions[0];
  assert.equal(ready.workNorms?.cut, 7000 / 3);
  assert.equal(ready.workNorms?.packing, 825);
  assert.equal(ready.workNorms?.multiplier, 3);
  assert.equal(ready.catalogEntryId, null);
  assert.equal(ready.unitsPerBox, null);
  assert.equal((await snapshot()).supplies.find(s => s.id === supplyId)?.store, "Не подтверждён");
  await save("cut");
  await save("packing");
  const work = db.sqlite.prepare("select operation,norm,coefficient,created_at from av2_work order by rowid").all();
  assert.equal(work[0].coefficient, null);
  assert.equal(Number(work[1].norm), 7000 / 3);
  assert.equal(Number(work[1].coefficient), 9 / (7000 / 3));
  assert.equal(Number(work[2].coefficient), 9 / 825);
  const day = new Date(Date.parse(String(work[1].created_at)) + 3 * 3600000).toISOString().slice(0, 10);
  const report = await readRitmWorkReport(db.store, new URL(`https://test/api/ritm/work-report?from=${day}&to=${day}`));
  const rated = report?.events.filter(e => e.positionId === rawPosition.externalId && e.coefficient !== null);
  assert.deepEqual(rated?.map(e => e.productType), [kind, kind]);
  const unrated = report?.events.find(e => e.positionId === rawPosition.externalId && e.coefficient === null);
  assert.deepEqual(unrated?.normIssue, { reason: "ready", market: "OZON", store: "2", hasCard: true });
  assert.ok(unrated && typeof unrated.id === "string");
  const unratedId = unrated.id;
  const applyNorms = (entryId: string, role: "collector" | "manager") => api(
    new Request("https://test/api/command", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "catalog.applyWorkNorms", key: crypto.randomUUID(),
        payload: { entryId, revision: 0, workIds: [unratedId] } }) }),
    db, role, role,
  );
  assert.equal((await applyNorms(ozonCard, "collector")).status, 403);
  assert.equal((await applyNorms(wbCard, "manager")).ok, false);
  const applied = await applyNorms(ozonCard, "manager");
  assert.equal(applied.ok, true);
  assert.equal(Number(db.sqlite.prepare("select coefficient from av2_work where id=?").get(unratedId)?.coefficient), 9 / 825);
  assert.equal((await applyNorms(ozonCard, "manager")).ok, false);

  const alternate = addCard("OZON", "1", "4");
  assert.equal((await snapshot()).positions[0].workNorms?.packing, null);
  db.sqlite.prepare("update av2_supplies set store='2' where id=?").run(supplyId);
  assert.equal((await snapshot()).positions[0].workNorms?.cut, 7000 / 3);
  db.sqlite.prepare("update av2_supplies set store='Не подтверждён' where id=?").run(supplyId);
  db.sqlite.prepare(`insert into av2_catalog_products(
    entry_id,market,store,sku,search,machine,review,data,revision,actor,updated_at
  ) values(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(alternate, "OZON", "1", sku + "(OZ)", sku, "", 0,
      JSON.stringify({ kind, sheetsPerUnit: "4", aliases: [sku], retiredIdentity: {} }), 1, "test", "now");
  assert.equal((await snapshot()).positions[0].workNorms?.cut, 7000 / 3);
  db.sqlite.prepare("update av2_positions set source_active=0,ready=0 where id=?").run(position.id);
  assert.equal((await snapshot()).positions[0].workNorms?.cut, null);
  await assert.rejects(save("cut"), /подтвердил готовность/);
});
