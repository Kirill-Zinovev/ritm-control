import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { IncidentStore } from "../agent/store.js";
import { RITMAssistant } from "../agent/assistant.js";
import { createAgentServer } from "../agent/server.js";
import { verifyTelegramInitData } from "../agent/telegramMiniApp.js";

const botToken = "12345:synthetic-mini-app-token-for-tests";
function signedInitData(
  user,
  authDate = Math.floor(Date.now() / 1000),
  chatType = null,
) {
  const pairs = [
    ["auth_date", String(authDate)],
    ["query_id", "AAEAA-test-query"],
    ["user", JSON.stringify(user)],
  ];
  if (chatType) pairs.push(["chat_type", chatType]);
  const check = pairs
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const signature = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams([...pairs, ["hash", signature]]).toString();
}

function setupMiniServer() {
  const store = new IncidentStore(":memory:");
  const config = {
    ownerToken: "synthetic-owner-token-that-is-long-enough-123456",
    apiRateLimit: 180,
    port: 4318,
    staticDir: path.join(os.tmpdir(), "ritm-mini-app-no-static"),
    publicOrigin: "https://ritm-mini.example",
    allowedOrigins: ["https://ritm-mini.example"],
    snapshotMaxAgeMs: 60_000,
    sources: [],
    doctorDocuments: [],
    telegram: { token: botToken, chatId: "70001", enabled: true },
    assistant: {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "",
      spendLimitUsd: 1,
      dailyRequestLimit: 5,
    },
  };
  store.db.exec(
    "CREATE TABLE assistant_owner (id INTEGER PRIMARY KEY CHECK(id=1),user_id TEXT NOT NULL,chat_id TEXT NOT NULL,bound_at TEXT NOT NULL)",
  );
  store.db
    .prepare("INSERT INTO assistant_owner VALUES(1,?,?,?)")
    .run("50001", "50001", new Date().toISOString());
  const doctor = {
    getRunStatus: () => null,
    state: () => ({ lastCheck: null, formulaIntelligence: null }),
  };
  const assistant = new RITMAssistant({ store, config, doctor });
  const server = createAgentServer(store, config, { assistant, doctor });
  return { store, config, server, assistant };
}

