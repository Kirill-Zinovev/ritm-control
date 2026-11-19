import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openWorkplace } from "../src/Access";

const testToken = "ab".repeat(32);

function mockBrowser(
  t: TestContext,
  responses: Array<{ status?: number; body: Record<string, unknown> }>,
) {
  const original = new Map(
    ["location", "history", "fetch"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const url = new URL(`https://assembly.test/#access=${testToken}`);
  const calls: Array<{ path: string; method: string }> = [];
  Object.defineProperty(globalThis, "location", { configurable: true, value: url });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: {
      replaceState(_state: unknown, _title: string, next: string | URL) {
        url.href = new URL(next, url).href;
      },
    },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (path: string, options?: RequestInit) => {
      calls.push({ path, method: options?.method || "GET" });
      const response = responses.shift();
      assert.ok(response, "unexpected access request");
      return new Response(JSON.stringify(response.body), {
        status: response.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  t.after(() => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  return { url, calls };
}

test("рабочий адрес остаётся полным для пересылки после открытия", async (t) => {
  const { url, calls } = mockBrowser(t, [
    { body: { role: null } },
    { body: { role: "collector" } },
    { body: { role: "collector" } },
  ]);
  assert.equal(await openWorkplace(), "collector");
  assert.equal(url.hash, `#access=${testToken}`);
  assert.deepEqual(calls, [
    { path: "/api/access", method: "GET" },
    { path: "/api/access/collector", method: "POST" },
    { path: "/api/access", method: "GET" },
  ]);
});

test("повторное открытие ссылки сохраняет существующий сеанс сборщика", async (t) => {
  const { url, calls } = mockBrowser(t, [{ body: { role: "collector" } }]);
  assert.equal(await openWorkplace(), "collector");
  assert.equal(url.hash, `#access=${testToken}`);
  assert.deepEqual(calls, [{ path: "/api/access", method: "GET" }]);
});

test("если браузер не сохраняет cookie, ссылка остаётся для повторной попытки", async (t) => {
  const { url } = mockBrowser(t, [
    { body: { role: null } },
    { body: { role: "collector" } },
    { body: { role: null } },
  ]);
  await assert.rejects(openWorkplace(), /не сохранил рабочий доступ.*cookie/i);
  assert.equal(url.hash, `#access=${testToken}`);
});

test("при ошибке рабочий адрес не теряется", async (t) => {
  const { url } = mockBrowser(t, [
    { body: { role: null } },
    { status: 403, body: { error: "Неверная рабочая ссылка" } },
  ]);
  await assert.rejects(openWorkplace(), /Неверная рабочая ссылка/);
  assert.equal(url.hash, `#access=${testToken}`);
});
