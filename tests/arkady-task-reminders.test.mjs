import test from "node:test";
import assert from "node:assert/strict";
import { cloudApi, maintenance } from "../worker/cloud/runtime.js";
import { CloudStore } from "../worker/cloud/store.js";
import { encryptBitrixConfig } from "../worker/cloud/bitrixNotifications.js";
import { listBitrixRecipients } from "../worker/cloud/bitrixRecipients.js";
import { evaluateProductionTaskReminder, productionTaskReminderVerifier } from "../worker/cloud/productionTaskReminderChecks.js";
import { drainProductionTaskReminders, TASK_REMINDER_KIND } from "../worker/cloud/productionTaskReminders.js";
import { cancelProductionControl, createProductionControl, createProductionControlBatch } from "../worker/cloud/productionControls.js";
import { LocalD1 } from "./helpers/d1-sqlite.mjs";
import { cloudSchemaStatements } from "./helpers/cloud-schema.mjs";
import { bindings } from "./cloud-env.mjs";

const body = init => JSON.parse(init.body);
const person = { ID: "42", NAME: "Ирина", LAST_NAME: "Смирнова", ACTIVE: true, USER_TYPE: "employee" };
const recipient = { id: "42", name: "Смирнова Ирина" };
const bitrix = {
  RITM_BITRIX_WEBHOOK_URL: "https://kaleidoskop.bitrix24.ru/rest/1/fixtureWebhookToken1/",
  RITM_BITRIX_BOT_TOKEN: "fictional-client-key",
  RITM_BITRIX_BOT_ID: "5768",
  RITM_BITRIX_BOX_CHAT: "chat37626",
  RITM_BITRIX_ROLL_CHAT: "chat37628",
};
const shipmentId = "RITM-SUPPLY-87878888-0000-4000-8000-000000000001";
const shipmentName = "OZON Тест · 1 магазин";
const task = {
  action: "create", requestId: "11111111-1111-4111-8111-111111111111",
  shipmentIds: [shipmentId], shipmentName, scope: "shipment",
  kind: "notification", priority: "attention", trigger: "shipment_received",
  title: "Проверить упаковку", note: "Посмотреть этикетки в коробах",
};
const fixture = (t) => {
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(";\n"));
  t.after(() => db.close());
  return db;
};
const request = (name, input, user = "owner") => new Request("https://ritm.test" + name, {
  method: input ? "POST" : "GET",
  headers: { "oai-authenticated-user-id": user, origin: "https://ritm.test", "content-type": "application/json" },
  ...(input && { body: JSON.stringify(input) }),
});

test("directory keeps only confirmed employees across Bitrix pagination", async () => {
  const starts = [];
  const result = await listBitrixRecipients(bitrix, async (_url, init) => {
    const { start, select } = body(init);
    starts.push(start);
    assert.ok(select.includes("USER_TYPE"));
    return Response.json(start ? {
      result: [{ ...person, ID: "45", NAME: "Вера", ACTIVE: "Y" }],
    } : {
      result: [person, { ...person, ID: "10", USER_TYPE: "extranet" }, { ...person, ID: "18", ACTIVE: false }],
      next: 50,
    });
  });
  assert.deepEqual(starts, [0, 50]);
  assert.deepEqual(result.map(value => value.id), ["45", "42"]);
  await assert.rejects(
    listBitrixRecipients(bitrix, async () => Response.json({ error: "insufficient_scope" }, { status: 403 })),
    { code: "bitrix_directory_unavailable" },
  );
});

