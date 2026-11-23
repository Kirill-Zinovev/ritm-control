import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAssemblyV2Feed,
  verifyAssemblyV2Feed,
  feedSignature,
  assemblyV2Feed,
} from "../worker/cloud/assemblyV2Feed.js";
const id = "RITM-SUPPLY-00000000-0000-4000-8000-000000000001",
  now = Date.now();
const documents = {
  "roll-printing": "SYNTHETIC_ROLL_DOCUMENT_000000",
  "box-printing": "SYNTHETIC_BOX_DOCUMENT_000000",
};
test("current source photos survive missing catalog matches; unsafe image addresses do not enter the signed feed",()=>{
 const c=fixture(),photo="https://mow-basket-cdn-18.geobasket.ru/vol15564/part1556466/1556466976/images/c516x688/1.webp?123";
 c.snapshot.value.supplies[0].photoUrl=photo;
 c.snapshot.value.supplies[1].photoUrl="https://127.0.0.1/private";
 const out=buildAssemblyV2Feed({...c,now,documents,maxAgeMs:300000});
 assert.equal(out.supplies[0].positions.find(p=>p.sourceId==="roll-printing").photoUrl,photo);
 assert.equal(out.supplies[0].positions.find(p=>p.sourceId==="box-printing").photoUrl,undefined);
});
function fixture() {
  const values = new Map([
    ["migrationReady", true],
    [
      "productionSupplies",
      [
        {
          id,
          name: "OZON МОСКВА 13_11",
          parts: [
            {
              department: "roll",
              documentId: documents["roll-printing"],
              sheetId: 10,
            },
            {
              department: "box",
              documentId: documents["box-printing"],
              sheetId: 11,
            },
          ],
        },
      ],
    ],
  ]);
  const scope = {
    operations: new Map(),
    meta: (key) => values.get(key),
    syncEvents: () => [],
  };
  const sheets = ["roll-printing", "box-printing"].map((sourceId, i) => ({
    sourceId,
    sheetId: 10 + i,
    name: "OZON МОСКВА 13_11",
    spreadsheetId: documents[sourceId],
    assemblyShipmentId: id,
  }));
  const supplies = sheets.map((s) => ({
    ...s,
    sheetName: s.name,
    row: 5,
    rawUid: "same-uid",
    article: "SKU-A",
    quantity: 100,
    productName: "Тестовый товар",
    shop: "Магазин 1",
    shopCatalogStatus: "matched",
    printProgress: 100,
    cutProgress: 100,
  }));
  return {
    values,
    scope,
    snapshot: {
      at: now,
      value: {
        ok: true,
        quality: { status: "valid" },
        issues: [],
        sheets,
        supplies,
      },
    },
    now,
    documents,
  };
}
test("confirmed RITM deadlines follow shipment identity and publish deadline-only revisions", () => {
  const c = fixture();
  const readyAt = new Date(now + 86400000).toISOString();
  const packingAt = new Date(now + 172800000).toISOString();
  const shipAt = new Date(now + 259200000).toISOString();
  c.values.get("productionSupplies")[0].planning = { readyAt, packingAt, shipAt };
  c.values.get("productionSupplies")[0].name += " 🔥";
  c.snapshot.value.supplies[1].cutProgress = 25;
  const before = buildAssemblyV2Feed(c);
  assert.deepEqual(before.supplies[0].schedule, {
    readyAt, packingAt, shipAt, urgent: true, printed: true, cut: false,
  });
  c.values.set("productionPlanning", [{
    updatedAt: new Date(now + 50).toISOString(),
    deadlines: { [`shipment:${id}`]: { readyAt: null, packingAt, shipAt } },
  }]);
  const after = buildAssemblyV2Feed({ ...c, now: now + 50 });
  assert.equal(after.sourceRevision, now + 50);
  assert.equal(after.supplies[0].schedule.readyAt, null);
  assert.deepEqual(after.supplies[0].positions, before.supplies[0].positions);
});

