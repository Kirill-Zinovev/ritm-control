import test from "node:test";
import assert from "node:assert/strict";
import type { LiveOrder, LivePrinting } from "../src/livePrinting";
import {
  buildMachineWorkload,
  resolveMachine,
  remaining,
  workloadState,
} from "../src/machineWorkloadData";
const row = (overrides: Partial<LiveOrder> = {}): LiveOrder => ({
  uid: "test-id",
  sheetId: 101,
  sheetName: "OZON Тест",
  assemblyShipmentId: "test-supply",
  row: 5,
  article: "SKU",
  quantity: 100,
  plannedArea: 0,
  sourceId: "roll-printing",
  machine: "2-GO",
  printProgress: 25,
  cutProgress: 10,
  packed: 90,
  ...overrides,
});
const snapshot = (orders: LiveOrder[]): LivePrinting => ({
  ok: true,
  schemaVersion: 2,
  updatedAt: "2026-10-26T10:00:00Z",
  events: [],
  issues: [],
  supplies: orders,
  sheets: [
    ...new Map(
      orders.map((o) => [
        `${o.sourceId}:${o.sheetId}`,
        {
          sourceId: o.sourceId,
          sheetId: o.sheetId,
          name: o.sheetName,
          assemblyShipmentId: o.assemblyShipmentId,
        },
      ]),
    ).values(),
  ],
});

test("all seven machines resolve by explicit alias; unknown names stay unknown", () => {
  for (const alias of ["УФ бел.", "УФ. бел", "УФ белый"])
    assert.equal(resolveMachine(alias)?.id, "uv-white");
  assert.equal(resolveMachine("УФ-планшет")?.department, "box");
  assert.equal(resolveMachine(" 2–GO ")?.id, "2-go");
  assert.equal(resolveMachine("Лазер"), null);
});
test("one canonical supply contains both departments; progress counts printing only", () => {
  const input = snapshot([
    row(),
    row({
      uid: "box",
      sourceId: "box-printing",
      sheetId: 102,
      machine: "XEROX",
      quantity: 200,
      printProgress: 200,
      cutProgress: 0,
    }),
  ]);
  const groups = buildMachineWorkload(input);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].machines.length, 2);
  assert.equal(groups[0].plan, 300);
  assert.equal(groups[0].printed.value, 225);
  assert.equal(groups[0].machines[1].cut.value, 0);
  assert.equal(remaining(groups[0]), 75);
});
test("same article on different machines or stores keeps its assignment and totals", () => {
  const groups = buildMachineWorkload(
    snapshot([
      row({ shop: "1" }),
      row({ uid: "b", machine: "УФ", shop: "1" }),
      row({ uid: "c", shop: "2" }),
    ]),
  );
  assert.equal(groups[0].machines.length, 2);
  assert.equal(groups[0].machines[0].rows.length, 2);
  assert.equal(groups[0].plan, 300);
});
test("missing, erroneous, and cross-department machines stay visible in their original department", () => {
  const groups = buildMachineWorkload(
    snapshot([
      row({ machine: "" }),
      row({ uid: "b", machine: "XEROX" }),
      row({ uid: "c", machine: "#N/A" }),
    ]),
  );
  assert.equal(groups[0].machines[0].id, "unknown");
  assert.equal(groups[0].machines[0].department, "roll");
  assert.equal(groups[0].plan, 300);
  assert.ok(groups[0].machines[0].rows[0].issue);
});
test("unknown readiness is never a zero or complete; over-plan remains visible", () => {
  const groups = buildMachineWorkload(
    snapshot([
      row({ machine: "УФ", printProgress: null, remainingPrint: null }),
      row({ uid: "b", printProgress: 120 }),
    ]),
  );
  assert.equal(
    workloadState(groups[0].machines.find((m) => m.id === "uv")!),
    "unknown",
  );
  assert.equal(remaining(groups[0].machines.find((m) => m.id === "uv")!), null);
  assert.equal(
    remaining(groups[0].machines.find((m) => m.id === "2-go")!),
    -20,
  );
});
test("create and confirmed deletion follow each new snapshot without a shadow task registry", () => {
  const first = row(),
    second = row({
      uid: "new",
      sheetId: 200,
      assemblyShipmentId: "new-supply",
    });
  assert.equal(buildMachineWorkload(snapshot([first])).length, 1);
  assert.equal(buildMachineWorkload(snapshot([first, second])).length, 2);
  assert.equal(buildMachineWorkload(snapshot([second])).length, 1);
  assert.equal(buildMachineWorkload(snapshot([])).length, 0);
});
test("equal supply names never merge different identities, and a failed read can preserve its old snapshot", () => {
  const data = snapshot([
    row(),
    row({ uid: "b", sheetId: 200, assemblyShipmentId: "other" }),
  ]);
  assert.equal(buildMachineWorkload(data).length, 2);
  assert.equal(buildMachineWorkload({ ...data, stale: true }).length, 2);
  assert.deepEqual(
    data.supplies.map((o) => o.printProgress),
    [25, 25],
  );
});

test('catalog equipment selects its workload lane without moving source jobs or changing facts',()=>{
 const order=row({article:'NT0006.A4692',machine:'УФ планшет',machineSource:'catalog',quantity:60,printProgress:15,cutProgress:null});
 const input=snapshot([order]);const groups=buildMachineWorkload(input);
 assert.equal(groups[0].machines[0].id,'uv-flatbed');assert.equal(groups[0].machines[0].department,'box');
 assert.equal(groups[0].machines[0].printed.value,15);assert.equal(groups[0].plan,60);
 assert.equal(order.sourceId,'roll-printing');assert.equal(input.supplies.length,1);assert.ok(groups[0].machines[0].rows[0].issue);
});
