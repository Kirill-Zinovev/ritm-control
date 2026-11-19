import test from "node:test";
import assert from "node:assert/strict";
import { LocalD1 } from "./helpers/d1-sqlite.mjs";
import { cloudSchemaStatements } from "./helpers/cloud-schema.mjs";
import { CloudStore } from "../worker/cloud/store.js";
import { eventSignature } from "../worker/cloud/assemblyV2Events.js";
import { refreshAssemblyV2Source } from "../worker/cloud/assemblyV2Refresh.js";
import { cloudApi } from "../worker/cloud/runtime.js";
const secret = "ab".repeat(32),
  bindings = { RITM_ASSEMBLY_V2_FEED_SECRET: secret };
function signed(body = "{}") {
  const path = "/api/assembly-v2/refresh",
    at = String(Date.now()),
    nonce = crypto.randomUUID();
  return new Request("https://ritm.test" + path, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-assembly-v2-at": at,
      "x-assembly-v2-nonce": nonce,
      "x-assembly-v2-signature": eventSignature(secret, {
        path,
        at,
        nonce,
        body,
      }),
    },
  });
}
async function context(t) {
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(";\n"));
  t.after(() => db.db.close());
  const store = new CloudStore(db),
    value = { ok: true, marker: "source-original" },
    at = Date.now() - 600000;
  const save = async (time) => {
    const lease = await store.acquire("refresh:printing", 60000);
    try {
      await store.saveSnapshot("printing", value, lease, time);
    } finally {
      await store.release(lease);
    }
  };
  await save(at);
  return { db, store, value, at, save };
}
test("twelve signed stale-cache requests share one source refresh and leave old queues and operations untouched", async (t) => {
  const c = await context(t);
  let reads = 0;
  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      refreshAssemblyV2Source(signed(), bindings, c.store, async () => {
        reads++;
        await c.save(Date.now());
        return { stale: false };
      }),
    ),
  );
  assert.equal(reads, 1);
  assert(responses.every((r) => r.status === 200 || r.status === 202));
  assert(Date.now() - (await c.store.snapshot("printing")).at < 10000);
  assert.equal(
    c.db.db.prepare("select count(*) n from cloud_sync_events").get().n,
    0,
  );
  assert.equal(
    c.db.db.prepare("select count(*) n from cloud_operations").get().n,
    0,
  );
  assert.equal(
    c.db.db.prepare("select count(*) n from assembly_v2_work_events").get().n,
    0,
  );
});

test('a newly committed supply refreshes even a seconds-old printing snapshot',async t=>{
 const c=await context(t);await c.save(Date.now());
 await c.store.withScope(async s=>s.meta('productionSupplyRevision',123));
 let reads=0;
 const response=await refreshAssemblyV2Source(signed(),bindings,c.store,async()=>{
   reads++;c.value.productionSupplyRevision=123;await c.save(Date.now());return {stale:false};
 });
 assert.equal(response.status,200);assert.equal(reads,1);assert.equal((await c.store.snapshot('printing')).value.productionSupplyRevision,123);
});

test('a confirmed legacy delivery context permits cache refresh while real source writers remain fenced',async t=>{
 const c=await context(t), lease=await c.store.acquire('production');
 try {
  const scope=await c.store.scope(lease);
  scope.meta('assemblyOutboxReadLease',{version:1,owner:lease.owner,fence:lease.fence,sourceWrites:false});await scope.checkpoint();
  let reads=0;
  const response=await refreshAssemblyV2Source(signed(),bindings,c.store,async()=>{reads++;await c.save(Date.now());return {stale:false};});
  assert.equal(response.status,200);assert.equal(reads,1);assert.equal(await c.store.leaseIsActive('production'),true);
  await assert.rejects(c.store.acquire('production'),{code:'cloud_operation_busy'});
 } finally {await c.store.release(lease);}
});
test("refresh authentication, original feed signature, replay and source URL injection fail before a source read", async (t) => {
  const c = await context(t);
  let reads = 0;
  const refresh = async () => {
    reads++;
    return { stale: false };
  };
  await assert.rejects(
    refreshAssemblyV2Source(
      new Request("https://ritm.test/api/assembly-v2/refresh", {
        method: "POST",
        body: "{}",
      }),
      bindings,
      c.store,
      refresh,
    ),
    (e) => e.status === 403,
  );
  const wrong = signed();
  wrong.headers.set("x-assembly-v2-signature", "00".repeat(32));
  await assert.rejects(
    refreshAssemblyV2Source(wrong, bindings, c.store, refresh),
    (e) => e.status === 403,
  );
  await assert.rejects(
    refreshAssemblyV2Source(
      signed('{"url":"https://example.invalid"}'),
      bindings,
      c.store,
      refresh,
    ),
    (e) => e.status === 400,
  );
  await c.save(Date.now());
  const request = signed(),
    retry = request.clone();
  assert.equal(
    (await refreshAssemblyV2Source(request, bindings, c.store, refresh)).status,
    200,
  );
  await assert.rejects(
    refreshAssemblyV2Source(retry, bindings, c.store, refresh),
    (e) => e.code === "assembly_v2_replay",
  );
  assert.equal(reads, 0);
  let external = 0;
  const response = await cloudApi(
    new Request("https://ritm.test/api/assembly-v2/refresh", {
      method: "POST",
      body: "{}",
    }),
    { ...bindings, DB: c.db },
    null,
    {
      fetcher: async () => {
        external++;
        throw Error("No network");
      },
    },
  );
  assert.equal(response.status, 403);
  assert.equal(external, 0);
});
test("failed reads and active production changes retain the original cache and never acknowledge freshness", async (t) => {
  const c = await context(t);
  let reads = 0;
  await assert.rejects(
    refreshAssemblyV2Source(signed(), bindings, c.store, async () => {
      reads++;
      return { stale: true };
    }),
    (e) => e.code === "assembly_v2_refresh_unconfirmed",
  );
  assert.deepEqual(await c.store.snapshot("printing"), {
    at: c.at,
    value: c.value,
  });
  const lease = await c.store.acquire("production");
  await assert.rejects(
    refreshAssemblyV2Source(signed(), bindings, c.store, async () => {
      reads++;
    }),
    (e) => e.code === "assembly_v2_source_busy",
  );
  await c.store.release(lease);
  assert.equal(reads, 1);
});
