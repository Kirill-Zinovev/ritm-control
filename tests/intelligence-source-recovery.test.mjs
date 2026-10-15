import test from "node:test";
import assert from "node:assert/strict";
import { IncidentStore } from "../agent/store.js";
import { SourceRecoveryService } from "../agent/sourceRecovery.js";
import { ProductionSheetsWriter } from "../agent/productionRepair.js";
import { PRODUCTION_DOCTOR_DOCUMENTS } from "../agent/productionRegistry.js";
import { createAgentServer } from "../agent/server.js";
import { digest } from "../agent/diagnosticGrid.js";

const SHOP_ID = "doctor-shop-one";
const DOCUMENT_ID = "1YTQQ1Mg9kVv7EOQiN6wOvkvnHvsiXcwbhYOERUPy8rQ";
const INCIDENT_ID = "a".repeat(64);
const SOURCE_SHEET = "Товары НОВАЯ ПЕЧАТЬ 20.07.2026";
const PRODUCTION_SHEET = "Первый магазин НОВАЯ ПЕЧАТЬ 20.07.2026";
const SKU = "FT0001.A8222(OZ)";
const VALUE = { stringValue: "Елочные игрушки" };
const NOW = Date.parse("2026-10-12T10:49:00.000Z");
const format = (value) => ({ effectiveValue: { stringValue: value } });
const formula = (value, effectiveValue = null) => ({
  userEnteredValue: { formulaValue: value },
  ...(effectiveValue ? { effectiveValue } : {}),
});
function columnIndex(letters) {
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}
function columnName(index) {
  let value = "";
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26))
    value = String.fromCharCode(65 + ((n - 1) % 26)) + value;
  return value;
}

