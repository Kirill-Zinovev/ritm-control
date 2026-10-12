import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PRODUCTION_DOCTOR_DOCUMENTS as docs } from "../agent/productionRegistry.js";
import { reviewDocument } from "../agent/diagnosticReview.js";
import { businessPreview } from "../agent/businessDoctor.js";
import { DiagnosticGovernance } from "../agent/diagnosticGovernance.js";
import { IncidentStore } from "../agent/store.js";
import { loadConfig } from "../agent/config.js";
import { createAgentServer } from "../agent/server.js";
import { offsetRow } from "../agent/diagnosticGrid.js";
const now = new Date("2026-10-09T12:00:00Z");
function sheet(gid, title, entries) {
  const rows = new Map();
  for (const [address, value, formula] of entries) {
    const [, letters, n] = address.match(/^([A-Z]+)(\d+)$/);
    let col = 0;
    for (const x of letters) col = col * 26 + x.charCodeAt(0) - 64;
    const row = rows.get(+n) || [];
    const effectiveValue =
      typeof value === "number"
        ? { numberValue: value }
        : { stringValue: value };
    row[col - 1] = {
      effectiveValue,
      userEnteredValue: formula ? { formulaValue: formula } : effectiveValue,
    };
    rows.set(+n, row);
  }
  return {
    properties: { sheetId: gid, title, gridProperties: { rowCount: 3000 } },
    data: [...rows].map(([n, values]) => ({
      startRow: n - 1,
      rowData: [
        {
          values: Array.from(
            { length: values.length },
            (_, i) => values[i] || {},
          ),
        },
      ],
    })),
  };
}
const fbo = (formula = "=SUM(B2:D2)", value = 1) => ({
  sheets: [
    sheet(0, "Все коэффициенты", [
      ["A2", "Synthetic"],
      ["B2", 0.4],
      ["C2", 0.3],
      ["D2", 0.3],
      ["E2", value, formula],
      ["A10", 11],
      ["E10", 150],
    ]),
  ],
});
const review = (doc, grid) =>
  reviewDocument(doc, grid, businessPreview(doc, grid, now), now);
function setup(grid = fbo(""), file = ":memory:") {
  const store = new IncidentStore(file),
    cfg = {
      ...loadConfig({ RITM_OWNER_TOKEN: randomBytes(32).toString("hex") }),
      doctorDocuments: structuredClone(docs),
      snapshotMaxAgeMs: 1200000,
    };
  let clock = now;
  const governance = new DiagnosticGovernance(store, cfg, { now: () => clock });
  const put = (g) => {
    store.snapshot(
      "doctor-review:doctor-fbo",
      review(docs[0], g),
      clock.toISOString(),
    );
    store.check(
      "doctor-fbo",
      { status: "ok", readVerifiedAt: clock.toISOString() },
      clock.toISOString(),
    );
  };
  put(grid);
  return { store, cfg, governance, put, setClock: (v) => (clock = v) };
}
const approve = (g) => {
  const r = g.state().rules[0];
  return g.decide({
    ruleId: r.id,
    version: r.version,
    decision: "approve",
    acknowledged: true,
  });
};
const except = (g, o = g.state().observations[0]) =>
  g.addException({
    observationId: o.id,
    evidenceVersion: o.evidenceVersion,
    reason: "Согласованная тестовая ручная корректировка",
    expiresAt: "2026-10-10T12:00:00Z",
  });

