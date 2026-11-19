import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { openDatabase } from "../server/local-db";
import { syncRitm, ritmApi } from "../server/ritm-api";
import type { RitmFeed, RitmSupply, RitmPosition } from "../shared/ritm";
import type { CatalogEntry } from "../shared/catalog";
import type { Snapshot } from "../shared/model";
import { fixture } from "./fixtures";
const id = "RITM-SUPPLY-00000000-0000-4000-8000-000000000001";
const env = {
  RITM_ASSEMBLY_V2_FEED_URL:
    "https://ritm-erp.zinovevkirill234.chatgpt.site/api/assembly-v2/feed",
  RITM_ASSEMBLY_V2_FEED_SECRET: "ab".repeat(32),
};
const position = (
  sku: string,
  sourceId: RitmPosition["sourceId"] = "roll-printing",
  store = "",
): RitmPosition => ({
  positionId: `${id}|${sourceId === "box-printing" ? "box:11|" : ""}uid:TEST-${sku}|${sku}`,
  sku,
  name: sku,
  quantity: 100,
  sourceId,
  sheetId: sourceId === "box-printing" ? 11 : 10,
  row: 5,
  rawUid: `TEST-${sku}`,
  store,
  storeStatus: store ? "matched" : "missing",
});
const source = (): RitmSupply => ({
  shipmentId: id,
  title: "OZON ТЕСТ · Москва",
  market: "OZON",
  locked: false,
  positions: [
    position("SKU-A"),
    position("SKU-A", "box-printing"),
    position("SKU-B"),
  ],
});
function feed(supplies: RitmSupply[], revision = Date.now()): RitmFeed {
  return {
    format: "ritm-assembly-v2",
    version: 1,
    sourceRevision: revision,
    sourceAt: new Date(revision).toISOString(),
    activeShipmentIds: supplies.map((s) => s.shipmentId),
    supplies,
    issues: [],
  };
}
function catalog(sku: string, store: string, norm = 100): CatalogEntry {
  return {
    id: JSON.stringify(["OZON", store, sku]),
    market: "OZON",
    store,
    sku,
    aliases: [sku],
    name: sku,
    barcode: "0012345678901",
    kind: "Наклейки",
    category: "Наклейки",
    machine: "2-GO",
    packaging: "П.17х22",
    size: "А5",
    sheetsPerUnit: "1",
    printFolder: "",
    catalogDepartment: "",
    boxType: "М",
    unitsPerBox: norm,
    rollMultiplicity: "",
    xeroxMultiplicity: "",
    capacitySource: "consistent",
    photoId: null,
    issues: [],
    rows: [],
  };
}
async function context(
  entries = [catalog("SKU-A", "1"), catalog("SKU-B", "2", 200)],
) {
  const db = await openDatabase();
  db.sqlite
    .prepare(
      "insert into av2_catalog_imports(id,manifest,state,created_at,actor) values('TEST-CATALOG','{}','active',?,'test')",
    )
    .run(new Date().toISOString());
  db.sqlite
    .prepare(
      "insert into av2_meta(id,revision,active_catalog_id) values(1,0,'TEST-CATALOG')",
    )
    .run();
  for (const e of entries) {
    db.sqlite
      .prepare(
        "insert into av2_catalog_entries(id,import_id,entry_id,market,store,sku,search,machine,review,data) values(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        e.id,
        "TEST-CATALOG",
        e.id,
        e.market,
        e.store,
        e.sku,
        e.sku,
        e.machine,
        0,
        JSON.stringify(e),
      );
    db.sqlite
      .prepare(
        "insert into av2_catalog_aliases(id,import_id,market,store,alias,entry_id,is_primary) values(?,?,?,?,?,?,1)",
      )
      .run(e.id, "TEST-CATALOG", e.market, e.store, e.sku, e.id);
  }
  let current = feed([source()]),
    requests = 0;
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    assert.equal(String(url), env.RITM_ASSEMBLY_V2_FEED_URL);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    const h = new Headers(init?.headers),
      at = h.get("x-assembly-v2-at")!,
      nonce = h.get("x-assembly-v2-nonce")!;
    assert.equal(
      h.get("x-assembly-v2-signature"),
      createHmac("sha256", env.RITM_ASSEMBLY_V2_FEED_SECRET)
        .update(JSON.stringify([1, "GET", "/api/assembly-v2/feed", at, nonce]))
        .digest("hex"),
    );
    return new Response(JSON.stringify(current), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const sync = (force = true) => syncRitm(db.store, db, env, { force, fetcher });
  const state = (supply?: string) =>
    db.snapshot(supply ?? null) as Promise<Snapshot>;
  const cmd = (action: string, payload: Record<string, unknown>) =>
    db.command(action, payload, crypto.randomUUID(), "test-owner");
  return {
    db,
    sync,
    state,
    cmd,
    setFeed: (next: RitmFeed) => {
      current = next;
    },
    requests: () => requests,
  };
}

test("unchanged complete feed skips writes; conflicting content still reaches revision validation", async t => {
  const c = await context(); t.after(() => c.db.sqlite.close());
  const current = feed([source()]); c.setFeed(current);
  assert.equal((await c.sync()).status, "synced");
  const writes: string[] = [];
  const batch = c.db.store.batch.bind(c.db.store);
  c.db.store.batch = async statements => { writes.push(...statements.map(s=>s.sql)); await batch(statements); };
  c.db.sqlite.exec("update av2_ritm_sync set checked_at=0");
  await c.sync(false);
  assert.ok(writes.length > 0);
  assert.ok(writes.every(sql=>sql.includes("av2_ritm_sync")), writes.join("\n"));
  c.setFeed({...current,supplies:current.supplies.map(s=>({...s,positions:s.positions.map(p=>({...p,quantity:120}))}))});
  c.db.sqlite.exec("update av2_ritm_sync set checked_at=0");
  assert.equal((await c.sync(false)).status, "partial");
  assert.ok((await c.state()).positions.every(p=>p.plan===100));
  c.setFeed(feed(current.supplies.map(s=>({...s,positions:s.positions.map(p=>({...p,quantity:120}))})),current.sourceRevision+1));
  c.db.sqlite.exec("update av2_ritm_sync set checked_at=0");
  assert.equal((await c.sync(false)).status,"synced");
  assert.ok((await c.state()).positions.every(p=>p.plan===120));
});
test("twelve collectors recover a stale RITM source via one signed refresh without duplicating positions or work", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await c.sync();
  let reads = 0,
    refreshes = 0,
    refreshed = false;
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/assembly-v2/refresh") {
      refreshes++;
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.body, "{}");
      const headers = new Headers(init?.headers),
        at = headers.get("x-assembly-v2-at"),
        nonce = headers.get("x-assembly-v2-nonce");
      const { createHash } = await import("node:crypto");
      assert.equal(
        headers.get("x-assembly-v2-signature"),
        createHmac("sha256", env.RITM_ASSEMBLY_V2_FEED_SECRET)
          .update(
            JSON.stringify([
              1,
              "POST",
              path,
              at,
              nonce,
              createHash("sha256").update("{}").digest("hex"),
            ]),
          )
          .digest("hex"),
      );
      refreshed = true;
      return new Response(JSON.stringify({ ok: true, refreshed: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(path, "/api/assembly-v2/feed");
    assert.equal(init?.method, "GET");
    reads++;
    return new Response(
      JSON.stringify(
        refreshed
          ? feed([source()])
          : {
              ok: false,
              error: "assembly_v2_source_stale",
              message: "Источник устарел.",
            },
      ),
      {
        status: refreshed ? 200 : 409,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      syncRitm(c.db.store, c.db, env, { force: true, fetcher }),
    ),
  );
  assert.equal(reads, 2);
  assert.equal(refreshes, 1);
  assert.equal((await syncRitm(c.db.store, c.db, env)).status, "synced");
  assert.equal(
    c.db.sqlite.prepare("select count(*) n from av2_positions").get()!.n,
    3,
  );
  assert.equal(
    c.db.sqlite.prepare("select count(*) n from av2_work").get()!.n,
    0,
  );
});

test("source refresh failure preserves facts; busy or held feeds cannot trigger a refresh", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await c.sync();
  const before = await c.state();
  for (const code of ["assembly_v2_source_stale", "assembly_v2_snapshot_pending", "assembly_v2_source_changed", "assembly_v2_source_busy"]) {
    let refreshes = 0;
    const fetcher = (async (url: RequestInfo | URL) => {
      if (new URL(String(url)).pathname.endsWith("/refresh")) {
        refreshes++;
        return new Response(
          JSON.stringify({ ok: false, message: "Чтение не подтверждено." }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: false,
          error: code,
          message: "Прежние данные сохранены.",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    assert.equal(
      (await syncRitm(c.db.store, c.db, env, { force: true, fetcher })).status,
      "waiting",
    );
    assert.equal(refreshes, code === "assembly_v2_source_busy" ? 0 : 1);
    assert.deepEqual((await c.state()).positions, before.positions);
  }
});

test("RITM groups two departments by exact origin while keeping stores separate and starting facts at zero", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const status = await c.sync();
  assert.equal(status.status, "synced");
  assert.equal(status.supplies, 1);
  assert.equal(status.groups, 2);
  assert.equal(status.positions, 3);
  const s = await c.state();
  assert.ok(s.supplies.every((s) => s.originShipmentId === id));
  const all = await Promise.all(s.supplies.map((s) => c.state(s.id)));
  const p = all.flatMap((s) => s.positions);
  assert.equal(new Set(p.map((p) => p.externalId)).size, 3);
  assert.ok(
    p.every(
      (p) =>
        p.packing === 0 && p.cut === 0 && p.assembly === 0 && p.boxed === 0,
    ),
  );
  assert.deepEqual(
    new Set(p.filter((p) => p.sku === "SKU-A").map((p) => p.unitsPerBox)),
    new Set([100]),
  );
});
test("twelve simultaneous clients share one source read; retry and unchanged heartbeat create no copies or work", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await Promise.all(Array.from({ length: 12 }, () => c.sync()));
  assert.equal(c.requests(), 1);
  assert.equal(
    c.db.sqlite.prepare("select count(*) n from av2_positions").get()!.n,
    3,
  );
  const before = await c.db.revision();
  c.setFeed(feed([source()], Date.now() + 10));
  await c.sync();
  assert.equal(await c.db.revision(), before);
  assert.equal(
    c.db.sqlite.prepare("select count(*) n from av2_work").get()!.n,
    0,
  );
});
test("source plan reduction and removed row preserve saved facts, carton norm, full source IDs and UUID", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await c.sync();
  let s = await c.state();
  const group = s.supplies.find((s) => s.store === "1")!;
  s = await c.state(group.id);
  const p = s.positions[0];
  await c.cmd("employee.create", { name: "Тест: Иван" });
  s = await c.state(group.id);
  const carton = String(
    (await c.cmd("carton.create", { supplyId: group.id })).cartonId,
  );
  await c.cmd("work.save", {
    positionId: p.id,
    employeeId: s.employees[0].id,
    operation: "packing",
    qty: 10,
    cartonId: carton,
  });
  const reduced = source();
  reduced.positions = reduced.positions.map((x) => ({ ...x, quantity: 5 }));
  c.setFeed(feed([reduced], Date.now() + 20));
  await c.sync();
  s = await c.state(group.id);
  assert.equal(s.positions.find((x) => x.id === p.id)!.packing, 10);
  assert.equal(s.positions.find((x) => x.id === p.id)!.plan, 5);
  assert.equal(s.cartons[0].items[0].externalSupplyId, id);
  assert.equal(s.cartons[0].items[0].externalPositionId, p.externalId);
  reduced.positions = reduced.positions.filter(
    (x) => x.positionId !== p.externalId,
  );
  c.setFeed(feed([reduced], Date.now() + 30));
  await c.sync();
  s = await c.state(group.id);
  const removed = s.positions.find((x) => x.id === p.id)!;
  assert.equal(removed.sourceActive, false);
  assert.equal(removed.ready, false);
  assert.equal(removed.packing, 10);
  assert.equal(s.cartons[0].items[0].qty, 10);
  assert.equal(s.cartons[0].items[0].unitsPerBox, 100);
  await assert.rejects(
    c.cmd("allocation.add", { positionId: p.id, cartonId: carton, qty: 1 }),
    /готовность/,
  );
});
test('an untouched unknown store can be confirmed from RITM without changing position identity',async t=>{
 const c=await context([catalog('SKU-A','1'),catalog('SKU-A','2')]);t.after(()=>c.db.sqlite.close());
 const only=source();only.positions=[position('SKU-A')];c.setFeed(feed([only]));await c.sync();
 const before=await c.state();assert.equal(before.supplies[0].store,'Не подтверждён');
 only.positions[0].store='2';only.positions[0].storeStatus='matched';c.setFeed(feed([only],Date.now()+50));
 const status=await c.sync();const after=await c.state();
 assert.equal(status.issues.length,0);assert.equal(after.supplies[0].store,'2');assert.equal(after.positions[0].id,before.positions[0].id);
 assert.equal(after.positions[0].sourceActive,true);assert.ok(after.positions[0].unitsPerBox);assert.equal(after.positions[0].packing,0);
});

test('a signed source capacity fills a previously missing box norm without adding work',async t=>{
 const c=await context([]);t.after(()=>c.db.sqlite.close());const only=source();only.positions=[position('SKU-A')];
 only.positions[0].store='2';only.positions[0].storeStatus='matched';c.setFeed(feed([only]));await c.sync();const before=await c.state();
 only.positions[0].unitsPerBox=108;c.setFeed(feed([only],Date.now()+100));await c.sync();const after=await c.state();
 assert.equal(after.positions[0].id,before.positions[0].id);assert.equal(after.positions[0].unitsPerBox,108);assert.equal(after.positions[0].packing,0);
});

test("missing or conflicting store is visible with work enabled but no boxing norm; warning persists after repeat", async (t) => {
  const c = await context([catalog("SKU-A", "1"), catalog("SKU-A", "2")]);
  t.after(() => c.db.sqlite.close());
  const only = source();
  only.positions = [position("SKU-A")];
  c.setFeed(feed([only]));
  let status = await c.sync();
  assert.equal(status.status, "partial");
  let s = await c.state();
  assert.equal(s.supplies[0].store, "Не подтверждён");
  assert.equal(s.positions[0].ready, true);
  assert.equal(s.positions[0].unitsPerBox, null);
  await c.cmd("employee.create", { name: "Тест: Иван" });
  s = await c.state();
  await c.cmd("work.save", {
    positionId: s.positions[0].id,
    employeeId: s.employees[0].id,
    operation: "packing",
    qty: 1,
  });
  c.setFeed(feed([only], Date.now() + 30));
  status = await c.sync();
  assert.equal(status.status, "partial");
  assert.ok(status.issues.length);
});
test("stale/error source preserves the last snapshot and never retires unrelated JSON supplies", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await c.sync();
  await c.cmd("supply.import", fixture as unknown as Record<string, unknown>);
  const before = await c.state();
  c.setFeed(feed([], Date.now() - 300001));
  const status = await c.sync();
  assert.equal(status.status, "waiting");
  assert.deepEqual((await c.state()).positions, before.positions);
  assert.equal(
    c.db.sqlite
      .prepare("select count(*) n from av2_supplies where source_active=1")
      .get()!.n,
    3,
  );
  c.setFeed(feed([], Date.now() + 10));
  await c.sync();
  assert.equal(
    c.db.sqlite
      .prepare(
        "select count(*) n from av2_supplies where origin_shipment_id is not null and source_active=1",
      )
      .get()!.n,
    0,
  );
  assert.equal(
    c.db.sqlite
      .prepare(
        "select source_active active from av2_supplies where external_id=?",
      )
      .get(fixture.externalId)!.active,
    1,
  );
});
test("a large group is rejected atomically without silently clipping or importing another store first", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const big = source();
  big.positions = [
    position("SKU-B"),
    ...Array.from({ length: 501 }, (_, i) => ({
      ...position("SKU-A"),
      positionId: `${id}|uid:TEST-${i}|SKU-A`,
    })),
  ];
  c.setFeed(feed([big]));
  const status = await c.sync();
  assert.equal(status.status, "partial");
  assert.match(status.issues[0].message, /500/);
  assert.equal(
    c.db.sqlite.prepare("select count(*) n from av2_supplies").get()!.n,
    0,
  );
});
test("the RITM service receipt lists only active position IDs after a removal", async t => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const original = source();
  await c.sync();
  const retained = original.positions.slice(1);
  const revision = Date.now() + 10;
  c.setFeed(feed([{ ...original, positions: retained }], revision));
  await c.sync();
  const request = () => new Request("https://assembly.test/api/ritm/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedShipmentIds: [id], includePositionIds: true }),
  });
  const receipt = await (await ritmApi(request(), c.db.store, c.db, "ritm-service", {})).json();
  assert.equal(receipt.positionReceipts.length, 1);
  assert.equal(receipt.positionReceipts[0].shipmentId, id);
  assert.equal(receipt.positionReceipts[0].sourceRevision, revision);
  assert.deepEqual(receipt.positionReceipts[0].positionIds.sort(), retained.map(p => p.positionId).sort());
  const owner = await (await ritmApi(request(), c.db.store, c.db, "owner", {})).json();
  assert.equal(owner.positionReceipts, undefined);
});

