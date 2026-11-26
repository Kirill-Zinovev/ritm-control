import { catalogKey, digest, spreadsheetError } from "../shared/catalog";
import {
  catalogHandoffBarcode, catalogHandoffStore, emptyCatalogProduct, mediaPath, type ManagedDetail,
} from "../shared/catalog-editor";
import { labelMime, type LabelMime } from "../shared/labels";
import { labelInputKey } from "../shared/product-label-fields";
import { json, type Database } from "./api";
import { boundedBody, type FileStore } from "./catalog-api";
import { catalogSavePlan, type PendingCatalogMedia } from "./catalog-editor";
import { catalogBarcodeMatches, catalogDetail, catalogLabelTargets, requireCatalog as check, selectableCatalog } from "./catalog-store";
import type { SqlStore } from "./database";

export const arkadyWbIntakeAction = "ritm.arkadyWbIntake";
const actionKey = "ritm:arkady-wb-intake:";
const shaPattern = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const photoLimit = 1_000_000;
const labelLimit = 200_000;
const bodyLimit = 1_700_000;
type AssetKind = "photo" | "label";

function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value), "Проверьте формат запроса.");
  return value as Record<string, unknown>;
}
function keys(input: Record<string, unknown>, allowed: string[]) {
  check(Object.keys(input).every(key => allowed.includes(key)), "В запросе есть неподдерживаемое поле.");
}
function optionalText(value: unknown, limit: number) {
  if (value === undefined) return "";
  check(typeof value === "string" && value.length <= limit && !/[\p{Cc}\p{Cf}]/u.test(value),
    "Проверьте текстовые поля карточки.");
  const text = value.trim().normalize("NFC");
  check(!text || !spreadsheetError(text) && !/^[=+@]/.test(text), "Проверьте текстовые поля карточки.");
  return text;
}
function textFromCatalog(value: string, limit: number) {
  try { return optionalText(value, limit); } catch { return ""; }
}

function parseDraft(value: unknown, withMedia = false) {
  const input = object(value);
  keys(input, ["article", "store", "barcode", "name", "packaging", ...(withMedia ? ["photo", "label"] : [])]);
  const { store, barcode } = input;
  check(catalogHandoffStore(store) && catalogHandoffBarcode(barcode, "WB"), "Выберите магазин WB и укажите штрихкод.");
  return {
    article: catalogKey(optionalText(input.article, 120)), store, barcode,
    name: optionalText(input.name, 500), packaging: optionalText(input.packaging, 100),
  };
}
function parseApproval(input: Record<string, unknown>) {
  const { approvalId, fingerprint } = input;
  const approvedBy = optionalText(input.approvedBy, 180);
  check(typeof approvalId === "string" && uuid.test(approvalId) && approvedBy
    && typeof fingerprint === "string" && shaPattern.test(fingerprint), "Нужно подтверждение владельца РИТМ.");
  return { approvalId: approvalId.toLowerCase(), approvedBy, fingerprint };
}

async function prepareDraft(store: SqlStore, requested: ReturnType<typeof parseDraft>) {
  const [meta] = await store.all<{ importId: string | null }>("select active_catalog_id import_id from av2_meta where id=1");
  const importId = meta?.importId;
  if (!importId) return null;
  const { store: shop, barcode } = requested;
  const matches = await catalogBarcodeMatches(store, importId, "WB", shop, barcode);
  check(matches.length <= 1, "В магазине несколько карточек с таким штрихкодом. Сверьте справочник.");
  const barcodeId = matches[0]?.entryId;
  const articleId = requested.article ? JSON.stringify(["WB", shop, requested.article]) : undefined;
  check(!barcodeId || !articleId || barcodeId === articleId,
    "Штрихкод уже относится к другому артикулу этого магазина.");
  const cardId = barcodeId ?? articleId;
  const current = cardId ? await catalogDetail(store, importId, cardId) as ManagedDetail | null : null;
  check(!barcodeId || current?.barcode === barcode, "Карточка изменилась. Подготовьте её заново.");
  check(!current || !current.barcode.trim() || spreadsheetError(current.barcode) || current.barcode === barcode,
    "У этого артикула уже указан другой штрихкод. Сверьте карточку магазина.");
  const article = current?.sku ?? requested.article;
  const related = !current && article
    ? await store.all<{ data: string }>(
        "select data from " + selectableCatalog + " where import_id=? and market='WB' and store in ('1','2') and store<>? and sku=? limit 2",
        [importId, shop, article])
    : [];
  const similar = related.length === 1 ? JSON.parse(related[0].data) as ManagedDetail : null;
  const sourceCard = current ?? similar;
  const draft = {
    article, store: shop, barcode,
    name: requested.name || textFromCatalog(sourceCard?.name ?? "", 500),
    packaging: requested.packaging || textFromCatalog(sourceCard?.packaging ?? "", 100),
  };
  const missing = (["article", "name", "packaging"] as const).filter(field => !draft[field]);
  const hasPhoto = !!(current?.photoId || current?.photoUrl);
  const [labelState] = current ? await catalogLabelTargets(store, importId, [current.id]) : [];
  const hasLabel = labelState?.needsLabel === 0;
  const source = current ? "exact-card" : similar ? "same-article" : "input";
  const fingerprint = await digest(JSON.stringify([
    importId, requested, draft, current?.id, current?.editRevision ?? null,
    sourceCard?.id, sourceCard?.editRevision ?? null, current?.barcode, hasPhoto, hasLabel,
  ]));
  const preview = { mode: current ? "update" : "create", draft, missing, hasPhoto, hasLabel, source, fingerprint };
  return { importId, current, preview };
}

