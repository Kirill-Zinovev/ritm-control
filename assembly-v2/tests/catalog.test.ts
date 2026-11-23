import { validateLabelPrint } from "../src/label-print";
import { catalogDetail, resolveCatalogPositions } from "../server/catalog-store";
import { labelsApi } from "../server/labels-api";
import type { ManagedProduct } from "../shared/catalog-editor";
import { bootstrap } from "./fixtures";
import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { openDatabase } from "../server/local-db";
import { createDatabase } from "../server/database";
import { catalogApi, type FileStore } from "../server/catalog-api";
import { api } from "../server/api";
import {
  capacity,
  catalogKey,
  catalogVersion,
  digest,
  photoAllowed,
} from "../shared/catalog";
import type {
  CatalogEntry,
  CatalogManifest,
  CatalogPhoto,
  CatalogBundle,
} from "../shared/catalog";
import { cellText, parseCatalog } from "../shared/catalog-excel";
import type { Snapshot, SupplyImport } from "../shared/model";
import { fixture } from "./fixtures";

const fakeFiles = (): FileStore => {
  const files = new Map<
    string,
    { body: Uint8Array<ArrayBuffer>; contentType: string }
  >();
  return {
    async get(key) {
      return files.get(key) ?? null;
    },
    async put(key, body, contentType) {
      files.set(key, { body: new Uint8Array(body), contentType });
    },
  };
};
const entry = (
  market: "WB" | "OZON" = "OZON",
  store = "1",
  norm: number | null = 100,
): CatalogEntry => ({
  id: JSON.stringify([market, store, "SKU-A"]),
  market,
  store,
  sku: "SKU-A",
  aliases: ["SKU-A", "EXPLICIT-ALIAS"],
  name: "Тестовый товар",
  barcode: "0012345678901",
  kind: "Наклейки",
  category: "Наклейки",
  machine: "2-GO",
  packaging: "П.17х22",
  size: "A5",
  sheetsPerUnit: "1",
  printFolder: "Порезка",
  catalogDepartment: "Красное здание",
  boxType: "М",
  unitsPerBox: norm,
  rollMultiplicity: "15",
  xeroxMultiplicity: "",
  capacitySource: norm ? "consistent" : "review",
  photoId: null,
  issues: norm ? [] : ["Вместимость короба требует проверки"],
  rows: [
    {
      sheet: market,
      row: 2,
      raw: { article: "SKU-A", store },
      refs: { article: `${market}!A2` },
    },
  ],
});
async function bundle(
  entries: CatalogEntry[],
  photos: CatalogPhoto[] = [],
): Promise<CatalogBundle> {
  const chunks: CatalogBundle["chunks"] = [];
  for (const [kind, data] of [
    ["entries", entries],
    ["photos", photos],
  ] as const) {
    if (!data.length) continue;
    const json = JSON.stringify(data);
    chunks.push({
      meta: { kind, part: 0, count: data.length, digest: await digest(json) },
      data: json,
    });
  }
  const bytes = new TextEncoder().encode("test-source");
  const manifest: CatalogManifest = {
    version: catalogVersion,
    sources: await Promise.all(
      (["base", "photos"] as const).map(async (role) => ({
        role,
        name: `${role}.xlsx`,
        bytes: bytes.length,
        sha256: await digest(bytes),
      })),
    ),
    entries: entries.length,
    photos: photos.length,
    sourceRows: entries.length,
    capacityConflicts: 0,
    userCorrections: 0,
    chunks: chunks.map((c) => c.meta),
    decision: "fixture",
  };
  return { id: await digest(JSON.stringify(manifest)), manifest, chunks };
}
async function context() {
  const db = await openDatabase();
  const files = fakeFiles();
  const call = async (path: string, body?: unknown) => {
    const response = await catalogApi(
      new Request(`https://assembly.test/api/catalog${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers:
          body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      db.store,
      db,
      "owner",
      files,
    );
    return {
      status: response.status,
      value: (await response.json()) as Record<string, unknown>,
    };
  };
  const upload = async (b: CatalogBundle, activate = true) => {
    assert.equal(
      (await call("/import/start", { id: b.id, manifest: b.manifest })).status,
      200,
    );
    for (const source of b.manifest.sources) {
      const r = await catalogApi(
        new Request(
          `https://assembly.test/api/catalog/source?import=${b.id}&role=${source.role}`,
          { method: "POST", body: "test-source" },
        ),
        db.store,
        db,
        "owner",
        files,
      );
      assert.equal(r.status, 200);
    }
    for (const c of b.chunks)
      assert.equal(
        (await call("/import/chunk", { id: b.id, ...c.meta, data: c.data }))
          .status,
        200,
      );
    if (activate)
      assert.equal((await call("/import/activate", { id: b.id })).status, 200);
  };
  return { db, call, files, upload };
}

