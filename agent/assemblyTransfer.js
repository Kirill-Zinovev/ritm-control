import { createHash, randomUUID } from "node:crypto";
import {
  BOX_PRINTING_SHEET_ID,
  ROLL_PRINTING_SHEET_ID,
} from "../worker/printing.js";

export const ASSEMBLY_TRANSFER_SOURCES = {
  roll: {
    id: ROLL_PRINTING_SHEET_ID,
    name: "Рулонная печать",
  },
  box: { id: BOX_PRINTING_SHEET_ID, name: "Бокс" },
};
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
const cellValue = (cell) =>
  cell?.effectiveValue?.stringValue ??
  cell?.effectiveValue?.numberValue ??
  cell?.effectiveValue?.boolValue ??
  (cell?.effectiveValue?.errorValue ? "#ERROR" : "");
const number = (value) => {
  const n =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isSafeInteger(n) && n > 0 && n <= 1_000_000 ? n : null;
};
export const transferRowKey = (row) =>
  (row.uid ? "uid:" + row.uid : "row:" + row.row) + "|" + row.sku;

function itemQuantitiesForTransfer(preview, transfer) {
  if (!Array.isArray(transfer?.keys) || !Array.isArray(preview?.items))
    return null;
  const wanted = new Set(
    transfer.keys.filter((key) => typeof key === "string"),
  );
  if (!wanted.size) return null;
  const quantities = {};
  for (const item of preview.items) {
    if (item?.department !== transfer.department) continue;
    const key = transferRowKey(item);
    if (
      wanted.has(key) &&
      Number.isSafeInteger(item.quantity) &&
      item.quantity >= 0
    )
      quantities[key] = item.quantity;
  }
  return Object.keys(quantities).length === wanted.size ? quantities : null;
}

function isMatchingRollBoxTarget(boxSource, rollSource) {
  if (
    boxSource.department !== "box" ||
    boxSource.manifest ||
    rollSource.department !== "roll" ||
    rollSource.name !== boxSource.name
  )
    return false;
  if (!rollSource.manifest) return true;
  const [part] = rollSource.manifest.parts || [];
  return (
    rollSource.manifest.ready === true &&
    rollSource.manifest.parts.length === 1 &&
    part?.department === "roll" &&
    part.documentId === ASSEMBLY_TRANSFER_SOURCES.roll.id &&
    part.sheetId === rollSource.sheetId
  );
}

