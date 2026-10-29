import assert from "node:assert/strict";
import { createHash as nodeHash, createHmac as nodeHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bindings } from "./cloud-env.mjs";
import { LocalD1 } from "./helpers/d1-sqlite.mjs";
import { CloudStore } from "../worker/cloud/store.js";
import { CloudSheetsReader } from "../worker/cloud/googleSheets.js";
import { requireOwner, readJson } from "../worker/cloud/access.js";
import { requireCutover, createServices } from "../worker/cloud/services.js";
import { createHash, createHmac, randomInt } from "../worker/cloud/crypto.js";
import { AssemblySyncQueue } from "../agent/assemblySync.js";
import { importMigration } from "../worker/cloud/migration.js";
import { sourceId } from "../worker/cloud/config.js";
import { digest } from "../worker/cloud/store.js";
import { cloudSchemaStatements } from "./helpers/cloud-schema.mjs";
import { cloudFetch } from "../worker/cloud/fetch.js";

const schema = cloudSchemaStatements().join(";\n");
function fixture(options = {}) { const db = new LocalD1(); db.db.exec(schema); return { db, store: new CloudStore(db, options) }; }
const env = { ...bindings, RITM_OWNER_USER_IDS: "owner-site-id" };

test("edge transport rejects unexpected redirects without using unsupported redirect:error",async()=>{
  let calls=0;const fetcher=async function(input,init){assert.equal(this,undefined);assert.equal(init.redirect,'manual');calls++;return new Response(null,{status:302,headers:{location:'https://unapproved.test/'}});};
  await assert.rejects(cloudFetch(fetcher,'https://sheets.googleapis.com/test',{redirect:'error'}),{code:'unexpected_redirect'});assert.equal(calls,1);
  assert.equal((await cloudFetch(fetcher,'https://docs.google.com/test',{redirect:'manual'})).status,302);
});

test("cloud reader calls the platform fetch without rebinding its receiver", async () => {
  let calls = 0;
  const reader = new CloudSheetsReader(env, { fetcher: async function () {
    assert.equal(this, undefined, "Workers fetch must retain its global invocation semantics"); calls++;
    return Response.json({ spreadsheetId: env.RITM_GOOGLE_CATALOG_ID, sheets: [] });
  } });
  reader.cached = { token: "synthetic-token", expires: Date.now() + 3600000 };
  await reader.get(env.RITM_GOOGLE_CATALOG_ID, { fields: "spreadsheetId,sheets.properties" });
  assert.equal(calls, 1);
});

test("portable SHA-256 and signed Assembly events match Node including Cyrillic", () => {
  for (const input of ["", "abc", "OZON МОСКВА 10_10", "😀".repeat(1000)]) {
    assert.equal(createHash("sha256").update(input).digest("hex"), nodeHash("sha256").update(input).digest("hex"));
    assert.equal(createHmac("sha256", "ab".repeat(32)).update(input).digest("hex"), nodeHmac("sha256", "ab".repeat(32)).update(input).digest("hex"));
  }
  for (let i = 0; i < 200; i++) { const value = randomInt(10000000, 2000000000); assert.ok(value >= 10000000 && value < 2000000000); }
});

test("cloud access fails closed without a trusted, explicitly allowed owner", () => {
  assert.throws(() => requireOwner(new Request("https://ritm.test/api/printing"), env), /Войдите/);
  assert.throws(() => requireOwner(new Request("https://ritm.test/api/printing", { headers: { "oai-authenticated-user-id": "stranger", "x-owner": "true" } }), env), /не настроен/);
  assert.throws(() => requireOwner(new Request("https://ritm.test/api/printing", { headers: { "oai-authenticated-user-id": "owner-site-id" } }), {}), /не настроен/);
  assert.throws(() => requireOwner(new Request("https://ritm.test/api/roll-supplies", { method: "POST", headers: { "oai-authenticated-user-id": "owner-site-id", origin: "https://attacker.test", "content-type": "application/json" } }), env, { write: true }), /странице RITM/);
});

test("oversized request is rejected before a domain operation starts", async () => {
  await assert.rejects(readJson(new Request("https://ritm.test/api/roll-supplies", { method: "POST", body: "a".repeat(100) }), 50), /Слишком большой/);
});

