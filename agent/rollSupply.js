import { createHash, randomInt } from "node:crypto";
import {
  ROLL_PRINTING_SHEET,
  ROLL_PRINTING_SHEET_ID,
} from "../worker/printing.js";
import { formulaFamily } from "./formulaIntelligence.js";
import { RepairError } from "./testSheetsWriter.js";

const DATA_START_ROW = ROLL_PRINTING_SHEET.dataStartRow;
const HEADER_ROW = ROLL_PRINTING_SHEET.headerRow;
const UID_HEADER_ROW = ROLL_PRINTING_SHEET.uidHeaderRow;
const MAX_ORDERS = 500;
const MAX_TEMPLATE_SCAN_ROWS = 4096;
const FORMULA_COLUMNS = [6, 9, 10]; // F, I, J in the registered roll-printing template.
const REGISTRY_KEY = "rollPrintingAdditionalSheets";
const fail = (code, message, status = 409) => {
  throw new RepairError(code, message, status);
};
const fold = (value) =>
  String(value || "")
    .trim()
    .toLocaleLowerCase("ru-RU");
const requestHash = (payload) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");
const columnName = (column) => {
  let value = "";
  for (; column > 0; column = Math.floor((column - 1) / 26))
    value = String.fromCharCode(65 + ((column - 1) % 26)) + value;
  return value;
};
const titleIsValid = (value) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= 100 &&
  !/[:\\/?*\[\]]/.test(value);

function normalizeLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_ORDERS)
    fail(
      "invalid_supply_lines",
      `Добавьте от 1 до ${MAX_ORDERS} строк с артикулами и количеством.`,
      400,
    );
  const seen = new Set();
  return lines.map((line, index) => {
    if (
      !line ||
      Object.keys(line).sort().join(",") !== "article,quantity" ||
      typeof line.article !== "string" ||
      !line.article.trim() ||
      line.article.trim().length > 120 ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0 ||
      line.quantity > 1000000
    )
      fail(
        "invalid_supply_line",
        `Проверьте строку ${index + 1}: нужен артикул и целое количество от 1 до 1 000 000.`,
        400,
      );
    const article = line.article.trim(),
      key = fold(article);
    if (seen.has(key))
      fail(
        "duplicate_supply_article",
        `Артикул «${article}» указан несколько раз. Объедините его в одну строку.`,
        400,
      );
    seen.add(key);
    return { article, quantity: line.quantity };
  });
}

export function validateRollSupplyPayload(input) {
  const allowed =
    input?.action === "create"
      ? ["action", "explicitWriteApproval", "lines", "name", "operationId"]
      : input?.action === "append"
        ? [
          "action",
          "explicitWriteApproval",
          "lines",
          "name",
          "operationId",
          "sheetId",
          ]
        : input?.action === "updateItem"
          ? [
              "action",
              "article",
              "expectedQuantity",
              "explicitWriteApproval",
              "name",
              "operationId",
              "quantity",
              "sheetId",
              "uid",
            ]
          : input?.action === "removeItem"
            ? [
                "action",
                "article",
                "expectedQuantity",
                "explicitWriteApproval",
                "name",
                "operationId",
                "sheetId",
                "uid",
              ]
        : ["action", "explicitWriteApproval", "name", "operationId", "sheetId"];
  if (
    !input ||
    Object.keys(input).sort().join(",") !== allowed.sort().join(",") ||
    !["create", "append", "updateItem", "removeItem", "delete"].includes(input.action) ||
    input.explicitWriteApproval !== true ||
    !/^[a-f0-9-]{36}$/i.test(input.operationId || "") ||
    !titleIsValid(input.name)
  )
    fail(
      "supply_confirmation_required",
      "Подтвердите точное название листа и состав поставки действием в форме.",
      400,
    );
  if (
    input.action !== "create" &&
    (!Number.isSafeInteger(input.sheetId) || input.sheetId <= 0)
  )
    fail("invalid_supply_target", "Не выбран лист поставки.", 400);
  if (input.action === "delete")
    return {
      action: input.action,
      operationId: input.operationId,
      name: input.name,
      sheetId: input.sheetId,
      lines: [],
    };
  if (["updateItem", "removeItem"].includes(input.action)) {
    if (
      typeof input.article !== "string" ||
      !input.article.trim() ||
      input.article.trim().length > 120 ||
      typeof input.uid !== "string" ||
      !input.uid.trim() ||
      input.uid.trim().length > 240 ||
      !Number.isSafeInteger(input.expectedQuantity) ||
      input.expectedQuantity <= 0 ||
      input.expectedQuantity > 1_000_000 ||
      (input.action === "updateItem" &&
        (!Number.isSafeInteger(input.quantity) ||
          input.quantity <= 0 ||
          input.quantity > 1_000_000))
    )
      fail(
        "invalid_supply_item",
        "Позиция поставки изменилась. Обновите данные и повторите действие.",
        400,
      );
    return {
      action: input.action,
      operationId: input.operationId,
      name: input.name,
      sheetId: input.sheetId,
      uid: input.uid.trim(),
      article: input.article.trim(),
      expectedQuantity: input.expectedQuantity,
      ...(input.action === "updateItem" ? { quantity: input.quantity } : {}),
      lines: [],
    };
  }
  return {
    action: input.action,
    operationId: input.operationId,
    name: input.name,
    ...(input.action === "append" ? { sheetId: input.sheetId } : {}),
    lines: normalizeLines(input.lines),
  };
}

function gridCell(grid, row, column) {
  const data = grid?.data?.[0];
  const rowData = data?.rowData || [];
  const rowIndex = row - 1 - (data?.startRow || 0);
  const columnIndex = column - 1 - (data?.startColumn || 0);
  return rowData[rowIndex]?.values?.[columnIndex] || {};
}

function entered(cell) {
  const value = cell?.userEnteredValue;
  if (!value) return "";
  if (typeof value.stringValue === "string") return value.stringValue.trim();
  if (typeof value.numberValue === "number") return value.numberValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  return "";
}

function effective(cell) {
  const value = cell?.effectiveValue;
  if (!value) return "";
  if (typeof value.stringValue === "string") return value.stringValue.trim();
  if (typeof value.numberValue === "number") return value.numberValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (value.errorValue) return "#" + String(value.errorValue.type || "ERROR");
  return "";
}

function isLiteralValue(cell) {
  const value = cell?.userEnteredValue;
  return (
    !!value &&
    !value.formulaValue &&
    (typeof value.stringValue === "string" ||
      typeof value.numberValue === "number" ||
      typeof value.boolValue === "boolean")
  );
}

function inputRows(grid) {
  const rowCount = grid?.properties?.gridProperties?.rowCount || 0;
  const rows = [];
  for (let row = DATA_START_ROW; row <= rowCount; row++) {
    rows.push({
      row,
      articleCell: gridCell(grid, row, 5),
      quantityCell: gridCell(grid, row, 15),
      uidCell: gridCell(grid, row, 29),
    });
  }
  return rows;
}

function lastLiteralDataRow(grid) {
  const rowCount = grid?.properties?.gridProperties?.rowCount || 0;
  let last = DATA_START_ROW - 1;
  for (let row = DATA_START_ROW; row <= rowCount; row++) {
    for (let column = 1; column <= 29; column++) {
      if (isLiteralValue(gridCell(grid, row, column))) {
        last = row;
        break;
      }
    }
  }
  return last;
}

