import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, verify } from "node:crypto";
import { inspectDocument, parseDoctorDate } from "../agent/doctor.js";
import { DEMO_DOCUMENT, demoSpreadsheet } from "../agent/doctorDemo.js";
import { validateDoctorDocuments } from "../agent/doctorRegistry.js";
import { IncidentStore } from "../agent/store.js";
import { TableDoctor } from "../agent/doctorService.js";
import {
  GoogleSheetsReader,
  SHEETS_READ_SCOPE,
} from "../agent/googleSheets.js";
import { loadConfig, publicConfig } from "../agent/config.js";
import { createAgentServer } from "../agent/server.js";
import { flushTelegram } from "../agent/telegram.js";
const now = new Date("2026-10-08T09:00:00Z");
const inspect = (scenario, doc = DEMO_DOCUMENT) =>
  inspectDocument(doc, demoSpreadsheet(scenario), { now });
test("deleted formula is distinguished from replacement by number with exact approved expectation", () => {
  assert.equal(inspect("missing").findings[0].type, "formula_missing");
  const incident = inspect("number").findings[0];
  assert.equal(incident.type, "formula_number");
  assert.equal(incident.observed, 150);
  assert.equal(incident.expected, "=C247/D247");
  assert.equal(incident.verification, "rule_confirmed");
  assert.equal(incident.sourceUrl, null);
  assert.equal(incident.demonstration, true);
});
test("correct formula and approved row exception pass without neighbor inference", () => {
  assert.deepEqual(inspect("healthy").findings, []);
  assert.equal(inspect("healthy").stats.checkedFormulas, 2);
  assert.equal(inspect("mismatch").findings[0].type, "formula_mismatch");
  const d = structuredClone(DEMO_DOCUMENT);
  d.sheets[0].rules[0].exceptions.push({
    rows: [247],
    reason: "Approved manual override",
  });
  assert.equal(inspect("number", d).findings.length, 0);
});
test("pending template differences are review-only and do not propose a known repair", () => {
  const d = structuredClone(DEMO_DOCUMENT);
  d.sheets[0].rules[0].approval = "pending";
  const f = inspect("mismatch", d).findings[0];
  assert.equal(f.initialStatus, "review");
  assert.equal(f.expected, null);
  assert.equal(f.verification, "needs_review");
  assert.deepEqual(inspect("healthy", d).baseline, {});
});
test("REF and DIV/0 effective errors are detected even with a formula present", () => {
  assert.match(inspect("ref").findings[0].observed, /REF/);
  assert.equal(inspect("ref").findings[0].type, "calculation_error");
  assert.match(inspect("div_zero").findings[0].observed, /DIVIDE_BY_ZERO/);
  const grid = demoSpreadsheet();
  grid.sheets[0].data[1].rowData[1].values[6].userEnteredValue.formulaValue =
    "=#REF!";
  assert.equal(
    inspectDocument(DEMO_DOCUMENT, grid).findings[0].type,
    "invalid_reference",
  );
});
test("structure change suspends cell evaluation and prevents false closure", () => {
  const r = inspect("schema");
  assert.equal(r.complete, false);
  assert.equal(r.findings[0].type, "structure_changed");
  assert.equal(r.stats.checkedFormulas, 0);
  const deleted = demoSpreadsheet();
  deleted.sheets = [];
  assert.equal(inspectDocument(DEMO_DOCUMENT, deleted).complete, false);
});
test("result consistency, duplicates, required UIDs and real numeric types are validated", () => {
  const grid = demoSpreadsheet();
  grid.sheets[0].data[1].rowData[1].values[6].effectiveValue.numberValue = 0;
  assert.equal(
    inspectDocument(DEMO_DOCUMENT, grid).findings[0].type,
    "business_rule",
  );
  grid.sheets[0].data[1].rowData[1].values[0] = structuredClone(
    grid.sheets[0].data[1].rowData[0].values[0],
  );
  assert.ok(
    inspectDocument(DEMO_DOCUMENT, grid).findings.some(
      (f) => f.type === "duplicate_uid",
    ),
  );
  grid.sheets[0].data[1].rowData[1].values[0] = {};
  assert.ok(
    inspectDocument(DEMO_DOCUMENT, grid).findings.some(
      (f) => f.type === "missing_uid",
    ),
  );
});
test("native date serials and calendar dates are supported; impossible dates are rejected", () => {
  assert.equal(parseDoctorDate(46302).toISOString().slice(0, 10), "2026-10-07");
  assert.equal(parseDoctorDate("31.02.2026"), null);
  assert.equal(parseDoctorDate("08.10.2026 25:00"), null);
});
test("registry rejects unbounded scans, implicit exceptions and malformed business rules", () => {
  const d = structuredClone(DEMO_DOCUMENT);
  d.sheets[0].rules[0].exceptions = [{ reason: "all rows" }];
  assert.throws(() => validateDoctorDocuments([d]));
  const huge = structuredClone(DEMO_DOCUMENT);
  huge.sheets[0].maxRows = 10000;
  huge.sheets[0].lastColumn = "ZZ";
  assert.throws(() => validateDoctorDocuments([huge]));
});
function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), "ritm-doctor-test-"));
  const config = loadConfig({
    RITM_DATA_DIR: dir,
    RITM_DOCTOR_DEMO_ENABLED: "true",
    RITM_OWNER_TOKEN: "test-owner-".repeat(4),
  });
  config.doctorDocuments = [structuredClone(DEMO_DOCUMENT)];
  const store = new IncidentStore(path.join(dir, "incidents.sqlite"));
  const doctor = new TableDoctor(store, config, { now: () => now });
  return {
    dir,
    config,
    store,
    doctor,
    clean() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("full persistent lifecycle: healthy -> fault -> repeat -> repair request -> fixed -> restart", async () => {
  const h = harness();
  try {
    await h.doctor.run();
    assert.equal(h.store.overview().active, 0);
    await h.doctor.setDemo("number");
    const first = h.store.listIncidents().rows[0];
    assert.equal(first.status, "new");
    assert.equal(first.previousFormula, "=C247/D247");
    await h.doctor.run();
    const repeated = h.store.getIncident(first.id);
    assert.equal(repeated.status, "confirmed");
    assert.equal(repeated.occurrences, 2);
    assert.equal(h.store.listIncidents().total, 1);
    assert.equal(repeated.previousFormula, "=C247/D247");
    h.store.incidentAction(first.id, "request-repair");
    h.store.incidentAction(first.id, "request-repair");
    assert.equal(
      h.store.db.prepare("SELECT count(*) n FROM repair_requests").get().n,
      1,
    );
    assert.equal(h.store.getIncident(first.id).repairRequested, true);
    await h.doctor.setDemo("healthy");
    assert.equal(h.store.getIncident(first.id).status, "fixed");
    assert.equal(h.store.overview().active, 0);
    h.store.close();
    h.store = new IncidentStore(path.join(h.dir, "incidents.sqlite"));
    assert.equal(h.store.getIncident(first.id).status, "fixed");
    assert.equal(h.store.getIncident(first.id).repairRequested, true);
  } finally {
    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});
test("ignored issues stay ignored across repeated checks and local requests never edit production", async () => {
  const h = harness();
  try {
    await h.doctor.setDemo("number");
    const id = h.store.listIncidents().rows[0].id;
    h.store.incidentAction(id, "ignore");
    await h.doctor.run();
    assert.equal(h.store.getIncident(id).status, "ignored");
    assert.equal(h.store.overview().active, 0);
    assert.equal(
      h.store.db.prepare("SELECT count(*) n FROM outbox").get().n,
      0,
    );
  } finally {
    h.clean();
  }
});
test("API outages preserve previous incidents; schema failures do not close affected cells", async () => {
  const h = harness();
  try {
    await h.doctor.setDemo("number");
    const id = h.store.listIncidents().rows[0].id;
    await h.doctor.setDemo("schema");
    assert.equal(h.store.getIncident(id).monitorStatus, "open");
    const doc = structuredClone(DEMO_DOCUMENT);
    doc.id = "doctor-live-test";
    doc.adapter = "google";
    doc.documentId = "a".repeat(30);
    h.config.doctorDocuments = [doc];
    const doctor = new TableDoctor(h.store, h.config, {
      reader: {
        configured: true,
        metadata: async () => {
          throw new Error("offline");
        },
      },
      now: () => now,
    });
    const scope = "doctor:data:" + doc.id;
    h.store.reconcile(scope, [
      { ...inspect("number").findings[0], sourceId: doc.id },
    ]);
    const dataId = h.store.listIncidents({
      source: doc.id,
      type: "formula_number",
    }).rows[0].id;
    await doctor.run();
    assert.equal(h.store.getIncident(dataId).monitorStatus, "open");
    assert.equal(doctor.state().documents[0].check.status, "unavailable");
  } finally {
    h.clean();
  }
});
test("schedule skips weekends and only flags data age inside the approved working window", () => {
  const d = structuredClone(DEMO_DOCUMENT);
  d.freshness = {
    sheetId: 1,
    column: "C",
    startRow: 246,
    endRow: 247,
    maximumAgeMinutes: 60,
    activeWeekdays: [1, 2, 3, 4, 5],
    startHour: 9,
    endHour: 18,
  };
  assert.ok(
    inspectDocument(d, demoSpreadsheet(), { now }).findings.some(
      (f) => f.type === "stale_data",
    ),
  );
  assert.ok(
    !inspectDocument(d, demoSpreadsheet(), {
      now: new Date("2026-10-10T09:00:00Z"),
    }).findings.some((f) => f.type === "stale_data"),
  );
});
test("owner API protects private reads, manual scans, demo writes and local incident actions", async () => {
  const h = harness();
  const server = createAgentServer(h.store, h.config, { doctor: h.doctor });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    for (const [url, method] of [
      ["/api/intelligence/doctor", "GET"],
      ["/api/intelligence/doctor/run", "POST"],
      ["/api/intelligence/doctor/demo", "POST"],
      ["/api/intelligence/incidents/" + "a".repeat(64) + "/ignore", "POST"],
    ])
      assert.equal((await fetch(base + url, { method })).status, 401);
    const headers = {
      authorization: "Bearer " + h.config.ownerToken,
      "content-type": "application/json",
    };
    assert.equal(
      (
        await fetch(base + "/api/intelligence/doctor/demo", {
          method: "POST",
          headers,
          body: JSON.stringify({ scenario: "number" }),
        })
      ).status,
      200,
    );
    const first = h.store.listIncidents().rows[0];
    assert.equal(
      (
        await fetch(
          base + "/api/intelligence/incidents/" + first.id + "/request-repair",
          { method: "POST", headers },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/api/intelligence/sheets/write", {
          method: "POST",
          headers,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/intelligence/doctor/run", {
          method: "POST",
          headers: { ...headers, origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/intelligence/doctor/demo", {
          method: "POST",
          headers,
          body: JSON.stringify({ scenario: "../../source" }),
        })
      ).status,
      400,
    );
  } finally {
    await new Promise((r) => server.close(r));
    h.clean();
  }
});
test("new confirmed real issues notify once; review and demo findings never send alerts", async () => {
  const store = new IncidentStore(":memory:");
  try {
    const real = {
      ...inspect("number").findings[0],
      demonstration: false,
      sourceUrl:
        "https://docs.google.com/spreadsheets/d/" +
        "a".repeat(30) +
        "/edit#gid=1&range=G247",
    };
    store.reconcile("live", [real]);
    store.reconcile("live", [real]);
    let sends = 0;
    const config = {
      enabled: true,
      token: "synthetic-token",
      chatId: "synthetic-owner",
    };
    const fetcher = async () => {
      sends++;
      return Response.json({ ok: true });
    };
    await flushTelegram(store, config, { fetcher, now: new Date() });
    await flushTelegram(store, config, { fetcher, now: new Date() });
    assert.equal(sends, 1);
    store.reconcile("review", [
      { ...real, verification: "needs_review", initialStatus: "review" },
    ]);
    store.reconcile("demo", [inspect("number").findings[0]]);
    await flushTelegram(store, config, { fetcher, now: new Date() });
    assert.equal(sends, 1);
  } finally {
    store.close();
  }
});
test("Google client signs readonly JWT, caches tokens and uses fixed GET-only bounded endpoints", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ritm-google-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const file = path.join(dir, "service-account.json");
  writeFileSync(
    file,
    JSON.stringify({
      type: "service_account",
      client_email: "test@example.invalid",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  const id = "a".repeat(30),
    calls = [];
  try {
    const client = new GoogleSheetsReader({
      credentialsFile: file,
      now: () => now.getTime(),
      fetcher: async (url, options) => {
        calls.push([String(url), options]);
        if (String(url).startsWith("https://oauth2.googleapis.com/")) {
          const jwt = new URLSearchParams(options.body).get("assertion"),
            parts = jwt.split(".");
          const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
          assert.equal(claims.scope, SHEETS_READ_SCOPE);
          assert.equal(claims.exp - claims.iat, 3600);
          assert.ok(
            verify(
              "RSA-SHA256",
              Buffer.from(parts[0] + "." + parts[1]),
              publicKey,
              Buffer.from(parts[2], "base64url"),
            ),
          );
          return Response.json({
            access_token: "synthetic-access-token",
            expires_in: 3600,
            scope: SHEETS_READ_SCOPE,
          });
        }
        assert.equal(options.method, "GET");
        assert.equal(options.redirect, "error");
        return Response.json({ spreadsheetId: id, sheets: [] });
      },
    });
    await client.metadata(id);
    await client.grid(id, ["'Коэффициенты'!A1:G247"]);
    assert.equal(calls.length, 3);
    assert.equal(typeof client.update, "undefined");
    assert.throws(() => client.grid(id, ["A:G"]), /bounded_ranges_required/);
    const cfg = loadConfig({ RITM_GOOGLE_CREDENTIALS_FILE: file });
    assert.ok(!JSON.stringify(publicConfig(cfg)).includes(file));
    assert.ok(!JSON.stringify(publicConfig(cfg)).includes("private_key"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("approved formula baseline is not reused after rules change", () => {
  const healthy = inspect("healthy"),
    document = structuredClone(DEMO_DOCUMENT);
  document.sheets[0].rules[0].templates = ["=C{row}*D{row}"];
  const findings = inspectDocument(document, demoSpreadsheet("number"), {
    baseline: healthy.baseline,
  }).findings;
  assert.equal(findings[0].previousFormula, null);
});

test("review becomes confirmed once approved and queues one notification; demo counters remain separate", () => {
  const store = new IncidentStore(":memory:");
  try {
    const finding = inspect("number").findings[0];
    store.reconcile("demo", [finding]);
    assert.equal(store.overview().active, 0);
    assert.equal(store.overview().demoActive, 1);
    const real = {
      ...finding,
      demonstration: false,
      initialStatus: "review",
      verification: "needs_review",
    };
    store.reconcile("real", [real]);
    assert.equal(store.db.prepare("SELECT count(*) n FROM outbox").get().n, 0);
    store.reconcile("real", [{ ...real, verification: "rule_confirmed" }]);
    assert.equal(store.db.prepare("SELECT count(*) n FROM outbox").get().n, 1);
    store.reconcile("real", [{ ...real, verification: "rule_confirmed" }]);
    assert.equal(store.db.prepare("SELECT count(*) n FROM outbox").get().n, 1);
  } finally {
    store.close();
  }
});
test("freshness interprets native local timestamps in Moscow", () => {
  const d = structuredClone(DEMO_DOCUMENT);
  d.freshness = {
    sheetId: 1,
    column: "B",
    startRow: 246,
    endRow: 247,
    maximumAgeMinutes: 60,
    activeWeekdays: [1, 2, 3, 4, 5],
    startHour: 9,
    endHour: 18,
  };
  const grid = demoSpreadsheet();
  grid.sheets[0].data[1].rowData[1].values[1] = {
    effectiveValue: { stringValue: "08.10.2026 11:05:00" },
  };
  assert.ok(
    !inspectDocument(d, grid, { now }).findings.some(
      (f) => f.type === "stale_data",
    ),
  );
  grid.sheets[0].data[1].rowData[1].values[1].effectiveValue.stringValue =
    "08.10.2026 10:59:00";
  assert.ok(
    inspectDocument(d, grid, { now }).findings.some(
      (f) => f.type === "stale_data",
    ),
  );
});
