import test from "node:test";
import assert from "node:assert/strict";
import { IncidentStore } from "../agent/store.js";
import {
  RollSupplyManagementService,
  RollSupplySheetsWriter,
} from "../agent/rollSupply.js";
import {
  ROLL_PRINTING_SHEET,
  ROLL_PRINTING_SHEET_ID,
} from "../worker/printing.js";

const payload = (operationId, overrides = {}) => ({
  action: "create",
  explicitWriteApproval: true,
  operationId,
  name: "OZON ТЕСТОВАЯ ПОСТАВКА",
  lines: [{ article: "TEST-001", quantity: 12 }],
  ...overrides,
});

const deletePayload = (operationId, name, sheetId, overrides = {}) => ({
  action: "delete",
  explicitWriteApproval: true,
  operationId,
  name,
  sheetId,
  ...overrides,
});

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function googleHarness({
  loseWriteResponse = false,
  corruptReadback = false,
  missingFormulaRows = [],
} = {}) {
  const sheets = new Map(),
    requests = [],
    counters = { writes: 0 };
  let loseWriteResponseAfterAcceptance = loseWriteResponse;
  const template = {
    properties: {
      sheetId: ROLL_PRINTING_SHEET.gid,
      title: ROLL_PRINTING_SHEET.name,
      gridProperties: { rowCount: 600 },
    },
    data: [{ startRow: 0, startColumn: 0, rowData: [] }],
  };
  const rowData = template.data[0].rowData;
  for (let row = 0; row < 600; row++) {
    const values = Array.from({ length: 29 }, () => ({}));
    const sheetRow = row + 1;
    if (sheetRow === 1)
      values[0] = { userEnteredValue: { stringValue: "OZON 10.10" } };
    if (sheetRow === 3)
      values[0] = {
        userEnteredValue: {
          stringValue: "⚠️ СЕЗОННАЯ ПЕЧАТЬ — Работа НЕ завершена!",
        },
      };
    if (sheetRow === ROLL_PRINTING_SHEET.headerRow) {
      values[4] = { userEnteredValue: { stringValue: "Артикул" } };
      values[14] = { userEnteredValue: { stringValue: "Кол-во" } };
    }
    if (sheetRow === ROLL_PRINTING_SHEET.uidHeaderRow)
      values[28] = { userEnteredValue: { stringValue: "UID" } };
    if (
      sheetRow >= ROLL_PRINTING_SHEET.dataStartRow &&
      sheetRow <= ROLL_PRINTING_SHEET.dataStartRow + 499 &&
      !missingFormulaRows.includes(sheetRow)
    ) {
      for (const column of [5, 8, 9])
        values[column] = {
          userEnteredValue: {
            formulaValue: `=FORMULA_${column + 1}_${sheetRow}`,
          },
          effectiveValue: { numberValue: 0 },
        };
      values[1] = {
        userEnteredValue: { formulaValue: `=IMAGE(E${sheetRow})` },
      };
      values[2] = {
        userEnteredValue: { formulaValue: `=LOOKUP(E${sheetRow})` },
      };
      values[3] = {
        userEnteredValue: { formulaValue: `=MACHINE(E${sheetRow})` },
      };
      if (sheetRow <= 11) {
        values[0] = { userEnteredValue: { numberValue: 46302 } };
        values[17] = { userEnteredValue: { stringValue: "В работе" } };
        values[18] = { userEnteredValue: { stringValue: "В работе" } };
        values[19] = { userEnteredValue: { stringValue: "█████░░░░░ 50%" } };
        values[20] = { userEnteredValue: { stringValue: "░░░░░░░░░░ 0%" } };
        values[21] = { userEnteredValue: { numberValue: 46302.5 } };
        values[23] = { userEnteredValue: { numberValue: 150 } };
      }
      if (sheetRow <= 151) {
        values[4] = { userEnteredValue: { stringValue: `OLD-${sheetRow}` } };
        values[14] = { userEnteredValue: { numberValue: 1 } };
      }
      if (sheetRow <= 194) {
        values[28] = {
          userEnteredValue: { stringValue: `old-uid-${sheetRow}` },
        };
      }
    }
    rowData.push({ values });
  }
  sheets.set(ROLL_PRINTING_SHEET.gid, {
    properties: structuredClone(template.properties),
    data: structuredClone(template.data),
  });

  function updateCell(sheet, row, column, value) {
    const data = sheet.data[0];
    const target = data.rowData[row] || (data.rowData[row] = { values: [] });
    target.values ||= [];
    if (Object.keys(value).length)
      target.values[column] = structuredClone(value);
    else target.values[column] = {};
  }

  function materialize(sheet) {
    const cloned = structuredClone(sheet);
    for (const row of cloned.data[0].rowData || []) {
      for (const cell of row.values || []) {
        if (cell.userEnteredValue?.formulaValue && !cell.effectiveValue)
          cell.effectiveValue = { numberValue: 0 };
        else if (cell.userEnteredValue && !cell.effectiveValue)
          cell.effectiveValue = structuredClone(cell.userEnteredValue);
      }
    }
    return cloned;
  }

  const fetcher = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "www.googleapis.com")
      return response({
        id: ROLL_PRINTING_SHEET_ID,
        capabilities: { canEdit: true },
      });
    assert.equal(parsed.hostname, "sheets.googleapis.com");
    if (parsed.pathname.endsWith(":batchUpdate")) {
      counters.writes++;
      const body = JSON.parse(options.body);
      requests.push(body.requests);
      const replies = [];
      for (const request of body.requests) {
        if (request.duplicateSheet) {
          const duplicate = request.duplicateSheet;
          const copied = structuredClone(sheets.get(duplicate.sourceSheetId));
          copied.properties.sheetId = duplicate.newSheetId;
          copied.properties.title = duplicate.newSheetName;
          sheets.set(duplicate.newSheetId, copied);
          replies.push({ duplicateSheet: { properties: copied.properties } });
        } else if (request.deleteSheet) {
          sheets.delete(request.deleteSheet.sheetId);
          replies.push({});
        } else if (request.updateCells) {
          const update = request.updateCells;
          const sheet = sheets.get(update.start.sheetId);
          for (let index = 0; index < update.rows.length; index++) {
            const values = update.rows[index].values || [];
            for (let offset = 0; offset < values.length; offset++)
              updateCell(
                sheet,
                update.start.rowIndex + index,
                update.start.columnIndex + offset,
                values[offset] || {},
              );
          }
          replies.push({});
        }
      }
      if (loseWriteResponseAfterAcceptance)
        throw new Error(
          "simulated lost HTTP response after Google accepted write",
        );
      return response({ spreadsheetId: ROLL_PRINTING_SHEET_ID, replies });
    }
    if (parsed.pathname === `/v4/spreadsheets/${ROLL_PRINTING_SHEET_ID}`) {
      if (parsed.searchParams.get("includeGridData") !== "true")
        return response({
          spreadsheetId: ROLL_PRINTING_SHEET_ID,
          sheets: [...sheets.values()].map((sheet) => ({
            properties: sheet.properties,
          })),
        });
      const range = parsed.searchParams.get("ranges") || "";
      const title = range
        .match(/^'((?:[^']|'')+)'!/)?.[1]
        ?.replaceAll("''", "'");
      const sheet = [...sheets.values()].find(
        (item) => item.properties.title === title,
      );
      assert.ok(sheet, `Expected read of sheet ${title}`);
      const grid = materialize(sheet);
      if (
        corruptReadback &&
        grid.properties.sheetId !== ROLL_PRINTING_SHEET.gid
      )
        grid.data[0].rowData[4].values[4].userEnteredValue.stringValue =
          "OTHER";
      return response({
        spreadsheetId: ROLL_PRINTING_SHEET_ID,
        sheets: [grid],
      });
    }
    throw new Error(`Unexpected Google API request: ${url}`);
  };

  return {
    fetcher,
    requests,
    counters,
    sheets,
    loseNextWriteResponse(value = true) {
      loseWriteResponseAfterAcceptance = value;
    },
  };
}

