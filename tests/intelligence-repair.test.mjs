import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, verify } from "node:crypto";
import { IncidentStore } from "../agent/store.js";
import {
  TestRepairService,
  validateTestRepairConfig,
} from "../agent/testRepair.js";
import {
  TestSheetsWriter,
  TEST_TARGET,
  TEST_WRITER_EMAIL,
  TEST_WRITE_SCOPE,
  PRODUCTION_DOCUMENTS,
  RepairError,
} from "../agent/testSheetsWriter.js";
import { createAgentServer } from "../agent/server.js";
const document = {
  id: "test-live",
  documentId: TEST_TARGET.documentId,
  enabled: true,
  adapter: "google",
  testSource: true,
  sheets: [
    {
      gid: TEST_TARGET.sheetId,
      name: TEST_TARGET.sheet,
      rules: [
        {
          kind: "formula",
          column: "G",
          startRow: 247,
          endRow: 247,
          approval: "approved",
          templates: [TEST_TARGET.formula],
          exceptions: [],
        },
      ],
    },
  ],
};
const configuration = () => ({
  port: 4319,
  testWriterCredentialsFile: "outside-repository",
  doctorDocuments: [structuredClone(document)],
  sources: [],
  telegram: { enabled: false },
  doctorDemoEnabled: false,
  publicOrigin: "",
  allowedOrigins: ["http://127.0.0.1:4319", "http://localhost:4319"],
  ownerToken: "o".repeat(64),
  apiRateLimit: 180,
});
function harness(file = ":memory:") {
  const store = new IncidentStore(file),
    config = configuration();
  let now = Date.parse("2026-10-09T09:00:00Z");
  let cell = { numberValue: 150 },
    uid = { stringValue: "TEST-ONLY-247" },
    numerator = { numberValue: 124 },
    denominator = { numberValue: 100 };
  let calls = 0,
    conflict = false,
    fail = false,
    wrong = false,
    isolationFail = false,
    recheckFail = false;
  const finding = {
    kind: "table_doctor",
    sourceId: document.id,
    sourceName: "ТЕСТ",
    sheet: TEST_TARGET.sheet,
    cell: "G247",
    type: "formula_number",
    observed: 150,
    expected: TEST_TARGET.formula,
    verification: "rule_confirmed",
    initialStatus: "new",
    title: "Тест",
    demonstration: true,
  };
  const scope = "test-scope";
  const id =
    store.reconcile(scope, [finding])[0] || store.listIncidents().rows[0].id;
  const reader = {
    async get() {
      const values = [uid, {}, numerator, denominator, {}, {}, cell].map(
        (value) => ({ userEnteredValue: value }),
      );
      values[6].effectiveValue = {
        numberValue: cell.formulaValue ? (wrong ? 99 : 1.24) : cell.numberValue,
      };
      values[6].formattedValue = cell.formulaValue
        ? "1,24"
        : String(cell.numberValue);
      return {
        spreadsheetId: TEST_TARGET.documentId,
        sheets: [
          {
            properties: {
              sheetId: TEST_TARGET.sheetId,
              title: TEST_TARGET.sheet,
            },
            data: [{ startRow: 246, rowData: [{ values }] }],
          },
        ],
      };
    },
  };
  const writer = {
    metrics: { writeRequests: 0 },
    verifiedAt: null,
    async verifyIsolation() {
      this.verifiedAt = null;
      if (isolationFail)
        throw new RepairError(
          "production_access_not_denied",
          "Изоляция не подтверждена",
          403,
        );
      this.verifiedAt = new Date(now).toISOString();
      return { verifiedAt: this.verifiedAt, productionAccess: "denied" };
    },
    async conditionalReplace(direction) {
      calls++;
      this.metrics.writeRequests++;
      if (conflict) {
        cell = { numberValue: 151 };
        throw new RepairError("conditional_conflict", "changed");
      }
      if (fail) throw new RepairError("write_uncertain", "uncertain", 503);
      cell =
        direction === "repair"
          ? { formulaValue: TEST_TARGET.formula }
          : { numberValue: 150 };
      return { changed: 1, writeRequests: this.metrics.writeRequests };
    },
  };
  const doctor = {
    current: null,
    async run() {
      if (!recheckFail)
        store.reconcile(scope, cell.formulaValue ? [] : [finding]);
    },
    state() {
      return {
        documents: [
          {
            id: document.id,
            check: {
              status: recheckFail ? "unavailable" : "ok",
              issueCount: cell.formulaValue ? 0 : 1,
              at: new Date(now).toISOString(),
            },
          },
        ],
      };
    },
  };
  const service = new TestRepairService(store, config, {
    reader,
    writer,
    doctor,
    now: () => now,
  });
  return {
    store,
    config,
    id,
    service,
    writer,
    reader,
    doctor,
    get calls() {
      return calls;
    },
    set cell(value) {
      cell = value;
    },
    set denominator(value) {
      denominator = value;
    },
    set now(value) {
      now = value;
    },
    set conflict(value) {
      conflict = value;
    },
    set fail(value) {
      fail = value;
    },
    set wrong(value) {
      wrong = value;
    },
    set isolationFail(value) {
      isolationFail = value;
    },
    set recheckFail(value) {
      recheckFail = value;
    },
    proposal() {
      return service.state(id).proposals[0];
    },
  };
}
const consent = (p, extra = {}) => ({
  version: p.version,
  confirmation: p.confirmation,
  exclusiveEditingAcknowledged: true,
  ...extra,
});
test("preparing an exact proposal never writes; owner-confirmed repair backs up and verifies before closure", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  assert.deepEqual(p.from, { numberValue: 150 });
  assert.deepEqual(p.to, { formulaValue: TEST_TARGET.formula });
  assert.equal(h.calls, 0);
  assert.equal(h.store.getIncident(h.id).monitorStatus, "open");
  await h.service.confirm(p.id, consent(p));
  assert.equal(h.calls, 1);
  assert.equal(h.proposal().status, "verified");
  assert.equal(h.store.getIncident(h.id).status, "fixed");
  assert.deepEqual(
    h.proposal().events.map((e) => e.type),
    [
      "repair_proposed",
      "repair_confirmed",
      "repair_backup",
      "repair_write_started",
      "repair_verified",
    ],
  );
  assert.equal(h.proposal().events[2].payload.original.cell.numberValue, 150);
  h.store.close();
});
test("confirmation binds version, exact text and exclusive editing acknowledgement; injected addresses fail", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  for (const payload of [
    consent(p, { version: "changed" }),
    consent(p, { confirmation: "yes" }),
    consent(p, { exclusiveEditingAcknowledged: false }),
    consent(p, { cell: "G248" }),
    null,
  ])
    await assert.rejects(h.service.confirm(p.id, payload));
  assert.equal(h.calls, 0);
  assert.equal(h.proposal().status, "pending");
  h.store.close();
});
test("a successful duplicate confirmation returns recorded result without another Google write", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  await h.service.confirm(p.id, consent(p));
  const r = await h.service.confirm(p.id, consent(p));
  assert.equal(r.replayed, true);
  assert.equal(h.calls, 1);
  h.store.close();
});
test("concurrent confirmations cannot both claim the persisted proposal", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  const r = await Promise.allSettled([
    h.service.confirm(p.id, consent(p)),
    h.service.confirm(p.id, consent(p)),
  ]);
  assert.equal(r.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(h.calls, 1);
  h.store.close();
});
test("changed cell cancels before write", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  h.cell = { numberValue: 151 };
  await assert.rejects(h.service.confirm(p.id, consent(p)), {
    code: "cell_changed",
  });
  assert.equal(h.calls, 0);
  assert.equal(h.proposal().status, "cancelled");
  h.store.close();
});
test("changed dependencies cancel before write", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  h.denominator = { numberValue: 101 };
  await assert.rejects(h.service.confirm(p.id, consent(p)), {
    code: "dependencies_changed",
  });
  assert.equal(h.calls, 0);
  h.store.close();
});
test("expired or superseded proposals cannot write", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const old = h.proposal();
  await h.service.prepare(h.id);
  await assert.rejects(h.service.confirm(old.id, consent(old)), {
    code: "proposal_unavailable",
  });
  const p = h.proposal();
  h.now = p.expiresAt + 1;
  await assert.rejects(h.service.confirm(p.id, consent(p)), {
    code: "proposal_expired",
  });
  assert.equal(h.calls, 0);
  h.store.close();
});
test("reopened incident generation invalidates an earlier proposal", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  h.store.db
    .prepare("UPDATE incidents SET generation=generation+1 WHERE id=?")
    .run(h.id);
  await assert.rejects(h.service.confirm(p.id, consent(p)), {
    code: "proposal_expired",
  });
  assert.equal(h.calls, 0);
  h.store.close();
});
test("server-side conditional conflict does not retry or close incident", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  h.conflict = true;
  await assert.rejects(h.service.confirm(p.id, consent(p)), {
    code: "conditional_conflict",
  });
  assert.equal(h.calls, 1);
  assert.equal(h.proposal().status, "cancelled");
  assert.equal(h.store.getIncident(h.id).monitorStatus, "open");
  h.store.close();
});
test("uncertain network result blocks repeated execution and new proposals", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  h.fail = true;
  await assert.rejects(h.service.confirm(p.id, consent(p)), {
    code: "write_uncertain",
  });
  await assert.rejects(h.service.confirm(p.id, consent(p)), {
    code: "proposal_unavailable",
  });
  await assert.rejects(h.service.prepare(h.id), { code: "unresolved_write" });
  assert.equal(h.calls, 1);
  assert.equal(h.proposal().status, "uncertain");
  h.store.close();
});
test("wrong computed result leaves incident open and blocks automatic rollback", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  h.wrong = true;
  await assert.rejects(h.service.confirm(p.id, consent(p)), {
    code: "postcondition_failed",
  });
  assert.equal(h.proposal().status, "uncertain");
  assert.equal(h.store.getIncident(h.id).monitorStatus, "open");
  assert.equal(h.calls, 1);
  h.store.close();
});
test("failed post-write doctor scan does not claim a verified correction", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  h.recheckFail = true;
  await assert.rejects(h.service.confirm(p.id, consent(p)), {
    code: "doctor_recheck_failed",
  });
  assert.equal(h.proposal().status, "uncertain");
  assert.equal(h.store.getIncident(h.id).monitorStatus, "open");
  h.store.close();
});
test("rollback is a separate exact owner-confirmed proposal from the persisted original", async () => {
  const h = harness();
  await h.service.prepare(h.id);
  const p = h.proposal();
  await h.service.confirm(p.id, consent(p));
  await h.service.prepare(h.id, "rollback", p.id);
  const rollback = h.proposal();
  assert.equal(h.calls, 1);
  assert.deepEqual(rollback.to, { numberValue: 150 });
  await h.service.confirm(rollback.id, consent(rollback));
  assert.equal(h.calls, 2);
  assert.equal(h.proposal().status, "verified");
  assert.equal(h.store.getIncident(h.id).monitorStatus, "open");
  h.store.close();
});
test("unverified isolation allows only a read-only plan and blocks owner-confirmed writes", async () => {
  const h = harness();
  h.isolationFail = true;
  await h.service.prepare(h.id);
  const p = h.proposal();
  assert.equal(h.service.state(h.id).isolation.status, "blocked");
  await assert.rejects(h.service.confirm(p.id, consent(p)), {
    code: "production_access_not_denied",
  });
  assert.equal(h.calls, 0);
  h.store.close();
});
test("restart preserves backups and marks interrupted writes uncertain instead of replaying them", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ritm-repair-test-"));
  try {
    const h = harness(path.join(dir, "test.sqlite"));
    await h.service.prepare(h.id);
    const p = h.proposal();
    h.store.db
      .prepare("UPDATE test_repair_proposals SET status='executing' WHERE id=?")
      .run(p.id);
    h.store.close();
    const after = harness(path.join(dir, "test.sqlite"));
    assert.equal(after.proposal().status, "uncertain");
    await assert.rejects(after.service.prepare(after.id), {
      code: "unresolved_write",
    });
    assert.equal(after.calls, 0);
    after.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("configuration fails closed for production port, public origin, live sources, Telegram, unapproved or altered target", () => {
  validateTestRepairConfig(configuration());
  for (const mutate of [
    (c) => (c.port = 4318),
    (c) => (c.publicOrigin = "https://example.com"),
    (c) => (c.sources = [{ enabled: true }]),
    (c) => (c.telegram.enabled = true),
    (c) => (c.doctorDocuments[0].documentId = PRODUCTION_DOCUMENTS[0]),
    (c) => c.doctorDocuments[0].sheets[0].gid++,
    (c) => (c.doctorDocuments[0].sheets[0].rules[0].approval = "pending"),
    (c) => (c.doctorDocuments[0].testSource = false),
  ]) {
    const c = configuration();
    mutate(c);
    assert.throws(() => validateTestRepairConfig(c));
  }
});
test("writer JWT uses only the separate account; isolation rejects publicly editable production without writing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ritm-writer-test-"));
  try {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const file = path.join(dir, "credentials.json");
    writeFileSync(
      file,
      JSON.stringify({
        type: "service_account",
        project_id: "ritm-intelligence",
        client_email: TEST_WRITER_EMAIL,
        private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    );
    let writeCalls = 0;
    const w = new TestSheetsWriter({
      credentialsFile: file,
      fetcher: async (url, options) => {
        if (url.includes("oauth2")) {
          const assertion = new URLSearchParams(options.body).get("assertion");
          const parts = assertion.split(".");
          assert.equal(
            verify(
              "RSA-SHA256",
              Buffer.from(parts[0] + "." + parts[1]),
              pair.publicKey,
              Buffer.from(parts[2], "base64url"),
            ),
            true,
          );
          const payload = JSON.parse(Buffer.from(parts[1], "base64url"));
          assert.equal(payload.iss, TEST_WRITER_EMAIL);
          assert.equal(payload.scope, TEST_WRITE_SCOPE);
          return Response.json({
            access_token: "test-token",
            expires_in: 3600,
          });
        }
        if (options.method === "POST") writeCalls++;
        return Response.json({
          id: url.split("/files/")[1].split("?")[0],
          capabilities: { canEdit: true },
        });
      },
    });
    await assert.rejects(w.verifyIsolation(), {
      code: "production_access_not_denied",
    });
    assert.equal(writeCalls, 0);
    assert.equal(w.verifiedAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("writer builds exactly one fixed-cell conditional request and never retries writes", async () => {
  let requests = [];
  const w = new TestSheetsWriter({
    credentialsFile: "unused",
    fetcher: async (url, options) => {
      requests.push({ url, options });
      throw Error("network");
    },
  });
  w.cached = { token: "test-token", expires: Date.now() + 3600000 };
  w.verifiedAt = new Date().toISOString();
  await assert.rejects(w.conditionalReplace("arbitrary"), {
    code: "invalid_direction",
  });
  assert.equal(requests.length, 0);
  await assert.rejects(w.conditionalReplace("repair"), {
    code: "write_uncertain",
  });
  assert.equal(requests.length, 1);
  const req = JSON.parse(requests[0].options.body).requests;
  assert.equal(req.length, 1);
  assert.equal(
    requests[0].url,
    "https://sheets.googleapis.com/v4/spreadsheets/" +
      TEST_TARGET.documentId +
      ":batchUpdate",
  );
  assert.deepEqual(req[0].findReplace.range, {
    sheetId: TEST_TARGET.sheetId,
    startRowIndex: 246,
    endRowIndex: 247,
    startColumnIndex: 6,
    endColumnIndex: 7,
  });
  assert.equal(req[0].findReplace.find, "150");
  assert.equal(req[0].findReplace.replacement, TEST_TARGET.formula);
  assert.equal(req[0].findReplace.includeFormulas, false);
});
test("API rejects anonymous, bearer-only, forged cell, missing origin, forwarded and public requests", async () => {
  const h = harness();
  const server = createAgentServer(h.store, h.config, { repair: h.service });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const post = (headers, payload = { incidentId: h.id }) =>
      fetch(base + "/api/intelligence/test-repair/propose", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload),
      });
    assert.equal((await post({})).status, 401);
    assert.equal(
      (
        await post({
          authorization: "Bearer " + h.config.ownerToken,
          origin: "http://localhost:4319",
        })
      ).status,
      403,
    );
    const login = await fetch(base + "/api/intelligence/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: h.config.ownerToken }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await post({ cookie })).status, 403);
    assert.equal(
      (await post({ cookie, origin: "https://evil.example" })).status,
      403,
    );
    assert.equal(
      (
        await post({
          cookie,
          origin: "http://localhost:4319",
          "x-forwarded-for": "1.2.3.4",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          { cookie, origin: "http://localhost:4319" },
          { incidentId: h.id, cell: "G248" },
        )
      ).status,
      400,
    );
    const valid = await post({ cookie, origin: "http://localhost:4319" });
    assert.equal(valid.status, 200);
    assert.equal(h.calls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    h.store.close();
  }
});

test("effective capabilities permit publicly readable production only when canEdit is false", async () => {
  const w = new TestSheetsWriter({
    credentialsFile: "unused",
    fetcher: async (url, options) => {
      assert.equal(options.method, "GET");
      assert.match(url, /drive\/v3\/files\//);
      const id = url.split("/files/")[1].split("?")[0];
      return Response.json({
        id,
        capabilities: { canEdit: id === TEST_TARGET.documentId },
      });
    },
  });
  w.cached = { token: "test-token", expires: Date.now() + 3600000 };
  const audit = await w.verifyIsolation();
  assert.equal(audit.productionAccess, "write_denied");
  assert.deepEqual(
    audit.capabilities.map((c) => c.canEdit),
    [true, false, false],
  );
  assert.equal(w.metrics.writeRequests, 0);
});
test("disabled permission API or malformed capabilities fail closed without a Google write", async () => {
  for (const response of [
    Response.json({ error: { code: 403 } }, { status: 403 }),
    Response.json({ id: TEST_TARGET.documentId }),
  ]) {
    const w = new TestSheetsWriter({
      credentialsFile: "unused",
      fetcher: async () => response,
    });
    w.cached = { token: "test-token", expires: Date.now() + 3600000 };
    await assert.rejects(w.verifyIsolation());
    assert.equal(w.verifiedAt, null);
    assert.equal(w.metrics.writeRequests, 0);
  }
});