test("suggests exact article families and finds templates beyond the first page", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const card = (sku: string, market: "WB"|"OZON" = "OZON", store = "1"): CatalogEntry => ({
    ...entry(market,store), id:JSON.stringify([market,store,sku]), sku, aliases:[sku],
  });
  const target = card("CT0001.A7431");
  const source = card("CT0001.A5589");
  const distant = card("CT0001.Z9999","WB","2");
  const wrongFamily = card("CT00010.A5589");
  const entries = [source,target,distant,wrongFamily,
    ...Array.from({length:31},(_,i)=>card(`CT0001.P${String(i).padStart(2,"0")}`))];
  await c.upload(await bundle(entries));
  const query = "/fill?market=OZON&store=1&family=1&sku=ct0001.a7431";
  const first = await c.call(query);
  assert.equal(first.status,200);
  assert.equal(first.value.hasMore,true);
  const rows = first.value.cards as {sku:string;id:string;barcode?:string}[];
  assert.equal(rows[0].id,source.id);
  assert.equal(rows.length,30);
  assert.ok(rows.every(row=>row.sku.startsWith("CT0001.") && row.sku!==target.sku && row.barcode===undefined));
  const filtered = await c.call(query + "&q=z9999");
  assert.equal(filtered.value.hasMore,false);
  assert.deepEqual((filtered.value.cards as {id:string}[]).map(row=>row.id),[distant.id]);
  const exact = await c.call(query.replace("&family=1",""));
  assert.deepEqual((exact.value.cards as {id:string}[]).map(row=>row.id),[target.id]);
});

