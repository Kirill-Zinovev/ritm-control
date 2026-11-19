import test from "node:test";
import assert from "node:assert/strict";
import { LocalD1 } from "./helpers/d1-sqlite.mjs";
import { cloudSchemaStatements } from "./helpers/cloud-schema.mjs";
import { CloudStore } from "../worker/cloud/store.js";
import {
  eventSignature,
  receiveAssemblyV2Events,
  readAssemblyV2Events,
  overlayAssemblyV2,
  overlayPrintingV2,
  applyNormRepairs,
} from "../worker/cloud/assemblyV2Events.js";
import {
  drainAssemblyV2,
  supplyDeliveryJob,
  queueSnapshotDelivery,
} from "../worker/cloud/assemblyV2Delivery.js";
import { bindings } from "./cloud-env.mjs";
import { summarizeAssembly } from "../worker/assembly.js";
const secret = "ab".repeat(32),
  root = "RITM-ROLL-10",
  position = root + "|uid:one|SKU";
function fixture() {
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(";\n"));
  return { db, store: new CloudStore(db) };
}
const work = {
  id: "av2:00000000-0000-4000-8000-000000000001",
  kind: "work",
  eventId: "av2:00000000-0000-4000-8000-000000000001",
  shipmentId: root,
  positionId: position,
  sku: "SKU",
  employeeId: "emp-001",
  employee: "Тестовый сборщик",
  operation: "packing",
  qty: 12,
  coefficient: null,
  norm: null,
  createdAt: "2026-11-14T06:00:00Z",
};
function signed(events) {
  const path = "/api/assembly-v2/events",
    body = JSON.stringify({ format: "assembly-v2-events", version: 1, events }),
    at = String(Date.now()),
    nonce = crypto.randomUUID();
  return new Request("https://ritm.test" + path, {
    method: "POST",
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
    body,
  });
}

test("исправление отсутствующей нормы сохраняется отдельно от работы; повтор не удваивает количество и не меняет известные коэффициенты",async t=>{
  const {db,store}=fixture();t.after(()=>db.db.close());
  const repair={id:"av2:norm:00000000-0000-4000-8000-000000000011",kind:"norm",eventId:work.eventId,
    shipmentId:root,positionId:position,sku:"SKU",employeeId:work.employeeId,operation:"packing",qty:12,
    norm:"600",coefficient:"0.02",productType:"Наклейки",originalCreatedAt:work.createdAt,createdAt:"2026-11-14T07:00:00Z"};
  await receiveAssemblyV2Events(signed([work,repair]),{RITM_ASSEMBLY_V2_FEED_SECRET:secret},store);
  await receiveAssemblyV2Events(signed([work,repair]),{RITM_ASSEMBLY_V2_FEED_SECRET:secret},store);
  const events=await readAssemblyV2Events(store);assert.equal(events.length,2);
  const snapshot={events:[],recordsBySource:{fbo:[]},sources:{assembly:{status:"available"}}};
  const result=overlayAssemblyV2(snapshot,events);assert.equal(result.events.length,1);assert.equal(result.events[0].quantity,12);
  assert.equal(result.events[0].norm,600);assert.equal(result.events[0].coefficient,0.02);assert.equal(result.sources.assembly.normRepairsApplied,1);
  assert.deepEqual(result.sources.assembly.normRepairsUnresolved,[]);
  const frozen={...result.events[0],norm:500,coefficient:0.024};
  const untouched=applyNormRepairs([frozen],events);assert.equal(untouched.records[0],frozen);assert.equal(untouched.unresolved.length,1);
  const changed={...result.events[0],norm:null,coefficient:null,quantity:13};
  const rejected=applyNormRepairs([changed],events);assert.equal(rejected.records[0],changed);assert.equal(rejected.unresolved.length,1);
  await assert.rejects(receiveAssemblyV2Events(signed([{...repair,id:"av2:norm:00000000-0000-4000-8000-000000000012",coefficient:1}]),{RITM_ASSEMBLY_V2_FEED_SECRET:secret},store),/расчёт нормы/);
});

