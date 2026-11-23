import {validateDeadlines} from '../shared/productionPlanning.js';
import {xeroxExtensionIssue} from '../shared/productionRouting.js';
import { createHash, randomUUID } from "node:crypto";
import {
  RollSupplySheetsWriter,
  MAX_SUPPLY_QUANTITY,
  validateRollSupplyPayload,
  supplyManifestRequests,
} from "./rollSupply.js";
import {
  ROLL_PRINTING_SHEET_ID,
  ROLL_PRINTING_SHEET,
} from "../worker/printing.js";
import { privateGoogleSource } from "../worker/privateGoogleConfig.js";
import { xeroxPlanRounding, xeroxSheetCount } from "./xeroxQuantity.js";
import { quantityRounding } from "./quantityRounding.js";

export const CATALOG_ID = privateGoogleSource("catalogId");
export const DEPARTMENTS = Object.freeze({
  roll: {
    name: "Рулонная печать",
    documentId: ROLL_PRINTING_SHEET_ID,
    template: ROLL_PRINTING_SHEET,
  },
  box: {
    name: "Бокс",
    documentId: privateGoogleSource("boxPrintingId"),
    template: { gid: 122063726, name: "OZON МОСКВА 10_10" },
  },
});
const operationsKey = "productionSupplyOperations";
const registryKey = "productionSupplies";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message, status = 409) => {
  throw Object.assign(new Error(message), { code, status });
};
const articleKey = (article) =>
  String(article)
    .trim()
    .toUpperCase()
    .replace(/\(OZ\)$/u, "");

function indexPrintExtensions(rows) {
  const headers = rows[0] || [];
  const articleColumn = headers.findIndex(
    (value) => String(value || "").trim().toLocaleLowerCase("ru-RU") === "артикул",
  );
  const extensionColumn = headers.findIndex((value) =>
    ["расширение печати", "расширения"].includes(
      String(value || "").trim().toLocaleLowerCase("ru-RU"),
    ),
  );
  if (articleColumn < 0 || extensionColumn < 0)
    fail(
      "catalog_extension_schema_changed",
      "Во вкладке «расширения» не найдены колонки «Артикул» и «Расширение печати». Новая поставка не создавалась.",
    );
  const index = new Map();
  for (const row of rows.slice(1)) {
    const article = String(row[articleColumn] || "").trim();
    const extension = String(row[extensionColumn] || "").trim().toUpperCase();
    if (!article || !extension || extension.startsWith("#")) continue;
    const key = articleKey(article);
    const previous = index.get(key);
    if (!previous) index.set(key, { value: extension });
    else if (previous.value !== extension) previous.conflict = true;
  }
  return index;
}

export function machineDepartment(machine) {
  const key = String(machine || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/gu, " ");
  if (["2-GO", "УФ", "УФ БЕЛ.", "УФ. БЕЛ", "УФ БЕЛЫЙ", "УФ ДВУСТОРОННИЙ"].includes(key))
    return "roll";
  if (["УФ ПЛАНШЕТ", "DTF", "XEROX"].includes(key)) return "box";
  return null;
}

export function shipmentMarketplace(name) {
  const text = String(name).toUpperCase();
  const ozon = /(?:^|[^\p{L}\p{N}])OZON(?=$|[^\p{L}\p{N}])/u.test(text);
  const wb = /(?:^|[^\p{L}\p{N}])WB(?=$|[^\p{L}\p{N}])/u.test(text);
  return ozon === wb ? null : ozon ? "OZON" : "WB";
}

export function routeAssemblyCatalogLines(lines, entries, name, {stock = false} = {}) {
  const shopMatches = [...String(name).matchAll(/(?:магазин\s*([12])(?!\d)|(?<!\d)([12])\s*(?:[-‑–]\s*)?(?:й|ый)?\s*магазин)/giu)];
  const shops = new Set(shopMatches.map(match => match[1] || match[2]));
  const selectedShop = shops.size === 1 ? [...shops][0] : "";
  const index = new Map();
  for (const entry of entries) {
    const matches = index.get(entry.article) || [];
    matches.push(entry);
    index.set(entry.article, matches);
  }
  const validValue = value => typeof value === "string" && !value.trim().startsWith("#") ? value.trim() : "";
  const unique = (entries, key) => new Set(entries.map(entry => validValue(entry[key])));
  return lines.map(line => {
    const candidates = index.get(line.article.trim().normalize("NFC").toUpperCase()) || [];
    const scoped = selectedShop ? candidates.filter(entry => entry.store === selectedShop) : candidates;
    const primary = scoped.filter(entry => entry.primary);
    const matches = primary.length ? primary : scoped;
    const skip = issue => ({ ...line, machine: "", department: null, issue });
    if (!matches.length) return skip(selectedShop
      ? "Артикул не найден в справочнике Assembly для указанного магазина"
      : "Артикул не найден в справочнике Assembly");
    const machines = unique(matches, "machine");
    const extensions = unique(matches, "printExtension");
    if (machines.size !== 1 || extensions.size !== 1)
      return skip("В справочнике Assembly расходятся станок или расширение печати. Укажите магазин или проверьте карточку.");
    const machine = [...machines][0], extension = [...extensions][0], department = machineDepartment(machine);
    const stores = unique(matches, "store");
    const store = stores.size === 1 && /^\d+$/.test([...stores][0]) ? [...stores][0] : "";
    const issue = !department ? "Станок в справочнике Assembly не задан или не распознан"
      : department === "roll" && !extension ? "В справочнике Assembly не задано расширение печати"
      : xeroxExtensionIssue(department, machine, extension);
    const result = { ...line, machine, department: issue ? null : department, extension: extension || null,
      store, storeIssue: store ? null : "Магазин не подтверждён в справочнике Assembly", issue, assemblyCatalog: true };
    const singleNumber = key => {
      const values = unique(matches, key);
      const value = values.size === 1 ? Number([...values][0].replace(",", ".")) : 0;
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    };
    if (stock) {
      const photos = new Set(matches.map(entry=>entry.photoUrl).filter(Boolean));
      return {...result, photoUrl:photos.size===1 ? [...photos][0] : "",
        sheetsPerUnit:singleNumber("sheetsPerUnit"),
        stockMultiplicity:singleNumber(department==="roll"?"rollMultiplicity":"xeroxMultiplicity")};
    }
    if (issue) return result;
    if (department === "roll") {
      const rollMultiplicity = singleNumber("rollMultiplicity");
      if (!rollMultiplicity) {
        return { ...result, rollIssue: "В справочнике Assembly не подтверждена кратность рулонной печати." };
      }
      const choices = quantityRounding(line.quantity, rollMultiplicity, { minimum: 0, maximum: MAX_SUPPLY_QUANTITY });
      return { ...result, rollMultiplicity, ...(choices && { rounding: { choices } }) };
    }
    if (machine.toUpperCase() !== "XEROX") return result;
    const factors = unique(matches, "sheetsPerUnit"), multiplicities = unique(matches, "xeroxMultiplicity");
    const factor = factors.size === 1 ? Number([...factors][0]) : 0;
    const multiplicity = multiplicities.size === 1 ? Number([...multiplicities][0]) : 0;
    const formats = {xeroxFactor: factor, xeroxMultiplicity: multiplicity};
    const rounding = xeroxPlanRounding(line.quantity, factor, multiplicity, { minimum: 0, maximum: MAX_SUPPLY_QUANTITY });
    if (rounding) return { ...result, ...formats, rounding };
    const xeroxSheets = xeroxSheetCount(line.quantity, factor, multiplicity);
    return xeroxSheets === null
      ? { ...result, department: null, issue: "В справочнике Assembly не подтверждены листы на изделие и кратность Xerox." }
      : { ...result, ...formats, xeroxSheets };
  });
}

