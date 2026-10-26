import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { LocalCloudBridge, localRepairOutcome } from "../agent/cloudBridge.js";
import { bridgeSignature, verifyBridge } from "../worker/cloud/bridge.js";
import { externalLease } from "../worker/cloud/externalLease.js";
import { requireCutover } from "../worker/cloud/services.js";
import { CloudStore } from "../worker/cloud/store.js";
import { LocalD1 } from "./helpers/d1-sqlite.mjs";
import { cloudSchemaStatements } from "./helpers/cloud-schema.mjs";
import { bindings } from "./cloud-env.mjs";
import { IncidentStore } from "../agent/store.js";
import { createAgentServer } from "../agent/server.js";

const origin = "https://isolated-ritm.chatgpt.site", secret = "a".repeat(64), id = "local-owner";
const documentId = bindings.RITM_GOOGLE_ROLL_PRINTING_ID;
function fixture() {
  const db = new LocalD1(); db.db.exec(cloudSchemaStatements().join(";\n"));
  let now = Date.now();
  const store = new CloudStore(db, { now: () => now, leaseMs: 1000 });
  const env = { ...bindings, DB: db, RITM_LOCAL_BRIDGE_ID: id, RITM_LOCAL_BRIDGE_SECRET: secret, RITM_CLOUD_WRITES_ENABLED: "true", RITM_CLOUD_CUTOVER_ID: "test-cutover" };
  return { db, store, env, advance: () => { now += 2000; } };
}
async function ready(store) {
  await store.withScope(async scope => { scope.meta("migrationReady", true); scope.meta("cloudCutover", { id: "test-cutover", localWriterDisabled: true }); });
}
function signed(path, { method = "GET", body = "", nonce = randomUUID(), timestamp = String(Date.now()) } = {}) {
  return new Request(origin + path, { method, headers: { "content-type": "application/json", "x-ritm-bridge-id": id, "x-ritm-bridge-at": timestamp, "x-ritm-bridge-nonce": nonce, "x-ritm-bridge-signature": bridgeSignature(secret, { method, path, timestamp, nonce, body }) }, ...(method === "GET" ? {} : { body }) });
}
test("bridge signatures bind method, path, query and body; reject stale, replayed and out-of-scope requests", async () => {
  const { db, env } = fixture();
  try {
    const request = signed("/api/roll-supplies/preview?mode=1", { method: "POST", body: '{"name":"Тест"}' });
    assert.equal(await verifyBridge(request.clone(), env), id);
    await assert.rejects(verifyBridge(request.clone(), env), { code: "bridge_replay" });
    await assert.rejects(verifyBridge(new Request(origin + "/api/roll-supplies/preview?mode=2", request), env), { code: "bridge_forbidden" });
    await assert.rejects(verifyBridge(signed("/api/cloud/import", { method: "POST", body: "{}" }), env), { code: "bridge_forbidden" });
    await assert.rejects(verifyBridge(signed("/api/printing", { timestamp: String(Date.now() - 300000) }), env), { code: "bridge_forbidden" });
    await assert.rejects(verifyBridge(signed("/api/printing"), { ...env, RITM_LOCAL_BRIDGE_SECRET: "" }), { code: "bridge_forbidden" });
  } finally { db.close(); }
});
test("local bridge signs only scoped cloud requests and never blindly retries lost responses", async () => {
  const { db, env } = fixture(); let calls = 0;
  const bridge = new LocalCloudBridge({ baseUrl: origin, id, secret, fetcher: async (url, init) => {
    calls++; assert.equal(init.redirect, "error");
    assert.equal(await verifyBridge(new Request(url, init), env), id);
    return Response.json({ ok: true, operationId: "saved-once" });
  } });
  try {
    assert.equal((await bridge.value("/api/roll-supplies", { method: "POST", body: { article: "SYNTHETIC" } })).operationId, "saved-once");
    await assert.rejects(bridge.request("https://another.chatgpt.site/api/printing"), { code: "cloud_bridge_scope" });
    await assert.rejects(bridge.request("/api/cloud/import", { method: "POST", body: {} }), { code: "cloud_bridge_scope" });
    assert.equal(calls, 1);
    bridge.fetcher = async () => { calls++; throw new Error("network lost after write"); };
    await assert.rejects(bridge.value("/api/roll-supplies", { method: "POST", body: { operationId: "same-key" } }), { code: "cloud_bridge_unavailable" });
    assert.equal(calls, 2);
  } finally { db.close(); }
});
test("expired local repair lease keeps cloud writes blocked until verified recovery", async () => {
  const { db, store, env, advance } = fixture();
  const request = new Request(origin + "/api/cloud/bridge-lease", { method: "POST" });
  const input = { operationId: randomUUID(), table: "test_repair_proposals", documentId };
  try {
    await ready(store);
    const { lease } = await externalLease(request, { ...input, action: "acquire" }, id, env, store);
    await assert.rejects(store.acquire(), { code: "cloud_operation_busy" });
    advance();
    await assert.rejects(externalLease(request, { ...input, action: "renew", lease }, id, env, store), { code: "cloud_lease_lost" });
    assert.throws(() => requireCutover(env, { meta: key => key === "migrationReady" ? true : key === "cloudCutover" ? { id: "test-cutover", localWriterDisabled: true } : key === "externalRepairs" ? [{ status: "writing", documentId }] : null }), { code: "local_repair_pending" });
    await externalLease(request, { ...input, action: "release", lease, outcome: "uncertain" }, id, env, store);
    const uncertain = await store.scope();
    assert.throws(() => requireCutover(env, uncertain), { code: "local_repair_pending" });
    await externalLease(request, { ...input, action: "release", lease, outcome: "verified" }, id, env, store);
    requireCutover(env, await store.scope());
    const next = await store.acquire(); await store.release(next);
  } finally { db.close(); }
});
test("repair result classification preserves unconfirmed writes and recognizes verified source recovery", () => {
  const store = row => ({ db: { prepare: () => ({ get: () => row }) } });
  assert.equal(localRepairOutcome(store({ status: "written_unverified", result: '{"api":{}}' }), "source_recovery_operations", "x"), "uncertain");
  assert.equal(localRepairOutcome(store({ status: "blocked", result: '{"code":"write_rejected"}' }), "source_recovery_operations", "x"), "not_written");
  assert.equal(localRepairOutcome(store({ status: "already_restored", result: "{}" }), "source_recovery_operations", "x"), "verified");
  assert.equal(localRepairOutcome(store(null), "unknown_table", "x"), "uncertain");
});
test("local proxy retains owner session, origin and forwarded-header write guards", async () => {
  const store = new IncidentStore(":memory:"); let calls = 0;
  const config = { ownerToken: "b".repeat(40), port: 4318, allowedOrigins: ["http://localhost:4318"], sources: [], apiRateLimit: 1000 };
  const bridge = new LocalCloudBridge({ baseUrl: origin, id, secret });
  bridge.request = async (path, options) => { calls++; return { status: 200, value: { ok: true, path, action: options.body?.action } }; };
  const server = createAgentServer(store, config, { cloudBridge: bridge });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (path, headers = {}, body) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://localhost:4318", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await request("/api/roll-supplies/status")).status, 401);
    const login = await request("/api/intelligence/session", {}, { token: config.ownerToken });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    for (const headers of [{ authorization: "Bearer " + config.ownerToken }, { cookie, origin: "https://foreign.test" }, { cookie, "x-forwarded-for": "127.0.0.1" }, { cookie, forwarded: "for=127.0.0.1" }]) {
      assert.equal((await request("/api/roll-supplies", headers, { action: "create" })).status, 403);
    }
    assert.equal(calls, 0);
    assert.equal((await request("/api/roll-supplies/status", { cookie })).status, 200);
    const saved = await request("/api/roll-supplies", { cookie }, { action: "create" });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).action, "create");
    assert.equal(calls, 2);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});