test("норма старого события исправляет тот же WorkLog ID без добавления работы; отмена остаётся сильнее исправления",()=>{
  const oldId="00000000-0000-4000-8000-000000000021";
  const old={eventId:oldId,shipmentId:root,positionId:position,article:"SKU",employeeId:work.employeeId,employee:work.employee,
    operationId:"packing",quantity:12,norm:null,coefficient:null,createdAt:work.createdAt,date:"2026-11-14"};
  const repair={id:"av2:norm:00000000-0000-4000-8000-000000000022",kind:"norm",eventId:oldId,
    shipmentId:root,positionId:position,sku:"SKU",employeeId:work.employeeId,operation:"packing",qty:12,norm:"600",coefficient:"0.02",originalCreatedAt:work.createdAt};
  const snapshot={events:[old],recordsBySource:{fbo:[]},sources:{assembly:{status:"available"}}};
  const corrected=overlayAssemblyV2(snapshot,[repair]);assert.equal(corrected.events.length,1);assert.equal(corrected.events[0].eventId,oldId);assert.equal(corrected.events[0].coefficient,0.02);assert.equal(old.coefficient,null);
  const canceled=overlayAssemblyV2(snapshot,[repair,{kind:"cancel",eventId:oldId}]);assert.equal(canceled.events.length,0);assert.deepEqual(canceled.sources.assembly.normRepairsUnresolved,[]);
});
test("свежий проверенный снимок доставляется без повторного чтения Google из-за времени постановки в очередь", async (t) => {
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(";\n"));
  t.after(() => db.db.close());
  let now = Date.now();
  const store = new CloudStore(db, { now: () => now });
  await store.withScope(async (s) => s.meta("migrationReady", true));
  const sheet = {
    sourceId: "roll-printing",
    sheetId: 10,
    name: "OZON ТЕСТ",
    spreadsheetId: bindings.RITM_GOOGLE_ROLL_PRINTING_ID,
  };
  const printing = {
    ok: true,
    quality: { status: "valid" },
    issues: [],
    sheets: [sheet],
    supplies: [
      {
        ...sheet,
        sheetName: sheet.name,
        row: 5,
        rawUid: "one",
        article: "SKU",
        quantity: 100,
        productName: "Тест",
        shop: "1",
        shopCatalogStatus: "matched",
      },
    ],
  };
  const capturedAt = now,
    lease = await store.acquire("refresh:printing");
  await store.saveSnapshot("printing", printing, lease, capturedAt);
  await store.release(lease);
  now += 200;
  await queueSnapshotDelivery(store, printing, capturedAt);
  let reads = 0;
  await drainAssemblyV2(
    {
      ...bindings,
      RITM_ASSEMBLY_V2_TARGET_URL:
        "https://assembly-v2.zinovevkirill234.chatgpt.site",
      RITM_ASSEMBLY_V2_TARGET_TOKEN: "test",
      RITM_ASSEMBLY_V2_FEED_SECRET: secret,
    },
    store,
    {
      refresh: async () => {
        reads++;
        throw new Error("Unnecessary source read");
      },
      fetcher: async () =>
        Response.json({
          status: "synced",
          sourceRevision: capturedAt,
          receipts: [
            {
              shipmentId: root,
              sourceRevision: capturedAt,
              groups: 1,
              positions: 1,
            },
          ],
        }),
    },
  );
  assert.equal(reads, 0);
  assert.equal(
    (
      await db
        .prepare(
          "select count(*) n from assembly_v2_supply_deliveries where delivered_at is not null",
        )
        .first()
    ).n,
    1,
  );
});
test("ручная и станочная резка в запас приходят отдельно от упаковки, не меняя поставки", async t => {
  const {db,store}=fixture();t.after(()=>db.db.close());const env={RITM_ASSEMBLY_V2_FEED_SECRET:secret};
  const taskId="00000000-0000-4000-8000-000000000041",id="av2:"+taskId;
  const cut={id,eventId:id,kind:"warehouse-work",taskId,market:"OZON",store:"1",sku:"STOCK",employeeId:"emp-cut",employee:"Резчик",
    operation:"assembly",qty:100,norm:"200",coefficient:"0.5",productType:"Наклейки",createdAt:"2026-11-16T08:00:00Z"};
  const machineId="00000000-0000-4000-8000-000000000042";
  const machine={...cut,id:"av2:"+machineId,eventId:"av2:"+machineId,taskId:machineId,operation:"cut"};
  await receiveAssemblyV2Events(signed([cut,machine]),env,store);await receiveAssemblyV2Events(signed([cut,machine]),env,store);
  const events=await readAssemblyV2Events(store);assert.equal(events.length,2);
  const base={events:[],recordsBySource:{fbo:[],assembly:[]},sources:{assembly:{status:"available"}}};
  const merged=overlayAssemblyV2(base,events);assert.equal(merged.events.length,2);
  assert(merged.events.every(e=>e.scope==="warehouse"&&e.quantity===100&&e.coefficient===0.5&&!e.shipmentId));
  const printing={supplies:[]};assert.equal(overlayPrintingV2(printing,events),printing);
  await assert.rejects(receiveAssemblyV2Events(signed([{...cut,receiptId:taskId}]),env,store),/расчёт кэфа/);
  await receiveAssemblyV2Events(signed([{id:"av2:cancel:00000000-0000-4000-8000-000000000043",kind:"cancel",eventId:id,reason:"Ошибка резки",createdAt:cut.createdAt}]),env,store);
  assert.equal(overlayAssemblyV2(base,await readAssemblyV2Events(store)).events.length,1);
  assert.equal((await db.prepare("select count(*) n from cloud_sync_events").first()).n,0);
});

