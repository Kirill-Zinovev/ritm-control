import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../shared/catalog";
import { openDatabase } from "../server/local-db";
import { shipmentTrackingApi, shipmentTrackingPath } from "../server/shipment-tracking";
import worker from "../server/worker";

const token = "tracking-test-token-with-at-least-32-characters";
const now = "2026-11-26T12:30:00.000Z";
const request = (params: Record<string, string>, headers?: Record<string, string>, method = "GET") =>
  new Request("https://assembly.example" + shipmentTrackingPath + "?" + new URLSearchParams(params), { headers, method });
const authorization = { Authorization: "Bearer " + token };

test("выгрузка доступна только для GET с отдельным токеном, токен не открывает методы Assembly", async () => {
  const tokenHash = await digest(token);
  const store = { all: async <T>(): Promise<T[]> => assert.fail("Запрос к данным без доступа") };
  assert.equal((await shipmentTrackingApi(request({ q: "Хоругвино" }), tokenHash, store)).status, 401);
  assert.equal((await shipmentTrackingApi(request({ q: "Хоругвино" }, authorization), undefined, store)).status, 401);
  assert.equal((await shipmentTrackingApi(request({ q: "Хоругвино" }, { "x-assembly-admin-token": token }), tokenHash, store)).status, 401);
  assert.equal((await shipmentTrackingApi(request({ q: "Хоругвино" }, authorization, "POST"), tokenHash, store)).status, 405);
  assert.equal((await shipmentTrackingApi(request({ id: "!" }, authorization), tokenHash, store)).status, 400);
  assert.equal((await worker.fetch(request({ q: "Хоругвино" }), { OZON_SHIPMENT_TRACKING_TOKEN_SHA256: tokenHash })).status, 401);
  const unrelated = new Request("https://assembly.example/api/dispatch-history", { headers: authorization });
  assert.equal((await worker.fetch(unrelated, { OZON_SHIPMENT_TRACKING_TOKEN_SHA256: tokenHash })).status, 401);
});

test("поиск по поставке выбирает только её реально уехавшие товары из общего выезда", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const firstTitle = "OZON МОСКВА 10_10 · Февраль [А]*_Ёж";
  const dispatchTitle = "OZON ДАЛЬНИЙ ВОСТОК 10_10 · Хоругвино";
  const item = (supplyId: string, supply: string, externalSupplyId: string, sku: string, qty: number) =>
    ({ supplyId, supply, externalSupplyId, sku, qty });
  const boxes = [
    { id: "box-1", items: [
      item("first", firstTitle, "654321", "AB123", 3),
      item("second", "Февраль Б", "112233", "XY456", 8),
    ] },
    { id: "box-2", items: [item("first", firstTitle, "654321", "AB123(OZ)", 5)] },
    { id: "returned", items: [item("first", firstTitle, "654321", "AB123", 11)] },
  ];
  await db.store.batch([
    ...[
      ["d1", "OZON", "sent", JSON.stringify({ cartons: boxes })],
      ["d2", "OZON", "canceled", JSON.stringify({ cartons: boxes })],
      ["d3", "WB", "sent", JSON.stringify({ cartons: boxes })],
      ["d4", "OZON", "sent", null],
      ["d5", "OZON", "draft", JSON.stringify({ cartons: boxes })],
    ].map(([id, market, state, payload]) => ({
      sql: `insert into av2_dispatches(id,label,market,store,destination,state,actor,created_at,sent_at,sent_payload,carton_ids,qty)
        values(?,?,?,'2','Хоругвино',?,'test-actor',?,?,?,?,27)`,
      args: [id, dispatchTitle, market, state, now, now, payload, JSON.stringify(boxes.map(box => box.id))],
    })),
    {
      sql: `insert into av2_commands(key,action,payload,result,expected_revision,actor,created_at)
        values('returned-command','dispatch.returnCarton',?,?,0,'test-actor',?)`,
      args: [JSON.stringify({ cartonId: "returned" }), JSON.stringify({ dispatchId: "d1", status: "pending" }), now],
    },
  ]);
  const tokenHash = await digest(token);
  const d1 = {
    async all<T>(sql: string, args: (string | number | null)[] = []): Promise<T[]> {
      // Local SQLite has a larger GLOB limit than Cloudflare D1 (50 UTF-8 bytes).
      if (/\bglob\b/i.test(sql) && typeof args[0] === "string" && Buffer.byteLength(args[0]) + 2 > 50)
        throw new Error("LIKE or GLOB pattern too complex");
      return db.store.all<T>(sql, args);
    },
  };
  const call = (params: Record<string, string>) => shipmentTrackingApi(request(params, authorization), tokenHash, d1);

  const found = await call({ q: "oZoN мОсКвА 10_10" });
  assert.equal(found.status, 200);
  assert.equal(found.headers.get("cache-control"), "no-store");
  const { shipments } = await found.json();
  assert.equal(shipments.length, 1);
  assert.match(shipments[0].id, /^[A-Za-z0-9_-]{1,160}$/);
  assert.deepEqual(shipments[0], { id: shipments[0].id, store: "2", title: firstTitle, destination: "Хоругвино", sent_at: now });
  assert.deepEqual(await (await call({ q: firstTitle.toLowerCase() })).json(), { shipments });
  assert.deepEqual(await (await call({ q: "фЕвРаЛь [а]*_ёЖ" })).json(), { shipments });
  assert.deepEqual(await (await call({ q: "654321" })).json(), { shipments });
  assert.deepEqual(await (await call({ id: shipments[0].id })).json(), {
    shipment: { ...shipments[0], items: [{ article: "AB123(OZ)", sent: 8 }] },
  });
  assert.deepEqual(await (await call({ q: "Февраль*" })).json(), { shipments: [] });
  assert.deepEqual(await (await call({ q: "Москва 10%10" })).json(), { shipments: [] });
  assert.equal((await (await call({ q: "февраль" })).json()).shipments.length, 2);
  const [whole] = (await (await call({ q: "ozon дальний восток 10_10" })).json()).shipments;
  assert.equal(whole.title, dispatchTitle);
  assert.deepEqual(await (await call({ id: whole.id })).json(), {
    shipment: { ...whole, items: [{ article: "AB123(OZ)", sent: 8 }, { article: "XY456(OZ)", sent: 8 }] },
  });
});