test("вместимость: конфликт остаётся null; подтверждение 700 относится только к конкретному OZON", () => {
  const raw = {
    article: "SS0031.A7484(OZ)",
    store: "1",
    unitsPerBoxNumber: "700",
    unitsPerBoxText: "550 М",
    boxType: "М",
  };
  assert.deepEqual(capacity(raw, "OZON"), {
    value: 700,
    source: "user",
    conflict: false,
  });
  assert.equal(capacity(raw, "WB").value, null);
  assert.equal(capacity({ ...raw, store: "2" }, "OZON").value, null);
  assert.equal(capacity({ ...raw, article: "OTHER" }, "OZON").value, null);
  assert.equal(
    capacity({ ...raw, article: "OTHER", unitsPerBoxText: "700М" }, "OZON")
      .value,
    700,
  );
});
test("Excel cached values, identifiers and safe photo domains", () => {
  assert.equal(cellText(2.037267056639e12), "2037267056639");
  assert.equal(cellText("0012345"), "0012345");
  assert.equal(cellText({ formula: "UNKNOWN()", result: 700 }), "700");
  assert.equal(cellText({ error: "#N/A" }), "#N/A");
  assert.equal(
    photoAllowed(
      "https://basket-23.wbbasket.ru/vol4099/part409941/409941190/images/big/1.webp",
    ),
    true,
  );
  for (const url of [
    "http://basket-1.wbbasket.ru/vol1/part1/1/images/1.webp",
    "https://basket-1.wbbasket.ru.evil.test/vol1/part1/1/images/1.webp",
    "https://127.0.0.1/1.png",
    "https://basket-1.wbbasket.ru/private",
  ])
    assert.equal(photoAllowed(url), false);
});
test("полный Excel parser различает два столбца Артикул и сохраняет дубликаты и ошибки", async () => {
  const base = new ExcelJS.Workbook();
  for (const market of ["WB", "OZON"] as const) {
    const s = base.addWorksheet(market);
    s.addRow(
      market === "WB"
        ? [
            "Артикул",
            "Артикул (oz)",
            "Баркод",
            "Баркод (OZ)",
            "Название",
            "Вид",
            "Вид товара",
            "Папка печати",
            "Кто печатает",
            "Кол-во листов",
            "Размер",
            "Упаковка",
            "Вид станка по умолчанию",
            "Тип короба",
            "Кол-во вида",
            "В коробке",
            "Кратность рулонная",
            "Кратность Xerox",
            "фото",
            "магазин",
          ]
        : [
            "Артикул",
            "Артикул",
            "Наименование",
            "Баркод",
            "Вид",
            "Кол-во листов",
            "Размер",
            "Упаковка",
            "Вид товара",
            "Папка печати",
            "Тип короба",
            "Кол-во вида",
            "В коробке",
            "фото",
            "станок",
            "магазин",
            "Кратность рулонная",
            "Кратность Xerox",
          ],
    );
    if (market === "WB") {
      s.addRow([
        "WB-A",
        "OZ-A",
        "001234",
        "",
        "#N/A",
        "Наклейки",
        "Наклейки",
        "Порезка",
        "Цех",
        1,
        "A5",
        "П.17х22",
        "2-GO",
        "М",
        100,
        "100 М",
        15,
        "",
        "",
        "1",
      ]);
      s.addRow([
        "WB-A",
        "OZ-A",
        "001234",
        "",
        "#N/A",
        "Наклейки",
        "Наклейки",
        "Порезка",
        "Цех",
        1,
        "A5",
        "П.17х22",
        "2-GO",
        "М",
        200,
        "200 М",
        15,
        "",
        "",
        "1",
      ]);
    } else
      s.addRow([
        "OZ-A",
        "WB-A",
        "Товар",
        "OZN123",
        "Наклейки",
        1,
        "A5",
        "П.17х22",
        "Наклейки",
        "Порезка",
        "М",
        300,
        "300 М",
        "",
        "2-GO",
        "1",
        15,
        "",
      ]);
  }
  const pictures = new ExcelJS.Workbook();
  const p = pictures.addWorksheet("Фото");
  p.addRow(["Артикул", "Магазин", "Ссылки на фото", "ссылка"]);
  const image = "https://basket-1.wbbasket.ru/vol1/part1/1/images/big/1.webp";
  p.addRow(["WB-A", 1, image, image]);
  const parsed = await parseCatalog(
    { name: "base.xlsx", bytes: new Uint8Array(await base.xlsx.writeBuffer()) },
    {
      name: "photos.xlsx",
      bytes: new Uint8Array(await pictures.xlsx.writeBuffer()),
    },
  );
  const entries = parsed.chunks
    .filter((c) => c.meta.kind === "entries")
    .flatMap((c) => JSON.parse(c.data)) as CatalogEntry[];
  assert.equal(entries.length, 2);
  const wb = entries.find((e) => e.market === "WB")!;
  const oz = entries.find((e) => e.market === "OZON")!;
  assert.equal(wb.rows.length, 2);
  assert.equal(wb.unitsPerBox, null);
  assert.equal(wb.name, "");
  assert.equal(wb.barcode, "001234");
  assert.equal(oz.unitsPerBox, 300);
  assert.ok(oz.photoId);
  assert.ok(oz.aliases.includes("WB-A"));
});
test("пакеты повторяемы, повреждённый пакет отклоняется, включение только полного импорта", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const b = await bundle([entry()]);
  await c.upload(b, false);
  const chunk = b.chunks[0];
  assert.equal(
    (
      await c.call("/import/chunk", {
        id: b.id,
        ...chunk.meta,
        data: chunk.data,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await c.call("/import/chunk", {
        id: b.id,
        ...chunk.meta,
        data: chunk.data + " ",
      })
    ).status,
    409,
  );
  assert.equal((await c.call("")).value.total, 0);
  assert.equal((await c.call("/import/activate", { id: b.id })).status, 200);
  assert.equal((await c.call("")).value.total, 1);
  const rev = await c.db.revision();
  await c.call("/import/activate", { id: b.id });
  assert.equal(await c.db.revision(), rev);
  const incomplete = await bundle([entry("WB")]);
  await c.call("/import/start", {
    id: incomplete.id,
    manifest: incomplete.manifest,
  });
  assert.equal(
    (await c.call("/import/activate", { id: incomplete.id })).status,
    409,
  );
  assert.equal((await c.call("")).value.total, 1);
});
test("рынок и магазин изолированы; старая версия RITM и нормы вложений неизменны после обновления каталога", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const photo: CatalogPhoto = {
    id: '["SKU-A","1"]',
    sku: "SKU-A",
    store: "1",
    primary: "https://basket-1.wbbasket.ru/vol1/part1/1/images/big/1.webp",
    urls: ["https://basket-1.wbbasket.ru/vol1/part1/1/images/big/1.webp"],
    sources: [],
  };
  const first = await bundle(
    [
      { ...entry(), photoId: photo.id },
      entry("WB", "1", 200),
      entry("OZON", "2", 300),
    ],
    [photo],
  );
  await c.upload(first);
  const source: SupplyImport = {
    ...fixture,
    externalId: "TEST-CATALOG-SUPPLY",
    store: "1",
    positions: [
      {
        ...fixture.positions[0],
        externalId: "TEST-CATALOG-POS",
        sku: "EXPLICIT-ALIAS",
        unitsPerBox: null,
      },
    ],
  };
  const cmd = (action: string, payload: Record<string, unknown>) =>
    c.db.command(action, payload, crypto.randomUUID(), "owner");
  await cmd("supply.import", source as unknown as Record<string, unknown>);
  await cmd("employee.create", { name: "Тест: Сборщик" });
  const snapshot = () => c.db.snapshot(null) as Promise<Snapshot>;
  let s = await snapshot();
  const p = s.positions[0];
  assert.equal(p.unitsPerBox, 100);
  assert.equal(p.department, source.positions[0].department);
  assert.equal(p.barcode, source.positions[0].barcode);
  assert.equal(p.catalog?.kind, "Наклейки");
  assert.equal(p.catalog?.photoId, photo.id);
  const carton = String(
    (await cmd("carton.create", { supplyId: s.selectedSupplyId })).cartonId,
  );
  await cmd("work.save", {
    positionId: p.id,
    employeeId: s.employees[0].id,
    operation: "packing",
    qty: 10,
    cartonId: carton,
  });
  const beforeCatalogChange = await snapshot();
  assert.equal(
    beforeCatalogChange.cartons[0].items[0].catalogImportId,
    first.id,
  );
  assert.equal(
    beforeCatalogChange.cartons[0].items[0].photoId,
    p.catalog?.photoId,
  );
  await c.upload(await bundle([entry("OZON", "1", 400)]));
  await cmd("supply.import", source as unknown as Record<string, unknown>);
  s = await snapshot();
  assert.equal(s.positions[0].id, p.id);
  assert.equal(s.positions[0].unitsPerBox, 100);
  assert.equal(s.positions[0].catalogImportId, first.id);
  assert.equal(s.cartons[0].items[0].unitsPerBox, 100);
  assert.equal(s.cartons[0].fill, 0.1);
  assert.equal(s.cartons[0].items[0].photoId, p.catalog?.photoId);
  // A new supply obtains the new version; source IDs, barcode and department remain authoritative.
  await cmd("supply.import", {
    ...source,
    externalId: "TEST-CATALOG-SUPPLY-2",
  });
  s = await snapshot();
  assert.equal(s.positions[0].unitsPerBox, 400);
  assert.equal(catalogKey(" explicit-alias "), "EXPLICIT-ALIAS");
});
test("неоднозначный alias не выбирает первую карточку, спорная норма не запрещает запись работы", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const a = entry("OZON", "1", null);
  const b = {
    ...entry(),
    id: JSON.stringify(["OZON", "1", "SKU-B"]),
    sku: "SKU-B",
    aliases: ["SKU-B", "EXPLICIT-ALIAS"],
  };
  await c.upload(await bundle([a, b]));
  const supply = {
    ...fixture,
    externalId: "TEST-CONFLICT",
    store: "1",
    positions: [
      {
        ...fixture.positions[0],
        externalId: "TEST-1",
        sku: "SKU-A",
        unitsPerBox: 700,
      },
      {
        ...fixture.positions[1],
        externalId: "TEST-2",
        sku: "EXPLICIT-ALIAS",
        unitsPerBox: null,
      },
    ],
  };
  const cmd = (action: string, payload: Record<string, unknown>) =>
    c.db.command(action, payload, crypto.randomUUID(), "owner");
  await cmd("supply.import", supply);
  await cmd("employee.create", { name: "Тест: Имя" });
  const s = (await c.db.snapshot(null)) as Snapshot;
  assert.ok(s.positions.every((p) => p.unitsPerBox === null));
  assert.equal(
    s.positions.find((p) => p.sku === "EXPLICIT-ALIAS")!.catalogImportId,
    null,
  );
  const p = s.positions.find((p) => p.sku === "SKU-A")!;
  await cmd("work.save", {
    positionId: p.id,
    employeeId: s.employees[0].id,
    operation: "packing",
    qty: 1,
  });
  const carton = String(
    (await cmd("carton.create", { supplyId: s.selectedSupplyId })).cartonId,
  );
  await assert.rejects(
    cmd("allocation.add", { positionId: p.id, cartonId: carton, qty: 1 }),
    /норм/,
  );
});
test("фотографии: только сохранённые CDN-ссылки; кэш ограничен; чужой origin и нет доступа отклоняются", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const url = "https://basket-1.wbbasket.ru/vol1/part1/1/images/big/1.webp";
  const photo: CatalogPhoto = {
    id: '["SKU-A","1"]',
    sku: "SKU-A",
    store: "1",
    primary: url,
    urls: [url],
    sources: [],
  };
  await c.upload(await bundle([{ ...entry(), photoId: photo.id }], [photo]));
  let fetches = 0;
  const remote = (async (input: RequestInfo | URL) => {
    assert.equal(input, url);
    fetches++;
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "image/webp" },
    });
  }) as typeof fetch;
  const active = (await c.call("")).value.active as { id: string };
  const request = () =>
    new Request(
      `https://assembly.test/api/catalog/photo?import=${active.id}&id=${encodeURIComponent(photo.id)}`,
    );
  assert.equal(
    (await catalogApi(request(), c.db.store, c.db, "owner", c.files, remote))
      .status,
    200,
  );
  assert.equal(
    (await catalogApi(request(), c.db.store, c.db, "owner", c.files, remote))
      .status,
    200,
  );
  assert.equal(fetches, 1);
  c.db.sqlite.exec(
    "with recursive n(x) as (select 1 union all select x+1 from n where x<255) insert into av2_photo_cache(id) select 'test-slot-'||x from n",
  );
  assert.equal(
    c.db.sqlite.prepare("select count(*) n from av2_photo_cache").get()!.n,
    256,
  );
  const another: CatalogPhoto = {
    ...photo,
    id: '["SKU-B","1"]',
    sku: "SKU-B",
    primary: url.replace("1.webp", "2.webp"),
    urls: [url.replace("1.webp", "2.webp")],
  };
  const newer = await bundle([{ ...entry(), photoId: another.id }], [another]);
  await c.upload(newer);
  const newRequest = () =>
    new Request(
      `https://assembly.test/api/catalog/photo?import=${newer.id}&id=${encodeURIComponent(another.id)}`,
    );
  let uncachedFetches = 0;
  const uncachedRemote = (async () => {
    uncachedFetches++;
    return new Response(new Uint8Array([1]), {
      headers: { "Content-Type": "image/webp" },
    });
  }) as typeof fetch;
  await catalogApi(
    newRequest(),
    c.db.store,
    c.db,
    "owner",
    c.files,
    uncachedRemote,
  );
  await catalogApi(
    newRequest(),
    c.db.store,
    c.db,
    "owner",
    c.files,
    uncachedRemote,
  );
  assert.equal(uncachedFetches, 2);
  assert.equal(
    c.db.sqlite.prepare("select count(*) n from av2_photo_cache").get()!.n,
    256,
  );
  assert.equal(
    (await catalogApi(request(), c.db.store, c.db, "", c.files, remote)).status,
    401,
  );
  const origin = await catalogApi(
    new Request("https://assembly.test/api/catalog/import/start", {
      method: "POST",
      headers: { Origin: "https://evil.test" },
    }),
    c.db.store,
    c.db,
    "owner",
    c.files,
  );
  assert.equal(origin.status, 403);
  const fallback = await catalogApi(
    newRequest(),
    c.db.store,
    c.db,
    "owner",
    c.files,
    (async () => {
      throw new Error("Source rejects datacenter requests");
    }) as typeof fetch,
  );
  assert.equal(fallback.status, 302);
  assert.equal(fallback.headers.get("location"), another.primary);
  assert.equal(fallback.headers.get("referrer-policy"), "no-referrer");
});

