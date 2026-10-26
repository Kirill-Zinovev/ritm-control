import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceCoefficientSum,
  groupWorkEvents,
} from "../src/assemblyCoefficient";

test("reported employee total includes both systems even when the approved total is withheld", () => {
  assert.equal(
    sourceCoefficientSum([{ coefficient: 0.25 }, { coefficient: 0.75 }], null),
    1,
  );
});

test("an unknown source coefficient cannot become a partial final total", () => {
  assert.equal(
    sourceCoefficientSum([{ coefficient: 0.75 }, { coefficient: null }]),
    null,
  );
  assert.equal(
    sourceCoefficientSum([{ coefficient: 0.75 }, { coefficient: NaN }]),
    null,
  );
});

test("zero work and a legacy single-source total retain their meaning", () => {
  assert.equal(
    sourceCoefficientSum([{ coefficient: 0 }, { coefficient: 0 }]),
    0,
  );
  assert.equal(sourceCoefficientSum([], 0.25), 0.25);
  assert.equal(sourceCoefficientSum(undefined), null);
});

const work = {
  date: "2026-10-22",
  employeeId: "emp-1",
  shipmentId: "supply-1",
  article: "SKU-1",
  operationId: "packing",
  quantity: 10,
  coefficient: 0.1,
  createdAt: "2026-10-22T08:00:00Z",
};

test("multiple entries for one article and operation sum work and retain times and original records", () => {
  const events = [
    work,
    {
      ...work,
      quantity: 20,
      coefficient: 0.2,
      createdAt: "2026-10-22T09:00:00Z",
    },
  ];
  const [group] = groupWorkEvents(events);
  assert.equal(group.quantity, 30);
  assert.ok(Math.abs(group.coefficient! - 0.3) < 1e-9);
  assert.deepEqual(group.events, events);
  assert.equal(events[0].quantity, 10);
});

test("article grouping never combines different employees, days, supplies or operations", () => {
  const events = [
    work,
    { ...work, employeeId: "emp-2" },
    { ...work, date: "2026-10-21" },
    { ...work, shipmentId: "supply-2" },
    { ...work, operationId: "cut" },
  ];
  assert.equal(groupWorkEvents(events).length, 5);
});

test("grouping does not invent a coefficient when one historical norm is missing", () => {
  const [group] = groupWorkEvents([work, { ...work, coefficient: null }]);
  assert.equal(group.quantity, 20);
  assert.equal(group.coefficient, null);
});