test("manager endpoint saves one future private schedule and maintenance sends only once per due cycle", async (t) => {
  const db = fixture(t);
  let now = Date.now();
  const store = new CloudStore(db, { now: () => now });
  const env = {
    ...bindings, DB: db, RITM_OWNER_USER_IDS: "owner", RITM_GOOGLE_READER_JSON: "{}",
    RITM_ASSEMBLY_SYNC_SECRET: "a".repeat(64),
    RITM_CLOUD_WRITES_ENABLED: "true", RITM_CLOUD_CUTOVER_ID: "synthetic",
  };
  await store.withScope(async scope => {
    scope.meta("migrationReady", true);
    scope.meta("bitrixNotificationConfig", await encryptBitrixConfig(env, bitrix));
  });
  const outgoing = [];
  let directory = 0;
  let directoryDenied = false;
  const fetcher = async (url, init) => {
    if (url.endsWith("user.get")) {
      directory++;
      if (directoryDenied) return Response.json({ error: "scope" }, { status: 403 });
      const id = body(init).filter.ID;
      return Response.json({ result: !id || id === 42 ? [person] : [] });
    }
    assert.ok(url.endsWith("imbot.message.add"), url);
    outgoing.push(body(init));
    return Response.json({ result: 234 + outgoing.length });
  };
  const api = req => cloudApi(req, env, {}, { fetcher });
  const path = "/api/production-controls";
  assert.equal((await api(request(path + "?view=bitrix-recipients", null, "other"))).status, 403);
  assert.equal(directory, 0);
  assert.deepEqual(await (await api(request(path + "?view=bitrix-recipients"))).json(), { ok: true, recipients: [recipient] });
  const remindAt = new Date(now + 60_000).toISOString();
  const input = { ...task, bitrixReminder: { recipientId: "42", remindAt, intervalMinutes: 60, check: "manual" } };
  assert.equal((await api(request(path, { ...input, bitrixReminder: { ...input.bitrixReminder, recipientId: "43" } }))).status, 409);
  const saved = await (await api(request(path, input))).json();
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual(saved.control.bitrixReminder, { ...input.bitrixReminder, recipientName: recipient.name, status: "scheduled", nextAt: remindAt });
  directoryDenied = true;
  assert.equal((await (await api(request(path, input))).json()).duplicate, true);
  directoryDenied = false;
  assert.equal(outgoing.length, 0);
  const run = () => maintenance(env, store, { fetcher, refresh: false });
  await run();
  assert.equal(outgoing.length, 0);
  now += 60_000;
  await run();
  await run();
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].DIALOG_ID, "42");
  assert.ok(JSON.stringify(outgoing[0].ATTACH).includes(task.note));
  const [recurring] = await store.readOperationsByKind(TASK_REMINDER_KIND);
  assert.equal(recurring.status, "scheduled");
  assert.equal(recurring.nextAt, new Date(now + 60 * 60_000).toISOString());
  assert.equal((await api(request(path, { action: "cancel", controlId: task.requestId }))).status, 200);
  now += 60 * 60_000;
  await run();
  assert.equal(outgoing.length, 1);
  assert.equal((await store.readOperationsByKind(TASK_REMINDER_KIND))[0].status, "cancelled");
});

test("grouped article tasks share one schedule and an unconfirmed delivery never repeats", async (t) => {
  const db = fixture(t);
  let now = Date.now();
  const store = new CloudStore(db, { now: () => now });
  const articles = ["AA0001.A1000", "AA0001.A1001"];
  const remindAt = new Date(now + 60_000).toISOString();
  const input = { ...task, articles, bitrixReminder: { recipientId: "42", remindAt, intervalMinutes: 60 } };
  const { controls } = await store.withScope(scope =>
    createProductionControlBatch(scope, input, { now: () => now, reminderRecipient: recipient }));
  assert.equal((await store.readOperationsByKind(TASK_REMINDER_KIND)).length, 1);
  await store.withScope(scope => cancelProductionControl(scope, { controlId: controls[0].id }, { now: () => now }));
  let deliveries = 0;
  const options = {
    verify: async (_schedule, rows) => {
      assert.deepEqual(rows.map(row => row.article), articles.slice(1));
      return "unconfirmed";
    },
    readRecipient: async () => recipient,
    send: async (record, rows) => {
      deliveries++;
      assert.equal(record.checkStatus, "unconfirmed");
      assert.deepEqual(rows.map(row => row.article), articles.slice(1));
      return { status: "sent" }; // No proof that the provider accepted it.
    },
  };
  now += 60_000;
  await drainProductionTaskReminders(store, options);
  now += 120 * 60_000;
  await drainProductionTaskReminders(store, options);
  assert.equal(deliveries, 1);
  assert.equal((await store.readOperationsByKind(TASK_REMINDER_KIND))[0].status, "uncertain");
});

