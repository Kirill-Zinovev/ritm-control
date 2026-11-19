import test from "node:test";
import assert from "node:assert/strict";
import {
  validateDeadlines,
  validateResources,
} from "../shared/productionPlanning.js";
import {
  readPlanning,
  savePlanning,
  activePlanningKeys,
} from "../worker/cloud/productionPlanning.js";
const owner = { role: "owner", displayName: "Test Owner" },
  manager = { role: "manager", displayName: "Test Manager" };
const memory = () => {
  const state = new Map([
    [
      "productionSupplies",
      [
        {
          id: "supply-1",
          planning: { readyAt: "2026-11-13T15:00:00Z", shipAt: null },
        },
      ],
    ],
  ]);
  return {
    meta: (key, value) =>
      value === undefined
        ? structuredClone(state.get(key))
        : state.set(key, structuredClone(value)),
    log() {},
  };
};
const resource = {
  id: "xerox",
  rate: 200,
  unit: "sheets",
  days: [1, 2, 3, 4, 5],
  start: 540,
  end: 1080,
};

test('automatic rate preference persists without inventing a rate; legacy and manual values remain strict',()=>{
 const auto={...resource,rate:0,rateMode:'auto'};
 assert.deepEqual(validateResources([auto]),[auto]);
 assert.equal(validateResources([resource])[0].rateMode,undefined);
 for(const change of [{rateMode:'manual',rate:0},{rateMode:'guess'},{rateMode:'auto',rate:-1},{rateMode:'auto',days:[]},{rateMode:'auto',id:'cut-roll',unit:'sheets'}])
  assert.throws(()=>validateResources([{...resource,...change}]));
 const store=memory();const next=savePlanning(store,{action:'resources',revision:0,resources:[auto]},{principal:owner});
 assert.equal(readPlanning(store).resources[0].rateMode,'auto');assert.equal(next.resources[0].rate,0);
 assert.throws(()=>savePlanning(store,{action:'resources',revision:1,resources:[auto]},{principal:manager}),/руководитель/);
});
test("deadline validation rejects reversed dates, local timestamps and injected fields", () => {
  assert.throws(() =>
    validateDeadlines({
      readyAt: "2026-11-12T18:00:00+03:00",
      shipAt: "2026-11-12T15:00:00+03:00",
    }),
  );
  assert.throws(() => validateDeadlines({ readyAt: "2026-11-12T18:00" }));
  assert.throws(() =>
    validateDeadlines({ readyAt: "2026-02-31T18:00:00+03:00" }),
  );
  assert.throws(() =>
    validateDeadlines({ readyAt: null, shipAt: null, quantity: 10 }),
  );
  assert.deepEqual(
    validateDeadlines({ readyAt: "2026-11-12T18:00:00+03:00" }),
    { readyAt: "2026-11-12T15:00:00.000Z", shipAt: null },
  );
});
test("packing deadline is ordered between production and shipping and survives legacy edits", () => {
  const readyAt = "2026-11-18T13:00:00.000Z", packingAt = "2026-11-20T09:00:00.000Z", shipAt = "2026-11-23T12:00:00.000Z";
  assert.deepEqual(validateDeadlines({ readyAt, packingAt, shipAt }), { readyAt, packingAt, shipAt });
  assert.throws(() => validateDeadlines({ readyAt, packingAt: "2026-11-17T09:00:00.000Z", shipAt }), /упаковки/i);
  assert.throws(() => validateDeadlines({ readyAt, packingAt: "2026-11-24T09:00:00.000Z", shipAt }), /отгрузки/i);
  const store = memory();
  const first = savePlanning(store, { action: "deadlines", revision: 0, key: "shipment:supply-1", deadlines: { readyAt, packingAt, shipAt } }, { principal: manager });
  const second = savePlanning(store, { action: "deadlines", revision: first.revision, key: "shipment:supply-1", deadlines: { readyAt, shipAt } }, { principal: manager });
  assert.equal(second.deadlines["shipment:supply-1"].packingAt, packingAt);
});
test("capacity settings never infer missing calendars or accept non-Xerox sheets", () => {
  assert.equal(validateResources([{...resource,id:"packing",unit:"pieces"}])[0].id,"packing");
  assert.throws(() => validateResources([{...resource,id:"packing",unit:"area"}]));
  assert.equal(validateResources([resource])[0].rate, 200);
  for (const change of [
    { rate: 0 },
    { rate: Infinity },
    { days: [] },
    { days: [1, 1] },
    { start: 1080, end: 540 },
    { id: "2-go", unit: "sheets" },
    { unit: "unknown" },
  ])
    assert.throws(() => validateResources([{ ...resource, ...change }]));
  assert.throws(() => validateResources([resource, resource]));
});
test("new creation deadlines feed the planning view; saving other settings preserves them", () => {
  const store = memory();
  assert.equal(
    readPlanning(store).deadlines["shipment:supply-1"].readyAt,
    "2026-11-13T15:00:00Z",
  );
  const result = savePlanning(
    store,
    { action: "resources", revision: 0, resources: [resource] },
    { principal: owner },
  );
  assert.equal(result.revision, 1);
  assert.ok(result.deadlines["shipment:supply-1"]);
});
test("manager can set real supply deadlines without ChatGPT but cannot change global capacities", () => {
  const store = memory();
  const value = savePlanning(
    store,
    {
      action: "deadlines",
      revision: 0,
      key: "shipment:supply-1",
      deadlines: { readyAt: null, shipAt: null },
    },
    { principal: manager },
  );
  assert.equal(value.updatedBy, "Test Manager");
  assert.throws(
    () =>
      savePlanning(
        store,
        { action: "resources", revision: 1, resources: [] },
        { principal: manager },
      ),
    { code: "planning_owner_required" },
  );
  assert.throws(
    () =>
      savePlanning(
        store,
        {
          action: "deadlines",
          revision: 1,
          key: "shipment:fake",
          deadlines: {},
        },
        { principal: manager },
      ),
    { code: "planning_supply_missing" },
  );
});
test("revision conflict prevents lost settings from concurrent employees; no state changes on rejection", () => {
  const store = memory();
  savePlanning(
    store,
    { action: "resources", revision: 0, resources: [resource] },
    { principal: owner },
  );
  assert.throws(
    () =>
      savePlanning(
        store,
        { action: "resources", revision: 0, resources: [] },
        { principal: owner },
      ),
    { code: "planning_conflict" },
  );
  assert.equal(readPlanning(store).resources.length, 1);
});
test("stock origin is position-scoped, bounded by actual packing and retains an audit history", () => {
  const store = memory();
  const printing = { supplies: [{ sourceId: "roll-printing", spreadsheetId: "book", sheetId: 5, rawUid: "position", article: "SKU1", quantity: 10, packed: 5, packingEventIds: ["packing-1"] }] };
  const original = structuredClone(printing);
  const first = savePlanning(store, { action: "packing-stock", revision: 0, taskId: "book:5:position", article: "SKU1", quantity: 5 }, { principal: owner, printing, now: Date.UTC(2026, 10, 14) });
  assert.equal(first.stockSources[0].quantity, 5);
  assert.deepEqual(first.stockSources[0].packingEventIds, ["packing-1"]);
  assert.equal(first.stockSources[0].recordedBy, "Test Owner");
  const second = savePlanning(store, { action: "packing-stock", revision: 1, taskId: "book:5:position", article: "SKU1", quantity: 0 }, { principal: owner, printing });
  assert.deepEqual(second.stockSources.map((event) => event.quantity), [5, 0]);
  assert.deepEqual(printing, original);
  for (const bad of [{ quantity: 6 }, { article: "OTHER" }, { taskId: "missing" }])
    assert.throws(() => savePlanning(store, { action: "packing-stock", revision: 2, taskId: "book:5:position", article: "SKU1", quantity: 5, ...bad }, { principal: owner, printing }), { code: "planning_stock_source_conflict" });
  assert.throws(() => savePlanning(store, { action: "packing-stock", revision: 2, taskId: "book:5:position", article: "SKU1", quantity: 5 }, { principal: manager, printing }), { code: "planning_owner_required" });
  assert.equal(readPlanning(store).stockSources.length, 2);
});
test("stock origin records over-plan packing without changing production and rejects more than packed", () => {
  const store = memory();
  const printing = { supplies: [{ sourceId: "roll-printing", spreadsheetId: "book", sheetId: 5, rawUid: "position", article: "SKU1", quantity: 20, packed: 24, packingEventIds: ["packing-1"] }] };
  const original = structuredClone(printing);
  const state = savePlanning(store, { action: "packing-stock", revision: 0, taskId: "book:5:position", article: "SKU1", quantity: 24 }, { principal: owner, printing });
  assert.equal(state.stockSources[0].quantity, 24);
  assert.deepEqual(state.stockSources[0].packingEventIds, ["packing-1"]);
  assert.deepEqual(printing, original);
  assert.throws(() => savePlanning(store, { action: "packing-stock", revision: 1, taskId: "book:5:position", article: "SKU1", quantity: 25 }, { principal: owner, printing }), { code: "planning_stock_source_conflict" });
  assert.equal(readPlanning(store).stockSources.length, 1);
});
test("owner confirms fully printed cutting for forecast only; source changes and managers are rejected", () => {
  const store = memory();
  const order = { sourceId: "roll-printing", spreadsheetId: "book", sheetId: 5, rawUid: "position", article: "SKU1", quantity: 10, printProgress: 10, cutProgress: 0 };
  const printing = { supplies: [order] }, original = structuredClone(printing);
  const body = { action: "cut-confirmation", revision: 0, taskId: "book:5:position", article: "SKU1", quantity: 10 };
  const result = savePlanning(store, body, { principal: owner, printing, now: Date.UTC(2026, 10, 14) });
  assert.equal(result.cutConfirmations[0].quantity, 10);
  assert.equal(result.cutConfirmations[0].sourcePlan, 10);
  assert.equal(result.cutConfirmations[0].recordedBy, "Test Owner");
  assert.deepEqual(printing, original);
  for (const altered of [{ ...order, printProgress: 0 }, { ...order, cutProgress: 5 }, { ...order, quantity: 11 }, { ...order, planningCut: 1 }])
    assert.throws(() => savePlanning(store, { ...body, revision: 1 }, { principal: owner, printing: { supplies: [altered] } }), { code: "planning_cut_source_conflict" });
  assert.throws(() => savePlanning(store, { ...body, revision: 1 }, { principal: manager, printing }), { code: "planning_owner_required" });
  const revoked = savePlanning(store, { ...body, revision: 1, quantity: 0 }, { principal: owner, printing });
  assert.deepEqual(revoked.cutConfirmations.map((event) => event.quantity), [10, 0]);
});
test("legacy supply identities use source and sheet ID, never the title", () => {
  const keys = activePlanningKeys({
    sheets: [
      { sheetId: 5, sourceId: "roll-printing", name: "Same" },
      { sheetId: 5, sourceId: "box-printing", name: "Same" },
      { sheetId: 8, sourceId: "box-printing", assemblyShipmentId: "linked" },
    ],
    supplies: [],
  });
  assert.deepEqual(
    [...keys],
    ["shipment:RITM-ROLL-5", "sheet:box-printing:5", "shipment:linked"],
  );
});