test("упаковка непосредственно на склад даёт кэф один раз без фиктивной поставки; отмена сохраняет историю", async t => {
  const {db,store}=fixture();t.after(()=>db.db.close());
  const stock={id:"av2:00000000-0000-4000-8000-000000000031",eventId:"av2:00000000-0000-4000-8000-000000000031",kind:"warehouse-work",
    receiptId:"00000000-0000-4000-8000-000000000032",market:"OZON",store:"1",sku:"STOCK",employeeId:work.employeeId,employee:work.employee,
    operation:"packing",qty:200,norm:"500",coefficient:"0.4",productType:"Наклейки",createdAt:"2026-11-16T08:00:00Z"};
  const env={RITM_ASSEMBLY_V2_FEED_SECRET:secret};
  await receiveAssemblyV2Events(signed([stock]),env,store);await receiveAssemblyV2Events(signed([stock]),env,store);
  assert.equal((await readAssemblyV2Events(store)).length,1);
  const snapshot={events:[],recordsBySource:{fbo:[],assembly:[]},history:[],sources:{fbo:{status:"available"},assembly:{status:"available"}}};
  let merged=overlayAssemblyV2(snapshot,await readAssemblyV2Events(store));
  const totals=summarizeAssembly(merged.recordsBySource.assembly,"2026-11-16","day");
  assert.equal(totals[0].packed,200);assert.equal(totals[0].coefficient,0.4);
  assert.equal(merged.events[0].scope,"warehouse");assert.equal(merged.events[0].shipmentId,"");assert.equal(merged.events[0].warehouseReceiptId,stock.receiptId);
  const printing={supplies:[]};assert.equal(overlayPrintingV2(printing,[stock]),printing);
  await assert.rejects(receiveAssemblyV2Events(signed([{...stock,id:"av2:00000000-0000-4000-8000-000000000033",eventId:"av2:00000000-0000-4000-8000-000000000033",coefficient:9}]),env,store),/расчёт кэфа/);
  const cancel={id:"av2:cancel:00000000-0000-4000-8000-000000000034",kind:"cancel",eventId:stock.eventId,reason:"Ошибка количества",createdAt:"2026-11-16T09:00:00Z"};
  await receiveAssemblyV2Events(signed([cancel]),env,store);
  merged=overlayAssemblyV2(snapshot,await readAssemblyV2Events(store));assert.equal(merged.events.length,0);
  assert.equal(overlayPrintingV2(printing,[stock,cancel]),printing);
  assert.equal((await db.prepare("select count(*) n from cloud_sync_events").first()).n,0);
});