test("смена каталога между чтением и импортом поставки повторяет план на новой ревизии", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  await c.upload(await bundle([entry()]));
  const newer = await bundle([entry("OZON", "1", 400)]);
  await c.upload(newer, false);
  let race = true;
  const db = createDatabase({
    ...c.db.store,
    async batch(statements) {
      if (
        race &&
        statements.some((s) => s.sql.includes("insert into av2_positions"))
      ) {
        race = false;
        assert.equal(
          (await c.call("/import/activate", { id: newer.id })).status,
          200,
        );
      }
      return c.db.store.batch(statements);
    },
  });
  const supply: SupplyImport = {
    ...fixture,
    externalId: "TEST-RACE-CATALOG",
    store: "1",
    positions: [
      {
        ...fixture.positions[0],
        externalId: "TEST-POS",
        sku: "SKU-A",
        unitsPerBox: null,
      },
    ],
  };
  await db.command(
    "supply.import",
    supply as unknown as Record<string, unknown>,
    crypto.randomUUID(),
    "owner",
  );
  const state = (await db.snapshot(null)) as Snapshot;
  assert.equal(state.positions[0].unitsPerBox, 400);
  assert.equal(state.positions[0].catalogImportId, newer.id);
});
test("предыдущую версию каталога можно восстановить без изменения истории поставки", async (t) => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const a = await bundle([entry()]),
    b = await bundle([entry("OZON", "1", 200)]);
  await c.upload(a);
  await c.upload(b);
  await c.upload(a);
  assert.equal(((await c.call("")).value.active as { id: string }).id, a.id);
  await c.upload(b);
  assert.equal(((await c.call("")).value.active as { id: string }).id, b.id);
});


