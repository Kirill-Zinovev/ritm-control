import { createHash, randomUUID } from "node:crypto";
import {
  RollSupplySheetsWriter,
  validateRollSupplyPayload,
  supplyManifestRequests,
} from "./rollSupply.js";
import {
  ROLL_PRINTING_SHEET_ID,
  ROLL_PRINTING_SHEET,
} from "../worker/printing.js";
import { privateGoogleSource } from "../worker/privateGoogleConfig.js";

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

export function machineDepartment(machine) {
  const key = String(machine || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/gu, " ");
  if (["2-GO", "УФ", "УФ БЕЛ.", "УФ. БЕЛ", "УФ ДВУСТОРОННИЙ"].includes(key))
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
    const map = new Map();
    for (const row of rows.slice(1)) {
      const aliases = market === "OZON" ? [row[0], row[1]] : [row[0]];
      for (const alias of aliases) {
        if (!alias || String(alias).startsWith("#")) continue;
        const key = articleKey(alias);
        const machine = String(row[machineColumn] || "").trim();
        const prior = map.get(key);
        if (!prior) map.set(key, { machine });
        else if (prior.machine.toUpperCase() !== machine.toUpperCase())
          prior.conflict = true;
      }
    }
    return map;
  };
  const wb = index(catalog.WB, "WB"),
    ozon = index(catalog.OZON, "OZON");
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
    let record = (marketplace === "OZON" ? ozon : wb).get(key);
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
    return {
      ...line,
      machine,
      department,
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
    { writers, legacy, now = () => Date.now(), refresh = null } = {},
  ) {
    Object.assign(this, { store, writers, legacy, now, refresh });
    this.previews = new Map();
    this.busy = false;
    // An interrupted write is never replayed. Its exact persisted plan must be
    // verified before the owner can continue the remaining, unsent steps.
    for (const op of this.operations()) {
      let changed = false;
      for (const step of op.steps)
        if (step.status === "writing") {
          step.status = "uncertain";
          changed = true;
        }
      if (changed) {
        op.status = "partial";
        this.save(op);
      }
    }
  }
  operations() {
    return this.store.meta(operationsKey) || [];
  }
  save(op) {
    op.updatedAt = new Date(this.now()).toISOString();
    this.store.meta(operationsKey, [
      ...this.operations().filter((p) => p.id !== op.id),
      op,
    ]);
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
    const history = this.operations();
    return {
      available: !!this.writers?.roll && !!this.writers?.box,
      busy: this.busy,
      operations: history
        .filter(
          (op, index) =>
            (op.action !== "deletePart" || op.status !== "verified") &&
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
    const required = [
      "action",
      "department",
      "explicitWriteApproval",
      "name",
      "operationId",
      "sheetId",
    ].sort();
    if (
      !input ||
      Object.keys(input).sort().join(",") !== required.join(",") ||
      input.action !== "deletePart" ||
      input.explicitWriteApproval !== true ||
      !["roll", "box"].includes(input.department) ||
      !/^[a-f0-9-]{36}$/i.test(input.operationId || "") ||
      !Number.isSafeInteger(input.sheetId) ||
      input.sheetId <= 0 ||
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
    if (input.sheetId === DEPARTMENTS[input.department].template.gid)
      fail(
        "production_delete_template_forbidden",
        "Лист-шаблон отдела производства удалять нельзя.",
        403,
      );
    const supply = (this.store.meta(registryKey) || []).find((candidate) =>
      candidate.parts?.some(
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
    const target = supply.parts.find(
      (part) => part.department === input.department && part.sheetId === input.sheetId,
    );
    const before = await this.writers[input.department].manifest(input.sheetId);
    if (
      !before ||
      before.ready !== true ||
      before.id !== supply.id ||
      before.name !== supply.name ||
      !before.parts.some(
        (part) =>
          part.department === input.department &&
          part.documentId === DEPARTMENTS[input.department].documentId &&
          part.sheetId === input.sheetId,
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
    const survivors = before.parts.filter(
      (part) =>
        !(
          part.department === input.department &&
          part.sheetId === input.sheetId
        ),
    );
    if (survivors.length !== before.parts.length - 1)
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
    const plan = await this.writers[input.department].prepareDelete({
      name: input.name,
      sheetId: input.sheetId,
    });
    return {
      id: input.operationId,
      action: "deletePart",
      requestHash: digest(input),
      shipmentId: supply.id,
      name: supply.name,
      department: input.department,
      sheetId: input.sheetId,
      status: "writing",
      message: null,
      steps: [],
      lines: [],
      deletePlan: plan,
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
      (candidate) => candidate.id !== op.id && candidate.status !== "verified",
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
      const writer = this.writers[op.department];
      const liveTarget = (await writer.metadata()).find(
        (sheet) => sheet.sheetId === op.sheetId,
      );
      if (liveTarget) {
        if (liveTarget.title !== op.name)
          fail(
            "production_delete_sheet_changed",
            "Название листа изменилось после подтверждения. Удаление остановлено.",
          );
        const liveManifest = await writer.manifest(op.sheetId);
        if (digest(liveManifest) !== digest(op.manifestBefore))
          fail(
            "production_delete_manifest_changed",
            "Связь листа изменилась после подтверждения. Удаление остановлено.",
          );
        await writer.execute(op.deletePlan);
        op.status = "checking";
        this.save(op);
        await writer.verify(op.deletePlan);
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
      if (op.department === "roll")
        this.store.meta(
          "rollPrintingAdditionalSheets",
          (this.store.meta("rollPrintingAdditionalSheets") || []).filter(
            (sheet) => sheet.gid !== op.sheetId,
          ),
        );
      op.status = "verified";
      op.message = op.survivors.length
        ? `Удалена часть «${DEPARTMENTS[op.department].name}». Вторая часть поставки сохранена.`
        : `Удалена последняя часть «${DEPARTMENTS[op.department].name}»; общая поставка снята со сборки.`;
      this.save(op);
      this.store.log("production_supply_department_deleted", op.message, null);
      try {
        await this.refresh?.();
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
    const params = new URLSearchParams({
      valueRenderOption: "FORMATTED_VALUE",
    });
    ranges.forEach((r) => params.append("ranges", r));
    const data = await writer.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${CATALOG_ID}/values:batchGet?${params}`,
    );
    if (data.spreadsheetId !== CATALOG_ID || data.valueRanges?.length !== 2)
      fail("catalog_unavailable", "База товаров не прочитана полностью.");
    return {
      WB: data.valueRanges[0].values || [],
      OZON: data.valueRanges[1].values || [],
    };
  }
  normalize(input) {
    const { previewId, department, ...raw } = input || {};
    const payload = validateRollSupplyPayload(raw);
    if (!["create", "append"].includes(payload.action))
      fail(
        "production_action_invalid",
        "Неизвестное действие с составом поставки.",
      );
    if (department !== undefined && !["roll", "box"].includes(department))
      fail("production_department_invalid", "Неизвестный отдел производства.");
    if (payload.action === "append") payload.department = department || "roll";
    return { payload, previewId };
  }
  async preview(input) {
    if (!this.state().available)
      fail(
        "production_writer_unavailable",
        "Запись в оба отдела пока не настроена.",
        503,
      );
    const { payload } = this.normalize(input);
    const routed = routeSupplyLines(
      payload.lines,
      shipmentMarketplace(payload.name),
      await this.catalog(),
    );
    const id = randomUUID();
    const value = {
      id,
      hash: digest(payload),
      payload,
      routed,
      at: this.now(),
    };
    this.previews.set(id, value);
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
        .map(({ article, quantity }) => ({ article, quantity }));
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
      lines: payload.lines,
      skippedLines: routed.filter((l) => !l.department),
      requestHash: digest(payload),
      status: "writing",
      steps,
      manifest,
    };
  }
  async execute(input) {
    if (!this.state().available)
      fail(
        "production_writer_unavailable",
        "Запись в оба отдела пока не настроена.",
        503,
      );
    if (input?.action === "deletePart") {
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
      const pending = this.operations().find((item) => item.status !== "verified");
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
    let payload, op;
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
      op = this.operations().find((o) => o.id === input.operationId);
      if (!op)
        fail("production_operation_missing", "Операция не найдена.", 404);
      if (op.action === "deletePart") return this.runDeletePart(op);
    } else {
      const normalized = this.normalize(input);
      payload = normalized.payload;
      op = this.operations().find((o) => o.id === payload.operationId);
      if (op) {
        if (op.requestHash !== digest(payload))
          fail(
            "production_operation_conflict",
            "Этот ID уже использован для другого состава поставки.",
          );
        return this.publicOperation(op);
      }
      const preview = this.previews.get(normalized.previewId);
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
    if (op?.status === "verified") return this.publicOperation(op);
    if (this.busy || this.legacy?.busy)
      fail(
        "production_operation_active",
        "Дождитесь завершения текущей операции.",
      );
    const pending = this.operations().find(
      (o) => o.id !== op?.id && o.status !== "verified",
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
        const fresh = routeSupplyLines(
          payload.lines,
          shipmentMarketplace(payload.name),
          await this.catalog(),
        );
        if (digest(fresh) !== digest(this.previews.get(input.previewId).routed))
          fail(
            "production_routing_changed",
            "Станки в базе изменились. Проверьте распределение заново.",
          );
        // Preflight every destination before the first production write.
        op = await this.prepare(payload, fresh);
        this.save(op);
        this.store.log(
          "production_supply_owner_approved",
          `Поставка «${op.name}»: добавляется ${op.steps.reduce((sum, step) => sum + step.lines.length, 0)} позиций, пропускается ${op.skippedLines?.length || 0}; распределение по станкам подтверждено`,
          null,
        );
      }
      for (const step of op.steps) {
        const writer = this.writers[step.department];
        if (step.status === "verified") continue;
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
      const errors = op.steps.flatMap((s) => s.calculations || []);
      if (errors.length)
        op.message +=
          " В зависимых формулах есть ошибки: " +
          errors.map((c) => c.cell + " " + c.error).join(", ");
      if (op.steps.some((s) => s.department === "box"))
        op.message +=
          " Ручные размеры печати в новых строках бокса требуют заполнения, если они не рассчитываются формулами.";
      this.save(op);
      try {
        await this.refresh?.();
      } catch {
        /* Writes have their own verified readback. */
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