// Read the machine from the selected marketplace first. OZON's machine is a
// lookup into WB; an exact WB base-article lookup is its only allowed fallback.
export function routeSupplyLines(lines, marketplace, catalog) {
  if (!marketplace)
    fail(
      "supply_marketplace_unknown",
      "В названии поставки укажите ровно один маркетплейс: OZON или WB.",
    );
  const index = (rows, market) => {
    const headers = rows[0] || [];
    const machineColumn = headers.findIndex(
      (h) =>
        String(h).trim().toLowerCase() ===
        (market === "WB" ? "вид станка по умолчанию" : "станок"),
    );
    if (machineColumn < 0)
      fail("catalog_schema_changed", "В базе не найдена колонка станка.");
    const storeColumns = headers.flatMap((h, index) => String(h).trim().toLocaleLowerCase("ru-RU") === "магазин" ? [index] : []);
    if (storeColumns.length > 1)
      fail("catalog_schema_changed", `Во вкладке ${sheetName} найдено несколько колонок «Магазин».`);
    const storeColumn = storeColumns[0] ?? -1;
    const map = new Map();
    for (const row of rows.slice(1)) {
      const aliases = market === "OZON" ? [row[0], row[1]] : [row[0]];
      for (const alias of aliases) {
        if (!alias || String(alias).startsWith("#")) continue;
        const key = articleKey(alias);
        const machine = String(row[machineColumn] || "").trim();
        const storeValue = storeColumn < 0 ? "" : String(row[storeColumn] || "").trim();
        const prior = map.get(key);
        if (!prior) map.set(key, { machine, store: /^\d+$/.test(storeValue) ? storeValue : "", storeConflict: false });
        else {
          if (prior.machine.toUpperCase() !== machine.toUpperCase()) prior.conflict = true;
          if (/^\d+$/.test(storeValue)) {
            if (prior.store && prior.store !== storeValue) { prior.storeConflict = true; prior.store = ""; }
            else prior.store = storeValue;
          }
        }
      }
    }
    return map;
  };
  const wb = index(catalog.WB, "WB"),
    ozon = index(catalog.OZON, "OZON");
  const extensions = Array.isArray(catalog.extensions) && catalog.extensions.length
    ? indexPrintExtensions(catalog.extensions)
    : new Map();
  const seen = new Set();
  return lines.map((line) => {
    const key = articleKey(line.article);
    if (seen.has(key))
      return {
        ...line,
        machine: "",
        department: null,
        issue: "Артикул повторяется после нормализации",
      };
    seen.add(key);
    const selectedMarketRecord = (marketplace === "OZON" ? ozon : wb).get(key);
    let record = selectedMarketRecord;
    if (record?.conflict)
      return {
        ...line,
        machine: record.machine,
        department: null,
        issue: "Разные станки у одного артикула в базе",
      };
    if (
      marketplace === "OZON" &&
      (!record?.machine || record.machine.startsWith("#"))
    )
      record = wb.get(key);
    if (record?.conflict)
      return {
        ...line,
        machine: record.machine,
        department: null,
        issue: "Разные станки у одного артикула в базе WB",
      };
    const machine = record?.machine || "";
    const department = machineDepartment(machine);
    const extension = extensions.get(key);
    if (department === "roll" && (!extension || extension.conflict))
      return {
        ...line,
        machine,
        extension: "",
        department: null,
        issue: extension?.conflict
          ? "Для артикула в базе указаны разные расширения печати"
          : "Расширение печати не найдено во вкладке «расширения»",
      };
    const routingIssue = extension && !extension.conflict
      ? xeroxExtensionIssue(department, machine, extension.value)
      : null;
    if (routingIssue)
      return {...line, machine, extension: extension.value, department: null, issue: routingIssue};
    return {
      ...line,
      machine,
      department,
      store: selectedMarketRecord?.storeConflict ? "" : selectedMarketRecord?.store || "",
      storeIssue: selectedMarketRecord?.storeConflict ? "В базе указаны разные магазины" : selectedMarketRecord?.store ? null : "Магазин не подтверждён в базе выбранного маркетплейса",
      extension: extension && !extension.conflict ? extension.value : null,
      issue: department
        ? null
        : "Станок отсутствует, содержит ошибку или не относится к настроенным отделам",
    };
  });
}

