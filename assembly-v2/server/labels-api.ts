import { mediaPath, type ManagedProduct } from "../shared/catalog-editor";
import { json } from "./api";
import type { SqlStore, Statement } from "./database";
import { boundedBody, type FileStore } from "./catalog-api";
import { sameOrigin } from "./access";
import { catalogKey, digest } from "../shared/catalog";
import {
  labelArticle, labelBatchLimit, labelFileId, labelFileLimit, labelMime,
  type LabelEntry, type LabelManifest, type PrintableLabel,
} from "../shared/labels";
import type { Market } from "../shared/model";
import { effectiveCatalogData } from "./catalog-store";

const shaPattern = /^[a-f0-9]{64}$/;
const importPattern = /^labels:[a-f0-9]{64}$/;
const q = (sql: string, ...args: (string | number | null)[]): Statement => ({ sql, args });
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function validateManifest(m: LabelManifest) {
  check(m && m.version === 1 && shaPattern.test(m.sourceHash) &&
    typeof m.capturedAt === "string" && Number.isFinite(Date.parse(m.capturedAt)) &&
    Number.isSafeInteger(m.entries) && m.entries > 0 && m.entries <= 20000 &&
    Array.isArray(m.chunks) && m.chunks.length > 0 && m.chunks.length <= 400 &&
    m.chunks.every(c => shaPattern.test(c.sha256) && Number.isSafeInteger(c.count) && c.count > 0 && c.count <= 50) &&
    m.chunks.reduce((n, c) => n + c.count, 0) === m.entries,
    "Неверный состав базы этикеток.");
}
function validateEntry(e: LabelEntry) {
  check(e && ["WB", "OZON"].includes(e.market) && typeof e.sku === "string" && e.sku.length > 0 && e.sku.length <= 300 && e.sku === labelArticle(e.sku, e.market), "Неверный артикул этикетки.");
  check(Array.isArray(e.fileIds) && e.fileIds.length > 0 && e.fileIds.length <= 100 && e.fileIds.every(labelFileId) && new Set(e.fileIds).size === e.fileIds.length, "Неверная ссылка на оригинал.");
  check(["found", "conflict", "file_unavailable", "unsupported_format", "file_too_large"].includes(e.status) &&
    (e.status === "conflict") === (e.fileIds.length > 1) &&
    (e.status === "found" ? typeof e.sha256 === "string" && shaPattern.test(e.sha256) : e.sha256 === null), "Проверьте статус оригинала этикетки.");
  check(Array.isArray(e.sources) && e.sources.length > 0 && e.sources.length <= 100 && e.sources.every(s =>
    typeof s.spreadsheetId === "string" && labelFileId(s.spreadsheetId) && typeof s.sheet === "string" && s.sheet.length > 0 && s.sheet.length <= 200 &&
    Number.isSafeInteger(s.row) && s.row >= 2 && typeof s.rawSku === "string" && labelArticle(s.rawSku, e.market) === e.sku && e.fileIds.includes(s.fileId)) &&
    e.fileIds.every(id => e.sources.some(s => s.fileId === id)), "Отсутствуют исходные строки этикетки.");
}
async function imported(store: SqlStore, id: string) {
  check(importPattern.test(id), "Неверная версия базы этикеток.");
  const [row] = await store.all<{ id: string; manifest: string; state: string }>("select id,manifest,state from av2_label_imports where id=?", [id]);
  check(row, "Версия базы этикеток не найдена.");
  return { ...row, parsed: JSON.parse(row.manifest) as LabelManifest };
}
async function readLabels(store: SqlStore, url: URL) {
  const ids = [...new Set(url.searchParams.getAll("position"))];
  const receiptId = url.searchParams.get("receipt"), entryId = url.searchParams.get("entry");
  check(Number(ids.length > 0) + Number(receiptId !== null) + Number(entryId !== null) === 1, "Выберите один источник этикеток.");
  type Target = { id: string; sku: string; name: string; barcode: string; market: Market; store: string; catalogEntryId?: string | null };
  let positions: Target[];
  if (receiptId !== null) {
    check(receiptId.length > 0 && receiptId.length <= 300, "Выберите складскую запись.");
    positions = await store.all<Target>("select r.id,r.sku,r.name,'' barcode,c.market,c.store,p.catalog_entry_id from av2_warehouse_receipts r join av2_warehouse_cartons c on c.id=r.carton_id left join av2_positions p on p.id=r.position_id where r.id=? and r.voided_at is null", [receiptId]);
    check(positions.length === 1, "Складская запись удалена или не найдена. Обновите список.");
  } else if (entryId !== null) {
    const importId = url.searchParams.get("catalogImport") || "";
    check(entryId.length > 0 && entryId.length <= 1500 && importId.length > 0 && importId.length <= 300, "Выберите товар из справочника.");
    const rows = await store.all<{ data: string }>(`select ${effectiveCatalogData()} data from av2_resolved_catalog_entries e where e.entry_id=? and e.import_id=? and e.import_id=(select active_catalog_id from av2_meta where id=1)`, [entryId, importId]);
    check(rows.length === 1, "Справочник изменился. Найдите товар заново.");
    const entry = JSON.parse(rows[0].data) as Omit<Target, "id">;
    positions = [{ ...entry, id: entryId, catalogEntryId: entryId }];
  } else {
    check(ids.length > 0 && ids.length <= labelBatchLimit && ids.every(id => id.length > 0 && id.length <= 300), "Выберите от 1 до 150 товаров.");
    positions = await store.all<Target>(
    `select p.id,p.sku,p.name,p.barcode,s.market,s.store,p.catalog_entry_id from av2_positions p join av2_supplies s on s.id=p.supply_id where p.id in (select value from json_each(?))`, [JSON.stringify(ids)]);
    check(positions.length === ids.length, "Часть выбранных товаров больше не найдена. Обновите поставку.");
  }
  const [active] = await store.all<{ id: string }>("select id from av2_label_imports where state='active'");
  const records = active ? await store.all<{ market: Market; sku: string; data: string }>(
    `select market,sku,data from av2_label_entries where import_id=? and (market,sku) in
      (select json_extract(value,'$[0]'),json_extract(value,'$[1]') from json_each(?))`,
    [active.id, JSON.stringify(positions.map(p => [p.market, labelArticle(p.sku, p.market)]))]) : [];
  const byKey = new Map(records.map(r => [JSON.stringify([r.market, r.sku]), JSON.parse(r.data) as LabelEntry]));
  const managed=await store.all<{data:string}>(`select data from av2_catalog_products
    where json_extract(data,'$.labelSha') is not null and (market,store) in
    (select json_extract(value,'$[0]'),json_extract(value,'$[1]') from json_each(?))`,[JSON.stringify(positions.map(p=>[p.market,p.store]))]);
  const managedLabels=managed.map(r=>JSON.parse(r.data) as ManagedProduct);
  const byId = new Map(positions.map(p => [p.id, p]));
  const items: PrintableLabel[] = (ids.length ? ids : positions.map(p => p.id)).map(id => {
    const p = byId.get(id)!;
    const entry = byKey.get(JSON.stringify([p.market, labelArticle(p.sku, p.market)]));
    const candidates = managedLabels.filter(m => m.market === p.market && m.store === p.store);
    const exact = candidates.find(m => m.id === p.catalogEntryId) ?? candidates.find(m => catalogKey(m.sku) === catalogKey(p.sku));
    const aliases = exact ? [exact] : candidates.filter(m =>
      m.aliases.some(a => labelArticle(a, m.market) === labelArticle(p.sku, p.market)));
    const hashes = [...new Set(aliases.flatMap(m => m.labelSha ? [m.labelSha] : []))];
    const target = { positionId: p.id, sku: p.sku, name: p.name, market: p.market };
    if (hashes.length === 1) return { ...target, status: 'found', imageUrl: mediaPath(hashes[0]) };
    if (hashes.length > 1) return { ...target, status: 'conflict' };
    return {
      ...target,
      status: !active ? "not_configured" : entry?.status ?? (p.barcode ? "barcode_only" : "missing"),
      ...(entry?.status === "found" ? {
        imageUrl: `/api/labels/image?import=${encodeURIComponent(active!.id)}&sha256=${entry.sha256}`,
        originalUrl: `https://drive.google.com/file/d/${entry.fileIds[0]}/view`,
      } : {}),
    };
  });
  return { items };
}
export async function labelsApi(
  request: Request,
  store: SqlStore,
  files: FileStore | undefined,
  role: "owner" | "manager" | "collector" | "service",
  actor: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (role === "service" || (!['owner','manager'].includes(role) && !(request.method === "GET" && ["/api/labels", "/api/labels/image"].includes(url.pathname))))
    return json({ error: "Управление этикетками доступно владельцу." }, 403);
  if (request.method !== "GET" && !sameOrigin(request)) return json({ error: "Недопустимый источник запроса." }, 403);
  try {
    if (request.method === "GET" && url.pathname === "/api/labels") return json(await readLabels(store, url));
    if (request.method === "GET" && url.pathname === "/api/labels/image") {
      check(files, "Хранилище этикеток недоступно.");
      const id = url.searchParams.get("import") || "", sha = url.searchParams.get("sha256") || "";
      check(importPattern.test(id) && shaPattern.test(sha), "Неверная ссылка на этикетку.");
      const [file] = await store.all<{ mimeType: string }>("select f.mime_type from av2_label_files f where f.sha256=? and exists(select 1 from av2_label_entries e join av2_label_imports i on i.id=e.import_id where e.import_id=? and e.sha256=f.sha256 and e.status='found' and i.state in('active','retired'))", [sha, id]);
      if (!file) return json({ error: "Оригинал этикетки не найден." }, 404);
      const object = await files.get(`labels/files/${sha}`);
      if (!object) return json({ error: "Оригинал этикетки недоступен. Повторите загрузку." }, 404);
      const headers: Record<string, string> = { "content-type": file.mimeType, "cache-control": "private, max-age=86400, immutable", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
      if (url.searchParams.get("download") === "1") {
        const name = (url.searchParams.get("name") || "label").slice(0, 120).replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_");
        const extension = file.mimeType === "image/png" ? "png" : file.mimeType === "image/jpeg" ? "jpg" : "webp";
        headers["content-disposition"] = `attachment; filename="label.${extension}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16))}.${extension}`;
      }
      return new Response(object.body, { headers });
    }
    if (request.method === "GET" && url.pathname === "/api/labels/files") {
      const hashes = [...new Set((url.searchParams.get("hashes") || "").split(","))];
      check(hashes.length > 0 && hashes.length <= 100 && hashes.every(h => shaPattern.test(h)), "Неверный список файлов.");
      return json({ files: await store.all(`select sha256,mime_type,bytes from av2_label_files where sha256 in (${hashes.map(() => "?").join(",")})`, hashes) });
    }
    if (request.method === "PUT" && url.pathname === "/api/labels/file") {
      check(files, "Хранилище этикеток недоступно.");
      const sha = url.searchParams.get("sha256") || "";
      check(shaPattern.test(sha), "Укажите контрольную сумму этикетки.");
      const bytes = await boundedBody(request, labelFileLimit), mime = labelMime(bytes);
      check(mime && bytes.length > 12, "Формат оригинала не поддерживается.");
      check(await digest(bytes) === sha, "Контрольная сумма этикетки не совпала.");
      await files.put(`labels/files/${sha}`, bytes, mime);
      await store.batch([q("insert into av2_label_files(sha256,mime_type,bytes,created_at) values(?,?,?,?) on conflict(sha256) do nothing", sha, mime, bytes.length, new Date().toISOString())]);
      return json({ sha256: sha, bytes: bytes.length });
    }
    if (request.method === "POST" && url.pathname === "/api/labels/import") {
      const manifest = JSON.parse(new TextDecoder().decode(await boundedBody(request, 100000))) as LabelManifest;
      validateManifest(manifest);
      const data = JSON.stringify(manifest), id = "labels:" + await digest(data);
      await store.batch([q("insert into av2_label_imports(id,manifest,state,created_at,actor) values(?,?,'staging',?,?) on conflict(id) do nothing", id, data, new Date().toISOString(), actor)]);
      const chunks = await store.all<{ part: number }>("select part from av2_label_chunks where import_id=? order by part", [id]);
      return json({ id, received: chunks.map(c => c.part) });
    }
    if (request.method === "PUT" && url.pathname === "/api/labels/chunk") {
      const version = await imported(store, url.searchParams.get("import") || ""), part = Number(url.searchParams.get("part"));
      check(Number.isSafeInteger(part) && part >= 0 && part < version.parsed.chunks.length, "Неверный номер пакета этикеток.");
      const bytes = await boundedBody(request, 1000000), expected = version.parsed.chunks[part];
      check(await digest(bytes) === expected.sha256, "Контрольная сумма пакета этикеток не совпала.");
      const entries = JSON.parse(new TextDecoder().decode(bytes)) as LabelEntry[];
      check(Array.isArray(entries) && entries.length === expected.count, "Неверное количество этикеток в пакете.");
      entries.forEach(validateEntry);
      check(new Set(entries.map(e => JSON.stringify([e.market, e.sku]))).size === entries.length, "В пакете есть повтор артикула.");
      const [received] = await store.all<{ digest: string }>("select digest from av2_label_chunks where import_id=? and part=?", [version.id, part]);
      if (received) { check(received.digest === expected.sha256, "Состав сохранённого пакета изменился."); return json({ accepted: entries.length, repeated: true }); }
      check(version.state === "staging", "Опубликованная база этикеток неизменна.");
      const hashes = [...new Set(entries.flatMap(e => e.sha256 ? [e.sha256] : []))];
      const saved = hashes.length ? await store.all<{ sha256: string }>(`select sha256 from av2_label_files where sha256 in (${hashes.map(() => "?").join(",")})`, hashes) : [];
      check(saved.length === hashes.length, "Сначала сохраните оригиналы этикеток.");
      await store.batch([
        ...entries.map(e => q("insert into av2_label_entries(id,import_id,market,sku,status,sha256,data) values(?,?,?,?,?,?,?)", JSON.stringify([version.id, e.market, e.sku]), version.id, e.market, e.sku, e.status, e.sha256, JSON.stringify(e))),
        q("insert into av2_label_chunks(id,import_id,part,digest,count) values(?,?,?,?,?)", `${version.id}:${part}`, version.id, part, expected.sha256, entries.length),
      ]);
      return json({ accepted: entries.length, repeated: false });
    }
    if (request.method === "POST" && url.pathname === "/api/labels/activate") {
      check(files, "Хранилище этикеток недоступно.");
      const body = JSON.parse(new TextDecoder().decode(await boundedBody(request, 1000))) as { id: string };
      const version = await imported(store, body.id);
      const chunks = await store.all<{ part: number; digest: string; count: number }>("select part,digest,count from av2_label_chunks where import_id=? order by part", [version.id]);
      check(chunks.length === version.parsed.chunks.length && chunks.every((c, i) => c.part === i && c.digest === version.parsed.chunks[i].sha256 && c.count === version.parsed.chunks[i].count), "Не все пакеты этикеток сохранены.");
      const [count] = await store.all<{ n: number; missing: number }>("select count(*) n,coalesce(sum(case when e.status='found' and f.sha256 is null then 1 else 0 end),0) missing from av2_label_entries e left join av2_label_files f on f.sha256=e.sha256 where e.import_id=?", [version.id]);
      check(count.n === version.parsed.entries && count.missing === 0, "База этикеток загружена не полностью.");
      check(await files.get(`legacy-backups/${version.parsed.sourceHash}`), "Исходный справочник этикеток не сохранён в резервной копии.");
      await store.batch([q("update av2_label_imports set state='retired' where state='active'"), q("update av2_label_imports set state='active' where id=?", version.id)]);
      return json({ id: version.id, entries: count.n, active: true });
    }
    return json({ error: "Страница этикеток не найдена." }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Не удалось подготовить этикетки." }, 409);
  }
}