test("local repair cannot acquire past an unresolved cloud supply operation or disabled cutover", async () => {
  const { db, store, env } = fixture();
  const request = new Request(origin + "/api/cloud/bridge-lease", { method: "POST" });
  const input = { action: "acquire", operationId: randomUUID(), table: "test_repair_proposals", documentId };
  try {
    await assert.rejects(externalLease(request, input, id, env, store), { code: "cloud_write_disabled" });
    await ready(store);
    await store.withScope(async scope => { scope.meta("productionSupplyOperations", [{ id: "uncertain-test", status: "partial" }]); });
    await assert.rejects(externalLease(request, input, id, env, store), { code: "supply_operation_pending" });
    assert.deepEqual((await store.scope()).meta("externalRepairs"), undefined);
  } finally { db.close(); }
});
test("every local write rechecks lease and fails closed before a subsequent write", async () => {
  let renews = 0, releases = 0;
  const bridge = new LocalCloudBridge({ baseUrl: origin, id, secret, documentIds: [documentId], fetcher: async (url, init) => {
    const input = JSON.parse(init.body);
    if (input.action === "acquire") return Response.json({ ok: true, lease: { name: "production", owner: "test", fence: 1 } });
    if (input.action === "renew" && ++renews > 1) return Response.json({ ok: false, error: "cloud_lease_lost" }, { status: 409 });
    if (input.action === "release") releases++;
    return Response.json({ ok: true });
  } });
  await assert.rejects(bridge.beforeLocalWrite(documentId), { code: "write_rejected" });
  await bridge.coordinateRepair({ operationId: randomUUID(), table: "test_repair_proposals", outcome: () => "uncertain" }, async () => {
    await bridge.beforeLocalWrite(documentId);
    await assert.rejects(bridge.beforeLocalWrite(documentId), { code: "write_rejected" });
  });
  assert.equal(renews, 2); assert.equal(releases, 1);
});
