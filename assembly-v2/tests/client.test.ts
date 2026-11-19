import test from "node:test";
import assert from "node:assert/strict";
import { request } from "../src/useWorkspace";
test("ошибка связи не превращается в успешную запись", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    throw new TypeError("network unavailable");
  };
  await assert.rejects(request("/api/command"), /Нет ответа от сервера/);
});
test("клиент показывает причину отказа сервера", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Короб уже закрыт." }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(request("/api/command"), /Короб уже закрыт/);
});
