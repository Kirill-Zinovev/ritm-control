import assert from "node:assert/strict";
import test from "node:test";
import { nextFastCheckDelay } from "../agent/schedule.js";
import { TableDoctor } from "../agent/doctorService.js";

test("fast checks preserve cadence when they complete inside the interval", () => {
  assert.equal(nextFastCheckDelay(1000, 31000, 120000), 90000);
});

test("slow fast checks wait a full interval before starting again", () => {
  assert.equal(nextFastCheckDelay(1000, 601000, 120000), 120000);
});

test("fast and deep Google checks share one FIFO so their API reads never overlap", async () => {
  const doctor = Object.create(TableDoctor.prototype);
  doctor.current = null;
  doctor.fastCurrent = null;
  doctor.scanTail = Promise.resolve();
  doctor.now = () => new Date();
  doctor.reader = {};
  let active = 0;
  let overlap = false;
  const events = [];
  const scan = async (name) => {
    if (active) overlap = true;
    active++;
    events.push(name + ":start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push(name + ":end");
    active--;
    return name;
  };
  doctor.inspect = () => scan("deep");
  doctor.inspectFast = () => scan("fast");
  doctor.formulas = { fastCheck: () => scan("fast") };

  const [deep, fast] = await Promise.all([doctor.run(), doctor.runFast()]);

  assert.equal(deep, "deep");
  assert.equal(fast, "fast");
  assert.equal(overlap, false);
  assert.deepEqual(events, [
    "deep:start",
    "deep:end",
    "fast:start",
    "fast:end",
  ]);
});

test("repeated requests for the same check reuse its queued promise", async () => {
  const doctor = Object.create(TableDoctor.prototype);
  doctor.current = null;
  doctor.fastCurrent = null;
  doctor.scanTail = Promise.resolve();
  let deepCalls = 0;
  doctor.inspect = async () => {
    deepCalls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return "deep";
  };
  doctor.formulas = { fastCheck: async () => "fast" };

  const first = doctor.run();
  const repeated = doctor.run();
  assert.equal(first, repeated);
  assert.equal(await repeated, "deep");
  assert.equal(deepCalls, 1);
});