function fixture({
  sourceValue = null,
  recalculate = true,
  permission = true,
  doctorStateResult = false,
  recalculateAfterRead = null,
  writerFailure = null,
  postWriteRead = null,
} = {}) {
  const store = new IncidentStore(":memory:"),
    config = {
      productionRepairEnabled: true,
      productionWriterCredentialsFile: "writer-key-outside-repo.json",
      productionWriterEmail:
        "ritm-test-writer@ritm-intelligence.iam.gserviceaccount.com",
      googleCredentialsFile: "reader-key-outside-repo.json",
      testWriterCredentialsFile: "",
      doctorDemoEnabled: false,
      publicOrigin: "",
      port: 4318,
      snapshotMaxAgeMs: 20 * 60 * 1000,
      doctorDocuments: PRODUCTION_DOCTOR_DOCUMENTS,
    },
    sourceCells = new Map(),
    productionCells = new Map(),
    target = {
      documentId: DOCUMENT_ID,
      sheetId: 1335787439,
      sheet: SOURCE_SHEET,
      cell: "P4",
    };
  store.db.exec(
    "CREATE TABLE test_repair_proposals(id TEXT PRIMARY KEY,incident_id TEXT,status TEXT,payload TEXT,result TEXT);",
  );
  sourceCells.set("A4", format(SKU));
  sourceCells.set("Q4", format("Стикербуки, значки и пр."));
  if (sourceValue)
    sourceCells.set("P4", {
      userEnteredValue: sourceValue,
      effectiveValue: sourceValue,
    });
  for (let row = 19; row <= 23; row++) {
    productionCells.set(`A${row}`, formula(`=J${row}`, { stringValue: SKU }));
    productionCells.set(
      `B${row}`,
      formula(
        `=VLOOKUP(A:A;'${SOURCE_SHEET}'!A:P;16;0)`,
        sourceValue && recalculate ? { stringValue: VALUE.stringValue } : null,
      ),
    );
    productionCells.set(
      `C${row}`,
      formula(
        `=VLOOKUP(B:B;'Нормы'!A:C;3;0)`,
        recalculate && sourceValue
          ? { numberValue: 2.5 }
          : { errorValue: { type: "N_A", message: "lookup failed" } },
      ),
    );
    productionCells.set(
      `AP${row}`,
      formula(
        `=IF(AN${row}>\"\";AR${row}/C${row};\"\")`,
        recalculate && sourceValue
          ? { numberValue: 4.25 }
          : { errorValue: { type: "N_A", message: "lookup failed" } },
      ),
    );
    productionCells.set(`AN${row}`, format("активно"));
    productionCells.set(`AR${row}`, { effectiveValue: { numberValue: 10 } });
  }
  let readerCalls = 0,
    writerHasRun = false;
  const recalculateDependents = () => {
    for (let row = 19; row <= 23; row++) {
      productionCells.set(`B${row}`, {
        ...productionCells.get(`B${row}`),
        effectiveValue: VALUE,
      });
      productionCells.set(`C${row}`, {
        ...productionCells.get(`C${row}`),
        effectiveValue: { numberValue: 2.5 },
      });
      productionCells.set(`AP${row}`, {
        ...productionCells.get(`AP${row}`),
        effectiveValue: { numberValue: 4.25 },
      });
    }
  };
  const reader = {
    async get(documentId, params) {
      assert.equal(documentId, DOCUMENT_ID);
      readerCalls++;
      if (
        writerHasRun &&
        recalculate &&
        Number.isInteger(recalculateAfterRead) &&
        readerCalls >= recalculateAfterRead
      )
        recalculateDependents();
      if (writerHasRun && postWriteRead) await postWriteRead();
      const sheets = new Map();
      for (const range of params.ranges) {
        const match = range.match(
          /^'((?:[^']|'')+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/,
        );
        assert.ok(match, `unexpected range ${range}`);
        const name = match[1].replaceAll("''", "'"),
          startColumn = columnIndex(match[2]),
          startRow = Number(match[3]) - 1,
          endColumn = columnIndex(match[4]),
          endRow = Number(match[5]) - 1,
          gid = name === SOURCE_SHEET ? 1335787439 : 1580315960,
          sheet = sheets.get(gid) || {
            properties: { sheetId: gid, title: name },
            merges: [],
            data: [],
          },
          cells = gid === 1335787439 ? sourceCells : productionCells,
          rowData = [];
        for (let row = startRow; row <= endRow; row++) {
          const values = [];
          for (let column = startColumn; column <= endColumn; column++)
            values.push(cells.get(columnName(column) + (row + 1)) || {});
          rowData.push({ values });
        }
        sheet.data.push({ startRow, startColumn, rowData });
        sheets.set(gid, sheet);
      }
      return { spreadsheetId: DOCUMENT_ID, sheets: [...sheets.values()] };
    },
  };
  let writeCalls = 0,
    writtenTarget = null,
    writtenValue = null;
  const writer = {
    async verifyIsolation() {
      return {
        canEdit: permission === true,
        accessCheck: "drive_capabilities",
      };
    },
    async writeSourceValue(operation) {
      writeCalls++;
      writtenTarget = operation.target;
      writtenValue = operation.value;
      if (operation.target.cell !== "P4") throw new Error("unexpected target");
      if (writerFailure) {
        const error = new Error(
          writerFailure.message || "Google rejected write",
        );
        error.code = writerFailure.code || "write_rejected";
        throw error;
      }
      sourceCells.set("P4", {
        userEnteredValue: operation.value,
        effectiveValue: operation.value,
      });
      writerHasRun = true;
      if (recalculate && !Number.isInteger(recalculateAfterRead))
        recalculateDependents();
      return { changed: 1, atomicCompareAndSet: false };
    },
  };
  const doctor = {
    async runDocument(sourceId) {
      assert.equal(sourceId, SHOP_ID);
      if (recalculate && sourceValue === null) {
        for (let row = 19; row <= 23; row++) {
          productionCells.set(`B${row}`, {
            ...productionCells.get(`B${row}`),
            effectiveValue: VALUE,
          });
          productionCells.set(`C${row}`, {
            ...productionCells.get(`C${row}`),
            effectiveValue: { numberValue: 2.5 },
          });
          productionCells.set(`AP${row}`, {
            ...productionCells.get(`AP${row}`),
            effectiveValue: { numberValue: 4.25 },
          });
        }
      }
      store.db
        .prepare(
          "UPDATE incidents SET status='resolved',resolved_at=?,workflow='confirmed' WHERE id=?",
        )
        .run(new Date(NOW).toISOString(), INCIDENT_ID);
      return doctorStateResult
        ? {
            documents: [
              {
                id: SHOP_ID,
                check: {
                  status: "ok",
                  errorCode: null,
                  readVerifiedAt: new Date(NOW).toISOString(),
                },
              },
            ],
          }
        : {
            complete: true,
            documentId: SHOP_ID,
            startedAt: new Date(NOW).toISOString(),
            at: new Date(NOW).toISOString(),
            documentRun: {
              documentId: SHOP_ID,
              complete: true,
              startedAt: new Date(NOW).toISOString(),
              at: new Date(NOW).toISOString(),
              status: "ok",
              errorCode: null,
            },
          };
    },
  };
  const finding = {
    kind: "table_doctor",
    sourceId: SHOP_ID,
    sourceName: "OZON Первый магазин",
    department: "Сборка",
    sheet: SOURCE_SHEET,
    gid: 1335787439,
    cell: "P4",
    row: 4,
    type: "data_quality_root_cause",
    dataQualityRule: "shop-required-product-kind",
    sourceFieldColumn: "P",
    sourceState: "missing",
    verification: "rule_confirmed",
    observed: { productKey: SKU },
    recoveryCandidate: {
      status: "candidate",
      value: VALUE,
      observedAt: new Date(NOW - 60_000).toISOString(),
      confirmation: "Подтверждаю P4: Елочные игрушки",
      evidence: "Успешное полное чтение Google Sheets до исчезновения значения",
    },
    dependencyPaths: Array.from({ length: 5 }, (_, i) => {
      const row = 19 + i;
      return {
        outputCell: `AP${row}`,
        cells: [
          `${PRODUCTION_SHEET}!AP${row}`,
          `${PRODUCTION_SHEET}!C${row}`,
          `${PRODUCTION_SHEET}!B${row}`,
          `${SOURCE_SHEET}!P4`,
          `${PRODUCTION_SHEET}!A${row}`,
          `${PRODUCTION_SHEET}!AR${row}`,
          `${PRODUCTION_SHEET}!AN${row}`,
        ],
      };
    }),
  };
  store.db
    .prepare(
      "INSERT INTO incidents(id,scope,payload,status,first_seen,last_seen,resolved_at,occurrences,generation,workflow) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      INCIDENT_ID,
      "doctor:data-quality:" + SHOP_ID,
      JSON.stringify(finding),
      "open",
      new Date(NOW - 5 * 60_000).toISOString(),
      new Date(NOW - 10_000).toISOString(),
      null,
      1,
      1,
      "confirmed",
    );
  store.snapshot(
    "doctor:source-values:" + SHOP_ID,
    {
      version: "fixture-version",
      cells: {
        P4: {
          current: null,
          currentAt: new Date(NOW).toISOString(),
          currentOrigin: "entered",
          history: [
            {
              value: VALUE,
              origin: "entered",
              at: finding.recoveryCandidate.observedAt,
            },
          ],
        },
      },
    },
    new Date(NOW).toISOString(),
  );
  const requestId = INCIDENT_ID + ":1";
  store.db.prepare("INSERT INTO repair_requests VALUES(?,?,?,?,?,?)").run(
    requestId,
    INCIDENT_ID,
    1,
    new Date(NOW - 30_000).toISOString(),
    "pending",
    JSON.stringify({
      finding,
      ownerConfirmation: {
        at: new Date(NOW - 30_000).toISOString(),
        sourceCell: "P4",
        sheet: SOURCE_SHEET,
        value: VALUE,
        confirmation: finding.recoveryCandidate.confirmation,
        owner: "authenticated_local_owner",
        googleSheetsChanged: false,
      },
    }),
  );
  const service = new SourceRecoveryService(store, config, {
    reader,
    writer,
    doctor,
    now: () => NOW,
    retryDelayMs: 0,
  });
  return {
    store,
    config,
    service,
    reader,
    writer,
    doctor,
    sourceCells,
    productionCells,
    target,
    get writeCalls() {
      return writeCalls;
    },
    get readerCalls() {
      return readerCalls;
    },
    get writtenTarget() {
      return writtenTarget;
    },
    get writtenValue() {
      return writtenValue;
    },
  };
}

