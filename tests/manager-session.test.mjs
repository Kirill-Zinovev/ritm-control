import assert from "node:assert/strict";
import test from "node:test";
import { clearManagerSession, installManagerSessionFetch, saveManagerSession } from "../src/managerSession.js";

test("manager session is attached only to allowed same-origin RITM APIs", async () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  const calls = [];
  globalThis.window = {
    location: { href: "https://ritm.test/?page=supplies", origin: "https://ritm.test" },
    sessionStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    fetch: async (input, init) => {
      calls.push({ input, init });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  };

  try {
    const token = "a".repeat(43);
    assert.equal(saveManagerSession(token), true);
    installManagerSessionFetch();
    await window.fetch("/api/roll-supplies", { method: "POST" });
    await window.fetch("/api/production-controls?shipmentIds=shipment-1");
    await window.fetch("/api/shipment-locks?shipmentIds=shipment-1");
    await window.fetch("/api/shipment-locks", { method: "POST", body: "{}" });
    await window.fetch("/api/assembly-only-items?shipmentId=shipment-1");
    await window.fetch("/api/assembly-only-catalog?article=ABC");
    await window.fetch("/api/assembly-only-items", { method: "POST", body: "{}" });
    await window.fetch("https://other.test/api/assembly-only-items");
    await window.fetch("/api/cloud/maintenance", { method: "POST" });
    await window.fetch("https://other.test/api/roll-supplies");

    assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${token}`);
    for (const call of calls.slice(1, 7))
      assert.equal(new Headers(call.init?.headers).get("authorization"), `Bearer ${token}`);
    for (const call of calls.slice(7))
      assert.equal(new Headers(call.init?.headers).has("authorization"), false);
    clearManagerSession();
    assert.equal(values.size, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});
