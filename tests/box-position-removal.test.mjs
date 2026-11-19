import test from "node:test";
import assert from "node:assert/strict";
import { removeBoxPosition, pendingBoxRemoval, boxRemovalOverlaps } from "../worker/cloud/boxPositionRemoval.js";
import { buildAssemblyV2Feed } from "../worker/cloud/assemblyV2Feed.js";
import { supplyDeliveryJob } from "../worker/cloud/assemblyV2Delivery.js";

const now = Date.now();
const operationId = "00000000-0000-4000-8000-000000000002";
const shipmentId = "RITM-SUPPLY-00000000-0000-4000-8000-000000000001";
const name = "OZON Тест";
const boxDocument = "SYNTHETIC_BOX_DOCUMENT_ID";
const box = { sourceId: "box-printing", spreadsheetId: boxDocument, sheetId: 11, name, assemblyShipmentId: shipmentId };
const roll = { sourceId: "roll-printing", spreadsheetId: "roll-doc", sheetId: 12, name, assemblyShipmentId: shipmentId };
const position = { ...box, sheetName: name, uid: "11::uid-1", rawUid: "uid-1", row: 7, article: "SKU", quantity: 30, packed: 0, packingRecords: 0 };
const other = { ...position, ...roll, uid: "12::uid-2", rawUid: "uid-2" };
const request = { operationId, explicitWriteApproval: true, name, sheetId: 11, uid: position.uid, article: position.article, quantity: 30 };
const unrelatedShipmentId = "RITM-SUPPLY-00000000-0000-4000-8000-000000000055";
const pendingSupply = (target = unrelatedShipmentId, sheetId = 55) => ({
  id: "00000000-0000-4000-8000-000000000056", action: "append", status: "partial",
  name: "OZON Другая поставка", shipmentId: target, updatedAt: new Date(now).toISOString(),
  manifest: { id: target, parts: [{ department: "box", documentId: boxDocument, sheetId }] },
});

function fixture({ hasWork = false, lost = false, last = false } = {}) {
  const supplies = last ? [position] : [position, other];
  const snapshot = { ok: true, quality: { status: "valid" }, issues: [], sheets: last ? [box] : [box, roll], supplies };
  const calls = [];
  const operations = new Map();
  const scope = {
    lease: { owner: "test" }, operations,
    putOperation(kind, value) { operations.set(`${kind}:${value.id}`, { kind, value: structuredClone(value) }); },
    async checkpoint() {},
    meta: key => key === "migrationReady" ? true : key === "productionSupplies" ? [{
      id: shipmentId, name, parts: snapshot.sheets.filter(entry => entry.assemblyShipmentId === shipmentId).map(entry => ({
        department: entry.sourceId.split("-")[0], documentId: entry.spreadsheetId, sheetId: entry.sheetId,
      })),
    }] : null,
    syncEvents: () => [],
  };
  let state = "absent";
  const args = {
    scope, now: () => now,
    bindings: { RITM_GOOGLE_BOX_PRINTING_ID: boxDocument,
      RITM_BOX_MOVE_GATEWAY_URL: "https://script.google.com/macros/s/SYNTHETIC_BOX_GATEWAY_01/exec",
      RITM_BOX_MOVE_GATEWAY_TOKEN: "t".repeat(32) },
    guard: async document => assert.equal(document, boxDocument),
    readPrinting: async () => snapshot,
    readSourceRow: async () => ({ 5:{stringValue:"SKU"}, 16:{numberValue:30}, 30:{stringValue:"uid-1"} }),
    hasAssemblyWork: async () => hasWork,
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.row, 7);
      assert.equal(body.uid, "uid-1");
      calls.push(body.action);
      if (body.action === "lock") state = "locked";
      if (body.action === "abort") state = "aborted";
      if (body.action === "remove") {
        assert.equal(state, "locked");
        snapshot.supplies = snapshot.supplies.filter(order => order.uid !== position.uid);
        state = "removed";
        if (lost) throw new Error("Reply lost after source write");
      }
      return Response.json({ ok: true, status: state });
    },
  };
  const feed = () => buildAssemblyV2Feed({
    snapshot: { at: now, value: snapshot }, now, scope,
    documents: { "box-printing": box.spreadsheetId, "roll-printing": roll.spreadsheetId },
  });
  return { args, calls, scope, feed, snapshot };
}

test("removing one box position leaves the same article in roll and schedules the correct Assembly supply", async () => {
  const f = fixture();
  const result = await removeBoxPosition(request, f.args);
  assert.equal(result.status, "verified");
  assert.deepEqual(f.calls, ["lock", "remove"]);
  assert.equal(f.feed().supplies[0].positions[0].sourceId, "roll-printing");
  assert.equal(f.feed().supplies[0].positions.length, 1);
  assert.equal(supplyDeliveryJob("box-position-removal", result, now).shipmentId, shipmentId);
});

test("uncertain reply keeps the original request and recovers without clearing the row again", async () => {
  const f = fixture({ lost: true });
  assert.equal((await removeBoxPosition(request, f.args)).status, "checking");
  assert.equal(pendingBoxRemoval(f.scope).id, operationId);
  assert.throws(f.feed, /подтверждает изменение/);
  assert.equal((await removeBoxPosition(request, f.args)).status, "verified");
  assert.deepEqual(f.calls, ["lock", "remove", "status"]);
});