test("owner-authorized source recovery writes only P4 and verifies B/C/AP rows before closing", async () => {
  const h = fixture();
  const started = h.service.startForIncident(INCIDENT_ID, {
    incidentId: INCIDENT_ID,
    explicitWriteApproval: true,
  });
  assert.equal(started.status, "repairing");
  const operation = await h.service.waitForOperation(started.id);
  assert.equal(operation.status, "verified", JSON.stringify(operation.result));
  assert.equal(h.writeCalls, 1);
  assert.deepEqual(h.writtenTarget, h.target);
  assert.deepEqual(h.writtenValue, VALUE);
  assert.equal(
    h.sourceCells.get("P4").userEnteredValue.stringValue,
    VALUE.stringValue,
  );
  assert.equal(h.store.getIncident(INCIDENT_ID).monitorStatus, "resolved");
  assert.equal(
    h.store.getIncident(INCIDENT_ID).resolvedBy,
    "agent_after_owner_confirmation",
  );
  assert.equal(operation.result.dependentRows.length, 5);
  assert.ok(operation.result.dependentRows.every((row) => row.norm === 2.5));
  assert.ok(
    operation.result.dependentRows.every((row) => row.coefficient === 4.25),
  );
  assert.equal(operation.result.fullDoctorCheck.complete, true);
  assert.equal(
    operation.result.fullDoctorCheck.verification,
    "document_run_contract",
  );
  assert.deepEqual(Object.keys(operation.result.timing.stages), [
    "preflight",
    "writer_access",
    "pre_write_recheck",
    "write",
    "post_write_readback",
    "full_doctor_check",
    "finalize",
  ]);
  assert.ok(
    Object.values(operation.result.timing.stages).every(
      (stage) => Number.isFinite(stage.durationMs) && stage.durationMs >= 0,
    ),
  );
  const history = h.store.history(0, 20).rows;
  assert.ok(history.some((row) => row.type === "source_recovery_authorized"));
  assert.ok(history.some((row) => row.type === "source_recovery_verified"));
  assert.equal(
    h.store.db
      .prepare("SELECT status FROM repair_requests WHERE id=?")
      .get(INCIDENT_ID + ":1").status,
    "completed",
  );
  h.store.close();
});

