import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../shared/catalog";
import type { Snapshot } from "../shared/model";
import { hmac } from "../server/access";
import { openDatabase } from "../server/local-db";
import { readRitmDispatchReport } from "../server/ritm-dispatch-report";
import worker, { type Env } from "../server/worker";
import { bootstrap, fixture } from "./fixtures";

test("Сверка учитывает фактический выезд, возврат, повторную отправку и текущие короба", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  const f = await bootstrap(db);
  const root = "RITM-ROLL-109";
  const other = "RITM-ROLL-110";
  const positionId = root + "|uid:sku-1|DEMO-101";
  const rows = async (ids = [root]) => (await readRitmDispatchReport(db.store, ids))!;

  for (const [supplyId, name, store] of [[root, "Москва", "1"], [root, "Москва", "2"], [other, "Казань", "1"]]) {
    await f.cmd("supply.import", {
      ...fixture, originShipmentId: supplyId, externalId: supplyId + "|store:" + store,
      title: name + " · Магазин " + store, destination: name + " · Магазин " + store, store,
      positions: [{ ...fixture.positions[0], externalId: positionId }],
    });
  }
  const before = await rows();
  assert.deepEqual(before.rows.map(({ supplyId, store, positionId, destination, plan, sent }) =>
    ({ supplyId, store, positionId, destination, plan, sent })), [
    { supplyId: root, store: "1", positionId, destination: "Москва", plan: 500, sent: 0 },
    { supplyId: root, store: "2", positionId, destination: "Москва", plan: 500, sent: 0 },
  ]);
  assert.equal(before.schemaVersion, 1);
  assert.equal(before.revision, await db.revision());

  const state = await db.snapshot(null) as Snapshot;
  const supply = state.supplies.find((s) => s.originShipmentId === root && s.store === "1")!;
  const [position] = (await db.snapshot(supply.id) as Snapshot).positions;
  await f.cmd("work.save", { positionId: position.id, employeeId: f.employee.id, operation: "packing", qty: 40 });
  for (const qty of [8, 12, 9]) await f.cmd("allocation.add", { positionId: position.id, qty, newCarton: true });
  const boxes = (await db.snapshot(supply.id) as Snapshot).cartons;
  const first = boxes.find((box) => box.qty === 8)!;
  const second = boxes.find((box) => box.qty === 12)!;
  const open = boxes.find((box) => box.qty === 9)!;
  for (const box of [first, second]) await f.cmd("carton.close", {
    cartonId: box.id, items: box.items.map(({ id, qty }) => ({ id, qty })),
  });
  const { dispatchId } = await f.cmd("dispatch.create", { cartonIds: [first.id, second.id] });
  const departure = await f.cmd("dispatch.send", { dispatchId, confirmed: true, cartonIds: [first.id] });
  const [sentId] = departure.dispatchIds as string[];
  const afterDeparture = await rows([root, other]);
  const report = afterDeparture.rows.find((row) => row.supplyId === root && row.store === "1")!;
  assert.equal(report.packed, 40);
  assert.equal(report.sent, 8);
  assert.deepEqual(report.sentCartons, [{ id: first.id, label: first.label, qty: 8 }]);
  assert.deepEqual(report.cartons, [
    { id: second.id, label: second.label, qty: 12, state: "closed", prepared: true },
    { id: open.id, label: open.label, qty: 9, state: "open", prepared: false },
  ]);
  assert(afterDeparture.rows.filter((row) => row !== report).every((row) => row.sent === 0 && row.cartons.length === 0));

  await f.cmd("dispatch.returnCarton", { cartonId: first.id, dispatchId: sentId, confirmed: true });
  assert.equal((await rows()).rows[0].sent, 0);
  assert.deepEqual((await rows()).rows[0].sentCartons, []);
  assert((await rows()).rows[0].cartons.some((box) => box.id === first.id && box.state === "closed" && !box.prepared));
  await f.cmd("dispatch.cancel", { dispatchId });
  assert((await rows()).rows[0].cartons.some((box) => box.id === second.id && !box.prepared));
  const next = await f.cmd("dispatch.create", { cartonIds: [first.id] });
  await f.cmd("dispatch.send", { dispatchId: next.dispatchId, confirmed: true });
  assert.equal((await rows()).rows[0].sent, 8);

  db.sqlite.prepare("update av2_dispatches set sent_payload=null where id=?").run(String(next.dispatchId));
  const legacy = (await rows()).rows[0];
  assert.equal(legacy.sent, null);
  assert.deepEqual(legacy.sentCartons, []);
  assert(!legacy.cartons.some((box) => box.id === first.id));
});

test("Служебная сверка принимает только подписанный запрос и проверяет список поставок", async (t) => {
  const db = await openDatabase();
  t.after(() => db.sqlite.close());
  await bootstrap(db);
  const path = "/api/ritm/dispatch-report";
  const secret = "a8".repeat(32);
  const ownerId = "test-owner";
  type Value = string | number | null;
  type Results = { results: Record<string, unknown>[] };
  type Prepared = {
    bind(...args: Value[]): Prepared;
    all(): Promise<Results>;
    execute(): Results;
  };
  const prepare = (sql: string, args: Value[] = []): Prepared => {
    const execute = () => ({ results: db.sqlite.prepare(sql).all(...args) });
    return { bind: (...next) => prepare(sql, next), all: async () => execute(), execute };
  };
  const env: Env = {
    RITM_ASSEMBLY_V2_FEED_SECRET: secret,
    AV2_OWNER_USER_ID: ownerId,
    DB: {
      prepare,
      async batch(statements: Prepared[]) {
        db.sqlite.exec("BEGIN");
        try {
          const results = statements.map((statement) => statement.execute());
          db.sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          db.sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  const request = async (supplyIds: unknown) => {
    const body = JSON.stringify({ supplyIds });
    const at = String(Date.now()), nonce = crypto.randomUUID();
    const signature = await hmac(secret,
      JSON.stringify([1, "POST", path, at, nonce, await digest(body)]));
    return new Request("https://assembly.test" + path, { method: "POST", body, headers: {
      "x-assembly-v2-at": at, "x-assembly-v2-nonce": nonce, "x-assembly-v2-signature": signature,
    } });
  };
  const signed = await request([fixture.externalId]);
  const serve = (r: Request) => worker.fetch(r, env);
  assert.equal((await serve(new Request(signed.clone(), {
    body: JSON.stringify({ supplyIds: ["other"] }),
  }))).status, 401);
  const count = await db.revision();
  assert.equal((await serve(new Request(signed.clone(), {
    headers: { "oai-authenticated-user-id": ownerId },
  }))).status, 403);
  assert.equal((await serve(await request([]))).status, 400);
  assert.equal((await serve(await request(["same", "same"]))).status, 400);
  const result = await serve(signed.clone());
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal((await result.json()).rows.length, 3);
  assert.equal((await serve(signed)).status, 409);
  assert.equal(await db.revision(), count);
});
