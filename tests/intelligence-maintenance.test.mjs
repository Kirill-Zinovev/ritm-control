import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { IncidentStore } from "../agent/store.js";

// Exercise the prepared maintenance SQL against isolated files, never the owner's database/task.
const helper = fileURLToPath(
  new URL("../scripts/windows/agent-maintenance.mjs", import.meta.url),
);
const run = (name, ...args) =>
  spawnSync(process.execPath, [helper, name, ...args], { encoding: "utf8" });

for (const scenario of ["crash", "graceful", "different-instance"]) {
  test(`maintenance backup preserves history and only releases verified lease: ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "ritm-maintenance-test-"));
    const file = join(dir, "test.sqlite"),
      copy = join(dir, "backup.sqlite");
    let store;
    try {
      store = new IncidentStore(file);
      store.meta("agent", { pid: 12345, status: "running" });
      store.acquire("original-instance");
      store.log("fixture_event", "ТЕСТ: история до обновления");
      const backedUp = run("backup", file, copy, "12345");
      assert.equal(backedUp.status, 0, backedUp.stderr);
      const snapshot = new IncidentStore(copy);
      assert.equal(snapshot.history().rows.length, 1);
      snapshot.close();
      if (scenario === "graceful") {
        store.release("original-instance");
        store.meta("agent", { status: "stopped" });
      }
      if (scenario === "different-instance") {
        store.release("original-instance");
        store.acquire("new-instance");
        store.meta("agent", { pid: 54321, status: "running" });
      }
      const released = run("release", file, copy, "12345");
      if (scenario === "different-instance") {
        assert.notEqual(released.status, 0);
        assert.equal(
          store.db.prepare("SELECT owner FROM lease").get().owner,
          "new-instance",
        );
        assert.equal(store.history().rows.length, 1);
      } else {
        assert.equal(released.status, 0, released.stderr);
        assert.equal(
          store.db.prepare("SELECT count(*) AS n FROM lease").get().n,
          0,
        );
        assert.equal(store.history().rows.length, 2);
      }
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("maintenance backup refuses to proceed while a repair is in flight", () => {
  const dir = mkdtempSync(join(tmpdir(), "ritm-maintenance-queue-test-"));
  const file = join(dir, "test.sqlite"),
    copy = join(dir, "backup.sqlite");
  let store;
  try {
    store = new IncidentStore(file);
    store.meta("agent", { pid: 12345, status: "running" });
    store.acquire("original-instance");
    store.db.exec("CREATE TABLE test_repair_proposals(status TEXT NOT NULL)");
    store.db
      .prepare("INSERT INTO test_repair_proposals(status) VALUES(?)")
      .run("executing");
    const backedUp = run("backup", file, copy, "12345");
    assert.notEqual(backedUp.status, 0);
    assert.match(backedUp.stderr, /Repair queue is active/);
    assert.equal(existsSync(copy), false);
    assert.equal(
      store.db.prepare("SELECT owner FROM lease").get().owner,
      "original-instance",
    );
    assert.equal(store.history().rows.length, 0);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maintenance backup refuses to proceed while source recovery is in flight", () => {
  const dir = mkdtempSync(
    join(tmpdir(), "ritm-maintenance-source-queue-test-"),
  );
  const file = join(dir, "test.sqlite"),
    copy = join(dir, "backup.sqlite");
  let store;
  try {
    store = new IncidentStore(file);
    store.meta("agent", { pid: 12345, status: "running" });
    store.acquire("original-instance");
    store.db
      .prepare(
        "INSERT INTO source_recovery_operations(id,request_id,incident_id,generation,status,created_at,updated_at,owner,target,approved_value,authorization) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "operation-1",
        "request-1",
        "incident-1",
        1,
        "repairing",
        new Date().toISOString(),
        new Date().toISOString(),
        "owner@example.test",
        "P4",
        "Елочные игрушки",
        "{}",
      );
    const backedUp = run("backup", file, copy, "12345");
    assert.notEqual(backedUp.status, 0);
    assert.match(backedUp.stderr, /Repair queue is active/);
    assert.equal(existsSync(copy), false);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart verification preserves formulas and history and reports a missing baseline", () => {
  const dir = mkdtempSync(join(tmpdir(), "ritm-maintenance-verify-test-"));
  const file = join(dir, "test.sqlite"),
    copy = join(dir, "backup.sqlite");
  let store;
  try {
    store = new IncidentStore(file);
    store.meta("agent", { pid: 12345, status: "running" });
    store.acquire("original-instance");
    store.log("fixture_event", "ТЕСТ: история до перезапуска");
    store.db.exec(`
      CREATE TABLE formula_protected(source_id TEXT,gid INTEGER,cell TEXT,formula TEXT,merge_signature TEXT,region_id TEXT,version TEXT,PRIMARY KEY(source_id,gid,cell));
      CREATE TABLE formula_versions(version TEXT PRIMARY KEY,region_id TEXT,at TEXT,payload BLOB);
      CREATE TABLE formula_decisions(id INTEGER PRIMARY KEY,at TEXT,action TEXT,payload TEXT);
      CREATE TABLE test_repair_proposals(id TEXT PRIMARY KEY,incident_id TEXT,version TEXT,status TEXT,payload TEXT,result TEXT);
      CREATE TABLE test_repair_events(id INTEGER PRIMARY KEY,proposal_id TEXT,at TEXT,type TEXT,payload TEXT);
    `);
    store.db.exec("DROP TABLE source_recovery_operations");
    store.db
      .prepare("INSERT INTO formula_protected VALUES(?,?,?,?,?,?,?)")
      .run("fbo", 1, "M11", "=C11/D11", "[]", "region-1", "version-1");
    store.db
      .prepare("INSERT INTO formula_versions VALUES(?,?,?,?)")
      .run(
        "version-1",
        "region-1",
        new Date().toISOString(),
        Buffer.from("snapshot"),
      );
    store.db
      .prepare("INSERT INTO test_repair_proposals VALUES(?,?,?,?,?,?)")
      .run("proposal-1", "incident-1", "version-1", "verified", "{}", "{}");
    store.db
      .prepare("INSERT INTO test_repair_events VALUES(?,?,?,?,?)")
      .run(
        1,
        "proposal-1",
        new Date().toISOString(),
        "repair_write_started",
        "{}",
      );
    const backedUp = run("backup", file, copy, "12345");
    assert.equal(backedUp.status, 0, backedUp.stderr);

    store.log("fixture_event", "ТЕСТ: история после резервной копии");
    store.meta("agent", { pid: 54321, status: "running" });
    store.db.exec(`
      CREATE TABLE source_recovery_operations(
        id TEXT PRIMARY KEY,request_id TEXT NOT NULL,incident_id TEXT NOT NULL,
        generation INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,owner TEXT NOT NULL,target TEXT NOT NULL,
        approved_value TEXT NOT NULL,authorization TEXT NOT NULL,before_value TEXT,
        after_value TEXT,result TEXT
      );
    `);
    store.db
      .prepare(
        "INSERT INTO source_recovery_operations(id,request_id,incident_id,generation,status,created_at,updated_at,owner,target,approved_value,authorization) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "operation-1",
        "request-1",
        "incident-1",
        1,
        "verified",
        new Date().toISOString(),
        new Date().toISOString(),
        "owner@example.test",
        "P4",
        "Елочные игрушки",
        "{}",
      );
    const verified = run("verify", file, copy, "54321");
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /"passed": true/);
    assert.match(verified.stdout, /"formula_protected": \{/);
    assert.match(verified.stdout, /"backupRows": 1/);
    assert.match(
      verified.stdout,
      /"source_recovery_operations": \{[\s\S]*?"currentRows": 1/,
    );

    store.db.prepare("DELETE FROM formula_protected WHERE cell='M11'").run();
    const missingBaseline = run("verify", file, copy, "54321");
    assert.notEqual(missingBaseline.status, 0);
    assert.match(missingBaseline.stdout, /"missing": 1/);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
