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