function clearCopiedData(grid, sheetId, throughRow, formulaRepairs = []) {
  const repairedFormulas = new Map(
    formulaRepairs.map((repair) => [`${repair.row}:${repair.column}`, repair.formula]),
  );
  const rows = [];
  for (let row = DATA_START_ROW; row <= throughRow; row++) {
    const values = [];
    for (let column = 1; column <= 29; column++) {
      const formula =
        repairedFormulas.get(`${row}:${column}`) ||
        gridCell(grid, row, column).userEnteredValue?.formulaValue;
      values.push(formula ? { userEnteredValue: { formulaValue: formula } } : {});
    }
    rows.push({ values });
  }
  return {
    updateCells: {
      start: { sheetId, rowIndex: DATA_START_ROW - 1, columnIndex: 0 },
      rows,
      fields: "userEnteredValue",
    },
  };
}

function formulaSignature(grid, startRow, endRow, formulaRepairs = []) {
  const repairedFormulas = new Map(
    formulaRepairs.map((repair) => [`${repair.row}:${repair.column}`, repair.formula]),
  );
  const formulas = [];
  for (let row = startRow; row <= endRow; row++)
    for (let column = 1; column <= 29; column++) {
      const formula =
        repairedFormulas.get(`${row}:${column}`) ||
        gridCell(grid, row, column).userEnteredValue?.formulaValue;
      if (formula) formulas.push([`${columnName(column)}${row}`, formula]);
    }
  return {
    count: formulas.length,
    digest: createHash("sha256").update(JSON.stringify(formulas)).digest("hex"),
  };
}

function validateTemplate(grid, allowEmptyUid = false) {
  if (
    fold(entered(gridCell(grid, HEADER_ROW, 5))) !== "артикул" ||
    fold(entered(gridCell(grid, HEADER_ROW, 15))) !== "кол-во" ||
    (fold(entered(gridCell(grid, UID_HEADER_ROW, 29))) !== "uid" && !(allowEmptyUid && !entered(gridCell(grid, UID_HEADER_ROW, 29)) && !gridCell(grid, UID_HEADER_ROW, 29).userEnteredValue?.formulaValue))
  )
    fail(
      "roll_template_schema_changed",
      "Структура шаблона рулонной печати изменилась. Запись остановлена, исходный лист не затронут.",
      409,
    );
}

function validateTemplateInputRange(grid, throughRow) {
  for (let row = DATA_START_ROW; row <= throughRow; row++) {
    if (
      gridCell(grid, row, 5).userEnteredValue?.formulaValue ||
      gridCell(grid, row, 15).userEnteredValue?.formulaValue
    )
      fail(
        "roll_template_input_formula",
        `В поле артикула или количества строки ${row} обнаружена формула; запись остановлена.`,
        409,
      );
  }
}

function translateFormulaRow(formula, fromRow, toRow) {
  const delta = toRow - fromRow;
  return formula.replace(
    /"(?:[^"]|"")*"|'(?:[^']|'')+'!|[\p{L}_][\p{L}\p{N}_ .]*!|(?<![\p{L}\p{N}_])\$?[A-Z]{1,3}\$?[1-9]\d*(?![\p{L}\p{N}_(]|!)/gu,
    (token) => {
      const reference = token.match(/^(\$?[A-Z]{1,3})(\$?)([1-9]\d*)$/);
      if (!reference) return token;
      const row = Number(reference[3]) + (reference[2] ? 0 : delta);
      if (row < 1)
        fail(
          "roll_template_formula_missing",
          "Формулу в новой строке нельзя безопасно перенести из шаблона. Загруженный список товаров не является причиной; лист не создан, исходный лист не изменён.",
          409,
        );
      return `${reference[1]}${reference[2]}${row}`;
    },
  );
}

function formulaMissingMessage(cell) {
  return `В листе-шаблоне «${ROLL_PRINTING_SHEET.name}» в ячейке ${cell} нет формулы, а соседние строки не подтверждают безопасное восстановление в новой копии. Загруженный список товаров ни при чём; поставка не создана, исходный лист не изменён.`;
}

function inferFormulaRepairs(grid, startRow, count, columns = FORMULA_COLUMNS) {
  const endRow = startRow + count - 1;
  const rowCount = grid?.properties?.gridProperties?.rowCount || 0;
  if (endRow > rowCount)
    fail(
      "roll_template_capacity_changed",
      `В исходном листе-шаблоне нет строки ${endRow}, необходимой для новой копии. Ваш загруженный список не изменён, Google Sheets не затронута.`,
      409,
    );

  const repairs = [];
  const inferred = new Map();
  for (let row = startRow; row <= endRow; row++) {
    for (const column of columns) {
      if (gridCell(grid, row, column).userEnteredValue?.formulaValue) continue;
      const columnLabel = columnName(column);
      const cell = `${columnLabel}${row}`;
      const previous = [];
      for (
        let sampleRow = row - 1;
        sampleRow >= Math.max(startRow, row - 3);
        sampleRow--
      ) {
        const formula =
          inferred.get(`${sampleRow}:${column}`) ||
          gridCell(grid, sampleRow, column).userEnteredValue?.formulaValue;
        if (!formula) break;
        previous.push({
          row: sampleRow,
          formula,
          family: formulaFamily(formula, `${columnLabel}${sampleRow}`),
        });
      }
      const family = previous[0]?.family;
      if (
        previous.length !== 3 ||
        previous.some((sample) => sample.family !== family)
      )
        fail("roll_template_formula_missing", formulaMissingMessage(cell), 409);

      const nextRow = row + 1;
      if (nextRow <= rowCount) {
        const nextFormula =
          gridCell(grid, nextRow, column).userEnteredValue?.formulaValue;
        if (
          nextFormula &&
          formulaFamily(nextFormula, `${columnLabel}${nextRow}`) !== family
        )
          fail("roll_template_formula_missing", formulaMissingMessage(cell), 409);
      }

      const source = previous[0];
      const formula = translateFormulaRow(source.formula, source.row, row);
      if (formulaFamily(formula, cell) !== family)
        fail("roll_template_formula_missing", formulaMissingMessage(cell), 409);
      const repair = {
        row,
        column,
        cell,
        sourceCell: `${columnLabel}${source.row}`,
        formula,
      };
      repairs.push(repair);
      inferred.set(`${row}:${column}`, formula);
    }
  }
  return repairs;
}

function uniqueIds(startRow, lines, operationId) {
  const used = new Set();
  return lines.map((_, index) => {
    const uid = `ritm-${operationId}-${index + 1}`;
    if (used.has(uid))
      fail(
        "supply_uid_conflict",
        "Не удалось создать уникальный ID строки.",
        409,
      );
    used.add(uid);
    return { row: startRow + index, uid };
  });
}

function cellsForColumn(values, valueKey, kind) {
  return {
    updateCells: {
      start: {
        sheetId: values.sheetId,
        rowIndex: values.startRow - 1,
        columnIndex: values.columnIndex,
      },
      rows: values.items.map((value) => ({
        values: [
          value[valueKey] === ""
            ? {}
            : {
                userEnteredValue:
                  kind === "number"
                    ? { numberValue: value[valueKey] }
                    : { stringValue: value[valueKey] },
              },
        ],
      })),
      fields: "userEnteredValue",
    },
  };
}

export class RollSupplySheetsWriter {
  constructor({ credentialWriter, fetcher = fetch, timeoutMs = 25000, documentId = ROLL_PRINTING_SHEET_ID, template = ROLL_PRINTING_SHEET, box = false } = {}) {
    if (!credentialWriter || typeof credentialWriter.token !== "function")
      throw new TypeError("A configured production writer is required");
    this.credentials = credentialWriter;
    this.documentId = documentId;
    this.template = template;
    this.box = box;
    this.formulaColumns = box ? [6, 10] : FORMULA_COLUMNS;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.preparedTemplates = new Map();
  }

