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
test("catalog details stay within the shipment marketplace and never override a source machine", () => {
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
  assert.equal(orders[0].machine, "XEROX");
  assert.equal(orders[0].productName, "Товар");
  assert.equal(orders[1].machine, "DTF");
  assert.equal(orders[1].machineSource, "catalog");
  assert.equal(orders[1].photoUrl, "https://example.test/photo.png");
  assert.equal(orders[2].machine, undefined);
});
test("conflicting catalog machines remain unassigned", () => {
  const orders = [{ sheetName: "WB Тест", article: "SKU" }];
  assignWorkloadDetails(orders, {
    WB: [
      ["Артикул", "Вид станка по умолчанию"],
      ["SKU", "DTF"],
      ["SKU", "XEROX"],
    ],
  });
  assert.equal(orders[0].machine, undefined);
  assert.match(orders[0].machineIssue, /разные станки/);
});

test("a source formula error can use an unambiguous machine from its own marketplace", () => {
  const orders = [{ sheetName: "OZON Тест", article: "SKU", machine: "#N/A" }];
  assignWorkloadDetails(orders, { OZON: [["Артикул", "", "Станок"], ["SKU", "", "УФ"]] });
  assert.equal(orders[0].machine, "УФ");
  assert.equal(orders[0].machineSource, "catalog");
});
