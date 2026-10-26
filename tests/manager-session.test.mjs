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
    await window.fetch("/api/cloud/maintenance", { method: "POST" });
    await window.fetch("https://other.test/api/roll-supplies");

    assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(new Headers(calls[1].init?.headers).has("authorization"), false);
    assert.equal(new Headers(calls[2].init?.headers).has("authorization"), false);
    clearManagerSession();
    assert.equal(values.size, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});