  async request(url, { method = "GET", body, write = false } = {}) {
    const token = await this.credentials.token();
    this.credentials.metrics[write ? "writeRequests" : "readRequests"]++;
    let response;
    try {
      response = await this.fetcher(url, {
        method,
        redirect: "error",
        headers: {
          authorization: "Bearer " + token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw Object.assign(
        new Error(
          write
            ? "Ответ Google Sheets на запись не получен. Результат неизвестен; повторная запись заблокирована."
            : "Google Sheets API не ответил на проверочный запрос.",
        ),
        {
          code: write
            ? "roll_supply_write_uncertain"
            : "roll_supply_read_failed",
          status: 503,
          uncertain: write,
        },
      );
    }
    if (!response.ok) {
      let reason = "";
      try {
        const error = await response.json();
        reason =
          error.error?.errors?.[0]?.reason ||
          error.error?.status ||
          error.error?.message ||
          "";
      } catch {}
      const uncertain = write && response.status >= 500;
      const message =
        response.status === 403
          ? "Google не подтвердил право редактирования документа рулонной печати. Изменений не выполнено."
          : response.status === 404
            ? "Не найдены таблица или лист рулонной печати. Изменений не выполнено."
            : uncertain
              ? "Google Sheets не подтвердил результат записи. Повторная запись заблокирована до проверки истории операции."
              : "Google Sheets отклонил операцию" +
                (reason ? ` (${String(reason).slice(0, 100)})` : "") +
                ". Изменений не выполнено.";
      throw Object.assign(new Error(message), {
        code: uncertain
          ? "roll_supply_write_uncertain"
          : "roll_supply_api_rejected",
        status: response.status === 403 || response.status === 404 ? 403 : 409,
        uncertain,
      });
    }
    try {
      return await response.json();
    } catch {
      if (write)
        throw Object.assign(
          new Error(
            "Google принял запрос, но ответ записи прочитать не удалось. Результат неизвестен; повторная запись заблокирована.",
          ),
          { code: "roll_supply_write_uncertain", status: 503, uncertain: true },
        );
      throw Object.assign(
        new Error("Google Sheets API вернул некорректный ответ чтения."),
        { code: "roll_supply_read_failed", status: 503 },
      );
    }
  }

  async verifyEditAccess() {
    const value = await this.request(
      `https://www.googleapis.com/drive/v3/files/${this.documentId}?fields=id,capabilities(canEdit)`,
    );
    if (
      value.id !== this.documentId ||
      value.capabilities?.canEdit !== true
    )
      fail(
        "roll_supply_writer_forbidden",
        "Аккаунт записи не имеет подтверждённого права редактировать таблицу рулонной печати.",
        403,
      );
    return true;
  }

  async metadata() {
    const data = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.documentId}?includeGridData=false&fields=spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount)))`,
    );
    if (
      data.spreadsheetId !== this.documentId ||
      !Array.isArray(data.sheets)
    )
      fail(
        "roll_supply_metadata_invalid",
        "Google не подтвердил таблицу рулонной печати.",
        503,
      );
    return data.sheets.map((sheet) => sheet.properties || {});
  }

  async grid(sheetName, endRow = DATA_START_ROW + MAX_ORDERS - 1) {
    const range = `'${sheetName.replaceAll("'", "''")}'!A1:AC${endRow}`;
    const params = new URLSearchParams({
      includeGridData: "true",
      ranges: range,
      fields:
        "spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount)),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue))))",
    });
    const data = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.documentId}?${params}`,
    );
    if (data.spreadsheetId !== this.documentId)
      fail("roll_supply_grid_invalid", "Google вернул другой документ.", 503);
    const result = data.sheets?.[0];
    if (!result?.properties?.sheetId || result.properties.title !== sheetName)
      fail(
        "roll_supply_sheet_missing",
        "Google не подтвердил выбранный лист.",
        409,
      );
    return result;
  }

  async prepareCreate({ operationId, name, lines }) {
    await this.verifyEditAccess();
    const sheets = await this.metadata();
    const template = sheets.find(
      (sheet) => sheet.sheetId === this.template.gid,
    );
    if (!template || template.title !== this.template.name)
      fail(
        "roll_template_missing",
        "Лист-шаблон «OZON МОСКВА 10_10» изменился или недоступен. Запись остановлена.",
        409,
      );
    if (sheets.some((sheet) => fold(sheet.title) === fold(name)))
      fail(
        "roll_supply_name_exists",
        "Лист с таким названием уже существует.",
        409,
      );
    const scanRows = template.gridProperties?.rowCount || 0;
    if (scanRows > MAX_TEMPLATE_SCAN_ROWS)
      fail(
        "roll_template_too_large",
        "В шаблоне слишком много строк для полной проверки. Запись остановлена без изменений.",
        409,
      );
    const sourceGrid = await this.grid(
      template.title,
      Math.max(scanRows, DATA_START_ROW + MAX_ORDERS - 1),
    );
    validateTemplate(sourceGrid, this.box);
    if (gridCell(sourceGrid, 1, 1).userEnteredValue?.formulaValue)
      fail(
        "roll_template_title_formula",
        "Заголовок A1 шаблона содержит формулу и не может быть безопасно заменён названием поставки.",
        409,
      );
    const formulaRepairs = inferFormulaRepairs(
      sourceGrid,
      DATA_START_ROW,
      lines.length,
      this.formulaColumns,
    );
    const sourceRows = inputRows(sourceGrid);
    const clearThrough = Math.max(
      lastLiteralDataRow(sourceGrid),
      DATA_START_ROW + lines.length - 1,
    );
    const formulas = formulaSignature(
      sourceGrid,
      DATA_START_ROW,
      clearThrough,
      formulaRepairs,
    );
    validateTemplateInputRange(sourceGrid, clearThrough);
    if (this.box && lines.some((_, i) => [18, 19].some(column => gridCell(sourceGrid, DATA_START_ROW + i, column).userEnteredValue?.formulaValue)))
      fail("box_status_formula", "В полях готовности бокса найдена формула. Запись остановлена.");
    if (
      sourceRows
        .filter((row) => row.row <= clearThrough)
        .some((row) => row.uidCell.userEnteredValue?.formulaValue)
    )
      fail(
        "roll_template_uid_formula",
        "В служебной колонке UID шаблона обнаружена формула. Запись остановлена.",
        409,
      );
    const existingSheetIds = new Set(sheets.map((sheet) => sheet.sheetId));
    let newSheetId = randomInt(1, 2147483647);
    while (existingSheetIds.has(newSheetId))
      newSheetId = randomInt(1, 2147483647);
    const ids = uniqueIds(DATA_START_ROW, lines, operationId);
    this.preparedTemplates.set(operationId, sourceGrid);
    return {
      action: "create",
      operationId,
      name,
      sheetId: newSheetId,
      sourceSheetId: template.sheetId,
      startRow: DATA_START_ROW,
      clearThrough,
      formulaSignature: formulas,
      formulaRepairs,
      lines,
      uids: ids,
      sourceRows: sourceRows.length,
    };
  }

  async prepareAppend({ operationId, name, sheetId, lines, registeredSheets }) {
    await this.verifyEditAccess();
    const registered = [
      { gid: this.template.gid, name: this.template.name },
      ...(Array.isArray(registeredSheets) ? registeredSheets : []),
    ].find((sheet) => sheet.gid === sheetId && sheet.name === name);
    if (!registered)
      fail(
        "roll_supply_target_forbidden",
        "Этот лист не зарегистрирован как поставка рулонной печати.",
        403,
      );
    const sheets = await this.metadata();
    const target = sheets.find((sheet) => sheet.sheetId === sheetId);
    if (!target || target.title !== name)
      fail(
        "roll_supply_target_changed",
        "Лист поставки изменился. Обновите список и повторите проверку.",
        409,
      );
    const scanRows = target.gridProperties?.rowCount || 0;
    if (scanRows > MAX_TEMPLATE_SCAN_ROWS)
      fail(
        "roll_supply_too_large",
        "В листе слишком много строк для полной проверки. Запись остановлена без изменений.",
        409,
      );
    const grid = await this.grid(
      name,
      Math.max(scanRows, DATA_START_ROW + MAX_ORDERS - 1),
    );
    validateTemplate(grid);
    const rows = inputRows(grid);
    const existingArticles = new Set(
      rows
        .map((row) => entered(row.articleCell))
        .filter((article) => typeof article === "string" && article)
        .map(fold),
    );
    const duplicate = lines.find((line) =>
      existingArticles.has(fold(line.article)),
    );
    if (duplicate)
      fail(
        "roll_supply_article_exists",
        `Артикул «${duplicate.article}» уже есть в этой поставке. Измените его план в таблице или выберите новый артикул.`,
        409,
      );
    // A UID without an article or quantity can be a legacy orphaned service
    // marker. Preserve it by inserting new rows at the top, but do not treat
    // the marker alone as a live item that consumes capacity.
    const existingRows = rows.filter(
      (row) => entered(row.articleCell) || entered(row.quantityCell),
    );
    const lastActiveRow = existingRows.reduce(
      (last, row) => Math.max(last, row.row),
      DATA_START_ROW - 1,
    );
    if (lastActiveRow > DATA_START_ROW + MAX_ORDERS - 1)
      fail(
        "roll_supply_capacity",
        "В поставке есть активные товары за пределами 500 подготовленных строк. Добавление остановлено без изменений.",
        409,
      );
    if (existingRows.length + lines.length > MAX_ORDERS)
      fail(
        "roll_supply_capacity",
        `В поставке можно хранить не более ${MAX_ORDERS} артикулов. Добавление остановлено без изменений.`,
        409,
      );
    const templateRow = DATA_START_ROW;
    const missingFormulaColumns = this.formulaColumns.filter(
      (column) => !gridCell(grid, templateRow, column).userEnteredValue?.formulaValue,
    );
    if (missingFormulaColumns.length)
      fail(
        "roll_supply_rows_not_ready",
        `Нельзя добавить артикул в начало: в строке ${templateRow} отсутствуют формулы ${missingFormulaColumns.map(columnName).join(", ")}. Данные не записаны.`,
        409,
      );
    if ([5, 15, 24, 29, ...(this.box ? [18, 19] : [])].some((column) =>
      gridCell(grid, templateRow, column).userEnteredValue?.formulaValue,
    ))
      fail(
        "roll_supply_rows_not_ready",
        `Строка ${templateRow} не подготовлена для новой позиции. Данные не записаны.`,
        409,
      );
    const plannedRows = existingRows.map((row) => ({
      row: row.row,
      article: entered(row.articleCell),
      quantity: entered(row.quantityCell),
      uid: entered(row.uidCell),
    }));
    if (plannedRows.some((row) => !row.article || !row.uid || !row.quantity))
      fail(
        "roll_supply_existing_row_incomplete",
        "В поставке есть строка с неполным артикулом, количеством или ID. Сначала проверьте исходный лист; добавление остановлено.",
        409,
      );
    const startRow = DATA_START_ROW;
    const endRow = startRow + lines.length - 1;
    for (let row = startRow; row <= endRow; row++) {
      if (row > DATA_START_ROW + MAX_ORDERS - 1)
        fail(
          "roll_supply_capacity",
          "В поставке закончились строки для новых артикулов.",
          409,
        );
    }
    return {
      action: "append",
      name,
      sheetId,
      startRow,
      clearThrough: endRow,
      lines,
      uids: uniqueIds(startRow, lines, operationId),
      existingRows: plannedRows,
      copyFormulaColumns: Array.from({ length: 29 }, (_, i) => i + 1).filter(column => gridCell(grid, DATA_START_ROW, column).userEnteredValue?.formulaValue),
      formulaSourceRow: DATA_START_ROW + lines.length,
      verifyThrough: Math.max(scanRows, DATA_START_ROW + MAX_ORDERS - 1) + lines.length,
    };
  }

  async prepareItem({ action, name, sheetId, uid, article, expectedQuantity, quantity, registeredSheets, snapshot }) {
    await this.verifyEditAccess();
    const registered = [
      { gid: this.template.gid, name: this.template.name },
      ...(Array.isArray(registeredSheets) ? registeredSheets : []),
    ].find((sheet) => sheet.gid === sheetId && sheet.name === name);
    if (!registered)
      fail("roll_supply_target_forbidden", "Этот лист не зарегистрирован как поставка рулонной печати.", 403);
    const sheets = await this.metadata();
    const target = sheets.find((sheet) => sheet.sheetId === sheetId);
    if (!target || target.title !== name)
      fail("roll_supply_target_changed", "Лист поставки изменился. Обновите список и повторите действие.", 409);
    const rawUid = uid.startsWith(`${sheetId}::`) ? uid.slice(String(sheetId).length + 2) : uid;
    if (!rawUid || rawUid.includes("::"))
      fail("roll_supply_item_changed", "Не удалось подтвердить ID артикула в выбранной поставке.", 409);
    const grid = await this.grid(name, Math.max(target.gridProperties?.rowCount || 0, DATA_START_ROW + MAX_ORDERS - 1));
    validateTemplate(grid);
    const matches = inputRows(grid).filter((row) => entered(row.uidCell) === rawUid);
    if (matches.length !== 1)
      fail("roll_supply_item_changed", "Артикул не найден по уникальному ID. Обновите список поставки.", 409);
    const row = matches[0];
    if (entered(row.articleCell) !== article || Number(entered(row.quantityCell)) !== expectedQuantity)
      fail("roll_supply_item_changed", "Артикул или количество уже изменились в исходном листе. Обновите список и повторите действие.", 409);
    const order = snapshot?.supplies?.find((item) => item.sheetId === sheetId && item.uid === `${sheetId}::${rawUid}`);
    if (!order || order.article !== article || Number(order.quantity) !== expectedQuantity)
      fail("roll_supply_item_snapshot_missing", "Не удалось сверить свежие данные производства по этой позиции. Обновите поставку и повторите действие.", 409);
    if (snapshot?.packing?.status !== "available")
      fail("roll_supply_packing_unavailable", "Журнал упаковки не подтверждён. Изменение остановлено, чтобы не потерять уже записанную работу.", 409);
    const printed = Number.isFinite(order.remainingPrint) && order.remainingPrint >= 0 && order.remainingPrint <= expectedQuantity
      ? expectedQuantity - order.remainingPrint
      : Number.isFinite(order.printProgress) && order.printProgress >= 0
        ? order.printProgress
        : null;
    const cut = Number.isFinite(order.cutProgress) && order.cutProgress >= 0 ? order.cutProgress : null;
    const packed = Number.isFinite(order.packed) && order.packed >= 0 ? order.packed : null;
    if (gridCell(grid, row.row, 24).userEnteredValue?.formulaValue)
      fail("roll_supply_remaining_formula", `Остаток печати X${row.row} содержит формулу; изменение остановлено без записи.`, 409);
    if (this.formulaColumns.some((column) => !gridCell(grid, row.row, column).userEnteredValue?.formulaValue))
      fail("roll_supply_formula_missing", `В строке ${row.row} не найдены обязательные формулы. Изменение остановлено без записи.`, 409);
    if (action === "removeItem") {
      if (printed === null || printed > 0 || (cut !== null && cut > 0) || packed === null || packed > 0 || Number(order.packingRecords) > 0)
        fail("roll_supply_item_has_work", "Артикул нельзя удалить: по нему уже есть работа или её факт не удалось полностью проверить.", 409);
      return {
        action,
        name,
        sheetId,
        row: row.row,
        uid: rawUid,
        article,
        expectedQuantity,
        sourceSnapshot: { printed, cut, packed, packingRecords: Number(order.packingRecords) || 0 },
      };
    }
    if (printed === null)
      fail("roll_supply_print_progress_unknown", "Не удалось подтвердить остаток печати. Количество не изменено.", 409);
    if (quantity < printed || (cut !== null && quantity < cut) || packed === null || quantity < packed)
      fail("roll_supply_quantity_below_progress", `Новое количество не может быть меньше факта: печать ${printed}, резка ${cut ?? "нет данных"}, упаковка ${packed ?? "нет данных"} шт.`, 409);
    return {
      action,
      name,
      sheetId,
      row: row.row,
      uid: rawUid,
      article,
      expectedQuantity,
      quantity,
      remainingPrint: quantity - printed,
      sourceSnapshot: { printed, cut, packed, packingRecords: Number(order.packingRecords) || 0 },
    };
  }

  async prepareDelete({ name, sheetId }) {
    await this.verifyEditAccess();
    if (sheetId === this.template.gid)
      fail(
        "roll_supply_delete_template_forbidden",
        "Основной шаблон «OZON МОСКВА 10_10» удалять через управление поставками нельзя.",
        403,
      );
    const sheets = await this.metadata();
    const target = sheets.find((sheet) => sheet.sheetId === sheetId);
    if (!target)
      fail(
        "roll_supply_target_missing",
        "Лист уже удалён из Google Sheets. Обновите список поставок; повторное удаление не выполнялось.",
        409,
      );
    if (target.title !== name)
      fail(
        "roll_supply_target_changed",
        "Название листа изменилось в Google Sheets. Обновите список и подтвердите удаление актуального листа.",
        409,
      );
    return { action: "delete", name, sheetId };
  }

  async execute(plan) {
    if (plan.action === "updateItem" || plan.action === "removeItem") {
      const values = plan.action === "updateItem"
        ? { article: plan.article, quantity: plan.quantity, remainingPrint: plan.remainingPrint, uid: plan.uid }
        : { article: "", quantity: "", remainingPrint: "", uid: "" };
      const requests = [
        cellsForColumn({ sheetId: plan.sheetId, startRow: plan.row, columnIndex: 4, items: [{ article: values.article }] }, "article", values.article ? "string" : "clear"),
        cellsForColumn({ sheetId: plan.sheetId, startRow: plan.row, columnIndex: 14, items: [{ quantity: values.quantity }] }, "quantity", values.quantity === "" ? "clear" : "number"),
        cellsForColumn({ sheetId: plan.sheetId, startRow: plan.row, columnIndex: 23, items: [{ quantity: values.remainingPrint }] }, "quantity", values.remainingPrint === "" ? "clear" : "number"),
        cellsForColumn({ sheetId: plan.sheetId, startRow: plan.row, columnIndex: 28, items: [{ uid: values.uid }] }, "uid", values.uid ? "string" : "clear"),
      ];
      const result = await this.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${this.documentId}:batchUpdate`,
        { method: "POST", body: { requests }, write: true },
      );
      return { acceptedAt: new Date().toISOString(), sheetId: plan.sheetId, name: plan.name, row: plan.row, requestId: result.spreadsheetId || this.documentId };
    }
    if (plan.action === "delete") {
      const result = await this.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${this.documentId}:batchUpdate`,
        {
          method: "POST",
          body: { requests: [{ deleteSheet: { sheetId: plan.sheetId } }] },
          write: true,
        },
      );
      return {
        acceptedAt: new Date().toISOString(),
        sheetId: plan.sheetId,
        name: plan.name,
        requestId: result.spreadsheetId || this.documentId,
      };
    }
    const endRow =
      plan.action === "create" ? plan.clearThrough : plan.clearThrough;
    const inputCount = endRow - plan.startRow + 1;
    const articleItems = Array.from({ length: inputCount }, (_, index) => ({
      article: plan.lines[index]?.article || "",
    }));
    const quantityItems = Array.from({ length: inputCount }, (_, index) => ({
      quantity: plan.lines[index]?.quantity ?? "",
    }));
    const sheetId = plan.sheetId;
    const requests = [];
    if (plan.action === "append") {
      requests.push({
        insertDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: DATA_START_ROW - 1,
            endIndex: DATA_START_ROW - 1 + inputCount,
          },
          inheritFromBefore: false,
        },
      });
      for (const column of (plan.copyFormulaColumns || this.formulaColumns)) {
        requests.push({
          copyPaste: {
            source: {
              sheetId,
              startRowIndex: plan.formulaSourceRow - 1,
              endRowIndex: plan.formulaSourceRow,
              startColumnIndex: column - 1,
              endColumnIndex: column,
            },
            destination: {
              sheetId,
              startRowIndex: DATA_START_ROW - 1,
              endRowIndex: DATA_START_ROW - 1 + inputCount,
              startColumnIndex: column - 1,
              endColumnIndex: column,
            },
            pasteType: "PASTE_FORMULA",
          },
        });
      }
    }
    if (plan.action === "create")
      requests.push({
        duplicateSheet: {
          sourceSheetId: plan.sourceSheetId,
          newSheetId: plan.sheetId,
          newSheetName: plan.name,
        },
      });
    if (plan.action === "create") {
      const sourceGrid = this.preparedTemplates.get(plan.operationId);
      if (!sourceGrid)
        fail(
          "roll_supply_preflight_expired",
          "Проверка шаблона устарела. Подтвердите состав поставки ещё раз; изменений не выполнено.",
          409,
        );
      this.preparedTemplates.delete(plan.operationId);
      requests.push(
        clearCopiedData(
          sourceGrid,
          sheetId,
          plan.clearThrough,
          plan.formulaRepairs,
        ),
      );
      const titleCell = {
        userEnteredValue: { stringValue: plan.name },
      };
      const bannerFormula = gridCell(sourceGrid, 3, 1).userEnteredValue?.formulaValue;
      requests.push(
        {
          updateCells: {
            start: { sheetId, rowIndex: 0, columnIndex: 0 },
            rows: [{ values: [titleCell] }],
            fields: "userEnteredValue",
          },
        },
        {
          updateCells: {
            start: { sheetId, rowIndex: 2, columnIndex: 0 },
            rows: [
              {
                values: [
                  bannerFormula
                    ? { userEnteredValue: { formulaValue: bannerFormula } }
                    : {},
                ],
              },
            ],
            fields: "userEnteredValue",
          },
        },
      );
    }
    requests.push(
      cellsForColumn(
        {
          sheetId,
          startRow: plan.startRow,
          columnIndex: 4,
          items: articleItems,
        },
        "article",
        "string",
      ),
      ...(!this.box ? [cellsForColumn(
        { sheetId, startRow: plan.startRow, columnIndex: 23, items: plan.lines.map(line => ({ quantity: line.quantity })) },
        "quantity", "number",
      )] : []),
      cellsForColumn(
        {
          sheetId,
          startRow: plan.startRow,
          columnIndex: 14,
          items: quantityItems,
        },
        "quantity",
        "number",
      ),
    );
    const uidItems = Array.from({ length: inputCount }, (_, index) => ({
      uid: plan.uids[index]?.uid || "",
    }));
    requests.push(
      cellsForColumn(
        { sheetId, startRow: plan.startRow, columnIndex: 28, items: uidItems },
        "uid",
        "string",
      ),
    );
    if (this.box && plan.action === "create") requests.push(cellsForColumn({ sheetId, startRow: 1, columnIndex: 28, items: [{ uid: "UID" }] }, "uid", "string"));
    if (this.box) requests.push({ updateCells: { start: { sheetId, rowIndex: plan.startRow - 1, columnIndex: 17 },
      rows: plan.lines.map(() => ({ values: [{ userEnteredValue: { boolValue: false } }, { userEnteredValue: { boolValue: false } }] })), fields: "userEnteredValue" } });
    if (plan.manifest) requests.push(...supplyManifestRequests(sheetId, plan.manifest));
    const result = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.documentId}:batchUpdate`,
      { method: "POST", body: { requests }, write: true },
    );
    if (plan.action === "create") {
      const duplicateReply = result.replies?.[0]?.duplicateSheet?.properties;
      if (
        duplicateReply?.sheetId !== plan.sheetId ||
        duplicateReply?.title !== plan.name
      )
        throw Object.assign(
          new Error(
            "Google подтвердил запрос без ожидаемого ID и названия листа.",
          ),
          { code: "roll_supply_write_uncertain", status: 503, uncertain: true },
        );
    }
    return { acceptedAt: new Date().toISOString(), sheetId, name: plan.name };
  }

  async verify(plan) {
    const sheets = await this.metadata();
    const target = sheets.find((sheet) => sheet.sheetId === plan.sheetId);
    if (plan.action === "delete") {
      if (target)
        fail(
          "roll_supply_delete_readback_failed",
          `Google Sheets ещё возвращает лист «${plan.name}». Удаление не объявлено завершённым; проверьте состояние листа.`,
          503,
        );
      return {
        verifiedAt: new Date().toISOString(),
        sheetId: plan.sheetId,
        name: plan.name,
        rows: 0,
        calculations: [],
      };
    }
    if (!target || target.title !== plan.name)
      fail(
        "roll_supply_readback_failed",
        "Лист после записи не найден по точному ID и названию.",
        503,
      );
    const grid = await this.grid(
      plan.name,
      Math.max(
        DATA_START_ROW + MAX_ORDERS - 1,
        plan.clearThrough || 0,
        plan.verifyThrough || plan.row || 0,
      ),
    );
    if (plan.action === "updateItem" || plan.action === "removeItem") {
      const currentArticle = entered(gridCell(grid, plan.row, 5));
      const currentQuantity = entered(gridCell(grid, plan.row, 15));
      const currentUid = entered(gridCell(grid, plan.row, 29));
      const expectedRemoved = plan.action === "removeItem";
      if (expectedRemoved ? currentArticle || currentQuantity || currentUid : currentArticle !== plan.article || Number(currentQuantity) !== plan.quantity || currentUid !== plan.uid)
        fail("roll_supply_item_readback_failed", `Google Sheets не подтвердил изменение артикула в строке ${plan.row}. Повторная запись заблокирована.`, 503);
      if (expectedRemoved ? entered(gridCell(grid, plan.row, 24)) !== "" : Number(entered(gridCell(grid, plan.row, 24))) !== plan.remainingPrint)
        fail("roll_supply_item_progress_readback_failed", `Остаток печати X${plan.row} не совпал с ожидаемым значением. Повторная запись заблокирована.`, 503);
      if (this.formulaColumns.some((column) => !gridCell(grid, plan.row, column).userEnteredValue?.formulaValue))
        fail("roll_supply_formula_readback_failed", `После изменения строки ${plan.row} формулы не подтверждены. Повторная запись заблокирована.`, 503);
      return { verifiedAt: new Date().toISOString(), sheetId: plan.sheetId, name: plan.name, row: plan.row, rows: 1, calculations: [] };
    }
    if (plan.action === "append") {
      for (const item of plan.existingRows) {
        const row = item.row + plan.lines.length;
        if (entered(gridCell(grid, row, 5)) !== item.article || Number(entered(gridCell(grid, row, 15))) !== Number(item.quantity) || entered(gridCell(grid, row, 29)) !== item.uid)
          fail("roll_supply_existing_rows_shift_failed", `После вставки в начало не удалось подтвердить прежний артикул и ID в строке ${row}. Повторная запись заблокирована.`, 503);
      }
    }
    if (plan.action === "create") {
      if (entered(gridCell(grid, 1, 1)) !== plan.name)
        fail(
          "roll_supply_title_readback_failed",
          "Лист создан, но заголовок не обновлён. Повторная запись заблокирована.",
          503,
        );
      if (entered(gridCell(grid, 3, 1)))
        fail(
          "roll_supply_stale_banner_readback_failed",
          "Лист создан, но старая надпись шаблона осталась. Повторная запись заблокирована.",
          503,
        );
      const actualFormulas = formulaSignature(
        grid,
        DATA_START_ROW,
        plan.clearThrough,
      );
      if (
        actualFormulas.count !== plan.formulaSignature.count ||
        actualFormulas.digest !== plan.formulaSignature.digest
      )
        fail(
          "roll_supply_formula_readback_failed",
          "Лист создан, но набор формул отличается от шаблона. Повторная запись заблокирована.",
          503,
        );
      const expected = new Map();
      plan.lines.forEach((line, index) => {
        const row = plan.startRow + index;
        expected.set(`E${row}`, line.article);
        expected.set(`O${row}`, line.quantity);
        if (!this.box) expected.set(`X${row}`, line.quantity);
        if (this.box) { expected.set(`R${row}`, false); expected.set(`S${row}`, false); }
        expected.set(`AC${row}`, plan.uids[index].uid);
      });
      for (let row = DATA_START_ROW; row <= plan.clearThrough; row++) {
        for (let column = 1; column <= 29; column++) {
          const cell = gridCell(grid, row, column);
          if (cell.userEnteredValue?.formulaValue) continue;
          const address = columnName(column) + row;
          if (expected.has(address)) {
            if (entered(cell) !== expected.get(address))
              fail(
                "roll_supply_input_readback_failed",
                `Лист создан, но значение ${address} не совпадает с подтверждённой поставкой. Повторная запись заблокирована.`,
                503,
              );
          } else if (isLiteralValue(cell)) {
            fail(
              "roll_supply_stale_data_readback_failed",
              `Лист создан, но старое значение осталось в ${address}. Повторная запись заблокирована.`,
              503,
            );
          }
        }
      }
    }
    if (plan.action === "append") {
      for (let index = 0; index < plan.lines.length; index++) {
        const row = plan.startRow + index;
        if (this.formulaColumns.some((column) => !gridCell(grid, row, column).userEnteredValue?.formulaValue))
          fail("roll_supply_formula_readback_failed", `В новой строке ${row} формулы не подтверждены. Повторная запись заблокирована.`, 503);
      }
    }
    const calculations = [];
    for (let index = 0; index < plan.lines.length; index++) {
      const row = plan.startRow + index;
      if (this.box && [18, 19].some(column => entered(gridCell(grid, row, column)) !== false))
        fail("box_status_readback_failed", "Исходная готовность новых товаров бокса не подтверждена.", 503);
      const article = entered(gridCell(grid, row, 5));
      const quantity = entered(gridCell(grid, row, 15));
      if (
        article !== plan.lines[index].article ||
        Number(quantity) !== plan.lines[index].quantity
      )
        fail(
          "roll_supply_readback_failed",
          `Google вернул другое значение в строке ${row}; операция не объявлена успешной.`,
          503,
        );
      if (!this.box && Number(entered(gridCell(grid, row, 24))) !== plan.lines[index].quantity)
        fail(
          "roll_supply_print_remainder_readback_failed",
          `План записан, но остаток печати X${row} не инициализирован количеством поставки. Повторная запись заблокирована.`,
          503,
        );
      if (
        this.formulaColumns.some(
          (column) =>
            !gridCell(grid, row, column).userEnteredValue?.formulaValue,
        )
      )
        fail(
          "roll_supply_formula_readback_failed",
          `Данные записаны, но формулы строки ${row} не подтверждены. Повторная запись заблокирована.`,
          503,
        );
      if (!effective(gridCell(grid, row, 29)))
        fail(
          "roll_supply_uid_readback_failed",
          `Данные записаны, но UID строки ${row} не появился. Повторная запись заблокирована.`,
          503,
        );
      for (const column of this.formulaColumns) {
        const cell = gridCell(grid, row, column),
          value = cell.effectiveValue;
        if (value?.errorValue)
          calculations.push({
            cell: String.fromCharCode(64 + column) + String(row),
            error: "#" + String(value.errorValue.type || "ERROR"),
          });
      }
    }
    return {
      verifiedAt: new Date().toISOString(),
      sheetId: plan.sheetId,
      name: plan.name,
      rows: plan.lines.length,
      calculations,
    };
  }
}

