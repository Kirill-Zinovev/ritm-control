import test from "node:test";
import assert from "node:assert/strict";
import { printingRefreshDelay, printingSnapshotTime } from "../src/printingSnapshotRefresh.js";

test("fresh and cached snapshots refresh before the write guard expires", () => {
  const now = Date.parse("2026-11-05T08:00:00Z");
  assert.equal(printingRefreshDelay("2026-11-05T08:00:00Z", now), 290000);
  assert.equal(printingRefreshDelay("2026-11-05T07:56:00Z", now), 50000);
  assert.equal(printingRefreshDelay("2026-11-05T07:54:00Z", now), 1000);
  assert.equal(printingRefreshDelay("invalid", now), null);
});

test('printing snapshot time is readable and explicitly Moscow time',()=>{
 assert.equal(printingSnapshotTime('2026-11-11T13:04:17.093Z'),'11.11, 16:04 МСК');
 assert.equal(printingSnapshotTime('invalid'),null);
});