interface IntakeAsset { kind: AssetKind; meta: PendingCatalogMedia; data: Uint8Array }
function pngLabelSize(data: Uint8Array) {
  if (data.length < 33 || String.fromCharCode(...data.subarray(12, 16)) !== "IHDR") return false;
  const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (header.getUint32(8) !== 13 || header.getUint32(16) !== 696 || header.getUint32(20) !== 480) return false;
  let imageData = false;
  for (let offset = 33; offset + 12 <= data.length;) {
    const bytes = header.getUint32(offset);
    const next = offset + bytes + 12;
    if (next > data.length) return false;
    const chunk = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    if (chunk === "IDAT" && bytes > 0) imageData = true;
    if (chunk === "IEND") return imageData && bytes === 0 && next === data.length;
    offset = next;
  }
  return false;
}
async function decodeAsset(value: unknown, kind: AssetKind): Promise<IntakeAsset> {
  const input = object(value);
  keys(input, ["filename", "mimeType", "content"]);
  const { content, mimeType } = input;
  check(optionalText(input.filename, 150), "Укажите имя загруженного файла.");
  const limit = kind === "photo" ? photoLimit : labelLimit;
  check(typeof content === "string" && content.length % 4 === 0 && content.length <= 4 * Math.ceil(limit / 3)
    && /^[A-Za-z0-9+/]+={0,2}$/.test(content), "Проверьте размер и формат изображения.");
  const data = Uint8Array.from(atob(content), char => char.charCodeAt(0));
  const detectedMime = labelMime(data);
  check(data.length > 12 && data.length <= limit && detectedMime && detectedMime === mimeType,
    "Проверьте размер и формат изображения.");
  if (kind === "label")
    check(detectedMime === "image/png" && pngLabelSize(data), "Сгенерируйте PNG-этикетку WB 58 × 40 мм.");
  return { kind, data, meta: { sha256: await digest(data), mimeType: detectedMime, bytes: data.length } };
}
function parseAssetMeta(value: unknown, kind: AssetKind): PendingCatalogMedia {
  const input = object(value);
  const { sha256, mimeType, bytes } = input;
  const validMime = mimeType === "image/png" || kind === "photo" && (mimeType === "image/jpeg" || mimeType === "image/webp");
  check(typeof sha256 === "string" && shaPattern.test(sha256) && validMime && Number.isSafeInteger(bytes)
    && typeof bytes === "number" && bytes > 12 && bytes <= (kind === "photo" ? photoLimit : labelLimit),
    "Проверьте изображение карточки.");
  return { sha256, mimeType: mimeType as LabelMime, bytes };
}