test("FBO exact B:D template covers employees and excludes numeric special row; no mutations", () => {
  const grid = fbo(),
    before = JSON.stringify(grid),
    r = review(docs[0], grid);
  assert.equal(r.rules[0].rowsChecked, 1);
  assert.equal(r.rules[0].formulaMatches, 1);
  assert.equal(r.observations.length, 0);
  assert.equal(JSON.stringify(grid), before);
});
test("SUM(B) is not source SUM(B:D); numerical equality does not approve a replaced formula", () => {
  for (const formula of ["=SUM(B2)", ""]) {
    const r = review(docs[0], fbo(formula));
    assert.equal(r.observations.length, 1);
    assert.equal(r.observations[0].classification, "suspicious");
    assert.equal(r.observations[0].expected, "=SUM(B2:D2)");
  }
});
test("blank supply rows and zero plan excluded, existing area template covers filled production row", () => {
  const r = review(docs[2], {
    sheets: [
      sheet(437912546, "OZON НОВЫЙ ГОД", [
        ["E4", "Synthetic"],
        ["F4", 2],
        ["H4", 0.2],
        ["I4", 0.3],
        ["O4", 10],
        ["J4", 1.2, "=F4*H4*I4*O4"],
        ["E5", "Zero"],
        ["O5", 0],
        ["J6", 0, "=F6*H6*I6*O6"],
      ]),
    ],
  });
  assert.equal(r.rules[0].rowsChecked, 1);
  assert.equal(r.rules[0].formulaMatches, 1);
  assert.equal(r.observations.length, 0);
});
test("catalog text quantity is input/business discrepancy, not broken SUM; manual K produces separate findings", () => {
  const r = review(docs[1], {
    sheets: [
      sheet(1335787439, "Товары НОВАЯ ПЕЧАТЬ 20.07.2026", [
        ["A2", "Synthetic"],
        ["G2", "11 657"],
        ["K2", 0, "=SUM(G2:J2)"],
        ["A3", "Manual"],
        ["G3", 127],
        ["K3", 1],
      ]),
    ],
  });
  assert.equal(r.rules[0].rowsChecked, 2);
  assert.equal(r.rules[0].deviatingRows, 2);
  assert.equal(r.rules[0].deviations, 3);
  assert.equal(r.observations[0].type, "invalid_input");
  assert.equal(r.observations[0].classification, "business_process");
});
test("ready with remaining one is explained by actual <=5 formula; different status formula not suppressed", () => {
  const entries = [
    ["J3", "Synthetic"],
    ["P3", "готово", '=IF(S3="готово";"готово";"не готово")'],
    ["Q3", 1],
    ["S3", "готово", '=IF(Q3<=5;"готово";"не готово")'],
    ["AA3", 180],
  ];
  const grid = {
    sheets: [
      sheet(1580315960, "Первый магазин НОВАЯ ПЕЧАТЬ 20.07.2026", entries),
      sheet(1335787439, "Товары НОВАЯ ПЕЧАТЬ 20.07.2026", [
        ["A2", "Synthetic"],
        ["K2", 180, "=SUM(G2:J2)"],
        ["G2", 180],
      ]),
    ],
  };
  let r = review(docs[1], grid);
  assert.equal(
    r.observations.find((x) => x.type === "status_remaining").classification,
    "expected_behavior",
  );
  assert.equal(
    businessPreview(docs[1], grid, now).checks.find(
      (x) => x.id === "shop-status",
    ).observations,
    0,
  );
  entries[3][2] = '=IF(Q3=0;"готово";"не готово")';
  grid.sheets[0] = sheet(
    1580315960,
    "Первый магазин НОВАЯ ПЕЧАТЬ 20.07.2026",
    entries,
  );
  r = review(docs[1], grid);
  assert.equal(
    r.observations.find((x) => x.type === "status_remaining").classification,
    "business_process",
  );
});
test("OFFSET identifies exact duplicate position, rejects a different row offset", () => {
  assert.equal(
    offsetRow("=OFFSET('Catalog'!A968;-N971;)", 971, 944, "Catalog", "A"),
    24,
  );
  assert.equal(
    offsetRow("=OFFSET('Catalog'!A968;-N970;)", 971, 944, "Catalog", "A"),
    null,
  );
  const title = "Товары НОВАЯ ПЕЧАТЬ 20.07.2026";
  const grid = {
    sheets: [
      sheet(1580315960, "Первый магазин НОВАЯ ПЕЧАТЬ 20.07.2026", [
        ["J3", "Synthetic", `=OFFSET('${title}'!A5;-N3;)`],
        ["N3", 2],
        ["AA3", 7, `=OFFSET('${title}'!K5;-N3;)`],
      ]),
      sheet(1335787439, title, [
        ["A2", "Synthetic"],
        ["K2", 999],
        ["A3", "Synthetic"],
        ["K3", 7],
      ]),
    ],
  };
  assert.equal(
    businessPreview(docs[1], grid, now).checks.find(
      (x) => x.id === "shop-links",
    ).observations,
    0,
  );
});
test("all duplicate groups are retained rather than first eight samples", () => {
  const entries = Array.from({ length: 11 }, (_, i) => [
    ["A" + (i * 2 + 2), "Synthetic" + i],
    ["A" + (i * 2 + 3), "Synthetic" + i],
  ]).flat();
  const r = review(docs[1], {
    sheets: [
      sheet(1580315960, "Первый магазин НОВАЯ ПЕЧАТЬ 20.07.2026", []),
      sheet(1335787439, "Товары НОВАЯ ПЕЧАТЬ 20.07.2026", entries),
    ],
  });
  assert.equal(
    r.observations.filter((x) => x.type === "duplicate_article").length,
    11,
  );
});
test("partial releases are added within production day and cutting is a separate group", () => {
  const grid = {
    sheets: [
      sheet(725126844, "Журнал выпуска", [
        ["A2", "part1"],
        ["B2", "09.10.2026 23:30:00"],
        ["C2", "Synthetic"],
        ["D2", "Печать"],
        ["H2", "same-roll"],
        ["J2", 1],
        ["L2", 2],
        ["A3", "part2"],
        ["B3", "09.10.2026"],
        ["C3", "Synthetic"],
        ["D3", "Печать"],
        ["H3", "same-roll"],
        ["J3", 1],
        ["L3", 3],
        ["A4", "cut"],
        ["B4", "09.10.2026"],
        ["C4", "Synthetic"],
        ["D4", "Порезка"],
        ["L4", 4],
      ]),
      sheet(572942359, "Выпуск по дням", [
        ["A5", "09.10.2026"],
        ["B5", "Synthetic"],
        ["C5", "Печать"],
        ["D5", 5],
        ["A6", "09.10.2026"],
        ["B6", "Synthetic"],
        ["C6", "Порезка"],
        ["D6", 4],
      ]),
    ],
  };
  const r = review(docs[2], grid);
  const rule = r.rules.find((x) => x.id === "daily-journal");
  assert.equal(rule.rowsChecked, 2);
  assert.equal(rule.deviations, 0);
});
test("diagnostic approval requires exact version, acknowledgement and fresh successful read", () => {
  const x = setup();
  try {
    const r = x.governance.state().rules[0];
    assert.throws(() =>
      x.governance.decide({
        ruleId: r.id,
        version: r.version,
        decision: "approve",
      }),
    );
    assert.throws(() =>
      x.governance.decide({
        ruleId: r.id,
        version: "changed",
        decision: "approve",
        acknowledged: true,
      }),
    );
    x.store.check("doctor-fbo", { status: "unavailable" }, now.toISOString());
    assert.throws(() => approve(x.governance));
    x.put(fbo(""));
    assert.equal(approve(x.governance).ok, true);
    assert.equal(approve(x.governance).unchanged, true);
    assert.equal(x.governance.state().permission, "diagnosis_only");
  } finally {
    x.store.close();
  }
});
test("unapproved rules do not create policy incidents; approval produces one, repeated check deduplicates, fixed source closes it", () => {
  const x = setup();
  try {
    x.governance.reconcile(docs[0], true, now.toISOString());
    assert.equal(x.store.overview().active, 0);
    approve(x.governance);
    x.governance.reconcile(docs[0], true, now.toISOString());
    x.governance.reconcile(docs[0], true, now.toISOString());
    assert.equal(x.store.overview().active, 1);
    assert.equal(x.governance.state().confirmed, 1);
    x.put(fbo());
    x.governance.reconcile(docs[0], true, now.toISOString());
    assert.equal(x.store.overview().active, 0);
    assert.equal(x.store.listIncidents({ status: "resolved" }).rows.length, 1);
  } finally {
    x.store.close();
  }
});
test("point exception pauses only one observation, not another type at same cell; revoke reopens", () => {
  const x = setup(fbo("", 150));
  try {
    approve(x.governance);
    x.governance.reconcile(docs[0], true, now.toISOString());
    assert.equal(x.store.overview().active, 2);
    const o = x.governance
      .state()
      .observations.find((o) => o.type === "formula_number");
    const e = except(x.governance, o);
    assert.equal(x.store.overview().active, 1);
    assert.equal(
      x.governance
        .state()
        .observations.filter((o) => o.classification === "expected_exception")
        .length,
      1,
    );
    assert.equal(
      x.store.db
        .prepare("SELECT resolved_at FROM incidents WHERE status='excepted'")
        .get().resolved_at,
      null,
    );
    x.governance.revokeException(e.id);
    x.governance.reconcile(docs[0], true, now.toISOString());
    assert.equal(x.store.overview().active, 2);
  } finally {
    x.store.close();
  }
});
test("exception invalidates on source change, expires and is never a global error suppression", () => {
  const x = setup();
  try {
    const e = except(x.governance);
    assert.equal(x.governance.state().exceptions[0].applies, true);
    x.put(fbo("", 2));
    assert.equal(x.governance.state().exceptions[0].applies, false);
    assert.throws(() =>
      x.governance.addException({
        observationId: e.id,
        evidenceVersion: "old",
        reason: "Reason",
        expiresAt: "2026-10-10T12:00:00Z",
      }),
    );
    x.setClock(new Date("2026-10-10T13:00:00Z"));
    assert.equal(x.governance.state().exceptions[0].status, "expired");
  } finally {
    x.store.close();
  }
});
test("revoking rule suspends rather than claiming fixed; decisions and exceptions survive restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ritm-policy-")),
    file = path.join(dir, "test.sqlite"),
    x = setup(fbo(""), file);
  try {
    approve(x.governance);
    x.governance.reconcile(docs[0], true, now.toISOString());
    const r = x.governance.state().rules[0];
    x.governance.decide({
      ruleId: r.id,
      version: r.version,
      decision: "revoke",
      acknowledged: true,
    });
    assert.equal(
      x.store.db.prepare("SELECT status,resolved_at FROM incidents").get()
        .status,
      "rule_paused",
    );
    assert.equal(
      x.store.db.prepare("SELECT resolved_at FROM incidents").get().resolved_at,
      null,
    );
    except(x.governance);
    x.store.close();
    const st = new IncidentStore(file);
    try {
      const g = new DiagnosticGovernance(st, x.cfg, { now: () => now });
      assert.equal(g.state().rules[0].approval, "pending");
      assert.equal(g.state().exceptions[0].applies, true);
      assert.ok(st.db.prepare("SELECT COUNT(*) n FROM history").get().n >= 3);
    } finally {
      st.close();
    }
  } finally {
    if (x.store.db.isOpen) x.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("real policy routes require owner cookie and Origin, reject bearer, anonymous, address injection", async () => {
  const x = setup(),
    server = createAgentServer(x.store, x.cfg, {
      doctor: { governance: x.governance, current: null },
    });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  x.cfg.allowedOrigins.push(base);
  const rule = x.governance.state().rules[0],
    url = base + "/api/intelligence/doctor/rules/fbo-sum/approve",
    payload = { version: rule.version, acknowledged: true };
  const post = (headers, body = payload) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post({ origin: base })).status, 401);
    assert.equal(
      (
        await post({
          origin: base,
          authorization: "Bearer " + x.cfg.ownerToken,
        })
      ).status,
      403,
    );
    const login = await fetch(base + "/api/intelligence/session", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ token: x.cfg.ownerToken }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await post({ cookie })).status, 403);
    assert.equal(
      (await post({ cookie, origin: "https://evil.test" })).status,
      403,
    );
    assert.equal(
      (await post({ cookie, origin: base }, { ...payload, cell: "G247" }))
        .status,
      400,
    );
    assert.equal(
      (await post({ cookie, origin: base }, { ...payload, version: "old" }))
        .status,
      409,
    );
    assert.equal((await post({ cookie, origin: base })).status, 200);
    assert.equal(
      (
        await fetch(base + "/api/intelligence/doctor/repair", {
          method: "POST",
          headers: { cookie, origin: base, "content-type": "application/json" },
          body: JSON.stringify({ cell: "G247" }),
        })
      ).status,
      403,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    x.store.close();
  }
});