test("новая работа получает подтверждение только после сохранения; повтор, подмена и отмена не удваивают RITM", async (t) => {
  const { db, store } = fixture();
  t.after(() => db.db.close());
  const env = { RITM_ASSEMBLY_V2_FEED_SECRET: secret };
  await receiveAssemblyV2Events(signed([work]), env, store);
  await receiveAssemblyV2Events(signed([work]), env, store);
  assert.equal((await readAssemblyV2Events(store)).length, 1);
  await assert.rejects(
    receiveAssemblyV2Events(signed([{ ...work, qty: 13 }]), env, store),
    /CONFLICT/,
  );
  assert.equal((await readAssemblyV2Events(store))[0].qty, 12);
  const snapshot = {
    events: [],
    recordsBySource: { fbo: [], assembly: [] },
    history: [],
    sources: {
      fbo: { status: "available" },
      assembly: { status: "available" },
    },
  };
  let merged = overlayAssemblyV2(snapshot, await readAssemblyV2Events(store));
  let totals = summarizeAssembly(
    merged.recordsBySource.assembly,
    "2026-11-14",
    "day",
  );
  assert.equal(totals[0].packed, 12);
  assert.equal(totals[0].coefficient, null);
  const cancel = {
    id: "av2:cancel:00000000-0000-4000-8000-000000000002",
    kind: "cancel",
    eventId: work.eventId,
    reason: "Ошибка количества",
    createdAt: "2026-11-14T07:00:00Z",
  };
  await receiveAssemblyV2Events(signed([cancel]), env, store);
  merged = overlayAssemblyV2(snapshot, await readAssemblyV2Events(store));
  assert.equal(merged.events.length, 0);
  assert.equal(
    (await db.prepare("select count(*) n from cloud_sync_events").first()).n,
    0,
  );
});
test("прогресс участков учитывает обе версии один раз и отмену старого события без записи в Sheets", () => {
  const old = {
    eventId: "old",
    shipmentId: root,
    positionId: position,
    article: "SKU",
    quantity: 20,
    createdAt: "2026-11-14T05:00:00Z",
  };
  const printing = {
    supplies: [
      {
        sourceId: "roll-printing",
        sheetId: 10,
        rawUid: "one",
        row: 5,
        article: "SKU",
      },
    ],
    _assemblyStages: {
      packing: { events: [old], invalid: [] },
      cut: { events: [], invalid: [] },
      assembly: { events: [], invalid: [] },
      checkedAt: "2026-11-14T07:00:00Z",
    },
  };
  assert.equal(overlayPrintingV2(printing, [work]).supplies[0].packed, 32);
  const cancel = { kind: "cancel", eventId: "old" };
  assert.equal(
    overlayPrintingV2(printing, [work, cancel]).supplies[0].packed,
    12,
  );
  assert.equal(printing._assemblyStages.packing.events[0].quantity, 20);
});
test("отменённая тестовая упаковка не становится ни выработкой, ни готовым запасом", () => {
  const printing = {
    supplies: [{ sourceId: "roll-printing", sheetId: 10, rawUid: "one", row: 5,
      article: "SKU", quantity: 50, printProgress: 0, cutProgress: 0 }],
    _assemblyStages: {
      packing: { events: [], invalid: [] },
      cut: { events: [], invalid: [] },
      assembly: { events: [], invalid: [] },
      checkedAt: "2026-11-14T07:00:00Z",
    },
  };
  const testWork = { ...work, qty: 50 };
  const cancel = { kind: "cancel", eventId: testWork.eventId };
  assert.equal(overlayPrintingV2(printing, [testWork]).supplies[0].packed, 50);
  const corrected = overlayPrintingV2(printing, [testWork, cancel]);
  assert.equal(corrected.supplies[0].packed, 0);
  assert.equal(corrected.supplies[0].quantity, 50);
  assert.equal(corrected.supplies[0].printProgress, 0);
  assert.equal(corrected.supplies[0].cutProgress, 0);
  assert.equal(testWork.qty, 50);
});
test("подтверждённое создание атомарно формирует отдельную очередь; сбой новой версии не меняет старую", async (t) => {
  const { db, store } = fixture();
  t.after(() => db.db.close());
  await store.withScope(async (scope) => {
    scope.putOperation("production", {
      id: "00000000-0000-4000-8000-000000000001",
      shipmentId: root,
      action: "create",
      status: "writing",
    });
  });
  assert.equal(
    (
      await db
        .prepare("select count(*) n from assembly_v2_supply_deliveries")
        .first()
    ).n,
    0,
  );
  await store.withScope(async (scope) => {
    scope.putOperation("production", {
      id: "00000000-0000-4000-8000-000000000001",
      shipmentId: root,
      action: "create",
      status: "verified",
    });
    scope.saveSyncEvent({
      id: "old-delivery",
      action: "create",
      created_at: Date.now(),
      attempts: 2,
      next_attempt_at: 0,
      payload: null,
    });
  });
  const original = await db.prepare("select * from cloud_sync_events").all();
  const row = await db
    .prepare("select * from assembly_v2_supply_deliveries")
    .first();
  assert.equal(row.shipment_id, root);
  const lease = await store.acquire("refresh:printing");
  await store.saveSnapshot("printing", { supplies: [] }, lease);
  await store.release(lease);
  const env = {
    RITM_ASSEMBLY_V2_TARGET_URL:
      "https://assembly-v2.zinovevkirill234.chatgpt.site",
    RITM_ASSEMBLY_V2_TARGET_TOKEN: "synthetic-token",
    RITM_ASSEMBLY_V2_FEED_SECRET: secret,
  };
  await drainAssemblyV2(env, store, {
    fetcher: async () => new Response("failure", { status: 503 }),
  });
  let job = await db
    .prepare("select * from assembly_v2_supply_deliveries")
    .first();
  assert.equal(job.delivered_at, null);
  assert.equal(job.attempts, 1);
  await db
    .prepare("update assembly_v2_supply_deliveries set next_attempt_at=0")
    .run();
  // A 200 without a matching persisted supply receipt is also a failure.
  await drainAssemblyV2(env, new CloudStore(db), {
    fetcher: async () =>
      Response.json({
        status: "synced",
        sourceRevision: Date.now(),
        receipts: [],
      }),
  });
  job = await db.prepare("select * from assembly_v2_supply_deliveries").first();
  assert.equal(job.delivered_at, null);
  await db
    .prepare("update assembly_v2_supply_deliveries set next_attempt_at=0")
    .run();
  await drainAssemblyV2(env, new CloudStore(db), {
    fetcher: async (url, init) => {
      assert.equal(init.redirect, "manual");
      assert.ok(String(url).startsWith(env.RITM_ASSEMBLY_V2_TARGET_URL));
      return Response.json({
        status: "synced",
        sourceRevision: Date.now(),
        receipts: [
          {
            shipmentId: root,
            sourceRevision: Date.now(),
            groups: 1,
            positions: 1,
          },
        ],
      });
    },
  });
  job = await db.prepare("select * from assembly_v2_supply_deliveries").first();
  assert.ok(job.delivered_at);
  assert.equal(job.id, row.id);
  assert.deepEqual(
    await db.prepare("select * from cloud_sync_events").all(),
    original,
  );
});

