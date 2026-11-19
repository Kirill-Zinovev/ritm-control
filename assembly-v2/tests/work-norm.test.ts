import test from "node:test";
import assert from "node:assert/strict";
import { effectiveWorkNorms, savedCoefficient } from "../shared/work-norm";
import { openDatabase } from "../server/local-db";
import { bootstrap } from "./fixtures";
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