test("existing detector incident keeps its identity across approval, no duplicate policy incident, exception is not a fix", () => {
  const x = setup();
  try {
    const legacy = {
      kind: "table_doctor",
      sourceId: docs[0].id,
      sourceName: docs[0].name,
      sheet: "Все коэффициенты",
      cell: "E2",
      type: "formula_number",
      title: "Synthetic",
      initialStatus: "review",
      verification: "needs_review",
    };
    x.store.reconcile("doctor:data:doctor-fbo", [legacy]);
    const id = x.store.listIncidents().rows[0].id;
    let f = x.governance.reviewLegacy(docs[0], [legacy], now.toISOString());
    x.store.reconcile("doctor:data:doctor-fbo", f);
    approve(x.governance);
    f = x.governance.reviewLegacy(docs[0], [legacy], now.toISOString());
    x.store.reconcile("doctor:data:doctor-fbo", f);
    x.governance.reconcile(docs[0], true, now.toISOString());
    assert.equal(x.store.overview().active, 1);
    assert.equal(x.store.listIncidents().rows[0].id, id);
    assert.equal(
      x.store.db.prepare("SELECT workflow FROM incidents WHERE id=?").get(id)
        .workflow,
      "confirmed",
    );
    except(x.governance);
    f = x.governance.reviewLegacy(docs[0], [legacy], now.toISOString());
    x.store.reconcile("doctor:data:doctor-fbo", f);
    assert.equal(
      x.store.db.prepare("SELECT status FROM incidents WHERE id=?").get(id)
        .status,
      "excepted",
    );
    assert.equal(
      x.store.db.prepare("SELECT resolved_at FROM incidents WHERE id=?").get(id)
        .resolved_at,
      null,
    );
  } finally {
    x.store.close();
  }
});
test("owner can revoke a rule after source becomes unavailable, without enabling writes", () => {
  const x = setup();
  try {
    approve(x.governance);
    const r = x.governance.state().rules[0];
    x.store.check("doctor-fbo", { status: "unavailable" }, now.toISOString());
    assert.equal(
      x.governance.decide({
        ruleId: r.id,
        version: r.version,
        decision: "revoke",
        acknowledged: true,
      }).ok,
      true,
    );
    assert.equal(x.governance.state().rules[0].approval, "pending");
  } finally {
    x.store.close();
  }
});

