import assert from 'node:assert/strict';
import test from 'node:test';
import { runLoadSimulation } from '../scripts/assembly-load-simulation.mjs';

test('synthetic concurrent work and box writes preserve idempotency and capacity at 5/10/20/30 clients', async () => {
  for (const users of [5, 10, 20, 30]) {
    const report = await runLoadSimulation(users);
    const expectedBoxAccepted = Math.floor(users / 2);

    assert.equal(report.lostWrites, 0, `${users} users: work log lost a write`);
    assert.equal(report.duplicateRows, 0, `${users} users: work log duplicated a write`);
    assert.equal(report.boxAccepted, expectedBoxAccepted, `${users} users: wrong box capacity acceptance`);
    assert.equal(report.boxCapacityRejections, users - expectedBoxAccepted, `${users} users: overflowing placement was not rejected`);
    assert.equal(report.boxDuplicateReplays, users, `${users} users: duplicate box request was not idempotent`);
    assert.equal(report.boxOverfilled, false, `${users} users: carton exceeded its confirmed capacity`);
    assert.equal(report.boxOutageRejected, true, `${users} users: box operation was accepted during a Sheets outage`);
    assert.equal(report.boxUsed, report.boxCapacity, `${users} users: expected synthetic carton to reach its limit exactly`);
  }
});
