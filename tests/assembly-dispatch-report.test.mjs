import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { readAssemblyDispatchReport } from "../worker/cloud/assemblyDispatchReport.js";
import { assemblyV2Origin } from "../worker/cloud/assemblyV2Transport.js";
import { cloudApi } from "../worker/cloud/runtime.js";

const owner = "dispatch-owner";
const supplyId = "RITM-ROLL-1";
const body = { supplyIds: [supplyId] };
const targetPath = "/api/ritm/dispatch-report";
const origin = "https://ritm.test";
const bindings = {
  RITM_OWNER_USER_IDS: owner,
  RITM_ASSEMBLY_V2_TARGET_URL: assemblyV2Origin,
  RITM_ASSEMBLY_V2_FEED_SECRET: "a".repeat(64),
};
const row = {
  supplyId, supplyTitle: "Москва 26.11", positionId: "RITM-ROLL-1:P11", sku: "PT0001.A0277", department: "roll",
  market: "OZON", store: "1", destination: "Москва", plan: 100, packed: 75, sent: 50,
  cartons: [{ id: "test-box-24", label: "К-024", qty: 25, state: "closed", prepared: true }],
};
const reply = (overrides = {}) => ({ checkedAt: new Date().toISOString(), schemaVersion: 1, revision: 71, rows: [row], ...overrides });

test("dispatch report calls the existing signed Assembly channel for exact supply IDs and retains unknown sent facts", async () => {
  const now = Date.now();
  const sourceRow = { ...row, sent: null, privateField: "internal", cartons: [{ ...row.cartons[0], privateField: "internal" }] };
  const value = await readAssemblyDispatchReport(body, bindings, {
    now: () => now,
    fetcher: async (url, init) => {
      assert.equal(url, assemblyV2Origin + targetPath);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.deepEqual(JSON.parse(init.body), body);
      assert.equal(init.headers["x-assembly-v2-at"], String(now));
      const digest = createHash("sha256").update(init.body).digest("hex");
      const checked = createHmac("sha256", bindings.RITM_ASSEMBLY_V2_FEED_SECRET)
        .update(JSON.stringify([1, "POST", targetPath, String(now), init.headers["x-assembly-v2-nonce"], digest])).digest("hex");
      assert.equal(init.headers["x-assembly-v2-signature"], checked);
      return Response.json(reply({ rows: [sourceRow] }));
    },
  });
  assert.equal(value.ok, true);
  assert.equal(value.stale, false);
  assert.equal(value.revision, 71);
  assert.deepEqual(value.rows, [{ ...row, sent: null }]);
});

test("dispatch report fails closed on stale, unknown, out-of-scope and oversized upstream responses", async () => {
  for (const [response, code] of [
    [new Response("Unavailable", { status: 503 }), "production_dispatch_unavailable"],
    [new Response("Too many rows", { status: 413 }), "production_dispatch_too_large"],
    [Response.json(reply({ checkedAt: new Date(Date.now() - 130_000).toISOString() })), "production_dispatch_stale"],
    [Response.json(reply({ rows: [{ ...row, supplyId: "RITM-BOX-2" }] })), "production_dispatch_unavailable"],
    [Response.json(reply({ rows: [row, row] })), "production_dispatch_unavailable"],
    [Response.json(reply({ rows: [{ ...row, sent: "0" }] })), "production_dispatch_unavailable"],
  ]) {
    await assert.rejects(readAssemblyDispatchReport(body, bindings, { fetcher: async () => response }), { code });
  }
});

test("Production route uses real owner access and validates same-origin and bounded IDs before reading Assembly", async () => {
  let outbound = 0;
  const request = (headers, value = body, method = "POST") => cloudApi(new Request(origin + "/api/production-dispatch", {
    method,
    headers: { origin, "content-type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify(value) : undefined,
  }), bindings, null, { fetcher: async () => { outbound++; return Response.json(reply()); } });
  const identity = { "oai-authenticated-user-id": owner };
  assert.equal((await request({})).status, 401);
  assert.equal((await request({ "oai-authenticated-user-id": "another-account" })).status, 403);
  assert.equal((await request({ ...identity, origin: "https://another.test" })).status, 403);
  assert.equal((await request(identity, { supplyIds: [supplyId, supplyId] })).status, 400);
  assert.equal((await request(identity, { supplyIds: ["Москва"] })).status, 400);
  assert.equal((await request(identity, undefined, "GET")).status, 405);
  assert.equal(outbound, 0);
  const ok = await request(identity);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control"), /no-store/);
  assert.deepEqual((await ok.json()).rows, [row]);
  assert.equal(outbound, 1);
});
