// Synthetic local benchmark; no Google credentials, production DB or Telegram transport.
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { IncidentStore } from "../agent/store.js";
import { FormulaIntelligence } from "../agent/formulaIntelligence.js";
const target = 97393,
  columns = 33,
  rows = Math.ceil(target / columns);
const document = {
  id: "synthetic-benchmark",
  name: "ТЕСТ производительности (синтетические формулы)",
  documentId: "synthetic_benchmark_not_google",
  adapter: "google",
  enabled: true,
  department: "ТЕСТ",
  sheets: [
    { gid: 1, name: "ТЕСТ", maxRows: rows, lastColumn: "AG", rules: [] },
  ],
};
const store = new IncidentStore(":memory:"),
  fi = new FormulaIntelligence(store, {
    doctorDocuments: [document],
    snapshotMaxAgeMs: 1200000,
  });
const memoryBeforeProcess = process.memoryUsage(),
  data = [];
for (let r = 0, n = 0; r < rows; r++) {
  const values = [];
  for (let c = 0; c < columns && n < target; c++, n++)
    values.push({
      userEnteredValue: { formulaValue: `=SUM(A${r + 1}:B${r + 1})` },
      effectiveValue: { numberValue: 1.24 },
    });
  data.push({ values });
}
const spreadsheet = {
  sheets: [
    {
      properties: {
        sheetId: 1,
        title: "ТЕСТ",
        gridProperties: { rowCount: rows, columnCount: columns },
      },
      merges: [],
      readBounds: { rows, columns, fullGrid: true },
      data: [{ rowData: data }],
    },
  ],
};
const memoryBeforeChecks = process.memoryUsage();
const times = {};
function scan(label) {
  const at = new Date().toISOString(),
    start = performance.now();
  const f = fi.inspect(document, spreadsheet, true, at);
  store.check(document.id, { status: "ok" }, at);
  times[label] = Math.round(performance.now() - start);
  return f;
}
scan("firstDiscoveryMs");
let started = performance.now();
const preview = fi.prepareProtection();
times.prepareProtectionMs = Math.round(performance.now() - started);
if (preview.totals.protectable !== target)
  throw new Error("Synthetic protection preview count mismatch");
started = performance.now();
fi.approveProtectionPreview({
  previewId: preview.previewId,
  acknowledged: true,
});
times.bulkApprovalMs = Math.round(performance.now() - started);
scan("protectedHealthyMs");
const native = data[10].values[12],
  original = native.userEnteredValue;
native.userEnteredValue = { numberValue: 150 };
const damaged = scan("damagedMs");
const repeated = scan("repeatMs");
native.userEnteredValue = original;
const restored = scan("restoredMs");
if (
  damaged.length !== 1 ||
  repeated.length !== 1 ||
  restored.length !== 0 ||
  store.listIncidents({ status: "fixed" }).total !== 1
)
  throw new Error("Synthetic lifecycle failed");
const report = {
  demonstration: true,
  at: new Date().toISOString(),
  formulas: target,
  regions: fi.state().regions.length,
  times,
  protectedCells: fi.state().metrics[0].protectedCells,
  coveragePercent: fi.state().metrics[0].protectedPercent,
  googleRequests: 0,
  telegramRequests: 0,
  rssAboveProcessStartMiB: Math.round(
    (process.memoryUsage().rss - memoryBeforeProcess.rss) / 1048576,
  ),
  rssAboveLoadedFixtureMiB: Math.round(
    (process.memoryUsage().rss - memoryBeforeChecks.rss) / 1048576,
  ),
  snapshotBytes: store.db
    .prepare("SELECT sum(length(payload)) AS n FROM formula_versions")
    .get().n,
  verifiedLifecycle: "fault → same incident → restored → closed",
};
mkdirSync(".checks", { recursive: true });
writeFileSync(
  ".checks/formula-intelligence-benchmark.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
store.close();
