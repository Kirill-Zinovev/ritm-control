const PRODUCTION_LOG_SHEET = 'Журнал выпуска';
const PRODUCTION_SYSTEM_SHEET = '_SYSTEM_ROLLS';

function openProductionLog() {
  return r2OpenJournal();
  const html = HtmlService.createHtmlOutputFromFile('ProductionLogPanel')
    .setTitle('Журнал выпуска');
  SpreadsheetApp.getUi().showSidebar(html);
}

function getProductionLogContext() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const source = ss.getActiveSheet();
  if (!source || source.isSheetHidden()) {
    throw new Error('Откройте видимый лист с заказом и выберите строку заказа.');
  }

  const active = source.getActiveRange();
  const row = active ? active.getRow() : 0;
  if (row < 4) {
    throw new Error('Выберите любую ячейку строки заказа (начиная со строки 4), затем откройте журнал.');
  }

  const values = source.getRange(row, 1, 1, 32).getValues()[0];
  const article = String(values[4] || '').trim();
  const uid = String(values[31] || '').trim();
  const orderQty = Number(values[14]) || 0;
  const areaPerPiece = (Number(values[5]) || 0) * (Number(values[7]) || 0) * (Number(values[8]) || 0);
  if (!article || !uid || orderQty <= 0 || areaPerPiece <= 0) {
    throw new Error('В выбранной строке не хватает артикула, UID, количества или размеров для расчёта площади.');
  }

  const system = ss.getSheetByName(PRODUCTION_SYSTEM_SHEET);
  if (!system || system.getLastRow() < 2) {
    throw new Error('Не найдена база рулонов.');
  }
  const systemRows = system.getRange(2, 1, system.getLastRow() - 1, 10).getValues();
  const rolls = systemRows
    .filter(r => String(r[0] || '').trim() === uid && String(r[8] || '').trim())
    .map(r => ({
      id: String(r[8]),
      name: String(r[1] || ''),
      employee: employeeFromRollName_(String(r[1] || '')),
      number: String(r[2] || ''),
      quantity: Number(r[7]) || 0
    }))
    .filter(r => r.quantity > 0);
  if (!rolls.length) {
    throw new Error('Для этой строки ещё нет рулонов. Сначала добавьте их через приложение «Рулоны».');
  }

  const totals = getProductionLogTotals_(ss, uid);
  rolls.forEach(roll => {
    roll.printDone = totals[roll.id] ? totals[roll.id].print : 0;
    roll.cutDone = totals[roll.id] ? totals[roll.id].cut : 0;
  });

  return {
    sheetName: source.getName(),
    row: row,
    article: article,
    uid: uid,
    orderQty: orderQty,
    areaPerPiece: Math.round(areaPerPiece * 1000000) / 1000000,
    rolls: rolls
  };
}

function saveProductionLog(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Не получены данные выпуска.');
  const employee = String(payload.employee || '').trim();
  const operation = String(payload.operation || '').trim();
  const rollId = String(payload.rollId || '').trim();
  const quantity = Number(payload.quantity);
  const comment = String(payload.comment || '').trim();
  if (!employee) throw new Error('Укажите сотрудника.');
  if (operation !== 'Печать' && operation !== 'Резка') throw new Error('Выберите операцию: печать или резка.');
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Количество должно быть целым числом больше нуля.');
  if (!rollId) throw new Error('Выберите рулон.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const source = ss.getSheetByName(String(payload.sheetName || ''));
    const row = Number(payload.row);
    if (!source || source.isSheetHidden() || row < 4 || row > source.getLastRow()) {
      throw new Error('Строка заказа изменилась. Закройте и снова откройте журнал.');
    }
    const order = source.getRange(row, 1, 1, 32).getValues()[0];
    const uid = String(order[31] || '').trim();
    if (uid !== String(payload.uid || '').trim()) {
      throw new Error('Выбранная строка уже изменилась. Обновите журнал перед записью.');
    }
    const article = String(order[4] || '').trim();
    const areaPerPiece = (Number(order[5]) || 0) * (Number(order[7]) || 0) * (Number(order[8]) || 0);
    if (!article || areaPerPiece <= 0) throw new Error('Не удалось пересчитать площадь по строке заказа.');

    const system = ss.getSheetByName(PRODUCTION_SYSTEM_SHEET);
    const systemRows = system.getRange(2, 1, Math.max(system.getLastRow() - 1, 0), 10).getValues();
    const roll = systemRows.find(r => String(r[0] || '').trim() === uid && String(r[8] || '').trim() === rollId);
    if (!roll) throw new Error('Рулон не найден для выбранного заказа. Обновите журнал.');
    const rollQty = Number(roll[7]) || 0;
    if (rollQty <= 0) throw new Error('У выбранного рулона не задано плановое количество.');

    const totals = getProductionLogTotals_(ss, uid);
    const already = totals[rollId] ? totals[rollId][operation === 'Печать' ? 'print' : 'cut'] : 0;
    const remaining = Math.max(0, rollQty - already);
    if (quantity > remaining) {
      throw new Error('Нельзя записать больше остатка рулона. Осталось: ' + remaining + ' шт.');
    }

    const log = ss.getSheetByName(PRODUCTION_LOG_SHEET);
    if (!log) throw new Error('Не найден лист «Журнал выпуска».');
    const now = new Date();
    const tz = ss.getSpreadsheetTimeZone();
    const dateValue = Utilities.parseDate(Utilities.formatDate(now, tz, 'yyyy-MM-dd'), tz, 'yyyy-MM-dd');
    const area = Math.round(quantity * areaPerPiece * 1000) / 1000;
    log.appendRow([
      Utilities.getUuid(), dateValue, employee, operation, source.getName(), row,
      article, uid, String(roll[1] || ''), quantity,
      Math.round(areaPerPiece * 1000000) / 1000000, area, now, comment, rollId
    ]);
    SpreadsheetApp.flush();
    return {
      message: 'Записано: ' + quantity + ' шт. / ' + area.toLocaleString('ru-RU') + ' м².',
      remaining: rollQty - already - quantity
    };
  } finally {
    lock.releaseLock();
  }
}