test("Telegram repair authorization is bound to the current owner, incident and candidate fingerprint", async () => {
  const h = fixture();
  try {
    const incident = h.store.getIncident(INCIDENT_ID);
    const fingerprint = digest({ incidentId: INCIDENT_ID, generation: 1, candidate: incident.recoveryCandidate });
    const payload = { incidentId: INCIDENT_ID, explicitWriteApproval: true };
    const authorization = { source: "telegram_owner_button", channel: "telegram", actor: "owner-77", expectedCandidateFingerprint: fingerprint };
    assert.throws(
      () => h.service.startForIncident(INCIDENT_ID, payload, { ...authorization, expectedCandidateFingerprint: "f".repeat(64) }),
      { code: "source_candidate_version_changed" },
    );
    assert.equal(h.writeCalls, 0);
    const started = h.service.startForIncident(INCIDENT_ID, payload, authorization);
    const operation = await h.service.waitForOperation(started.id);
    assert.equal(operation.status, "verified", JSON.stringify(operation.result));
    const row = h.store.db.prepare("SELECT authorization FROM source_recovery_operations WHERE id=?").get(started.id);
    const audit = JSON.parse(row.authorization);
    assert.equal(audit.owner, "linked_telegram_owner");
    assert.equal(audit.source, "telegram_owner_button");
    assert.equal(audit.actor, "owner-77");
    assert.equal(audit.candidateFingerprint, fingerprint);
    assert.equal(h.writeCalls, 1);
  } finally { h.store.close(); }
});

function withoutHistoricalValue(h) {
  h.store.db.prepare("DELETE FROM repair_requests WHERE incident_id=?").run(INCIDENT_ID);
  const row = h.store.db.prepare("SELECT payload FROM incidents WHERE id=?").get(INCIDENT_ID), finding = JSON.parse(row.payload);
  delete finding.recoveryCandidate;
  h.store.db.prepare("UPDATE incidents SET payload=? WHERE id=?").run(JSON.stringify(finding), INCIDENT_ID);
  const snapshot = h.store.getSnapshot("doctor:source-values:" + SHOP_ID);
  snapshot.value.cells.P4.history = [];
  snapshot.value.cells.P4.key = SKU;
  h.store.snapshot("doctor:source-values:" + SHOP_ID, snapshot.value, snapshot.at);
}