export async function arkadyWbIntakePlan(store: SqlStore, input: Record<string, unknown>, actor: string, now: string) {
  const approval = parseApproval(input);
  check(actor === "ritm-owner:" + approval.approvedBy, "Нужно подтверждение владельца РИТМ.");
  const requested = parseDraft(input.draft);
  const prepared = await prepareDraft(store, requested);
  check(prepared?.preview.fingerprint === approval.fingerprint, "Справочник изменился. Подготовьте карточку заново.");
  const { current, importId, preview } = prepared;
  check(!preview.missing.length, "Заполните артикул, название и упаковку.");
  const photo = input.photo ? parseAssetMeta(input.photo, "photo") : null;
  const label = input.label ? parseAssetMeta(input.label, "label") : null;
  const product = { ...(current ?? emptyCatalogProduct()), market: "WB", store: preview.draft.store,
    sku: preview.draft.article, barcode: preview.draft.barcode, name: preview.draft.name,
    packaging: preview.draft.packaging, photoUrl: photo ? mediaPath(photo.sha256) : current?.photoUrl,
    labelSha: label?.sha256 ?? current?.labelSha ?? null };
  check(!current || !preview.hasLabel || label || labelInputKey({ ...product, market: "WB" }) === labelInputKey(current),
    "Для новых данных сгенерируйте этикетку заново.");
  if (current && !photo && !label && product.barcode === current.barcode &&
    product.name === current.name && product.packaging === current.packaging)
    throw new Error("Эти данные уже сохранены в карточке.");
  return catalogSavePlan(store, {
    id: current?.id ?? null, create: !current, revision: current?.editRevision ?? 0,
    importId, barcodeHandoff: !current, product,
  }, actor, now, {
    media: [photo, label].filter(media => media !== null),
    auditReason: "Карточка WB подтверждена в Аркадии " + approval.approvalId,
  });
}

export async function arkadyWbIntakeApi(request: Request, store: SqlStore, db: Database, actor: string, files?: FileStore) {
  if (actor !== "ritm-service") return json({ error: "Требуется служебный запрос РИТМ." }, 403);
  if (request.method !== "POST") return json({ error: "Метод запроса не поддерживается." }, 405);
  let input: Record<string, unknown>;
  try {
    const bytes = await boundedBody(request, bodyLimit);
    input = object(JSON.parse(new TextDecoder().decode(bytes)));
    check(input.action === "prepare" || input.action === "confirm", "Неизвестное действие с карточкой WB.");
    keys(input, input.action === "prepare" ? ["action", "draft"]
      : ["action", "draft", "fingerprint", "approvalId", "approvedBy"]);
  } catch (error) {
    return error instanceof Error && error.message === "Файл слишком большой."
      ? json({ error: "Запрос превышает допустимый размер." }, 413)
      : json({ error: "Проверьте запрос карточки WB." }, 400);
  }
  const confirm = input.action === "confirm";
  let requested, approval, assets: IntakeAsset[];
  try {
    requested = parseDraft(input.draft, confirm);
    approval = confirm ? parseApproval(input) : null;
    const draft = object(input.draft);
    assets = confirm ? await Promise.all((["photo", "label"] as const)
      .filter(kind => draft[kind] !== undefined).map(kind => decodeAsset(draft[kind], kind))) : [];
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Проверьте поля карточки WB." }, 400);
  }
  try {
    if (!approval) {
      const state = await prepareDraft(store, requested);
      return state ? json({ ok: true, ...state.preview }) : json({ error: "Справочник РИТМ Сборка не подключён." }, 503);
    }
    const key = actionKey + approval.approvalId;
    const owner = "ritm-owner:" + approval.approvedBy;
    const payload = { ...approval, draft: requested, ...Object.fromEntries(assets.map(asset => [asset.kind, asset.meta])) };
    const recorded = async () => (await store.all("select key from av2_commands where key=?", [key])).length > 0;
    const save = async () => json({ ok: true, ...await db.command(arkadyWbIntakeAction, payload, key, owner) });
    try {
      if (!await recorded()) {
        if (assets.length && !files) return json({ error: "Хранилище изображений справочника недоступно." }, 503);
        await arkadyWbIntakePlan(store, payload, owner, new Date().toISOString());
        for (const { data, meta } of assets) {
          try { await files!.put("catalog/media/" + meta.sha256, data, meta.mimeType); }
          catch { return json({ error: "Не удалось сохранить изображение. Повторите подтверждение." }, 503); }
        }
      }
      return await save();
    } catch (error) {
      // An identical concurrent confirmation may commit between validation reads.
      // The native command compares the recorded owner and payload before replay.
      if (await recorded()) return await save();
      throw error;
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Карточка WB не сохранена." }, 409);
  }
}