// Only a read-only Sheets reader is accepted here. No production writer is used.
export class AssemblyTransferService {
  constructor(store, { reader, queue, now = Date.now } = {}) {
    Object.assign(this, { store, reader, queue, now });
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS assembly_transfer_previews (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, payload TEXT NOT NULL)",
    );
    this.backfillBoxTransferQuantities();
  }
  backfillBoxTransferQuantities() {
    const rows = this.store.db
      .prepare(
        "SELECT id,payload FROM assembly_sync_events WHERE action='transfer' AND outcome='synced' AND payload IS NOT NULL",
      )
      .all();
    const readPreview = this.store.db.prepare(
      "SELECT payload FROM assembly_transfer_previews WHERE id=?",
    );
    const update = this.store.db.prepare(
      "UPDATE assembly_sync_events SET payload=? WHERE id=?",
    );
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload);
        const transfer = payload?.transfer;
        if (
          transfer?.department !== "box" ||
          payload.boxQuantityByKey ||
          typeof payload.previewId !== "string"
        )
          continue;
        const previewRow = readPreview.get(payload.previewId);
        if (!previewRow) continue;
        const quantities = itemQuantitiesForTransfer(
          JSON.parse(previewRow.payload),
          transfer,
        );
        if (quantities)
          update.run(
            JSON.stringify({ ...payload, boxQuantityByKey: quantities }),
            row.id,
          );
      } catch {
        // A missing or malformed historical preview must not block startup.
      }
    }
  }
  available() {
    return !!this.reader?.configured && !!this.queue?.state().configured;
  }
  requireAvailable() {
    if (!this.available())
      fail("Передача в Assembly пока не настроена на этом агенте.", 503);
  }
  sourceRef(department, sheetId) {
    const source = ASSEMBLY_TRANSFER_SOURCES[department];
    if (
      !["roll", "box"].includes(department) ||
      !source ||
      !Number.isSafeInteger(sheetId) ||
      sheetId < 0
    )
      fail("Выберите участок и существующий лист.", 400);
    return source;
  }
  async sources() {
    this.requireAvailable();
    const sources = [];
    // Fail visibly if either source cannot be inspected; never hide it as empty.
    for (const [department, source] of Object.entries(
      ASSEMBLY_TRANSFER_SOURCES,
    )) {
      const book = await this.reader.get(source.id, {
        fields:
          "spreadsheetId,sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)))",
      });
      const tabs = book.sheets.filter(
        (s) =>
          !s.properties.hidden &&
          s.properties.gridProperties?.columnCount >= 15,
      );
      const sheets = [];
      for (let i = 0; i < tabs.length; i += 30) {
        const data = await this.reader.get(source.id, {
          ranges: tabs
            .slice(i, i + 30)
            .map(
              (s) => "'" + s.properties.title.replaceAll("'", "''") + "'!E4:O4",
            ),
          includeGridData: "true",
          fields:
            "spreadsheetId,sheets(properties(sheetId,title,hidden),data(startRow,startColumn,rowData(values(effectiveValue))))",
        });
        for (const sheet of data.sheets) {
          const cells = sheet.data?.[0]?.rowData?.[0]?.values || [];
          if (
            !sheet.properties.hidden &&
            String(cellValue(cells[0])).trim() === "Артикул" &&
            String(cellValue(cells[10])).trim() === "Кол-во"
          )
            sheets.push({
              sheetId: sheet.properties.sheetId,
              name: sheet.properties.title,
            });
        }
      }
      sources.push({ department, name: source.name, sheets });
    }
    return sources;
  }
  async readSource(department, sheetId) {
    const source = this.sourceRef(department, sheetId);
    const metadata = await this.reader.get(source.id, {
      fields:
        "spreadsheetId,sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)))",
    });
    const target = metadata.sheets.find(
      (s) => s.properties.sheetId === sheetId,
    )?.properties;
    if (!target || target.hidden)
      fail("Лист удалён или скрыт. Выберите доступную поставку.");
    if (target.gridProperties?.rowCount > 5000)
      fail(
        "В листе больше 5000 строк. Проверьте диапазон поставки перед передачей.",
      );
    const title = "'" + target.title.replaceAll("'", "''") + "'";
    const lastRow = Math.min(5000, target.gridProperties?.rowCount || 5000);
    if (lastRow < 4 || (target.gridProperties?.columnCount || 0) < 15)
      fail("У листа другая структура: нужны Артикул в E4 и Кол-во в O4.");
    const data = await this.reader.get(source.id, {
      ranges: [
        title + "!E4:E" + lastRow,
        title + "!O4:O" + lastRow,
        ...(target.gridProperties.columnCount >= 29
          ? [title + "!AC4:AC" + lastRow]
          : []),
      ],
      includeGridData: "true",
      fields:
        "spreadsheetId,sheets(properties(sheetId,title,hidden),developerMetadata(metadataKey,metadataValue),data(startRow,startColumn,rowData(values(effectiveValue))))",
    });
    const sheet = data.sheets.find((s) => s.properties.sheetId === sheetId);
    if (
      !sheet ||
      sheet.properties.hidden ||
      sheet.properties.title !== target.title
    )
      fail("Лист изменился во время чтения. Повторите загрузку.");
    const columns = new Map(
      (sheet.data || []).map((grid) => [grid.startColumn || 0, grid]),
    );
    const at = (column, row) => {
      const grid = columns.get(column - 1);
      return cellValue(
        grid?.rowData?.[row - 1 - (grid?.startRow || 0)]?.values?.[0],
      );
    };
    if (
      String(at(5, 4)).trim() !== "Артикул" ||
      String(at(15, 4)).trim() !== "Кол-во"
    )
      fail("У листа другая структура: нужны Артикул в E4 и Кол-во в O4.");
    const rows = [],
      seen = new Set();
    for (let row = 5; row <= 5001; row++) {
      const sku = String(at(5, row) || "").trim();
      if (!sku) continue;
      if (row === 5001)
        fail("В листе больше 5000 строк. Проверьте диапазон поставки.");
      const uid = String(at(29, row) || "").trim();
      if (
        sku.length > 120 ||
        uid.length > 240 ||
        sku.startsWith("#") ||
        (uid && seen.has(uid))
      )
        fail(
          "В листе есть ошибка артикула или повтор UID. Исправьте источник и обновите список.",
        );
      if (uid) seen.add(uid);
      rows.push({ sku, uid, row, quantity: number(at(15, row)) });
    }
    const entries = (sheet.developerMetadata || []).filter(
      (m) => m.metadataKey === "RITM_SUPPLY",
    );
    if (entries.length > 1) fail("У листа несколько связей с поставкой.");
    let manifest = null;
    try {
      manifest = entries.length ? JSON.parse(entries[0].metadataValue) : null;
    } catch {
      fail("Повреждена связь общей поставки.");
    }
    if (
      manifest &&
      (manifest.version !== 1 ||
        !/^RITM-(?:SUPPLY-[a-f0-9-]{36}|ROLL-\d+|BOX-\d+)$/.test(manifest.id) ||
        !manifest.ready ||
        !Array.isArray(manifest.parts) ||
        !manifest.parts.length ||
        manifest.parts.length > 2 ||
        !manifest.parts.some(
          (p) =>
            p.department === department &&
            p.documentId === source.id &&
            p.sheetId === sheetId,
        ))
    )
      fail(
        "Загрузка общей поставки ещё не подтверждена. Завершите её перед передачей.",
      );
    const fingerprint = digest([
      department,
      sheetId,
      target.title,
      manifest,
      rows,
    ]);
    return {
      department,
      sheetId,
      name: target.title,
      manifest,
      rows,
      fingerprint,
    };
  }
  async source(department, sheetId) {
    this.requireAvailable();
    const source = await this.readSource(department, sheetId);
    return {
      ...source,
      manifest: undefined,
      managed: !!source.manifest,
      items: source.rows.map((row) => ({
        ...row,
        key: transferRowKey(row),
        issue:
          row.quantity === null
            ? "В источнике нет корректного положительного количества"
            : null,
      })),
      rows: undefined,
    };
  }
  async preview(input) {
    this.requireAvailable();
    const inputKeys = input && Object.keys(input).sort().join(",");
    if (
      !input ||
      ![
        "department,fingerprint,keys,sheetId",
        "department,fingerprint,keys,sheetId,targetRollSheetId",
      ].includes(inputKeys) ||
      !Array.isArray(input.keys) ||
      !input.keys.length ||
      input.keys.length > 500 ||
      new Set(input.keys).size !== input.keys.length ||
      input.keys.some((k) => typeof k !== "string" || k.length > 400)
    )
      fail("Выберите от 1 до 500 позиций.", 400);
    const source = await this.readSource(input.department, input.sheetId);
    if (source.fingerprint !== input.fingerprint)
      fail(
        "Состав листа изменился. Обновите позиции и проверьте выбор заново.",
      );
    let targetRoll = null;
    if (input.targetRollSheetId !== undefined) {
      if (
        !Number.isSafeInteger(input.targetRollSheetId) ||
        input.targetRollSheetId <= 0
      )
        fail(
          "Выбранную поставку нельзя использовать как назначение для бокса.",
        );
      targetRoll = await this.readSource("roll", input.targetRollSheetId);
      if (
        !isMatchingRollBoxTarget(source, targetRoll) ||
        targetRoll.rows.some((row) => row.quantity === null)
      )
        fail(
          "Не удалось подтвердить отдельную рулонную поставку с тем же названием. Общая поставка с несколькими участками не может быть объединена этим способом.",
        );
    }
    const selected = new Set(input.keys),
      rows = source.rows.filter((row) => selected.has(transferRowKey(row)));
    if (
      rows.length !== selected.size ||
      rows.some((row) => row.quantity === null)
    )
      fail("Выбранные позиции изменились или содержат неверное количество.");
    let parts = [source];
    if (source.manifest) {
      if (rows.length !== source.rows.length)
        fail(
          "Общая поставка RITM передаётся целиком, вместе со всеми участками.",
        );
      const seen = new Set();
      parts = [];
      for (const part of source.manifest.parts) {
        if (
          seen.has(part.department) ||
          this.sourceRef(part.department, part.sheetId).id !== part.documentId
        )
          fail("Не удалось подтвердить источники общей поставки.");
        seen.add(part.department);
        const current =
          part.department === source.department &&
          part.sheetId === source.sheetId
            ? source
            : await this.readSource(part.department, part.sheetId);
        if (
          JSON.stringify(current.manifest) !==
            JSON.stringify(source.manifest) ||
          current.rows.some((row) => row.quantity === null)
        )
          fail(
            "Участки поставки ещё не согласованы или содержат неверные количества.",
          );
        parts.push(current);
      }
    }
    const transfer = {
      department: source.department,
      sheetId: source.sheetId,
      name: source.name,
      fingerprint: source.fingerprint,
      keys: input.keys,
      parts: parts.map((part) => ({
        department: part.department,
        sheetId: part.sheetId,
        fingerprint: part.fingerprint,
      })),
      ...(targetRoll
        ? {
            targetRollSheetId: targetRoll.sheetId,
            targetRollFingerprint: targetRoll.fingerprint,
          }
        : {}),
    };
    if (Buffer.byteLength(JSON.stringify(transfer)) > 180000)
      fail(
        "Состав слишком большой. Передайте товары несколькими группами.",
        400,
      );
    const id = randomUUID(),
      preview = {
        id,
        transfer,
        name: source.manifest?.name || source.name,
        managed: !!source.manifest,
        destinationName: targetRoll?.name || source.manifest?.name || null,
        rows: source.manifest
          ? parts.reduce((sum, p) => sum + p.rows.length, 0)
          : rows.length,
        quantity: (source.manifest
          ? parts.flatMap((p) => p.rows)
          : rows
        ).reduce((sum, row) => sum + row.quantity, 0),
        items: source.manifest
          ? parts.flatMap((p) =>
              p.rows.map((row) => ({ ...row, department: p.department })),
            )
          : rows.map((row) => ({ ...row, department: source.department })),
      };
    this.store.db
      .prepare("DELETE FROM assembly_transfer_previews WHERE expires_at<?")
      .run(this.now());
    this.store.db
      .prepare("INSERT INTO assembly_transfer_previews VALUES(?,?,?)")
      .run(id, this.now() + 900000, JSON.stringify(preview));
    return this.publicPreview(preview);
  }
  publicPreview(p) {
    const { transfer, ...preview } = p;
    return preview;
  }
  operation(id) {
    const row = this.store.db
      .prepare(
        "SELECT * FROM assembly_sync_events WHERE id=? AND payload IS NOT NULL",
      )
      .get(id);
    if (!row) return null;
    const receipt = row.receipt ? JSON.parse(row.receipt) : null;
    return {
      id: row.id,
      name: JSON.parse(row.payload).name,
      status:
        row.outcome === "conflict"
          ? "conflict"
          : row.delivered_at
            ? "delivered"
            : "pending",
      attempts: row.attempts,
      receipt,
    };
  }
  links() {
    const rows = this.store.db
      .prepare(
        "SELECT payload,receipt FROM assembly_sync_events WHERE action='transfer' AND outcome='synced' AND payload IS NOT NULL ORDER BY created_at,id",
      )
      .all();
    const links = new Map();
    for (const row of rows) {
      let payload, receipt;
      try {
        payload = JSON.parse(row.payload);
        receipt = row.receipt ? JSON.parse(row.receipt) : null;
      } catch {
        continue;
      }
      const transfer = payload?.transfer;
      if (
        transfer?.department !== "box" ||
        typeof transfer.name !== "string" ||
        !Number.isSafeInteger(transfer.sheetId)
      )
        continue;
      const targetRollSheetId = Number.isSafeInteger(transfer.targetRollSheetId)
        ? transfer.targetRollSheetId
        : null;
      let boxQuantityByKey = payload.boxQuantityByKey;
      if (
        (!boxQuantityByKey || typeof boxQuantityByKey !== "object") &&
        typeof payload.previewId === "string"
      ) {
        try {
          const previewRow = this.store.db
            .prepare(
              "SELECT payload FROM assembly_transfer_previews WHERE id=?",
            )
            .get(payload.previewId);
          if (previewRow)
            boxQuantityByKey = itemQuantitiesForTransfer(
              JSON.parse(previewRow.payload),
              transfer,
            );
        } catch {
          boxQuantityByKey = null;
        }
      }
      const key = String(transfer.sheetId);
      const link = links.get(key) || {
        name: transfer.name,
        boxSheetId: transfer.sheetId,
        targetRollSheetId,
        boxKeys: new Set(),
        boxQuantities: new Map(),
        legacyRows: 0,
        conflictingTargets: false,
      };
      link.name = transfer.name;
      if (
        targetRollSheetId !== null &&
        link.targetRollSheetId !== null &&
        targetRollSheetId !== link.targetRollSheetId
      )
        link.conflictingTargets = true;
      if (link.targetRollSheetId === null)
        link.targetRollSheetId = targetRollSheetId;
      if (Array.isArray(transfer.keys))
        transfer.keys.forEach((itemKey) => {
          if (typeof itemKey !== "string") return;
          link.boxKeys.add(itemKey);
          const quantity = boxQuantityByKey?.[itemKey];
          if (Number.isSafeInteger(quantity) && quantity >= 0)
            link.boxQuantities.set(itemKey, quantity);
        });
      else if (Number.isSafeInteger(receipt?.added))
        link.legacyRows = Math.max(link.legacyRows, Math.max(0, receipt.added));
      links.set(key, link);
    }
    return [...links.values()]
      .map(
        ({
          boxKeys,
          boxQuantities,
          legacyRows,
          conflictingTargets,
          ...link
        }) => {
          const quantityKnown =
            boxKeys.size > 0 &&
            [...boxKeys].every((key) => boxQuantities.has(key));
          return {
            ...link,
            targetRollSheetId: conflictingTargets
              ? null
              : link.targetRollSheetId,
            positionKeys: [...boxKeys].sort(),
            boxRows: Math.max(boxKeys.size, legacyRows),
            boxQuantity: quantityKnown
              ? [...boxKeys].reduce(
                  (total, key) => total + boxQuantities.get(key),
                  0,
                )
              : null,
          };
        },
      )
      .filter((link) => link.boxRows > 0);
  }
  async execute(input) {
    this.requireAvailable();
    if (
      !input ||
      Object.keys(input).sort().join(",") !==
        "explicitTransferApproval,operationId,previewId" ||
      input.explicitTransferApproval !== true ||
      !/^[a-f0-9-]{36}$/i.test(input.operationId || "") ||
      !/^[a-f0-9-]{36}$/i.test(input.previewId || "")
    )
      fail("Подтвердите передачу выбранного состава в Assembly.", 400);
    const previous = this.store.db
      .prepare("SELECT payload FROM assembly_sync_events WHERE id=?")
      .get(input.operationId);
    if (previous) {
      if (
        !previous.payload ||
        JSON.parse(previous.payload).previewId !== input.previewId
      )
        fail("Этот номер операции уже использован для другого состава.");
      this.queue.schedule(0);
      return this.operation(input.operationId);
    }
    const row = this.store.db
      .prepare("SELECT * FROM assembly_transfer_previews WHERE id=?")
      .get(input.previewId);
    if (!row || row.expires_at < this.now())
      fail("Проверка состава устарела. Подготовьте передачу заново.");
    const preview = JSON.parse(row.payload);
    for (const part of preview.transfer.parts) {
      const actual = await this.readSource(part.department, part.sheetId);
      if (actual.fingerprint !== part.fingerprint)
        fail(
          "Состав источника изменился после проверки. Передача остановлена, проверьте позиции заново.",
        );
    }
    if (preview.transfer.targetRollSheetId !== undefined) {
      const targetRoll = await this.readSource(
        "roll",
        preview.transfer.targetRollSheetId,
      );
      if (
        targetRoll.fingerprint !== preview.transfer.targetRollFingerprint ||
        !isMatchingRollBoxTarget(
          { department: "box", name: preview.name, manifest: null },
          targetRoll,
        )
      )
        fail(
          "Рулонная поставка изменилась после проверки. Подготовьте передачу заново.",
        );
    }
    this.queue.enqueueTransfer(input.operationId, {
      previewId: input.previewId,
      name: preview.name,
      transfer: preview.transfer,
      ...(preview.transfer.department === "box"
        ? {
            boxQuantityByKey: itemQuantitiesForTransfer(
              preview,
              preview.transfer,
            ),
          }
        : {}),
    });
    this.store.log(
      "assembly_transfer_queued",
      `Передача «${preview.name}» в Assembly: ${preview.rows} позиций; подтверждено владельцем`,
      null,
    );
    return this.operation(input.operationId);
  }
}