test("редактор: обновляет сборку, сохраняет выработку, исходный Excel и правки после нового импорта", async t => {
  const c=await context();t.after(()=>c.db.sqlite.close());
  const original=entry(),first=await bundle([original]);await c.upload(first);
  const f=await bootstrap(c.db);
  c.db.sqlite.prepare("update av2_positions set sku=?,catalog_import_id=?,catalog_entry_id=? where id=?").run(original.sku,first.id,original.id,f.a.id);
  const save=(product:ManagedProduct,revision:number,create=false,key=crypto.randomUUID(),importId=first.id)=>c.db.command('catalog.save',{id:create?null:product.id,create,revision,importId,product},key,'owner');
  await save({...original,workNorms:{packing:100,cut:200,assembly:150}},0);
  await f.cmd('work.save',{positionId:f.a.id,employeeId:f.employee.id,operation:'packing',qty:10});
  await f.cmd('allocation.add',{positionId:f.a.id,qty:10,newCarton:true});
  const workBefore=c.db.sqlite.prepare('select * from av2_work').all();
  const d=await catalogDetail(c.db.store,first.id,original.id) as ManagedProduct;
  const edited={...d,name:'Новое название',barcode:'00009999',unitsPerBox:200,workNorms:{packing:200,cut:300,assembly:150}};
  const key=crypto.randomUUID();await save(edited,1,false,key);await save(edited,1,false,key);
  assert.deepEqual(c.db.sqlite.prepare('select * from av2_work').all(),workBefore);
  assert.equal(c.db.sqlite.prepare('select name from av2_positions where id=?').get(f.a.id)!.name,'Новое название');
  assert.equal(c.db.sqlite.prepare('select units_per_box from av2_allocations').get()!.units_per_box,200);
  assert.equal(JSON.parse(String(c.db.sqlite.prepare('select data from av2_catalog_entries where entry_id=?').get(original.id)!.data)).name,original.name);
  await assert.rejects(save({...edited,name:'Устаревшее окно'},1),/другом окне/);
  await f.cmd('work.save',{positionId:f.a.id,employeeId:f.employee.id,operation:'packing',qty:10});
  const works=c.db.sqlite.prepare('select qty,coefficient from av2_work order by rowid').all();assert.equal(works[0].coefficient,'0.1');assert.equal(works[1].coefficient,'0.05');
  const fresh={...entry('WB','2'),sku:'NEW-001',id:JSON.stringify(['WB','2','NEW-001']),aliases:['NEW-001']};
  await save(fresh,0,true);
  await assert.rejects(save(fresh,0,true),/уже есть/);
  const second=await bundle([{...original,name:'Поздний Excel'}]);await c.upload(second);
  assert.equal((await catalogDetail(c.db.store,second.id,original.id))!.name,'Новое название');
  assert.equal((await catalogDetail(c.db.store,first.id,fresh.id))!.name,fresh.name,'Old position links remain valid for managed-only products');
  assert.equal((await catalogDetail(c.db.store,second.id,fresh.id))!.sku,'NEW-001');
  const found=await resolveCatalogPositions(c.db.store,{...fixture,market:'WB',store:'2',positions:[{...fixture.positions[0],sku:'NEW-001'}]});assert.equal(found.get('NEW-001')?.entry.name,fresh.name);
  assert.equal(c.db.sqlite.prepare("select count(*) n from av2_quality_repairs where kind='catalog.edit'").get()!.n,3);
});