test("owner source proposal is not snapshot proof or write permission; one versioned write approval completes recovery", async () => {
  const h = fixture();
  try {
    withoutHistoricalValue(h);
    const result = await h.service.proposeValue(INCIDENT_ID, VALUE.stringValue);
    assert.equal(result.candidate.origin, "owner_proposal");
    assert.equal(h.writeCalls, 0);
    assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM repair_requests").get().n, 0);
    assert.deepEqual(h.store.getSnapshot("doctor:source-values:" + SHOP_ID).value.cells.P4.history, []);
    assert.throws(() => h.service.startForIncident(INCIDENT_ID, { incidentId: INCIDENT_ID, explicitWriteApproval: true }), { code: "source_candidate_version_changed" });
    const operation = h.service.startForIncident(INCIDENT_ID, { incidentId: INCIDENT_ID, explicitWriteApproval: true, candidateVersion: result.candidate.version });
    const finished = await h.service.waitForOperation(operation.id);
    assert.equal(finished.status, "verified"); assert.equal(h.writeCalls, 1);
    assert.equal(h.store.getIncident(INCIDENT_ID).monitorStatus, "resolved");
  } finally { h.store.close(); }
});

test("source owner proposal refuses populated values, disallowed validation and invalid text without writing", async () => {
  for (const reason of ["populated", "validation", "formula"]) {
    const h = fixture();
    try {
      withoutHistoricalValue(h);
      if (reason === "populated") h.sourceCells.set("P4", { userEnteredValue: { stringValue: "Другое" }, effectiveValue: { stringValue: "Другое" } });
      if (reason === "validation") h.sourceCells.set("P4", { dataValidation: { condition: { type: "ONE_OF_LIST", values: [{ userEnteredValue: "Другое" }] } } });
      await assert.rejects(h.service.proposeValue(INCIDENT_ID, reason === "formula" ? "=999" : VALUE.stringValue));
      assert.equal(h.writeCalls, 0); assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM repair_requests").get().n, 0);
    } finally { h.store.close(); }
  }
});

test("first matching catalog key must still select the authorized source row before a write", async () => {
  const h = fixture();
  try {
    const row = h.store.db.prepare("SELECT payload FROM incidents WHERE id=?").get(INCIDENT_ID), finding = JSON.parse(row.payload);
    finding.lookupEvidence = [{ selection: "first_match", matchingRows: [4, 149] }];
    h.store.db.prepare("UPDATE incidents SET payload=? WHERE id=?").run(JSON.stringify(finding), INCIDENT_ID);
    h.sourceCells.set("A3", format(SKU));
    const operation = h.service.startForIncident(INCIDENT_ID, { incidentId: INCIDENT_ID, explicitWriteApproval: true });
    const finished = await h.service.waitForOperation(operation.id);
    assert.equal(finished.result.code, "source_lookup_changed");
    assert.equal(h.writeCalls, 0);
  } finally { h.store.close(); }
});

test("a fresh successful Table Doctor state verifies recovery without a top-level complete flag", async () => {
  const h = fixture({ doctorStateResult: true });
  const started = h.service.startForIncident(INCIDENT_ID, {
    incidentId: INCIDENT_ID,
    explicitWriteApproval: true,
  });
  const operation = await h.service.waitForOperation(started.id);
  assert.equal(operation.status, "verified", JSON.stringify(operation.result));
  assert.equal(operation.result.fullDoctorCheck.complete, true);
  assert.equal(
    operation.result.fullDoctorCheck.verification,
    "fresh_document_state_compatibility",
  );
  assert.equal(h.writeCalls, 1);
  assert.equal(h.store.getIncident(INCIDENT_ID).monitorStatus, "resolved");
  h.store.close();
});