test("one D1 writer lease wins among 30 clients and an old fence cannot release its successor", async () => {
  let at = 1000;
  const { db, store } = fixture({ now: () => at, leaseMs: 100 });
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 30 }, () => store.acquire()));
    const success = attempts.filter((result) => result.status === "fulfilled");
    assert.equal(success.length, 1);
    const first = success[0].value;
    // acquire() clamps lease durations below one second to 1000 ms.
    at = 2001;
    const next = await store.acquire();
    assert.ok(next.fence > first.fence);
    await assert.rejects(store.renew(first), /потеряла блокировку/);
    await store.release(first);
    await store.renew(next);
  } finally { db.close(); }
});

test("operation journal survives a lost server response and retains the same event identity", async () => {
  const { db, store } = fixture();
  const id = crypto.randomUUID();
  try {
    await assert.rejects(store.withScope(async (scope) => {
      scope.meta("migrationReady", true);
      scope.beginRollSupplyOperation(id, "create", "original-hash", { name: "OZON TEST" }, new Date().toISOString());
      await scope.checkpoint();
      throw new Error("simulated response lost");
    }), /response lost/);
    await store.withScope(async (scope) => {
      const first = scope.rollSupplyOperation(id);
      assert.equal(first.status, "writing");
      assert.equal(scope.beginRollSupplyOperation(id, "create", "other-hash", {}, new Date().toISOString()).requestHash, "original-hash");
      scope.updateRollSupplyOperation(id, "uncertain", { message: "verify only" }, new Date().toISOString());
    });
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM cloud_operations").get().n, 1);
    assert.equal((await store.scope()).rollSupplyOperation(id).status, "uncertain");
  } finally { db.close(); }
});

test("production previews use expiring rows instead of a growing cloud_state cache", async () => {
  let at = 1000;
  const { db, store } = fixture({ now: () => at });
  const id = "production:" + crypto.randomUUID();
  try {
    await store.withScope(async (scope) => {
      scope.meta("productionPreviewCache", [{ payload: "legacy preview cache".repeat(5000) }]);
      scope.meta("productionPreviewCache", []);
      scope.saveTransferPreview(id, at + 600000, JSON.stringify({ id, routed: [{ article: "TEST-1", quantity: 4 }] }));
    });
    assert.equal(db.db.prepare("SELECT value FROM cloud_state WHERE key='productionPreviewCache'").get().value, "[]");
    assert.ok((await store.scope()).transferPreview(id)?.payload.includes("TEST-1"));
    at += 600001;
    await store.withScope(async () => {});
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM cloud_transfer_previews WHERE id=?").get(id).n, 0);
  } finally { db.close(); }
});

test("chunked source snapshots round-trip without truncation and detect corrupted contents", async () => {
  const { db, store } = fixture();
  const lease = await store.acquire("refresh:printing");
  try {
    const value = { ok: true, records: "русские данные ".repeat(50000), packed: 3039 };
    await store.saveSnapshot("printing", value, lease);
    assert.deepEqual((await store.snapshot("printing")).value, value);
    db.db.prepare("UPDATE cloud_snapshot_chunks SET payload='corrupt' WHERE ordinal=0").run();
    await assert.rejects(store.snapshot("printing"), /целостности/);
  } finally { await store.release(lease); db.close(); }
});

test("cloud writes require both explicit cutover and reconciliation of inherited pending operations", async () => {
  const { db, store } = fixture();
  try {
    await store.withScope(async (scope) => {
      assert.throws(() => requireCutover(env, scope), /ещё не включена/);
      scope.meta("migrationReady", true);
      scope.meta("cloudCutover", { id: "cutover-one", localWriterDisabled: true });
      const configured = { ...env, RITM_CLOUD_WRITES_ENABLED: "true", RITM_CLOUD_CUTOVER_ID: "cutover-one" };
      requireCutover(configured, scope);
      scope.meta("migrationPendingWrites", [{ id: "old-uncertain" }]);
      assert.throws(() => requireCutover(configured, scope), /незавершённые/);
    });
  } finally { db.close(); }
});

