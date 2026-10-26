import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { cloudSchemaStatements } from "../tests/helpers/cloud-schema.mjs";

const input = process.argv[2];
const baselineRepository = process.argv[3];
if (!input || !path.isAbsolute(input) || !baselineRepository || !path.isAbsolute(baselineRepository)) throw new Error("Pass absolute paths to the private migration artifact and unchanged baseline repository");
const envelope = JSON.parse(readFileSync(input, "utf8"));
const env = Object.fromEntries(Object.entries(envelope.payload.sources).map(([key, value]) => ["RITM_GOOGLE_" + key.replace(/[A-Z]/g, (letter) => "_" + letter).toUpperCase(), value]));
Object.assign(env, { RITM_OWNER_USER_IDS: "isolated-test-owner", RITM_GOOGLE_READER_JSON: "{}", RITM_CLOUD_IMPORT_ENABLED: "true" });
let outgoingBlocked = 0;
const mf = new Miniflare({ modules: true, scriptPath: fileURLToPath(new URL("../dist/server/index.js", import.meta.url)), compatibilityDate: "2026-08-06", d1Databases: ["DB"], bindings: env, outboundService: async () => { outgoingBlocked++; throw new Error("External traffic forbidden in migration parity check"); } });
const headers = { "oai-authenticated-user-id": "isolated-test-owner", origin: "https://ritm.isolated.test", "content-type": "application/json" };
try {
  const db = await mf.getD1Database("DB");
  for (const statement of cloudSchemaStatements()) await db.prepare(statement).run();
  const response = await mf.dispatchFetch("https://ritm.isolated.test/api/cloud/import", { method: "POST", headers, body: JSON.stringify({ explicitImportApproval: true, envelope }) });
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));
  const repeat = await mf.dispatchFetch("https://ritm.isolated.test/api/cloud/import", { method: "POST", headers, body: JSON.stringify({ explicitImportApproval: true, envelope }) });
  assert.equal((await repeat.json()).repeated, true);
  const linksResponse = await mf.dispatchFetch("https://ritm.isolated.test/api/assembly-transfers/links", { headers });
  assert.equal(linksResponse.status, 200);
  const actualLinks = (await linksResponse.json()).links;
  const originalModule = await import(pathToFileURL(path.join(baselineRepository, "agent/assemblyTransfer.js")).href);
  const oldDb = new DatabaseSync(path.join(path.dirname(input), "ritm-before-sites.sqlite"), { readOnly: true });
  let expectedLinks;
  try {
    const oldService = Object.create(originalModule.AssemblyTransferService.prototype);
    oldService.store = { db: oldDb };
    expectedLinks = oldService.links();
  } finally { oldDb.close(); }
  assert.deepEqual(actualLinks, expectedLinks);
  for (const snapshot of envelope.payload.snapshots) {
    const result = await db.prepare("SELECT s.updated_at,c.ordinal,c.payload FROM cloud_snapshots s JOIN cloud_snapshot_chunks c ON c.kind=s.kind AND c.generation=s.generation WHERE s.kind=? ORDER BY c.ordinal").bind(snapshot.kind).all();
    const text = result.results.map((row) => row.payload).join("");
    assert.equal(createHash("sha256").update(text).digest("hex"), createHash("sha256").update(JSON.stringify(snapshot.value)).digest("hex"));
    assert.equal(result.results[0].updated_at, Date.parse(snapshot.at));
  }
  assert.equal(outgoingBlocked, 0);
  const report = { ...receipt, isolatedWorkersRuntime: true, externalRequests: outgoingBlocked, sourceDatabaseOpenedReadOnly: true, linkedBoxSupplies: actualLinks.length, snapshotsEqualByDigest: envelope.payload.snapshots.length, existingAssemblyCodeChanged: false };
  mkdirSync(".checks", { recursive: true });
  writeFileSync(".checks/migration-parity.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await mf.dispose(); }