test("the value-only saved confirmation is not enough to write", () => {
  const h = fixture();
  assert.throws(
    () =>
      h.service.startForIncident(INCIDENT_ID, {
        incidentId: INCIDENT_ID,
        explicitWriteApproval: false,
      }),
    (error) => error.code === "source_write_confirmation_required",
  );
  assert.equal(h.writeCalls, 0);
  assert.equal(
    h.store.db
      .prepare("SELECT count(*) AS n FROM source_recovery_operations")
      .get().n,
    0,
  );
  h.store.close();
});

test("a stale value snapshot blocks the operation before any write", () => {
  const h = fixture();
  h.store.snapshot(
    "doctor:source-values:" + SHOP_ID,
    {
      cells: {
        P4: {
          current: null,
          currentAt: new Date(NOW - 60 * 60_000).toISOString(),
          currentOrigin: "entered",
          history: [
            {
              value: VALUE,
              origin: "entered",
              at: new Date(NOW - 60 * 60_000).toISOString(),
            },
          ],
        },
      },
    },
    new Date(NOW - 60 * 60_000).toISOString(),
  );
  assert.throws(
    () =>
      h.service.startForIncident(INCIDENT_ID, {
        incidentId: INCIDENT_ID,
        explicitWriteApproval: true,
      }),
    (error) => error.code === "source_snapshot_stale",
  );
  assert.equal(h.writeCalls, 0);
  h.store.close();
});

test("a conflicting current value is not overwritten", async () => {
  const h = fixture({ sourceValue: { stringValue: "Другое значение" } });
  const started = h.service.startForIncident(INCIDENT_ID, {
    incidentId: INCIDENT_ID,
    explicitWriteApproval: true,
  });
  const operation = await h.service.waitForOperation(started.id);
  assert.equal(operation.status, "blocked");
  assert.equal(operation.result.code, "source_cell_changed");
  assert.equal(h.writeCalls, 0);
  assert.equal(
    h.sourceCells.get("P4").userEnteredValue.stringValue,
    "Другое значение",
  );
  assert.equal(h.store.getIncident(INCIDENT_ID).monitorStatus, "open");
  h.store.close();
});

test("an already restored source is checked and never rewritten", async () => {
  const h = fixture({ sourceValue: VALUE });
  const started = h.service.startForIncident(INCIDENT_ID, {
    incidentId: INCIDENT_ID,
    explicitWriteApproval: true,
  });
  const operation = await h.service.waitForOperation(started.id);
  assert.equal(
    operation.status,
    "already_restored",
    JSON.stringify(operation.result),
  );
  assert.equal(h.writeCalls, 0);
  assert.equal(h.store.getIncident(INCIDENT_ID).monitorStatus, "resolved");
  assert.match(operation.result.resolutionCause, /уже был восстановлен/);
  h.store.close();
});

test("a dependent recalculation error keeps the incident open and is not reported fixed", async () => {
  const h = fixture({ recalculate: false });
  const started = h.service.startForIncident(INCIDENT_ID, {
    incidentId: INCIDENT_ID,
    explicitWriteApproval: true,
  });
  const operation = await h.service.waitForOperation(started.id);
  assert.equal(operation.status, "written_unverified");
  assert.equal(operation.result.code, "dependent_recalculation_failed");
  assert.equal(operation.result.writeStarted, true);
  assert.equal(operation.result.writeConfirmed, true);
  assert.equal(operation.result.retryAllowed, false);
  assert.match(operation.result.message, /Записано, проверка не завершена/);
  assert.equal(operation.result.timing.stages.post_write_readback.attempts, 5);
  assert.equal(h.writeCalls, 1);
  assert.equal(h.store.getIncident(INCIDENT_ID).monitorStatus, "open");
  assert.equal(
    h.store.db
      .prepare("SELECT status FROM repair_requests WHERE id=?")
      .get(INCIDENT_ID + ":1").status,
    "needs_review",
  );
  assert.throws(
    () =>
      h.service.startForIncident(INCIDENT_ID, {
        incidentId: INCIDENT_ID,
        explicitWriteApproval: true,
      }),
    (error) => error.code === "source_operation_not_retryable",
  );
  assert.equal(h.writeCalls, 1);
  h.store.close();
});

