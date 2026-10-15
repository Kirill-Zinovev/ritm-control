import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { IncidentStore } from "../agent/store.js";
import { FormulaIntelligence } from "../agent/formulaIntelligence.js";
import { PRODUCTION_DOCTOR_DOCUMENTS } from "../agent/productionRegistry.js";
import { PRODUCTION_REPAIR_DOCUMENT_IDS } from "../agent/productionRegistry.js";
import {
  ProductionRepairService,
  ProductionSheetsWriter,
  validateProductionRepairConfig,
  approvedTarget,
  isTailscaleReadOrigin,
} from "../agent/productionRepair.js";
import { RepairError } from "../agent/testSheetsWriter.js";
import { createAgentServer } from "../agent/server.js";
import { gzipSync } from "node:zlib";
const doc = PRODUCTION_DOCTOR_DOCUMENTS.find(
  (d) => d.documentId === "1YTQQ1Mg9kVv7EOQiN6wOvkvnHvsiXcwbhYOERUPy8rQ",
);
const tab = doc.sheets.find((s) => s.gid === 1580315960);
function harness() {
  const store = new IncidentStore(":memory:");
  const config = {
    productionRepairEnabled: true,
    productionWriterEmail:
      "ritm-test-writer@ritm-intelligence.iam.gserviceaccount.com",
    productionWriterCredentialsFile: "writer-outside",
    googleCredentialsFile: "reader-outside",
    port: 4318,
    publicOrigin: "",
    doctorDocuments: [doc],
    sources: [],
    telegram: {},
    allowedOrigins: ["http://localhost:4318", "http://127.0.0.1:4318"],
    ownerToken: "o".repeat(64),
  };
  new FormulaIntelligence(store, config);
  const cells = new Map([
      ["M11", { numberValue: 1 }],
      ["N11", { numberValue: 2 }],
    ]),
    incidents = new Map();
  let merge = null,
    validation = null,
    error = false,
    calls = 0;
  let now = Date.parse("2026-10-10T09:00:00Z");
  const formula = "=C11/D11",
    version = "a".repeat(64),
    region = "b".repeat(64);
  const scope = `doctor:formula:${doc.id}:${tab.gid}`;
  const makeFinding = (cellAddress, expected, entered, type = "formula_number") => ({
    kind: "table_doctor",
    sourceId: doc.id,
    sourceName: doc.name,
    sheet: tab.name,
    cell: cellAddress,
    type,
    title:
      type === "calculation_error"
        ? "Ошибка вычисления при сохранённой формуле"
        : "Тест программного механизма",
    expected,
    observed: { entered },
    verification: type === "calculation_error" ? "needs_review" : "rule_confirmed",
    baselineVersion: version,
    formulaRegionId: region,
    initialStatus: type === "calculation_error" ? "review" : "confirmed",
  });
  const addIncident = (cellAddress = "M11", expected = formula) => {
    store.db
      .prepare("INSERT INTO formula_protected VALUES(?,?,?,?,?,?,?)")
      .run(doc.id, tab.gid, cellAddress, expected, null, region, version);
    incidents.set(cellAddress, { id: null, expected });
    store.reconcile(
      scope,
      [...incidents].map(([address, issue]) =>
        makeFinding(address, issue.expected, cells.get(address)),
      ),
    );
    const id = store.listIncidents().rows.find((i) => i.cell === cellAddress).id;
    incidents.set(cellAddress, { id, expected });
    return id;
  };
  const id = addIncident();
  const reader = {
    async get(_, options) {
      const cellAddress = options.ranges[0].split("!").at(-1),
        column = cellAddress.match(/^[A-Z]+/)[0],
        row = Number(cellAddress.match(/\d+$/)[0]),
        columnIndex = [...column].reduce(
          (n, c) => n * 26 + c.charCodeAt(0) - 64,
          0,
        ) - 1;
      return {
        spreadsheetId: doc.documentId,
        sheets: [
          {
            properties: { sheetId: tab.gid, title: tab.name },
            merges: merge ? [merge] : [],
            data: [
              {
                startRow: row - 1,
                startColumn: columnIndex,
                rowData: [
                  {
                    values: [
                      {
                        userEnteredValue: cells.get(cellAddress),
                        effectiveValue: error
                          ? { errorValue: { type: "REF" } }
                          : {
                              stringValue: cells.get(cellAddress)?.formulaValue
                                ? "TEST-RESULT"
                                : "1",
                            },
                        formattedValue: "test",
                        ...(validation ? { dataValidation: validation } : {}),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
    },
  };
  const writer = {
    metrics: {},
    verifiedAt: null,
    async verifyIsolation() {
      return {};
    },
    async conditionalReplace(direction, p) {
      calls++;
      cells.set(p.target.cell, structuredClone(p.to));
      return { changed: 1 };
    },
  };
  const doctor = {
    async run() {
      const findings = [];
      for (const [cellAddress, issue] of incidents) {
        const entered = cells.get(cellAddress);
        if (entered?.formulaValue !== issue.expected)
          findings.push(makeFinding(cellAddress, issue.expected, entered));
        else if (error)
          findings.push(
            makeFinding(cellAddress, issue.expected, entered, "calculation_error"),
          );
      }
      store.reconcile(scope, findings, { at: new Date(now + 1).toISOString() });
    },
    async runFast() {
      await this.run();
      return {
        at: new Date(now + 1).toISOString(),
        documents: [
          {
            sourceId: doc.id,
            name: doc.name,
            sheets: [{ gid: tab.gid, status: "ok", checkedCells: incidents.size }],
          },
        ],
      };
    },
    state() {
      return {
        documents: [
          {
            id: doc.id,
            check: { status: "ok", at: new Date(now + 1).toISOString() },
          },
        ],
      };
    },
  };
  const service = new ProductionRepairService(store, config, {
    reader,
    writer,
    doctor,
    now: () => now,
  });
  return {
    store,
    config,
    service,
    id,
    addIncident,
    writer,
    set: (c, cellAddress = "M11") => {
      cells.set(cellAddress, c);
    },
    setMerge: (m) => {
      merge = m;
    },
    setError: () => {
      error = true;
    },
    setValidation: () => {
      validation = { condition: { type: "NUMBER_GREATER" } };
    },
    tick: () => {
      now += 601000;
    },
    get calls() {
      return calls;
    },
  };
}
const confirm = (p) => ({
  version: p.version,
  confirmation: p.confirmation,
  exclusiveEditingAcknowledged: true,
});
function historicalIncident(h) {
  h.store.db.prepare("DELETE FROM formula_protected WHERE cell='M11'").run();
  const row = h.store.db.prepare("SELECT * FROM incidents WHERE id=?").get(h.id), finding = JSON.parse(row.payload);
  const formula = finding.expected;
  delete finding.baselineVersion; delete finding.formulaRegionId;
  finding.type = "formula_history_change"; finding.verification = "needs_review";
  finding.expected = { candidateFormula: formula, confidence: "unapproved_history" };
  h.store.db.prepare("UPDATE incidents SET payload=? WHERE id=?").run(JSON.stringify(finding), h.id);
  const region = "c".repeat(64), version = "d".repeat(64), at = new Date(Date.parse(row.first_seen) - 1000).toISOString(),
    area = { sourceId: doc.id, gid: tab.gid, sheet: tab.name, cells: [["M11", formula, null]] };
  h.store.db.prepare("INSERT INTO formula_versions VALUES(?,?,?,?)").run(version, region, at, gzipSync(JSON.stringify(area)));
  h.store.db.prepare("INSERT INTO formula_regions VALUES(?,?,?,?,?,?)").run(region, doc.id, tab.gid, version, at, JSON.stringify({ current: true }));
}

test("historical repair requires immutable evidence and one explicit candidate-plus-write approval", async () => {
  const h = harness();
  try {
    historicalIncident(h);
    await h.service.prepare(h.id);
    const proposal = h.service.state(h.id).proposals[0];
    assert.equal(proposal.historyApprovalRequired, true);
    assert.equal(h.calls, 0);
    await assert.rejects(h.service.confirm(proposal.id, confirm(proposal)), { code: "history_approval_required" });
    await h.service.confirm(proposal.id, { ...confirm(proposal), historyCandidateApproved: true });
    await waitForProposal(h.service, proposal.id, ["verified"]);
    assert.equal(h.calls, 1);
    assert.equal(h.store.getIncident(h.id).monitorStatus, "resolved");
    assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM formula_protected").get().n, 0);
    const replay = await h.service.confirm(proposal.id, { ...confirm(proposal), historyCandidateApproved: true });
    assert.equal(replay.replayed, true); assert.equal(h.calls, 1);
  } finally { h.store.close(); }
});

test("altered historical candidate cannot use a different immutable formula", async () => {
  const h = harness();
  try {
    historicalIncident(h);
    const finding = JSON.parse(h.store.db.prepare("SELECT payload FROM incidents WHERE id=?").get(h.id).payload);
    finding.expected.candidateFormula = "=999";
    h.store.db.prepare("UPDATE incidents SET payload=? WHERE id=?").run(JSON.stringify(finding), h.id);
    await assert.rejects(h.service.prepare(h.id), { code: "history_unverified" });
    assert.equal(h.calls, 0);
  } finally { h.store.close(); }
});
async function waitForProposal(service, id, statuses) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const proposal = service.queueState().items.find((item) => item.id === id);
    if (proposal && statuses.includes(proposal.status)) return proposal;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(
    `Proposal ${id} did not reach ${statuses.join(" or ")}; current status: ${service.queueState().items.find((item) => item.id === id)?.status}`,
  );
}
test("production exact proposal writes only after explicit consent, backs up, rereads, closes and is idempotent", async () => {
  const h = harness();
  const p = (await h.service.prepare(h.id)).proposals[0];
  assert.equal(h.calls, 0);
  assert.equal(p.target.cell, "M11");
  assert.equal(p.testOnly, undefined);
  assert.equal(p.to.formulaValue, "=C11/D11");
  await h.service.confirm(p.id, confirm(p));
  await waitForProposal(h.service, p.id, ["verified"]);
  assert.equal(h.calls, 1);
  assert.equal(
    h.store.db.prepare("SELECT status FROM incidents WHERE id=?").get(h.id)
      .status,
    "resolved",
  );
  assert.ok(
    h.service
      .state(h.id)
      .proposals[0].events.some((e) => e.type === "repair_backup"),
  );
  await h.service.confirm(p.id, confirm(p));
  assert.equal(h.calls, 1);
  const rollback = (await h.service.prepare(h.id, "rollback", p.id))
    .proposals[0];
  assert.deepEqual(rollback.to, { numberValue: 1 });
  assert.equal(h.calls, 1);
  await h.service.confirm(rollback.id, confirm(rollback));
  await waitForProposal(h.service, rollback.id, ["needs_review"]);
  assert.equal(h.calls, 2);
  h.store.close();
});

test("individually confirmed repairs queue sequentially without a global busy lock", async () => {
  const h = harness(),
    secondIncident = h.addIncident("N11", "=E11/F11"),
    first = (await h.service.prepare(h.id)).proposals[0],
    second = (await h.service.prepare(secondIncident)).proposals[0];
  await h.service.confirm(first.id, confirm(first));
  await h.service.confirm(second.id, confirm(second));
  await Promise.all([
    waitForProposal(h.service, first.id, ["verified"]),
    waitForProposal(h.service, second.id, ["verified"]),
  ]);
  assert.equal(h.calls, 2);
  assert.equal(h.service.queueState().queued, 0);
  assert.equal(h.service.queueState().executing, 0);
  assert.equal(h.service.queueState().checking, 0);
  assert.equal(h.store.getIncident(h.id).status, "fixed");
  assert.equal(h.store.getIncident(secondIncident).status, "fixed");
  h.store.close();
});

function activeSourceRecovery(h) {
  h.store.db.prepare("INSERT INTO source_recovery_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("source-in-flight", "fixture-request", "fixture-source-incident", 1, "checking", "2026-10-10T09:00:00Z", "2026-10-10T09:00:00Z", "test-owner", "{}", "{}", "{}", null, null, null);
  h.service.queuePollMs = 10;
}
async function waitForWaiting(h, id) {
  for (let n = 0; n < 200; n++) {
    const row = h.store.db.prepare("SELECT status,result FROM test_repair_proposals WHERE id=?").get(id);
    if (row.status === "queued" && JSON.parse(row.result || "{}").phase === "waiting_before_write") return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Confirmed formula did not wait safely before writing");
}
test("formula waits for source recovery, preserves consent and executes once after verification", async () => {
  const h = harness(), first = (await h.service.prepare(h.id)).proposals[0],
    untouched = (await h.service.prepare(h.addIncident("N11", "=E11/F11"))).proposals[0];
  activeSourceRecovery(h);
  await h.service.confirm(first.id, confirm(first));
  await waitForWaiting(h, first.id);
  assert.equal(h.calls, 0);
  await h.service.confirm(first.id, confirm(first));
  assert.equal(h.calls, 0);
  h.store.db.prepare("UPDATE source_recovery_operations SET status='verified'").run();
  await waitForProposal(h.service, first.id, ["verified"]);
  assert.equal(h.calls, 1);
  assert.equal(h.service.state(untouched.incidentId).proposals[0].status, "pending");
  assert.equal(h.service.state(h.id).proposals[0].events.filter((event) => event.type === "repair_waiting").length, 1);
  await h.service.confirm(first.id, confirm(first));
  assert.equal(h.calls, 1);
  h.store.close();
});
test("source recovery starting during formula preflight defers without failure or write", async () => {
  const h = harness(), proposal = (await h.service.prepare(h.id)).proposals[0];
  let started = false;
  h.writer.verifyIsolation = async () => {
    if (!started) { started = true; activeSourceRecovery(h); }
    return {};
  };
  await h.service.confirm(proposal.id, confirm(proposal));
  await waitForWaiting(h, proposal.id);
  assert.equal(h.calls, 0);
  assert.ok(!h.service.state(h.id).proposals[0].events.some((event) => event.type === "repair_postcheck_failed"));
  h.store.db.prepare("UPDATE source_recovery_operations SET status='verified'").run();
  await waitForProposal(h.service, proposal.id, ["verified"]);
  assert.equal(h.calls, 1);
  h.store.close();
});
test("expiry while waiting cancels before write and does not execute pending requests", async () => {
  const h = harness(), proposal = (await h.service.prepare(h.id)).proposals[0];
  activeSourceRecovery(h);
  await h.service.confirm(proposal.id, confirm(proposal));
  await waitForWaiting(h, proposal.id);
  h.tick();
  h.store.db.prepare("UPDATE source_recovery_operations SET status='verified'").run();
  await waitForProposal(h.service, proposal.id, ["needs_review"]);
  assert.equal(h.calls, 0);
  h.service.startQueue();
  assert.equal(h.calls, 0);
  h.store.close();
});
test("restart keeps queued consent while pending and failed proposals remain unexecuted", async () => {
  const h = harness(), proposal = (await h.service.prepare(h.id)).proposals[0],
    pending = (await h.service.prepare(h.addIncident("N11", "=E11/F11"))).proposals[0];
  activeSourceRecovery(h);
  await h.service.confirm(proposal.id, confirm(proposal));
  await waitForWaiting(h, proposal.id);
  clearTimeout(h.service.queueWake);
  h.service.queueWake = null;
  const restarted = new ProductionRepairService(h.store, h.config, {
    reader: h.service.reader, writer: h.writer, doctor: h.service.doctor, now: h.service.now,
  });
  restarted.queuePollMs = 10;
  restarted.startQueue();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(h.calls, 0);
  h.store.db.prepare("UPDATE source_recovery_operations SET status='verified'").run();
  await waitForProposal(restarted, proposal.id, ["verified"]);
  assert.equal(h.calls, 1);
  assert.equal(restarted.state(pending.incidentId).proposals[0].status, "pending");
  h.store.close();
});
test("queue includes real source recovery stages and counts only verified writes today", async () => {
  const h = harness();
  activeSourceRecovery(h);
  const target = { documentId: doc.documentId, sheet: "Товары НОВАЯ ПЕЧАТЬ 20.07.2026", cell: "P99", sheetId: 1335787439 };
  h.store.db.prepare("UPDATE source_recovery_operations SET target=?,status='repairing'").run(JSON.stringify(target));
  assert.equal(h.service.queueState().executing, 1);
  h.store.db.prepare("UPDATE source_recovery_operations SET status='checking'").run();
  assert.equal(h.service.queueState().checking, 1);
  h.store.db.prepare("UPDATE source_recovery_operations SET status='written_unverified'").run();
  assert.equal(h.service.queueState().needsDecision, 1);
  assert.equal(h.service.queueState().fixedToday, 0);
  h.store.db.prepare("UPDATE source_recovery_operations SET status='verified',result=?").run(JSON.stringify({ verifiedAt: "2026-10-10T09:00:00Z", writeSucceeded: false }));
  assert.equal(h.service.queueState().fixedToday, 0);
  h.store.db.prepare("UPDATE source_recovery_operations SET result=?").run(JSON.stringify({ verifiedAt: "2026-10-10T09:00:00Z", writeSucceeded: true }));
  assert.equal(h.service.queueState().fixedToday, 1);
  assert.equal(h.service.queueState().items[0].target.cell, "P99");
  assert.equal(h.calls, 0);
  h.store.close();
});

test("already restored production formula is rescanned and closed without creating a write proposal", async () => {
  const h = harness();
  h.set({ formulaValue: "=C11/D11" });
  const result = await h.service.prepare(h.id);
  assert.equal(result.ok, true);
  assert.equal(result.alreadyRestored, true);
  assert.match(result.message, /уже содержит утверждённую формулу/);
  assert.equal(h.calls, 0);
  assert.equal(
    h.store.db.prepare("SELECT status FROM incidents WHERE id=?").get(h.id)
      .status,
    "resolved",
  );
  assert.equal(
    h.store.db
      .prepare(
        "SELECT count(*) AS n FROM test_repair_proposals WHERE incident_id=?",
      )
      .get(h.id).n,
    0,
  );
  const rollPrinting = PRODUCTION_DOCTOR_DOCUMENTS.find(
    (entry) => entry.id === "doctor-roll-printing",
  );
  assert.ok(rollPrinting, "Roll printing remains available for monitoring");
  assert.ok(!PRODUCTION_REPAIR_DOCUMENT_IDS.includes(rollPrinting.id));
  assert.throws(
    () =>
      approvedTarget({
        documentId: rollPrinting.documentId,
        sheetId: 119710351,
        sheet: "OZON МОСКВА 10_10",
        cell: "J5",
      }),
    (error) => error.code === "target_forbidden",
  );
  h.store.close();
});

test("production proposal preparation does not hold a global queue lock", async () => {
  const h = harness();
  h.service.busy = true;
  const prepared = await h.service.prepare(h.id);
  assert.equal(prepared.proposals.length, 1);
  assert.equal(prepared.proposals[0].status, "pending");
  assert.equal(h.calls, 0);
  h.store.close();
});
for (const [name, change] of [
  ["changed input", (h) => h.set({ numberValue: 2 })],
  [
    "changed merge geometry",
    (h) =>
      h.setMerge({
        startRowIndex: 10,
        endRowIndex: 12,
        startColumnIndex: 12,
        endColumnIndex: 13,
      }),
  ],
  ["changed validation", (h) => h.setValidation()],
  ["expired proposal", (h) => h.tick()],
  ["revoked baseline", (h) => h.store.db.exec("DELETE FROM formula_protected")],
  [
    "changed baseline version",
    (h) => h.store.db.exec("UPDATE formula_protected SET version='different'"),
  ],
])
  test(`production ${name} cancels before write`, async () => {
    const h = harness(),
      p = (await h.service.prepare(h.id)).proposals[0];
    change(h);
    if (["expired proposal", "revoked baseline", "changed baseline version"].includes(name))
      await assert.rejects(h.service.confirm(p.id, confirm(p)));
    else {
      await h.service.confirm(p.id, confirm(p));
      await waitForProposal(h.service, p.id, ["needs_review"]);
    }
    assert.equal(h.calls, 0);
    h.store.close();
  });
test("unapproved historical candidate and missing consent cannot be repaired", async () => {
  const h = harness();
  const p = (await h.service.prepare(h.id)).proposals[0];
  await assert.rejects(
    h.service.confirm(p.id, {
      ...confirm(p),
      exclusiveEditingAcknowledged: false,
    }),
  );
  await assert.rejects(
    h.service.confirm(p.id, { ...confirm(p), target: { cell: "M12" } }),
  );
  h.store.db
    .prepare(
      "UPDATE incidents SET payload=json_set(payload,'$.verification','needs_review') WHERE id=?",
    )
    .run(h.id);
  await assert.rejects(h.service.prepare(h.id));
  assert.equal(h.calls, 0);
  h.store.close();
});
test("calculation error after write stays uncertain with no retry or automatic rollback", async () => {
  const h = harness(),
    p = (await h.service.prepare(h.id)).proposals[0];
  const write = h.writer.conditionalReplace.bind(h.writer);
  h.writer.conditionalReplace = async (...args) => {
    const result = await write(...args);
    h.setError();
    return result;
  };
  await h.service.confirm(p.id, confirm(p));
  const uncertain = await waitForProposal(h.service, p.id, ["uncertain"]);
  assert.equal(uncertain.errorCode, "postcondition_failed");
  await assert.rejects(h.service.confirm(p.id, confirm(p)));
  await assert.rejects(h.service.prepare(h.id));
  assert.equal(h.calls, 1);
  assert.equal(
    h.store.db.prepare("SELECT status FROM incidents WHERE id=?").get(h.id)
      .status,
    "open",
  );
  h.store.close();
});
test("production configuration refuses read identity, reused credentials, public API and test mode", () => {
  const h = harness();
  for (const c of [
    {
      productionWriterEmail:
        "ritm-table-doctor@ritm-intelligence.iam.gserviceaccount.com",
    },
    { productionWriterCredentialsFile: "reader-outside" },
    { publicOrigin: "https://example.com" },
    { port: 4319 },
    { testWriterCredentialsFile: "test" },
  ])
    assert.throws(() => validateProductionRepairConfig({ ...h.config, ...c }));
  assert.throws(() => approvedTarget({ documentId: "other", cell: "M11" }));
  const fbo = PRODUCTION_DOCTOR_DOCUMENTS.find(
    (entry) => entry.id === "doctor-fbo",
  );
  assert.ok(fbo, "FBO remains in the production repair registry");
  assert.equal(
    approvedTarget({
      documentId: fbo.documentId,
      sheetId: 0,
      sheet: "Все коэффициенты",
      cell: "E7",
    }).gid,
    0,
  );
  h.store.close();
});

test("Tailscale read-origin compatibility accepts only an exact HTTPS ts.net origin", () => {
  const h = harness();
  const origin = "https://desktop-example.tail12345.ts.net";
  assert.equal(isTailscaleReadOrigin(origin), true);
  assert.doesNotThrow(() =>
    validateProductionRepairConfig({ ...h.config, publicOrigin: origin }),
  );
  for (const value of [
    "https://example.com",
    "https://desktop.ts.net.example.com",
    "https://ts.net",
    "http://desktop.ts.net",
    "https://desktop.ts.net:8443",
    "https://owner@desktop.ts.net",
    origin + "/",
    origin + "/path",
    origin + "?query=1",
    origin + "#fragment",
    "invalid",
  ]) {
    assert.equal(isTailscaleReadOrigin(value), false, value);
    assert.throws(() =>
      validateProductionRepairConfig({ ...h.config, publicOrigin: value }),
    );
  }
  h.store.close();
});

test("configured Tailscale preserves localhost repair but rejects remote Host, Origin and proxies", async () => {
  const h = harness();
  const origin = "https://desktop-example.tail12345.ts.net";
  h.config.publicOrigin = origin;
  h.config.allowedOrigins.push(origin);
  const server = createAgentServer(h.store, h.config, { repair: h.service });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // Use raw HTTP: Node fetch can discard a custom Host header.
  const request = (path, headers = {}, payload) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: payload === undefined ? "GET" : "POST",
          headers: {
            host: `localhost:${port}`,
            origin: "http://localhost:4318",
            "content-type": "application/json",
            ...headers,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res));
        },
      );
      req.on("error", reject);
      req.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
  try {
    const login = await request(
      "/api/intelligence/session",
      {},
      {
        token: h.config.ownerToken,
      },
    );
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const body = { incidentId: h.id };
    const endpoint = "/api/intelligence/formula-repair";
    for (const extra of [
      { host: new URL(origin).host },
      { origin },
      { host: new URL(origin).host, origin },
      { "x-forwarded-host": new URL(origin).host },
      { "x-forwarded-for": "100.100.100.100" },
      { forwarded: "for=100.100.100.100" },
    ]) {
      assert.equal(
        (await request(endpoint + "/propose", { cookie, ...extra }, body))
          .statusCode,
        403,
      );
      assert.equal(
        (await request(endpoint + "?incidentId=" + h.id, { cookie, ...extra }))
          .statusCode,
        403,
      );
    }
    assert.equal(
      (await request(endpoint + "/propose", { cookie }, body)).statusCode,
      200,
    );
    assert.equal(h.calls, 0, "even an accepted proposal must not write");
  } finally {
    await new Promise((r) => server.close(r));
    h.store.close();
  }
});
test("production writer emits one native cell and no retry, preserving other fields", async () => {
  const h = harness(),
    p = (await h.service.prepare(h.id)).proposals[0];
  let request;
  const w = new ProductionSheetsWriter({
    credentialsFile: "unused",
    fetcher: async (url, options) => {
      request = JSON.parse(options.body);
      return new Response(
        JSON.stringify({ spreadsheetId: doc.documentId, replies: [{}] }),
      );
    },
  });
  w.token = async () => "test-token";
  w.verifiedAt = "test";
  await w.conditionalReplace("repair", p);
  assert.equal(request.requests.length, 1);
  assert.equal(request.requests[0].updateCells.fields, "userEnteredValue");
  assert.deepEqual(request.requests[0].updateCells.range, {
    sheetId: tab.gid,
    startRowIndex: 10,
    endRowIndex: 11,
    startColumnIndex: 12,
    endColumnIndex: 13,
  });
  let calls = 0;
  w.fetcher = async () => {
    calls++;
    throw new Error("timeout");
  };
  await assert.rejects(w.conditionalReplace("repair", p), /неизвестен/);
  assert.equal(calls, 1);
  h.store.close();
});

test("production access audit separates missing document, disabled API and permission failures", async () => {
  const h = harness();
  const cases = [
    [404, {}, "writer_document_not_found"],
    [403, { reason: "SERVICE_DISABLED" }, "sheets_api_disabled"],
    [
      403,
      { reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" },
      "writer_sheets_forbidden",
    ],
    [403, { reason: "PERMISSION_DENIED" }, "writer_sheets_forbidden"],
    [429, {}, "writer_drive_unavailable"],
    [503, {}, "writer_drive_unavailable"],
  ];
  for (const [status, detail, code] of cases) {
    const writer = new ProductionSheetsWriter({
      credentialsFile: "unused",
      fetcher: async () =>
        new Response(
          JSON.stringify({
            error: {
              status: detail.reason,
              errors: detail.reason ? [{ reason: detail.reason }] : [],
            },
          }),
          { status },
        ),
    });
    writer.token = async () => "opaque";
    await assert.rejects(
      writer.verifyIsolation({
        documentId: doc.documentId,
        sheetId: tab.gid,
        sheet: tab.name,
        cell: "A1",
      }),
      (error) => error.code === code,
    );
    assert.equal(writer.metrics.writeRequests, 0);
  }
  h.store.close();
});

test("Drive capabilities confirm writer permission using only a metadata GET", async () => {
  const h = harness();
  const calls = [];
  const writer = new ProductionSheetsWriter({
    credentialsFile: "unused",
    fetcher: async (url, options) => {
      calls.push({ url, method: options.method });
      return new Response(
        JSON.stringify({ id: doc.documentId, capabilities: { canEdit: true } }),
      );
    },
  });
  writer.token = async () => "opaque";
  const audit = await writer.verifyIsolation({
    documentId: doc.documentId,
    sheetId: tab.gid,
    sheet: tab.name,
    cell: "A1",
  });
  assert.equal(audit.canEdit, true);
  assert.equal(audit.accessCheck, "drive_capabilities");
  assert.equal(audit.googleIsolation, "not_guaranteed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(writer.metrics.writeRequests, 0);
  h.store.close();
});

test("unconfigured Drive API falls back to exact read-only Sheets metadata and preserves the cause", async () => {
  const h = harness();
  const calls = [];
  const writer = new ProductionSheetsWriter({
    credentialsFile: "unused",
    fetcher: async (url) => {
      calls.push(url);
      if (url.includes("drive/v3"))
        return new Response(
          JSON.stringify({
            error: {
              status: "PERMISSION_DENIED",
              errors: [{ reason: "accessNotConfigured" }],
            },
          }),
          { status: 403 },
        );
      return new Response(
        JSON.stringify({
          spreadsheetId: doc.documentId,
          sheets: [{ properties: { sheetId: tab.gid, title: tab.name } }],
        }),
      );
    },
  });
  writer.token = async () => "opaque";
  const audit = await writer.verifyIsolation({
    documentId: doc.documentId,
    sheetId: tab.gid,
    sheet: tab.name,
    cell: "A1",
  });
  assert.equal(audit.canEdit, "unverified");
  assert.equal(audit.accessCheck, "sheets_api_metadata_only");
  assert.equal(audit.permissionReason, "drive_api_disabled");
  assert.match(audit.requiredAction, /Включить Google Drive API/);
  assert.match(audit.message, /accessNotConfigured/);
  assert.match(audit.googleIsolation, /not_guaranteed/);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /includeGridData=false/);
  assert.equal(writer.metrics.writeRequests, 0);
  h.store.close();
});

test("Google permission rejection after owner confirmation closes proposal without retry or uncertain-write label", async () => {
  const h = harness();
  const p = (await h.service.prepare(h.id)).proposals[0];
  let writes = 0;
  h.writer.conditionalReplace = async () => {
    writes++;
    throw new RepairError("write_rejected", "permission denied", 403);
  };
  await h.service.confirm(p.id, confirm(p));
  await waitForProposal(h.service, p.id, ["cancelled"]);
  assert.equal(writes, 1);
  assert.equal(h.service.state(h.id).proposals[0].status, "cancelled");
  assert.equal(
    h.store.db.prepare("SELECT status FROM incidents WHERE id=?").get(h.id)
      .status,
    "open",
  );
  h.store.close();
});

test("production endpoints reject anonymous, bearer-only, forwarded and address injection", async () => {
  const h = harness();
  const server = createAgentServer(h.store, h.config, { repair: h.service });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    host: "localhost:4318",
    origin: "http://localhost:4318",
    "content-type": "application/json",
  };
  try {
    assert.equal(
      (
        await fetch(base + "/api/intelligence/formula-repair/propose", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/api/intelligence/formula-repair/propose", {
          method: "POST",
          headers: {
            ...headers,
            authorization: "Bearer " + h.config.ownerToken,
          },
          body: "{}",
        })
      ).status,
      403,
    );
    const login = await fetch(base + "/api/intelligence/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ token: h.config.ownerToken }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await fetch(base + "/api/intelligence/formula-repair/propose", {
          method: "POST",
          headers: { ...headers, cookie, "x-forwarded-host": "test" },
          body: JSON.stringify({ incidentId: h.id }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/intelligence/formula-repair/propose", {
          method: "POST",
          headers: { ...headers, cookie },
          body: JSON.stringify({ incidentId: h.id, cell: "M12" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/intelligence/formula-repair/propose", {
          method: "POST",
          headers: { ...headers, cookie },
          body: JSON.stringify({ incidentId: h.id }),
        })
      ).status,
      200,
    );
    assert.equal(h.calls, 0);
  } finally {
    await new Promise((r) => server.close(r));
    h.store.close();
  }
});