export class ProductionSupplyWriter extends RollSupplySheetsWriter {
  constructor({ department, ...options }) {
    const target = DEPARTMENTS[department];
    if (!target) throw new TypeError("Unknown production department");
    super({
      ...options,
      documentId: target.documentId,
      template: target.template,
      box: department === "box",
    });
  }
  async xeroxFormats(marketplace, articles) {
    // Box templates use these lookups for columns G (sheets) and N (Xerox layout).
    const ranges = [
      "'_RITM_МАКЕТЫ'!A:A", "'_RITM_МАКЕТЫ'!P:P",
      "'_RITM_WB_SOURCE'!A:A", "'_RITM_WB_SOURCE'!B:B",
      ...(marketplace === "OZON" ? ["'Cache FBO'!B:B", "'Cache FBO'!F:F"] : []),
    ];
    const params = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE", majorDimension: "COLUMNS" });
    for (const range of ranges) params.append("ranges", range);
    const data = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.documentId}/values:batchGet?${params}`,
    );
    if (data.spreadsheetId !== this.documentId || data.valueRanges?.length !== ranges.length)
      fail("production_xerox_source_unavailable", "Не удалось проверить параметры Xerox в таблице бокса.", 503);
    const columns = data.valueRanges.map(range => range.values?.[0] || []);
    if (columns[0][0] !== "Артикул" || columns[1][0] !== "Xerox")
      fail("production_xerox_source_unavailable", "В таблице макетов изменились колонки Xerox. Проверьте справочник.", 503);
    const needed = new Set(articles);
    const read = (keys, values) => {
      const byArticle = new Map();
      keys?.forEach((key, row) => {
        const article = String(key).toUpperCase();
        if (needed.has(article) && !byArticle.has(article))
          byArticle.set(article, values[row]);
      });
      return byArticle;
    };
    const multiplicities = read(columns[0], columns[1]);
    const wb = read(columns[2], columns[3]);
    const ozon = read(columns[4], columns[5]);
    return new Map(articles.map(article => {
      const ozonFactor = ozon.get(article);
      const useWb = ozonFactor == null || ozonFactor === "" || ozonFactor === 0 || ozonFactor === "#N/A";
      return [article, { factor: useWb ? wb.get(article) : ozonFactor, multiplicity: multiplicities.get(article) }];
    }));
  }
  async verifyEditAccess() {
    // The Sites writer token is scoped to Google Sheets, and its cloud fetch
    // guard intentionally rejects Drive API calls. Preparation reads the exact
    // target through Sheets; the first journaled batchUpdate is the authoritative
    // write-permission check, so a denial remains recoverable in the operation log.
    return true;
  }
  async manifest(sheetId) {
    const data = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.documentId}?fields=sheets(properties(sheetId),developerMetadata(metadataKey,metadataValue))`,
    );
    const sheet = data.sheets?.find((s) => s.properties.sheetId === sheetId);
    if (!sheet)
      fail(
        "production_sheet_missing",
        "Лист производственного задания не найден.",
      );
    const records = (sheet.developerMetadata || []).filter(
      (m) => m.metadataKey === "RITM_SUPPLY",
    );
    if (records.length > 1)
      fail(
        "production_manifest_conflict",
        "У листа несколько связей с поставками. Запись остановлена.",
      );
    try {
      return records.length ? JSON.parse(records[0].metadataValue) : null;
    } catch {
      fail(
        "production_manifest_invalid",
        "Связь производственного задания повреждена.",
      );
    }
  }
  async publish(plan, manifest) {
    const current = await this.manifest(plan.sheetId);
    if (
      !current ||
      digest({ ...current, ready: false }) !==
        digest({ ...manifest, ready: false })
    )
      fail(
        "production_manifest_changed",
        "Связь поставки изменилась. Продолжение остановлено.",
      );
    if (current.ready === true) return;
    await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.documentId}:batchUpdate`,
      {
        method: "POST",
        body: {
          requests: supplyManifestRequests(plan.sheetId, {
            ...manifest,
            ready: true,
          }),
        },
        write: true,
      },
    );
    const verified = await this.manifest(plan.sheetId);
    if (digest(verified) !== digest({ ...manifest, ready: true }))
      fail(
        "production_manifest_unverified",
        "Не удалось подтвердить готовность общего состава поставки.",
      );
  }
}

export class ProductionSupplyService {
  constructor(
    store,
    { writers, legacy, now = () => Date.now(), refresh = null, refreshAfterWrite = true, recoverInterrupted = true, beforeCreateWrite = null, onVerified = null, createCatalog = null } = {},
  ) {
    Object.assign(this, { store, writers, legacy, now, refresh, refreshAfterWrite, beforeCreateWrite, onVerified, createCatalog });
    this.previews = new Map();
    this.busy = false;
    // An interrupted write is never replayed. Its exact persisted plan must be
    // verified before the owner can continue the remaining, unsent steps.
    for (const candidate of recoverInterrupted ? this.operations() : []) {
      if (!candidate.steps?.some(step => step.status === "writing") && !(candidate.status === "writing" && candidate.steps?.length && candidate.steps.every(step => step.status === "verified"))) continue;
      const op = structuredClone(candidate);
      let changed = false;
      for (const step of op.steps)
        if (step.status === "writing") {
          step.status = "uncertain";
          changed = true;
        }
      const unfinishedCommit = op.status === "writing" && op.steps.length > 0 && op.steps.every(step => step.status === "verified");
      if (changed || unfinishedCommit) {
        op.status = "partial";
        if (unfinishedCommit) op.message = "Состав отделов сохранён и проверен. Требуется завершить подтверждение общей поставки.";
        this.save(op);
      }
    }
  }
  operations() {
    if (typeof this.store.productionSupplyOperations === "function") return this.store.productionSupplyOperations();
    return this.store.meta(operationsKey) || [];
  }
  save(op) {
    op.updatedAt = new Date(this.now()).toISOString();
    if (typeof this.store.saveProductionSupplyOperation === "function")
      this.store.saveProductionSupplyOperation(op);
    else this.store.meta(operationsKey, [
      ...this.operations().filter((p) => p.id !== op.id),
      op,
    ]);
    if (op.status === 'verified') this.onVerified?.(op);
  }
  remainingSkipped(op, history) {
    if (!op.skippedLines?.length) return [];
    const index = history.findIndex((item) => item.id === op.id);
    const addedLater = new Set(
      history
        .slice(index + 1)
        .filter(
          (item) =>
            item.status === "verified" && item.shipmentId === op.shipmentId,
        )
        .flatMap((item) => item.steps.flatMap((step) => step.lines))
        .map((line) => articleKey(line.article)),
    );
    return (op.skippedLines || []).filter(
      (line) => !addedLater.has(articleKey(line.article)),
    );
  }
  publicOperation(op, history = this.operations()) {
    const accepted = (op.steps || []).flatMap((step) => step.lines || []);
    return {
      id: op.id,
      action: op.action,
      status: op.status,
      name: op.name,
      sheetId:
        op.sheetId ||
        op.steps.find((s) => s.department === "roll")?.plan?.sheetId ||
        null,
      rows: accepted.length,
      skippedLines: this.remainingSkipped(op, history),
      retryTarget: op.manifest?.parts[0]
        ? {
            sheetId: op.manifest.parts[0].sheetId,
            department: op.manifest.parts[0].department,
          }
        : null,
      message: op.message || null,
      spreadsheetUrl: "",
      updatedAt: op.updatedAt,
      department: op.department || null,
      steps: (op.steps || []).map((s) => ({
        department: s.department,
        name: DEPARTMENTS[s.department].name,
        status: s.status,
        rows: s.lines.length,
        message: s.message || null,
        spreadsheetUrl: s.plan
          ? `https://docs.google.com/spreadsheets/d/${DEPARTMENTS[s.department].documentId}/edit#gid=${s.plan.sheetId}`
          : "",
      })),
    };
  }
  state() {
    const history = this.operations().filter(op => op.status !== "cancelled");
    return {
      available: !!this.writers?.roll && !!this.writers?.box,
      busy: this.busy,
      operations: history
        .filter(
          (op, index) =>
            (!["deletePart", "deleteSupply"].includes(op.action) || op.status !== "verified") &&
            (index >= history.length - 100 ||
              op.status !== "verified" ||
              this.remainingSkipped(op, history).length),
        )
        .reverse()
        .map((op) => this.publicOperation(op, history)),
      supplies: this.store.meta(registryKey) || [],
    };
  }
  async prepareDeletePart(input) {
    const whole = input?.action === "deleteSupply";
    const required = [
      "action",
      "explicitWriteApproval",
      "name",
      "operationId",
      ...(whole ? ["shipmentId"] : ["department", "sheetId"]),
    ].sort();
    if (
      !input ||
      Object.keys(input).sort().join(",") !== required.join(",") ||
      (!whole && input.action !== "deletePart") ||
      input.explicitWriteApproval !== true ||
      (whole ? !/^RITM-(SUPPLY-[a-f0-9-]{36}|ROLL-\d+|BOX-\d+)$/i.test(input.shipmentId || "") :
        !["roll", "box"].includes(input.department) || !Number.isSafeInteger(input.sheetId) || input.sheetId <= 0) ||
      !/^[a-f0-9-]{36}$/i.test(input.operationId || "") ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.trim() !== input.name ||
      input.name.length > 100 ||
      /[:\\/?*\[\]]/.test(input.name)
    )
      fail(
        "production_delete_part_invalid",
        "Подтвердите точный лист и отдел, который нужно удалить.",
        400,
      );
    const supply = (this.store.meta(registryKey) || []).find((candidate) =>
      whole ? candidate.id === input.shipmentId : candidate.parts?.some(
        (part) =>
          part.department === input.department &&
          part.sheetId === input.sheetId,
      ),
    );
    if (!supply || supply.name !== input.name)
      fail(
        "production_delete_part_unregistered",
        "Этот лист не найден в подтверждённом составе общей поставки. Обновите список.",
      );
    const targets = whole ? supply.parts : supply.parts.filter(
      (part) => part.department === input.department && part.sheetId === input.sheetId);
    if (!targets?.length || targets.some(part =>
      !DEPARTMENTS[part.department] || part.sheetId === DEPARTMENTS[part.department].template.gid))
      fail("production_delete_template_forbidden", "Лист-шаблон отдела производства удалять нельзя.", 403);
    const [target] = targets;
    const before = await this.writers[target.department].manifest(target.sheetId);
    if (
      !before ||
      before.ready !== true ||
      before.id !== supply.id ||
      before.name !== supply.name ||
      !before.parts.some(
        (part) =>
          part.department === target.department &&
          part.documentId === DEPARTMENTS[target.department].documentId &&
          part.sheetId === target.sheetId,
      )
    )
      fail(
        "production_delete_manifest_changed",
        "Связь отдела с общей поставкой изменилась. Удаление остановлено.",
      );
    const registeredParts = supply.parts
      .map(({ department, documentId, sheetId }) => ({
        department,
        documentId,
        sheetId,
      }))
      .sort((a, b) => a.department.localeCompare(b.department));
    const manifestParts = before.parts
      .map(({ department, documentId, sheetId }) => ({
        department,
        documentId,
        sheetId,
      }))
      .sort((a, b) => a.department.localeCompare(b.department));
    if (digest(registeredParts) !== digest(manifestParts))
      fail(
        "production_delete_manifest_conflict",
        "Состав листов в реестре не совпадает со связью в таблице.",
      );
    const survivors = whole ? [] : before.parts.filter(
      (part) =>
        !(
          part.department === input.department &&
          part.sheetId === input.sheetId
        ),
    );
    if (!whole && survivors.length !== before.parts.length - 1)
      fail(
        "production_delete_manifest_conflict",
        "Состав листов в реестре не совпадает со связью в таблице.",
      );
    for (const part of supply.parts) {
      const writer = this.writers[part.department];
      const metadata = await writer.metadata();
      const sheet = metadata.find((item) => item.sheetId === part.sheetId);
      if (!sheet || sheet.title !== (part.name || supply.name))
        fail(
          "production_delete_sheet_changed",
          "Название или ID одной из частей поставки изменились. Удаление остановлено.",
        );
      if (digest(await writer.manifest(part.sheetId)) !== digest(before))
        fail(
          "production_delete_manifest_conflict",
          "Оба отдела должны иметь одну и ту же подтверждённую связь перед удалением.",
        );
    }
    const plans = await Promise.all(targets.map(async part => ({
      department: part.department,
      plan: await this.writers[part.department].prepareDelete({ name: part.name || input.name, sheetId: part.sheetId }),
    })));
    return {
      id: input.operationId,
      action: input.action,
      requestHash: digest(input),
      shipmentId: supply.id,
      name: supply.name,
      department: input.department || null,
      sheetId: input.sheetId || null,
      status: "writing",
      message: null,
      steps: [],
      lines: [],
      ...(whole ? { deletePlans: plans } : { deletePlan: plans[0].plan }),
      manifestBefore: before,
      manifestAfter: survivors.length
        ? {
            ...before,
            revision: input.operationId,
            parts: survivors,
            ready: true,
          }
        : null,
      survivors,
    };
  }
  async runDeletePart(op) {
    const pending = this.operations().find(
      (candidate) => candidate.id !== op.id && !["verified", "cancelled"].includes(candidate.status),
    );
    if (
      pending ||
      this.legacy?.writeConflict(
        Object.values(DEPARTMENTS).map((department) => department.documentId),
      )
    )
      fail(
        "production_operation_pending",
        "Сначала завершите сверку предыдущей операции с поставкой.",
      );
    this.busy = true;
    if (this.legacy) this.legacy.busy = true;
    try {
      const plans = op.deletePlans || [{ department: op.department, plan: op.deletePlan }];
      const remaining = await Promise.all(plans.map(async ({ department, plan }) => {
        const writer = this.writers[department];
        const sheet = (await writer.metadata()).find(row => row.sheetId === plan.sheetId);
        if (!sheet) return null;
        if (sheet.title !== plan.name)
          fail("production_delete_sheet_changed", "Название листа изменилось после подтверждения. Удаление остановлено.");
        if (digest(await writer.manifest(plan.sheetId)) !== digest(op.manifestBefore))
          fail("production_delete_manifest_changed", "Связь листа изменилась после подтверждения. Удаление остановлено.");
        return { writer, plan };
      }));
      for (const item of remaining) {
        if (!item) continue;
        await item.writer.execute(item.plan);
        op.status = "checking";
        this.save(op);
        await item.writer.verify(item.plan);
      }
      for (const part of op.survivors) {
        const survivorWriter = this.writers[part.department];
        const current = await survivorWriter.manifest(part.sheetId);
        if (digest(current) === digest(op.manifestAfter)) continue;
        if (digest(current) !== digest(op.manifestBefore))
          fail(
            "production_delete_survivor_manifest_changed",
            "Связь оставшегося отдела изменилась. Общий состав сохранён до сверки.",
          );
        await survivorWriter.request(
          `https://sheets.googleapis.com/v4/spreadsheets/${survivorWriter.documentId}:batchUpdate`,
          {
            method: "POST",
            body: {
              requests: supplyManifestRequests(part.sheetId, op.manifestAfter),
            },
            write: true,
          },
        );
        if (digest(await survivorWriter.manifest(part.sheetId)) !== digest(op.manifestAfter))
          fail(
            "production_delete_manifest_unverified",
            "Лист отдела удалён, но новый общий состав пока не подтверждён.",
            503,
          );
      }
      const registry = this.store.meta(registryKey) || [];
      const registered = registry.find((item) => item.id === op.shipmentId);
      if (!registered)
        fail(
          "production_delete_registry_changed",
          "Состав в локальном реестре изменился. Требуется сверка.",
        );
      this.store.meta(
        registryKey,
        op.survivors.length
          ? registry.map((item) =>
              item.id === op.shipmentId
                ? {
                    ...item,
                    parts: op.survivors.map((part) => ({
                      ...part,
                      name: item.name,
                    })),
                  }
                : item,
            )
          : registry.filter((item) => item.id !== op.shipmentId),
      );
      const deletedRollIds = new Set(plans.filter(item => item.department === "roll").map(item => item.plan.sheetId));
      if (deletedRollIds.size)
        this.store.meta(
          "rollPrintingAdditionalSheets",
          (this.store.meta("rollPrintingAdditionalSheets") || []).filter(
            (sheet) => !deletedRollIds.has(sheet.gid),
          ),
        );
      const retired = new Set(this.store.meta("retiredProductionTabs") || []);
      for (const { department, plan } of plans) retired.add(`${department}:${plan.sheetId}`);
      this.store.meta("retiredProductionTabs", [...retired]);
      op.status = "verified";
      op.message = op.action === "deleteSupply"
        ? "Поставка удалена из рабочих таблиц. Состав нового Assembly обновляется."
        : op.survivors.length
        ? `Удалена часть «${DEPARTMENTS[op.department].name}». Вторая часть поставки сохранена.`
        : `Удалена последняя часть «${DEPARTMENTS[op.department].name}»; общая поставка снята со сборки.`;
      this.save(op);
      this.store.log("production_supply_department_deleted", op.message, null);
      try {
        if (this.refreshAfterWrite) await this.refresh?.();
      } catch {
        /* Verified sheet and manifest state remain authoritative. */
      }
      return this.publicOperation(op);
    } catch (error) {
      op.status = "partial";
      op.message = error.message || "Удаление требует сверки.";
      this.save(op);
      return this.publicOperation(op);
    } finally {
      this.busy = false;
      if (this.legacy) this.legacy.busy = false;
    }
  }
  async catalog() {
    const writer = this.writers.roll;
    const meta = await writer.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${CATALOG_ID}?fields=sheets(properties(title,hidden,gridProperties(rowCount,columnCount)))`,
    );
    const ranges = [];
    for (const name of ["WB", "OZON"]) {
      const sheet = meta.sheets?.find(
        (s) => s.properties.title === name && !s.properties.hidden,
      )?.properties;
      if (
        !sheet ||
        sheet.gridProperties.rowCount > 30000 ||
        sheet.gridProperties.columnCount < 15
      )
        fail(
          "catalog_unavailable",
          "Не удалось подтвердить рабочие вкладки базы товаров.",
        );
      ranges.push(`'${name}'!A1:O${sheet.gridProperties.rowCount}`);
    }
    const extensionSheet = meta.sheets?.find(
      (s) => s.properties.title.trim().toLocaleLowerCase("ru-RU") === "расширения" && !s.properties.hidden,
    )?.properties;
    if (
      !extensionSheet ||
      extensionSheet.gridProperties.rowCount > 30000 ||
      extensionSheet.gridProperties.columnCount < 2
    )
      fail(
        "catalog_extension_unavailable",
        "Не удалось прочитать вкладку «расширения» базы. Новая поставка не создавалась.",
        503,
      );
    ranges.push(`'расширения'!A1:B${extensionSheet.gridProperties.rowCount}`);
    const params = new URLSearchParams({
      valueRenderOption: "FORMATTED_VALUE",
    });
    ranges.forEach((r) => params.append("ranges", r));
    const data = await writer.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${CATALOG_ID}/values:batchGet?${params}`,
    );
    if (data.spreadsheetId !== CATALOG_ID || data.valueRanges?.length !== 3)
      fail("catalog_unavailable", "База товаров не прочитана полностью.");
    return {
      WB: data.valueRanges[0].values || [],
      OZON: data.valueRanges[1].values || [],
      extensions: data.valueRanges[2].values || [],
    };
  }
  normalize(input) {
    const { previewId, department, priority, reminderMinutes, planning, xeroxRounding, rollRounding, ...raw } = input || {};
    if (reminderMinutes !== undefined && (raw.action !== "create" || priority !== "urgent" || ![0, 30, 60, 120, 240].includes(reminderMinutes)))
      fail("production_reminder_invalid", "Выберите время напоминания для срочной поставки.", 400);
    if (priority !== undefined && (raw.action !== 'create' || !['normal', 'urgent'].includes(priority)))
      fail('production_priority_invalid', 'Выберите обычную или срочную поставку.', 400);
    if (raw.action === 'create' && priority === 'urgent') {
      if (typeof raw.name !== 'string' || raw.name.trim().length > 97)
        fail('production_priority_name_invalid', 'Для срочной поставки сократите название до 97 символов.', 400);
      raw.name = `${raw.name.trim().replace(/\s*🔥$/u, '')} 🔥`;
    }
    let dates;
    if (planning !== undefined) {
      if (raw.action !== 'create') fail('production_planning_invalid','Даты задаются при создании поставки.',400);
      try { dates = validateDeadlines(planning); } catch(error) { fail('production_planning_invalid',error.message,400); }
    }
    const payload = validateRollSupplyPayload(raw);
    if (dates) payload.planning = dates;
    if (payload.action === 'create' && priority !== undefined) payload.priority = priority;
    if (reminderMinutes !== undefined) payload.reminderMinutes = reminderMinutes;
    if (!["create", "append"].includes(payload.action))
      fail(
        "production_action_invalid",
        "Неизвестное действие с составом поставки.",
      );
    if (department !== undefined && !["roll", "box"].includes(department))
      fail("production_department_invalid", "Неизвестный отдел производства.");
    if (payload.action === "append") payload.department = department || "roll";
    const readChoices = (choices, kind, message) => {
      const selected = new Map();
      if (choices === undefined) return selected;
      if (payload.action !== "create" || !Array.isArray(choices) || choices.length > payload.lines.length)
        fail(`production_${kind}_rounding_required`, message, 400);
      for (const choice of choices) {
        const article = typeof choice?.article === "string" ? articleKey(choice.article) : "";
        if (!article || article.length > 120 || selected.has(article) ||
            Object.keys(choice).sort().join(",") !== "article,direction" ||
            !["down", "up"].includes(choice.direction))
          fail(`production_${kind}_rounding_required`, message, 400);
        selected.set(article, choice.direction);
      }
      return selected;
    };
    const decisions = {
      xerox: readChoices(xeroxRounding, "xerox", "Проверьте выбранное округление Xerox."),
      roll: readChoices(rollRounding, "roll", "Проверьте выбранное округление для рулонной печати."),
    };
    return { payload, previewId, decisions };
  }
  async routedLines(payload) {
    const marketplace = shipmentMarketplace(payload.name);
    if (payload.action === "create" && this.createCatalog) {
      if (!marketplace) fail("supply_marketplace_unknown", "В названии поставки укажите ровно один маркетплейс: OZON или WB.");
      return routeAssemblyCatalogLines(payload.lines, await this.createCatalog(marketplace, payload.lines.map(line => line.article)), payload.name);
    }
    const routed = routeSupplyLines(payload.lines, marketplace, await this.catalog());
    if (payload.action !== "create") return routed;
    const isXerox = line => line.department === "box" && line.machine.toUpperCase() === "XEROX";
    const articles = routed.filter(isXerox).map(line => articleKey(line.article));
    if (!articles.length) return routed;
    const formats = await this.writers.box.xeroxFormats(marketplace, articles);
    return routed.map(line => {
      if (!isXerox(line)) return line;
      const { factor, multiplicity } = formats.get(articleKey(line.article)) || {};
      const rounding = xeroxPlanRounding(line.quantity, factor, multiplicity, { minimum: 0, maximum: MAX_SUPPLY_QUANTITY });
      if (rounding) return { ...line, rounding };
      const xeroxSheets = xeroxSheetCount(line.quantity, factor, multiplicity);
      return xeroxSheets === null
        ? { ...line, xeroxIssue: "Нет подтверждённых параметров Xerox для расчёта листов." }
        : { ...line, xeroxSheets };
    });
  }
  async preview(input) {
    if (!this.state().available)
      fail(
        "production_writer_unavailable",
        "Запись в оба отдела пока не настроена.",
        503,
      );
    const { payload, decisions } = this.normalize(input);
    if (decisions.roll.size || decisions.xerox.size)
      fail(decisions.roll.size ? "production_roll_rounding_required" : "production_xerox_rounding_required",
        "Выберите округление после проверки распределения.", 400);
    const routed = await this.routedLines(payload);
    const id = randomUUID();
    const value = {
      id,
      hash: digest(payload),
      payload,
      routed,
      at: this.now(),
    };
    this.previews.set(id, value);
    this.store.saveTransferPreview?.("production:" + id, value.at + 600000, JSON.stringify(value));
    for (const [key, prior] of this.previews)
      if (this.now() - prior.at > 600000) this.previews.delete(key);
    return {
      id,
      lines: routed,
      blocked: !routed.some((l) => l.department),
      acceptedRows: routed.filter((l) => l.department).length,
      skippedRows: routed.filter((l) => !l.department).length,
      departments: Object.entries(DEPARTMENTS).map(([id, d]) => ({
        id,
        name: d.name,
        rows: routed.filter((l) => l.department === id).length,
        quantity: routed
          .filter((l) => l.department === id)
          .reduce((a, l) => a + l.quantity, 0),
      })),
    };
  }
  previewById(id) {
    const stored = this.store.transferPreview?.("production:" + id);
    if (stored?.payload) {
      try { return JSON.parse(stored.payload); } catch { return null; }
    }
    return this.previews.get(id) || null;
  }
  async prepare(payload, routed) {
    const registry = this.store.meta(registryKey) || [];
    const selectedDepartment = payload.department || "roll";
    const existing =
      payload.action === "append"
        ? registry.find((s) =>
            s.parts.some(
              (p) =>
                p.department === selectedDepartment &&
                p.sheetId === payload.sheetId,
            ),
          )
        : null;
    if (payload.action === "append" && !existing) {
      const registered =
        selectedDepartment === "roll"
          ? [
              { gid: ROLL_PRINTING_SHEET.gid, name: ROLL_PRINTING_SHEET.name },
              ...(this.store.meta("rollPrintingAdditionalSheets") || []),
            ]
          : [];
      if (
        !registered.some(
          (s) => s.gid === payload.sheetId && s.name === payload.name,
        )
      )
        fail(
          "production_target_unregistered",
          "Выбранный лист не зарегистрирован как поставка. Обновите список.",
        );
    }
    if (existing && existing.name !== payload.name)
      fail(
        "production_supply_renamed",
        "Название общей поставки изменилось. Обновите список перед добавлением.",
      );
    const id =
      existing?.id ||
      (payload.action === "append"
        ? `RITM-${selectedDepartment.toUpperCase()}-${payload.sheetId}`
        : `RITM-SUPPLY-${payload.operationId}`);
    const steps = [];
    if (existing) {
      const incoming = new Set(
        routed.filter((l) => l.department).map((l) => articleKey(l.article)),
      );
      for (const part of existing.parts) {
        const writer = this.writers[part.department];
        const meta = (await writer.metadata()).find(
          (s) =>
            s.sheetId === part.sheetId &&
            s.title === (part.name || existing.name),
        );
        if (!meta || meta.gridProperties?.rowCount > 4096)
          fail(
            "production_target_changed",
            "Лист общей поставки изменился или превышает безопасный диапазон проверки.",
          );
        const grid = await writer.grid(
          part.name || existing.name,
          meta.gridProperties.rowCount,
        );
        for (const data of grid.data || [])
          for (let i = 0; i < (data.rowData || []).length; i++) {
            if (i + (data.startRow || 0) < 4) continue;
            const cell = data.rowData[i].values?.[4 - (data.startColumn || 0)];
            const article = cell?.userEnteredValue?.stringValue || "";
            if (article && incoming.has(articleKey(article)))
              fail(
                "production_article_exists",
                `Артикул «${article}» уже есть в одном из отделов этой поставки.`,
              );
          }
      }
    }
    for (const department of Object.keys(DEPARTMENTS)) {
      const lines = routed
        .filter((l) => l.department === department)
        .map(({ article, quantity, extension, assemblyCatalog, machine, store, xeroxFactor, xeroxMultiplicity }) => ({
          article,
          quantity,
          ...(extension ? { extension } : {}),
          ...(assemblyCatalog ? {catalogMachine:machine, store, ...(xeroxFactor ? {xeroxFactor, xeroxMultiplicity} : {})} : {}),
        }));
      const part =
        existing?.parts.find((p) => p.department === department) ||
        (payload.action === "append" && department === selectedDepartment
          ? { sheetId: payload.sheetId, name: payload.name }
          : null);
      // Include an unchanged existing department in the commit handshake.
      if (!lines.length && !part) continue;
      const writer = this.writers[department];
      let plan;
      if (part) {
        const current = await writer.manifest(part.sheetId);
        if (current && (current.id !== id || !current.ready))
          fail(
            "production_supply_pending",
            "Связанное задание принадлежит другой или незавершённой поставке.",
          );
        if (lines.length)
          plan = await writer.prepareAppend({
            ...payload,
            sheetId: part.sheetId,
            name: part.name || payload.name,
            lines,
            registeredSheets: [
              { gid: part.sheetId, name: part.name || payload.name },
            ],
          });
        else {
          await writer.verifyEditAccess();
          plan = {
            action: "manifest",
            sheetId: part.sheetId,
            name: part.name || payload.name,
          };
        }
      } else plan = await writer.prepareCreate({ ...payload, lines });
      steps.push({ department, lines, plan, status: "pending" });
    }
    const parts = steps.map((s) => ({
      department: s.department,
      documentId: DEPARTMENTS[s.department].documentId,
      sheetId: s.plan.sheetId,
    }));
    const manifest = {
      version: 1,
      id,
      name: payload.name,
      revision: payload.operationId,
      parts,
      ready: false,
    };
    for (const step of steps) step.plan.manifest = manifest;
    return {
      id: payload.operationId,
      shipmentId: id,
      action: payload.action,
      name: payload.name,
      ...(payload.action === 'create' && payload.priority ? { priority: payload.priority } : {}),
      ...(payload.action === 'create' && payload.reminderMinutes !== undefined ? { reminderMinutes: payload.reminderMinutes } : {}),
      createdAt: new Date(this.now()).toISOString(),
      ...(payload.action === "create" && payload.lockAfterCreate === true ? { lockAfterCreate: true } : {}),
      lines: payload.lines,
      skippedLines: routed.filter((l) => !l.department && l.quantity > 0),
      ...(routed.some(line => line.assemblyCatalog) ? {catalogStores: Object.fromEntries(
        routed.filter(line => line.department).map(line => [line.article.trim().normalize("NFC").toUpperCase(), line.store]),
      )} : {}),
      ...(payload.planning ? {planning:payload.planning} : {}),
      requestHash: digest(payload),
      status: "writing",
      steps,
      manifest,
    };
  }
  async cancelAbsentCreate(input) {
    if (input.explicitWriteApproval !== true || Object.keys(input).sort().join() !== ["action", "operationId", "explicitWriteApproval"].sort().join())
      fail("production_confirmation_required", "Подтвердите отмену операции.");
    const op = this.operations().find(item => item.id === input.operationId);
    if (!op) fail("production_operation_missing", "Операция не найдена.", 404);
    if (op.status === "cancelled") return this.publicOperation(op);
    if (op.action !== "create" || op.status === "verified" || !op.steps?.length || op.steps.some(step => step.plan?.action !== "create"))
      fail("production_cancel_not_safe", "Отменить так можно только незавершённое создание новой поставки.");
    for (const step of op.steps) {
      const started = Date.parse(step.writeStartedAt || op.updatedAt);
      if (!Number.isFinite(started) || this.now() - started <= 180000)
        fail("production_cancel_wait", "Предыдущий запрос ещё может выполняться. Повторите отмену через три минуты.");
      const sheets = await this.writers[step.department].metadata();
      if (sheets.some(sheet => sheet.sheetId === step.plan.sheetId || sheet.title === op.name))
        fail("production_cancel_sheet_exists", "Часть поставки уже есть в таблице. Автоматическая отмена остановлена для сохранности данных.");
    }
    op.status = "cancelled";
    op.cancelledAt = new Date(this.now()).toISOString();
    op.message = "Создание отменено: отсутствие листов проверено в обоих отделах. Можно создать новую поставку.";
    this.save(op);
    this.store.log("production_supply_cancelled", op.message, null);
    return this.publicOperation(op);
  }
  async execute(input) {
    if (input?.action === "cancelAbsentCreate") return this.cancelAbsentCreate(input);
    if (!this.state().available)
      fail(
        "production_writer_unavailable",
        "Запись в оба отдела пока не настроена.",
        503,
      );
    if (["deletePart", "deleteSupply"].includes(input?.action)) {
      const same = this.operations().find((item) => item.id === input.operationId);
      if (same) {
        if (same.requestHash !== digest(input))
          fail(
            "production_operation_conflict",
            "Этот ID уже использован для другого действия.",
          );
        return this.publicOperation(same);
      }
      const op = await this.prepareDeletePart(input);
      if (this.busy || this.legacy?.busy)
        fail("production_operation_active", "Дождитесь завершения текущей операции.");
      const pending = this.operations().find((item) => !["verified", "cancelled"].includes(item.status));
      if (
        pending ||
        this.legacy?.writeConflict(
          Object.values(DEPARTMENTS).map((department) => department.documentId),
        )
      )
        fail(
          "production_operation_pending",
          "Сначала завершите сверку предыдущей операции с поставкой.",
        );
      this.save(op);
      return this.runDeletePart(op);
    }
    const resume = input?.action === "resume";
    let payload, op, decisions, requestHash;
    if (resume) {
      if (
        Object.keys(input).sort().join() !==
          ["action", "explicitWriteApproval", "operationId"].sort().join() ||
        input.explicitWriteApproval !== true
      )
        fail(
          "production_confirmation_required",
          "Подтвердите продолжение этой операции.",
        );
      op = structuredClone(this.operations().find((o) => o.id === input.operationId));
      if (!op)
        fail("production_operation_missing", "Операция не найдена.", 404);
      if (["deletePart", "deleteSupply"].includes(op.action)) return this.runDeletePart(op);
    } else {
      const normalized = this.normalize(input);
      payload = normalized.payload;
      decisions = normalized.decisions;
      requestHash = digest({
        ...payload,
        ...(decisions.xerox.size ? { xeroxRounding: [...decisions.xerox].sort() } : {}),
        ...(decisions.roll.size ? { rollRounding: [...decisions.roll].sort() } : {}),
      });
      op = this.operations().find((o) => o.id === payload.operationId);
      if (op) {
        if (op.requestHash !== requestHash)
          fail(
            "production_operation_conflict",
            "Этот ID уже использован для другого состава поставки.",
          );
        return this.publicOperation(op);
      }
      const preview = this.previewById(normalized.previewId);
      if (
        !preview ||
        this.now() - preview.at > 600000 ||
        preview.hash !== digest(payload)
      )
        fail(
          "production_preview_required",
          "Проверьте распределение текущего состава перед записью.",
        );
      if (!preview.routed.some((l) => l.department))
        fail(
          "production_unrouted_items",
          "Нет распознанных товаров для добавления. Уточните станки в базе и проверьте список заново.",
        );
    }
    if (["verified", "cancelled"].includes(op?.status)) return this.publicOperation(op);
    if (this.busy || this.legacy?.busy)
      fail(
        "production_operation_active",
        "Дождитесь завершения текущей операции.",
      );
    const pending = this.operations().find(
      (o) => o.id !== op?.id && !["verified", "cancelled"].includes(o.status),
    );
    if (
      pending ||
      this.legacy?.writeConflict(
        Object.values(DEPARTMENTS).map((d) => d.documentId),
      )
    )
      fail(
        "production_operation_pending",
        "Сначала завершите сверку предыдущей операции с поставкой.",
      );
    this.busy = true;
    if (this.legacy) this.legacy.busy = true;
    try {
      if (!op) {
        const fresh = await this.routedLines(payload);
        if (digest(fresh) !== digest(this.previewById(input.previewId)?.routed))
          fail(
            "production_routing_changed",
            "Станки или параметры кратности изменились. Проверьте распределение заново.",
          );
        const confirmed = fresh.map(line => {
          if (!line.rounding) return line;
          const article = articleKey(line.article);
          const isRoll = line.department === "roll";
          const selected = isRoll ? decisions.roll : decisions.xerox;
          const choice = line.rounding.choices.find(option => option.direction === selected.get(article));
          if (!choice)
            fail(isRoll ? "production_roll_rounding_required" : "production_xerox_rounding_required",
              isRoll ? `Выберите количество для «${line.article}» в рулонной печати.` : `Выберите количество Xerox для «${line.article}».`);
          selected.delete(article);
          return { ...line, quantity: choice.quantity, department: choice.quantity ? line.department : null };
        });
        if (decisions.roll.size || decisions.xerox.size)
          fail(decisions.roll.size ? "production_roll_rounding_required" : "production_xerox_rounding_required",
            "Список округлений изменился. Проверьте распределение заново.");
        if (!confirmed.some(line => line.department))
          fail(fresh.some(line => line.department === "roll" && line.rounding)
            ? "production_roll_rounding_required"
            : "production_xerox_rounding_required", "Добавьте хотя бы одну позицию с количеством больше нуля.");
        // Preflight every destination before the first production write.
        op = await this.prepare(payload, confirmed);
        op.requestHash = requestHash;
        this.save(op);
        this.store.log(
          "production_supply_owner_approved",
          `Поставка «${op.name}»: добавляется ${op.steps.reduce((sum, step) => sum + step.lines.length, 0)} позиций, пропускается ${op.skippedLines?.length || 0}; распределение по станкам подтверждено`,
          null,
        );
      }
      if (op.action === "create" && op.lockAfterCreate === true) {
        if (typeof this.beforeCreateWrite !== "function")
          fail("shipment_lock_delivery_unavailable", "Не удалось подтвердить замок в Assembly. Запись поставки остановлена до изменения таблиц.", 503);
        await this.beforeCreateWrite(op);
      }
      for (const step of op.steps) {
        const writer = this.writers[step.department];
        if (step.status === "verified") continue;
        // A timed-out CREATE can be safely retried only after Google's maximum
        // processing window, with authoritative absence and the SAME sheet ID.
        // duplicateSheet rejects that ID atomically if the first call did land.
        if (step.status === "uncertain" && step.plan.action === "create") {
          const started = Date.parse(step.writeStartedAt || op.createdAt);
          if (Number.isFinite(started) && this.now() - started > 180000) {
            const sheets = await writer.metadata();
            if (!sheets.some((sheet) => sheet.sheetId === step.plan.sheetId || sheet.title === step.plan.name)) {
              step.status = "pending";
              step.message = null;
              this.save(op);
            }
          }
        }
        if (["uncertain", "checking"].includes(step.status)) {
          try {
            if (step.plan.action !== "manifest") await writer.verify(step.plan);
            const manifest = await writer.manifest(step.plan.sheetId);
            if (
              !manifest ||
              manifest.id !== op.shipmentId ||
              manifest.revision !== op.id
            )
              fail(
                "production_manifest_unverified",
                "Связь поставки пока не подтверждена.",
              );
            step.status = "verified";
            this.save(op);
            continue;
          } catch (error) {
            step.message = error.message;
            op.status = "partial";
            op.message =
              "Результат записи требует сверки. Повторная отправка этого отдела заблокирована.";
            this.save(op);
            return this.publicOperation(op);
          }
        }
        // A pending create after a process restart must acquire a fresh template
        // before the write. Never do this for an uncertain sent request.
        if (step.plan.action === "create") {
          const fresh = await writer.prepareCreate({
            operationId: op.id,
            name: op.name,
            lines: step.lines,
          });
          fresh.sheetId = step.plan.sheetId;
          step.plan = { ...fresh, manifest: op.manifest };
          this.save(op);
        }
        if (step.plan.action === "append") {
          step.plan = {
            ...(await writer.prepareAppend({
              operationId: op.id,
              name: step.plan.name,
              sheetId: step.plan.sheetId,
              lines: step.lines,
              registeredSheets: [
                { gid: step.plan.sheetId, name: step.plan.name },
              ],
            })),
            manifest: op.manifest,
          };
          this.save(op);
        }
        step.status = "writing";
        step.writeStartedAt = new Date(this.now()).toISOString();
        this.save(op);
        try {
          if (step.plan.action === "manifest") {
            await writer.request(
              `https://sheets.googleapis.com/v4/spreadsheets/${writer.documentId}:batchUpdate`,
              {
                method: "POST",
                body: {
                  requests: supplyManifestRequests(
                    step.plan.sheetId,
                    op.manifest,
                  ),
                },
                write: true,
              },
            );
          } else await writer.execute(step.plan);
          step.status = "checking";
          this.save(op);
          if (step.plan.action !== "manifest") {
            const verification = await writer.verify(step.plan);
            step.calculations = verification.calculations;
          }
          step.status = "verified";
          step.message = null;
          this.save(op);
        } catch (error) {
          step.status =
            step.status === "checking"
              ? "checking"
              : error.uncertain
                ? "uncertain"
                : "failed";
          step.message = error.message;
          op.status = "partial";
          op.message =
            "Поставка загружена не полностью. Подтверждённые отделы не будут записаны повторно; продолжите оставшиеся шаги.";
          this.save(op);
          return this.publicOperation(op);
        }
      }
      try {
        for (const step of op.steps)
          await this.writers[step.department].publish(step.plan, op.manifest);
      } catch (error) {
        op.status = "partial";
        op.message =
          "Состав записан, но его общая готовность пока не подтверждена: " +
          error.message;
        this.save(op);
        return this.publicOperation(op);
      }
      const registry = this.store.meta(registryKey) || [];
      this.store.meta(registryKey, [
        ...registry.filter((s) => s.id !== op.shipmentId),
        {
          id: op.shipmentId,
          name: op.name,
          parts: op.manifest.parts.map((p) => ({ ...p, name: op.name })),
          ...((op.catalogStores || registry.find(s => s.id === op.shipmentId)?.catalogStores) ?
            {catalogStores: op.catalogStores || registry.find(s => s.id === op.shipmentId).catalogStores} : {}),
          ...((registry.find(s => s.id === op.shipmentId)?.planning || op.planning) ? {planning:registry.find(s => s.id === op.shipmentId)?.planning || op.planning} : {}),
        },
      ]);
      const rolls = this.store.meta("rollPrintingAdditionalSheets") || [];
      for (const part of op.manifest.parts.filter(
        (p) => p.department === "roll" && p.sheetId !== ROLL_PRINTING_SHEET.gid,
      ))
        if (!rolls.some((s) => s.gid === part.sheetId))
          rolls.push({ gid: part.sheetId, name: op.name });
      this.store.meta("rollPrintingAdditionalSheets", rolls);
      op.status = "verified";
      op.message =
        "Состав обоих отделов подтверждён. В Assembly будет одна общая поставка.";
      if (op.skippedLines?.length)
        op.message += ` Пропущено позиций: ${op.skippedLines.length}. Их список сохранён для уточнения станков и дозагрузки.`;
      const calculations = op.steps.flatMap((s) => s.calculations || []);
      const dimensionIssues = calculations.filter(
        (item) => item.error === "Размер не распознан",
      );
      const errors = calculations.filter(
        (item) => item.error !== "Размер не распознан",
      );
      if (errors.length)
        op.message +=
          " В зависимых формулах есть ошибки: " +
          errors.map((c) => c.cell + " " + c.error).join(", ");
      if (dimensionIssues.length)
        op.message +=
          " Не удалось распознать размеры в столбце G для строк: " +
          dimensionIssues.map((c) => c.cell).join(", ") +
          ". Площадь этих позиций оставлена незаполненной.";
      this.save(op);
      if (this.refreshAfterWrite) {
        try {
          await this.refresh?.();
        } catch {
          /* Writes have their own verified readback. */
        }
      }
      return this.publicOperation(op);
    } catch (error) {
      if (!op) throw error;
      op.status = "partial";
      op.message = "Загрузка остановлена до следующей записи: " + error.message;
      this.save(op);
      return this.publicOperation(op);
    } finally {
      this.busy = false;
      if (this.legacy) this.legacy.busy = false;
    }
  }
}
