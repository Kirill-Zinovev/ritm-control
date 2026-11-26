import { CloudError } from "./access.js";
import { callAssemblyV2 } from "./assemblyV2Transport.js";

const path = "/api/ritm/arkady/catalog/wb-intake";
const stores = new Set(["1", "2"]);
const modes = new Set(["create", "update"]);
const sources = new Set(["exact-card", "same-article", "input"]);
const fields = new Set(["article", "name", "packaging"]);
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const unsupportedCatalogText = /[\p{Cc}\p{Cf}]|^[=+@]|^#(?:N\/A|VALUE!|REF!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR!)/iu;
const barcodePattern = /^[0-9]{6,32}$/u;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/u;
const photoTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const png = "\x89PNG\r\n\x1a\n";
const reviewedMessages = new Set([
  "В магазине несколько карточек с таким штрихкодом. Сверьте справочник.",
  "Штрихкод уже относится к другому артикулу этого магазина.",
  "У этого артикула уже указан другой штрихкод. Сверьте карточку магазина.",
  "Справочник изменился. Подготовьте карточку заново.",
  "Заполните артикул, название и упаковку.",
  "Для новых данных сгенерируйте этикетку заново.",
  "Эти данные уже сохранены в карточке.",
]);

export const arkadyWbIntakeMaxBytes = 1_700_000;
const fail = (code, message, status = 400) => { throw new CloudError(code, message, status); };
const inputError = () => fail("arkady_wb_intake_invalid", "Проверьте магазин, артикул, штрихкод, название и упаковку.");
const record = value => value && typeof value === "object" && !Array.isArray(value);
const clean = (value, max) => {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max) inputError();
  const text = value.trim().normalize("NFC");
  if (unsupportedCatalogText.test(text) || /[\p{Cc}\p{Cf}]/u.test(value)) inputError();
  return text;
};

function draftFields(value) {
  if (!record(value) || !stores.has(value.store) || typeof value.barcode !== "string" ||
    !barcodePattern.test(value.barcode.trim())) inputError();
  const article = clean(value.article, 120).toLocaleUpperCase("ru-RU");
  return {
    ...(article && { article }),
    store: value.store,
    barcode: value.barcode.trim(),
    ...(value.name !== undefined && {name: clean(value.name, 500)}),
    ...(value.packaging !== undefined && {packaging: clean(value.packaging, 100)}),
  };
}

function matchesImage(bytes, mimeType, label) {
  if (mimeType === "image/png") {
    if (bytes.length < 33 || !bytes.startsWith(png) || bytes.slice(12, 16) !== "IHDR") return false;
    return !label || bytes.slice(16, 24) === "\x00\x00\x02\xb8\x00\x00\x01\xe0";
  }
  if (mimeType === "image/jpeg") return bytes.length > 12 && bytes.startsWith("\xff\xd8\xff");
  return bytes.length > 12 && bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
}

function intakeMedia(file, label) {
  const message = label
    ? "Сгенерируйте этикетку WB 58 × 40 мм в PNG размером до 200 КБ."
    : "Прикрепите фото в JPEG, PNG или WebP размером до 1 МБ.";
  const invalid = () => fail("arkady_wb_intake_media", message);
  const maxBytes = label ? 200_000 : 1_000_000;
  if (!record(file) || typeof file.filename !== "string" || !file.filename.trim() || file.filename.length > 150 ||
    /[\\/\p{Cc}\p{Cf}]/u.test(file.filename) ||
    (label ? file.mimeType !== "image/png" : !photoTypes.has(file.mimeType)) ||
    typeof file.content !== "string" || file.content.length % 4 !== 0 ||
    file.content.length > Math.ceil(maxBytes / 3) * 4 || !base64Pattern.test(file.content)) invalid();
  let bytes;
  try { bytes = atob(file.content); }
  catch { invalid(); }
  if (bytes.length > maxBytes || !matchesImage(bytes, file.mimeType, label)) invalid();
  return { filename: file.filename.trim(), mimeType: file.mimeType, content: file.content };
}

