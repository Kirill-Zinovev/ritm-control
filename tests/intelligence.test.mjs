import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  inspectAssemblyRows,
  HISTORY_HEADERS,
} from "../worker/assemblyDiagnostics.js";
import {
  parseAssemblyRows,
  loadAssembly,
  summarizeAssembly,
} from "../worker/assembly.js";
import { collectJournalPrinting, indexOrders } from "../worker/printing.js";
import {
  DEFAULT_SOURCES,
  validateRegistry,
  cellLink,
} from "../agent/registry.js";
import { loadConfig, publicConfig } from "../agent/config.js";
import { IncidentStore } from "../agent/store.js";
import {
  Monitor,
  freshnessFinding,
  issueFinding,
  retryingFetch,
} from "../agent/monitor.js";
import { inspectGeneric, validateApi } from "../agent/adapters.js";
import { createAgentServer } from "../agent/server.js";
import { flushTelegram } from "../agent/telegram.js";

const now = new Date("2026-10-08T09:00:00Z"),
  assemblySource = DEFAULT_SOURCES[0];
const csv = (rows, headers = HISTORY_HEADERS) =>
  [headers, ...rows]
    .map((r) =>
      r.map((v) => '"' + String(v ?? "").replaceAll('"', '""') + '"').join(","),
    )
    .join("\r\n");
const row = (id = "1", coeff = "0,75", date = "08.10.2026") => [
  date,
  "Оля",
  "3",
  "1",
  "4",
  "6",
  "10",
  coeff,
  "ПВХ — 4",
  "Короб — 6",
  "08.10.2026 12:00:00",
  id,
];
function payload(rows = [row()]) {
  const v = inspectAssemblyRows(csv(rows));
  return {
    ok: true,
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    sourceUpdatedAt: v.sourceUpdatedAt,
    date: "2026-10-08",
    period: "day",
    rows: summarizeAssembly(v.records, "2026-10-08"),
    history: v.records.map((r) => ({ ...r, days: 1 })),
    issues: v.issues,
    quality: v.quality,
  };
}
function config() {
  return {
    ...loadConfig({ RITM_OWNER_TOKEN: randomBytes(32).toString("hex") }),
    sources: [structuredClone(assemblySource)],
    retries: 0,
    apiBase: "",
    timeoutMs: 5000,
  };
}
const finding = () =>
  issueFinding(assemblySource, {
    code: "invalid_number",
    source: "История производства",
    cell: "H247",
    row: 247,
    found: "#VALUE!",
    expected: "Коэффициент ≥ 0",
    message: "Повреждён коэффициент сборки",
  });