test('an unresolved old identity cannot discard a newer confirmed supply receipt', async t => {
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(';\n'));
  t.after(() => db.close());
  const now = Date.now(), store = new CloudStore(db,{now:()=>now});
  const old = 'RITM-ROLL-123', current = 'RITM-SUPPLY-00000000-0000-4000-8000-000000000099';
  for (const [id,shipment] of [['old',old],['current',current]])
    await db.prepare('INSERT INTO assembly_v2_supply_deliveries(id,shipment_id,created_at) VALUES(?,?,?)').bind(id,shipment,now).run();
  const lease = await store.acquire('refresh:printing');
  await store.saveSnapshot('printing',{ok:true,supplies:[]},lease);
  await store.release(lease);
  const env = {RITM_ASSEMBLY_V2_TARGET_URL:'https://assembly-v2.zinovevkirill234.chatgpt.site',RITM_ASSEMBLY_V2_TARGET_TOKEN:'synthetic-token',RITM_ASSEMBLY_V2_FEED_SECRET:secret};
  let syncs = 0;
  await drainAssemblyV2(env,store,{fetcher:async (url,init) => {
    if (new URL(url).pathname === '/api/ritm/deliver') return Response.json({ok:true});
    syncs++;
    assert.deepEqual(JSON.parse(init.body).expectedShipmentIds.sort(),[old,current].sort());
    return Response.json({status:'partial',sourceRevision:now,receipts:[{shipmentId:current,sourceRevision:now,groups:1,positions:44}]});
  }});
  assert.equal(syncs,1);
  const rows = db.db.prepare('SELECT * FROM assembly_v2_supply_deliveries ORDER BY id').all();
  assert.equal(rows.find(r=>r.id==='current').delivered_at,now);
  assert.equal(rows.find(r=>r.id==='old').delivered_at,null);
  assert.equal(rows.find(r=>r.id==='old').attempts,1);
  assert.equal(rows.find(r=>r.id==='current').last_error,null);
  assert.equal(db.db.prepare('SELECT count(*) n FROM cloud_operations').get().n,0);
});

