import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../agent/config.js";
import { loadSource, todayMoscow, validateApi } from "../agent/adapters.js";
import { IncidentStore } from "../agent/store.js";
import { DEFAULT_SOURCES } from "../agent/registry.js";
import { createAgentServer } from "../agent/server.js";
import { FBO_HISTORY_GID, selectAssemblyPeriod } from "../worker/assembly.js";
import { HISTORY_HEADERS } from "../worker/assemblyDiagnostics.js";
import { makeFboCurrentGvizFixture } from "../worker/assemblyFboCurrent.js";
import { RITM_ASSEMBLY_WORKLOG_GID, RITM_ASSEMBLY_CURRENT_CATALOG_GID, RITM_ASSEMBLY_WORK_CORRECTIONS_GID } from "../worker/assemblyWorkLog.js";

const day = todayMoscow();
const previousDay = new Date(Date.parse(day + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);
const csv = (rows) => rows.map((row) => row.map((value) => '"' + String(value ?? "").replaceAll('"', '""') + '"').join(",")).join("\r\n");
const source = DEFAULT_SOURCES.find((item) => item.adapter === "assembly");
const shipmentId = "RITM-ROLL-555";
const positionId = shipmentId + "|uid:one|SKU1";
async function snapshot() {
  const requests = [];
  const value = await loadSource(source, async (input) => {
    const url = new URL(input);
    requests.push(url);
    const gid = Number(url.searchParams.get("gid"));
    if (url.pathname.endsWith("/gviz/tq")) return new Response(makeFboCurrentGvizFixture([
      ["Вика 4", 0, 0, 0.4, 0.4, "", "Обновляется автоматически\n13:09", null, 0, 0, 0, 400, 400, null, "Наклейки А5 — 400"],
    ]));
    if (gid === FBO_HISTORY_GID) return new Response(csv([
      HISTORY_HEADERS,
      [previousDay, "Вика 4", 0, 0, 0, 100, 100, 0.1, "", "Наклейки А5 — 100", previousDay + "T09:00:00Z", "history1"],
      [day, "Вика 4", 0, 0, 0, 0, 0, 0, "", "", day + "T00:00:00Z", "zero-today"],
    ]));
    if (gid === RITM_ASSEMBLY_WORKLOG_GID) return new Response(csv([
      ["eventId", "createdAt", "shipmentId", "directionId", "Направление", "positionId", "Артикул", "employeeId", "Сотрудник", "operationId", "Операция", "Количество, шт", "Норма, шт/чел", "Коэффициент", "Источник", "idempotencyKey"],
      ["event1", day + "T09:00:00Z", shipmentId, "ROLL", "OZON 10_10", positionId, "SKU1", "emp-1", "Анна", "packing", "Упаковка", 70, 700, 0.1, "WEB_APP_RITM", "idempotency1"],
    ]));
    if (gid === RITM_ASSEMBLY_WORK_CORRECTIONS_GID)
      return new Response("correctionId,eventId,action,createdAt,actor,reason");
    if (gid === RITM_ASSEMBLY_CURRENT_CATALOG_GID) return new Response(csv([
      ["shipmentId", "directionId", "positionId", "Артикул", "Вид товара", "Источник"],
      [shipmentId, "ROLL", positionId, "SKU1", "Наклейки А5", "RITM_ROLL_PRINTING"],
    ]));
    return new Response("Вид,Норма\nНаклейки А5 упаковка,700");
  }, new Date(day + "T10:00:00Z"));
  return { value, requests };
}

test("agent snapshot reads today's live FBO and Assembly plus historical FBO for local period filters", async () => {
  const { value, requests } = await snapshot();
  assert.equal(value.schemaVersion, 2);
  assert.ok(requests.some((url) => Number(url.searchParams.get("gid")) === FBO_HISTORY_GID));
  assert.equal(value.sources.fbo.status, "available");
  assert.equal(value.sources.assembly.status, "available");
  assert.equal(value.reconciliation.sourceTotals.fbo.packed, 400);
  assert.equal(value.reconciliation.sourceTotals.assembly.packed, 70);
  assert.ok(value.history.some((row) => row.date === previousDay && row.packed === 100));
  const historical = selectAssemblyPeriod(value, previousDay);
  assert.equal(historical.reconciliation.sourceTotals.fbo.packed, 100);
  assert.equal(historical.reconciliation.sourceTotals.assembly.packed, 0);
  assert.equal(historical.recordsBySource, undefined);
  assert.equal(validateApi(selectAssemblyPeriod(value, day), "assembly").schemaVersion, 2);
});

test("protected agent API upgrades legacy snapshot, refreshes explicitly and preserves data after refresh failure", async () => {
  const { value } = await snapshot();
  const store = new IncidentStore(":memory:");
  const config = { ...loadConfig({ RITM_OWNER_TOKEN: randomBytes(32).toString("hex") }), sources: [source] };
  store.snapshot(source.id, { ...value, schemaVersion: 1 }, value.updatedAt);
  let refreshes = 0;
  let failRefresh = false;
  const server = createAgentServer(store, config, {
    refreshAssembly: async () => {
      refreshes++;
      if (!failRefresh) store.snapshot(source.id, value, value.updatedAt);
      store.check(source.id, { status: failRefresh ? "error" : "ok", kind: "source" }, value.updatedAt);
      return { ok: !failRefresh };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = { authorization: "Bearer " + config.ownerToken };
  try {
    assert.equal((await fetch(base + "/api/assembly")).status, 401);
    const read = async (date = day, period = "day", refresh = false) => {
      const response = await fetch(base + `/api/assembly?date=${date}&period=${period}${refresh ? "&refresh=1" : ""}`, { headers });
      assert.equal(response.status, 200);
      return response.json();
    };
    const current = await read();
    assert.equal(refreshes, 1);
    assert.equal(current.schemaVersion, 2);
    assert.equal(current.reconciliation.sourceTotals.fbo.packed, 400);
    assert.equal(current.reconciliation.sourceTotals.assembly.packed, 70);
    assert.equal((await read(previousDay)).reconciliation.sourceTotals.fbo.packed, 100);
    await read(day, "week");
    await read(day, "month");
    assert.equal(refreshes, 1, "cached filters must not read Google Sheets again");
    await read(day, "day", true);
    assert.equal(refreshes, 2);
    failRefresh = true;
    const stale = await read(day, "day", true);
    assert.equal(stale.stale, true);
    assert.equal(stale.refreshFailed, true);
    assert.equal(stale.reconciliation.sourceTotals.assembly.packed, 70);
    assert.equal(stale.reconciliation.sourceTotals.fbo.packed, 400);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