test("explicit ISO instants use Moscow production day; floating sheet dates and serials do not shift", async () => {
  const { productionDay } = await import("../agent/diagnosticGrid.js");
  assert.equal(productionDay("2026-10-08T21:30:00Z"), "2026-10-09");
  assert.equal(productionDay("2026-10-09T00:30:00+03:00"), "2026-10-09");
  assert.equal(productionDay("09.10.2026 23:30:00"), "2026-10-09");
  assert.equal(productionDay("2026-10-09T00:30:00"), "2026-10-09");
  assert.equal(productionDay("31.02.2026"), null);
});
test("compact Google response retains original formulas, effective values and error details, without formatted duplication", async () => {
  const { GoogleSheetsReader } = await import("../agent/googleSheets.js");
  let request;
  const data = {
    spreadsheetId: docs[0].documentId,
    sheets: [
      {
        properties: { sheetId: 0 },
        data: [
          {
            rowData: [
              {
                values: [
                  {
                    userEnteredValue: { formulaValue: "=SUM(B2:D2)" },
                    effectiveValue: { numberValue: 0 },
                  },
                  {
                    userEnteredValue: { formulaValue: "=NA()" },
                    effectiveValue: {
                      errorValue: { type: "N_A", message: "Synthetic" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const reader = new GoogleSheetsReader({
    credentialsFile: path.join(tmpdir(), "synthetic-not-read-google-key.json"),
    fetcher: async (url, options) => {
      request = { url: new URL(url), options };
      return Response.json(data);
    },
  });
  reader.cached = {
    token: "synthetic-unit-test-token",
    expires: Date.now() + 3600000,
  };
  assert.deepEqual(
    await reader.grid(docs[0].documentId, ["'Все коэффициенты'!A1:E10"]),
    data,
  );
  assert.equal(request.url.searchParams.get("prettyPrint"), "false");
  assert.match(
    request.url.searchParams.get("fields"),
    /userEnteredValue,effectiveValue/,
  );
  assert.doesNotMatch(request.url.searchParams.get("fields"), /formattedValue/);
  assert.equal(request.options.method, "GET");
  assert.equal(reader.telemetry().readRequests, 1);
});
