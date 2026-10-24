import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IncidentStore } from "../agent/store.js";
import { AssemblySyncQueue, ASSEMBLY_SYNC_URL } from "../agent/assemblySync.js";

const secret = "ab".repeat(32);

test("Apps Script verifies Cyrillic Assembly event names using the sender UTF-8 charset", () => {
  const event = {
    v: 1,
    eventId: "93f0cc05-1843-4dfa-8000-5b51383d7837",
    action: "transfer",
    issuedAt: 1792573407422,
    transfer: { department: "box", name: "OZON МОСКВА 10_10" },
  };
  assert.equal(
    createHmac("sha256", secret).update(JSON.stringify(event), "utf8").digest("hex"),
    "1d51c7b3c486c5509bea094a5432f458f5b9566e74ddd111991687340bcb556a",
  );
  const script = readFileSync(new URL("../apps-script/assembly/Code.gs", import.meta.url), "utf8");
  assert.match(script, /computeHmacSha256Signature\(JSON\.stringify\(event\), secret, Utilities\.Charset\.UTF_8\)/);
  assert.match(script, /computeDigest\(Utilities\.DigestAlgorithm\.SHA_256, JSON\.stringify\(\[department, sheetId, name, manifest, rows\]\), Utilities\.Charset\.UTF_8\)/);
  const fingerprint = ["box", 122063726, "OZON МОСКВА 10_10", null, [{ sku: "SKU", uid: "", row: 5, quantity: 10 }]];
  assert.equal(createHash("sha256").update(JSON.stringify(fingerprint), "utf8").digest("hex"), "b8ac7a381e15d8340847a2ac7102c7b402ebece3ff10fa73798b6f34198e00a7");
});

test("explicit transfer is signed, separate from reconcile batches, and its receipt survives retries", async () => {
  const store = new IncidentStore(":memory:"), id = randomUUID(), actions = [];
  let calls = 0, at = Date.now();
  const queue = new AssemblySyncQueue(store, { secret, now: () => at, fetchImpl: async (_, init) => {
    const { event, signature } = JSON.parse(init.body); actions.push(event.action);
    assert.equal(signature, createHmac("sha256", secret).update(JSON.stringify(event)).digest("hex"));
    calls++;
    return new Response(JSON.stringify({ ok: true, status: "synced", eventId: event.eventId, name: "Existing", added: 2, existing: 1 }));
  } });
  try {
    queue.enqueueTransfer(id, { previewId: randomUUID(), name: "Existing", transfer: { department: "roll", sheetId: 50, keys: ["uid:a|SKU"] } });
    at++;
    queue.enqueue(operation());
    await queue.flush();
    assert.equal(queue.state().pending, 1);
    assert.deepEqual(actions, ["transfer"]);
    const receipt = store.db.prepare("SELECT receipt FROM assembly_sync_events WHERE id=?").get(id);
    assert.equal(JSON.parse(receipt.receipt).added, 2);
    await queue.flush(); assert.equal(calls, 2); assert.equal(queue.state().pending, 0);
    assert.deepEqual(actions, ["transfer", "reconcile"]);
  } finally { await queue.stop(); store.close(); }
});

test("a changed-source receipt ends an explicit transfer without replaying or blocking later events", async () => {
  const store = new IncidentStore(":memory:"), id = randomUUID(); let calls = 0;
  const queue = new AssemblySyncQueue(store, { secret, fetchImpl: async (_, init) => {
    calls++; const { event } = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: false, status: "conflict", eventId: event.eventId, message: "Состав источника изменился перед передачей." }));
  } });
  try {
    queue.enqueueTransfer(id, { name: "Source", previewId: randomUUID(), transfer: {} });
    await queue.flush(); await queue.flush();
    assert.equal(calls, 1); assert.equal(queue.state().pending, 0);
    const result = store.db.prepare("SELECT outcome,receipt FROM assembly_sync_events WHERE id=?").get(id);
    assert.equal(result.outcome, "conflict");
    assert.equal(JSON.parse(result.receipt).message, "Состав источника изменился перед передачей.");
  } finally { await queue.stop(); store.close(); }
});
const operation = (status = "verified") => ({ id: randomUUID(), action: "create", status });
const acknowledge = init => {
  const { event, signature } = JSON.parse(init.body);
  assert.equal(signature, createHmac("sha256", secret).update(JSON.stringify(event)).digest("hex"));
  return new Response(JSON.stringify({ ok: true, status: "synced", eventId: event.eventId }));
};

