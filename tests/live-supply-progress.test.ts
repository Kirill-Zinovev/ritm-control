import test from "node:test";
import assert from "node:assert/strict";
import {
  completeTotal,
  observedTotal,
  rollCut,
  rollPrinted,
  rollPrintRemaining,
} from "../src/liveSupplyProgress";

test("print progress uses T when present and derives printed pieces from X otherwise", () => {
  const fromX = {
    quantity: 300,
    printProgress: null,
    remainingPrint: 150,
  };
  assert.equal(rollPrinted(fromX), 150);
  assert.equal(rollPrintRemaining(fromX), 150);
  assert.equal(
    rollPrinted({ ...fromX, printProgress: 120 }),
    120,
  );
  assert.equal(rollPrinted({ ...fromX, remainingPrint: 301 }), null);
});

test("totals can show verified print progress without inventing cutting data", () => {
  const orders = [
    { quantity: 300, printProgress: null, cutProgress: null, remainingPrint: 150 },
    { quantity: 170, printProgress: null, cutProgress: null, remainingPrint: 170 },
  ];
  assert.equal(completeTotal(orders.map(rollPrinted)), 150);
  assert.equal(completeTotal(orders.map(rollCut)), null);
  assert.equal(completeTotal(orders.map(rollPrintRemaining)), 320);
  assert.deepEqual(observedTotal(orders.map(rollCut)), {
    total: null,
    observed: 0,
    missing: 2,
  });
});

test("partial cutting total shows known rows and missing rows separately", () => {
  assert.deepEqual(observedTotal([150, null, null]), {
    total: 150,
    observed: 1,
    missing: 2,
  });
});
