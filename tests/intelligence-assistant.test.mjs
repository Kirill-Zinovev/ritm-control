import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { IncidentStore } from "../agent/store.js";
import { RITMAssistant, formatAssistantResult } from "../agent/assistant.js";
import { TelegramAssistant } from "../agent/telegramAssistant.js";
import { flushTelegram } from "../agent/telegram.js";
import { LocalSecretStore } from "../agent/secretStore.js";
import { createAgentServer } from "../agent/server.js";

function harness({ fetcher, now } = {}) {
  const store = new IncidentStore(":memory:");
  const config = {
    snapshotMaxAgeMs: 60_000,
    sources: [
      {
        id: "assembly",
        adapter: "assembly",
        enabled: true,
        name: "История производства",
      },
      {
        id: "roll",
        adapter: "printing",
        enabled: true,
        name: "Рулонная печать",
      },
    ],
    doctorDocuments: [
      {
        id: "ozon",
        name: "OZON Первый магазин",
        adapter: "google",
        enabled: true,
        sheets: [{ name: "Товары OZON", gid: 123 }],
      },
    ],
    telegram: { token: "", chatId: "", enabled: false },
    assistant: {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "",
      spendLimitUsd: 1,
      dailyRequestLimit: 10,
    },
  };
  const doctor = {
    current: null,
    fastCurrent: null,
    fastRuns: 0,
    deepRuns: 0,
    runFast() {
      this.fastRuns++;
      return (
        this.fastCurrent ||
        (this.fastCurrent = Promise.resolve({
          summary: "быстрая проверка завершена",
        }).finally(() => {
          this.fastCurrent = null;
        }))
      );
    },
    runDocument(id) {
      this.deepRuns++;
      return (
        this.current ||
        (this.current = new Promise((resolve) =>
          setTimeout(() => resolve({ documentId: id }), 20),
        ).finally(() => {
          this.current = null;
        }))
      );
    },
    run() {
      this.deepRuns++;
      return (
        this.current ||
        (this.current = new Promise((resolve) =>
          setTimeout(() => resolve({}), 20),
        ).finally(() => {
          this.current = null;
        }))
      );
    },
  };
  const assistant = new RITMAssistant({
    store,
    config,
    doctor,
    sourceRecovery: { state: () => ({ operation: null }) },
    fetcher,
    now: now || (() => new Date("2026-10-14T09:00:00.000Z")),
  });
  return { store, config, doctor, assistant };
}
function addPrintingSnapshot(
  h,
  { events = [], cutEvents = [], supplies = [] } = {},
) {
  h.store.snapshot(
    "roll",
    {
      events,
      cutEvents,
      supplies,
      issues: [],
      quality: { status: "valid", invalidRecords: 0 },
    },
    "2026-10-14T08:45:00.000Z",
  );
  h.store.check("roll", { status: "ok" }, "2026-10-14T08:45:00.000Z");
}
function requestLocalHttp(port, pathname, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("fast printing and cutting queries share real snapshot facts and Lukman is counted only as cutter", async () => {
  const h = harness();
  addPrintingSnapshot(h, {
    events: [
      {
        employee: "Кирилл",
        quantity: 400,
        area: 12,
        date: "2026-10-14",
        article: "A1",
        sourceName: "Рулонная печать",
      },
    ],
    cutEvents: [
      {
        employee: "Лукман",
        quantity: 250,
        area: 0,
        date: "2026-10-14",
        article: "A1",
        sourceName: "Рулонная печать",
      },
    ],
    supplies: [
      {
        article: "A1",
        quantity: 500,
        remainingPrint: 100,
        sheetName: "Поставка",
      },
    ],
  });
  const print = await h.assistant.callTool(
    "web",
    "owner",
    "get_print_statistics",
    { period: "day" },
  );
  const cut = await h.assistant.callTool(
    "telegram",
    "12",
    "get_cutting_statistics",
    { employee: "Лукман" },
  );
  const remaining = await h.assistant.callTool(
    "web",
    "owner",
    "get_remaining_production",
    {},
  );
  assert.equal(print.quantity, 400);
  assert.equal(cut.quantity, 250);
  assert.equal(cut.employees[0].employee, "Лукман");
  assert.equal(remaining.items[0].remaining, 100);
  assert.equal(print.source, "Рулонная печать");
  h.store.close();
});

test("missing or stale data is not presented as a zero production result", async () => {
  const h = harness();
  const reply = await h.assistant.respond("Кто сколько напечатал?");
  assert.match(reply.text, /Нет проверенного снимка/);
  assert.doesNotMatch(reply.text, /0 шт/);
  h.store.close();
});

test("employee KPI uses the approved assembly summary and never substitutes print data", async () => {
  const h = harness();
  addPrintingSnapshot(h, { events: [{ employee: "Лукман", quantity: 99, area: 0, date: "2026-10-14", article: "A1", sourceName: "Рулонная печать" }] });
  const missing = await h.assistant.callTool("telegram", "77", "get_employee_kpi", { employee: "Лукман" });
  assert.equal(missing.unavailable, true);
  assert.match(missing.message, /не подменяют/);
  h.store.snapshot("assembly", { history: [{ employee: "Анна", date: "2026-10-14", coefficient: 1.25, machineCut: 10, manualCut: 2, cut: 12, packed: 8, total: 20, cutTypes: [], packTypes: [] }] }, "2026-10-14T08:30:00.000Z");
  h.store.check("assembly", { status: "ok" }, "2026-10-14T08:30:00.000Z");
  const result = await h.assistant.callTool("web", "owner", "get_employee_kpi", { employee: "Анна" });
  assert.equal(result.employees[0].cut, 12);
  assert.match(formatAssistantResult("get_employee_kpi", result), /коэффициент 1.25/);
  assert.doesNotMatch(formatAssistantResult("get_employee_kpi", result), /99 шт/);
  h.store.close();
});

test("read-only check starts once, reports the selected document, and never writes", async () => {
  const h = harness();
  const first = await h.assistant.callTool("telegram", "12", "run_deep_check", {
    document: "OZON",
  });
  const second = await h.assistant.callTool(
    "telegram",
    "12",
    "run_fast_check",
    {},
  );
  assert.equal(first.status, "started");
  assert.equal(first.document, "OZON Первый магазин");
  assert.equal(second.status, "already_running");
  assert.equal(h.doctor.deepRuns, 1);
  assert.equal(h.doctor.fastRuns, 0);
  assert.equal(
    h.store.db
      .prepare("SELECT count(*) n FROM source_recovery_operations")
      .get().n,
    0,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  h.store.close();
});

test("a Telegram request during a scheduled check subscribes to its result instead of disappearing", async () => {
  const h = harness();
  h.store.db.prepare("INSERT INTO assistant_owner(id,user_id,chat_id,bound_at) VALUES(1,'12','77',?)").run("2026-10-14T08:00:00.000Z");
  const activeRun = {
    id: "deep-run-1", mode: "deep", status: "running",
    queuedAt: "2026-10-14T08:59:00.000Z", startedAt: "2026-10-14T09:00:00.000Z",
    lastActivityAt: "2026-10-14T09:00:01.000Z", progress: { phase: "Чтение листа", sheet: "Товары OZON" },
  };
  let listener;
  h.doctor.current = new Promise(() => {});
  h.doctor.getRunStatus = () => activeRun;
  h.doctor.subscribeRun = (id, fn) => { assert.equal(id, activeRun.id); listener = fn; return true; };
  const sent = [];
  h.assistant.attachTelegram({ token: "configured", send: async (chatId, text) => sent.push({ chatId, text }) });

  const response = await h.assistant.callTool("telegram", "12", "run_deep_check", {});
  assert.equal(response.status, "already_running");
  assert.equal(response.subscribed, true);
  assert.match(response.message, /отправлю результат именно этого цикла/);
  assert.equal(h.doctor.deepRuns, 0);
  listener({ ...activeRun, status: "completed", finishedAt: "2026-10-14T09:01:15.000Z", resultSummary: "Проверено 4 документа и 10 листов." });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "77");
  assert.match(sent[0].text, /завершена за 1 мин 15 сек/);
  assert.match(sent[0].text, /4 документа и 10 листов/);
  assert.equal(h.store.db.prepare("SELECT status FROM assistant_check_subscriptions WHERE run_id='deep-run-1'").get().status, "sent");
  h.store.close();
});

test("requesting all tables during a fast cycle queues one deep run and subscribes to that result", async () => {
  const h = harness();
  h.store.db.prepare("INSERT INTO assistant_owner(id,user_id,chat_id,bound_at) VALUES(1,'12','77',?)").run("2026-10-14T08:00:00.000Z");
  const runs = [{
    id: "fast-active", mode: "fast", scope: "fast", status: "running",
    queuedAt: "2026-10-14T09:00:00.000Z", startedAt: "2026-10-14T09:00:00.000Z",
  }];
  const listeners = new Map();
  h.doctor.current = null;
  h.doctor.fastCurrent = new Promise(() => {});
  h.doctor.getRunStatus = (mode = null, scope = null) => {
    const compatible = runs.filter((run) => (!mode || run.mode === mode) && (!scope || run.scope === scope));
    return compatible.find((run) => run.status === "running") || compatible.find((run) => run.status === "queued") || (mode ? null : runs.find((run) => run.status === "running")) || null;
  };
  h.doctor.run = () => {
    h.doctor.deepRuns++;
    const existing = runs.find((run) => run.mode === "deep" && run.scope === "all" && ["queued", "running"].includes(run.status));
    if (existing) return new Promise(() => {});
    runs.push({
      id: "deep-all-1", mode: "deep", scope: "all", status: "queued",
      queuedAt: "2026-10-14T09:00:02.000Z", startedAt: null,
    });
    return new Promise(() => {});
  };
  h.doctor.subscribeRun = (id, listener) => {
    listeners.set(id, listener);
    return true;
  };
  const sent = [];
  h.assistant.attachTelegram({ token: "configured", send: async (chatId, text) => sent.push({ chatId, text }) });

  const first = await h.assistant.callTool("telegram", "12", "run_deep_check", {});
  const duplicate = await h.assistant.callTool("telegram", "12", "run_deep_check", {});
  assert.equal(first.status, "queued");
  assert.equal(first.subscribed, true);
  assert.match(first.message, /Глубокая проверка deep-all-1 поставлена в очередь/);
  assert.equal(duplicate.status, "queued");
  assert.equal(h.doctor.deepRuns, 1);
  assert.equal(listeners.has("fast-active"), false);
  assert.equal(listeners.has("deep-all-1"), true);

  listeners.get("deep-all-1")({
    id: "deep-all-1", mode: "deep", status: "completed", startedAt: "2026-10-14T09:00:10.000Z",
    finishedAt: "2026-10-14T09:02:10.000Z", resultSummary: "Проверено 4 документа и 10 листов.",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "77");
  assert.match(sent[0].text, /Глубокая проверка завершена за 2 мин 0 сек/);
  assert.equal(h.store.db.prepare("SELECT status FROM assistant_check_subscriptions WHERE run_id='deep-all-1'").get().status, "sent");
  h.store.close();
});

test("a failed subscribed check sends its failure cause to the owner", async () => {
  const h = harness();
  h.store.db.prepare("INSERT INTO assistant_owner(id,user_id,chat_id,bound_at) VALUES(1,'12','77',?)").run("2026-10-14T08:00:00.000Z");
  const run = { id: "failed-run", mode: "deep", status: "running", startedAt: "2026-10-14T09:00:00.000Z", queuedAt: "2026-10-14T09:00:00.000Z" };
  let listener;
  h.doctor.current = new Promise(() => {});
  h.doctor.getRunStatus = () => run;
  h.doctor.subscribeRun = (_id, fn) => { listener = fn; return true; };
  const sent = [];
  h.assistant.attachTelegram({ token: "configured", send: async (_chat, text) => sent.push(text) });
  await h.assistant.callTool("telegram", "12", "run_deep_check", {});
  listener({ ...run, status: "failed", finishedAt: "2026-10-14T09:00:05.000Z", error: "google_timeout" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sent[0], /завершилась с ошибкой/);
  assert.match(sent[0], /google_timeout/);
  h.store.close();
});

test("/checkstatus reports run type, start, elapsed time and progress to the bound owner", async () => {
  const h = harness();
  h.store.db.prepare("INSERT INTO assistant_owner(id,user_id,chat_id,bound_at) VALUES(1,'12','77',?)").run("2026-10-14T08:00:00.000Z");
  h.doctor.getRunStatus = () => ({
    id: "status-run", mode: "deep", status: "running", startedAt: "2026-10-14T08:59:00.000Z",
    queuedAt: "2026-10-14T08:59:00.000Z", elapsedMs: 65_000,
    lastActivityAt: "2026-10-14T09:00:04.000Z", progress: { phase: "Чтение листа", document: "OZON", sheet: "Товары OZON" },
  });
  const telegram = new TelegramAssistant({ assistant: h.assistant, store: h.store, now: () => Date.parse("2026-10-14T09:00:05.000Z") });
  telegram.send = async (chatId, text) => { telegram.lastMessage = { chatId, text }; return true; };
  await telegram.process({ update_id: 700, message: { text: "/checkstatus", from: { id: 12 }, chat: { id: 77, type: "private" } } });
  assert.equal(telegram.lastMessage.chatId, 77);
  assert.match(telegram.lastMessage.text, /Глубокая проверка: выполняется/);
  assert.match(telegram.lastMessage.text, /Начало:/);
  assert.match(telegram.lastMessage.text, /1 мин 5 сек/);
  assert.match(telegram.lastMessage.text, /Лист: Товары OZON/);
  h.store.close();
});

test("specific sheet check is resolved to its controlled document; ambiguous OZON asks for clarification", async () => {
  const h = harness();
  const sheet = await h.assistant.callTool("telegram", "12", "run_fast_check", {
    sheet: "Товары OZON",
  });
  assert.equal(sheet.status, "started");
  assert.equal(sheet.requestedSheet, "Товары OZON");
  assert.equal(h.doctor.fastRuns, 1);
  const route = h.assistant.route("Проверь конкретный лист OZON");
  assert.equal(route.tool, "run_fast_check");
  assert.equal(route.args.document, "неоднозначно");
  await new Promise((resolve) => setTimeout(resolve, 30));
  h.store.close();
});

test("repair request only shows an exact candidate and never calls a writer", async () => {
  const h = harness();
  const created = h.store.reconcile(
    "doctor:ozon",
    [
      {
        kind: "table_doctor",
        sourceId: "ozon",
        sourceName: "OZON Первый магазин",
        sheet: "Товары OZON",
        cell: "P4",
        type: "data_quality_root_cause",
        title: "Нет вида товара",
        severity: "high",
        found: "пусто",
        expected: "текст",
        status: "open",
        recoveryCandidate: {
          status: "candidate",
          value: { stringValue: "Ёлочные игрушки" },
          evidence: "approved snapshot",
        },
      },
    ],
    { verified: false },
  );
  const item = h.store.listIncidents({ status: "active", page: 0, limit: 10 })
    .rows[0];
  const result = await h.assistant.callTool(
    "telegram",
    "12",
    "prepare_repair",
    { incidentId: item.id },
  );
  assert.equal(result.cell, "P4");
  assert.equal(result.proposed, "Ёлочные игрушки");
  assert.equal(result.wrote, false);
  assert.equal(
    h.store.db
      .prepare("SELECT count(*) n FROM source_recovery_operations")
      .get().n,
    0,
  );
  h.store.close();
});

test("Telegram repair-action migration adds the formula proposal link without losing existing actions", () => {
  const h = harness();
  h.store.db.exec("CREATE TABLE telegram_repair_actions(token_hash TEXT PRIMARY KEY,incident_id TEXT NOT NULL,generation INTEGER NOT NULL,candidate_version TEXT NOT NULL,action TEXT NOT NULL,stage TEXT NOT NULL,user_id TEXT NOT NULL,chat_id TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT)");
  h.store.db.prepare("INSERT INTO telegram_repair_actions VALUES('hash','incident',1,'version','details','notice','77','77','2026-10-14T09:00:00.000Z','2026-10-14T09:10:00.000Z',NULL)").run();
  new TelegramAssistant({ assistant: h.assistant, store: h.store });
  const columns = h.store.db.prepare("PRAGMA table_info(telegram_repair_actions)").all().map((column) => column.name);
  assert.ok(columns.includes("proposal_id"));
  assert.equal(h.store.db.prepare("SELECT action FROM telegram_repair_actions WHERE token_hash='hash'").get().action, "details");
  h.store.close();
});

test("confirmed formula incidents use the protected baseline and repair after one owner Telegram click", async () => {
  const h = harness(), sent = [], repairCalls = [], formulaRows = [
    { cell: "Q8", version: "a".repeat(64), region: "c".repeat(64), formula: '=IF(Z8="";"В работе";IF(COUNTIF(\'_SYSTEM_ROLLS\'!A:A;AF8)=0;"В работе";IF(COUNTIFS(\'_SYSTEM_ROLLS\'!A:A;AF8;\'_SYSTEM_ROLLS\'!D:D;TRUE)=COUNTIF(\'_SYSTEM_ROLLS\'!A:A;AF8);"Готов";"В работе")))' },
    { cell: "R8", version: "b".repeat(64), region: "d".repeat(64), formula: '=IF(Z8="";"В работе";IF(COUNTIF(\'_SYSTEM_ROLLS\'!A:A;AF8)=0;"В работе";IF(COUNTIFS(\'_SYSTEM_ROLLS\'!A:A;AF8;\'_SYSTEM_ROLLS\'!E:E;TRUE)=COUNTIF(\'_SYSTEM_ROLLS\'!A:A;AF8);"Готов";"В работе")))' },
  ];
  h.config.publicOrigin = "https://ritm-private.ts.net";
  h.config.doctorDocuments.push({ id: "doctor-printing", documentId: "sheet-id", name: "СЕЗОННАЯ ПЕЧАТЬ КРАСНОЕ ЗДАНИЕ", enabled: true, adapter: "google", sheets: [{ gid: 437912546, name: "OZON НОВЫЙ ГОД" }] });
  h.store.db.exec("CREATE TABLE formula_protected(source_id TEXT NOT NULL,gid INTEGER NOT NULL,cell TEXT NOT NULL,formula TEXT NOT NULL,merge_signature TEXT,region_id TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(source_id,gid,cell))");
  for (const row of formulaRows) h.store.db.prepare("INSERT INTO formula_protected VALUES('doctor-printing',437912546,?,?,NULL,?,?)").run(row.cell, row.formula, row.region, row.version);
  const findings = formulaRows.map((baseline) => ({
    kind: "table_doctor", sourceId: "doctor-printing", sourceName: "СЕЗОННАЯ ПЕЧАТЬ КРАСНОЕ ЗДАНИЕ",
    sheet: "OZON НОВЫЙ ГОД", gid: 437912546, cell: baseline.cell, type: "formula_text",
    title: "Нарушен эталон утверждённой формулы", cause: "Содержимое ячейки отличается от эталона.",
    recommendation: "Восстановить только после подтверждения владельца.", severity: "high", found: "0 из 2",
    expected: baseline.formula, status: "open", verification: "rule_confirmed", demonstration: false,
    baselineVersion: baseline.version, formulaRegionId: baseline.region,
    observed: { entered: { stringValue: "0 из 2" }, result: "0 из 2", error: null },
  }));
  h.store.reconcile("doctor:formula:doctor-printing:437912546", findings);
  const incidents = h.store.listIncidents({ status: "active", page: 0, limit: 10 }).rows;
  assert.equal(incidents.length, 2);
  assert.deepEqual(incidents.map((item) => item.recoveryCandidate?.kind), ["approved_formula", "approved_formula"]);
  assert.equal(incidents[0].recoveryCandidate.value.formulaValue, formulaRows.find((item) => item.cell === incidents[0].cell).formula);
  assert.equal(incidents[1].recoveryCandidate.value.formulaValue, formulaRows.find((item) => item.cell === incidents[1].cell).formula);

  h.store.db.prepare("INSERT INTO assistant_owner(id,user_id,chat_id,bound_at) VALUES(1,'77','77',?)").run("2026-10-14T08:00:00.000Z");
  const telegram = new TelegramAssistant({ assistant: h.assistant, store: h.store, now: () => Date.parse("2026-10-14T09:00:00.000Z"), fetcher: async (url, options) => {
    const body = JSON.parse(options.body || "{}");
    if (String(url).endsWith("/sendMessage")) sent.push(body);
    return Response.json({ ok: true, result: true });
  } });
  telegram.token = "12345:abcdefghijklmnopqrstuvwxyz";
  const incident = incidents.find((item) => item.cell === "Q8");
  let proposal;
  h.store.db.exec("CREATE TABLE test_repair_proposals(id TEXT PRIMARY KEY,incident_id TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,result TEXT)");
  h.assistant.productionRepair = {
    production: true,
    async prepare(id) {
      repairCalls.push(["prepare", id]);
      proposal = { id: "q8-proposal", incidentId: id, generation: 1, direction: "repair", target: { documentId: "sheet-id", sheetId: 437912546, sheet: "OZON НОВЫЙ ГОД", cell: "Q8" }, from: { stringValue: "0 из 2" }, to: { formulaValue: formulaRows[0].formula }, baselineVersion: formulaRows[0].version, version: "e".repeat(64), confirmation: "Подтверждаю Q8: 0 из 2 → утверждённая формула", expiresAt: Date.parse("2026-10-14T09:10:00.000Z"), createdAt: "2026-10-14T09:00:00.000Z" };
      h.store.db.prepare("INSERT INTO test_repair_proposals VALUES(?,?,?,'pending',?,NULL)").run(proposal.id, id, proposal.version, JSON.stringify(proposal));
      return { proposals: [{ ...proposal, status: "pending" }] };
    },
    async confirm(id, input) {
      repairCalls.push(["confirm", id, input]);
      h.store.db.prepare("UPDATE test_repair_proposals SET status='queued' WHERE id=?").run(id);
      return { queued: true };
    },
    async waitForProposal() { return { status: "verified", target: proposal.target }; },
  };
  await telegram.sendIncident(incident);
  const card = sent.at(-1);
  assert.match(card.text, /Сейчас: 0 из 2/);
  assert.match(card.text, /Предлагается: вернуть формулу из утверждённого эталона/);
  assert.match(card.text, /Источник эталона: Утверждённая формула Formula Intelligence/);
  const [[fix, reject], [details, openCell]] = card.reply_markup.inline_keyboard;
  assert.equal(fix.text, "Исправить");
  assert.equal(reject.text, "Отклонить");
  assert.equal(details.text, "Подробнее");
  assert.equal(openCell.text, "Открыть ячейку");
  assert.match(openCell.url, /gid=437912546/);
  assert.match(openCell.url, /Q8/);
  await telegram.process({ update_id: 1, callback_query: { id: "fix-q8", data: fix.callback_data, from: { id: 77 }, message: { chat: { id: 77, type: "private" } } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(repairCalls[1][0], "confirm");
  assert.equal(repairCalls[1][1], "q8-proposal");
  assert.equal(repairCalls[1][2].exclusiveEditingAcknowledged, true);
  assert.ok(sent.some((item) => /Исправление запущено: OZON НОВЫЙ ГОД!Q8/.test(item.text)));
  assert.ok(sent.some((item) => /Формула исправлена и проверена: OZON НОВЫЙ ГОД!Q8/.test(item.text)));
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM source_recovery_operations").get().n, 0);
  h.store.close();
});

test("formula incident without a matching current protected baseline has no repair button and explains why", async () => {
  const h = harness(), sent = [];
  h.store.db.exec("CREATE TABLE formula_protected(source_id TEXT NOT NULL,gid INTEGER NOT NULL,cell TEXT NOT NULL,formula TEXT NOT NULL,merge_signature TEXT,region_id TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(source_id,gid,cell))");
  h.store.db.prepare("INSERT INTO formula_protected VALUES('doctor-printing',437912546,'Q8','=A1+1',NULL,'current-region',?)").run("f".repeat(64));
  h.store.reconcile("doctor:formula:doctor-printing:437912546", [{
    kind: "table_doctor", sourceId: "doctor-printing", sourceName: "Печать", sheet: "OZON НОВЫЙ ГОД", gid: 437912546, cell: "Q8",
    type: "formula_text", title: "Нарушен эталон утверждённой формулы", expected: "=A1+2", status: "open", verification: "rule_confirmed",
    baselineVersion: "a".repeat(64), formulaRegionId: "old-region", observed: { entered: { stringValue: "значение" } },
  }]);
  const incident = h.store.listIncidents({ status: "active", page: 0, limit: 1 }).rows[0];
  assert.equal(incident.recoveryCandidate, undefined);
  assert.equal(incident.repairAvailability.status, "blocked");
  assert.match(incident.repairAvailability.reason, /Версия эталона изменилась/);
  const telegram = new TelegramAssistant({ assistant: h.assistant, store: h.store, fetcher: async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ ok: true, result: true }); } });
  telegram.token = "12345:abcdefghijklmnopqrstuvwxyz";
  h.store.db.prepare("INSERT INTO assistant_owner(id,user_id,chat_id,bound_at) VALUES(1,'77','77',?)").run(new Date().toISOString());
  await telegram.sendIncident(incident);
  assert.match(sent[0].text, /почему нет исправления/i);
  assert.match(sent[0].text, /версия эталона изменилась/i);
  assert.equal(sent[0].reply_markup.inline_keyboard.flat().some((button) => button.text === "Исправить"), false);
  h.store.close();
});

test("tool arguments reject arbitrary keys and unsupported tools", async () => {
  const h = harness();
  await assert.rejects(
    h.assistant.callTool("web", "owner", "execute_sql", {
      query: "DELETE FROM incidents",
    }),
    /не разрешены/,
  );
  await assert.rejects(
    h.assistant.callTool("web", "owner", "get_print_statistics", {
      sql: "DROP TABLE",
    }),
    /аргумент|параметр|разреш/,
  );
  h.store.close();
});

test("Telegram pairing is single-use, private-only, and rejects foreign users", async () => {
  const h = harness();
  const sends = [];
  const telegram = new TelegramAssistant({
    assistant: h.assistant,
    store: h.store,
    fetcher: async (_url, options) => {
      sends.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    },
  });
  telegram.token = "12345:abcdefghijklmnopqrstuvwxyz";
  const { code } = h.assistant.createPairing();
  await telegram.process({
    update_id: 1,
    message: {
      text: `/start ${code}`,
      from: { id: 77 },
      chat: { id: 77, type: "private" },
    },
  });
  assert.equal(
    h.assistant.isOwner({
      message: { from: { id: 77 }, chat: { id: 77, type: "private" } },
    }),
    true,
  );
  await telegram.process({
    update_id: 2,
    message: {
      text: "/status",
      from: { id: 88 },
      chat: { id: 88, type: "private" },
    },
  });
  await telegram.process({
    update_id: 3,
    message: {
      text: "/status",
      from: { id: 77 },
      chat: { id: -1, type: "group" },
    },
  });
  assert.equal(sends.length, 1);
  await telegram.process({
    update_id: 1,
    message: { text: "/status", from: { id: 77 }, chat: { id: 77, type: "private" } },
  });
  assert.equal(sends.length, 1, "replayed Telegram update is ignored");
  assert.equal(
    h.store.db.prepare("SELECT count(*) n FROM assistant_owner").get().n,
    1,
  );
  h.store.close();
});

test("expired Telegram pairing code cannot bind an owner", () => {
  let clock = new Date("2026-10-14T09:00:00.000Z");
  const h = harness({ now: () => clock });
  const { code } = h.assistant.createPairing();
  clock = new Date("2026-10-14T09:11:00.000Z");
  assert.equal(h.assistant.bindTelegram({ message: { text: `/start ${code}`, from: { id: 77 }, chat: { id: 77, type: "private" } } }), false);
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM assistant_owner").get().n, 0);
  h.store.close();
});

test("Telegram Исправить starts one exact Source Recovery operation and reports its verified result", async () => {
  const h = harness(), sent = [], calls = [], methods = [];
  h.config.publicOrigin = "https://ritm-private.ts.net";
  const telegram = new TelegramAssistant({
    assistant: h.assistant,
    store: h.store,
    fetcher: async (url, options) => {
      const method = String(url).split("/").at(-1), payload = JSON.parse(options.body || "{}");
      calls.push(method);
      methods.push({ method, payload });
      if (method === "sendMessage") sent.push(payload);
      return Response.json({ ok: true, result: true });
    },
  });
  telegram.token = "12345:abcdefghijklmnopqrstuvwxyz";
  const { code } = h.assistant.createPairing();
  await telegram.process({ update_id: 100, message: { text: `/start ${code}`, from: { id: 77 }, chat: { id: 77, type: "private" } } });
  const candidate = { status: "candidate", value: { stringValue: "Наклейки А5 5-6 листов" }, evidence: "Утверждённый снимок каталога", observedAt: "2026-10-14T08:00:00.000Z" };
  h.store.reconcile("doctor:ozon", [{
    kind: "table_doctor", sourceId: "ozon", sourceName: "OZON Первый магазин", sheet: "Товары", gid: 123,
    cell: "P194", type: "data_quality_root_cause", title: "Не заполнен Вид товара", cause: "Обязательное поле пустое",
    severity: "high", found: "", expected: "текст", status: "open", verification: "rule_confirmed",
    demonstration: false, sourceState: "missing", observed: { productKey: "FT0001.A0002(OZ)" }, recoveryCandidate: candidate,
  }]);
  const incident = h.store.listIncidents({ status: "active", page: 0, limit: 10 }).rows[0];
  h.assistant.sourceRecovery = {
    startForIncident(id, payload, auth) {
      calls.push("source-recovery-start");
      assert.equal(id, incident.id);
      assert.equal(payload.candidateVersion, undefined, "historical candidates have no owner-proposal version; the separate Telegram token is bound to their fingerprint");
      assert.equal(auth.source, "telegram_owner_button");
      assert.equal(auth.channel, "telegram");
      assert.equal(auth.actor, "77");
      assert.match(auth.expectedCandidateFingerprint, /^[a-f0-9]{64}$/);
      return { id: "synthetic-operation", target: { sheet: "Товары", cell: "P194" } };
    },
    async waitForOperation() { return { status: "verified", target: { sheet: "Товары", cell: "P194" }, after: { userEnteredValue: { stringValue: candidate.value.stringValue }, effectiveValue: { stringValue: candidate.value.stringValue }, formattedValue: candidate.value.stringValue } }; },
  };
  await flushTelegram(h.store, { enabled: true, token: telegram.token, chatId: "77" }, { telegramAssistant: telegram });
  const notice = sent.at(-1);
  assert.match(notice.text, /Артикул: FT0001\.A0002\(OZ\)/);
  assert.match(notice.text, /Товары!P194/);
  assert.match(notice.text, /Предлагается: Наклейки А5 5-6 листов/);
  assert.match(notice.text, /Источник эталона: Утверждённый снимок каталога/);
  assert.doesNotMatch(notice.text, /[{}]|ID инцидента|repair_requests/);
  const [[confirmButton, rejectButton], [detailsButton]] = notice.reply_markup.inline_keyboard;
  assert.equal(confirmButton.text, "Исправить");
  assert.equal(rejectButton.text, "Отклонить");
  assert.equal(detailsButton.text, "Подробнее");
  assert.equal(calls.includes("source-recovery-start"), false, "notification has no write side effect");
  const callback = (id, data, user = 77) => ({ update_id: id, callback_query: { id: `cb-${id}`, data, from: { id: user }, message: { chat: { id: 77, type: "private" } } } });
  await telegram.process(callback(101, confirmButton.callback_data, 88));
  assert.equal(calls.includes("source-recovery-start"), false, "foreign Telegram identity cannot act");
  await telegram.process(callback(102, confirmButton.callback_data));
  assert.equal(calls.filter((x) => x === "source-recovery-start").length, 1, "owner click starts the existing writer");
  assert.ok(sent.some((item) => /Исправление запущено: Товары!P194/.test(item.text)));
  await telegram.process(callback(103, confirmButton.callback_data));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((x) => x === "source-recovery-start").length, 1);
  assert.equal(calls.filter((x) => x === "source-recovery-start").length, 1, "a second update cannot reuse a consumed confirmation");
  assert.ok(sent.some((x) => /Исправлено и проверено: Товары!P194/.test(x.text)));
  assert.ok(sent.some((x) => /Исправлено и проверено: Товары!P194 = Наклейки А5 5-6 листов/.test(x.text)), "GridData result is shown as the actual restored value");
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM source_recovery_operations").get().n, 0, "synthetic flow never touches production operation tables");
  h.store.close();
});

test("Telegram approval token expires or becomes stale when the incident generation changes", async () => {
  let clock = Date.now();
  const h = harness({ now: () => new Date(clock) }), sent = [], methods = [];
  const telegram = new TelegramAssistant({ assistant: h.assistant, store: h.store, now: () => clock, fetcher: async (url, options) => { methods.push(String(url).split("/").at(-1)); sent.push(JSON.parse(options.body)); return Response.json({ ok: true, result: true }); } });
  telegram.token = "12345:abcdefghijklmnopqrstuvwxyz";
  h.store.db.prepare("INSERT INTO assistant_owner(id,user_id,chat_id,bound_at) VALUES(1,'77','77',?)").run(new Date(clock).toISOString());
  const candidate = { status: "candidate", version: "b".repeat(64), value: { stringValue: "Однозначное значение" }, evidence: "утверждено" };
  h.store.reconcile("doctor:stale", [{ kind: "table_doctor", sourceId: "ozon", sourceName: "OZON", sheet: "Товары", gid: 123, cell: "P194", type: "data_quality_root_cause", title: "Пустое поле", cause: "Поле отсутствует", severity: "high", found: "", expected: "текст", status: "open", verification: "rule_confirmed", demonstration: false, sourceState: "missing", recoveryCandidate: candidate }]);
  const incident = h.store.listIncidents({ status: "active", page: 0, limit: 10 }).rows[0];
  await telegram.sendIncident(incident);
  const action = sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
  h.store.db.prepare("UPDATE incidents SET generation=generation+1 WHERE id=?").run(incident.id);
  await telegram.process({ update_id: 501, callback_query: { id: "stale", data: action, from: { id: 77 }, message: { chat: { id: 77, type: "private" } } } });
  assert.ok(methods.includes("answerCallbackQuery"));
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM telegram_repair_actions WHERE consumed_at IS NOT NULL").get().n, 0);
  h.store.close();
});

test("Telegram owner repair works without Tailscale and still uses one-use owner callback", async () => {
  const h = harness(), sent = [];
  const telegram = new TelegramAssistant({ assistant: h.assistant, store: h.store, fetcher: async (url, options) => { sent.push({ method: String(url).split("/").at(-1), ...JSON.parse(options.body || "{}") }); return Response.json({ ok: true, result: true }); } });
  telegram.token = "12345:abcdefghijklmnopqrstuvwxyz";
  h.store.db.prepare("INSERT INTO assistant_owner(id,user_id,chat_id,bound_at) VALUES(1,'77','77',?)").run(new Date().toISOString());
  const candidate = { status: "candidate", version: "c".repeat(64), value: { stringValue: "Синтетическое значение" }, evidence: "синтетический эталон" };
  h.store.reconcile("doctor:no-https", [{ kind: "table_doctor", sourceId: "ozon", sourceName: "OZON", sheet: "Товары", gid: 123, cell: "P194", type: "data_quality_root_cause", title: "Пустое поле", cause: "Поле отсутствует", severity: "high", found: "", expected: "текст", status: "open", verification: "rule_confirmed", demonstration: false, sourceState: "missing", recoveryCandidate: candidate }]);
  const incident = h.store.listIncidents({ status: "active", page: 0, limit: 10 }).rows[0];
  let operationCount = 0;
  h.assistant.sourceRecovery = {
    startForIncident(id, payload, auth) {
      operationCount++;
      assert.equal(id, incident.id);
      assert.equal(payload.explicitWriteApproval, true);
      assert.equal(auth.source, "telegram_owner_button");
      return { id: "synthetic-operation", target: { sheet: "Товары", cell: "P194" } };
    },
    async waitForOperation() { return { status: "verified", target: { sheet: "Товары", cell: "P194" }, after: { stringValue: candidate.value.stringValue } }; },
  };
  await telegram.sendIncident(incident);
  const approve = sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
  await telegram.process({ update_id: 601, callback_query: { id: "no-https", data: approve, from: { id: 77 }, message: { chat: { id: 77, type: "private" } } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operationCount, 1);
  assert.ok(sent.some((item) => /Исправлено и проверено: Товары!P194/.test(item.text || "")));
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM source_recovery_operations").get().n, 0);
  h.store.close();
});

test("Telegram status reflects a verified Bot API connection and clears on stop", async () => {
  const h = harness();
  const telegram = new TelegramAssistant({
    assistant: h.assistant,
    store: h.store,
    fetcher: async (url, options) => {
      if (url.endsWith("/getMe"))
        return new Response(JSON.stringify({ ok: true, result: { username: "ritm_test_bot" } }), { status: 200 });
      await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    },
  });
  await telegram.setToken("12345:abcdefghijklmnopqrstuvwxyz");
  for (let attempt = 0; attempt < 20 && !telegram.connected; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.assistant.configView().telegramConnected, true);
  assert.equal(h.assistant.configView().telegramBotName, "ritm_test_bot");
  await telegram.stop();
  assert.equal(h.assistant.configView().telegramConnected, false);
  h.store.close();
});

test("LLM uses one allowlisted tool, caps requests, and records provider usage", async () => {
  let requestBody;
  const h = harness({
    fetcher: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          ok: true,
          usage: { prompt_tokens: 100, completion_tokens: 20 },
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: { name: "get_active_incidents", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  h.config.assistant.apiKey = "test-key";
  const answer = await h.assistant.respond("Привет, расскажи коротко", {
    channel: "telegram",
    actor: "77",
  });
  assert.equal(answer.tool, "get_active_incidents", answer.text);
  assert.equal(requestBody.tools.length, 12);
  assert.equal(
    h.store.db.prepare("SELECT count(*) n FROM assistant_usage").get().n,
    1,
  );
  assert.ok(
    h.store.db
      .prepare(
        "SELECT count(*) n FROM assistant_audit WHERE event='llm_usage_recorded'",
      )
      .get().n === 1,
  );
  h.store.close();
});

test("Anthropic adapter validates tool input and records Anthropic token usage", async () => {
  let captured;
  const h = harness({
    fetcher: async (url, options) => {
      captured = {
        url,
        headers: options.headers,
        body: JSON.parse(options.body),
      };
      return new Response(
        JSON.stringify({
          usage: { input_tokens: 120, output_tokens: 24 },
          content: [
            { type: "tool_use", name: "get_active_incidents", input: {} },
          ],
        }),
        { status: 200 },
      );
    },
  });
  h.config.assistant.provider = "anthropic";
  h.config.assistant.model = "claude-sonnet-4-6";
  h.config.assistant.apiKey = "anthropic-test-key";
  const answer = await h.assistant.respond("Здравствуйте", {
    channel: "web",
    actor: "owner",
  });
  assert.equal(answer.tool, "get_active_incidents", answer.text);
  assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
  assert.equal(captured.headers["x-api-key"], "anthropic-test-key");
  assert.equal(captured.body.tools.length, 12);
  assert.equal(
    h.store.db
      .prepare(
        "SELECT count(*) n FROM assistant_audit WHERE event='llm_usage_recorded'",
      )
      .get().n,
    1,
  );
  h.store.close();
});

test("DPAPI secret store persists only ciphertext and can be exercised with an injected protector", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ritm-assistant-secret-"));
  try {
    const store = new LocalSecretStore(dir, {
      encrypt: async (text) => "cipher:" + Buffer.from(text).toString("base64"),
      decrypt: async (value) =>
        Buffer.from(value.replace(/^cipher:/, ""), "base64").toString("utf8"),
    });
    await store.write({
      telegramToken: "secret-token",
      llmApiKey: "secret-api-key",
    });
    const raw = readFileSync(path.join(dir, "assistant-secrets.dpapi"), "utf8");
    assert.doesNotMatch(raw, /secret-token|secret-api-key/);
    assert.deepEqual(await store.read(), {
      telegramToken: "secret-token",
      llmApiKey: "secret-api-key",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows CurrentUser DPAPI round-trips secrets without plaintext on disk", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ritm-assistant-dpapi-"));
  try {
    const store = new LocalSecretStore(dir);
    const secret = "synthetic-only-secret";
    await store.write({ telegramToken: secret });
    const raw = readFileSync(path.join(dir, "assistant-secrets.dpapi"), "utf8");
    assert.ok(raw.length > 40);
    assert.doesNotMatch(raw, /synthetic-only-secret/);
    assert.equal((await store.read()).telegramToken, secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AI Center assistant settings require an owner session, accept local secret entry, and never return secrets", async () => {
  const h = harness();
  h.config.ownerToken = "a".repeat(40);
  h.config.allowedOrigins = [];
  h.config.apiRateLimit = 180;
  h.config.port = 4318;
  h.config.staticDir = path.join(os.tmpdir(), "missing-ritm-assistant-ui");
  h.config.publicOrigin = "https://ritm-test.ts.net";
  h.config.allowedOrigins.push(h.config.publicOrigin);
  const state = {};
  const secretStore = {
    async read() {
      return { ...state };
    },
    async write(value) {
      Object.assign(state, value);
    },
  };
  const telegramAssistant = {
    approvals: 0,
    async setToken(value) {
      h.config.telegram.token = value;
    },
    async sendTest() {},
    webApprovalDetails(token) {
      return token === "a".repeat(48) ? { document: "OZON", sheet: "Товары", cell: "P194", article: "A1", current: "пусто", proposed: "Тестовое значение", evidence: "синтетический снимок", requiresExclusiveEditing: true } : null;
    },
    async confirmWebApproval(token, exclusiveEditingAcknowledged) {
      assert.equal(token, "a".repeat(48));
      assert.equal(exclusiveEditingAcknowledged, true);
      this.approvals++;
      return { status: "started", cell: "Товары!P194" };
    },
  };
  const server = createAgentServer(h.store, h.config, {
    assistant: h.assistant,
    secretStore,
    telegramAssistant,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(),
    base = `http://127.0.0.1:${address.port}`;
  h.config.allowedOrigins.push(base);
  try {
    const denied = await fetch(base + "/api/intelligence/assistant");
    assert.equal(denied.status, 401);
    const login = await fetch(base + "/api/intelligence/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ token: h.config.ownerToken }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const save = await fetch(base + "/api/intelligence/assistant/configure", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, cookie },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "never-echo-this",
        telegramToken: "12345:abcdefghijklmnopqrstuvwxyz",
        spendLimitUsd: 5,
        dailyRequestLimit: 30,
      }),
    });
    const data = await save.json();
    assert.equal(save.status, 200);
    assert.equal(data.llmConfigured, true);
    assert.equal(data.telegramConfigured, true);
    assert.doesNotMatch(
      JSON.stringify(data),
      /never-echo-this|abcdefghijklmnopqrstuvwxyz/,
    );
    assert.equal(state.llmApiKeys.openai, "never-echo-this");
    const privateHostHeaders = { host: "ritm-test.ts.net", origin: h.config.publicOrigin };
    const privateHeaders = { ...privateHostHeaders, "sec-fetch-site": "same-origin" };
    const page = await requestLocalHttp(address.port, `/telegram-approval?token=${"a".repeat(48)}`, { headers: { host: privateHostHeaders.host, "sec-fetch-site": "cross-site" } });
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /exclusiveEditingAcknowledged/);
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    const deniedDetails = await requestLocalHttp(address.port, `/api/intelligence/telegram-approval?token=${"a".repeat(48)}`, { headers: privateHeaders });
    assert.equal(deniedDetails.status, 401, "approval details need an owner session");
    const publicLogin = await requestLocalHttp(address.port, "/api/intelligence/session", {
      method: "POST",
      headers: { ...privateHeaders, "content-type": "application/json" },
      body: JSON.stringify({ token: h.config.ownerToken }),
    });
    assert.equal(publicLogin.status, 200);
    const publicCookie = publicLogin.headers["set-cookie"][0].split(";")[0];
    const bearerOnly = await requestLocalHttp(address.port, `/api/intelligence/telegram-approval?token=${"a".repeat(48)}`, {
      headers: { ...privateHeaders, authorization: "Bearer " + h.config.ownerToken },
    });
    assert.equal(bearerOnly.status, 403, "phone confirmation requires the owner cookie session, not a bearer key");
    const details = await requestLocalHttp(address.port, `/api/intelligence/telegram-approval?token=${"a".repeat(48)}`, { headers: { ...privateHeaders, cookie: publicCookie } });
    assert.equal(details.status, 200);
    assert.equal(JSON.parse(details.text).proposed, "Тестовое значение");
    const confirmed = await requestLocalHttp(address.port, "/api/intelligence/telegram-approval", {
      method: "POST",
      headers: { ...privateHeaders, cookie: publicCookie, "content-type": "application/json" },
      body: JSON.stringify({ token: "a".repeat(48), exclusiveEditingAcknowledged: true }),
    });
    assert.equal(confirmed.status, 202);
    assert.equal(telegramAssistant.approvals, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    h.store.close();
  }
});