const availableError = write => fail("arkady_wb_intake_unavailable", write
  ? "RITM Сборка пока не подтвердила сохранение. Повторите запрос с тем же подтверждением."
  : "Справочник RITM Сборка временно недоступен. Повторите проверку.",
503);

function approvedResult(value) {
  return typeof value.entryId === "string" && value.entryId.length > 0 && value.entryId.length <= 240 &&
    Number.isSafeInteger(value.revision) && value.revision >= 0;
}

function reviewedResult(value, input) {
  const { draft, mode, source, fingerprint, hasPhoto, hasLabel, missing } = value;
  return record(draft) && modes.has(mode) && sources.has(source) &&
    typeof fingerprint === "string" && fingerprintPattern.test(fingerprint) &&
    draft.store === input.store && draft.barcode === input.barcode &&
    typeof draft.article === "string" && draft.article.length <= 120 && !unsupportedCatalogText.test(draft.article) &&
    (!input.article || draft.article === input.article) &&
    typeof draft.name === "string" && draft.name.length <= 500 &&
    typeof draft.packaging === "string" && draft.packaging.length <= 100 &&
    typeof hasPhoto === "boolean" && typeof hasLabel === "boolean" &&
    Array.isArray(missing) && missing.length <= fields.size && missing.every(field => fields.has(field));
}

export async function arkadyWbIntake(input, { bindings, principal, writesEnabled, fetcher }) {
  if (!principal || !["owner", "manager"].includes(principal.role))
    fail("arkady_wb_intake_forbidden", "Войдите в РИТМ, чтобы проверить карточку WB.", 403);
  if (!record(input) || !["prepare", "confirm"].includes(input.action)) inputError();
  const write = input.action === "confirm";
  const canEdit = principal.role === "owner" && writesEnabled === true;
  if (write && !canEdit)
    fail("arkady_wb_intake_owner_required", "Сохранить карточку WB может владелец РИТМа при включённой записи.", 403);
  if (write && input.explicitWriteApproval !== true)
    fail("arkady_wb_intake_approval", "Проверьте карточку и подтвердите сохранение.", 409);

  const draft = draftFields(input.draft);
  const body = { action: input.action, draft };
  if (write) {
    if (typeof input.fingerprint !== "string" || !fingerprintPattern.test(input.fingerprint) ||
      typeof input.approvalId !== "string" || !uuidPattern.test(input.approvalId) ||
      typeof principal.id !== "string" || !principal.id || principal.id.length > 180)
      fail("arkady_wb_intake_confirmation", "Сначала заново проверьте карточку WB.", 409);
    if (input.draft.photo !== undefined) draft.photo = intakeMedia(input.draft.photo, false);
    if (input.draft.label !== undefined) draft.label = intakeMedia(input.draft.label, true);
    Object.assign(body, {
      fingerprint: input.fingerprint,
      approvalId: input.approvalId,
      approvedBy: principal.id,
    });
  }

  let response, value;
  try {
    response = await callAssemblyV2(bindings, path, {
      method: "POST", body: JSON.stringify(body), fetcher, timeout: write ? 25_000 : 12_000,
    });
    value = await response.json();
  } catch { availableError(write); }
  if (response.status === 409)
    fail("arkady_wb_intake_conflict", reviewedMessages.has(value?.error) ? value.error :
      "Карточка изменилась или найдено совпадение с другим товаром. Повторите проверку.", 409);
  if ([400, 422].includes(response.status)) inputError();
  if (response.status === 413)
    fail("arkady_wb_intake_media", "Уменьшите размер фото или этикетки.", 413);
  if (!response.ok || value?.ok !== true) availableError(write);
  if (write) {
    if (!approvedResult(value)) availableError(true);
    return { ok: true, entryId: value.entryId, revision: value.revision };
  }
  if (!reviewedResult(value, draft)) availableError(false);
  const { mode, fingerprint, missing, hasPhoto, hasLabel, source } = value;
  const reviewed = value.draft;
  return {
    ok: true, canEdit, mode, fingerprint, missing: [...new Set(missing)], hasPhoto, hasLabel, source,
    draft: { article: reviewed.article, store: reviewed.store, barcode: reviewed.barcode, name: reviewed.name, packaging: reviewed.packaging },
  };
}
