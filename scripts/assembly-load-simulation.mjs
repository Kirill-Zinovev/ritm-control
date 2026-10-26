import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// Synthetic contract-level simulation only. It does not call Apps Script or Google Sheets.
const SERVICE_LATENCY_MS = { referenceReads: 2, workLogAppend: 4, boxAppend: 4, versionRead: 1, shipmentRead: 5 };
const USERS = [5, 10, 20, 30];
const POSITION_COUNT = 147;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
};
const summarize = values => ({
  n: values.length,
  p50Ms: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
});

class AsyncLock {
  #tail = Promise.resolve();
  async run(action) {
    const queuedAt = performance.now();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const prior = this.#tail;
    this.#tail = prior.then(() => gate);
    await prior;
    const waitMs = performance.now() - queuedAt;
    try { return { result: await action(), waitMs }; }
    finally { release(); }
  }
}

class SheetsContractFixture {
  constructor() {
    this.lock = new AsyncLock();
    this.workLog = new Map();
    this.boxAllocations = new Map();
    this.boxCapacity = 0;
    this.boxPlan = 0;
    this.boxOpen = true;
    this.version = 1;
    this.available = true;
    this.positions = Array.from({ length: POSITION_COUNT }, (_, i) => ({ positionId: `p-${i}`, sku: `SKU-${i}` }));
  }
  async openShipment() {
    const started = performance.now();
    await sleep(SERVICE_LATENCY_MS.shipmentRead);
    return { elapsedMs: performance.now() - started, count: this.positions.length };
  }
  async save(key, quantity) {
    await sleep(SERVICE_LATENCY_MS.referenceReads);
    if (!this.available) throw new Error('synthetic Sheets outage');
    const started = performance.now();
    const { result, waitMs } = await this.lock.run(async () => {
      // The second lookup is inside the mutex, directly before append.
      if (this.workLog.has(key)) return { duplicate: true, eventId: this.workLog.get(key).eventId };
      await sleep(SERVICE_LATENCY_MS.workLogAppend);
      const event = { eventId: `event-${this.workLog.size + 1}`, positionId: 'same-article-1', quantity };
      this.workLog.set(key, event);
      this.version += 1;
      return { duplicate: false, eventId: event.eventId };
    });
    return { ...result, waitMs, elapsedMs: performance.now() - started };
  }
  async readVersion() {
    await sleep(SERVICE_LATENCY_MS.versionRead);
    return this.version;
  }
  async placeBox(key, quantity) {
    await sleep(SERVICE_LATENCY_MS.referenceReads);
    if (!this.available) throw new Error('synthetic Sheets outage');
    const started = performance.now();
    const { result, waitMs } = await this.lock.run(async () => {
      const prior = this.boxAllocations.get(key);
      if (prior) return { duplicate: true, allocationId: prior.allocationId };
      if (!this.boxOpen) throw new Error('synthetic closed box');
      const used = [...this.boxAllocations.values()].reduce((sum, row) => sum + row.quantity, 0);
      const planned = used;
      if (quantity > this.boxCapacity - used) throw new Error('synthetic box capacity exceeded');
      if (quantity > this.boxPlan - planned) throw new Error('synthetic item plan exceeded');
      await sleep(SERVICE_LATENCY_MS.boxAppend);
      const allocation = { allocationId: `allocation-${this.boxAllocations.size + 1}`, quantity };
      this.boxAllocations.set(key, allocation);
      this.version += 1;
      return { duplicate: false, allocationId: allocation.allocationId };
    });
    return { ...result, waitMs, elapsedMs: performance.now() - started };
  }
}

function localExpandAndSearch(positions, query) {
  // Models client-only filtering and item expansion; deliberately no network adapter exists.
  return positions.filter(row => row.sku.includes(query));
}

