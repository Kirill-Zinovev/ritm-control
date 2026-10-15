import { createHash, randomInt } from "node:crypto";
import {
  ROLL_PRINTING_SHEET,
  ROLL_PRINTING_SHEET_ID,
} from "../worker/printing.js";
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

function validatePayload(input) {
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
        : ["action", "explicitWriteApproval", "name", "operationId", "sheetId"];
  if (
    !input ||
    Object.keys(input).sort().join(",") !== allowed.sort().join(",") ||
    !["create", "append", "delete"].includes(input.action) ||
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

function clearCopiedData(grid, sheetId, throughRow) {
  const rows = [];
  for (let row = DATA_START_ROW; row <= throughRow; row++) {
    const values = [];
    for (let column = 1; column <= 29; column++) {
      const formula = gridCell(grid, row, column).userEnteredValue?.formulaValue;
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

function formulaSignature(grid, startRow, endRow) {
  const formulas = [];
  for (let row = startRow; row <= endRow; row++)
    for (let column = 1; column <= 29; column++) {
      const formula = gridCell(grid, row, column).userEnteredValue?.formulaValue;
      if (formula) formulas.push([`${columnName(column)}${row}`, formula]);
    }
  return {
    count: formulas.length,
    digest: createHash("sha256").update(JSON.stringify(formulas)).digest("hex"),
  };
}

function validateTemplate(grid) {
  if (
    fold(entered(gridCell(grid, HEADER_ROW, 5))) !== "артикул" ||
    fold(entered(gridCell(grid, HEADER_ROW, 15))) !== "кол-во" ||
    fold(entered(gridCell(grid, UID_HEADER_ROW, 29))) !== "uid"
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

function validatePreparedFormulaRows(grid, startRow, count) {
  const endRow = startRow + count - 1;
  const rowCount = grid?.properties?.gridProperties?.rowCount || 0;
  if (endRow > rowCount)
    fail(
      "roll_template_capacity_changed",
      `В шаблоне нет строки ${endRow}, необходимой для этой поставки. Исходный лист не затронут.`,
      409,
    );
  for (let row = startRow; row <= endRow; row++) {
    const missingColumns = FORMULA_COLUMNS.filter(
      (column) => !gridCell(grid, row, column).userEnteredValue?.formulaValue,
    ).map((column) => String.fromCharCode(64 + column));
    if (missingColumns.length)
      fail(
        "roll_template_formula_missing",
        `В строке ${row}, нужной для этой поставки, отсутствует формула ${missingColumns.join(", ")}. Исходный лист не затронут.`,
        409,
      );
  }
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
  constructor({ credentialWriter, fetcher = fetch, timeoutMs = 25000 } = {}) {
    if (!credentialWriter || typeof credentialWriter.token !== "function")
      throw new TypeError("A configured production writer is required");
    this.credentials = credentialWriter;
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
      `https://www.googleapis.com/drive/v3/files/${ROLL_PRINTING_SHEET_ID}?fields=id,capabilities(canEdit)`,
    );
    if (
      value.id !== ROLL_PRINTING_SHEET_ID ||
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
      `https://sheets.googleapis.com/v4/spreadsheets/${ROLL_PRINTING_SHEET_ID}?includeGridData=false&fields=spreadsheetId,sheets(properties(sheetId,title,gridProperties(rowCount)))`,
    );
    if (
      data.spreadsheetId !== ROLL_PRINTING_SHEET_ID ||
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
      `https://sheets.googleapis.com/v4/spreadsheets/${ROLL_PRINTING_SHEET_ID}?${params}`,
    );
    if (data.spreadsheetId !== ROLL_PRINTING_SHEET_ID)
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
      (sheet) => sheet.sheetId === ROLL_PRINTING_SHEET.gid,
    );
    if (!template || template.title !== ROLL_PRINTING_SHEET.name)
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
    validateTemplate(sourceGrid);
    if (gridCell(sourceGrid, 1, 1).userEnteredValue?.formulaValue)
      fail(
        "roll_template_title_formula",
        "Заголовок A1 шаблона содержит формулу и не может быть безопасно заменён названием поставки.",
        409,
      );
    validatePreparedFormulaRows(sourceGrid, DATA_START_ROW, lines.length);
    const sourceRows = inputRows(sourceGrid);
    const clearThrough = Math.max(
      lastLiteralDataRow(sourceGrid),
      DATA_START_ROW + lines.length - 1,
    );
    const formulas = formulaSignature(sourceGrid, DATA_START_ROW, clearThrough);
    validateTemplateInputRange(sourceGrid, clearThrough);
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
      lines,
      uids: ids,
      sourceRows: sourceRows.length,
    };
  }

  async prepareAppend({ operationId, name, sheetId, lines, registeredSheets }) {
    await this.verifyEditAccess();
    const registered = [
      { gid: ROLL_PRINTING_SHEET.gid, name: ROLL_PRINTING_SHEET.name },
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
    const lastOccupied = rows.reduce(
      (last, row) =>
        entered(row.articleCell) ||
        entered(row.quantityCell) ||
        entered(row.uidCell)
          ? row.row
          : last,
      DATA_START_ROW - 1,
    );
    if (lastOccupied > DATA_START_ROW + MAX_ORDERS - 1)
      fail(
        "roll_supply_capacity",
        "В листе уже есть товары за пределами 500 подготовленных строк. Добавление остановлено.",
        409,
      );
    const startRow = Math.max(DATA_START_ROW, lastOccupied + 1);
    if (startRow + lines.length - 1 > DATA_START_ROW + MAX_ORDERS - 1)
      fail(
        "roll_supply_capacity",
        "В листе закончились подготовленные строки с формулами.",
        409,
      );
    for (let row = startRow; row < startRow + lines.length; row++) {
      const occupiedColumn = Array.from({ length: 29 }, (_, index) => index + 1)
        .find((column) => isLiteralValue(gridCell(grid, row, column)));
      const forbiddenFormulaColumn = [5, 15, 24, 29].find(
        (column) => gridCell(grid, row, column).userEnteredValue?.formulaValue,
      );
      const missingFormulaColumns = FORMULA_COLUMNS.filter(
        (column) =>
          !gridCell(grid, row, column).userEnteredValue?.formulaValue,
      );
      if (occupiedColumn || forbiddenFormulaColumn || missingFormulaColumns.length)
        fail(
          "roll_supply_rows_not_ready",
          occupiedColumn
            ? `В строке ${row} уже есть лишнее значение ${columnName(occupiedColumn)}${row}. Данные не записаны.`
            : forbiddenFormulaColumn
              ? `В поле ${columnName(forbiddenFormulaColumn)}${row} строка не подготовлена для нового товара. Данные не записаны.`
              : `В строке ${row} не подготовлена формула ${missingFormulaColumns.map(columnName).join(", ")}. Данные не записаны.`,
          409,
        );
    }
    return {
      action: "append",
      name,
      sheetId,
      startRow,
      clearThrough: startRow + lines.length - 1,
      lines,
      uids: uniqueIds(startRow, lines, operationId),
      sourceRows: rows.length,
    };
  }

  async prepareDelete({ name, sheetId }) {
    await this.verifyEditAccess();
    if (sheetId === ROLL_PRINTING_SHEET.gid)
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
    if (plan.action === "delete") {
      const result = await this.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${ROLL_PRINTING_SHEET_ID}:batchUpdate`,
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
        requestId: result.spreadsheetId || ROLL_PRINTING_SHEET_ID,
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
      requests.push(clearCopiedData(sourceGrid, sheetId, plan.clearThrough));
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
      cellsForColumn(
        {
          sheetId,
          startRow: plan.startRow,
          columnIndex: 23,
          items: plan.lines.map((line) => ({ quantity: line.quantity })),
        },
        "quantity",
        "number",
      ),
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
    const result = await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${ROLL_PRINTING_SHEET_ID}:batchUpdate`,
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
    const grid = await this.grid(plan.name);
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
        expected.set(`X${row}`, line.quantity);
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
    const calculations = [];
    for (let index = 0; index < plan.lines.length; index++) {
      const row = plan.startRow + index;
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
      if (Number(entered(gridCell(grid, row, 24))) !== plan.lines[index].quantity)
        fail(
          "roll_supply_print_remainder_readback_failed",
          `План записан, но остаток печати X${row} не инициализирован количеством поставки. Повторная запись заблокирована.`,
          503,
        );
      if (
        FORMULA_COLUMNS.some(
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
      for (const column of FORMULA_COLUMNS) {
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
    { writer = null, now = () => Date.now(), refresh = null } = {},
  ) {
    this.store = store;
    this.writer = writer;
    this.now = now;
    this.refresh = refresh;
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

  writeConflict() {
    const tables = new Set(
      this.store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    if (
      tables.has("test_repair_proposals") &&
      this.store.db
        .prepare(
          "SELECT 1 FROM test_repair_proposals WHERE status IN ('queued','executing','checking','uncertain') LIMIT 1",
        )
        .get()
    )
      return "Выполняется или требует сверки другая операция исправления. Создание поставки временно остановлено.";
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM source_recovery_operations WHERE status IN ('repairing','checking','uncertain') LIMIT 1",
        )
        .get()
    )
      return "Выполняется или требует сверки восстановление исходных данных. Создание поставки временно остановлено.";
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
    const payload = validatePayload(input);
    const identity = {
      action: payload.action,
      name: payload.name,
      sheetId: payload.sheetId || null,
      ...(payload.action !== "delete" ? { lines: payload.lines } : {}),
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
      const plan =
        payload.action === "create"
          ? await this.writer.prepareCreate(payload)
          : payload.action === "append"
            ? await this.writer.prepareAppend({
                ...payload,
                registeredSheets,
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
        `${payload.action === "create" ? "Создание листа" : payload.action === "append" ? "Добавление товаров" : "Удаление листа"} «${payload.name}»: ${payload.lines.length} строк; точная операция подтверждена владельцем`,
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
      rows: operation.payload.lines?.length || 0,
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
