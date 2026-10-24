import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { IncidentStore } from "../agent/store.js";
import { createAgentServer } from "../agent/server.js";
import {
  ProductionSupplyService,
  routeSupplyLines,
  machineDepartment,
  shipmentMarketplace,
  DEPARTMENTS,
} from "../agent/productionSupplies.js";

const catalog = {
  WB: [
    [
      "Артикул",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "Кто печатает",
      "",
      "",
      "",
      "Вид станка по умолчанию",
    ],
    ["ROLL", "", "", "", "", "", "", "", "Бокс", "", "", "", "2-GO"],
    ["BOX", "", "", "", "", "", "", "", "Красное здание", "", "", "", "XEROX"],
  ],
  OZON: [
    ["Артикул", "", "", "", "", "", "", "", "", "", "", "", "", "", "станок"],
    [
      "ROLL(OZ)",
      "ROLL",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "2-GO",
    ],
    ["BOX(OZ)", "BOX", "", "", "", "", "", "", "", "", "", "", "", "", "XEROX"],
  ],
};
const payload = () => ({
  action: "create",
  operationId: randomUUID(),
  explicitWriteApproval: true,
  name: "OZON Общая поставка",
  lines: [
    { article: "ROLL", quantity: 10 },
    { article: "BOX", quantity: 7 },
  ],
});