test("редактор: фото и этикетка сохраняются, доступны из поставки и склада; неверные данные не меняют базу",async t=>{
  const c=await context();t.after(()=>c.db.sqlite.close());const e=entry(),b=await bundle([e]);await c.upload(b);const f=await bootstrap(c.db);
  c.db.sqlite.prepare('update av2_positions set sku=?,catalog_import_id=?,catalog_entry_id=? where id=?').run(e.sku,b.id,e.id,f.a.id);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNTcAAAAASUVORK5CYII=','base64');
  const upload=await catalogApi(new Request('https://assembly.test/api/catalog/media',{method:'POST',body:png}),c.db.store,c.db,'owner',c.files);
  assert.equal(upload.status,200);const media=await upload.json() as {sha256:string;url:string};
  const product={...e,photoUrl:media.url,labelSha:media.sha256};
  const save=(p:ManagedProduct)=>c.db.command('catalog.save',{id:e.id,create:false,revision:0,importId:b.id,product:p},crypto.randomUUID(),'owner');
  for(const p of [{...product,unitsPerBox:-1},{...product,photoUrl:'http://localhost/x'},{...product,labelSha:'a'.repeat(64)},{...product,workNorms:{cut:-10}}])await assert.rejects(save(p));
  assert.equal(c.db.sqlite.prepare('select count(*) n from av2_catalog_products').get()!.n,0);
  await save(product);
  const image=await catalogApi(new Request('https://assembly.test'+media.url),c.db.store,c.db,'owner',c.files);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  const label=await labelsApi(new Request('https://assembly.test/api/labels?position='+f.a.id),c.db.store,c.files,'collector','worker');
  assert.equal(label.status,200);const printed=(await label.json() as {items:import('../shared/labels').PrintableLabel[]}).items[0];assert.equal(printed.imageUrl,media.url);validateLabelPrint([{label:printed,copies:2}],'https://assembly.test');
  await f.cmd('warehouse.receive',{catalogImportId:b.id,entryId:e.id,market:'OZON',store:'1',sku:e.sku,qty:5,employeeId:f.employee.id});
  const receipt=c.db.sqlite.prepare('select id from av2_warehouse_receipts').get()!.id;
  const stockLabel=await labelsApi(new Request('https://assembly.test/api/labels?receipt='+receipt),c.db.store,c.files,'collector','worker');assert.equal((await stockLabel.json() as {items:{imageUrl:string}[]}).items[0].imageUrl,media.url);
});