test("a rejected Google write stays blocked and records the failed write stage", async () => {
  const h = fixture({
    writerFailure: { code: "write_rejected", message: "403" },
  });
  const started = h.service.startForIncident(INCIDENT_ID, {
    incidentId: INCIDENT_ID,
    explicitWriteApproval: true,
  });
  const operation = await h.service.waitForOperation(started.id);
  assert.equal(operation.status, "blocked");
  assert.equal(operation.result.writeConfirmed, false);
  assert.equal(operation.result.timing.stages.write.status, "failed");
  assert.equal(h.writeCalls, 1);
  assert.equal(h.store.getIncident(INCIDENT_ID).monitorStatus, "open");
  h.store.close();
});

test("a delayed Sheets recalculation is retried read-only and completes after it settles", async () => {
  const h = fixture({ recalculateAfterRead: 4 });
  const started = h.service.startForIncident(INCIDENT_ID, {
    incidentId: INCIDENT_ID,
    explicitWriteApproval: true,
  });
  const operation = await h.service.waitForOperation(started.id);
  assert.equal(operation.status, "verified");
  assert.equal(operation.result.timing.stages.post_write_readback.attempts, 2);
  assert.equal(h.writeCalls, 1);
  assert.equal(h.store.getIncident(INCIDENT_ID).monitorStatus, "resolved");
  h.store.close();
});

