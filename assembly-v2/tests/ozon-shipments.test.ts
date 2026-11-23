import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { api } from "../server/api";
import { openDatabase } from "../server/local-db";
import { readRitmWarehousePage } from "../server/ritm-warehouse";
import type { Snapshot } from "../shared/model";
import type { DispatchHistoryDetail, DispatchHistoryPage } from "../shared/dispatch-history";
import { ozonCodesByCarton, summarizeOzonProducts, type OzonGroup, type OzonPreview } from "../shared/ozon-shipment";
import { accountWorkbook } from "../src/exports/excel";
import {
  ozonCargoWorkbook, ozonControlWorkbook, ozonProductsWorkbook, readOzonBarcodeWorkbook,
} from "../src/exports/ozon-excel";
import { bootstrap, fixture } from "./fixtures";

test("Ozon: готовит товары по магазину и кластеру, затем назначает ШК и сверяет грузоместа", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  await f.cmd("work.save", { positionId: f.a.id, employeeId: f.employee.id, operation: "packing", qty: 60 });
  await f.cmd("allocation.add", { positionId: f.a.id, qty: 27, newCarton: true });
  await f.cmd("allocation.add", { positionId: f.a.id, qty: 33, newCarton: true });
  const other = {
    ...fixture,
    externalId: "OZON-QA-YAR",
    store: "2",
    title: "OZON Ярославль 18.11.2026 (2 магазин)",
    destination: "OZON Ярославль 18.11.2026 (2 магазин)",
    positions: [{ ...fixture.positions[0], externalId: "OZON-QA-YAR|sku", sku: fixture.positions[0].sku + " (oz)" }],
  };
  await f.cmd("supply.import", other);
  let state = await db.snapshot(null) as Snapshot;
  const otherSupply = state.supplies.find((supply) => supply.externalId === other.externalId)!;
  const otherPosition = (await db.snapshot(otherSupply.id) as Snapshot).positions[0];
  await f.cmd("work.save", { positionId: otherPosition.id, employeeId: f.employee.id, operation: "packing", qty: 4 });
  await f.cmd("allocation.add", { positionId: otherPosition.id, qty: 4, newCarton: true });
  state = await db.snapshot(null) as Snapshot;
  const city = state.cartons.filter((box) => box.store === "1").sort((a, b) => a.label.localeCompare(b.label, "ru"));
  const yar = state.cartons.find((box) => box.store === "2")!;
  const numbers = [city[1].label, city[0].label, yar.label].join("\n");
  const makePreview = (role: "manager" | "collector", input = numbers) => api(
    new Request("https://assembly.test/api/ozon/preview", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ numbers: input }),
    }), db, "test-owner", role,
  );
  assert.equal((await makePreview("collector")).status, 403);
  const preview = await (await makePreview("manager")).json() as OzonPreview;
  assert.equal(preview.issues.length, 0);
  assert.deepEqual(preview.groups.map((g) => [g.city, g.store, g.cluster]),
    [["Москва", "1", "Москва, МО и Дальние регионы"], ["Ярославль", "2", "Ярославль"]]);
  assert.deepEqual(preview.groups[0].boxes.map((b) => b.label), [city[1].label, city[0].label]);

  const badPreview = await (await makePreview("manager", numbers + "\nнесуществующий")).json() as OzonPreview;
  assert.match(badPreview.issues[0].reason, /не найден/);
  const input = { boxes: preview.groups.flatMap((group) => group.boxes.map(({ id, proof }) => ({ id, proof, cluster: group.cluster }))) };
  await assert.rejects(f.cmd("ozon.prepare", {
    boxes: input.boxes.map((box, index) => index === 1 ? { ...box, proof: "старый состав" } : box),
  }), /статус изменился/);
  assert.equal((await db.snapshot(null) as Snapshot).cartons.every((box) => box.state === "open" && !box.dispatchId), true);
  const key = crypto.randomUUID();
  const ready = await f.cmd("ozon.prepare", input, key);
  assert.deepEqual(await f.cmd("ozon.prepare", input, key), ready);
  const batchId = String(ready.batchId);
  let saved = (await db.ozon!.batch(batchId))!;
  assert.equal(saved.groups.length, 2);
  assert.deepEqual(saved.groups.map((g) => g.dispatch.state), ["draft", "draft"]);
  state = await db.snapshot(null) as Snapshot;
  assert.equal(state.cartons.every((box) => box.state === "closed" && box.dispatchId), true);
  const ritm = await readRitmWarehousePage(db.store, new URL("https://assembly.test/api/ritm/warehouse"));
  assert.equal(ritm.cartons.length, 3);
  assert.equal(ritm.cartons.every((box) => box.status === "closed" && box.reserved && box.dispatchStatus === "pending"), true);
  assert.equal(state.exports.length, 0);
  const first = saved.groups[0];
  const products = ozonProductsWorkbook(first);
  assert.deepEqual(products.worksheets.map((sheet) => sheet.name), ["Sheet1"]);
  assert.equal(products.getWorksheet("Sheet1")!.getCell("C2").value, 60);
  assert.equal(ozonProductsWorkbook(saved.groups[1]).getWorksheet("Sheet1")!.getCell("C2").value, 4);
  assert.throws(() => ozonCargoWorkbook(first), /Сначала сохраните пары/);

  const codes = ["1022124184352999", "1022124184353999"];
  const replacedCode = "1022124184352998";
  await assert.rejects(f.cmd("ozon.assign", { dispatchId: first.dispatch.id, codes: [codes[0]] }), /должно совпадать/);
  const originalLabels = await f.cmd("ozon.assign", {
    dispatchId: first.dispatch.id, codes: [replacedCode, codes[1]], previousLabelId: null,
  });
  await f.cmd("ozon.assign", { dispatchId: first.dispatch.id, codes, previousLabelId: originalLabels.labelId });
  await assert.rejects(f.cmd("ozon.assign", { dispatchId: saved.groups[1].dispatch.id, codes: [codes[0]] }), /другой отгрузкой/);
  saved = (await db.ozon!.batch(batchId))!;
  assert.deepEqual(saved.groups[0].labels?.codes, codes);
  const cargo = ozonCargoWorkbook(saved.groups[0]);
  const readable = new ExcelJS.Workbook();
  const buffer = await cargo.xlsx.writeBuffer();
  await readable.xlsx.load(buffer);
  assert.deepEqual(readable.worksheets.map((sheet) => sheet.name), ["Состав ГМ поставки", "Инструкция"]);
  const sheet = readable.worksheets[0];
  assert.equal(sheet.getCell("F1").value, "ШК ГМ");
  assert.equal(sheet.getCell("F2").value, codes[0]);
  assert.equal(sheet.getCell("F3").value, codes[1]);
  assert.equal(sheet.getCell("E2").value, null);
  assert.equal(sheet.getCell("D2").value, "Сортируемый товар");
  assert.equal(sheet.getCell("G2").value, "Коробка");
  assert.equal(Number(sheet.getCell("C2").value) + Number(sheet.getCell("C3").value), summarizeOzonProducts(first.boxes)[0].qty);
  assert.deepEqual(await readOzonBarcodeWorkbook(buffer), codes);
  assert.deepEqual(ozonControlWorkbook(saved).worksheets.map((sheet) => sheet.name), ["Москва — магазин 1", "Ярославль — магазин 2"]);
  assert.equal((await db.ozon!.list())[0].labelCount, 2);
  assert.equal((await db.ozon!.list())[0].boxCount, 3);

  // The Ozon assignment order is the reverse of the frozen departure's order.
  const historyRequest = (role: "owner" | "manager" | "collector", query = "") =>
    api(new Request("https://assembly.test/api/dispatch-history" + query), db, "test-owner", role);
  assert.equal((await historyRequest("collector")).status, 403);
  assert.equal((await historyRequest("collector", "?id=" + first.dispatch.id)).status, 403);
  assert.equal((await historyRequest("collector", "?q=" + codes[0])).status, 403);
  assert.equal((await historyRequest("manager", "?id=" + first.dispatch.id)).status, 404);
  const searchHistory = async (query: string) => {
    const response = await historyRequest("manager", "?" + new URLSearchParams({ q: query }));
    assert.equal(response.status, 200);
    return await response.json() as DispatchHistoryPage;
  };
  assert.equal((await searchHistory(codes[0])).total, 0);
  assert.equal((await searchHistory(f.a.sku)).total, 0);
  await f.cmd("dispatch.send", { dispatchId: first.dispatch.id, confirmed: true });
  await f.cmd("dispatch.cancel", { dispatchId: saved.groups[1].dispatch.id });
  const page = await (await historyRequest("manager")).json() as DispatchHistoryPage;
  assert.equal(page.total, 2);
  assert.deepEqual(page.entries.find((entry) => entry.id === first.dispatch.id)?.cartonLabels, [city[1].label, city[0].label]);
  const history = await (await historyRequest("manager", "?id=" + first.dispatch.id)).json() as DispatchHistoryDetail;
  assert.equal(history.archive?.kind, "departure");
  assert.deepEqual(history.archive!.payload.cartons.map(({ id }) => id), [city[0].id, city[1].id]);
  const recordedCodes = ozonCodesByCarton(history.ozon);
  assert.deepEqual(history.archive!.payload.cartons.map(({ id }) => recordedCodes.get(id)), [codes[1], codes[0]]);
  for (const query of [codes[0], " " + city[1].label.toUpperCase() + " "]) {
    const result = await searchHistory(query);
    assert.equal(result.total, 1);
    assert.equal(result.entries[0].id, first.dispatch.id);
    assert.deepEqual(result.entries[0].matchedCarton, {
      id: city[1].id, label: city[1].label, exact: true,
      ...(query === codes[0] ? { ozonCode: codes[0] } : {}),
    });
  }
  assert.equal((await searchHistory(replacedCode)).total, 0);
  assert.equal((await searchHistory("2998")).total, 0);
  assert.equal((await searchHistory("2435")).total, 0);
  const suffixMatches = await searchHistory("999");
  assert.equal(suffixMatches.total, 2);
  assert.deepEqual(new Map(suffixMatches.entries.map(({ matchedCarton }) => [matchedCarton?.id, matchedCarton?.ozonCode])),
    new Map([[city[1].id, codes[0]], [city[0].id, codes[1]]]));
  assert.deepEqual((await searchHistory(yar.label)).entries[0].matchedCarton, { id: yar.id, label: yar.label, exact: true });
  for (const sku of [f.a.sku, f.a.sku.toLowerCase() + " (oz)"]) {
    const products = await searchHistory(sku);
    assert.equal(products.total, 3);
    assert.deepEqual(new Map(products.entries.map(({ matchedCarton }) => [matchedCarton?.id, matchedCarton?.articleQty])),
      new Map([[city[0].id, 27], [city[1].id, 33], [yar.id, 4]]));
  }
  const historyBook = accountWorkbook(history.archive!, recordedCodes);
  const savedHistory = new ExcelJS.Workbook();
  await savedHistory.xlsx.load(await historyBook.xlsx.writeBuffer());
  const historySheet = savedHistory.getWorksheet("Короба")!;
  assert.equal(historySheet.getCell("J1").value, "ШК грузоместа Ozon");
  assert.equal(historySheet.getCell("J2").value, codes[1]);
  assert.equal(historySheet.getCell("J3").value, codes[0]);
  const canceled = await (await historyRequest("owner", "?id=" + saved.groups[1].dispatch.id)).json() as DispatchHistoryDetail;
  assert.equal(canceled.archive, null);
  assert.equal(canceled.ozon?.boxes[0].qty, 4);
  assert.equal(ozonCodesByCarton(canceled.ozon).size, 0);
});