export async function runLoadSimulation(userCount) {
  const fixture = new SheetsContractFixture();
  const openTimes = [];
  const localUiTimes = [];
  const writeTimes = [];
  const lockWaits = [];
  const updateTimes = [];
  const boxTimes = [];
  const boxWaits = [];
  const errors = [];

  const opened = await Promise.all(Array.from({ length: userCount }, async () => {
    const result = await fixture.openShipment();
    openTimes.push(result.elapsedMs);
    const started = performance.now();
    localExpandAndSearch(fixture.positions, 'SKU-1');
    localUiTimes.push(performance.now() - started);
    return result;
  }));

  const saves = await Promise.all(Array.from({ length: userCount }, (_, i) => fixture.save(`user-${i}-key-00000001`, i + 1)));
  saves.forEach(result => { writeTimes.push(result.elapsedMs); lockWaits.push(result.waitMs); });

  const retryKey = 'shared-retry-key-00000001';
  const concurrentRetries = await Promise.all(Array.from({ length: userCount }, () => fixture.save(retryKey, 7)));
  concurrentRetries.forEach(result => { lockWaits.push(result.waitMs); if (result.duplicate) writeTimes.push(result.elapsedMs); });
  const rowsAfterRetries = fixture.workLog.size;

  const outageCountBefore = fixture.workLog.size;
  fixture.available = false;
  try { await fixture.save('outage-key-000000001', 9); }
  catch { errors.push('Sheets outage rejected a write without appending'); }
  fixture.available = true;

  const knownVersion = fixture.version - 1;
  const clients = await Promise.all(Array.from({ length: userCount }, async () => {
    const started = performance.now();
    const version = await fixture.readVersion();
    updateTimes.push(performance.now() - started);
    return version > knownVersion;
  }));

  if (opened.some(row => row.count !== POSITION_COUNT)) throw new Error('shipment payload mismatch');
  if (fixture.workLog.size !== userCount + 1) throw new Error(`lost or duplicate write: expected ${userCount + 1}, got ${fixture.workLog.size}`);
  if (rowsAfterRetries !== userCount + 1) throw new Error('idempotency retry appended a duplicate');
  if ([...fixture.workLog.values()].some(event => event.positionId !== 'same-article-1')) throw new Error('same-article concurrency scenario mismatch');
  if (fixture.workLog.size !== outageCountBefore) throw new Error('outage wrote an unconfirmed operation');
  if (!clients.every(Boolean)) throw new Error('progress version was not observable to every client');
  if (concurrentRetries.filter(result => !result.duplicate).length !== 1) throw new Error('concurrent duplicate keys were not serialized');

  fixture.boxCapacity = Math.max(2, userCount - (userCount % 2));
  fixture.boxPlan = fixture.boxCapacity + 2;
  const boxAttempts = await Promise.all(Array.from({ length: userCount }, (_, i) => {
    const key = `box-user-${i}-key-000001`;
    return fixture.placeBox(key, 2).then(result => ({ ...result, key, ok: true })).catch(error => ({ key, ok: false, error: error.message }));
  }));
  boxAttempts.filter(result => result.ok).forEach(result => { boxTimes.push(result.elapsedMs); boxWaits.push(result.waitMs); });
  const acceptedBoxWrites = boxAttempts.filter(result => result.ok && !result.duplicate).length;
  const capacityRejections = boxAttempts.filter(result => !result.ok && result.error === 'synthetic box capacity exceeded').length;
  const expectedAccepted = fixture.boxCapacity / 2;
  if (acceptedBoxWrites !== expectedAccepted) throw new Error(`box capacity mismatch: expected ${expectedAccepted} accepted placements, got ${acceptedBoxWrites}`);
  if (capacityRejections !== userCount - expectedAccepted) throw new Error('box capacity did not reject every overflowing placement');
  const boxUsed = [...fixture.boxAllocations.values()].reduce((sum, row) => sum + row.quantity, 0);
  if (boxUsed > fixture.boxCapacity) throw new Error('box exceeded confirmed capacity');
  const firstBoxKey = boxAttempts.find(result => result.ok && !result.duplicate).key;
  const boxReplays = await Promise.all(Array.from({ length: userCount }, () => fixture.placeBox(firstBoxKey, 2)));
  boxReplays.forEach(result => { boxTimes.push(result.elapsedMs); boxWaits.push(result.waitMs); });
  if (boxReplays.some(result => !result.duplicate) || fixture.boxAllocations.size !== acceptedBoxWrites) throw new Error('box retry duplicated an allocation');
  const boxRowsBeforeOutage = fixture.boxAllocations.size;
  fixture.available = false;
  let boxOutageRejected = false;
  try { await fixture.placeBox('box-outage-key-000001', 1); }
  catch { boxOutageRejected = true; }
  fixture.available = true;
  if (!boxOutageRejected || fixture.boxAllocations.size !== boxRowsBeforeOutage) throw new Error('box outage wrote an unconfirmed allocation');

  return {
    users: userCount,
    contract: 'synthetic local adapter; no Google services called',
    openShipment: summarize(openTimes),
    localSearchExpand: summarize(localUiTimes),
    writeAndRetry: summarize(writeTimes),
    lockWait: summarize(lockWaits),
    versionUpdateCheck: summarize(updateTimes),
    boxPlacements: summarize(boxTimes),
    boxLockWait: summarize(boxWaits),
    boxAccepted: acceptedBoxWrites,
    boxCapacityRejections: capacityRejections,
    boxDuplicateReplays: boxReplays.length,
    boxUsed: boxUsed,
    boxCapacity: fixture.boxCapacity,
    boxOverfilled: boxUsed > fixture.boxCapacity,
    boxOutageRejected,
    successfulUniqueWrites: userCount + 1,
    successfulDuplicateReplays: concurrentRetries.filter(result => result.duplicate).length,
    expectedOutageRejections: errors.length,
    lostWrites: 0,
    duplicateRows: 0,
    clientsSeeingProgress: clients.filter(Boolean).length,
    errors,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reports = [];
  for (const users of USERS) reports.push(await runLoadSimulation(users));
  process.stdout.write(JSON.stringify({
    disclaimer: 'Synthetic contract simulation, not an Apps Script or Google Sheets load test. Timings describe this local mock only.',
    serviceLatencyMs: SERVICE_LATENCY_MS,
    reports,
  }, null, 2) + '\n');
}