test("Assembly outbox persists one event, retries its identity and stores a matching receipt", async () => {
  const { db, store } = fixture();
  let attempts = 0;
  const id = crypto.randomUUID();
  try {
    await store.withScope(async (scope) => {
      const queue = new AssemblySyncQueue(scope, { secret: "ab".repeat(32), beforeDeliver: () => scope.checkpoint(), fetchImpl: async (_, init) => {
        attempts++; assert.ok(db.db.prepare("SELECT id FROM cloud_sync_events WHERE id=?").get(id));
        const { event } = JSON.parse(init.body); assert.equal(event.eventId, id);
        return new Response(JSON.stringify({ ok: true, eventId: id, status: "synced", added: 1 }));
      } });
      queue.schedule = () => {};
      const payload = { previewId: crypto.randomUUID(), name: "OZON TEST", transfer: { department: "box", sheetId: 10 } };
      queue.enqueueTransfer(id, payload); queue.enqueueTransfer(id, payload);
      await queue.flush();
      assert.equal(queue.state().pending, 0);
    });
    assert.equal(attempts, 1);
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM cloud_sync_events").get().n, 1);
    assert.equal((await store.scope()).syncEvent(id).outcome, "synced");
  } finally { db.close(); }
});

test("Google source allowlist and export redirect checks prevent credential forwarding", async () => {
  let calls = 0;
  const reader = new CloudSheetsReader(env, { fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://attacker.test/capture" } }); } });
  reader.cached = { token: "synthetic-access-token", expires: Date.now() + 3600000 };
  await assert.rejects(reader.authenticatedFetch("https://attacker.test/spreadsheets/d/anything/export"), /не разрешён/);
  await assert.rejects(reader.get("UNAPPROVED_DOCUMENT_000000000000", {}), /не разрешён/);
  assert.equal(calls, 0);
  await assert.rejects(reader.authenticatedFetch(`https://docs.google.com/spreadsheets/d/${bindings.RITM_GOOGLE_ROLL_PRINTING_ID}/export?format=csv&gid=1`), /ответ источника/);
  assert.equal(calls, 1);
});

async function migrationFixture() {
  const sources = Object.fromEntries(["seasonalPrintingId", "rollPrintingId", "boxPrintingId", "catalogId", "fboSourceId", "assemblyDatabaseId"].map((key) => [key, sourceId(env, key)]));
  const payload = { sources, metadata: { productionSupplies: [], productionSupplyOperations: [], rollPrintingAdditionalSheets: [{ gid: 100, name: "OZON TEST" }] }, rollOperations: [{ id: crypto.randomUUID(), action: "create", status: "verified", requestHash: "same", payload: { name: "OZON TEST" }, createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-20T10:00:00Z", result: null }], syncEvents: [], transferPreviews: [], pendingWrites: [], snapshots: [] };
  return { format: "ritm-sites-migration", version: 1, id: crypto.randomUUID(), createdAt: "2026-10-20T10:00:00Z", digest: await digest(JSON.stringify(payload)), payload };
}

test("migration verifies exact operation payloads, is idempotent and refuses foreign source IDs", async () => {
  const { db, store } = fixture();
  const input = await migrationFixture(), configured = { ...env, RITM_CLOUD_IMPORT_ENABLED: "true" };
  try {
    const receipt = await importMigration(input, configured, store);
    assert.equal(receipt.counts.rollOperations, 1);
    assert.equal((await store.scope()).meta("migrationReady"), true);
    assert.equal((await importMigration(input, configured, store)).repeated, true);
    const tampered = structuredClone(input);
    tampered.payload.rollOperations[0].payload.name = "changed";
    await assert.rejects(importMigration(tampered, configured, store), /Контрольная сумма/);
    const foreign = structuredClone(input);
    foreign.payload.sources.catalogId = "FOREIGN_DATABASE_000000000000000000";
    foreign.digest = await digest(JSON.stringify(foreign.payload));
    await assert.rejects(importMigration(foreign, configured, store), /другому набору/);
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM cloud_operations").get().n, 1);
  } finally { db.close(); }
});

test("interrupted import resumes the same snapshot without replacing or duplicating records", async () => {
  const { db, store } = fixture();
  const input = await migrationFixture(), configured = { ...env, RITM_CLOUD_IMPORT_ENABLED: "true" };
  const batch = db.batch.bind(db);
  let calls = 0;
  db.batch = async (statements) => {
    const result = await batch(statements);
    if (++calls === 3) throw new Error("simulated import connection loss after commit");
    return result;
  };
  try {
    await assert.rejects(importMigration(input, configured, store), /connection loss/);
    db.batch = batch;
    assert.equal((await store.scope()).meta("migrationReady"), false);
    const receipt = await importMigration(input, configured, store);
    assert.equal(receipt.counts.rollOperations, 1);
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM cloud_operations").get().n, 1);
    assert.equal((await store.scope()).meta("migrationReady"), true);
  } finally { db.close(); }
});

test("a pending repair in another document is preserved without blocking supply writes", async () => {
  const { db, store } = fixture();
  try {
    await store.withScope(async (scope) => {
      scope.meta("migrationReady", true);
      scope.meta("cloudCutover", { id: "cutover-one", localWriterDisabled: true });
      scope.meta("migrationPendingWrites", [{ id: "old-test", documentId: "UNRELATED_TEST_DOCUMENT_000000000000" }]);
      requireCutover({ ...env, RITM_CLOUD_WRITES_ENABLED: "true", RITM_CLOUD_CUTOVER_ID: "cutover-one" }, scope);
      assert.equal(scope.supplyWriteConflict([sourceId(env, "rollPrintingId")]), null);
    });
  } finally { db.close(); }
});

test("Google production writes checkpoint their exact operation before sending and never target Assembly or the catalog", async () => {
  const { db, store } = fixture();
  const operationId = crypto.randomUUID();
  let externalWrites = 0;
  const configured = { ...env, RITM_CLOUD_WRITES_ENABLED: "true", RITM_CLOUD_CUTOVER_ID: "approved-cutover", RITM_GOOGLE_READER_JSON: "{}", RITM_GOOGLE_WRITER_JSON: "{}" };
  try {
    await store.withScope(async (scope) => {
      scope.meta("migrationReady", true);
      scope.meta("cloudCutover", { id: "approved-cutover", localWriterDisabled: true });
      const services = await createServices(configured, scope, { fetcher: async () => {
        externalWrites++;
        const row = db.db.prepare("SELECT payload FROM cloud_operations WHERE id=?").get(operationId);
        assert.ok(row, "journal must exist before Google receives a request");
        assert.equal(JSON.parse(row.payload).status, "writing");
        return new Response("{}");
      } });
      scope.beginRollSupplyOperation(operationId, "create", "source-hash", { name: "OZON TEST" }, new Date().toISOString());
      for (const source of ["catalogId", "assemblyDatabaseId"]) await assert.rejects(services.writers.roll.fetcher(`https://sheets.googleapis.com/v4/spreadsheets/${sourceId(env, source)}:batchUpdate`, { method: "POST" }), /не разрешено/);
      assert.equal(externalWrites, 0);
      await services.writers.roll.fetcher(`https://sheets.googleapis.com/v4/spreadsheets/${sourceId(env, "rollPrintingId")}:batchUpdate`, { method: "POST" });
    });
    assert.equal(externalWrites, 1);
    await store.withScope(async (scope) => {
      const services = await createServices(configured, scope, { fetcher: async () => { throw new Error("must not be called"); } });
      assert.equal(services.legacy.state().available, false);
      assert.equal(scope.rollSupplyOperation(operationId).status, "uncertain");
    });
  } finally { db.close(); }
});

test("source authentication mints a read-only token in memory with no private key in the request URL", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const key = btoa(String.fromCharCode(...raw));
  const account = JSON.stringify({ type: "service_account", client_email: "synthetic@example.test", private_key: `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----` });
  let calls = 0;
  const reader = new CloudSheetsReader({ ...env, RITM_GOOGLE_READER_JSON: account }, { fetcher: async (url, init) => {
    calls++; assert.equal(url, "https://oauth2.googleapis.com/token"); assert.ok(!String(url).includes(key));
    const assertion = new URLSearchParams(init.body).get("assertion");
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
    assert.equal(claims.scope, "https://www.googleapis.com/auth/spreadsheets.readonly");
    assert.ok(!assertion.includes("PRIVATE KEY"));
    return new Response(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600 }));
  } });
  assert.equal(await reader.accessToken(), "synthetic-token");
  assert.equal(await reader.accessToken(), "synthetic-token");
  assert.equal(calls, 1);
});

test("production operation ordering survives a D1 reload after resuming an older operation", async () => {
  const { db, store } = fixture();
  const a = { id: crypto.randomUUID(), steps: [], status: "verified", updatedAt: "2026-10-20T00:00:00Z" }, b = { id: crypto.randomUUID(), steps: [], status: "verified", updatedAt: "2026-10-21T00:00:00Z" };
  try {
    await store.withScope(async (scope) => { scope.meta("productionSupplyOperations", [a, b]); });
    await store.withScope(async (scope) => { scope.meta("productionSupplyOperations", [b, a]); });
    assert.deepEqual((await store.scope()).meta("productionSupplyOperations").map((row) => row.id), [b.id, a.id]);
  } finally { db.close(); }
});