test("restart after an acknowledged write marks verification incomplete and never writes again", async () => {
  let releaseRead;
  const readGate = new Promise((resolve) => (releaseRead = resolve)),
    h = fixture({
      postWriteRead: async () => {
        await readGate;
        const error = new Error(
          "simulated process stop after API acknowledgement",
        );
        error.code = "simulated_agent_stop";
        throw error;
      },
    });
  const started = h.service.startForIncident(INCIDENT_ID, {
    incidentId: INCIDENT_ID,
    explicitWriteApproval: true,
  });
  for (let i = 0; i < 30; i++) {
    const row = h.store.db
      .prepare("SELECT status FROM source_recovery_operations WHERE id=?")
      .get(started.id);
    if (row?.status === "checking") break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(
    h.store.db
      .prepare("SELECT status FROM source_recovery_operations WHERE id=?")
      .get(started.id).status,
    "checking",
  );
  const restarted = new SourceRecoveryService(h.store, h.config, {
    reader: h.reader,
    writer: h.writer,
    doctor: h.doctor,
    now: () => NOW,
    retryDelayMs: 0,
  });
  assert.equal(
    restarted.state(INCIDENT_ID).operation.status,
    "written_unverified",
  );
  assert.equal(
    restarted.state(INCIDENT_ID).operation.result.timing.stages
      .post_write_readback.status,
    "interrupted",
  );
  assert.throws(
    () =>
      restarted.startForIncident(INCIDENT_ID, {
        incidentId: INCIDENT_ID,
        explicitWriteApproval: true,
      }),
    (error) => error.code === "source_operation_not_retryable",
  );
  assert.equal(h.writeCalls, 1);
  releaseRead();
  const operation = await h.service.waitForOperation(started.id);
  assert.equal(operation.status, "written_unverified");
  assert.equal(h.writeCalls, 1);
  h.store.close();
});

test("ProductionSheetsWriter sends one exact single-cell string update and never retries", async () => {
  let sent = null,
    fetches = 0;
  const writer = new ProductionSheetsWriter({
    credentialsFile: "not-read-by-test.json",
    writerEmail: "ritm-test-writer@ritm-intelligence.iam.gserviceaccount.com",
    now: () => NOW,
    fetcher: async (url, options) => {
      fetches++;
      sent = { url: String(url), options };
      return new Response(
        JSON.stringify({ spreadsheetId: DOCUMENT_ID, replies: [{}] }),
        { status: 200 },
      );
    },
  });
  writer.verifiedAt = new Date(NOW).toISOString();
  writer.canEditVerifiedAt = writer.verifiedAt;
  writer.token = async () => "test-token";
  const result = await writer.writeSourceValue({
    operationId: "12345678-1234-1234-1234-123456789012",
    target: {
      documentId: DOCUMENT_ID,
      sheetId: 1335787439,
      sheet: SOURCE_SHEET,
      cell: "P4",
    },
    value: VALUE,
    ownerAuthorization: true,
  });
  const request = JSON.parse(sent.options.body).requests;
  assert.equal(result.changed, 1);
  assert.equal(fetches, 1);
  assert.equal(request.length, 1);
  assert.deepEqual(Object.keys(request[0]), ["updateCells"]);
  assert.deepEqual(request[0].updateCells.range, {
    sheetId: 1335787439,
    startRowIndex: 3,
    endRowIndex: 4,
    startColumnIndex: 15,
    endColumnIndex: 16,
  });
  assert.deepEqual(request[0].updateCells.rows[0].values[0], {
    userEnteredValue: VALUE,
  });
  assert.equal(request[0].updateCells.fields, "userEnteredValue");
  assert.equal(result.atomicCompareAndSet, false);
});

test("source proposal and write endpoints require owner cookies and accept no target injection", async () => {
  const store = new IncidentStore(":memory:"),
    token = "o".repeat(64),
    config = {
      productionRepairEnabled: true,
      ownerToken: token,
      port: 4318,
      allowedOrigins: ["http://localhost:4318", "http://127.0.0.1:4318"],
      publicOrigin: "",
      apiRateLimit: 180,
    };
  let calls = 0, proposals = 0;
  const server = createAgentServer(store, config, {
    repair: { production: true },
    sourceRecovery: {
      proposeValue: async (incidentId, value) => {
        proposals++; assert.equal(incidentId, INCIDENT_ID); assert.equal(value, "Фигурки");
        return { candidate: { version: "b".repeat(64), value: { stringValue: value } } };
      },
      state: () => ({ operation: null }),
      startForIncident: (incidentId, payload) => {
        calls++;
        assert.equal(incidentId, INCIDENT_ID);
        assert.deepEqual(payload, {
          incidentId: INCIDENT_ID,
          explicitWriteApproval: true,
        });
        return { id: "operation", incidentId, status: "repairing" };
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`,
    headers = {
      origin: "http://localhost:4318",
      "content-type": "application/json",
    };
  try {
    const candidateUrl = base + "/api/intelligence/formula-repair/source-candidate";
    const candidatePayload = { incidentId: INCIDENT_ID, value: "Фигурки" };
    const noSession = await fetch(candidateUrl, { method: "POST", headers, body: JSON.stringify(candidatePayload) });
    assert.equal(noSession.status, 401);
    const bearerCandidate = await fetch(candidateUrl, { method: "POST", headers: { ...headers, authorization: "Bearer " + token }, body: JSON.stringify(candidatePayload) });
    assert.equal(bearerCandidate.status, 403);
    const anonymous = await fetch(
      base + "/api/intelligence/formula-repair/source-recovery",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          incidentId: INCIDENT_ID,
          explicitWriteApproval: true,
        }),
      },
    );
    assert.equal(anonymous.status, 401);
    const bearerOnly = await fetch(
      base + "/api/intelligence/formula-repair/source-recovery",
      {
        method: "POST",
        headers: { ...headers, authorization: "Bearer " + token },
        body: JSON.stringify({
          incidentId: INCIDENT_ID,
          explicitWriteApproval: true,
        }),
      },
    );
    assert.equal(bearerOnly.status, 403);
    const login = await fetch(base + "/api/intelligence/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ token }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const injected = await fetch(candidateUrl, { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify({ ...candidatePayload, cell: "P149" }) });
    assert.equal(injected.status, 400);
    const candidate = await fetch(candidateUrl, { method: "POST", headers: { ...headers, cookie }, body: JSON.stringify(candidatePayload) });
    assert.equal(candidate.status, 200); assert.equal(proposals, 1); assert.equal(calls, 0);
    const response = await fetch(
      base + "/api/intelligence/formula-repair/source-recovery",
      {
        method: "POST",
        headers: { ...headers, cookie },
        body: JSON.stringify({
          incidentId: INCIDENT_ID,
          explicitWriteApproval: true,
        }),
      },
    );
    assert.equal(response.status, 202);
    assert.equal((await response.json()).operation.status, "repairing");
    assert.equal(calls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