function getProductionLogTotals_(ss, uid) {
  const log = ss.getSheetByName(PRODUCTION_LOG_SHEET);
  const totals = {};
  if (!log || log.getLastRow() < 2) return totals;
  const rows = log.getRange(2, 1, log.getLastRow() - 1, 15).getValues();
  rows.forEach(r => {
    if (String(r[7] || '').trim() !== uid) return;
    const id = String(r[14] || '').trim();
    if (!id) return;
    if (!totals[id]) totals[id] = {print: 0, cut: 0};
    const amount = Number(r[9]) || 0;
    if (String(r[3]) === 'Печать') totals[id].print += amount;
    if (String(r[3]) === 'Резка') totals[id].cut += amount;
  });
  return totals;
}


function syncCompletedPrintToJournal_(roll, order, employee, printDate, area) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(PRODUCTION_LOG_SHEET);
  if (!log || !roll) return;

  const rollId = String(roll.rollId || '').trim();
  const uid = String(roll.uid || '').trim();
  const rollQty = Math.max(0, Math.floor(Number(roll.quantity) || 0));
  if (!rollId || !uid || rollQty < 1) return;

  const recordId = 'AUTO_PRINT_' + rollId;
  const lastRow = log.getLastRow();
  const rows = lastRow > 1
    ? log.getRange(2, 1, lastRow - 1, 15).getValues()
    : [];

  let autoRow = 0;
  let alreadyLogged = 0;
  rows.forEach((row, index) => {
    const id = String(row[0] || '').trim();
    const sameRoll =
      String(row[7] || '').trim() === uid &&
      String(row[14] || '').trim() === rollId &&
      String(row[3] || '').trim() === 'Печать';
    if (id === recordId) autoRow = index + 2;
    if (sameRoll && id !== recordId) {
      alreadyLogged += Math.max(0, Number(row[9]) || 0);
    }
  });

  const quantity = Math.max(0, rollQty - alreadyLogged);
  if (quantity < 1) {
    if (autoRow) log.getRange(autoRow, 1, 1, 15).clearContent();
    return;
  }

  const totalArea = Math.max(0, Number(area) || 0);
  const areaPerPiece = totalArea / rollQty;
  let eventDate = printDate ? new Date(printDate) : new Date();
  if (isNaN(eventDate.getTime())) eventDate = new Date();
  const dateParts = Utilities.formatDate(eventDate, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd').split('-').map(Number);
  eventDate = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
  const sourceSheet = order && order.sheetName
    ? String(order.sheetName)
    : (typeof C !== 'undefined' ? C.SHEET : '');
  const sourceRow = order && Number(order.row) > 0 ? Number(order.row) : '';

  const values = [[
    recordId,
    eventDate,
    String(employee || ''),
    'Печать',
    sourceSheet,
    sourceRow,
    String(order && order.article || ''),
    uid,
    String(roll.name || ''),
    quantity,
    areaPerPiece,
    quantity * areaPerPiece,
    new Date(),
    'Автоматически: рулон отмечен как напечатанный',
    rollId
  ]];

  if (autoRow) {
    log.getRange(autoRow, 1, 1, 15).setValues(values);
  } else {
    log.appendRow(values[0]);
  }
}

function removeCompletedPrintFromJournal_(rollId) {
  const log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PRODUCTION_LOG_SHEET);
  if (!log || log.getLastRow() < 2) return;

  const recordId = 'AUTO_PRINT_' + String(rollId || '').trim();
  const rows = log.getRange(2, 1, log.getLastRow() - 1, 15).getValues();
  rows.forEach((row, index) => {
    if (String(row[0] || '').trim() === recordId) {
      log.getRange(index + 2, 1, 1, 15).clearContent();
    }
  });
}