test('менеджер назначает пустой магазин без дублей, а новый импорт сохраняет назначение', async t => {
  const c = await context();
  t.after(() => c.db.sqlite.close());
  const missing = { ...entry('OZON', ''), name: '', issues: ['Не заполнено поле: store', 'Не заполнено поле: name'] };
  const otherStore = entry('OZON', '2');
  const first = await bundle([missing, otherStore]);
  await c.upload(first);

  const f = await bootstrap(c.db);
  c.db.sqlite.prepare('update av2_positions set sku=?,catalog_import_id=?,catalog_entry_id=? where id=?')
    .run(missing.sku, first.id, missing.id, f.a.id);
  await f.cmd('work.save', { positionId: f.a.id, employeeId: f.employee.id, operation: 'packing', qty: 8 });
  const work = c.db.sqlite.prepare('select * from av2_work').all();
  const send = (product: CatalogEntry, role: 'owner' | 'manager' | 'collector', id = missing.id, revision = 0) => api(
    new Request('https://assembly.test/api/command', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'catalog.save', key: crypto.randomUUID(), payload: {
        id, create: false, revision, importId: first.id, product,
      } }),
    }), c.db, role, role,
  );
  assert.equal((await send({ ...missing, store: '1' }, 'collector')).status, 403);
  assert.equal((await send({ ...missing, store: '3' }, 'manager')).status, 409);
  assert.equal((await send({ ...missing, store: '2' }, 'manager')).status, 409);
  assert.equal((await send({ ...otherStore, store: '1' }, 'owner', otherStore.id)).status, 409);
  assert.equal((await c.call('?store=2')).value.total, 1);
  assert.ok(await catalogDetail(c.db.store, first.id, missing.id));

  const response = await send({ ...missing, store: '1' }, 'manager');
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  const assignedId = entry().id;
  const assigned = await catalogDetail(c.db.store, first.id, assignedId);
  assert.equal(assigned?.store, '1');
  assert.deepEqual(assigned?.rows, missing.rows);
  assert.deepEqual(assigned?.issues, ['Не заполнено поле: name']);
  assert.equal(await catalogDetail(c.db.store, first.id, missing.id), null);
  assert.equal(c.db.sqlite.prepare('select catalog_entry_id from av2_positions where id=?').get(f.a.id)?.catalog_entry_id, assignedId);
  assert.deepEqual(c.db.sqlite.prepare('select * from av2_work').all(), work);
  const history = await c.call(`/history?id=${encodeURIComponent(assignedId)}`);
  const [change] = history.value.items as { before: CatalogEntry; after: CatalogEntry }[];
  assert.equal(change.before.store, '');
  assert.equal(change.after.store, '1');

  const second = await bundle([{ ...missing, name: 'Следующий импорт' }, otherStore]);
  await c.upload(second);
  assert.equal(await catalogDetail(c.db.store, second.id, missing.id), null);
  assert.equal((await c.call('?q=SKU-A')).value.total, 2);
  assert.equal((await c.call('?store=1')).value.total, 1);
  const found = await resolveCatalogPositions(c.db.store, {
    ...fixture, positions: [{ ...fixture.positions[0], sku: 'SKU-A' }],
  });
  assert.equal(found.get('SKU-A')?.entry.id, assignedId);
});
