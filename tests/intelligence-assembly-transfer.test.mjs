import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { IncidentStore } from "../agent/store.js";
import { AssemblySyncQueue } from "../agent/assemblySync.js";
import {
  AssemblyTransferService,
  ASSEMBLY_TRANSFER_SOURCES,
} from "../agent/assemblyTransfer.js";
import { createAgentServer } from "../agent/server.js";

function fixture(columnCount = 29) {
  const store = new IncidentStore(":memory:");
  const queue = new AssemblySyncQueue(store, {
    secret: "ab".repeat(32),
    fetchImpl: async (_, init) => {
      const { event } = JSON.parse(init.body);
      assert.equal(event.action, "transfer");
      return new Response(
        JSON.stringify({
          ok: true,
          status: "synced",
          eventId: event.eventId,
          name: "OZON existing",
          added: 1,
          existing: 0,
        }),
      );
    },
  });
  const sourceRows = [
    { sku: "SKU1", uid: "uid-1", row: 5, quantity: 12 },
    { sku: "SKU2", uid: "", row: 6, quantity: null },
  ];
  const reader = {
    configured: true,
    calls: [],
    manifests: new Map(),
    async get(id, params) {
      this.calls.push({ id, params });
      assert.ok(
        Object.values(ASSEMBLY_TRANSFER_SOURCES).some(
          (source) => source.id === id,
        ),
      );
      const properties = {
        sheetId: 50,
        title: "OZON existing",
        hidden: false,
        gridProperties: { rowCount: 1000, columnCount },
      };
      if (!params.ranges)
        return { spreadsheetId: id, sheets: [{ properties }] };
      const effectiveValue = (value) =>
        typeof value === "number"
          ? { numberValue: value }
          : { stringValue: value ?? "" };
      const data = params.ranges.map((range) => {
        if (!range.endsWith("E4:O4")) {
          assert.ok(
            !range.includes("5001"),
            "source ranges must remain within the physical grid",
          );
          if (columnCount < 29) assert.ok(!range.includes("!AC"));
        }
        const column = range.includes("!AC")
          ? 28
          : range.includes("!O")
            ? 14
            : 4;
        const rowData = [
          {
            values: [
              {
                effectiveValue: effectiveValue(
                  column === 4 ? "Артикул" : column === 14 ? "Кол-во" : "UID",
                ),
              },
            ],
          },
        ];
        if (range.endsWith("E4:O4"))
          return {
            startRow: 3,
            startColumn: 4,
            rowData: [
              {
                values: Array.from({ length: 11 }, (_, c) => ({
                  effectiveValue: effectiveValue(
                    c === 0 ? "Артикул" : c === 10 ? "Кол-во" : "",
                  ),
                })),
              },
            ],
          };
        for (const row of sourceRows)
          rowData.push({
            values: [
              {
                effectiveValue: effectiveValue(
                  column === 4
                    ? row.sku
                    : column === 14
                      ? row.quantity
                      : row.uid,
                ),
              },
            ],
          });
        return { startRow: 3, startColumn: column, rowData };
      });
      const manifest = this.manifests.get(id);
      return {
        spreadsheetId: id,
        sheets: [
          {
            properties,
            data,
            ...(manifest
              ? {
                  developerMetadata: [
                    {
                      metadataKey: "RITM_SUPPLY",
                      metadataValue: JSON.stringify(manifest),
                    },
                  ],
                }
              : {}),
          },
        ],
      };
    },
  };
  const service = new AssemblyTransferService(store, { reader, queue });
  return {
    store,
    queue,
    reader,
    service,
    sourceRows,
    async close() {
      await queue.stop();
      store.close();
    },
  };
}
test("transfer endpoints require owner login and local same-origin confirmation without using the production writer", async () => {
  const store = new IncidentStore(":memory:"),
    config = {
      ownerToken: "a".repeat(40),
      port: 4318,
      allowedOrigins: ["http://localhost:4318"],
      sources: [],
      apiRateLimit: 1000,
    };
  let previews = 0,
    transfers = 0;
  const server = createAgentServer(store, config, {
    assemblyTransfer: {
      sources: async () => [],
      source: async () => ({}),
      operation: () => null,
      preview: async () => {
        previews++;
        return {};
      },
      links: () => [{ name: "OZON existing", boxRows: 2 }],
      execute: async () => {
        transfers++;
        return { status: "pending" };
      },
    },
    rollSupplyService: {
      execute: () => {
        throw new Error("Production writer must never run");
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (path, headers = {}, payload) =>
    fetch(base + path, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        origin: "http://localhost:4318",
        "content-type": "application/json",
        ...headers,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  try {
    assert.equal(
      (await request("/api/assembly-transfers/sources")).status,
      401,
    );
    const login = await request(
      "/api/intelligence/session",
      {},
      { token: config.ownerToken },
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    for (const path of [
      "/api/assembly-transfers/preview",
      "/api/assembly-transfers",
    ]) {
      for (const headers of [
        { authorization: "Bearer " + config.ownerToken },
        { cookie, origin: "https://foreign.test" },
        { cookie, "x-forwarded-for": "127.0.0.1" },
        { cookie, forwarded: "for=127.0.0.1" },
      ])
        assert.equal((await request(path, headers, {})).status, 403);
    }
    assert.equal(previews, 0);
    assert.equal(transfers, 0);
    assert.equal(
      (await request("/api/assembly-transfers/sources", { cookie })).status,
      200,
    );
    const links = await request("/api/assembly-transfers/links", { cookie });
    assert.equal(links.status, 200);
    assert.deepEqual((await links.json()).links, [
      { name: "OZON existing", boxRows: 2 },
    ]);
    assert.equal(
      (await request("/api/assembly-transfers/preview", { cookie }, {})).status,
      200,
    );
    assert.equal(
      (await request("/api/assembly-transfers", { cookie }, {})).status,
      202,
    );
    assert.equal(previews, 1);
    assert.equal(transfers, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
test("existing sheet transfer uses read-only source data and persists one idempotent outbox operation", async () => {
  const f = fixture();
  try {
    assert.equal((await f.service.sources()).length, 2);
    const source = await f.service.source("roll", 50);
    assert.equal(source.items[1].quantity, null);
    assert.equal(
      source.fingerprint,
      createHash("sha256")
        .update(
          JSON.stringify(["roll", 50, "OZON existing", null, f.sourceRows]),
        )
        .digest("hex"),
    );
    const preview = await f.service.preview({
      department: "roll",
      sheetId: 50,
      fingerprint: source.fingerprint,
      keys: [source.items[0].key],
    });
    assert.equal(preview.rows, 1);
    assert.equal(preview.quantity, 12);
    const input = {
      previewId: preview.id,
      operationId: randomUUID(),
      explicitTransferApproval: true,
    };
    assert.equal((await f.service.execute(input)).status, "pending");
    await f.queue.flush();
    assert.equal((await f.service.execute(input)).status, "delivered");
    assert.equal(f.queue.state().pending, 0);
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM assembly_sync_events").get()
        .n,
      1,
    );
    await assert.rejects(
      f.service.execute({ ...input, previewId: randomUUID() }),
      /другого состава/,
    );
  } finally {
    await f.close();
  }
});
test("legacy source without AC uses row identity and bounded ranges", async () => {
  const f = fixture(20);
  try {
    const source = await f.service.source("box", 50);
    assert.equal(source.items[0].uid, "");
    assert.equal(source.items[0].key, "row:5|SKU1");
    assert.equal(source.items[0].quantity, 12);
  } finally {
    await f.close();
  }
});

test("source changes between selection, preview and confirmation prevent enqueue", async () => {
  const f = fixture();
  try {
    const source = await f.service.source("roll", 50);
    const data = {
      department: "roll",
      sheetId: 50,
      fingerprint: source.fingerprint,
      keys: [source.items[0].key],
    };
    const preview = await f.service.preview(data);
    f.sourceRows[0].quantity++;
    await assert.rejects(f.service.preview(data), /изменился/);
    await assert.rejects(
      f.service.execute({
        previewId: preview.id,
        operationId: randomUUID(),
        explicitTransferApproval: true,
      }),
      /изменился/,
    );
    assert.equal(f.queue.state().pending, 0);
    await assert.rejects(
      f.service.source("external-document", 50),
      /Выберите участок/,
    );
  } finally {
    await f.close();
  }
});

test("box positions can join a same-name roll-only managed supply", async () => {
  const f = fixture();
  try {
    f.sourceRows[1].quantity = 8;
    f.reader.manifests.set(ASSEMBLY_TRANSFER_SOURCES.roll.id, {
      version: 1,
      id: "RITM-SUPPLY-01234567-89ab-cdef-0123-456789abcdef",
      name: "OZON existing",
      ready: true,
      parts: [
        {
          department: "roll",
          documentId: ASSEMBLY_TRANSFER_SOURCES.roll.id,
          sheetId: 50,
        },
      ],
    });
    const source = await f.service.source("box", 50);
    const preview = await f.service.preview({
      department: "box",
      sheetId: 50,
      fingerprint: source.fingerprint,
      keys: source.items.map((item) => item.key),
      targetRollSheetId: 50,
    });
    assert.equal(preview.destinationName, "OZON existing");
    assert.equal(preview.rows, 2);
    assert.equal(preview.quantity, 20);
    const input = {
      previewId: preview.id,
      operationId: randomUUID(),
      explicitTransferApproval: true,
    };
    assert.equal((await f.service.execute(input)).status, "pending");
    const queued = JSON.parse(
      f.store.db
        .prepare("SELECT payload FROM assembly_sync_events WHERE id=?")
        .get(input.operationId).payload,
    );
    assert.equal(queued.transfer.targetRollSheetId, 50);
    assert.equal(
      queued.transfer.targetRollFingerprint,
      (await f.service.readSource("roll", 50)).fingerprint,
    );
    assert.deepEqual(queued.boxQuantityByKey, {
      "uid:uid-1|SKU1": 12,
      "row:6|SKU2": 8,
    });
    await f.queue.flush();
    assert.deepEqual(f.service.links(), [
      {
        name: "OZON existing",
        boxSheetId: 50,
        targetRollSheetId: 50,
        positionKeys: ["row:6|SKU2", "uid:uid-1|SKU1"],
        boxRows: 2,
        boxQuantity: 20,
      },
    ]);
  } finally {
    await f.close();
  }
});

test("a changed roll target after preview prevents box transfer enqueue", async () => {
  const f = fixture();
  try {
    f.sourceRows[1].quantity = 8;
    const manifest = {
      version: 1,
      id: "RITM-SUPPLY-01234567-89ab-cdef-0123-456789abcdef",
      name: "OZON existing",
      ready: true,
      parts: [
        {
          department: "roll",
          documentId: ASSEMBLY_TRANSFER_SOURCES.roll.id,
          sheetId: 50,
        },
      ],
    };
    f.reader.manifests.set(ASSEMBLY_TRANSFER_SOURCES.roll.id, manifest);
    const source = await f.service.source("box", 50);
    const preview = await f.service.preview({
      department: "box",
      sheetId: 50,
      fingerprint: source.fingerprint,
      keys: [source.items[0].key],
      targetRollSheetId: 50,
    });
    manifest.name = "Renamed supply";
    await assert.rejects(
      f.service.execute({
        previewId: preview.id,
        operationId: randomUUID(),
        explicitTransferApproval: true,
      }),
      /изменилась после проверки/,
    );
    assert.equal(f.queue.state().pending, 0);
  } finally {
    await f.close();
  }
});

test("box transfer refuses to merge into a roll supply with another department", async () => {
  const f = fixture();
  try {
    f.reader.manifests.set(ASSEMBLY_TRANSFER_SOURCES.roll.id, {
      version: 1,
      id: "RITM-SUPPLY-01234567-89ab-cdef-0123-456789abcdef",
      name: "OZON existing",
      ready: true,
      parts: [
        {
          department: "roll",
          documentId: ASSEMBLY_TRANSFER_SOURCES.roll.id,
          sheetId: 50,
        },
        {
          department: "box",
          documentId: ASSEMBLY_TRANSFER_SOURCES.box.id,
          sheetId: 51,
        },
      ],
    });
    const source = await f.service.source("box", 50);
    await assert.rejects(
      f.service.preview({
        department: "box",
        sheetId: 50,
        fingerprint: source.fingerprint,
        keys: [source.items[0].key],
        targetRollSheetId: 50,
      }),
      /отдельную рулонную поставку/,
    );
    assert.equal(f.queue.state().pending, 0);
  } finally {
    await f.close();
  }
});

test("RITM supply indicator counts unique box positions across old and targeted transfers", async () => {
  const f = fixture();
  try {
    const insert = f.store.db.prepare(
      "INSERT INTO assembly_sync_events (id,action,created_at,next_attempt_at,payload,outcome,receipt) VALUES(?,'transfer',?,?,?,'synced',?)",
    );
    const boxTransfer = (keys, targetRollSheetId) => ({
      transfer: {
        department: "box",
        name: "OZON existing",
        sheetId: 77,
        keys,
        ...(targetRollSheetId == null ? {} : { targetRollSheetId }),
      },
    });
    insert.run(
      randomUUID(),
      1,
      1,
      JSON.stringify(boxTransfer(["row:5|SKU1", "uid:uid-2|SKU2"], null)),
      JSON.stringify({ added: 2 }),
    );
    insert.run(
      randomUUID(),
      2,
      2,
      JSON.stringify(boxTransfer(["row:5|SKU1"], 50)),
      JSON.stringify({ added: 1 }),
    );
    assert.deepEqual(f.service.links(), [
      {
        name: "OZON existing",
        boxSheetId: 77,
        targetRollSheetId: 50,
        positionKeys: ["row:5|SKU1", "uid:uid-2|SKU2"],
        boxRows: 2,
        boxQuantity: null,
      },
    ]);
  } finally {
    await f.close();
  }
});

test("confirmed historical box transfers recover and retain the planned quantity", async () => {
  const f = fixture();
  try {
    f.sourceRows[1].quantity = 8;
    const source = await f.service.source("box", 50);
    const preview = await f.service.preview({
      department: "box",
      sheetId: 50,
      fingerprint: source.fingerprint,
      keys: source.items.map((item) => item.key),
      targetRollSheetId: 50,
    });
    const previewPayload = JSON.parse(
      f.store.db
        .prepare("SELECT payload FROM assembly_transfer_previews WHERE id=?")
        .get(preview.id).payload,
    );
    const operationId = randomUUID();
    f.store.db
      .prepare(
        "INSERT INTO assembly_sync_events (id,action,created_at,next_attempt_at,payload,outcome,receipt) VALUES(?,'transfer',?,?,?,'synced',?)",
      )
      .run(
        operationId,
        1,
        1,
        JSON.stringify({
          previewId: preview.id,
          name: previewPayload.name,
          transfer: previewPayload.transfer,
        }),
        JSON.stringify({ added: 2 }),
      );

    const restartedService = new AssemblyTransferService(f.store, {
      reader: f.reader,
      queue: f.queue,
    });
    const recovered = JSON.parse(
      f.store.db
        .prepare("SELECT payload FROM assembly_sync_events WHERE id=?")
        .get(operationId).payload,
    );
    assert.deepEqual(recovered.boxQuantityByKey, {
      "uid:uid-1|SKU1": 12,
      "row:6|SKU2": 8,
    });
    assert.deepEqual(restartedService.links(), [
      {
        name: "OZON existing",
        boxSheetId: 50,
        targetRollSheetId: 50,
        positionKeys: ["row:6|SKU2", "uid:uid-1|SKU1"],
        boxRows: 2,
        boxQuantity: 20,
      },
    ]);
  } finally {
    await f.close();
  }
});

test("Assembly Apps Script recognizes managed and legacy roll mirrors as safe targets", () => {
  const code = readFileSync(
    new URL("../apps-script/assembly/Code.gs", import.meta.url),
    "utf8",
  );
  const context = {};
  runInNewContext(
    code +
      String.fromCharCode(10) +
      "globalThis.resolveRollMirror = ritmResolveRollMirror_; globalThis.isRollTarget = ritmIsStandaloneRollTarget_;",
    context,
  );
  const rollSource = {
    department: "roll",
    sheetId: 50,
    name: "OZON existing",
    manifest: null,
  };
  const rollPart = {
    department: "roll",
    documentId: ASSEMBLY_TRANSFER_SOURCES.roll.id,
    sheetId: 50,
  };
  const target = (note, name = "OZON existing") => ({
    getName: () => name,
    getRange: () => ({ getNote: () => note }),
  });
  const resolve = (shipmentId, identity, record, source = rollSource) => {
    const marker = "RITM_ASSEMBLY_SUPPLY_V1:" + identity;
    const key = "ritm.assembly.supply." + identity;
    const props = { getProperties: () => ({ [key]: JSON.stringify(record) }) };
    const sheet = target(marker, record.name);
    const db = { getSheetById: (id) => (id === 900 ? sheet : null) };
    return context.resolveRollMirror(source, db, props, 50);
  };

  const managedId = "RITM-SUPPLY-01234567-89ab-cdef-0123-456789abcdef";
  const managed = resolve(managedId, "linked-" + managedId, {
    shipmentId: managedId,
    name: rollSource.name,
    sourceSheetId: 50,
    sheetId: 900,
    marker: "RITM_ASSEMBLY_SUPPLY_V1:linked-" + managedId,
    routed: true,
    parts: [rollPart],
  });
  assert.equal(managed.shipmentId, managedId);
  assert.equal(managed.key, "ritm.assembly.supply.linked-" + managedId);

  const renamedSource = { ...rollSource, name: "OZON renamed at source" };
  const renamedMatch = resolve(managedId, "linked-" + managedId, {
    shipmentId: managedId,
    name: rollSource.name,
    sourceSheetId: 50,
    sheetId: 900,
    marker: "RITM_ASSEMBLY_SUPPLY_V1:linked-" + managedId,
    routed: true,
    parts: [rollPart],
  }, renamedSource);
  assert.equal(renamedMatch.shipmentId, managedId, "stable source sheet ID and marker survive a source rename");

  const boxSource = { department: "box", sheetId: 70, name: "OZON box", manifest: null };
  const mergedMatch = resolve(managedId, "linked-" + managedId, {
    shipmentId: managedId,
    name: rollSource.name,
    sourceSheetId: 50,
    sheetId: 900,
    marker: "RITM_ASSEMBLY_SUPPLY_V1:linked-" + managedId,
    routed: true,
    parts: [rollPart],
  }, boxSource);
  assert.equal(mergedMatch.shipmentId, managedId, "a box refresh resolves its linked roll mirror by the stored roll source ID");

  const legacy = resolve("RITM-ROLL-50", "50", {
    shipmentId: "RITM-ROLL-50",
    name: rollSource.name,
    sourceSheetId: 50,
    sheetId: 900,
  });
  assert.equal(legacy.shipmentId, "RITM-ROLL-50");

  assert.equal(
    context.isRollTarget({
      ...rollSource,
      manifest: { ready: true, parts: [rollPart] },
    }),
    true,
  );
  assert.equal(
    context.isRollTarget({
      ...rollSource,
      manifest: {
        ready: true,
        parts: [rollPart, { ...rollPart, department: "box" }],
      },
    }),
    false,
  );
});
