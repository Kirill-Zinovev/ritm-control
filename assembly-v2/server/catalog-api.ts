import { labelMime } from "../shared/labels";
import { json, type Database } from "./api";
import type { SqlStore, Statement } from "./database";
import { catalogFamilyKey, type CatalogFamilyCard, type CatalogFamilyMatches } from "../shared/catalog-editor";
import {
  catalogDetail,
  catalogList,
  importManifest,
  requireCatalog as check,
} from "./catalog-store";
import {
  catalogKey,
  catalogVersion,
  digest,
  photoAllowed,
} from "../shared/catalog";
import type {
  CatalogEntry,
  CatalogManifest,
  CatalogPhoto,
} from "../shared/catalog";

export interface FileObject {
  body: BodyInit;
  contentType: string;
}
export interface FileStore {
  get(key: string): Promise<FileObject | null>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}
const q = (sql: string, ...args: (string | number | null)[]): Statement => ({
  sql,
  args,
});
export async function boundedBody(
  request: Pick<Request, "body" | "headers">,
  limit: number,
): Promise<Uint8Array> {
  check(
    Number(request.headers.get("content-length") ?? 0) <= limit,
    "Файл слишком большой.",
  );
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.length;
      check(bytes <= limit, "Файл слишком большой.");
      parts.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
const sourceKey = (id: string, role: string) =>
  `catalog/sources/${id}/${role}.xlsx`;
function validEntry(e: CatalogEntry) {
  check(
    e &&
      (e.market === "WB" || e.market === "OZON") &&
      typeof e.id === "string" &&
      typeof e.sku === "string" &&
      typeof e.store === "string" &&
      e.id === JSON.stringify([e.market, e.store, catalogKey(e.sku)]),
    "Неверный ключ артикула.",
  );
  for (const k of [
    "name",
    "barcode",
    "kind",
    "category",
    "machine",
    "packaging",
    "size",
    "sheetsPerUnit",
    "printFolder",
    "catalogDepartment",
    "boxType",
    "rollMultiplicity",
    "xeroxMultiplicity",
  ] as const)
    check(
      typeof e[k] === "string" && e[k].length <= 4000,
      "Неверные поля карточки.",
    );
  check(
    Array.isArray(e.aliases) &&
      e.aliases.length <= 100 &&
      e.aliases.every(
        (a) => typeof a === "string" && a === catalogKey(a) && a.length <= 300,
      ) &&
      e.aliases.includes(catalogKey(e.sku)),
    "Неверные алиасы артикула.",
  );
  check(
    Array.isArray(e.rows) &&
      e.rows.length > 0 &&
      e.rows.length <= 100 &&
      e.rows.every(
        (r) =>
          r.sheet === e.market &&
          Number.isSafeInteger(r.row) &&
          r.row > 1 &&
          r.raw &&
          r.refs &&
          Object.values(r.raw).every((v) => typeof v === "string") &&
          Object.values(r.refs).every((v) => typeof v === "string"),
      ),
    "У карточки отсутствуют исходные строки.",
  );
  check(
    e.unitsPerBox === null ||
      (Number.isSafeInteger(e.unitsPerBox) && e.unitsPerBox > 0),
    "Неверная вместимость короба.",
  );
  check(
    ["consistent", "user", "review"].includes(e.capacitySource) &&
      (e.capacitySource === "review") === (e.unitsPerBox === null) &&
      Array.isArray(e.issues) &&
      e.issues.every((i) => typeof i === "string"),
    "Проверьте статус карточки.",
  );
  check(
    e.photoId === null || typeof e.photoId === "string",
    "Неверная ссылка на фотографию.",
  );
}
function validPhoto(p: CatalogPhoto) {
  check(
    p &&
      typeof p.sku === "string" &&
      typeof p.store === "string" &&
      p.id === JSON.stringify([catalogKey(p.sku), p.store]) &&
      Array.isArray(p.urls) &&
      p.urls.length <= 300 &&
      p.urls.every(photoAllowed) &&
      (!p.primary || photoAllowed(p.primary)) &&
      Array.isArray(p.sources),
    "Неверная запись фотографии.",
  );
}
export async function catalogApi(
  request: Request,
  store: SqlStore,
  db: Database,
  actor: string,
  files?: FileStore,
  remoteFetch: typeof fetch = fetch,
): Promise<Response> {
  if (!actor) return json({ error: "Войдите в RITM Сборка." }, 401);
  const url = new URL(request.url);
  if (
    request.method !== "GET" &&
    request.headers.get("origin") &&
    request.headers.get("origin") !== url.origin
  )
    return json({ error: "Недопустимый источник запроса." }, 403);
  try {
    if (url.pathname === "/api/catalog/media") {
      check(files, "Хранилище файлов недоступно.");
      if (request.method === "POST") {
        const bytes = await boundedBody(request, 8 * 1024 * 1024), mime = labelMime(bytes);
        check(mime && bytes.length > 12, "Загрузите изображение PNG, JPG или WebP.");
        const sha = await digest(bytes);
        await files.put(`catalog/media/${sha}`, bytes, mime);
        await store.batch([q("insert into av2_catalog_media(sha256,mime_type,bytes,created_at) values(?,?,?,?) on conflict(sha256) do nothing",sha,mime,bytes.length,new Date().toISOString())]);
        return json({sha256:sha,url:`/api/catalog/media?sha256=${sha}`,bytes:bytes.length});
      }
      check(request.method === "GET", "Недопустимый запрос.");
      const sha = url.searchParams.get("sha256") || "";
      check(/^[a-f0-9]{64}$/.test(sha), "Файл не найден.");
      const [row] = await store.all<{mimeType:string}>("select mime_type from av2_catalog_media where sha256=?",[sha]);
      const file = row ? await files.get(`catalog/media/${sha}`) : null;
      if (!file) return json({error:"Файл не найден."},404);
      const headers:Record<string,string> = {"content-type":row.mimeType,"cache-control":"private, max-age=31536000, immutable","x-content-type-options":"nosniff"};
      if (url.searchParams.has("download")) headers["content-disposition"]=`attachment; filename="label.${row.mimeType === 'image/jpeg' ? 'jpg' : row.mimeType === 'image/webp' ? 'webp' : 'png'}"`;
      return new Response(file.body,{headers});
    }
    if (request.method === "GET" && url.pathname === "/api/catalog/options") {
      const [norms,machines,packing]=await Promise.all([
        store.all<{data:string}>("select data from av2_shift_norms order by type_key"),
        store.all<{machine:string}>("select distinct machine from av2_resolved_catalog_entries where import_id=(select active_catalog_id from av2_meta where id=1) and machine<>'' order by machine"),
        store.all<{field:string;value:string}>(`with card_values as (
          select field.key field,trim(json_extract(e.data,'$.'||field.key)) value
          from av2_resolved_catalog_entries e cross join json_each('{"packaging":0,"boxType":0}') field
          where e.import_id=(select active_catalog_id from av2_meta where id=1)
        ) select field,value from card_values where value<>'' and value not like '#%' and length(value)<=150
          group by field,value order by count(*) desc,value limit 200`)]);
      return json({norms:norms.map(n=>JSON.parse(n.data)),machines:machines.map(n=>n.machine).filter(v=>!v.startsWith('#')),
        packaging:packing.filter(row=>row.field==="packaging").map(row=>row.value),
        boxTypes:packing.filter(row=>row.field==="boxType").map(row=>row.value)});
    }
    if (request.method === "GET" && url.pathname === "/api/catalog/fill") {
      const sku = catalogKey(url.searchParams.get("sku") ?? "");
      const market = url.searchParams.get("market");
      const kind = (url.searchParams.get("kind") ?? "").trim();
      const box = (url.searchParams.get("box") ?? "").trim();
      check(sku.length <= 300 && kind.length <= 150 && box.length <= 150 &&
        (market==="WB" || market==="OZON"), "Проверьте поля для поиска.");
      if (url.searchParams.get("family") === "1") {
        const family = catalogFamilyKey(sku);
        if (!family) return json({cards:[],hasMore:false} satisfies CatalogFamilyMatches);
        const search = catalogKey(url.searchParams.get("q") ?? "").slice(0,150);
        const shop = (url.searchParams.get("store") ?? "").slice(0,30);
        const cards = await store.all<CatalogFamilyCard>(`select entry_id id,sku,market,store,
          coalesce(json_extract(data,'$.name'),'') name from av2_resolved_catalog_entries
          where import_id=(select active_catalog_id from av2_meta where id=1)
            and sku>=? and sku<? and sku<>? and instr(search,?)>0
          order by (market=?) desc,(store=?) desc,sku,market,store limit 31`,
          [family+".",family+"/",sku,search,market,shop]);
        return json({cards:cards.slice(0,30),hasMore:cards.length>30} satisfies CatalogFamilyMatches);
      }
      const [cards, capacities] = await Promise.all([
        sku ? store.all<{id:string;market:string;store:string;name:string}>(`select entry_id id,market,store,
          coalesce(json_extract(data,'$.name'),'') name from av2_resolved_catalog_entries
          where import_id=(select active_catalog_id from av2_meta where id=1) and sku=?
          order by market,store limit 30`,[sku]) : [],
        kind && box ? store.all<{quantity:number}>(`select distinct json_extract(e.data,'$.unitsPerBox') quantity
          from av2_resolved_catalog_entries e
          where import_id=(select active_catalog_id from av2_meta where id=1) and market=?
            and trim(json_extract(e.data,'$.kind'))=? and trim(json_extract(e.data,'$.boxType'))=?
            and json_type(e.data,'$.unitsPerBox')='integer' and json_extract(e.data,'$.unitsPerBox')>0
          order by quantity limit 13`,[market,kind,box]) : [],
      ]);
      return json({cards,capacities:capacities.map(row=>row.quantity)});
    }
    if (request.method === "GET" && url.pathname === "/api/catalog/history") {
      const id=url.searchParams.get("id") || "";
      const rows=await store.all<{before:string;after:string;createdAt:string}>("select before,after,created_at from av2_quality_repairs where kind='catalog.edit' and json_extract(after,'$.id')=? order by created_at desc limit 20",[id]);
      return json({items:rows.map(r=>({before:JSON.parse(r.before),after:JSON.parse(r.after),createdAt:r.createdAt}))});
    }
    if (request.method === "GET" && url.pathname === "/api/catalog")
      return json(await catalogList(store, url));
    if (request.method === "GET" && url.pathname === "/api/catalog/entry") {
      const item = await catalogDetail(
        store,
        url.searchParams.get("import") ?? "",
        url.searchParams.get("id") ?? "",
      );
      return item ? json(item) : json({ error: "Карточка не найдена." }, 404);
    }
    if (url.pathname === "/api/catalog/source") {
      check(files, "Хранилище исходных файлов не подключено.");
      const id = url.searchParams.get("import") ?? "";
      const role = url.searchParams.get("role") ?? "";
      const { manifest } = await importManifest(store, id);
      const source = manifest.sources.find((s) => s.role === role);
      check(source, "Исходный файл не найден.");
      if (request.method === "POST") {
        const bytes = await boundedBody(request, 12_000_000);
        check(
          bytes.length === source.bytes &&
            (await digest(bytes)) === source.sha256,
          "Контрольная сумма исходного Excel не совпала.",
        );
        await files.put(
          sourceKey(id, role),
          bytes,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        await store.batch([
          q(
            "insert into av2_catalog_files(id,import_id,role,sha256,bytes) values(?,?,?,?,?) on conflict(id) do nothing",
            `${id}:${role}`,
            id,
            role,
            source.sha256,
            bytes.length,
          ),
        ]);
        return json({ saved: true });
      }
      if (request.method === "GET") {
        const file = await files.get(sourceKey(id, role));
        return file
          ? new Response(file.body, {
              headers: {
                "Content-Type": file.contentType,
                "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(source.name)}`,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
              },
            })
          : json({ error: "Файл ещё не загружен." }, 404);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/catalog/photo") {
      const id = url.searchParams.get("import") ?? "";
      const photoId = url.searchParams.get("id") ?? "";
      let source = url.searchParams.get("source");
      if (!source) {
        const row = (
          await store.all<{ data: string }>(
            "select data from av2_catalog_photos where import_id=? and photo_id=?",
            [id, photoId],
          )
        )[0];
        if (!row) return json({ error: "Фото не найдено." }, 404);
        const photo = JSON.parse(row.data) as CatalogPhoto;
        const index = Number(url.searchParams.get("index") ?? 0);
        check(
          Number.isInteger(index) && index >= 0 && index < 300,
          "Неверный номер фотографии.",
        );
        source = index === 0 ? photo.primary : photo.urls[index];
      }
      check(source && photoAllowed(source), "Нет доступной фотографии.");
      const hash = await digest(source);
      const key = `catalog/images/${hash}`;
      const cached = await files?.get(key).catch(() => null);
      const headers = {
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      };
      if (cached)
        return new Response(cached.body, {
          headers: { ...headers, "Content-Type": cached.contentType },
        });
      let bytes: Uint8Array;
      let type: string;
      try {
        const response = await remoteFetch(source, {
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        type = (response.headers.get("content-type") ?? "").split(";")[0];
        check(
          response.ok && /^image\/(webp|jpeg|png|avif)$/.test(type),
          "Фотография пока недоступна у источника.",
        );
        bytes = await boundedBody(response, 1_000_000);
      } catch {
        // Some image CDNs reject datacenter requests. The browser can load the
        // same approved public asset directly, without exposing Site credentials.
        return new Response(null, {
          status: 302,
          headers: {
            Location: source,
            "Cache-Control": "private, max-age=300",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      if (files) {
        // Atomic bounded reservations: at most 256 images × 1 MB, including concurrent requests.
        try {
          await store.batch([
            q(
              "insert into av2_photo_cache(id) select ? where (select count(*) from av2_photo_cache)<256 on conflict(id) do nothing",
              hash,
            ),
          ]);
          if (
            (
              await store.all("select id from av2_photo_cache where id=?", [
                hash,
              ])
            ).length
          )
            await files.put(key, bytes, type).catch(() => {});
        } catch {
          console.warn("ASSEMBLY_PHOTO_CACHE_UNAVAILABLE");
        }
      }
      return new Response(new Uint8Array(bytes), {
        headers: { ...headers, "Content-Type": type },
      });
    }
    if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/catalog/import/")
    ) {
      check(
        request.headers.get("content-type")?.startsWith("application/json"),
        "Ожидается JSON.",
      );
      const raw = await boundedBody(request, 1_800_000);
      const body = JSON.parse(new TextDecoder().decode(raw)) as Record<
        string,
        unknown
      >;
      if (url.pathname.endsWith("/start")) {
        const m = body.manifest as CatalogManifest;
        const id = String(body.id ?? "");
        check(
          m?.version === catalogVersion &&
            id === (await digest(JSON.stringify(m))),
          "Проверьте версию и контрольную сумму импорта.",
        );
        check(
          Number.isSafeInteger(m.entries) &&
            m.entries > 0 &&
            m.entries <= 30000 &&
            Number.isSafeInteger(m.photos) &&
            m.photos <= 50000 &&
            m.photos >= 0 &&
            m.sourceRows >= m.entries,
          "Справочник превышает допустимый размер.",
        );
        check(
          m.sources.length === 2 &&
            new Set(m.sources.map((s) => s.role)).size === 2 &&
            m.sources.every(
              (s) =>
                ["base", "photos"].includes(s.role) &&
                /^[a-f0-9]{64}$/.test(s.sha256) &&
                s.bytes > 0 &&
                s.bytes <= 12_000_000 &&
                typeof s.name === "string",
            ),
          "Неверные исходные файлы.",
        );
        check(
          Array.isArray(m.chunks) &&
            m.chunks.length <= 2000 &&
            new Set(m.chunks.map((c) => `${c.kind}:${c.part}`)).size ===
              m.chunks.length &&
            m.chunks.every(
              (c) =>
                ["entries", "photos"].includes(c.kind) &&
                Number.isSafeInteger(c.part) &&
                c.part >= 0 &&
                c.count > 0 &&
                c.count <= 50 &&
                /^[a-f0-9]{64}$/.test(c.digest),
            ),
          "Неверный список пакетов.",
        );
        for (const kind of ["entries", "photos"] as const)
          check(
            m.chunks
              .filter((c) => c.kind === kind)
              .reduce((n, c) => n + c.count, 0) === m[kind],
            "Число строк не совпало с пакетами.",
          );
        await store.batch([
          q(
            "insert into av2_catalog_imports(id,manifest,state,created_at,actor) values(?,?,'staging',?,?) on conflict(id) do nothing",
            id,
            JSON.stringify(m),
            new Date().toISOString(),
            actor,
          ),
        ]);
        const receipts = await store.all<{ kind: string; part: number }>(
          "select kind,part from av2_catalog_chunks where import_id=?",
          [id],
        );
        return json({
          id,
          received: receipts.map((c) => `${c.kind}:${c.part}`),
        });
      }
      const id = String(body.id ?? "");
      const { manifest, state } = await importManifest(store, id);
      if (url.pathname.endsWith("/activate")) {
        const current = (
          await store.all<{ activeCatalogId: string | null }>(
            "select active_catalog_id from av2_meta where id=1",
          )
        )[0]?.activeCatalogId;
        if (current === id) return json({ catalogId: id });
        return json(
          await db.command(
            "catalog.activate",
            { id },
            `catalog:${crypto.randomUUID()}`,
            actor,
          ),
        );
      }
      if (url.pathname.endsWith("/chunk")) {
        const kind = body.kind;
        const part = body.part;
        const expected = manifest.chunks.find(
          (c) => c.kind === kind && c.part === part,
        );
        check(
          expected &&
            typeof body.data === "string" &&
            (await digest(body.data)) === expected.digest,
          "Контрольная сумма пакета не совпала.",
        );
        const receipt = `${id}:${kind}:${part}`;
        if (
          (
            await store.all("select id from av2_catalog_chunks where id=?", [
              receipt,
            ])
          ).length
        )
          return json({ saved: true, repeated: true });
        check(
          state === "staging",
          "Этот импорт уже опубликован. Для новых данных загрузите новую версию.",
        );
        const items = JSON.parse(body.data) as unknown[];
        check(
          Array.isArray(items) && items.length === expected.count,
          "Неверное число записей пакета.",
        );
        const statements: Statement[] = [];
        if (kind === "entries") {
          for (const item of items) validEntry(item as CatalogEntry);
          const data = JSON.stringify(
            (items as CatalogEntry[]).map((e) => ({
              ...e,
              search: catalogKey(
                [e.sku, ...e.aliases, e.name, e.barcode].join(" "),
              ),
              primaryKey: catalogKey(e.sku),
            })),
          );
          statements.push(
            q(
              `insert into av2_catalog_entries(id,import_id,entry_id,market,store,sku,search,machine,review,data)
            select ?||':'||json_extract(value,'$.id'),?,json_extract(value,'$.id'),json_extract(value,'$.market'),json_extract(value,'$.store'),json_extract(value,'$.sku'),json_extract(value,'$.search'),json_extract(value,'$.machine'),case when json_array_length(value,'$.issues')>0 then 1 else 0 end,json_remove(value,'$.search','$.primaryKey') from json_each(?)`,
              id,
              id,
              data,
            ),
          );
          statements.push(
            q(
              `insert into av2_catalog_aliases(id,import_id,market,store,alias,entry_id,is_primary)
            select ?||':'||json_extract(e.value,'$.id')||':'||a.value,?,json_extract(e.value,'$.market'),json_extract(e.value,'$.store'),a.value,json_extract(e.value,'$.id'),case when a.value=json_extract(e.value,'$.primaryKey') then 1 else 0 end from json_each(?) e,json_each(e.value,'$.aliases') a`,
              id,
              id,
              data,
            ),
          );
        } else {
          for (const item of items) validPhoto(item as CatalogPhoto);
          statements.push(
            q(
              "insert into av2_catalog_photos(id,import_id,photo_id,data) select ?||':'||json_extract(value,'$.id'),?,json_extract(value,'$.id'),value from json_each(?)",
              id,
              id,
              body.data,
            ),
          );
        }
        statements.push(
          q(
            "insert into av2_catalog_chunks(id,import_id,kind,part,digest,count) values(?,?,?,?,?,?)",
            receipt,
            id,
            expected.kind,
            expected.part,
            expected.digest,
            expected.count,
          ),
        );
        try {
          await store.batch(statements);
        } catch (error) {
          if (
            !(
              await store.all("select id from av2_catalog_chunks where id=?", [
                receipt,
              ])
            ).length
          )
            throw error;
        }
        return json({ saved: true });
      }
    }
    return json({ error: "Страница справочника не найдена." }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return json(
      {
        error: /[А-Яа-яЁё]/.test(message)
          ? message
          : "Не удалось загрузить справочник. Повторите запрос; принятые пакеты сохранены.",
      },
      409,
    );
  }
}
