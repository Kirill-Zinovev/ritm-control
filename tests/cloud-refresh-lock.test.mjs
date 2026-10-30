import assert from "node:assert/strict";
import test from "node:test";
import { readSnapshot } from "../worker/cloud/runtime.js";
import { bindings } from "./cloud-env.mjs";

test("competing refresh keeps a still-fresh verified snapshot writable", async () => {
  const now = Date.now();
  const store = {
    now: () => now,
    snapshot: async () => ({ at: now - 60_000, value: { ok: true, updatedAt: new Date(now - 60_000).toISOString() } }),
    acquire: async () => { throw Object.assign(new Error("busy"), { code: "cloud_operation_busy" }); },
  };
  const result = await readSnapshot("printing", new URL("https://ritm.test/api/printing?refresh=1"), bindings, store, {});
  assert.equal(result.stale, false);
  assert.equal(result.refreshFailed, false);
  assert.equal(result.refreshInProgress, true);
});

test("competing refresh keeps an expired snapshot stale and blocks writes", async () => {
  const now = Date.now();
  const store = {
    now: () => now,
    snapshot: async () => ({ at: now - 6 * 60_000, value: { ok: true, updatedAt: new Date(now - 6 * 60_000).toISOString() } }),
    acquire: async () => { throw Object.assign(new Error("busy"), { code: "cloud_operation_busy" }); },
  };
  const result = await readSnapshot("printing", new URL("https://ritm.test/api/printing?refresh=1"), bindings, store, {});
  assert.equal(result.stale, true);
  assert.equal(result.refreshFailed, false);
  assert.equal(result.refreshInProgress, true);
});