test("Ozon: сохраняет обе пары при недостающем ШК товара и обновляет Excel после его заполнения", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  await f.cmd("work.save", { positionId: f.a.id, employeeId: f.employee.id, operation: "packing", qty: 60 });
  await f.cmd("allocation.add", { positionId: f.a.id, qty: 28, newCarton: true });
  await f.cmd("allocation.add", { positionId: f.a.id, qty: 32, newCarton: true });
  db.sqlite.prepare("update av2_positions set barcode='' where id=?").run(f.a.id);
  const { cartons } = await db.snapshot(null) as Snapshot;
  const ozon = db.ozon;
  assert.ok(ozon);
  const preview = await ozon.preview(cartons.map((box) => box.label).join("\n"));
  const prepared = await f.cmd("ozon.prepare", {
    boxes: preview.groups.flatMap((group) => group.boxes.map(({ id, proof }) => ({ id, proof, cluster: group.cluster }))),
  });
  const read = async () => (await ozon.batch(String(prepared.batchId)))!.groups[0];
  const group = await read();
  const codes = ["1022124999991000", "1022124999992000"];
  const assign = (previousLabelId: unknown) => f.cmd("ozon.assign", { dispatchId: group.dispatch.id, codes, previousLabelId });
  const assigned = await assign(null);
  const fresh = await read();
  assert.deepEqual([...ozonCodesByCarton(fresh)], cartons.map(({ id }, index) => [id, codes[index]]));
  assert.throws(() => ozonCargoWorkbook(fresh), /Укажите ШК товара/);
  await assert.rejects(assign(null), /Штрихкоды уже обновились/);

  db.sqlite.prepare("update av2_positions set sku=?,barcode=? where id=?")
    .run(f.a.sku + " (oz)", "OZN123456789", f.a.id);
  await assign(assigned.labelId);
  const updated = await read();
  const cargo = ozonCargoWorkbook(updated).worksheets[0];
  assert.equal(cargo.getCell("A2").value, "OZN123456789");
  assert.equal(cargo.getCell("F2").value, codes[0]);
  assert.equal(cargo.getCell("F3").value, codes[1]);
});