test("feed service signature is scoped, fresh and required on the public RITM Site", () => {
  const secret = "ab".repeat(32),
    at = String(now),
    nonce = "00000000-0000-4000-8000-000000000001",
    path = "/api/assembly-v2/feed";
  const headers = {
    "x-assembly-v2-at": at,
    "x-assembly-v2-nonce": nonce,
    "x-assembly-v2-signature": feedSignature(secret, { path, at, nonce }),
  };
  verifyAssemblyV2Feed(
    new Request("https://ritm.test" + path, { headers }),
    { RITM_ASSEMBLY_V2_FEED_SECRET: secret },
    now,
  );
  assert.throws(
    () =>
      verifyAssemblyV2Feed(
        new Request("https://ritm.test" + path),
        { RITM_ASSEMBLY_V2_FEED_SECRET: secret },
        now,
      ),
    /не подтверждена/,
  );
  assert.throws(
    () =>
      verifyAssemblyV2Feed(
        new Request("https://ritm.test" + path, { headers }),
        { RITM_ASSEMBLY_V2_FEED_SECRET: secret },
        now + 120001,
      ),
    /не подтверждена/,
  );
  assert.throws(
    () =>
      verifyAssemblyV2Feed(
        new Request("https://ritm.test" + path, { method: "POST", headers }),
        { RITM_ASSEMBLY_V2_FEED_SECRET: secret },
        now,
      ),
    /Метод/,
  );
});
test("complete shared shipment preserves original IDs and two same-UID departmental positions", () => {
  const f = fixture(),
    feed = buildAssemblyV2Feed(f);
  assert.equal(feed.supplies.length, 1);
  const s = feed.supplies[0];
  assert.equal(s.shipmentId, id);
  assert.equal(s.positions.length, 2);
  assert.deepEqual(
    new Set(s.positions.map((p) => p.positionId)),
    new Set([`${id}|uid:same-uid|SKU-A`, `${id}|box:11|uid:same-uid|SKU-A`]),
  );
  assert.ok(s.positions.every((p) => p.quantity === 100));
  assert.ok(
    s.positions.every(
      (p) => !Object.hasOwn(p, "printProgress") && !Object.hasOwn(p, "packed"),
    ),
  );
  assert.equal(s.locked, false);
});
test("stale, unknown and revision-invalid snapshots never become authoritative empty feeds", () => {
  const f = fixture();
  assert.throws(
    () => buildAssemblyV2Feed({ ...f, now: now + 300000 }),
    /свежий снимок/,
  );
  f.snapshot.value.productionMoveRevision = "changed";
  assert.throws(() => buildAssemblyV2Feed(f), /после переноса/);
  f.snapshot.value.productionMoveRevision = null;
  f.values.set("migrationReady", false);
  assert.throws(() => buildAssemblyV2Feed(f), /не подтверждён/);
});
test("a missing department, invalid row or duplicate position holds the whole shared composition", () => {
  for (const change of [
    (f) => f.snapshot.value.sheets.pop(),
    (f) => {
      f.snapshot.value.supplies[0].quantity = null;
    },
    (f) => f.snapshot.value.supplies.push({ ...f.snapshot.value.supplies[0] }),
  ]) {
    const f = fixture();
    change(f);
    const feed = buildAssemblyV2Feed(f);
    assert.equal(feed.supplies.length, 0);
    assert.ok(feed.activeShipmentIds.includes(id));
    assert.ok(feed.issues.length);
  }
});
test("in-progress writes and metadata newer than the snapshot hold the source", () => {
  const f = fixture();
  f.values.set("productionSupplyOperations", [{ status: "writing" }]);
  assert.throws(() => buildAssemblyV2Feed(f), /подтверждает изменение/);
  f.values.set("productionSupplyOperations", [
    { status: "verified", updatedAt: new Date(now + 1).toISOString() },
  ]);
  assert.throws(() => buildAssemblyV2Feed(f), /ожидается обновление/);
});
test("deleted managed supplies are not resurrected from older materialized rows", () => {
  const f = fixture();
  f.values.set("productionSupplies", []);
  const feed = buildAssemblyV2Feed(f);
  assert.equal(feed.supplies.length, 0);
  assert.equal(feed.activeShipmentIds.length, 0);
});
test("a pending box removal preserves that roster while an unrelated shipment can sync", () => {
  const f = fixture();
  const adjacent = { ...f.snapshot.value.sheets[0], sheetId: 12, name: "OZON СПБ", assemblyShipmentId: null };
  f.snapshot.value.sheets.push(adjacent);
  f.snapshot.value.supplies.push({ ...f.snapshot.value.supplies[0], ...adjacent, sheetName: adjacent.name });
  f.scope.operations.set("box-position-removal:pending", {
    kind: "box-position-removal", value: { id: "pending", status: "checking", shipmentId: id, identity: {sheetId:11} },
  });
  assert.throws(() => buildAssemblyV2Feed(f), /подтверждает изменение/);
  f.snapshot.value.assemblyHeldRemovals = [{ operationId: "pending", id, sheetId: 11, name: "OZON МОСКВА" }];
  const feed = buildAssemblyV2Feed(f);
  assert.ok(feed.activeShipmentIds.includes(id));
  assert.ok(feed.issues.some(issue => issue.shipmentId === id));
  assert.deepEqual(feed.supplies.map(s => s.shipmentId), ["RITM-ROLL-12"]);
});
test("unlinked boxes require the old confirmed transfer selection; its event is never changed", () => {
  const f = fixture();
  f.values.set("productionSupplies", []);
  f.snapshot.value.sheets = f.snapshot.value.sheets
    .filter((s) => s.sourceId === "box-printing")
    .map((s) => ({ ...s, assemblyShipmentId: null }));
  f.snapshot.value.supplies = f.snapshot.value.supplies
    .filter((s) => s.sourceId === "box-printing")
    .map((s) => ({ ...s, assemblyShipmentId: null }));
  assert.equal(buildAssemblyV2Feed(f).supplies.length, 0);
  const event = {
    action: "transfer",
    outcome: "synced",
    payload: JSON.stringify({
      transfer: {
        department: "box",
        sheetId: 11,
        keys: ["uid:same-uid|SKU-A"],
      },
    }),
  };
  f.scope.syncEvents = () => [event];
  const before = JSON.stringify(event);
  assert.equal(buildAssemblyV2Feed(f).supplies[0].shipmentId, "RITM-BOX-11");
  assert.equal(JSON.stringify(event), before);
});
test("locks including pending unlock are respected without copying physical work", () => {
  const f = fixture();
  f.scope.operations.set(`production-shipment-lock:${id}`, {
    kind: "production-shipment-lock",
    value: { id, shipmentId: id, status: "unlocking" },
  });
  assert.equal(buildAssemblyV2Feed(f).supplies[0].locked, true);
});
test("the canonical unlock wins over historical physical department locks", () => {
  const f = fixture();
  for (const physical of ["RITM-ROLL-10", "RITM-BOX-11"])
    f.scope.operations.set(`production-shipment-lock:${physical}`, {
      kind: "production-shipment-lock",
      value: { id: physical, shipmentId: physical, status: "locked" },
    });
  f.scope.operations.set(`production-shipment-lock:${id}`, {
    kind: "production-shipment-lock",
    value: {
      id,
      shipmentId: id,
      status: "unlocked",
      changedAt: new Date(now - 1000).toISOString(),
    },
  });
  assert.equal(buildAssemblyV2Feed(f).supplies[0].locked, false);
});
test("canonical lock changes advance the feed independently of a printing refresh", () => {
  const f = fixture();
  f.snapshot.at = now - 2000;
  const lock = {
    id,
    shipmentId: id,
    status: "locked",
    changedAt: new Date(now - 1000).toISOString(),
  };
  f.scope.operations.set(`production-shipment-lock:${id}`, {
    kind: "production-shipment-lock",
    value: lock,
  });
  const closed = buildAssemblyV2Feed(f);
  assert.equal(closed.supplies[0].locked, true);
  assert.equal(closed.sourceRevision, now - 1000);
  lock.status = "unlocked";
  lock.changedAt = new Date(now).toISOString();
  const opened = buildAssemblyV2Feed(f);
  assert.equal(opened.supplies[0].locked, false);
  assert.equal(opened.sourceRevision, now);
  assert.equal(opened.sourceAt, new Date(now).toISOString());
});
test("an unlinked legacy shipment still uses its own canonical physical lock", () => {
  const f = fixture();
  f.snapshot.value.supplies = [f.snapshot.value.supplies[0]];
  f.snapshot.value.supplies[0].assemblyShipmentId = "";
  f.snapshot.value.sheets = [f.snapshot.value.sheets[0]];
  f.snapshot.value.sheets[0].assemblyShipmentId = "";
  f.values.set("productionSupplies", []);
  const legacy = "RITM-ROLL-10";
  f.scope.operations.set(`production-shipment-lock:${legacy}`, {
    kind: "production-shipment-lock",
    value: { id: legacy, shipmentId: legacy, status: "locked" },
  });
  assert.equal(buildAssemblyV2Feed(f).supplies[0].locked, true);
});
test("a bad supply leaf blocks its composition; an unrelated journal warning does not", () => {
  const f = fixture();
  f.snapshot.value.quality.status = "partial";
  f.snapshot.value.issues = [{ source: "Другой журнал", code: "bad" }];
  assert.equal(buildAssemblyV2Feed(f).supplies.length, 1);
  f.snapshot.value.issues = [{ source: "OZON МОСКВА 13_11", code: "bad" }];
  assert.equal(buildAssemblyV2Feed(f).supplies.length, 0);
  f.snapshot.value.issues = [{ code: "bad" }];
  assert.throws(() => buildAssemblyV2Feed(f), /неполный/);
});
test("the actual source handler only reads existing snapshots and scope", async () => {
  const f = fixture(),
    secret = "cd".repeat(32),
    path = "/api/assembly-v2/feed",
    at = String(now),
    nonce = "00000000-0000-4000-8000-000000000001";
  let reads = 0;
  const store = {
    now: () => now,
    leaseIsActive: async () => {
      reads++;
      return false;
    },
    snapshot: async () => f.snapshot,
    scope: async () => f.scope,
  };
  const b = {
    RITM_ASSEMBLY_V2_FEED_SECRET: secret,
    RITM_GOOGLE_ROLL_PRINTING_ID: documents["roll-printing"],
    RITM_GOOGLE_BOX_PRINTING_ID: documents["box-printing"],
  };
  const before = JSON.stringify([...f.values]);
  const request = new Request("https://ritm.test" + path, {
      headers: {
        "x-assembly-v2-at": at,
        "x-assembly-v2-nonce": nonce,
        "x-assembly-v2-signature": feedSignature(secret, { path, at, nonce }),
      },
    });
  const r = await assemblyV2Feed(request,b,store);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).supplies.length, 1);
  assert.equal(reads, 2);
  request.headers.set("if-none-match",r.headers.get("etag"));
  const unchanged = await assemblyV2Feed(request,b,store);
  assert.equal(unchanged.status,304);
  assert.equal(await unchanged.text(),"");
  assert.equal(reads,4);
  assert.equal(JSON.stringify([...f.values]), before);
});

test("an isolated move retains its shipment while a newly created supply reaches Assembly", () => {
  const c = fixture();
  const movedId = "RITM-ROLL-85";
  c.scope.operations.set("move", {kind:"production-department-move", value:{id:"move", status:"uncertain"}});
  assert.throws(() => buildAssemblyV2Feed(c), /подтверждает изменение/);
  c.snapshot.value.assemblyHeldMoves = [{moveId:"move",id:movedId,name:"OZON Перенос",parts:[
    {department:"roll",sheetId:85},{department:"box",sheetId:86},
  ]}];
  const feed = buildAssemblyV2Feed(c);
  assert.deepEqual(feed.supplies.map(s=>s.shipmentId), [id]);
  assert.equal(feed.supplies[0].positions.length, 2);
  assert.ok(feed.activeShipmentIds.includes(movedId));
  assert.ok(feed.issues.some(issue=>issue.shipmentId===movedId));
  c.snapshot.value.assemblyHeldMoves[0].moveId = "different-move";
  assert.throws(() => buildAssemblyV2Feed(c), /подтверждает изменение/);
});