test("confirmed supply notifications coalesce, persist and do not replay production writes", async () => {
  const store = new IncidentStore(":memory:");
  let calls = 0;
  const queue = new AssemblySyncQueue(store, { secret, fetchImpl: async (url, init) => {
    assert.equal(url, ASSEMBLY_SYNC_URL); calls++; return acknowledge(init);
  } });
  try {
    assert.equal(queue.enqueue(operation("partial")), false);
    const first = operation(), second = operation();
    queue.enqueue(first); queue.enqueue(second);
    await queue.flush();
    assert.equal(calls, 1);
    assert.equal(queue.state().pending, 0);
    assert.equal(queue.enqueue(first), false);
    await queue.flush();
    assert.equal(calls, 1);
  } finally { await queue.stop(); store.close(); }
});

test("an unknown webhook result retains the outbox and retries with the same identity", async () => {
  const store = new IncidentStore(":memory:");
  let at = Date.now(), attempts = 0;
  const ids = [];
  const queue = new AssemblySyncQueue(store, { secret, now: () => at, fetchImpl: async (_, init) => {
    ids.push(JSON.parse(init.body).event.eventId);
    if (++attempts === 1) throw new Error("response lost after remote processing");
    return acknowledge(init);
  } });
  try {
    queue.enqueue(operation()); await queue.flush();
    assert.equal(queue.state().pending, 1);
    await queue.flush(); assert.equal(attempts, 1, "retry backoff applies");
    at += 5000; await queue.flush();
    assert.equal(queue.state().pending, 0);
    assert.equal(ids[0], ids[1]);
  } finally { await queue.stop(); store.close(); }
});

test("restart recovers a committed operation even if the process died before enqueue", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ritm-assembly-outbox-"));
  const filename = path.join(dir, "store.sqlite");
  let store = new IncidentStore(filename);
  const committed = operation();
  store.meta("productionSupplyOperations", [committed, operation("partial")]);
  store.close();
  store = new IncidentStore(filename);
  const queue = new AssemblySyncQueue(store, { secret, fetchImpl: async (_, init) => acknowledge(init) });
  try {
    queue.recoverConfirmed();
    assert.equal(queue.state().pending, 1);
    await queue.flush();
    assert.equal(queue.state().pending, 0);
  } finally {
    await queue.stop(); store.close();
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(dir).startsWith("ritm-assembly-outbox-"));
    rmSync(dir, { recursive: true });
  }
});

test("events arriving during delivery are not acknowledged by an older response", async () => {
  const store = new IncidentStore(":memory:");
  let release;
  const queue = new AssemblySyncQueue(store, { secret, fetchImpl: (_, init) => new Promise(resolve => {
    release = () => resolve(acknowledge(init));
  }) });
  try {
    queue.enqueue(operation());
    const pending = queue.flush();
    queue.enqueue(operation());
    release(); await pending;
    assert.equal(queue.state().pending, 1);
  } finally { await queue.stop(); store.close(); }
});

test("unconfigured delivery retains events, and unsafe redirects never receive a signature", async () => {
  const store = new IncidentStore(":memory:");
  let calls = 0;
  const disabled = new AssemblySyncQueue(store, { fetchImpl: () => { throw new Error("must not call network"); } });
  disabled.enqueue(operation()); await disabled.flush(); await disabled.stop();
  assert.equal(disabled.state().pending, 1);
  const queue = new AssemblySyncQueue(store, { secret, fetchImpl: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: "https://example.com/collect" } });
  } });
  try { await queue.flush(); assert.equal(calls, 1); assert.equal(queue.state().pending, 1); }
  finally { await queue.stop(); store.close(); }
});

test("Google ContentService redirects are followed only as GET without signed body", async () => {
  const store = new IncidentStore(":memory:");
  let expected, calls = 0;
  const queue = new AssemblySyncQueue(store, { secret, fetchImpl: async (_, init) => {
    if (++calls === 1) {
      expected = JSON.parse(init.body).event.eventId;
      return new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/macros/echo?test=1" } });
    }
    assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
    return new Response(JSON.stringify({ ok: true, status: "synced", eventId: expected }));
  } });
  try { queue.enqueue(operation()); await queue.flush(); assert.equal(queue.state().pending, 0); }
  finally { await queue.stop(); store.close(); }
});
