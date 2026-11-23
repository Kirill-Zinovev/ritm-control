import assert from "node:assert/strict";
import test from "node:test";
import { bindings as defaults } from "./cloud-env.mjs";
import { cloudApi } from "../worker/cloud/runtime.js";
import { assemblyV2Origin } from "../worker/cloud/assemblyV2Transport.js";

const bindings = {
  ...defaults,
  DB: {},
  RITM_GOOGLE_FBO_SOURCE_ID: undefined,
  RITM_OWNER_USER_IDS: "test-owner",
  RITM_ASSEMBLY_V2_TARGET_URL: assemblyV2Origin,
  RITM_ASSEMBLY_V2_FEED_SECRET: "a".repeat(64),
};
const headers = { "oai-authenticated-user-id": "test-owner" };
const request = (query = "") => new Request("https://ritm.test/api/assembly" + query, { headers });
const run = (query, fetcher) => cloudApi(request(query), bindings, {}, { fetcher });
const job = { id: "work-a", employeeId: "employee-a", employee: "Сборщик", operation: "packing",
  qty: 24, norm: "120", coefficient: "0.2", createdAt: "2026-11-20T22:10:00.000Z",
  sku: "SKU-1", supply: "Поставка", supplyId: "supply-a", positionId: "position-a", productType: "Наклейки" };

test("the production report reads Assembly D1 in place of FBO and presents actual saved work", async () => {
  const response = await run("?date=2026-11-21&period=month", async (url, init) => {
    assert.equal(url, assemblyV2Origin + "/api/ritm/work-report?from=2026-11-01&to=2026-11-21");
    assert.equal(init.method, "GET");
    assert.match(init.headers["x-assembly-v2-signature"], /^[0-9a-f]{64}$/);
    return Response.json({ ok: true, schemaVersion: 1, revision: 8,
      events: [job, { ...job, id: "work-b", employeeId: "employee-b", employee: "Упаковщик", coefficient: null, norm: null }],
      next: null });
  });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.sourcePolicy.mode, "assembly-only");
  assert.deepEqual(Object.keys(report.sources), ["assembly"]);
  assert.deepEqual(report.reportRange, { start: "2026-11-01", end: "2026-11-21" });
  assert.deepEqual(report.rows.map(row => [row.employee, row.packed, row.coefficient]), [
    ["Сборщик", 24, 0.2], ["Упаковщик", 24, null],
  ]);
  assert.equal(report.history[0].date, "2026-11-21");
  assert.equal(report.events[0].positionId, "position-a");
});

test("a failed D1 report never triggers a Google or legacy work request", async () => {
  let calls = 0;
  const response = await run("?date=2026-11-21&from=2026-10-16&to=2026-11-21", async input => {
    calls++;
    assert.ok(input.startsWith(assemblyV2Origin + "/api/ritm/work-report?"));
    return new Response(null, { status: 503 });
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
  assert.equal((await response.json()).error, "assembly_report_unavailable");
});
