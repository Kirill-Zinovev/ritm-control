import test from "node:test";
import assert from "node:assert/strict";
import { indexOrders, assignWorkloadDetails } from "../worker/printing.js";
test("source machine is read by header, with safe optional photo and unchanged R/S facts", () => {
  const rows = Array.from({ length: 4 }, () => Array(29).fill(""));
  rows[0][28] = "UID";
  rows[3][1] = "Фото";
  rows[3][3] = "Станок";
  rows[3][4] = "Артикул";
  rows[3][14] = "Кол-во";
  const source = Array(29).fill("");
  source[1] = "javascript:alert(1)";
  source[3] = "XEROX";
  source[4] = "SKU";
  source[14] = 300;
  source[17] = "TRUE";
  source[18] = "FALSE";
  source[28] = "id";
  rows.push(source);
  const order = indexOrders([
    {
      gid: 123,
      name: "OZON Тест",
      rows,
      sourceId: "box-printing",
      headerRow: 4,
      dataStartRow: 5,
    },
  ]).orders[0];
  assert.equal(order.machine, "XEROX");
  assert.equal(order.machineSource, "supply");
  assert.equal(order.photoUrl, "");
  assert.equal(order.printProgress, 300);
  assert.equal(order.cutProgress, 0);
  assert.equal(rows[4][17], "TRUE");
});
test("catalog details stay within the shipment marketplace and replace stale source equipment", () => {
  const catalog = {
    OZON: [
      ["Артикул", "", "Станок", "Наименование", "Фото"],
      ["SKU", "ALIAS", "DTF", "Товар", "https://example.test/photo.png"],
    ],
    WB: [
      ["Артикул", "Вид станка по умолчанию"],
      ["ONLY-WB", "XEROX"],
    ],
  };
  const orders = [
    { sheetName: "OZON Тест", article: "ALIAS", machine: "XEROX" },
    { sheetName: "OZON Тест", article: "SKU" },
    { sheetName: "OZON Тест", article: "ONLY-WB" },
  ];
  assignWorkloadDetails(orders, catalog);
  assert.equal(orders[0].machine, "DTF");
  assert.equal(orders[0].machineSource, "catalog");
  assert.equal(orders[0].productName, "Товар");
  assert.equal(orders[1].machine, "DTF");
  assert.equal(orders[1].machineSource, "catalog");
  assert.equal(orders[1].photoUrl, "https://example.test/photo.png");
  assert.equal(orders[2].machine, undefined);
});
test("conflicting catalog machines remain unassigned even when the supply has a broad label", () => {
  const orders = [{ sheetName: "WB Тест", article: "SKU", machine: "Интерьерная печать" }];
  assignWorkloadDetails(orders, {
    WB: [
      ["Артикул", "Вид станка по умолчанию"],
      ["SKU", "DTF"],
      ["SKU", "XEROX"],
    ],
  });
  assert.equal(orders[0].machine, "");
  assert.match(orders[0].machineIssue, /разные станки/);
});

test("a source formula error can use an unambiguous machine from its own marketplace", () => {
  const orders = [{ sheetName: "OZON Тест", article: "SKU", machine: "#N/A" }];
  assignWorkloadDetails(orders, { OZON: [["Артикул", "", "Станок"], ["SKU", "", "УФ"]] });
  assert.equal(orders[0].machine, "УФ");
  assert.equal(orders[0].machineSource, "catalog");
});

test('broad supply process labels never hide exact catalog equipment across all supplies', () => {
 const pairs=[['LT0001.A5427','Интерьерная печать','УФ'],['JA0037.A0225','Интерьерная печать','2-GO'],['NT0006.A4692','Интерьерная печать','УФ планшет'],['KS0002.A7665','УФ-печать','УФ'],['KT0072.A0094','УФ-печать','УФ двусторонний'],['KT0046.A6935','УФ-печать','УФ'],['KS0006.A8368','Ксерокс','XEROX']];
 const orders=pairs.flatMap(([article,machine])=>['OZON Москва','OZON Будущая поставка'].map(sheetName=>({sheetName,article,machine})));
 const header=Array(16).fill('');header[0]='Артикул';header[1]='Артикул';header[14]='Станок';
 assignWorkloadDetails(orders,{OZON:[header,...pairs.map(([article,,machine])=>{const r=Array(16).fill('');r[0]=article+'(OZ)';r[1]=article;r[14]=machine;return r;})]});
 for(const order of orders){assert.equal(order.machine,pairs.find(p=>p[0]===order.article)[2]);assert.equal(order.machineSource,'catalog');}
});
test('no missing or failed catalog can erase a precise source assignment',()=>{
 for(const catalog of [null,{}, {OZON:[['Артикул','Станок'],['SKU','']]}]){
 const orders=[{sheetName:'OZON Тест',article:'SKU',machine:'XEROX',machineSource:'supply'}];assignWorkloadDetails(orders,catalog);assert.equal(orders[0].machine,'XEROX');
 }
});


test('catalog department labels are reported honestly without borrowing equipment from WB',()=>{
 const orders=[{sheetName:'OZON Тест',article:'SKU',machine:'Интерьерная печать'}];
 assignWorkloadDetails(orders,{OZON:[['Артикул','Станок'],['SKU','Бокс']],WB:[['Артикул','Вид станка по умолчанию'],['SKU','XEROX']]});
 assert.equal(orders[0].machine,'Бокс');assert.match(orders[0].machineIssue,/В базе OZON/);assert.match(orders[0].machineIssue,/Конкретный станок не указан/);
});