function makeService(options = {}) {
  const store = new IncidentStore(":memory:");
  const google = googleHarness(options);
  const credentialWriter = {
    metrics: { readRequests: 0, writeRequests: 0 },
    async token() {
      return "test-token";
    },
  };
  let refreshes = 0;
  const writer = new RollSupplySheetsWriter({
    credentialWriter,
    fetcher: google.fetcher,
  });
  const service = new RollSupplyManagementService(store, {
    writer,
    refresh: async () => {
      refreshes++;
    },
  });
  return {
    store,
    service,
    google,
    credentialWriter,
    refreshes: () => refreshes,
  };
}

test("new supply clears template data, renames the heading and initializes print remainder", async () => {
  const h = makeService();
  try {
    const result = await h.service.execute(
      payload("11111111-1111-4111-8111-111111111111"),
    );
    assert.equal(result.status, "verified", JSON.stringify(result));
    assert.equal(result.rows, 1);
    assert.equal(h.google.counters.writes, 1);
    assert.equal(h.refreshes(), 1);
    const batch = h.google.requests[0];
    assert.equal(
      batch[0].duplicateSheet.sourceSheetId,
      ROLL_PRINTING_SHEET.gid,
    );
    const updatedColumns = batch
      .filter((request) => request.updateCells)
      .map((request) => request.updateCells.start.columnIndex);
    assert.deepEqual(
      [...new Set(updatedColumns)].sort((a, b) => a - b),
      [0, 4, 14, 23, 28],
    );
    const created = h.google.sheets.get(result.sheetId);
    const rows = created.data[0].rowData;
    assert.equal(rows[0].values[0].userEnteredValue.stringValue, result.name);
    assert.equal(rows[2].values[0].userEnteredValue, undefined);
    assert.equal(rows[4].values[4].userEnteredValue.stringValue, "TEST-001");
    assert.equal(rows[4].values[14].userEnteredValue.numberValue, 12);
    assert.equal(rows[4].values[23].userEnteredValue.numberValue, 12);
    assert.match(
      rows[4].values[28].userEnteredValue.stringValue,
      /^ritm-11111111-1111-4111-8111-111111111111-1$/,
    );
    assert.equal(rows[5].values[4].userEnteredValue, undefined);
    assert.equal(rows[5].values[14].userEnteredValue, undefined);
    assert.equal(rows[5].values[28].userEnteredValue, undefined);
    assert.equal(rows[4].values[0].userEnteredValue, undefined);
    assert.equal(rows[4].values[17].userEnteredValue, undefined);
    assert.equal(rows[4].values[18].userEnteredValue, undefined);
    assert.equal(rows[4].values[19].userEnteredValue, undefined);
    assert.equal(rows[4].values[20].userEnteredValue, undefined);
    assert.equal(rows[4].values[21].userEnteredValue, undefined);
    assert.equal(rows[4].values[23].userEnteredValue.numberValue, 12);
    assert.equal(rows[8].values[23].userEnteredValue, undefined);
    assert.equal(rows[193].values[28].userEnteredValue, undefined);
    assert.equal(
      rows[4].values[5].userEnteredValue.formulaValue,
      "=FORMULA_6_5",
    );
    assert.equal(rows[4].values[1].userEnteredValue.formulaValue, "=IMAGE(E5)");
    assert.equal(rows[4].values[2].userEnteredValue.formulaValue, "=LOOKUP(E5)");
    assert.equal(rows[4].values[3].userEnteredValue.formulaValue, "=MACHINE(E5)");
    const saved = h.store.rollSupplyOperation(
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(JSON.stringify(saved.payload.plan).includes("FORMULA"), false);
    assert.equal(
      rows[4].values[8].userEnteredValue.formulaValue,
      "=FORMULA_9_5",
    );
    assert.equal(
      rows[4].values[9].userEnteredValue.formulaValue,
      "=FORMULA_10_5",
    );
  } finally {
    h.store.close();
  }
});

test("create checks only formula rows used by this supply, not an unrelated gap at row 80", async () => {
  const h = makeService({ missingFormulaRows: [80] });
  try {
    const result = await h.service.execute(
      payload("12121212-1212-4212-8212-121212121212", {
        lines: [
          { article: "TEST-001", quantity: 12 },
          { article: "TEST-002", quantity: 8 },
          { article: "TEST-003", quantity: 6 },
          { article: "TEST-004", quantity: 4 },
        ],
      }),
    );
    assert.equal(result.status, "verified");
    assert.equal(result.rows, 4);
    assert.equal(h.google.counters.writes, 1);
  } finally {
    h.store.close();
  }
});

test("owner-confirmed delete removes one registered sheet and verifies absence before unregistering", async () => {
  const h = makeService();
  try {
    const created = await h.service.execute(
      payload("18181818-1818-4818-8818-181818181818"),
    );
    const result = await h.service.execute(
      deletePayload(
        "19191919-1919-4919-8919-191919191919",
        created.name,
        created.sheetId,
      ),
    );
    assert.equal(result.status, "verified");
    assert.equal(result.action, "delete");
    assert.equal(result.sheetId, created.sheetId);
    assert.equal(h.google.sheets.has(created.sheetId), false);
    assert.deepEqual(h.store.meta("rollPrintingAdditionalSheets"), []);
    assert.equal(h.refreshes(), 2);
    assert.deepEqual(h.google.requests.at(-1), [
      { deleteSheet: { sheetId: created.sheetId } },
    ]);
    const saved = h.store.rollSupplyOperation(
      "19191919-1919-4919-8919-191919191919",
    );
    assert.equal(saved.payload.approval.principal, "authenticated_local_owner");
    assert.equal(saved.payload.approval.exactOperationId, saved.id);
  } finally {
    h.store.close();
  }
});

test("delete requires an exact live non-template target and owner approval", async () => {
  const h = makeService();
  try {
    await assert.rejects(
      h.service.execute(
        deletePayload(
          "20202020-2020-4020-8020-202020202020",
          ROLL_PRINTING_SHEET.name,
          ROLL_PRINTING_SHEET.gid,
        ),
      ),
      { code: "roll_supply_delete_template_forbidden" },
    );
    await assert.rejects(
      h.service.execute(
        deletePayload(
          "21212121-2121-4121-8121-212121212121",
          "Несуществующая поставка",
          123456,
        ),
      ),
      { code: "roll_supply_target_missing" },
    );
    await assert.rejects(
      h.service.execute(
        deletePayload(
          "22222222-2222-4222-8222-222222222223",
          "Несуществующая поставка",
          123456,
          { explicitWriteApproval: false },
        ),
      ),
      { code: "supply_confirmation_required" },
    );
    assert.equal(h.google.counters.writes, 0);
  } finally {
    h.store.close();
  }
});

test("owner can delete an existing supply tab that was created outside RITM", async () => {
  const h = makeService();
  try {
    const sheetId = 919191,
      name = "Старая поставка";
    h.google.sheets.set(sheetId, {
      properties: {
        sheetId,
        title: name,
        gridProperties: { rowCount: 600 },
      },
      data: [{ startRow: 0, startColumn: 0, rowData: [] }],
    });
    const result = await h.service.execute(
      deletePayload("27272727-2727-4727-8727-272727272727", name, sheetId),
    );
    assert.equal(result.status, "verified");
    assert.equal(h.google.sheets.has(sheetId), false);
    assert.deepEqual(h.google.requests.at(-1), [
      { deleteSheet: { sheetId } },
    ]);
  } finally {
    h.store.close();
  }
});

test("an externally deleted supply is removed from the local registry on live metadata reconciliation", async () => {
  const h = makeService();
  try {
    const created = await h.service.execute(
      payload("23232323-2323-4323-8323-232323232323"),
    );
    h.google.sheets.delete(created.sheetId);
    const result = await h.service.syncRegisteredSheets({
      force: true,
      refreshOnChange: true,
    });
    assert.equal(result.status, "updated");
    assert.deepEqual(result.removed, [created.name]);
    assert.deepEqual(h.store.meta("rollPrintingAdditionalSheets"), []);
    assert.equal(h.refreshes(), 2);
    assert.equal(h.google.counters.writes, 1);
  } finally {
    h.store.close();
  }
});

test("failed live metadata reconciliation preserves the registered supply", async () => {
  const h = makeService();
  try {
    const created = await h.service.execute(
      payload("24242424-2424-4424-8424-242424242424"),
    );
    h.google.sheets.delete(created.sheetId);
    const metadata = h.service.writer.metadata.bind(h.service.writer);
    h.service.writer.metadata = async () => {
      throw new Error("simulated metadata timeout");
    };
    const result = await h.service.syncRegisteredSheets({ force: true });
    assert.equal(result.status, "error");
    assert.equal(result.removed.length, 0);
    assert.deepEqual(h.store.meta("rollPrintingAdditionalSheets"), [
      { gid: created.sheetId, name: created.name },
    ]);
    h.service.writer.metadata = metadata;
  } finally {
    h.store.close();
  }
});

test("uncertain delete is not repeated and remains registered until live reconciliation confirms removal", async () => {
  const h = makeService();
  try {
    const created = await h.service.execute(
      payload("25252525-2525-4525-8525-252525252525"),
    );
    h.google.loseNextWriteResponse();
    const deletion = deletePayload(
      "26262626-2626-4626-8626-262626262626",
      created.name,
      created.sheetId,
    );
    await assert.rejects(h.service.execute(deletion), {
      code: "roll_supply_write_uncertain",
    });
    assert.equal(h.google.counters.writes, 2);
    assert.equal(h.google.sheets.has(created.sheetId), false);
    assert.deepEqual(h.store.meta("rollPrintingAdditionalSheets"), [
      { gid: created.sheetId, name: created.name },
    ]);
    const repeated = await h.service.execute(deletion);
    assert.equal(repeated.status, "uncertain");
    assert.equal(h.google.counters.writes, 2);
    const reconciled = await h.service.syncRegisteredSheets({ force: true });
    assert.deepEqual(reconciled.removed, [created.name]);
    assert.deepEqual(h.store.meta("rollPrintingAdditionalSheets"), []);
    assert.equal(
      h.store.rollSupplyOperation(
        "26262626-2626-4626-8626-262626262626",
      ).status,
      "verified",
    );
    assert.equal(
      h.store.rollSupplyOperation(
        "26262626-2626-4626-8626-262626262626",
      ).result.reconciledBy,
      "live_google_metadata",
    );
  } finally {
    h.store.close();
  }
});

test("create still stops before writing when a formula is missing in a requested row", async () => {
  const h = makeService({ missingFormulaRows: [6] });
  try {
    await assert.rejects(
      h.service.execute(
        payload("13131313-1313-4313-8313-131313131313", {
          lines: [
            { article: "TEST-001", quantity: 12 },
            { article: "TEST-002", quantity: 8 },
          ],
        }),
      ),
      { code: "roll_template_formula_missing" },
    );
    assert.equal(h.google.counters.writes, 0);
  } finally {
    h.store.close();
  }
});

test("explicit approval is required before any Google read or write", async () => {
  const h = makeService();
  try {
    await assert.rejects(
      h.service.execute(
        payload("22222222-2222-4222-8222-222222222222", {
          explicitWriteApproval: false,
        }),
      ),
      { code: "supply_confirmation_required" },
    );
    assert.equal(h.google.counters.writes, 0);
    assert.equal(h.google.requests.length, 0);
  } finally {
    h.store.close();
  }
});

test("an active formula repair blocks a supply write", async () => {
  const h = makeService();
  try {
    h.store.db.exec(
      "CREATE TABLE test_repair_proposals (status TEXT NOT NULL)",
    );
    h.store.db
      .prepare("INSERT INTO test_repair_proposals(status) VALUES('queued')")
      .run();
    assert.equal(h.service.state().available, false);
    await assert.rejects(
      h.service.execute(payload("23232323-2323-4323-8323-232323232323")),
      { code: "roll_supply_operation_conflict" },
    );
    assert.equal(h.google.counters.writes, 0);
  } finally {
    h.store.close();
  }
});

test("same approved operation is idempotent and is never written twice", async () => {
  const h = makeService();
  try {
    const request = payload("33333333-3333-4333-8333-333333333333");
    const first = await h.service.execute(request);
    const second = await h.service.execute(request);
    assert.equal(first.status, "verified");
    assert.equal(second.status, "verified");
    assert.equal(h.google.counters.writes, 1);
  } finally {
    h.store.close();
  }
});

test("append writes only new articles into the next prepared rows", async () => {
  const h = makeService();
  try {
    const created = await h.service.execute(
      payload("34343434-3434-4434-8434-343434343434"),
    );
    const sheet = h.google.sheets.get(created.sheetId);
    const originalRow = structuredClone(sheet.data[0].rowData[4]);
    const result = await h.service.execute({
      action: "append",
      explicitWriteApproval: true,
      operationId: "35353535-3535-4535-8535-353535353535",
      name: created.name,
      sheetId: created.sheetId,
      lines: [{ article: "TEST-002", quantity: 8 }],
    });
    assert.equal(result.status, "verified");
    assert.equal(h.google.counters.writes, 2);
    assert.equal(
      sheet.data[0].rowData[4].values[4].userEnteredValue.stringValue,
      "TEST-001",
    );
    assert.equal(
      sheet.data[0].rowData[4].values[14].userEnteredValue.numberValue,
      12,
    );
    assert.equal(
      sheet.data[0].rowData[4].values[23].userEnteredValue.numberValue,
      12,
    );
    assert.equal(
      sheet.data[0].rowData[4].values[5].userEnteredValue.formulaValue,
      "=FORMULA_6_5",
    );
    assert.notEqual(
      sheet.data[0].rowData[4].values[28].userEnteredValue.stringValue,
      "old-uid-5",
    );
    assert.equal(
      sheet.data[0].rowData[5].values[4].userEnteredValue.stringValue,
      "TEST-002",
    );
    assert.equal(
      sheet.data[0].rowData[5].values[14].userEnteredValue.numberValue,
      8,
    );
    assert.equal(
      sheet.data[0].rowData[5].values[23].userEnteredValue.numberValue,
      8,
    );
    assert.notEqual(
      sheet.data[0].rowData[5].values[28].userEnteredValue.stringValue,
      "old-uid-6",
    );
    assert.equal(
      originalRow.values[5].userEnteredValue.formulaValue,
      "=FORMULA_6_5",
    );
    const appendBatch = h.google.requests[1];
    assert.equal(
      appendBatch.some((request) => request.duplicateSheet),
      false,
    );
    assert.deepEqual(
      [
        ...new Set(
          appendBatch.map((request) => request.updateCells.start.columnIndex),
        ),
      ].sort((a, b) => a - b),
      [4, 14, 23, 28],
    );
  } finally {
    h.store.close();
  }
});

test("append preserves orphan service IDs and scans beyond the old 504-row range", async () => {
  const h = makeService();
  try {
    const result = await h.service.execute({
      action: "append",
      explicitWriteApproval: true,
      operationId: "36363636-3636-4636-8636-363636363636",
      name: ROLL_PRINTING_SHEET.name,
      sheetId: ROLL_PRINTING_SHEET.gid,
      lines: [{ article: "TEST-600", quantity: 1 }],
    });
    assert.equal(result.status, "verified");
    assert.equal(result.rows, 1);
    const sheet = h.google.sheets.get(ROLL_PRINTING_SHEET.gid);
    assert.equal(
      sheet.data[0].rowData[151].values[28].userEnteredValue.stringValue,
      "old-uid-152",
    );
    assert.equal(
      sheet.data[0].rowData[193].values[28].userEnteredValue.stringValue,
      "old-uid-194",
    );
    assert.equal(
      sheet.data[0].rowData[194].values[4].userEnteredValue.stringValue,
      "TEST-600",
    );
  } finally {
    h.store.close();
  }
});

test("append rejects active data beyond the 500 prepared formula rows", async () => {
  const h = makeService();
  try {
    const sheet = h.google.sheets.get(ROLL_PRINTING_SHEET.gid);
    sheet.data[0].rowData[504].values[4] = {
      userEnteredValue: { stringValue: "OUT-OF-RANGE" },
    };
    await assert.rejects(
      h.service.execute({
        action: "append",
        explicitWriteApproval: true,
        operationId: "37373737-3737-4737-8737-373737373737",
        name: ROLL_PRINTING_SHEET.name,
        sheetId: ROLL_PRINTING_SHEET.gid,
        lines: [{ article: "TEST-OUT-OF-RANGE", quantity: 1 }],
      }),
      { code: "roll_supply_capacity" },
    );
    assert.equal(h.google.counters.writes, 0);
  } finally {
    h.store.close();
  }
});

test("lost Google write response becomes uncertain and cannot trigger a retry", async () => {
  const h = makeService({ loseWriteResponse: true });
  try {
    const request = payload("44444444-4444-4444-8444-444444444444");
    await assert.rejects(h.service.execute(request), {
      code: "roll_supply_write_uncertain",
    });
    const second = await h.service.execute(request);
    assert.equal(second.status, "uncertain");
    assert.equal(h.google.counters.writes, 1);
  } finally {
    h.store.close();
  }
});

test("failed readback is recorded as written-unverified and is not repeated", async () => {
  const h = makeService({ corruptReadback: true });
  try {
    const request = payload("55555555-5555-4555-8555-555555555555");
    const first = await h.service.execute(request);
    assert.equal(first.status, "written_unverified");
    const second = await h.service.execute(request);
    assert.equal(second.status, "written_unverified");
    assert.equal(h.google.counters.writes, 1);
  } finally {
    h.store.close();
  }
});

test("restart converts in-flight supply writes and checks to no-retry states", () => {
  const store = new IncidentStore(":memory:");
  try {
    const at = new Date().toISOString();
    store.beginRollSupplyOperation(
      "66666666-6666-4666-8666-666666666666",
      "create",
      "h1",
      {
        name: "A",
        lines: [],
        plan: { sheetId: 12 },
      },
      at,
    );
    store.beginRollSupplyOperation(
      "77777777-7777-4777-8777-777777777777",
      "append",
      "h2",
      {
        name: "B",
        lines: [],
        plan: { sheetId: 13 },
      },
      at,
    );
    store.updateRollSupplyOperation(
      "77777777-7777-4777-8777-777777777777",
      "checking",
      { sheetId: 13 },
      at,
    );
    const service = new RollSupplyManagementService(store, { writer: {} });
    assert.equal(
      store.rollSupplyOperation("66666666-6666-4666-8666-666666666666").status,
      "uncertain",
    );
    assert.equal(
      store.rollSupplyOperation("77777777-7777-4777-8777-777777777777").status,
      "written_unverified",
    );
    assert.equal(service.state().operations.length, 2);
  } finally {
    store.close();
  }
});