test("a targeted deletion needs the exact Assembly roster, not a matching row count", async t => {
  const { db } = fixture();
  t.after(() => db.close());
  let now = Date.now();
  const store = new CloudStore(db, { now: () => now });
  await store.withScope(scope => scope.meta("migrationReady", true));
  const sheet = {
    sourceId: "roll-printing", sheetId: 10, name: "OZON ТЕСТ",
    spreadsheetId: bindings.RITM_GOOGLE_ROLL_PRINTING_ID,
  };
  const live = {
    ok: true, quality: { status: "valid" }, issues: [], sheets: [sheet],
    supplies: [{ ...sheet, sheetName: sheet.name, row: 5, rawUid: "one",
      article: "SKU", quantity: 100, productName: "Тест", shop: "1", shopCatalogStatus: "matched" }],
  };
  const revision = now;
  const lease = await store.acquire("refresh:printing");
  await store.saveSnapshot("printing", live, lease, revision);
  await store.release(lease);
  const job = "roll:test-delete";
  await db.prepare("INSERT INTO assembly_v2_supply_deliveries(id,shipment_id,created_at) VALUES(?,?,?)")
    .bind(job, root, revision).run();
  const env = { ...bindings, RITM_ASSEMBLY_V2_TARGET_URL: "https://assembly-v2.zinovevkirill234.chatgpt.site",
    RITM_ASSEMBLY_V2_TARGET_TOKEN: "test", RITM_ASSEMBLY_V2_FEED_SECRET: secret };
  const sync = positionIds => drainAssemblyV2(env, store, { fetcher: async (url, request) => {
    if (new URL(url).pathname === "/api/ritm/deliver") return Response.json({ok:true});
    assert.deepEqual(JSON.parse(request.body).expectedShipmentIds, [root]);
    assert.equal(JSON.parse(request.body).includePositionIds, true);
    return Response.json({
      status: "synced", sourceRevision: revision,
      receipts: [{ shipmentId: root, sourceRevision: revision, groups: 1, positions: 1 }],
      positionReceipts: [{ shipmentId: root, sourceRevision: revision, positionIds }],
    });
  }});
  const delivery = () => db.db.prepare("SELECT * FROM assembly_v2_supply_deliveries WHERE id=?").get(job);
  await sync([position.replace("one", "removed")]);
  assert.equal(delivery().delivered_at, null);
  now = delivery().next_attempt_at;
  await sync([position]);
  assert.equal(delivery().delivered_at, now);
  assert.deepEqual(JSON.parse(delivery().receipt).positionReceipt.positionIds, [position]);
});

test("deleting a whole shipment waits for its empty active roster in Assembly", async t => {
  const { db } = fixture();
  t.after(() => db.close());
  const now = Date.now(), store = new CloudStore(db, { now: () => now });
  await store.withScope(scope => scope.meta("migrationReady", true));
  const job = supplyDeliveryJob("production", {id:"delete-shipment",action:"deleteSupply",status:"verified",shipmentId:root}, now);
  assert.equal(job.shipmentId, root);
  await db.prepare("INSERT INTO assembly_v2_supply_deliveries(id,shipment_id,created_at) VALUES(?,?,?)")
    .bind(job.id, root, now).run();
  const lease = await store.acquire("refresh:printing");
  await store.saveSnapshot("printing",{ok:true,quality:{status:"valid"},issues:[],supplies:[],sheets:[]},lease,now);
  await store.release(lease);
  const env = { ...bindings, RITM_ASSEMBLY_V2_TARGET_URL:"https://assembly-v2.zinovevkirill234.chatgpt.site",
    RITM_ASSEMBLY_V2_TARGET_TOKEN:"test", RITM_ASSEMBLY_V2_FEED_SECRET:secret };
  await drainAssemblyV2(env, store, {fetcher:async (url, request) => {
    if (new URL(url).pathname === "/api/ritm/deliver") return Response.json({ok:true});
    assert.deepEqual(JSON.parse(request.body).expectedShipmentIds, [root]);
    return Response.json({status:"synced",sourceRevision:now,receipts:[],
      positionReceipts:[{shipmentId:root,sourceRevision:now,positionIds:[]}]});
  }});
  assert.equal(db.db.prepare("SELECT delivered_at FROM assembly_v2_supply_deliveries WHERE id=?").get(job.id).delivered_at, now);
});