export class RollSupplyManagementService {
  constructor(
    store,
    { writer = null, now = () => Date.now(), refresh = null, getPrintingSnapshot = null } = {},
  ) {
    this.store = store;
    this.writer = writer;
    this.now = now;
    this.refresh = refresh;
    this.getPrintingSnapshot = getPrintingSnapshot;
    this.busy = false;
    this.lastSheetSyncAt = 0;
    this.sheetSyncPromise = null;
    this.sheetSync = { status: "not_checked", checkedAt: null, removed: [] };
    for (const operation of store.recentRollSupplyOperations(100)) {
      if (operation.status === "writing")
        store.updateRollSupplyOperation(
          operation.id,
          "uncertain",
          {
            message:
              "Агент перезапустился во время записи. Проверьте лист в Google Sheets; повторная запись не выполняется.",
          },
          new Date(now()).toISOString(),
        );
      else if (operation.status === "checking")
        store.updateRollSupplyOperation(
          operation.id,
          "written_unverified",
          {
            message:
              "Агент перезапустился после записи до проверки. Лист не записывается повторно.",
          },
          new Date(now()).toISOString(),
        );
    }
  }

  writeConflict(documentIds = [ROLL_PRINTING_SHEET_ID]) {
    const tables = new Set(
      this.store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    // Serialize writes only when they address the same Google spreadsheet.
    // A repair in another production module must not disable roll-supply work.
    if (tables.has("test_repair_proposals")) {
      const proposals = this.store.db
        .prepare(
          "SELECT payload FROM test_repair_proposals WHERE status IN ('queued','executing','checking','uncertain')",
        )
        .all();
      for (const row of proposals) {
        try {
          const target = JSON.parse(row.payload || "{}").target;
          if (documentIds.includes(target?.documentId))
            return "Исправление этой же таблицы выполняется или требует сверки. Создание поставки возобновится после проверки.";
        } catch {
          // An unreadable repair record has no proven link to this document.
          // Keep unrelated application areas available; same-document writes
          // remain protected by their own validated target and operation checks.
        }
      }
    }
    if (tables.has("source_recovery_operations")) {
      const operations = this.store.db
        .prepare(
          "SELECT target FROM source_recovery_operations WHERE status IN ('repairing','checking','uncertain','written_unverified')",
        )
        .all();
      for (const row of operations) {
        try {
          const target = JSON.parse(row.target || "{}");
          if (documentIds.includes(target?.documentId))
            return "Восстановление в этой же таблице выполняется или требует сверки. Создание поставки возобновится после проверки.";
        } catch {
          // See the formula-repair case above: do not impose a global lock.
        }
      }
    }
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM roll_supply_operations WHERE status IN ('writing','checking','uncertain','written_unverified') LIMIT 1",
        )
        .get()
    )
      return "Предыдущая операция с поставкой требует сверки. Новая запись временно остановлена.";
    return null;
  }

  state() {
    const conflict = this.writeConflict();
    return {
      ok: true,
      available: !!this.writer && !conflict,
      reason: this.writer
        ? conflict
        : "Production writer не настроен. Создание и изменение листов недоступны.",
      documentId: ROLL_PRINTING_SHEET_ID,
      documentName: "OZON РУЛОННАЯ ПЕЧАТЬ",
      template: {
        sheetId: ROLL_PRINTING_SHEET.gid,
        name: ROLL_PRINTING_SHEET.name,
      },
      busy: this.busy,
      sheetSync: this.sheetSync,
      registeredSheets: [
        { gid: ROLL_PRINTING_SHEET.gid, name: ROLL_PRINTING_SHEET.name },
        ...(this.store.meta(REGISTRY_KEY) || []),
      ],
      operations: this.store
        .recentRollSupplyOperations(100)
        .map((item) => this.publicOperation(item)),
    };
  }

  async syncRegisteredSheets({ refreshOnChange = false, force = false } = {}) {
    if (!this.writer)
      return { status: "unavailable", removed: [], renamed: [] };
    if (this.sheetSyncPromise) return this.sheetSyncPromise;
    const now = this.now();
    if (!force && now - this.lastSheetSyncAt < 60_000)
      return { ...this.sheetSync, removed: [], renamed: [] };
    this.sheetSyncPromise = (async () => {
      try {
        const actual = await this.writer.metadata();
        const byId = new Map(actual.map((sheet) => [sheet.sheetId, sheet]));
        const registered = this.store.meta(REGISTRY_KEY) || [];
        const next = [],
          removed = [],
          renamed = [];
        for (const item of registered) {
          const sheet = byId.get(item.gid);
          if (!sheet) {
            removed.push(item.name);
            continue;
          }
          if (!titleIsValid(sheet.title)) continue;
          if (sheet.title !== item.name)
            renamed.push({ from: item.name, to: sheet.title, gid: item.gid });
          next.push({ gid: item.gid, name: sheet.title });
        }
        for (const operation of this.store.recentRollSupplyOperations(100)) {
          if (
            operation.action !== "delete" ||
            !["uncertain", "written_unverified"].includes(operation.status)
          )
            continue;
          const sheetId =
            operation.result?.sheetId || operation.payload.plan?.sheetId;
          if (!Number.isSafeInteger(sheetId) || byId.has(sheetId)) continue;
          const verifiedAt = new Date(this.now()).toISOString();
          const result = {
            ...(operation.result || {}),
            sheetId,
            name: operation.payload.name,
            verifiedAt,
            reconciledBy: "live_google_metadata",
            message:
              "Отсутствие листа подтверждено свежими метаданными Google Sheets. Повторный запрос не выполнялся.",
          };
          this.store.updateRollSupplyOperation(
            operation.id,
            "verified",
            result,
            verifiedAt,
          );
          this.store.log(
            "roll_supply_delete_reconciled",
            `Удаление «${operation.payload.name}» подтверждено read-only сверкой Google Sheets`,
            null,
            verifiedAt,
          );
        }
        const changed =
          removed.length > 0 ||
          renamed.length > 0 ||
          next.length !== registered.length;
        if (changed) this.store.meta(REGISTRY_KEY, next);
        this.lastSheetSyncAt = this.now();
        this.sheetSync = {
          status: changed ? "updated" : "current",
          checkedAt: new Date(this.now()).toISOString(),
          removed,
          renamed,
        };
        if (changed && refreshOnChange) {
          try {
            await this.refresh?.();
          } catch (error) {
            this.sheetSync = {
              ...this.sheetSync,
              refreshError:
                error?.message || "Не удалось сразу обновить снимок поставок.",
            };
          }
        }
        return this.sheetSync;
      } catch (error) {
        this.lastSheetSyncAt = this.now();
        this.sheetSync = {
          status: "error",
          checkedAt: new Date(this.now()).toISOString(),
          removed: [],
          renamed: [],
          error: error?.message || "Не удалось сверить список листов.",
        };
        return this.sheetSync;
      } finally {
        this.sheetSyncPromise = null;
      }
    })();
    return this.sheetSyncPromise;
  }

  async execute(input) {
    if (!this.writer)
      fail(
        "roll_supply_writer_unavailable",
        "Создание поставки остановлено: production writer не настроен.",
        503,
      );
    const payload = validateRollSupplyPayload(input);
    const identity = {
      action: payload.action,
      name: payload.name,
      sheetId: payload.sheetId || null,
      ...(payload.action === "create" || payload.action === "append"
        ? { lines: payload.lines }
        : payload.action === "updateItem" || payload.action === "removeItem"
          ? {
              uid: payload.uid,
              article: payload.article,
              expectedQuantity: payload.expectedQuantity,
              ...(payload.action === "updateItem" ? { quantity: payload.quantity } : {}),
            }
          : {}),
    };
    const hash = requestHash(identity);
    const previous = this.store.rollSupplyOperation(payload.operationId);
    if (previous) {
      if (previous.requestHash !== hash)
        fail(
          "roll_supply_operation_conflict",
          "ID операции уже использован для другого состава поставки.",
          409,
        );
      return this.publicOperation(previous);
    }
    if (this.busy)
      fail(
        "roll_supply_operation_active",
        "Дождитесь завершения текущей операции с листом рулонной печати.",
        409,
      );
    const conflict = this.writeConflict();
    if (conflict) fail("roll_supply_operation_conflict", conflict, 409);
    this.busy = true;
    try {
      const registeredSheets = this.store.meta(REGISTRY_KEY) || [];
      let snapshot = null;
      if (payload.action === "updateItem" || payload.action === "removeItem") {
        const refreshed = await this.refresh?.();
        if (!refreshed?.ok || refreshed.partial)
          fail("roll_supply_fresh_snapshot_required", "Не удалось получить свежие и полные данные производства. Изменение остановлено без записи.", 409);
        snapshot = this.getPrintingSnapshot?.();
      }
      const plan =
        payload.action === "create"
          ? await this.writer.prepareCreate(payload)
          : payload.action === "append"
            ? await this.writer.prepareAppend({
                ...payload,
                registeredSheets,
              })
            : payload.action === "updateItem" || payload.action === "removeItem"
              ? await this.writer.prepareItem({
                  ...payload,
                  registeredSheets,
                  snapshot,
                })
              : await this.writer.prepareDelete({
                  ...payload,
                  registeredSheets,
                });
      const approvedAt = new Date(this.now()).toISOString();
      this.store.beginRollSupplyOperation(
        payload.operationId,
        payload.action,
        hash,
        {
          ...payload,
          plan,
          approval: {
            principal: "authenticated_local_owner",
            approvedAt,
            exactOperationId: payload.operationId,
          },
        },
        approvedAt,
      );
      this.store.log(
        "roll_supply_owner_approved",
        `${payload.action === "create" ? "Создание листа" : payload.action === "append" ? "Добавление товаров в начало списка" : payload.action === "updateItem" ? "Изменение количества артикула" : payload.action === "removeItem" ? "Удаление артикула" : "Удаление листа"} «${payload.name}»: ${payload.lines?.length || 1} строк; точная операция подтверждена владельцем`,
        null,
        new Date(this.now()).toISOString(),
      );
      let accepted;
      try {
        accepted = await this.writer.execute(plan);
      } catch (error) {
        const uncertain =
          !!error.uncertain || error.code === "roll_supply_write_uncertain";
        const result = {
          message: error.message || "Google Sheets не подтвердил запись.",
          code: error.code || "roll_supply_write_failed",
        };
        this.store.updateRollSupplyOperation(
          payload.operationId,
          uncertain ? "uncertain" : "failed",
          result,
          new Date(this.now()).toISOString(),
        );
        this.store.log(
          uncertain
            ? "roll_supply_write_uncertain"
            : "roll_supply_write_failed",
          result.message,
          null,
          new Date(this.now()).toISOString(),
        );
        throw error;
      }
      if (payload.action === "create") {
        const registry = this.store.meta(REGISTRY_KEY) || [];
        this.store.meta(REGISTRY_KEY, [
          ...registry.filter((sheet) => sheet.gid !== plan.sheetId),
          { gid: plan.sheetId, name: plan.name },
        ]);
      }
      this.store.updateRollSupplyOperation(
        payload.operationId,
        "checking",
        accepted,
        new Date(this.now()).toISOString(),
      );
      let verification;
      try {
        verification = await this.writer.verify(plan);
      } catch (error) {
        const result = {
          ...accepted,
          message: error.message || "Проверка записи не завершилась.",
          code: error.code || "roll_supply_readback_failed",
        };
        this.store.updateRollSupplyOperation(
          payload.operationId,
          "written_unverified",
          result,
          new Date(this.now()).toISOString(),
        );
        this.store.log(
          "roll_supply_written_unverified",
          result.message,
          null,
          new Date(this.now()).toISOString(),
        );
        return this.publicOperation(
          this.store.rollSupplyOperation(payload.operationId),
        );
      }
      const status = verification.calculations.length
        ? "verified_with_calculation_errors"
        : "verified";
      let refreshWarning = null;
      if (payload.action === "delete") {
        const registry = this.store.meta(REGISTRY_KEY) || [];
        this.store.meta(
          REGISTRY_KEY,
          registry.filter((sheet) => sheet.gid !== plan.sheetId),
        );
      }
      try {
        await this.refresh?.();
      } catch {
        refreshWarning =
          "Проверка значений в Google Sheets завершена, но снимок RITM обновится при следующем цикле.";
      }
      const result = {
        ...accepted,
        ...verification,
        refreshWarning,
        message: verification.calculations.length
          ? "Артикулы и количество подтверждены. В зависимых формулах есть ошибки; проверьте список ячеек."
          : "Google Sheets подтвердил лист, состав и формулы." +
            (refreshWarning ? " " + refreshWarning : ""),
      };
      this.store.updateRollSupplyOperation(
        payload.operationId,
        status,
        result,
        new Date(this.now()).toISOString(),
      );
      this.store.log(
        status,
        result.message,
        null,
        new Date(this.now()).toISOString(),
      );
      return this.publicOperation(
        this.store.rollSupplyOperation(payload.operationId),
      );
    } finally {
      this.busy = false;
    }
  }

  publicOperation(operation) {
    return {
      id: operation.id,
      action: operation.action,
      status: operation.status,
      name: operation.payload.name,
      sheetId:
        operation.result?.sheetId || operation.payload.plan?.sheetId || null,
      rows:
        operation.payload.lines?.length ||
        (operation.action === "updateItem" || operation.action === "removeItem"
          ? 1
          : 0),
      updatedAt: operation.updatedAt,
      message: operation.result?.message || null,
      calculations: operation.result?.calculations || [],
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${ROLL_PRINTING_SHEET_ID}/edit#gid=${operation.result?.sheetId || operation.payload.plan?.sheetId || ""}`,
    };
  }
}

export function rollSupplyFormulaColumns() {
  return FORMULA_COLUMNS.map((column) => String.fromCharCode(64 + column));
}

export function supplyManifestRequests(sheetId, manifest) {
  return [
    { deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataKey: "RITM_SUPPLY", metadataLocation: { sheetId }, locationMatchingStrategy: "EXACT_LOCATION" } } } },
    { createDeveloperMetadata: { developerMetadata: { metadataKey: "RITM_SUPPLY", metadataValue: JSON.stringify(manifest), location: { sheetId }, visibility: "DOCUMENT" } } },
  ];
}
