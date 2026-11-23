import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { bindings } from "./cloud-env.mjs";
import { cloudSchemaStatements } from "./helpers/cloud-schema.mjs";
import { feedSignature } from "../worker/cloud/assemblyV2Feed.js";
import { eventSignature } from "../worker/cloud/assemblyV2Events.js";

test("compiled Workers receives v2 work into D1 and exposes the same facts in reports and production progress without Google writes", async () => {
  const secret = "ab".repeat(32);
  let outbound = 0;
  const mf = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(
      new URL("../dist/server/index.js", import.meta.url),
    ),
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
    bindings: {
      ...bindings,
      RITM_OWNER_USER_IDS: "test-owner",
      RITM_GOOGLE_READER_JSON: "{}",
      RITM_ASSEMBLY_V2_FEED_SECRET: secret,
    },
    outboundService: async () => {
      outbound++;
      throw new Error("Network forbidden");
    },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of cloudSchemaStatements()) await db.prepare(sql).run();
    const now = Date.now();
    await db
      .prepare(
        "insert into cloud_state(key,value,updated_at) values('migrationReady','true',?)",
      )
      .bind(now)
      .run();
    const day = "2026-11-14",
      event = {
        id: "av2:00000000-0000-4000-8000-000000000009",
        kind: "work",
        eventId: "av2:00000000-0000-4000-8000-000000000009",
        shipmentId: "RITM-ROLL-10",
        positionId: "RITM-ROLL-10|uid:one|SKU",
        sku: "SKU",
        employeeId: "emp-001",
        employee: "Тестовый сборщик",
        operation: "packing",
        qty: 12,
        createdAt: day + "T06:00:00Z",
        coefficient: null,
      };
    const old = {
      eventId: "old",
      shipmentId: "RITM-ROLL-10",
      positionId: event.positionId,
      article: "SKU",
      quantity: 20,
      createdAt: day + "T05:00:00Z",
    };
    const cache = async (kind, value) => {
      const payload = JSON.stringify(value);
      await db
        .prepare(
          "insert into cloud_snapshots(kind,generation,updated_at,chunks,digest) values(?,?,?,1,?)",
        )
        .bind(
          kind,
          "test",
          now,
          createHash("sha256").update(payload).digest("hex"),
        )
        .run();
      await db
        .prepare(
          "insert into cloud_snapshot_chunks(kind,generation,ordinal,payload) values(?,?,0,?)",
        )
        .bind(kind, "test", payload)
        .run();
    };
    await cache("printing", {
      ok: true,
      quality: { status: "valid" },
      sheets: [],
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
        checkedAt: day + "T06:00:00Z",
      },
    });
    await cache("assembly", {
      ok: true,
      date: day,
      events: [],
      history: [],
      recordsBySource: { fbo: [], assembly: [] },
      sources: {
        fbo: {
          status: "available",
          currentStatus: "available",
          historyStatus: "available",
        },
        assembly: { status: "available" },
      },
    });
    const refreshPath = "/api/assembly-v2/refresh", refreshBody = "{}",
      refreshAt = String(Date.now()), refreshNonce = crypto.randomUUID();
    const refreshHeaders = {"content-type":"application/json","x-assembly-v2-at":refreshAt,
      "x-assembly-v2-nonce":refreshNonce,"x-assembly-v2-signature":eventSignature(secret,{path:refreshPath,at:refreshAt,nonce:refreshNonce,body:refreshBody})};
    assert.equal((await mf.dispatchFetch("https://ritm.test"+refreshPath,{method:"POST",body:refreshBody})).status,403);
    const refreshResponse = await mf.dispatchFetch("https://ritm.test"+refreshPath,{method:"POST",body:refreshBody,headers:refreshHeaders});
    assert.equal(refreshResponse.status,200);assert.deepEqual(await refreshResponse.json(),{ok:true,refreshed:false});
    assert.equal((await mf.dispatchFetch("https://ritm.test"+refreshPath,{method:"POST",body:refreshBody,headers:refreshHeaders})).status,409);
    const send = async (events) => {
      const path = "/api/assembly-v2/events",
        body = JSON.stringify({
          format: "assembly-v2-events",
          version: 1,
          events,
        }),
        at = String(Date.now()),
        nonce = crypto.randomUUID();
      return mf.dispatchFetch("https://ritm.test" + path, {
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
    };
    assert.equal((await send([event])).status, 200);
    assert.equal((await send([event])).status, 200);
    assert.equal(
      (
        await db
          .prepare("select count(*) n from assembly_v2_work_events")
          .first()
      ).n,
      1,
    );
    const headers = { "oai-authenticated-user-id": "test-owner" };
    let progress = await (
      await mf.dispatchFetch("https://ritm.test/api/printing", { headers })
    ).json();
    assert.equal(progress.supplies[0].packed, 32);
    assert.equal(progress._assemblyStages, undefined);
    let report = await (
      await mf.dispatchFetch("https://ritm.test/api/assembly?date=" + day, {
        headers,
      })
    ).json();
    assert.equal(report.rows[0].packed, 12);
    assert.equal(report.rows[0].coefficient, null);
    assert.equal(
      (
        await send([
          {
            id: "av2:cancel:00000000-0000-4000-8000-000000000008",
            kind: "cancel",
            eventId: event.eventId,
            reason: "Ошибка количества",
            createdAt: day + "T07:00:00Z",
          },
        ])
      ).status,
      200,
    );
    progress = await (
      await mf.dispatchFetch("https://ritm.test/api/printing", { headers })
    ).json();
    assert.equal(progress.supplies[0].packed, 20);
    await db.prepare("update cloud_snapshots set updated_at=? where kind='printing'").bind(now-310000).run();
    const firstView = await (await mf.dispatchFetch("https://ritm.test/api/printing?view=last-confirmed",{headers})).json();
    assert.equal(firstView.stale,true);
    assert.equal(firstView.refreshOnOpen,true);
    assert.equal(firstView.supplies[0].packed,20);
    report = await (
      await mf.dispatchFetch("https://ritm.test/api/assembly?date=" + day, {
        headers,
      })
    ).json();
    assert.equal(report.rows.length, 0);
    assert.equal(
      (await db.prepare("select count(*) n from cloud_sync_events").first()).n,
      0,
    );
    assert.equal(outbound, 0);
  } finally {
    await mf.dispose();
  }
});
test("compiled Workers/D1 feed authenticates its isolated key and performs no Google, queue or notification writes", async () => {
  const secret = "ef".repeat(32);
  let outbound = 0;
  const mf = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(
      new URL("../dist/server/index.js", import.meta.url),
    ),
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
    bindings: {
      ...bindings,
      RITM_OWNER_USER_IDS: "test-owner",
      RITM_GOOGLE_READER_JSON: "{}",
      RITM_ASSEMBLY_V2_FEED_SECRET: secret,
    },
    outboundService: async () => {
      outbound++;
      throw new Error("Network forbidden");
    },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of cloudSchemaStatements()) await db.prepare(sql).run();
    const now = Date.now();
    const sheet = {
      sourceId: "roll-printing",
      sheetId: 10,
      name: "OZON ТЕСТ",
      spreadsheetId: bindings.RITM_GOOGLE_ROLL_PRINTING_ID,
    };
    const payload = JSON.stringify({
      ok: true,
      quality: { status: "valid" },
      issues: [],
      sheets: [sheet],
      supplies: [
        {
          ...sheet,
          sheetName: sheet.name,
          row: 5,
          rawUid: "TEST-UID",
          article: "TEST-SKU",
          quantity: 100,
          productName: "Тест",
          shop: "1",
          shopCatalogStatus: "matched",
        },
      ],
    });
    await db
      .prepare(
        "insert into cloud_state(key,value,updated_at) values('migrationReady','true',?)",
      )
      .bind(now)
      .run();
    await db
      .prepare(
        "insert into cloud_snapshots(kind,generation,updated_at,chunks,digest) values('printing','test',?,1,?)",
      )
      .bind(now, createHash("sha256").update(payload).digest("hex"))
      .run();
    await db
      .prepare(
        "insert into cloud_snapshot_chunks(kind,generation,ordinal,payload) values('printing','test',0,?)",
      )
      .bind(payload)
      .run();
    const path = "/api/assembly-v2/feed";
    assert.equal(
      (await mf.dispatchFetch("https://ritm.test" + path)).status,
      403,
    );
    assert.equal(
      (await mf.dispatchFetch("https://ritm.test/api/printing")).status,
      401,
    );
    const at = String(Date.now()),
      nonce = "00000000-0000-4000-8000-000000000001";
    const r = await mf.dispatchFetch("https://ritm.test" + path, {
      headers: {
        "x-assembly-v2-at": at,
        "x-assembly-v2-nonce": nonce,
        "x-assembly-v2-signature": feedSignature(secret, { path, at, nonce }),
      },
    });
    const feed = await r.json();
    assert.equal(r.status, 200, JSON.stringify(feed));
    assert.equal(feed.supplies[0].shipmentId, "RITM-ROLL-10");
    assert.equal(
      feed.supplies[0].positions[0].positionId,
      "RITM-ROLL-10|uid:TEST-UID|TEST-SKU",
    );
    assert.equal(outbound, 0);
    assert.equal(
      (await db.prepare("select count(*) n from cloud_sync_events").first()).n,
      0,
    );
    assert.equal(
      (await db.prepare("select count(*) n from cloud_operations").first()).n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});
