import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/local-db";
import { dispatchHistoryPageSize } from "../shared/dispatch-history";

test("поиск короба находит старую отправку и отмену по их архивам, включая старые записи без состава", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const history = db.dispatchHistory;
  assert.ok(history);
  const box = { id: "box-id", label: "1Мос71", qty: 10, items: [
    { sku: "CT0001.A7431", qty: 3 }, { sku: "CT0001.A7431", qty: 7 },
  ] };
  const second = { ...box, id: "box-id-2", label: "1Мос72" };
  const legacy = { id: "legacy-box-id", label: "1тк1" };
  const oldDate = "2026-11-10T13:00:00.000Z";
  const recentDate = "2026-11-21T14:00:00.000Z";
  const destinations = [
    { id: "old-send", state: "sent", date: oldDate, payload: JSON.stringify({ cartons: [box, second] }), cartons: [box.id, second.id] },
    { id: "new-cancel", state: "canceled", date: recentDate, payload: null, cartons: [box.id] },
    { id: "legacy-send", state: "sent", date: recentDate, payload: null, cartons: [legacy.id] },
    ...Array.from({ length: dispatchHistoryPageSize }, (_, i) => {
      const other = { ...box, id: "box-other-" + i, label: "1Мос8" + i };
      return { id: "other-" + i, state: "sent", date: recentDate, payload: JSON.stringify({ cartons: [other] }), cartons: [other.id] };
    }),
  ];
  await db.store.batch([
    ...destinations.map(({ id, state, date, payload, cartons }) => ({
      sql: `insert into av2_dispatches(id,label,market,store,destination,state,actor,created_at,
        sent_at,sent_payload,carton_ids,qty) values(?,?,'WB','1','Тверь',?,'test',?,?,?,?,10)`,
      args: [id, id, state, date, state === "sent" ? date : null, payload, JSON.stringify(cartons)],
    })),
    {
      sql: `insert into av2_cartons(id,label,market,store,destination,state,created_at,dispatch_id)
        values(?,?,'WB','1','Тверь','closed',?,'legacy-send')`,
      args: [legacy.id, legacy.label, oldDate],
    },
    {
      sql: `insert into av2_exports(id,dispatch_id,kind,payload,actor,created_at)
        values('saved','new-cancel','account',?,'test',?)`,
      args: [JSON.stringify({ cartons: [box] }), recentDate],
    },
  ]);
  assert.equal((await history.page(0)).entries.some((entry) => entry.id === "old-send"), false);
  const matches = await history.page(0, "1мОс71");
  assert.equal(matches.total, 2);
  assert.deepEqual(matches.entries.map((entry) => [entry.id, entry.matchedCarton]), [
    ["old-send", { id: box.id, label: box.label, exact: true, ozonCode: undefined, articleQty: undefined }],
    ["new-cancel", { id: box.id, label: box.label, exact: true, ozonCode: undefined, articleQty: undefined }],
  ]);
  const partial = await history.page(0, "оС7");
  assert.deepEqual(partial.entries.map((entry) => [entry.id, entry.matchedCarton?.id, entry.matchedCarton?.exact]), [
    ["old-send", box.id, false], ["old-send", second.id, false], ["new-cancel", box.id, false],
  ]);
  assert.equal((await history.page(0, legacy.label)).entries[0].matchedCarton?.id, legacy.id);
  assert.equal((await history.page(0, "1м*")).total, 0);
  assert.equal((await history.page(0, "CT0001.A743")).total, 0);
  assert.equal((await history.page(0, "CT0001.A7431(OZ)")).total, 0);
  const articles = await history.page(0, "ct0001.a7431");
  assert.equal(articles.total, dispatchHistoryPageSize + 3);
  assert.equal(articles.entries.length, dispatchHistoryPageSize);
  const lastPage = await history.page(1, "ct0001.a7431");
  assert.deepEqual(lastPage.entries.map((entry) => [entry.id, entry.matchedCarton?.id, entry.matchedCarton?.articleQty]), [
    ["old-send", box.id, 10], ["old-send", second.id, 10], ["new-cancel", box.id, 10],
  ]);
  assert.deepEqual(await history.page(2, "ct0001.a7431"), { entries: [], total: articles.total });
});
