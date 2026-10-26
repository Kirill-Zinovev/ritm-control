import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Miniflare } from "miniflare";
import { bindings } from "./cloud-env.mjs";
import { cloudSchemaStatements } from "./helpers/cloud-schema.mjs";
import { bridgeSignature } from "../worker/cloud/bridge.js";

test("Sites artifact excludes local filesystem, SQLite and file-backed credentials", () => {
  const graph = JSON.parse(readFileSync(new URL("../.checks/sites-bundle-inputs.json", import.meta.url), "utf8"));
  assert.ok(!Object.keys(graph.inputs).some((name) => /(?:^|\/)worker\/privateGoogleConfig\.js$/.test(name)));
  for (const file of Object.values(graph.outputs)) assert.ok(!file.imports.some((entry) => entry.path.startsWith("node:")));
  assert.ok(!readFileSync(new URL("../dist/server/index.js", import.meta.url), "utf8").includes("intelligence.local.json"));
});

test("real Workers runtime handles cloud owner access and D1 without any local files or Google traffic", async () => {
  let outbound = 0;
  const bridgeSecret = "c".repeat(64);
  const mf = new Miniflare({ modules: true, scriptPath: new URL("../dist/server/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), compatibilityDate: "2026-08-06", d1Databases: ["DB"], bindings: { ...bindings, RITM_OWNER_USER_IDS: "owner-site-id", RITM_GOOGLE_READER_JSON: "{}", RITM_LOCAL_BRIDGE_ID: "local-test", RITM_LOCAL_BRIDGE_SECRET: bridgeSecret }, outboundService: async () => { outbound++; throw new Error("Network forbidden in isolated migration test"); } });
  try {
    const db = await mf.getD1Database("DB");
    for (const statement of cloudSchemaStatements()) await db.prepare(statement).run();
    const anonymous = await mf.dispatchFetch("https://ritm.test/api/printing");
    assert.equal(anonymous.status, 401);
    const identity = await mf.dispatchFetch("https://ritm.test/api/runtime");
    assert.equal((await identity.json()).mode, "cloud");
    const headers = { "oai-authenticated-user-id": "owner-site-id" };
    const status = await mf.dispatchFetch("https://ritm.test/api/roll-supplies/status", { headers });
    assert.equal(status.status, 200);
    const state = await status.json();
    assert.equal(state.mode, "cloud"); assert.equal(state.available, false);
    const responses = await Promise.all(Array.from({ length: 30 }, () => mf.dispatchFetch("https://ritm.test/api/assembly-transfers/links", { headers })));
    for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual((await response.json()).links, []); }
    const write = await mf.dispatchFetch("https://ritm.test/api/roll-supplies", { method: "POST", headers: { ...headers, origin: "https://ritm.test", "content-type": "application/json" }, body: "{}" });
    assert.equal(write.status, 403);
    const path = "/api/cloud/registry", timestamp = String(Date.now()), nonce = crypto.randomUUID();
    const bridgeHeaders = { "x-ritm-bridge-id": "local-test", "x-ritm-bridge-at": timestamp, "x-ritm-bridge-nonce": nonce, "x-ritm-bridge-signature": bridgeSignature(bridgeSecret, { method: "GET", path, timestamp, nonce }) };
    const registry = await mf.dispatchFetch("https://ritm.test" + path, { headers: bridgeHeaders });
    assert.equal(registry.status, 503); assert.equal((await registry.json()).error, "migration_not_imported");
    const replay = await mf.dispatchFetch("https://ritm.test" + path, { headers: bridgeHeaders });
    assert.equal(replay.status, 409);
    assert.equal(outbound, 0);
  } finally { await mf.dispose(); }
});

test("RITM manager PIN login is isolated, first-login PIN is rotated, and supply access is role-limited", async () => {
  const owner = "owner-site-id";
  const mf = new Miniflare({ modules: true, scriptPath: new URL("../dist/server/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), compatibilityDate: "2026-08-06", d1Databases: ["DB"], bindings: { ...bindings, RITM_OWNER_USER_IDS: owner, RITM_GOOGLE_READER_JSON: "{}" }, outboundService: async () => { throw new Error("Network forbidden in isolated PIN-auth test"); } });
  try {
    const db = await mf.getD1Database("DB");
    for (const statement of cloudSchemaStatements()) await db.prepare(statement).run();
    const anonymous = await mf.dispatchFetch("https://ritm.test/api/runtime");
    const anonymousRuntime = await anonymous.json();
    assert.equal(anonymousRuntime.authenticated, false);
    assert.equal(anonymousRuntime.authorized, false);

    const ownerHeaders = { "oai-authenticated-user-id": owner, origin: "https://ritm.test", "content-type": "application/json" };
    const created = await mf.dispatchFetch("https://ritm.test/api/auth/users", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ username: "manager.test", displayName: "Тестовый менеджер" }) });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    const temporaryPin = createdBody.user.temporaryPin;
    assert.match(temporaryPin, /^\d{8}$/);
    const stored = await db.prepare("SELECT pin_salt,pin_hash FROM ritm_manager_users WHERE id=?").bind(createdBody.user.id).first();
    assert.ok(stored.pin_hash !== temporaryPin);
    assert.ok(stored.pin_salt.length >= 20);

    const invalid = await mf.dispatchFetch("https://ritm.test/api/auth/login", { method: "POST", headers: { origin: "https://ritm.test", "content-type": "application/json" }, body: JSON.stringify({ username: "manager.test", pin: "00000000" }) });
    assert.equal(invalid.status, 401);
    const login = await mf.dispatchFetch("https://ritm.test/api/auth/login", { method: "POST", headers: { origin: "https://ritm.test", "content-type": "application/json" }, body: JSON.stringify({ username: "manager.test", pin: temporaryPin }) });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") || "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";")[0];
    assert.match(cookie, /^__Host-ritm_session=/);

    const runtimeBeforePinChange = await mf.dispatchFetch("https://ritm.test/api/runtime", { headers: { cookie } });
    const managerBeforePinChange = await runtimeBeforePinChange.json();
    assert.equal(managerBeforePinChange.role, "manager");
    assert.equal(managerBeforePinChange.mustChangePin, true);
    const blockedBeforePinChange = await mf.dispatchFetch("https://ritm.test/api/roll-supplies/status", { headers: { cookie } });
    assert.equal(blockedBeforePinChange.status, 403);

    const changed = await mf.dispatchFetch("https://ritm.test/api/auth/change-pin", { method: "POST", headers: { cookie, origin: "https://ritm.test", "content-type": "application/json" }, body: JSON.stringify({ newPin: "87654321" }) });
    assert.equal(changed.status, 200);
    const runtime = await mf.dispatchFetch("https://ritm.test/api/runtime", { headers: { cookie } });
    const manager = await runtime.json();
    assert.equal(manager.authorized, true);
    assert.equal(manager.mustChangePin, false);

    assert.equal((await mf.dispatchFetch("https://ritm.test/api/roll-supplies/status", { headers: { cookie } })).status, 200);
    assert.equal((await mf.dispatchFetch("https://ritm.test/api/assembly-transfers/links", { headers: { cookie } })).status, 200);
    for (const path of ["/api/assembly", "/api/cloud/state", "/api/intelligence/status", "/api/auth/users"]) {
      const denied = await mf.dispatchFetch("https://ritm.test" + path, { headers: { cookie } });
      assert.equal(denied.status, 403, path);
    }
    const supplyPreview = await mf.dispatchFetch("https://ritm.test/api/roll-supplies/preview", { method: "POST", headers: { cookie, origin: "https://ritm.test", "content-type": "application/json" }, body: JSON.stringify({}) });
    const previewResult = await supplyPreview.json();
    assert.equal(previewResult.ok, false);
    assert.notEqual(previewResult.error, "manager_route_forbidden");
    assert.notEqual(previewResult.error, "authentication_required");

    const disabled = await mf.dispatchFetch(`https://ritm.test/api/auth/users/${createdBody.user.id}/status`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ status: "disabled" }) });
    assert.equal(disabled.status, 200);
    const afterDisable = await mf.dispatchFetch("https://ritm.test/api/runtime", { headers: { cookie } });
    const disabledRuntime = await afterDisable.json();
    assert.equal(disabledRuntime.authorized, false);
  } finally { await mf.dispose(); }
});