function request(
  port,
  pathName,
  { method = "GET", headers = {}, body = "" } = {},
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathName, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("Telegram Mini App initData accepts valid owner signature and rejects tampering, expiry and foreign identity", () => {
  const now = Date.now(),
    user = { id: 50001, first_name: "Owner", is_bot: false };
  const valid = signedInitData(user, Math.floor(now / 1000));
  assert.equal(
    verifyTelegramInitData(valid, botToken, { now })?.userId,
    "50001",
  );
  assert.equal(
    verifyTelegramInitData(valid.replace("Owner", "Attacker"), botToken, {
      now,
    }),
    null,
  );
  assert.equal(
    verifyTelegramInitData(
      signedInitData(user, Math.floor(now / 1000) - 600),
      botToken,
      { now },
    ),
    null,
  );
  assert.equal(
    verifyTelegramInitData(signedInitData({ ...user, id: 99999 }), botToken, {
      now,
    })?.userId,
    "99999",
  );
  assert.equal(
    verifyTelegramInitData(valid + "&auth_date=1", botToken, { now }),
    null,
  );
});

test("Mini App requires signed initData for the bound owner and rejects frontend identity or CSRF bypass", async () => {
  const h = setupMiniServer();
  await new Promise((resolve) => h.server.listen(0, "127.0.0.1", resolve));
  const port = h.server.address().port;
  const headers = {
    host: "ritm-mini.example",
    origin: h.config.publicOrigin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  try {
    const foreign = await request(port, "/api/mini/session", {
      method: "POST",
      headers,
      body: JSON.stringify({
        initData: signedInitData({ id: 99999, first_name: "Other" }),
      }),
    });
    assert.equal(foreign.status, 401);
    const group = await request(port, "/api/mini/session", {
      method: "POST",
      headers,
      body: JSON.stringify({
        initData: signedInitData(
          { id: 50001, first_name: "Owner" },
          undefined,
          "group",
        ),
      }),
    });
    assert.equal(
      group.status,
      401,
      "the bound owner cannot open the private production console from a group context",
    );
    const forged = await request(port, "/api/mini/session", {
      method: "POST",
      headers,
      body: JSON.stringify({
        initData: signedInitData({ id: 50001, first_name: "Owner" }),
        user_id: "50001",
      }),
    });
    assert.equal(
      forged.status,
      401,
      "frontend identity fields cannot override signed initData",
    );
    const login = await request(port, "/api/mini/session", {
      method: "POST",
      headers,
      body: JSON.stringify({
        initData: signedInitData({ id: 50001, first_name: "Owner" }),
      }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers["set-cookie"][0], /HttpOnly/);
    assert.match(login.headers["set-cookie"][0], /Secure/);
    assert.match(login.headers["set-cookie"][0], /SameSite=Strict/);
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const dashboard = await request(port, "/api/mini/dashboard", {
      headers: { ...headers, cookie },
    });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.json.ok, true);
    const outOfScope = await request(port, "/api/intelligence/assistant", {
      headers: { ...headers, cookie },
    });
    assert.equal(
      outOfScope.status,
      403,
      "Mini App session cannot access AI Center settings or general owner APIs",
    );
    const noCsrf = await request(port, "/api/mini/check", {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify({ mode: "deep" }),
    });
    assert.equal(noCsrf.status, 403);
    const chatWithoutCsrf = await request(
      port,
      "/api/intelligence/assistant/chat",
      {
        method: "POST",
        headers: { ...headers, cookie },
        body: JSON.stringify({ message: "статус" }),
      },
    );
    assert.equal(chatWithoutCsrf.status, 403);
    const injectedUser = await request(port, "/api/mini/check", {
      method: "POST",
      headers: { ...headers, cookie, "x-ritm-miniapp": "1" },
      body: JSON.stringify({ mode: "deep", user_id: "99999" }),
    });
    assert.equal(injectedUser.status, 400);
  } finally {
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
    h.store.close();
  }
});

test("Mini App check endpoint accepts only typed read-only checks for the bound owner", async () => {
  const h = setupMiniServer();
  let starts = 0;
  h.assistant.callTool = async (_channel, actor, tool, args) => {
    assert.equal(actor, "50001");
    assert.equal(tool, "run_deep_check");
    assert.deepEqual(args, {});
    starts++;
    return {
      status: "started",
      mode: "deep",
      message: "Глубокая проверка запущена",
    };
  };
  await new Promise((resolve) => h.server.listen(0, "127.0.0.1", resolve));
  const port = h.server.address().port;
  const baseHeaders = {
    host: "ritm-mini.example",
    origin: h.config.publicOrigin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  try {
    const login = await request(port, "/api/mini/session", {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        initData: signedInitData({ id: 50001, first_name: "Owner" }),
      }),
    });
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const check = await request(port, "/api/mini/check", {
      method: "POST",
      headers: { ...baseHeaders, cookie, "x-ritm-miniapp": "1" },
      body: JSON.stringify({ mode: "deep" }),
    });
    assert.equal(check.status, 202);
    assert.equal(check.json.mode, "deep");
    assert.equal(starts, 1);
    const bad = await request(port, "/api/mini/check", {
      method: "POST",
      headers: { ...baseHeaders, cookie, "x-ritm-miniapp": "1" },
      body: JSON.stringify({ mode: "deep", document: 123 }),
    });
    assert.equal(
      bad.status,
      400,
      "unsupported scope cannot trigger arbitrary checks",
    );
    assert.equal(starts, 1);
  } finally {
    h.server.closeAllConnections();
    await new Promise((resolve) => h.server.close(resolve));
    h.store.close();
  }
});

test("Mini App repair needs an exact second confirmation and cannot call a writer from a single action", async () => {
  const h = setupMiniServer();
  h.config.productionRepairEnabled = true;
  const incidentId = h.store.reconcile(
    "doctor:mini",
    [
      {
        kind: "table_doctor",
        sourceId: "ozon",
        sourceName: "OZON",
        sheet: "Товары",
        gid: 123,
        cell: "P194",
        type: "data_quality_root_cause",
        title: "Нет обязательного поля",
        severity: "high",
        productKey: "AS0012.A6707(OZ)",
        found: "пусто",
        verification: "rule_confirmed",
        recoveryCandidate: {
          status: "candidate",
          value: { stringValue: "Наклейки А5" },
          evidence: "Подтверждённый снимок SQLite",
        },
      },
    ],
    { verified: false },
  )[0];
  const incident = h.store.getIncident(incidentId);
  let starts = 0;
  const sourceRecovery = {
    context: () => ({
      incidentRow: { generation: 1 },
      candidate: {
        version: "c".repeat(64),
        value: { stringValue: "Наклейки А5" },
        evidence: "Подтверждённый снимок SQLite",
      },
      incident: { ...incident, id: incident.id },
      target: {
        documentId: "doc",
        sheetId: 123,
        sheet: "Товары",
        cell: "P194",
      },
      productKey: "AS0012.A6707(OZ)",
      doc: { name: "OZON" },
    }),
    readLive: async () => ({ synthetic: true }),
    validateBefore: () => ({ alreadyRestored: false }),
    startForIncident(id, payload, authorization) {
      starts++;
      assert.equal(id, incident.id);
      assert.equal(payload.explicitWriteApproval, true);
      assert.equal(payload.candidateVersion, "c".repeat(64));
      assert.equal(authorization.source, "telegram_mini_app");
      return { id: "synthetic-operation", status: "repairing" };
    },
    state: () => ({ operation: null }),
  };
  const repair = { production: true, state: () => ({ proposals: [] }) };
  const server = createAgentServer(h.store, h.config, {
    assistant: h.assistant,
    doctor: h.assistant.doctor,
    sourceRecovery,
    repair,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseHeaders = {
    host: "ritm-mini.example",
    origin: h.config.publicOrigin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  try {
    const login = await request(port, "/api/mini/session", {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        initData: signedInitData({ id: 50001, first_name: "Owner" }),
      }),
    });
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const headers = { ...baseHeaders, cookie, "x-ritm-miniapp": "1" };
    const prepared = await request(port, "/api/mini/repair/prepare", {
      method: "POST",
      headers,
      body: JSON.stringify({ incidentId: incident.id }),
    });
    assert.equal(prepared.status, 200, prepared.json.message);
    assert.equal(prepared.json.proposal.current, "Пусто");
    assert.equal(prepared.json.proposal.proposed, "Наклейки А5");
    assert.equal(
      starts,
      0,
      "preparing shows an exact proposal but never starts Source Recovery",
    );
    const token = prepared.json.proposal.token;
    const unconfirmed = await request(port, "/api/mini/repair/confirm", {
      method: "POST",
      headers,
      body: JSON.stringify({ token, exclusiveEditingAcknowledged: false }),
    });
    assert.equal(unconfirmed.status, 400);
    assert.equal(starts, 0);
    const confirmed = await request(port, "/api/mini/repair/confirm", {
      method: "POST",
      headers,
      body: JSON.stringify({ token, exclusiveEditingAcknowledged: true }),
    });
    assert.equal(confirmed.status, 202);
    assert.equal(starts, 1);
    const replay = await request(port, "/api/mini/repair/confirm", {
      method: "POST",
      headers,
      body: JSON.stringify({ token, exclusiveEditingAcknowledged: true }),
    });
    assert.equal(replay.status, 409);
    assert.equal(starts, 1, "one-time token prevents a duplicate queue action");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    h.store.close();
  }
});