test("changed quantity and known Assembly work cannot clear production inputs", async () => {
  const f = fixture({ hasWork: true });
  await assert.rejects(removeBoxPosition({ ...request, quantity: 31 }, f.args), /Состав бокса изменился/);
  assert.equal((await removeBoxPosition(request, f.args)).status, "cancelled");
  assert.deepEqual(f.calls, ["lock", "abort"]);
  assert.equal(f.feed().supplies[0].positions.length, 2);
});

test("the confirmed last source removal retires the active shipment without inventing a missing roster", async () => {
  const f = fixture({ last: true });
  assert.equal((await removeBoxPosition(request, f.args)).status, "verified");
  assert.deepEqual(f.feed().activeShipmentIds, []);
  assert.deepEqual(f.feed().issues, []);
});

test("a known unrelated unfinished supply does not block the box row or its Assembly delivery", async () => {
  const f = fixture();
  const otherSupply = pendingSupply();
  f.scope.putOperation("production", otherSupply);
  const otherBox = { ...box, sheetId: 55, assemblyShipmentId: otherSupply.shipmentId, name: otherSupply.name };
  f.snapshot.sheets.push(otherBox);
  f.snapshot.supplies.push({ ...position, ...otherBox, sheetName: otherBox.name });
  const result = await removeBoxPosition(request, f.args);
  assert.equal(result.status, "verified");
  assert.throws(f.feed, /подтверждает изменение/);
  f.scope.boxRemovalsPendingDelivery = new Set([operationId]);
  const feed = f.feed();
  assert.equal(feed.supplies.length, 1);
  assert.equal(feed.supplies[0].shipmentId, shipmentId);
  assert.equal(feed.supplies[0].positions.length, 1);
  assert.ok(feed.activeShipmentIds.includes(otherSupply.shipmentId));
  assert.ok(feed.activeShipmentIds.includes("RITM-BOX-55"));
  assert.ok(feed.issues.some(issue => issue.shipmentId === otherSupply.shipmentId));
});

test("an unfinished operation with an alias of the same box sheet is identified before a write", async () => {
  const f = fixture();
  f.scope.putOperation("production", pendingSupply(unrelatedShipmentId, box.sheetId));
  await assert.rejects(removeBoxPosition(request, f.args), /По этой поставке.*добавление товаров.*OZON Другая поставка/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.scope.operations.size, 1);
});

test("an uncertain legacy operation in a linked roll sheet blocks the same supply only", async () => {
  const f = fixture();
  const op = { id: "old-roll", action: "append", status: "written_unverified", payload: { name, plan: { sheetId: roll.sheetId } } };
  f.scope.putOperation("roll", op);
  await assert.rejects(removeBoxPosition(request, f.args), /Рулонная печать ещё сверяет операцию/);
  assert.deepEqual(f.calls, []);
  f.scope.putOperation("roll", { ...op, payload: { name, plan: { sheetId: 54 } } });
  assert.equal((await removeBoxPosition(request, f.args)).status, "verified");
});

test("an unknown pending target and a stale readback block the gateway before any mutation", async () => {
  const f = fixture();
  const op = { ...pendingSupply(), manifest: null };
  f.scope.putOperation("production", op);
  await assert.rejects(removeBoxPosition(request, f.args), /пока не подтвердил, какие листы/);
  f.scope.putOperation("production", { ...op, status: "cancelled" });
  f.snapshot.stale = true;
  f.snapshot.refreshFailure = { message: "Перенос SKU требует проверки." };
  await assert.rejects(removeBoxPosition(request, f.args), /Перенос SKU требует проверки/);
  assert.deepEqual(f.calls, []);
});

test("a saved move of another box row allows removal, while overlapping and unknown rows stop before lock", async () => {
  for (const [sheetId, sourceRow, allowed] of [[11, 9, true], [55, 7, true], [11, 7, false], [null, 9, false]]) {
    const f = fixture();
    f.scope.putOperation("production-department-move", {
      id: "move", status: "uncertain", input: { article: "CS0001.A0048" },
      proof: { plan: { proof: { from: "box", box: { sheetId }, source: { row: sourceRow, article: "CS0001.A0048" } },
        destination: { preserveExistingRows: true } } },
    });
    if (allowed) assert.equal((await removeBoxPosition(request, f.args)).status, "verified");
    else {
      await assert.rejects(removeBoxPosition(request, f.args), /CS0001.A0048/);
      assert.deepEqual(f.calls, []);
    }
  }
});

test("pending removal only permits a provably different registered shipment", () => {
  const pending = {id: operationId, status: "checking", shipmentId, identity: {sheetId: 11}};
  const supplies = [
    {id: shipmentId, parts: [{department:"box",sheetId:11},{department:"roll",sheetId:12}]},
    {id: unrelatedShipmentId, parts: [{department:"box",sheetId:55},{department:"roll",sheetId:56}]},
  ];
  const scope = {operations:new Map([["x",{kind:"box-position-removal",value:pending}]]),meta:key=>key==="productionSupplies"?supplies:null};
  assert.equal(boxRemovalOverlaps(scope, 12, "roll"), true);
  assert.equal(boxRemovalOverlaps(scope, 56, "roll"), false);
  assert.equal(boxRemovalOverlaps(scope, 999, "roll"), true);
  supplies.push({id:"duplicate",parts:[{department:"roll",sheetId:56}]});
  assert.equal(boxRemovalOverlaps(scope, 56, "roll"), true);
});
