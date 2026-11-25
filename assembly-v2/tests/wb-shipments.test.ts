import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { api } from "../server/api";
import { openDatabase } from "../server/local-db";
import type { OzonBatch } from "../shared/ozon-shipment";
import type { Snapshot } from "../shared/model";
import { readWbCartonWorkbook, wbWorkbook } from "../src/exports/wb-excel";
import { bootstrap, fixture } from "./fixtures";

test("WB: готовит отгрузки по магазину, сохраняет оба вида кодов и переносит пары при частичном выезде", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  const wb = db.wb;
  assert.ok(wb);
  async function pack(store: string, quantities: number[]) {
    const externalId = "WB-TEST-" + store;
    await f.cmd("supply.import", {
      ...fixture, externalId, title: "WB Щербинка", destination: "WB Щербинка", market: "WB", store,
      positions: fixture.positions.slice(0, 2).map((p) => ({ ...p, externalId: externalId + "|" + p.sku })),
    });
    const supply = (await db.snapshot(null) as Snapshot).supplies.find((s) => s.externalId === externalId)!;
    const [first, second] = (await db.snapshot(supply.id) as Snapshot).positions;
    await f.cmd("work.save", { positionId: first.id, employeeId: f.employee.id, operation: "packing", qty: quantities.reduce((a, b) => a + b) });
    await f.cmd("work.save", { positionId: second.id, employeeId: f.employee.id, operation: "packing", qty: 7 });
    const labels: string[] = [];
    for (const qty of quantities) {
      const carton = await f.cmd("allocation.add", { positionId: first.id, qty, newCarton: true });
      if (labels.length === 0) await f.cmd("allocation.add", { positionId: second.id, qty: 7, cartonId: carton.cartonId });
      labels.push(String(carton.label));
    }
    return { labels, second };
  }
  const first = await pack("1", [15, 23]);
  const second = await pack("2", [10, 20]);
  db.sqlite.prepare("update av2_positions set barcode='' where id=?").run(first.second.id);
  const preview = await wb.preview([...first.labels, ...second.labels].join("\n"));
  assert.equal(preview.issues.length, 0);
  assert.deepEqual(preview.groups.map((group) => [group.store, group.boxes.length]), [["1", 2], ["2", 2]]);
  const prepared = await f.cmd("wb.prepare", {
    boxes: preview.groups.flatMap((group) => group.boxes.map(({ id, proof }) => ({ id, proof, cluster: group.cluster }))),
  });
  const batchPath = "/api/wb/shipments?id=" + prepared.batchId;
  const load = async () => {
    const response = await api(new Request("https://assembly.test" + batchPath), db, "manager", "manager");
    assert.equal(response.status, 200);
    return await response.json() as OzonBatch;
  };
  assert.equal((await api(new Request("https://assembly.test" + batchPath), db, "collector", "collector")).status, 403);
  let batch = await load();
  const primary = batch.groups.find((group) => group.dispatch.store === "1")!;
  const secondary = batch.groups.find((group) => group.dispatch.store === "2")!;
  assert.equal(primary.dispatch.market, "WB");
  assert.throws(() => wbWorkbook(primary, "products"), /однозначный баркод/);
  const generate = { dispatchId: primary.dispatch.id, previousLabelId: null };
  const retryKey = crypto.randomUUID();
  const [created, retried] = await Promise.all([
    f.cmd("wb.generate", generate, retryKey), f.cmd("wb.generate", generate, retryKey),
  ]);
  assert.deepEqual(created, retried);
  await assert.rejects(f.cmd("wb.generate", generate), /уже обновились/);
  batch = await load();
  const generated = batch.groups.find((group) => group.dispatch.id === primary.dispatch.id)!.labels!;
  assert.equal(new Set(generated.codes).size, 2);
  assert.ok(generated.codes.every((code) => /^RITM[A-F0-9]{32}$/u.test(code)));
  const duplicate = { code: generated.codes[0].toLowerCase(), printCode: null };
  await assert.rejects(f.cmd("wb.assign", {
    dispatchId: secondary.dispatch.id, entries: [duplicate, { code: "19530565", printCode: null }],
  }), /другой отгрузке/);
  const imported = [
    { code: "019530565", printCode: "$Ts;Qa1;B;1;Aa;TAS" },
    { code: "19530201", printCode: "$Ts;Qa2;B;1;Aa;TAS" },
  ];
  const wbFile = new ExcelJS.Workbook();
  wbFile.addWorksheet("Sheet1").addRows([
    ["Баркод товара", "Кол-во товаров", "ШК короба", "Срок годности", "ШК короба для печати в стороннем сервисе"],
    ...imported.map(({ code, printCode }) => [null, 0, code, null, printCode]),
    ["0012345678901", 3, imported[0].code, null, imported[0].printCode],
  ]);
  const read = await readWbCartonWorkbook(await wbFile.xlsx.writeBuffer());
  assert.deepEqual(read, imported);
  const assign = await api(new Request("https://assembly.test/api/command", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "wb.assign", key: crypto.randomUUID(), payload: { dispatchId: secondary.dispatch.id, entries: read },
    }),
  }), db, "manager", "manager");
  assert.equal(assign.status, 200);
  const importedGroup = (await load()).groups.find((group) => group.dispatch.id === secondary.dispatch.id)!;
  assert.deepEqual(importedGroup.labels?.codes, imported.map(({ code }) => code));
  assert.deepEqual(importedGroup.labels?.printCodes, imported.map(({ printCode }) => printCode));
  const cargo = wbWorkbook(importedGroup, "cargo").worksheets[0];
  assert.deepEqual(cargo.getColumn(3).values?.slice(2), ["019530565", "019530565", "19530201"]);
  assert.equal(cargo.getCell("E2").value, null);

  db.sqlite.prepare("update av2_positions set barcode=? where id=?").run("090000000003", first.second.id);
  const ready = (await load()).groups.find((group) => group.dispatch.id === primary.dispatch.id)!;
  const products = wbWorkbook(ready, "products").worksheets[0];
  assert.deepEqual((products.getRow(1).values as string[]).slice(1), ["Баркод", "Количество"]);
  assert.deepEqual((products.getRow(2).values as unknown[]).slice(1), [fixture.positions[0].barcode, 38]);
  assert.deepEqual((products.getRow(3).values as unknown[]).slice(1), ["090000000003", 7]);
  const qr = generated.codes.map((code, index) => ({ code, printCode: "$Ts;Added;" + index + ";TAS" }));
  await f.cmd("wb.assign", {
    dispatchId: primary.dispatch.id, previousLabelId: generated.id, entries: [...qr].reverse(),
  });
  const afterQr = (await load()).groups.find((group) => group.dispatch.id === primary.dispatch.id)!;
  assert.deepEqual(afterQr.labels?.codes, generated.codes);
  assert.deepEqual(afterQr.labels?.printCodes, qr.map(({ printCode }) => printCode));
  const firstCartonId = primary.boxes[0].id;
  await f.cmd("dispatch.send", { dispatchId: primary.dispatch.id, confirmed: true, cartonIds: [firstCartonId] });
  const afterSend = (await load()).groups.filter((group) => group.dispatch.store === "1");
  assert.deepEqual(afterSend.find((group) => group.dispatch.state === "sent")?.labels?.codes, [generated.codes[0]]);
  assert.deepEqual(afterSend.find((group) => group.dispatch.state === "draft")?.labels?.printCodes, [qr[1].printCode]);
  await f.cmd("dispatch.cancel", { dispatchId: primary.dispatch.id });
  await assert.rejects(f.cmd("wb.assign", {
    dispatchId: secondary.dispatch.id, previousLabelId: importedGroup.labels?.id, replaceCodes: true,
    entries: [{ code: generated.codes[1], printCode: null }, imported[1]],
  }), /другой отгрузке/);
});