test("production preview and execution require a local owner cookie and reject foreign origins, bearer-only and proxy requests", async () => {
  const store = new IncidentStore(":memory:");
  const config = {
    ownerToken: "a".repeat(40),
    port: 4318,
    allowedOrigins: ["http://localhost:4318"],
    sources: [],
    apiRateLimit: 1000,
  };
  let previews = 0,
    writes = 0;
  const notifications = [];
  const productionSupplyService = {
    async preview() {
      previews++;
      return { id: "checked", blocked: false };
    },
    async execute(input) {
      writes++;
      return { id: input.operationId, action: input.action, status: "verified" };
    },
    operations: () => [],
    state: () => ({ supplies: [] }),
  };
  const server = createAgentServer(store, config, {
    rollSupplyService: {},
    productionSupplyService,
    assemblySync: { enqueue: operation => notifications.push(operation) },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const request = (path, headers, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            host: `localhost:${port}`,
            origin: "http://localhost:4318",
            "content-type": "application/json",
            ...headers,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  try {
    assert.equal(
      (await request("/api/roll-supplies/preview", {}, payload())).statusCode,
      401,
    );
    const login = await request(
      "/api/intelligence/session",
      {},
      { token: config.ownerToken },
    );
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    for (const endpoint of [
      "/api/roll-supplies/preview",
      "/api/roll-supplies",
    ]) {
      for (const extra of [
        { origin: "https://foreign.test" },
        { "x-forwarded-for": "100.1.1.1" },
        { forwarded: "for=100.1.1.1" },
        { authorization: "Bearer " + config.ownerToken, cookie: "" },
      ])
        assert.equal(
          (await request(endpoint, { cookie, ...extra }, payload())).statusCode,
          403,
        );
    }
    assert.equal(previews, 0);
    assert.equal(writes, 0);
    assert.equal(notifications.length, 0);
    assert.equal(
      (await request("/api/roll-supplies/preview", { cookie }, payload()))
        .statusCode,
      200,
    );
    assert.equal(previews, 1);
    assert.equal(writes, 0);
    assert.equal(
      (
        await request(
          "/api/roll-supplies",
          { cookie },
          { ...payload(), previewId: "checked" },
        )
      ).statusCode,
      200,
    );
    assert.equal(writes, 1);
    const partDelete = await request("/api/roll-supplies", { cookie }, {
      action: "deletePart",
      department: "box",
      explicitWriteApproval: true,
      operationId: randomUUID(),
      name: "OZON Общая поставка",
      sheetId: 999,
    });
    assert.equal(partDelete.statusCode, 200);
    assert.equal(writes, 2, "department deletion is routed through the shared production service");
    assert.deepEqual(notifications.map(operation => operation.action), ["create", "deletePart"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

function fixture() {
  const metadata = new Map();
  const store = {
    meta(key, value) {
      if (arguments.length === 1)
        return structuredClone(metadata.get(key) ?? null);
      metadata.set(key, structuredClone(value));
    },
    log() {},
  };
  const legacy = { busy: false, writeConflict: () => null };
  const writers = {};
  let seq = 100;
  for (const department of ["roll", "box"]) {
    const sheets = new Map();
    const writer = {
      documentId: DEPARTMENTS[department].documentId,
      sheets,
      preparedTemplates: new Map(),
      writes: 0,
      commits: 0,
      reject: false,
      lost: false,
      unreadable: false,
      async verifyEditAccess() {
        if (this.forbidden) throw new Error("forbidden destination");
      },
      async prepareCreate(p) {
        await this.verifyEditAccess();
        this.preparedTemplates.set(p.operationId, true);
        return { ...p, action: "create", sheetId: seq++, startRow: 5 };
      },
      async prepareAppend(p) {
        return { ...p, startRow: 5 };
      },
      async prepareDelete(p) {
        const target = sheets.get(p.sheetId);
        if (!target || target.name !== p.name)
          throw new Error("exact delete target mismatch");
        return { action: "delete", name: p.name, sheetId: p.sheetId };
      },
      async metadata() {
        return [...sheets.values()].map((s) => ({
          sheetId: s.sheetId,
          title: s.name,
          gridProperties: { rowCount: 600 },
        }));
      },
      async grid(name) {
        const sheet = [...sheets.values()].find((s) => s.name === name);
        return {
          data: [
            {
              startRow: 4,
              startColumn: 0,
              rowData: sheet.lines.map((l) => ({
                values: Array.from({ length: 5 }, (_, i) =>
                  i === 4
                    ? { userEnteredValue: { stringValue: l.article } }
                    : {},
                ),
              })),
            },
          ],
        };
      },
      async request(url, options) {
        const body =
            typeof options.body === "string"
              ? JSON.parse(options.body)
              : options.body,
          manifest =
            body.requests.at(-1).createDeveloperMetadata.developerMetadata;
        sheets.get(manifest.location.sheetId).manifest = JSON.parse(
          manifest.metadataValue,
        );
      },
      async execute(plan) {
        if (this.reject) throw new Error("rejected before write");
        this.writes++;
        if (plan.action === "delete") {
          sheets.delete(plan.sheetId);
          return;
        }
        const saved = structuredClone(plan);
        if (plan.action === "append")
          saved.lines = [
            ...saved.lines,
            ...(sheets.get(plan.sheetId)?.lines || []),
          ];
        sheets.set(plan.sheetId, saved);
        if (this.lost)
          throw Object.assign(new Error("lost after accept"), {
            uncertain: true,
          });
      },
      async manifest(id) {
        return sheets.get(id)?.manifest || null;
      },
      async verify(plan) {
        if (plan.action === "delete") {
          if (sheets.has(plan.sheetId)) throw new Error("delete readback failed");
          return { calculations: [] };
        }
        if (this.unreadable || !sheets.has(plan.sheetId))
          throw new Error("readback unavailable");
        return { calculations: [] };
      },
      async publish(plan, manifest) {
        this.commits++;
        sheets.get(plan.sheetId).manifest = { ...manifest, ready: true };
      },
    };
    writers[department] = writer;
  }
  const createService = () => {
    const s = new ProductionSupplyService(store, { writers, legacy });
    s.catalog = async () => structuredClone(catalog);
    return s;
  };
  return { store, writers, legacy, createService, service: createService() };
}

test("confirmed machines determine departments independently of Who prints and marketplace article text", () => {
  for (const machine of ["2-GO", "УФ", "Уф. бел", "УФ бел.", "Уф двусторонний"])
    assert.equal(machineDepartment(machine), "roll");
  for (const machine of ["УФ Планшет", "DTF", "xerox"])
    assert.equal(machineDepartment(machine), "box");
  assert.equal(machineDepartment("UNKNOWN"), null);
  assert.equal(shipmentMarketplace("WB тестовая"), "WB");
  assert.equal(shipmentMarketplace("WBX"), null);
  assert.equal(shipmentMarketplace("WB OZON"), null);
  const routed = routeSupplyLines(payload().lines, "WB", catalog);
  assert.deepEqual(
    routed.map((l) => l.department),
    ["roll", "box"],
  );
});

test("OZON suffix and broken lookup use exact base WB machine; conflicting catalog rows block", () => {
  const data = structuredClone(catalog);
  data.OZON[2][14] = "#N/A";
  assert.equal(
    routeSupplyLines([{ article: " box(OZ) ", quantity: 1 }], "OZON", data)[0]
      .department,
    "box",
  );
  data.WB.push([...data.WB[2].slice(0, 12), "2-GO"]);
  const conflict = routeSupplyLines(
    [{ article: "BOX", quantity: 1 }],
    "OZON",
    data,
  )[0];
  assert.equal(conflict.department, null);
  assert.match(conflict.issue, /Разные станки/);
});

test("preview separates unknown articles and writes only the recognized subset", async () => {
  const f = fixture(),
    p = payload();
  p.lines.push({ article: "MISSING", quantity: 2 });
  const preview = await f.service.preview(p);
  assert.equal(preview.blocked, false);
  assert.equal(preview.acceptedRows, 2);
  assert.equal(preview.skippedRows, 1);
  assert.equal(f.writers.roll.writes + f.writers.box.writes, 0);
  const result = await f.service.execute({ ...p, previewId: preview.id });
  assert.equal(result.status, "verified");
  assert.equal(result.rows, 2);
  assert.equal(result.skippedLines.length, 1);
  assert.equal(result.skippedLines[0].article, "MISSING");
  assert.equal(result.skippedLines[0].quantity, 2);
  assert.ok(
    Object.values(f.writers).every((writer) =>
      [...writer.sheets.values()].every((sheet) =>
        sheet.lines.every((line) => line.article !== "MISSING"),
      ),
    ),
  );
  assert.equal(
    f.store.meta("productionSupplyOperations")[0].lines.length,
    3,
    "keep the original approved input for audit",
  );
});

test("an entirely unknown list creates no empty supply or department jobs", async () => {
  const f = fixture(),
    p = { ...payload(), lines: [{ article: "MISSING", quantity: 2 }] };
  const preview = await f.service.preview(p);
  assert.equal(preview.blocked, true);
  assert.equal(preview.acceptedRows, 0);
  assert.equal(preview.skippedRows, 1);
  await assert.rejects(
    () => f.service.execute({ ...p, previewId: preview.id }),
    /Нет распознанных товаров/,
  );
  assert.equal(f.writers.roll.writes + f.writers.box.writes, 0);
  assert.equal(f.store.meta("productionSupplies"), null);
});

test("skipped items survive restart and are rechecked and appended to the same supply after catalog repair", async () => {
  const f = fixture(),
    p = payload();
  p.lines.push({ article: "MISSING", quantity: 2 });
  const preview = await f.service.preview(p);
  await f.service.execute({ ...p, previewId: preview.id });
  const restarted = f.createService();
  const source = restarted
    .state()
    .operations.find((op) => op.id === p.operationId);
  assert.equal(source.skippedLines.length, 1);
  const before = f.store.meta("productionSupplies")[0];
  const retry = {
    ...payload(),
    action: "append",
    name: p.name,
    department: source.retryTarget.department,
    sheetId: source.retryTarget.sheetId,
    lines: source.skippedLines.map(({ article, quantity }) => ({
      article,
      quantity,
    })),
  };
  const unknown = await restarted.preview(retry);
  assert.equal(unknown.blocked, true);
  const repaired = structuredClone(catalog);
  repaired.WB.push(["MISSING", ...Array(11).fill(""), "XEROX"]);
  restarted.catalog = async () => repaired;
  const checked = await restarted.preview(retry);
  assert.equal(checked.acceptedRows, 1);
  const result = await restarted.execute({ ...retry, previewId: checked.id });
  assert.equal(result.status, "verified");
  assert.equal(f.store.meta("productionSupplies").length, 1);
  assert.equal(f.store.meta("productionSupplies")[0].id, before.id);
  assert.equal(
    restarted.state().operations.find((op) => op.id === p.operationId)
      .skippedLines.length,
    0,
  );
  assert.equal(
    f.store
      .meta("productionSupplyOperations")
      .find((op) => op.id === p.operationId).skippedLines.length,
    1,
    "retain the original skip audit after successful reimport",
  );
  assert.equal(f.writers.roll.writes, 1);
  assert.equal(f.writers.box.writes, 2);
  await restarted.execute({ ...retry, previewId: checked.id });
  assert.equal(
    f.writers.box.writes,
    2,
    "repeat confirmation cannot duplicate the repaired item",
  );
});

test("two destinations are preflighted before writes; fresh catalog routing must match preview", async () => {
  const f = fixture(),
    p = payload(),
    preview = await f.service.preview(p);
  f.writers.box.forbidden = true;
  await assert.rejects(
    () => f.service.execute({ ...p, previewId: preview.id }),
    /forbidden/,
  );
  assert.equal(f.writers.roll.writes, 0);
  f.writers.box.forbidden = false;
  const changed = structuredClone(catalog);
  changed.OZON[2][14] = "2-GO";
  f.service.catalog = async () => changed;
  await assert.rejects(
    () => f.service.execute({ ...p, previewId: preview.id }),
    /Станки в базе изменились/,
  );
  assert.equal(f.writers.roll.writes, 0);
});

test("one owner action creates disjoint department jobs with one committed Assembly identity", async () => {
  const f = fixture(),
    p = payload(),
    preview = await f.service.preview(p);
  const result = await f.service.execute({ ...p, previewId: preview.id });
  assert.equal(result.status, "verified");
  const supply = f.store.meta("productionSupplies")[0];
  assert.equal(supply.parts.length, 2);
  assert.deepEqual([...f.writers.roll.sheets.values()][0].lines, [p.lines[0]]);
  assert.deepEqual([...f.writers.box.sheets.values()][0].lines, [p.lines[1]]);
  for (const writer of Object.values(f.writers)) {
    const sheet = [...writer.sheets.values()][0];
    assert.equal(sheet.manifest.id, supply.id);
    assert.equal(sheet.manifest.ready, true);
  }
  await f.service.execute({ ...p, previewId: preview.id });
  assert.equal(f.writers.roll.writes, 1);
  assert.equal(f.writers.box.writes, 1);
  await assert.rejects(
    () =>
      f.service.execute({
        ...p,
        lines: [{ article: "BOX", quantity: 100 }],
        previewId: preview.id,
      }),
    /другого состава/,
  );
});

for (const department of ["roll", "box"]) {
  test(`deleting the ${department} part removes only that department and updates the shared manifest`, async () => {
    const f = fixture(),
      p = payload(),
      preview = await f.service.preview(p);
    await f.service.execute({ ...p, previewId: preview.id });
    const supply = f.store.meta("productionSupplies")[0];
    const target = supply.parts.find((part) => part.department === department);
    const survivor = supply.parts.find((part) => part.department !== department);
    const targetWriter = f.writers[department];
    const survivorWriter = f.writers[survivor.department];
    const deletion = {
      action: "deletePart",
      department,
      explicitWriteApproval: true,
      name: p.name,
      operationId: randomUUID(),
      sheetId: target.sheetId,
    };
    const deleted = await f.service.execute(deletion);
    assert.equal(deleted.status, "verified");
    assert.equal(deleted.action, "deletePart");
    assert.equal(targetWriter.sheets.has(target.sheetId), false);
    assert.equal(survivorWriter.sheets.has(survivor.sheetId), true);
    assert.deepEqual(survivorWriter.sheets.get(survivor.sheetId).lines, [
      p.lines[department === "roll" ? 1 : 0],
    ]);
    const remainingManifest = await survivorWriter.manifest(survivor.sheetId);
    assert.equal(remainingManifest.ready, true);
    assert.deepEqual(
      remainingManifest.parts.map((part) => part.department),
      [survivor.department],
    );
    const updatedSupply = f.store.meta("productionSupplies")[0];
    assert.deepEqual(
      updatedSupply.parts.map((part) => part.department),
      [survivor.department],
    );
    assert.equal(
      f.service.state().operations.some((item) => item.id === deletion.operationId),
      false,
      "verified department deletions stay in the audit store but leave the operator panel",
    );
    const writesAfterDelete = targetWriter.writes;
    assert.equal((await f.service.execute(deletion)).status, "verified");
    assert.equal(targetWriter.writes, writesAfterDelete, "repeating the same confirmation never deletes or writes twice");
  });
}

test("known rejection in second department resumes only its unsent work", async () => {
  const f = fixture(),
    p = payload(),
    preview = await f.service.preview(p);
  f.writers.box.reject = true;
  assert.equal(
    (await f.service.execute({ ...p, previewId: preview.id })).status,
    "partial",
  );
  assert.equal(f.writers.roll.writes, 1);
  assert.equal(f.writers.roll.commits, 0);
  f.writers.box.reject = false;
  const restarted = f.createService();
  const result = await restarted.execute({
    action: "resume",
    operationId: p.operationId,
    explicitWriteApproval: true,
  });
  assert.equal(result.status, "verified");
  assert.equal(f.writers.roll.writes, 1);
  assert.equal(f.writers.box.writes, 1);
});

test("lost accepted write is verified after restart rather than sent twice; missing proof blocks continuation", async () => {
  const f = fixture(),
    p = payload(),
    preview = await f.service.preview(p);
  f.writers.box.lost = true;
  await f.service.execute({ ...p, previewId: preview.id });
  f.writers.box.unreadable = true;
  const restarted = f.createService();
  const resume = {
    action: "resume",
    operationId: p.operationId,
    explicitWriteApproval: true,
  };
  assert.equal((await restarted.execute(resume)).status, "partial");
  assert.equal(f.writers.box.writes, 1);
  f.writers.box.unreadable = false;
  assert.equal((await restarted.execute(resume)).status, "verified");
  assert.equal(f.writers.box.writes, 1);
});

test("single department supply creates no empty job in the other department", async () => {
  const f = fixture(),
    p = payload();
  p.lines = [p.lines[1]];
  const preview = await f.service.preview(p);
  const result = await f.service.execute({ ...p, previewId: preview.id });
  assert.equal(result.status, "verified");
  assert.equal(f.writers.roll.writes, 0);
  assert.equal(f.writers.box.writes, 1);
  assert.equal(f.store.meta("productionSupplies")[0].parts.length, 1);
});

test("append from box targets the same common supply and keeps the other department's articles unchanged", async () => {
  const f = fixture(),
    p = payload(),
    preview = await f.service.preview(p);
  await f.service.execute({ ...p, previewId: preview.id });
  const supply = f.store.meta("productionSupplies")[0],
    box = supply.parts.find((p) => p.department === "box");
  const updatedCatalog = structuredClone(catalog);
  updatedCatalog.WB.push(["BOX2", ...Array(11).fill(""), "DTF"]);
  f.service.catalog = async () => updatedCatalog;
  const append = {
    ...p,
    operationId: randomUUID(),
    action: "append",
    department: "box",
    sheetId: box.sheetId,
    lines: [{ article: "BOX2", quantity: 4 }],
  };
  const checked = await f.service.preview(append);
  const result = await f.service.execute({ ...append, previewId: checked.id });
  assert.equal(result.status, "verified", JSON.stringify(result));
  assert.equal(f.writers.roll.writes, 1);
  assert.equal(f.writers.box.writes, 2);
  assert.deepEqual([...f.writers.roll.sheets.values()][0].lines, [p.lines[0]]);
  assert.equal(f.store.meta("productionSupplies").length, 1);
  assert.equal(f.store.meta("productionSupplies")[0].id, supply.id);
});

test("a repeated article already present in another department is rejected before append", async () => {
  const f = fixture(),
    p = payload(),
    preview = await f.service.preview(p);
  await f.service.execute({ ...p, previewId: preview.id });
  const supply = f.store.meta("productionSupplies")[0];
  const append = {
    ...p,
    operationId: randomUUID(),
    action: "append",
    department: "box",
    sheetId: supply.parts.find((p) => p.department === "box").sheetId,
    lines: [p.lines[0]],
  };
  const checked = await f.service.preview(append);
  await assert.rejects(
    () => f.service.execute({ ...append, previewId: checked.id }),
    /уже есть в одном из отделов/,
  );
  assert.equal(f.writers.roll.writes, 1);
  assert.equal(f.writers.box.writes, 1);
});