test("facts verify exact planned rows, authoritative store and active Assembly-only goods", async () => {
  const article = "AA0001.A1000", now = Date.now();
  const roll = { sheetId: 1, sourceId: "roll-printing", name: shipmentName };
  const box = { sheetId: 1, sourceId: "box-printing", name: shipmentName, assemblyShipmentId: shipmentId };
  const row = { sheetId: 1, uid: "roll", sourceId: "roll-printing", assemblyShipmentId: shipmentId, sheetName: shipmentName,
    quantity: 10, printProgress: 10, cutProgress: 10, packed: 10, article, shopCatalogStatus: "missing" };
  const printing = { ok: true, quality: { status: "valid" }, sheets: [roll, box],
    supplies: [row, { ...row, uid: "box", sourceId: "box-printing", cutProgress: 0 }],
    packing: { status: "available", invalidRecords: 0, checkedAt: new Date(now).toISOString() } };
  const control = { ...task, id: task.requestId, shipmentIds: [shipmentId, "RITM-ROLL-1"] };
  const check = (kind, options = {}, selected = control) =>
    evaluateProductionTaskReminder(kind, [selected], { printing, now, extraItems: [], ...options });
  assert.equal(await check("production"), "open");
  printing.supplies[1].cutProgress = null;
  assert.equal(await check("production"), "unconfirmed");
  printing.supplies[1].cutProgress = 10;
  assert.equal(await check("production"), "closed");
  assert.equal(await check("production", { printing: { ...printing, stale: true } }), "unconfirmed");
  assert.equal(await check("packing"), "closed");
  assert.equal(await check("packing", { extraItems: [{ shipmentId, article: "AA0001.A1001" }] }), "unconfirmed");
  let lookups = 0;
  const readCatalog = (market, selected) => {
    lookups++;
    assert.equal(market, "OZON");
    assert.deepEqual(selected, [article]);
    return [{ article, store: "2" }];
  };
  assert.equal(await check("catalog-exists", { readCatalog }, { ...control, scope: "article", article }), "open");
  assert.equal(await check("catalog-exists", { readCatalog: () => [{ article, store: "1" }] }, { ...control, scope: "article", article }), "closed");
  assert.equal(await check("catalog-exists", { readCatalog }, { ...control, scope: "article", article: "AA0001.A9999" }), "unconfirmed");
  assert.equal(lookups, 1);
});

test("a fresh confirmed production snapshot closes the schedule without changing the Assembly task", async (t) => {
  const db = fixture(t);
  let now = Date.now();
  const store = new CloudStore(db, { now: () => now });
  const remindAt = new Date(now + 60_000).toISOString();
  const input = { ...task, bitrixReminder: { recipientId: "42", remindAt, intervalMinutes: 60, check: "production" } };
  await store.withScope(scope => createProductionControl(scope, input, { now: () => now, reminderRecipient: recipient }));
  const sheet = { sheetId: 1, sourceId: "roll-printing", name: shipmentName, assemblyShipmentId: shipmentId };
  const snapshot = {
    ok: true, sheets: [sheet], quality: { status: "valid" },
    supplies: [{ ...sheet, sheetName: shipmentName, uid: "roll", article: "AA0001.A1000", quantity: 10, printProgress: 10, cutProgress: 10 }],
  };
  const save = () => store.withScope(scope => store.saveSnapshot("printing", snapshot, scope.lease));
  await save();
  now += 20 * 60_000;
  let attempts = 0;
  const drain = () => drainProductionTaskReminders(store, {
    verify: productionTaskReminderVerifier({}, store),
    readRecipient: async () => recipient,
    send: async record => {
      assert.equal(record.checkStatus, "unconfirmed");
      attempts++;
      return { status: "sent", messageId: 123 };
    },
  });
  await drain();
  assert.equal(attempts, 1);
  now += 60 * 60_000;
  await save();
  await drain();
  await drain();
  const [record] = await store.readOperationsByKind(TASK_REMINDER_KIND);
  assert.equal(attempts, 1);
  assert.equal(record.checkStatus, "closed");
  assert.equal(record.status, "completed");
  assert.equal((await store.readOperationsByKind("production-control"))[0].status, "active");
});