test("damaged numbers and formula errors never become zero or accepted KPI", () => {
  for (const value of [
    "#REF!",
    "#N/A",
    "#VALUE!",
    "#DIV/0!",
    "abc",
    "",
    "Infinity",
    "-2",
    "0x10",
    "1e3",
  ]) {
    const result = inspectAssemblyRows(csv([row("1", value)]));
    assert.equal(result.records.length, 0, value);
    assert.equal(result.quality.status, "partial");
    assert.equal(result.issues[0].cell, "H2");
  }
  assert.equal(parseAssemblyRows(csv([row("1", "0")]))[0].coefficient, 0);
});
test("impossible dates, quantities, missing keys and duplicate keys are quarantined", () => {
  const badQty = row();
  badQty[5] = "1,2";
  const data = inspectAssemblyRows(
    csv([
      row("dupe"),
      row("dupe"),
      row(""),
      row("bad-date", "0,2", "31.02.2026"),
      badQty,
    ]),
  );
  assert.equal(data.records.length, 0);
  assert.ok(data.issues.some((x) => x.code === "duplicate_uid"));
  assert.ok(data.issues.some((x) => x.code === "missing_uid"));
  assert.ok(data.issues.some((x) => x.code === "invalid_date"));
  assert.ok(data.issues.some((x) => x.code === "invalid_number"));
});
test("valid historical math and source timestamps are retained", () => {
  const data = inspectAssemblyRows(csv([row("1"), row("2", "0,25")]));
  assert.equal(summarizeAssembly(data.records, "2026-10-08")[0].coefficient, 1);
  assert.equal(data.sourceUpdatedAt, now.toISOString());
  assert.equal(data.quality.status, "valid");
});
test("schema changes and Sheets HTTP errors cannot masquerade as no production", async () => {
  assert.throws(
    () => inspectAssemblyRows(csv([row()], ["Other"])),
    /schema changed/,
  );
  await assert.rejects(() =>
    loadAssembly(
      "2026-10-08",
      "day",
      async () => new Response("no", { status: 503 }),
    ),
  );
});
test("registry supports new departments with explicit generic rules and rejects unsafe config", () => {
  const extra = {
    id: "packing",
    name: "Упаковщики",
    documentId: "document_id_for_new_source_123",
    adapter: "csv",
    department: "Упаковка",
    enabled: true,
    sheets: [
      {
        gid: 1,
        name: "Выпуск",
        headerRow: 1,
        dataStartRow: 2,
        checks: [
          { column: "A", type: "unique", header: "ID" },
          { column: "B", type: "integer" },
        ],
      },
    ],
  };
  assert.equal(validateRegistry([...DEFAULT_SOURCES, extra]).length, 3);
  assert.equal(
    inspectGeneric(
      [
        ["ID", "Шт."],
        ["1", "#REF!"],
        ["1", "8"],
      ],
      extra.sheets[0],
    ).length,
    3,
  );
  assert.throws(() => validateRegistry([extra, extra]), /duplicate/);
  assert.throws(() => loadConfig({ RITM_BASE_URL: "http://external.test" }));
  assert.throws(() => loadConfig({ RITM_DEV_ORIGIN: "https://evil.test" }));
  assert.equal(publicConfig(config()).ownerToken, undefined);
});
test("printing diagnostics preserve exclusions, UID errors and links to source cells", () => {
  const order = {
    uid: "o1",
    rawUid: "o1",
    article: "ART",
    sheetId: 437912546,
    sheetName: "OZON НОВЫЙ ГОД",
  };
  const ix = {
    byUid: { o1: order },
    byRaw: { o1: [order] },
    issues: [],
    orders: [order],
  };
  const log = [
    "e1",
    "08.10.2026",
    "Дмитрий",
    "Печать",
    order.sheetName,
    4,
    "ART",
    "o1",
    "д1",
    10,
    "",
    1.76,
  ];
  const result = collectJournalPrinting(ix, [log, log]);
  assert.equal(result.events.length, 0);
  assert.equal(result.issues[0].code, "duplicate_uid");
  const f = issueFinding(DEFAULT_SOURCES[1], result.issues[0]);
  assert.equal(f.cell, "A2");
  assert.match(f.sourceUrl, /gid=725126844&range=A2/);
  const missing = [...log];
  missing[7] = "";
  assert.equal(collectJournalPrinting(ix, [missing]).issues[0].cell, "H2");
});
test("repeat detections update one incident and enqueue one notification", () => {
  const store = new IncidentStore(":memory:");
  try {
    store.reconcile("fbo:data", [finding()], { at: now.toISOString() });
    store.reconcile("fbo:data", [finding()], { at: now.toISOString() });
    const list = store.listIncidents({ search: "СБОРКИ" });
    assert.equal(list.total, 1);
    assert.equal(list.rows[0].occurrences, 2);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM outbox").get().n,
      1,
    );
    store.reconcile("fbo:data", [], { verified: false });
    assert.equal(store.overview().active, 1);
    store.reconcile("fbo:data", [], { verified: true });
    assert.equal(store.overview().resolved, 1);
    assert.equal(store.overview().corrections, 0);
  } finally {
    store.close();
  }
});
test("snapshot and incidents survive abrupt process exit, with lease recovery", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ritm-restart-")),
    file = path.join(dir, "state.sqlite");
  const script =
    'import { IncidentStore } from "./agent/store.js"; const s=new IncidentStore(' +
    JSON.stringify(file) +
    '); s.acquire("crashed"); s.snapshot("assembly", {count:3}); s.reconcile("check",[ {type:"test",title:"Проверка",sourceId:"x"}]); process.exit(42);';
  try {
    assert.throws(() =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: path.resolve("."),
        stdio: "pipe",
      }),
    );
    const store = new IncidentStore(file);
    assert.equal(store.getSnapshot("assembly").value.count, 3);
    assert.equal(store.overview().active, 1);
    assert.equal(store.acquire("second"), false);
    assert.equal(store.acquire("second", Date.now() + 91000), true);
    store.release("second");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("freshness follows an approved calendar, weekends and absent records are not zero", () => {
  const s = structuredClone(assemblySource);
  assert.equal(freshnessFinding(s, payload(), now).configured, false);
  s.freshness = {
    maximumAgeMinutes: 30,
    activeWeekdays: [1, 2, 3, 4, 5],
    startHour: 9,
    endHour: 19,
  };
  const old = { sourceUpdatedAt: "2026-10-07T10:00:00Z" };
  assert.equal(freshnessFinding(s, old, now).findings[0].type, "stale_source");
  assert.equal(
    freshnessFinding(s, old, new Date("2026-10-10T09:00:00Z")).findings.length,
    0,
  );
  const emptyDay = summarizeAssembly(
    parseAssemblyRows(csv([row("1", "0,5", "09.10.2026")])),
    "2026-10-10",
  );
  assert.deepEqual(emptyDay, []);
});
test("source failures preserve old snapshots and do not close existing data incidents", async () => {
  const store = new IncidentStore(":memory:"),
    c = config();
  try {
    store.snapshot(assemblySource.id, payload(), now.toISOString());
    store.reconcile(assemblySource.id + ":data", [finding()]);
    const monitor = new Monitor(store, c, {
      now: () => now,
      loaders: {
        assembly: async () => {
          throw Error("Sheets unavailable");
        },
      },
    });
    await monitor.run();
    assert.equal(
      store.getSnapshot(assemblySource.id).value.rows[0].coefficient,
      0.75,
    );
    assert.equal(store.overview().active, 2);
    assert.equal(
      store.overview().checks.find((x) => x.kind === "source").status,
      "error",
    );
  } finally {
    store.close();
  }
});
test("false KPI decline from damaged records retains the verified snapshot and reports incompleteness", async () => {
  const store = new IncidentStore(":memory:"),
    c = config();
  try {
    store.snapshot(
      assemblySource.id,
      payload([row("1", "1")]),
      now.toISOString(),
    );
    const partial = payload([row("1", "#VALUE!"), row("2", "0,1")]);
    assert.equal(partial.rows[0].coefficient, 0.1);
    assert.equal(partial.quality.status, "partial");
    await new Monitor(store, c, {
      now: () => now,
      loaders: { assembly: async () => partial },
    }).run();
    assert.equal(
      store.getSnapshot(assemblySource.id).value.rows[0].coefficient,
      1,
    );
    assert.equal(
      store.overview().checks.find((x) => x.kind === "source").status,
      "partial",
    );
  } finally {
    store.close();
  }
});
test("unexpected loss of a previously nonempty full history is an incident, empty selected day is not", async () => {
  const store = new IncidentStore(":memory:"),
    c = config();
  try {
    store.snapshot(assemblySource.id, payload(), now.toISOString());
    const empty = payload([]);
    await new Monitor(store, c, {
      now: () => now,
      loaders: { assembly: async () => empty },
    }).run();
    assert.equal(store.listIncidents().rows[0].type, "unexpected_empty");
    assert.equal(store.getSnapshot(assemblySource.id).value.history.length, 1);
  } finally {
    store.close();
  }
});
test("API failure and API contract damage are recorded separately from a healthy source", async () => {
  for (const response of [
    () => new Response("broken", { status: 500 }),
    () =>
      Response.json({
        ...payload(),
        rows: [{ ...payload().rows[0], coefficient: "oops" }],
      }),
  ]) {
    const store = new IncidentStore(":memory:"),
      c = { ...config(), apiBase: "https://ritm.test" };
    try {
      const m = new Monitor(store, c, {
        now: () => now,
        loaders: { assembly: async () => payload() },
        fetcher: async (url) =>
          String(url).includes("/api/")
            ? response()
            : new Response('<div id="root"></div>'),
      });
      await m.run();
      assert.equal(
        store.overview().checks.find((x) => x.id === "api:assembly").status,
        "error",
      );
      assert.equal(
        store.overview().checks.find((x) => x.kind === "source").status,
        "ok",
      );
      assert.ok(
        store.listIncidents().rows.some((x) => x.layer.includes("server")),
      );
    } finally {
      store.close();
    }
  }
});
test("API validators reject duplicates and stale API snapshots are detected", async () => {
  const valid = payload();
  assert.throws(
    () =>
      validateApi(
        { ...valid, history: [...valid.history, ...valid.history] },
        "assembly",
      ),
    /duplicate/,
  );
  const store = new IncidentStore(":memory:"),
    c = { ...config(), apiBase: "https://ritm.test" };
  try {
    await new Monitor(store, c, {
      now: () => now,
      loaders: { assembly: async () => payload() },
      fetcher: async (url) =>
        String(url).includes("/api/")
          ? Response.json({ ...payload(), updatedAt: "2026-10-01T00:00:00Z" })
          : new Response('<div id="root"></div>'),
    }).run();
    assert.ok(store.listIncidents().rows.some((x) => x.type === "stale_api"));
  } finally {
    store.close();
  }
});
test("two tasks cannot overlap, and monitoring does not depend on an AI API", async () => {
  const store = new IncidentStore(":memory:"),
    c = { ...config(), model: "unavailable-model" };
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const m = new Monitor(store, c, {
    now: () => now,
    loaders: {
      assembly: async () => {
        await hold;
        return payload();
      },
    },
    fetcher: async () => {
      throw Error("AI API must not be used");
    },
  });
  try {
    const first = m.run();
    assert.equal(await m.run(), false);
    release();
    await first;
    assert.equal(
      store.overview().checks.find((x) => x.kind === "source").status,
      "ok",
    );
  } finally {
    store.close();
  }
});
test("temporary HTTP failures are retried and permission failures are bounded", async () => {
  let calls = 0;
  const f = retryingFetch(
    async () => {
      calls++;
      return new Response("denied", { status: 403 });
    },
    { retries: 2, timeoutMs: 1000 },
  );
  await assert.rejects(() => f("https://sheets.test"));
  assert.equal(calls, 1);
  calls = 0;
  const retry = retryingFetch(
    async () =>
      ++calls === 1 ? new Response("", { status: 503 }) : new Response("ok"),
    { retries: 1, timeoutMs: 1000 },
  );
  assert.equal((await retry("https://sheets.test")).status, 200);
  assert.equal(calls, 2);
});
test("Telegram unavailability cannot stop monitoring or repeatedly notify an unresolved problem", async () => {
  const store = new IncidentStore(":memory:"),
    tg = { enabled: true, token: "fixture-only", chatId: "1" };
  let sends = 0;
  try {
    store.reconcile("fbo", [finding()]);
    await flushTelegram(store, tg, {
      fetcher: async () => {
        sends++;
        throw Error("network unavailable");
      },
    });
    store.reconcile("fbo", [finding()]);
    await flushTelegram(store, tg, {
      fetcher: async () => {
        sends++;
        throw Error("no");
      },
    });
    assert.equal(sends, 1);
    assert.equal(
      store.db.prepare("SELECT status FROM outbox").get().status,
      "uncertain",
    );
    await new Monitor(store, config(), {
      now: () => now,
      loaders: { assembly: async () => payload() },
    }).run();
    assert.equal(
      store.overview().checks.find((x) => x.kind === "source").status,
      "ok",
    );
  } finally {
    store.close();
  }
});
test("successful Telegram delivery is persistent and 429 is rescheduled", async () => {
  const store = new IncidentStore(":memory:"),
    tg = { enabled: true, token: "fixture-only", chatId: "1" };
  let sends = 0;
  try {
    store.reconcile("fbo", [finding()], { at: now.toISOString() });
    await flushTelegram(store, tg, {
      now,
      fetcher: async () => {
        sends++;
        return Response.json(
          { ok: false, parameters: { retry_after: 60 } },
          { status: 429 },
        );
      },
    });
    await flushTelegram(store, tg, {
      now,
      fetcher: async () => {
        sends++;
        return Response.json({ ok: true });
      },
    });
    assert.equal(sends, 1);
    await flushTelegram(store, tg, {
      now: new Date(now.getTime() + 61000),
      fetcher: async () => {
        sends++;
        return Response.json({ ok: true });
      },
    });
    await flushTelegram(store, tg, {
      now: new Date(now.getTime() + 62000),
      fetcher: async () => {
        sends++;
        return Response.json({ ok: true });
      },
    });
    assert.equal(sends, 2);
    assert.equal(
      store.db.prepare("SELECT status FROM outbox").get().status,
      "sent",
    );
  } finally {
    store.close();
  }
});
test("protected API rejects anonymous reads, writes, foreign origins and schema-free actions; authenticated snapshots are stale-marked", async () => {
  const store = new IncidentStore(":memory:"),
    c = config();
  store.snapshot(assemblySource.id, payload(), now.toISOString());
  store.check(
    assemblySource.id,
    { status: "error", kind: "source" },
    now.toISOString(),
  );
  const server = createAgentServer(store, c, { now: () => now.getTime() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  c.allowedOrigins.push(base);
  try {
    assert.equal((await fetch(base + "/api/intelligence/status")).status, 401);
    assert.equal(
      (await fetch(base + "/api/intelligence/repair", { method: "POST" }))
        .status,
      401,
    );
    const h = { authorization: "Bearer " + c.ownerToken };
    const reply = await fetch(base + "/api/intelligence/status", {
      headers: h,
    });
    const status = await reply.json();
    assert.equal(reply.status, 200);
    assert.equal(status.config.permissionLevel, 1);
    assert.ok(!JSON.stringify(status).includes(c.ownerToken));
    assert.equal(
      (
        await fetch(base + "/api/intelligence/repair", {
          method: "POST",
          headers: h,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/intelligence/status", {
          headers: { ...h, origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + "/api/assembly", { headers: h })).status,
      200,
    );
    assert.equal(
      (await (await fetch(base + "/api/assembly", { headers: h })).json())
        .stale,
      true,
    );
    const login = await fetch(base + "/api/intelligence/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ token: c.ownerToken }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const session = cookie.split(";")[0];
    assert.equal(
      (
        await fetch(base + "/api/intelligence/history", {
          headers: { cookie: session },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/api/intelligence/session", {
          method: "DELETE",
          headers: { cookie: session },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/api/intelligence/status", {
          headers: { cookie: session },
        })
      ).status,
      401,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
test("protected API returns no fabricated KPI before the first successful snapshot", async () => {
  const store = new IncidentStore(":memory:"),
    c = config(),
    server = createAgentServer(store, c);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const r = await fetch(
      "http://127.0.0.1:" + server.address().port + "/api/assembly",
      { headers: { authorization: "Bearer " + c.ownerToken } },
    );
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "no_verified_snapshot");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("printing schema and duplicated order UID point to the affected supply sheet", () => {
  const rows = [
    ["UID"],
    [],
    Array.from({ length: 15 }, (_, i) =>
      i === 4 ? "Артикул" : i === 14 ? "Кол-во" : "",
    ),
    ["order", "", "", "", "article"],
  ];
  const sheet = { gid: 99, name: "Поставка QA", rows };
  const changed = structuredClone(sheet);
  changed.rows[2][4] = "Сломан";
  assert.throws(
    () => indexOrders([changed]),
    (e) => e.issue.source === "Поставка QA" && e.issue.cell === "E3:O3",
  );
  const duplicate = structuredClone(sheet);
  duplicate.rows.push([...duplicate.rows[3]]);
  assert.throws(
    () => indexOrders([duplicate]),
    (e) => e.issue.code === "duplicate_uid" && e.issue.cell === "A5",
  );
});

test("API empty full history conflicts with a healthy nonempty source, while an empty selected day is allowed", async () => {
  const st = new IncidentStore(":memory:"),
    cfg = config();
  cfg.apiBase = "https://example.test";
  const value = payload();
  const response = { ...value, rows: [], history: [] };
  const monitor = new Monitor(st, cfg, {
    now: () => now,
    fetcher: async () => Response.json(response),
  });
  await monitor.api(
    "assembly",
    new Map([[assemblySource.id, { ok: true, value }]]),
  );
  assert.equal(st.listIncidents().rows[0].type, "unexpected_empty_api");
  response.history = value.history;
  await monitor.api(
    "assembly",
    new Map([[assemblySource.id, { ok: true, value }]]),
  );
  assert.equal(st.overview().active, 0);
  st.close();
});