test("connection API keeps owner/origin checks and never accepts a client-provided source URL", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const unauth = await ritmApi(
    new Request("https://assembly.test/api/ritm/status"),
    c.db.store,
    c.db,
    "",
    env,
  );
  assert.equal(unauth.status, 401);
  const cross = await ritmApi(
    new Request("https://assembly.test/api/ritm/sync", {
      method: "POST",
      headers: {
        Origin: "https://evil.test",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    c.db.store,
    c.db,
    "owner",
    env,
  );
  assert.equal(cross.status, 403);
  const status = await syncRitm(
    c.db.store,
    c.db,
    {
      ...env,
      RITM_ASSEMBLY_V2_FEED_URL: "https://evil.test/api/assembly-v2/feed",
    },
    {
      fetcher: async () => {
        throw new Error("Must never fetch");
      },
    },
  );
  assert.equal(status.configured, false);
});

test("a source redirect never forwards the service signature or replaces existing supplies", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await c.sync();
  const before = await c.state();
  let requests = 0;
  const result = await syncRitm(c.db.store, c.db, env, {
    force: true,
    fetcher: async (url, init) => {
      requests++;
      assert.equal(String(url), env.RITM_ASSEMBLY_V2_FEED_URL);
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://untrusted.test/feed" },
      });
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.status, "waiting");
  assert.match(result.message, /перенаправил/);
  assert.deepEqual(await c.state(), before);
});

test("замок поставки виден в новой версии и не снимается при попытке записи", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const locked = source();
  locked.locked = true;
  c.setFeed(feed([locked]));
  await c.sync();
  const s = await c.state();
  const group = s.supplies.find((x) => x.store === "1")!;
  assert.equal(group.sourceLocked, true);
  const state = await c.state(group.id);
  assert.equal(state.positions[0].ready, false);
  await assert.rejects(
    c.cmd("work.save", {
      positionId: state.positions[0].id,
      employeeId: "any",
      operation: "packing",
      qty: 1,
    }),
    /закрыта для сборки в РИТМ/,
  );
  assert.equal((await c.state(group.id)).works.length, 0);
});