test("Ozon: Excel добавляет один суффикс (OZ) к старым артикулам и суммирует варианты", async () => {
  const group: OzonGroup = {
    batchId: "batch",
    city: "Казань",
    cluster: "Казань",
    dispatch: {
      id: "dispatch", label: "ОТ-00001", market: "OZON", store: "1", destination: "Казань",
      state: "draft", createdAt: "2026-11-21T11:00:00Z", sentAt: null, qty: 39, cartonIds: ["first", "second"],
    },
    boxes: [
      {
        id: "first", label: "1каз14", qty: 31,
        products: [
          { sku: "KT0008.A5592", name: "Наклейки", qty: 16 },
          { sku: "KT0008.A5592(OZ)", name: "Наклейки", qty: 15 },
        ],
      },
      {
        id: "second", label: "1каз15", qty: 8,
        products: [{ sku: "RT0001.A0014 (oz)", name: "Стикеры", qty: 8 }],
      },
    ],
    labels: {
      id: "labels",
      codes: ["1022124184352999", "1022124184353998"],
      products: [
        { sku: "KT0008.A5592", barcode: "OZN10000123456" },
        { sku: "KT0008.A5592(OZ)", barcode: "OZN10000123456" },
        { sku: "RT0001.A0014 (oz)", barcode: "OZN10000123457" },
      ],
    },
  };
  async function readSheet(book: ExcelJS.Workbook) {
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(await book.xlsx.writeBuffer());
    return reopened.worksheets[0];
  }
  const [products, cargo, control] = await Promise.all([
    readSheet(ozonProductsWorkbook(group)),
    readSheet(ozonCargoWorkbook(group)),
    readSheet(ozonControlWorkbook({ id: group.batchId, groups: [group] })),
  ]);
  assert.equal(products.rowCount, 3);
  assert.deepEqual((products.getRow(2).values as unknown[]).slice(1), ["KT0008.A5592(OZ)", "Наклейки", 31]);
  assert.deepEqual((products.getRow(3).values as unknown[]).slice(1), ["RT0001.A0014(OZ)", "Стикеры", 8]);
  assert.equal(cargo.rowCount, 3);
  assert.equal(cargo.getCell("A2").value, "OZN10000123456");
  assert.equal(cargo.getCell("B2").value, "KT0008.A5592(OZ)");
  assert.equal(cargo.getCell("C2").value, 31);
  assert.equal(cargo.getCell("F2").value, "1022124184352999");
  assert.equal(cargo.getCell("B3").value, "RT0001.A0014(OZ)");
  assert.equal(cargo.getCell("F3").value, "1022124184353998");
  assert.deepEqual((control.getRow(3).values as unknown[]).slice(1), ["KT0008.A5592(OZ)", 31, "Наклейки"]);
  assert.deepEqual(control.getColumn(3).values?.slice(-3), ["KT0008.A5592(OZ)", "KT0008.A5592(OZ)", "RT0001.A0014(OZ)"]);
  assert.equal(group.boxes[0].products[0].sku, "KT0008.A5592");

  const labels = group.labels!;
  assert.throws(() => ozonCargoWorkbook({
    ...group,
    labels: {
      ...labels,
      products: [...labels.products, { sku: "KT0008.A5592(oz)", barcode: "OZN20000123456" }],
    },
  }), /однозначный ШК товара KT0008\.A5592\(OZ\)/);
});

test("файл Ozon сохраняет длинные ШК, выбирает кластер и отклоняет повторы в списке", async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Штрихкоды");
  sheet.addRows([
    ["Номер ГМ", "Кластер", "Штрихкод грузового места"],
    [1, "Москва, МО и Дальние регионы", "1022124184352999"],
    [2, "Ярославль", "1022124184353998"],
  ]);
  assert.deepEqual(await readOzonBarcodeWorkbook(await book.xlsx.writeBuffer(), "Ярославль"), ["1022124184353998"]);
  sheet.addRow([3, "Ярославль", "1022124184353998"]);
  await assert.rejects(readOzonBarcodeWorkbook(await book.xlsx.writeBuffer(), "Ярославль"), /повторяются/);
});
