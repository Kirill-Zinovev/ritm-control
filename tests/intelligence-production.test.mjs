import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  GoogleSheetsReader,
  SHEETS_READ_SCOPE,
  SheetsAccessError,
} from "../agent/googleSheets.js";
import { loadConfig, publicConfig } from "../agent/config.js";
import { TableDoctor } from "../agent/doctorService.js";
import { DEMO_DOCUMENT, demoSpreadsheet } from "../agent/doctorDemo.js";
import { IncidentStore } from "../agent/store.js";
import { createAgentServer } from "../agent/server.js";
import { backupDatabase } from "../agent/backup.js";
import { measureGrid, accessMessage } from "../agent/doctorTelemetry.js";
const documentId = "x".repeat(30);
function readerHarness(statuses, options = {}) {
  let clock = 1000000,
    calls = 0;
  const times = [],
    waits = [];
  const reader = new GoogleSheetsReader({
    credentialsFile: "not-read-cached-test.json",
    retries: 2,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    fetcher: async () => {
      times.push(clock);
      const status = statuses[Math.min(calls++, statuses.length - 1)];
      return status === 200
        ? Response.json({ spreadsheetId: documentId, sheets: [] })
        : new Response("", { status });
    },
    ...options,
  });
  reader.cached = { token: "synthetic-cache", expires: clock + 3600000 };
  return {
    reader,
    times,
    waits,
    get calls() {
      return calls;
    },
  };
}
test("Sheets GET uses real retry pipeline for 429 and 503; telemetry contains no tokens", async () => {
  const h = readerHarness([429, 503, 200]);
  await h.reader.metadata(documentId);
  assert.equal(h.calls, 3);
  assert.deepEqual(h.waits, [1000, 2000]);
  assert.equal(h.reader.telemetry().readRequests, 3);
  assert.equal(h.reader.telemetry().retries, 2);
  assert.deepEqual(h.reader.telemetry().statuses, { 200: 1, 429: 1, 503: 1 });
  assert.ok(!JSON.stringify(h.reader.telemetry()).includes("synthetic-cache"));
});
test("403 is not retried; quota retries are bounded and 401 invalidates the token", async () => {
  const forbidden = readerHarness([403]);
  await assert.rejects(
    forbidden.reader.metadata(documentId),
    (e) => e.status === 403,
  );
  assert.equal(forbidden.calls, 1);
  assert.match(
    accessMessage(new SheetsAccessError("sheets_unavailable", 403)),
    /403/,
  );
  const quota = readerHarness([429]);
  await assert.rejects(
    quota.reader.metadata(documentId),
    (e) => e.status === 429,
  );
  assert.equal(quota.calls, 3);
  const expired = readerHarness([401]);
  await assert.rejects(
    expired.reader.metadata(documentId),
    (e) => e.status === 401,
  );
  assert.equal(expired.reader.cached, null);
});
test("serialized pacing constrains simultaneous and retried Sheets reads", async () => {
  const h = readerHarness([200], { minIntervalMs: 2000 });
  await Promise.all([
    h.reader.metadata(documentId),
    h.reader.metadata(documentId),
    h.reader.metadata(documentId),
  ]);
  assert.deepEqual(h.times, [1000000, 1002000, 1004000]);
});
test("OAuth token mint also retries temporary failure and uses readonly scope", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ritm-stage3-oauth-"));
  const filename = path.join(dir, "key.json");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(
    filename,
    JSON.stringify({
      type: "service_account",
      client_email: "synthetic@example.invalid",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  let oauth = 0;
  try {
    const reader = new GoogleSheetsReader({
      credentialsFile: filename,
      sleep: async () => {},
      fetcher: async (url, options) => {
        if (String(url).includes("oauth2.googleapis.com")) {
          assert.equal(options.method, "POST");
          const jwt = new URLSearchParams(options.body).get("assertion");
          assert.equal(
            JSON.parse(Buffer.from(jwt.split(".")[1], "base64url")).scope,
            SHEETS_READ_SCOPE,
          );
          oauth++;
          return oauth === 1
            ? new Response("", { status: 503 })
            : Response.json({
                access_token: "synthetic-token",
                expires_in: 3600,
                scope: SHEETS_READ_SCOPE,
              });
        }
        assert.equal(options.method, "GET");
        return Response.json({ spreadsheetId: documentId, sheets: [] });
      },
    });
    await reader.metadata(documentId);
    assert.equal(oauth, 2);
    assert.ok(reader.authorizedAt);
    assert.equal(reader.telemetry().oauthRequests, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function doctorHarness() {
  const store = new IncidentStore(":memory:"),
    config = loadConfig({ RITM_GOOGLE_CREDENTIALS_FILE: "outside-repo-key" });
  const doc = structuredClone(DEMO_DOCUMENT);
  doc.adapter = "google";
  doc.id = "real-document-test";
  doc.documentId = documentId;
  config.doctorDocuments = [doc];
  const grid = demoSpreadsheet("healthy");
  let fail = false,
    clock = new Date("2026-10-08T12:00:00Z");
  const reader = {
    configured: true,
    authorizedAt: clock.toISOString(),
    metadata: async () => {
      if (fail) throw new SheetsAccessError("sheets_unavailable", 429);
      return grid;
    },
    grid: async () => grid,
  };
  const doctor = new TableDoctor(store, config, { reader, now: () => clock });
  return {
    store,
    config,
    doc,
    grid,
    doctor,
    setFailure(v) {
      fail = v;
    },
    setTime(v) {
      clock = v;
    },
  };
}
test("configured path is not verified access; actual formula count differs from rule candidates", async () => {
  const h = doctorHarness();
  try {
    assert.equal(publicConfig(h.config).formulaAccess, "awaiting_verification");
    assert.equal(h.doctor.state().connection, "awaiting_verification");
    h.grid.sheets[0].data[1].rowData[0].values[2].userEnteredValue = {
      formulaValue: "=100/2",
    };
    assert.equal(measureGrid(h.doc, h.grid).formulasRead, 3);
    await h.doctor.run();
    const state = h.doctor.state();
    assert.equal(state.connection, "verified");
    assert.equal(state.formulasRead, 3);
    assert.equal(state.checkedFormulas, 2);
    assert.ok(state.documents[0].check.readVerifiedAt);
    assert.ok(state.documents[0].check.durationMs >= 0);
    h.setTime(new Date("2026-10-08T13:00:00Z"));
    assert.equal(h.doctor.state().connection, "awaiting_verification");
    assert.equal(h.doctor.state().formulasRead, null);
  } finally {
    h.store.close();
  }
});
test("real access failure preserves last successful time without reporting zero formulas", async () => {
  const h = doctorHarness();
  try {
    await h.doctor.run();
    const verified = h.doctor.state().documents[0].check.readVerifiedAt;
    h.setFailure(true);
    await h.doctor.run();
    const state = h.doctor.state();
    assert.equal(state.connection, "unavailable");
    assert.equal(state.formulasRead, null);
    assert.equal(state.documents[0].check.readVerifiedAt, verified);
    assert.equal(state.documents[0].check.httpStatus, 429);
    const id = h.store.listIncidents().rows[0].id;
    await h.doctor.run();
    assert.equal(h.store.listIncidents().total, 1);
    assert.equal(h.store.listIncidents().rows[0].id, id);
    h.setFailure(false);
    await h.doctor.run();
    assert.equal(h.store.getIncident(id).status, "fixed");
  } finally {
    h.store.close();
  }
});
test("online backup restores incidents, history and WAL state; restart lease remains enforced", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ritm-stage3-backup-")),
    store = new IncidentStore(path.join(dir, "source.sqlite"));
  try {
    store.log("test", "Synthetic audit");
    store.meta("test", { present: true });
    store.reconcile("synthetic", [
      {
        sourceId: "synthetic-source",
        type: "test-fault",
        severity: "warning",
        title: "Synthetic issue",
      },
    ]);
    assert.equal(store.acquire("process-a"), true);
    assert.equal(store.acquire("process-b"), false);
    const filename = await backupDatabase(
      path.join(dir, "source.sqlite"),
      path.join(dir, "backups"),
    );
    const copy = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.ok(copy.prepare("SELECT count(*) AS n FROM history").get().n >= 1);
      assert.equal(
        copy.prepare("SELECT count(*) AS n FROM incidents").get().n,
        1,
      );
      assert.equal(
        JSON.parse(
          copy.prepare("SELECT value FROM metadata WHERE key='test'").get()
            .value,
        ).present,
        true,
      );
      assert.equal(
        Object.values(copy.prepare("PRAGMA quick_check").get())[0],
        "ok",
      );
    } finally {
      copy.close();
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("HTTPS-only origin configuration, Secure session and private API rate limit", async () => {
  assert.throws(() =>
    loadConfig({ RITM_PUBLIC_ORIGIN: "http://external.example" }),
  );
  const store = new IncidentStore(":memory:");
  const config = loadConfig({
    RITM_PUBLIC_ORIGIN: "https://agent.example",
    RITM_OWNER_TOKEN: "synthetic-owner-key".repeat(3),
  });
  config.apiRateLimit = 4;
  const server = createAgentServer(store, config);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const response = await fetch(base + "/api/intelligence/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://agent.example",
      },
      body: JSON.stringify({ token: config.ownerToken }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /Secure/);
    assert.equal((await fetch(base + "/api/intelligence/status")).status, 401);
    assert.equal(
      (await fetch(base + "/api/intelligence/doctor/run", { method: "POST" }))
        .status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/api/intelligence/status", {
          headers: { origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(base + "/api/intelligence/status")).status, 429);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test("Retry-After is honored within the bounded retry timeout", async () => {
  let count = 0;
  const waits = [];
  const h = readerHarness([200], {
    sleep: async (ms) => waits.push(ms),
    fetcher: async () =>
      ++count === 1
        ? new Response("", { status: 429, headers: { "retry-after": "3" } })
        : Response.json({ spreadsheetId: documentId, sheets: [] }),
  });
  await h.reader.metadata(documentId);
  assert.deepEqual(waits, [3000]);
});

test("manual connector audit never verifies autonomous authorization or creates incidents", () => {
  const h = doctorHarness();
  try {
    h.store.snapshot("doctor:manual-audit", {
      channel: "google_drive_connector",
      formulasRead: 6601,
      at: new Date().toISOString(),
      sheets: [],
    });
    const state = h.doctor.state();
    assert.equal(state.manualAudit.formulasRead, 6601);
    assert.equal(state.connection, "awaiting_verification");
    assert.equal(state.formulasRead, null);
    assert.equal(h.store.listIncidents().total, 0);
  } finally {
    h.store.close();
  }
});
