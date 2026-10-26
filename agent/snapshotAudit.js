import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { inspectDocument } from "./doctor.js";
import { DEFAULT_DOCTOR_DOCUMENTS } from "./doctorRegistry.js";
export function unpackSnapshot(snapshot) {
  return {
    spreadsheetId: snapshot.spreadsheetId,
    properties: snapshot.properties,
    sheets: snapshot.sheets.map((s) => ({
      properties: s.properties,
      data: s.cells.map(([row, column, entered, effective]) => ({
        startRow: row,
        startColumn: column,
        rowData: [
          {
            values: [
              {
                ...(entered ? { userEnteredValue: entered } : {}),
                ...(effective ? { effectiveValue: effective } : {}),
              },
            ],
          },
        ],
      })),
    })),
  };
}
export function auditSnapshot(
  document,
  snapshot,
  { iterations = 50, now = new Date() } = {},
) {
  if (snapshot.source !== "google_drive_connector")
    throw new Error("Unknown snapshot origin");
  const spreadsheet = unpackSnapshot(snapshot),
    times = [];
  let result;
  const before = process.memoryUsage().rss;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    result = inspectDocument(document, spreadsheet, { now });
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return {
    source: snapshot.source,
    capturedAt: snapshot.at,
    document: document.name,
    iterations,
    diagnosticMedianMs: Number(times[Math.floor(times.length / 2)].toFixed(3)),
    diagnosticP95Ms: Number(times[Math.floor(times.length * 0.95)].toFixed(3)),
    rssBeforeBytes: before,
    rssAfterBytes: process.memoryUsage().rss,
    complete: result.complete,
    stats: result.stats,
    findings: result.findings.map((f) => ({
      type: f.type,
      sheet: f.sheet,
      cell: f.cell,
      verification: f.verification,
      expected: f.expected,
      sourceUrl: f.sourceUrl,
    })),
    baselineFormulaCount: Object.keys(result.baseline).length,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const dir = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) throw new Error("Specify private snapshot directory");
  const results = DEFAULT_DOCTOR_DOCUMENTS.map((doc, i) =>
    auditSnapshot(
      doc,
      JSON.parse(fs.readFileSync(path.join(dir, i + ".snapshot.json"), "utf8")),
    ),
  );
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify(
      { at: new Date().toISOString(), networkRequests: 0, results },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ networkRequests: 0, results }, null, 2));
}
