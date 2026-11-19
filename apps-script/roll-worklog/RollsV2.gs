/**
 * Target-table adapter for the roll manager.
 * Order columns are resolved from row 4 headers on every visible OZON/WB sheet.
 * Existing hidden storage is read-only; incompatible/new records use ROLLS_V2.
 */
const R2_CFG = {
  HEADER_ROW: 4,
  DATA_ROW: 5,
  STORE: 'ROLLS_V2',
  PROGRESS_STORE: 'ROLLS_V2_PROGRESS',
  SYSTEM_OLD: '_SYSTEM_ROLLS',
  JOURNAL: 'Журнал выпуска',
  DAILY: 'Выпуск по дням',
  CUTTER_DEFAULT: 'Лукман',
  MIGRATION_PROP: 'R2_LEGACY_MIGRATION_V1',
  TZ: 'Europe/Moscow',
  STORE_HEADERS: [
    'ROLL_ID', 'ORDER_UID', 'SHEET_SOURCE', 'ORDER_ROW', 'ARTICLE',
    'ROLL_NAME', 'ROLL_NUMBER', 'PRINT_READY', 'CUT_READY', 'CREATED_AT',
    'UPDATED_AT', 'ROLL_QUANTITY', 'PRINT_DONE_AT', 'PRINT_EMPLOYEE',
    'CUT_DONE_AT', 'CUT_EMPLOYEE', 'LEGACY_SOURCE'
  ],
  PROGRESS_HEADERS: [
    'EVENT_ID', 'ROLL_ID', 'ORDER_UID', 'SHEET_SOURCE', 'ORDER_ROW', 'ARTICLE',
    'OPERATION', 'EMPLOYEE', 'DATE', 'QUANTITY', 'AREA_PER_ITEM', 'AREA', 'ENTERED_AT', 'COMMENT'
  ],
  JOURNAL_HEADERS: [
    'ID записи', 'Дата', 'Сотрудник', 'Операция', 'Лист-источник',
    'Строка заказа', 'Артикул', 'UID заказа', 'Рулон', 'Сделано',
    'м² на 1 шт.', 'Выпуск м²', 'Время записи', 'Комментарий', 'ID рулона'
  ],
  DAILY_HEADERS: ['Дата', 'Сотрудник', 'Операция', 'Сделано, шт.', 'Выпуск, м²']
};

var R2_HEADER_CACHE_ = {};

function r2Normalize_(value) {
  return String(value == null ? '' : value)
    .trim().toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
}

function r2Number_(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null || value === '') return null;
  var text = String(value).replace(/\u00a0/g, '').replace(/\s/g, '').replace(',', '.');
  var match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  var n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function r2Employee_(value) {
  var text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return '';
  var first = text.charAt(0);
  if (first === 'д' || first === 'd' || text === 'дмитрий' || text === 'dmitry') return 'Дмитрий';
  if (first === 'а' || first === 'a' || text === 'андрей' || text === 'andrey' || text === 'andrew') return 'Андрей';
  if (first === 'п' || first === 'p' || text === 'паша' || text === 'pasha' || text === 'pavel') return 'Паша';
  return '';
}

function r2Bool_(value) {
  if (value === true || value === 1) return true;
  var text = String(value == null ? '' : value).trim().toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'да' || text === 'готов';
}

function r2EmployeeForRoll_(rollName, requested) {
  var fromRoll = r2Employee_(rollName);
  var explicit = r2Employee_(requested);
  if (fromRoll && explicit && fromRoll !== explicit) {
    throw new Error('Сотрудник не совпадает с первой буквой рулона: ' + fromRoll + '.');
  }
  return fromRoll || explicit;
}

function r2CutterNameFromCode_(value) {
  var text = String(value == null ? '' : value).trim();
  if (!text) return '';
  var normalized = r2Normalize_(text);
  if (normalized === 'luk' || normalized === 'lukman' || normalized === 'лукман') return 'Лукман';
  return '';
}

function r2CutterForOrder_(order) {
  var code = String(order && order.cutEmployeeCode || '').trim();
  if (!code) return R2_CFG.CUTTER_DEFAULT;
  var employee = r2CutterNameFromCode_(code);
  if (!employee) throw new Error('Резчик задан как Лукман. В колонке «Код сотрудника порезки» укажите LUK; сейчас указано: «' + code + '».');
  return employee;
}

function r2EmployeeForOperation_(roll, order, operation, requested) {
  if (operation === 'Резка') return r2CutterForOrder_(order);
  return r2EmployeeForRoll_(roll.name, requested || roll.printEmployee);
}

function r2PersistCutterCode_(order, employee) {
  if (!order || employee !== R2_CFG.CUTTER_DEFAULT || !order.columns || !order.columns.cutEmployee) return false;
  var sheet = r2SheetByName_(order.sheetName), cell = sheet.getRange(order.row, order.columns.cutEmployee);
  if (cell.getFormula()) return false;
  var current = String(cell.getValues()[0][0] || '').trim();
  if (current) return false;
  cell.setValue('LUK');
  order.cutEmployeeCode = 'LUK';
  order.cutter = R2_CFG.CUTTER_DEFAULT;
  return true;
}

function r2ToMeters_(value, header) {
  var n = r2Number_(value);
  if (n == null || n <= 0) return null;
  var label = String(header || '').toLowerCase();
  if (/мм|millimet/.test(label)) return n / 1000;
  if (/см|centimet/.test(label)) return n / 100;
  // Target values were checked directly: 0.21 and 0.30 are metres.
  // Dimension strings such as 21x30 are centimetres, inferred by scale.
  if (n > 1000) return n / 1000;
  if (n > 10) return n / 100;
  return n;
}

function r2HeaderMap_(sheet) {
  var cacheKey = String(sheet.getSheetId());
  if (R2_HEADER_CACHE_[cacheKey]) return R2_HEADER_CACHE_[cacheKey];
  var headers = sheet.getRange(R2_CFG.HEADER_ROW, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var normalized = headers.map(r2Normalize_);
  function find(aliases) {
    var wanted = aliases.map(r2Normalize_);
    for (var i = 0; i < normalized.length; i++) {
      if (wanted.indexOf(normalized[i]) >= 0) return i + 1;
    }
    return 0;
  }
  var map = {
    machine: find(['Станок']), article: find(['Артикул']), sheets: find(['Кол-во листов', 'Листов на изделие']),
    size: find(['Размер']), quantity: find(['Кол-во']), width: find(['Ширина']), height: find(['Высота']),
    print: find(['Печать']), cut: find(['Порезка', 'Резка']),
    cutEmployee: find(['Код сотрудника порезки', 'Сотрудник порезки', 'Резчик']),
    printProgress: find(['Прогресс печати']), cutProgress: find(['Прогресс порезки', 'Прогресс резки']),
    printDate: find(['Дата готовности печати']), cutDate: find(['Дата готовности порезки', 'Дата готовности резки']),
    printStatus: find(['Печать']), cutStatus: find(['Порезка', 'Резка']),
    remaining: find(['Кол-во осталось']), printRemaining: find(['Остаток по печати', 'Остаток по печати шт', 'Остаток печати']),
    comment: find(['Комментарий']), shop: find(['Магазин']),
    roll: find(['Рулоны']), uid: find(['UID', 'UID заказа', 'ID заказа'])
  };
  // RITM labels its stable row identity in AD1, not the table header row.
  // Trust the explicit marker only in this workbook and only when no other
  // conflicting UID header is present; never invent or change identities.
  if (sheet.getParent().getId() === '1hojhKS4Av_yy5sUMJcsoeJ_MQRU3V5g9P-fP61PO6Cs' &&
      r2IsMarketplaceSheetName_(sheet.getName()) && headers.length >= 30 &&
      r2Normalize_(sheet.getRange(1, 30).getDisplayValue()) === 'uid') {
    var adHeader = normalized[29];
    if (adHeader && ['uid','uidзаказа','idзаказа'].indexOf(adHeader) < 0) {
      throw new Error('На листе «' + sheet.getName() + '» служебная колонка UID имеет другой заголовок. Проверьте структуру листа.');
    }
    if (map.uid && map.uid !== 30) {
      throw new Error('На листе «' + sheet.getName() + '» найдены разные колонки UID. Проверьте структуру листа.');
    }
    map.uid = 30;
  }
  if (!map.uid) map.uid = r2DetectUidColumn_(sheet, headers);
  var required = ['article', 'sheets', 'size', 'quantity', 'print', 'cut', 'printProgress', 'cutProgress', 'printDate', 'cutDate', 'uid'];
  var missing = required.filter(function(k) { return !map[k]; });
  if (missing.length) throw new Error('На листе «' + sheet.getName() + '» не найдены заголовки: ' + missing.join(', '));
  if (!map.width || !map.height) throw new Error('На листе «' + sheet.getName() + '» не найдены заголовки ширины и высоты.');
  map.headerValues = headers;
  R2_HEADER_CACHE_[cacheKey] = map;
  return map;
}

function r2DetectUidColumn_(sheet, headers) {
  var last = sheet.getLastRow();
  if (last < R2_CFG.DATA_ROW) return 0;
  var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var ritmUid = /^ritm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$/i;
  var normalized = headers.map(r2Normalize_);
  var candidates = [];
  var values = sheet.getRange(R2_CFG.DATA_ROW, 1, last - R2_CFG.DATA_ROW + 1, headers.length).getDisplayValues();
  for (var col = 1; col <= headers.length; col++) {
    var label = normalized[col - 1];
    if (label && !/^(?:кодсотрудникапечати|idзаказа|идентификаторзаказа)$/.test(label)) continue;
    var found = 0, unique = {};
    values.forEach(function(row) {
      var value = String(row[col - 1] || '').trim();
      if (uuid.test(value) || ritmUid.test(value)) { found++; unique[value] = true; }
    });
    var uniqueCount = Object.keys(unique).length;
    if (found) candidates.push({column: col, found: found, unique: uniqueCount});
  }
  candidates.sort(function(a, b) { return b.found - a.found || b.unique - a.unique; });
  if (!candidates.length) return 0;
  if (candidates.length > 1 && candidates[0].found === candidates[1].found && candidates[0].unique === candidates[1].unique) {
    throw new Error('На листе «' + sheet.getName() + '» несколько равнозначных столбцов с UID; автоматическая привязка остановлена.');
  }
  return candidates[0].column;
}

function r2IsMarketplaceSheetName_(name) {
  return /^(?:OZON|WB)(?:$|[^A-ZА-ЯЁ0-9])/i.test(String(name || '').trim());
}

function r2IsTargetSheet_(sheet) {
  if (!sheet || sheet.isSheetHidden()) return false;
  return r2IsMarketplaceSheetName_(sheet.getName());
}

function r2TargetSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheets().filter(function(sheet) {
    if (!r2IsTargetSheet_(sheet)) return false;
    try { r2HeaderMap_(sheet); return true; } catch (e) { return false; }
  });
}

function r2SheetByName_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(String(name || ''));
  if (!r2IsTargetSheet_(sheet)) throw new Error('Лист заказа должен быть видимым и начинаться с OZON или WB.');
  r2HeaderMap_(sheet);
  return sheet;
}

function r2OrderFromValues_(sheet, row, map, values) {
  function cell(key) { return map[key] ? values[map[key] - 1] : ''; }
  var article = String(cell('article') || '').trim();
  var uid = String(cell('uid') || '').trim();
  if (!article || !uid) return null;
  var size = String(cell('size') || '').trim();
  var sheets = r2Number_(cell('sheets'));
  var width = r2ToMeters_(cell('width'), map.headerValues[map.width - 1]);
  var height = r2ToMeters_(cell('height'), map.headerValues[map.height - 1]);
  if (!width || !height) {
    var dims = size.match(/(\d+(?:[.,]\d+)?)\s*[xх×]\s*(\d+(?:[.,]\d+)?)/i);
    if (dims) {
      width = width || r2ToMeters_(dims[1], '');
      height = height || r2ToMeters_(dims[2], '');
    }
  }
  var orderQty = r2Number_(cell('quantity'));
  var cutEmployeeCode = String(cell('cutEmployee') || '').trim();
  var areaPerPiece = (sheets > 0 && width > 0 && height > 0) ? sheets * width * height : 0;
  return {
    uid: uid, sheetName: sheet.getName(), row: row, article: article,
    machine: map.machine ? String(cell('machine') || '') : '', size: size,
    sheetsPerPiece: sheets || 0, widthM: width || 0, heightM: height || 0,
    orderQty: orderQty || 0, areaPerPiece: areaPerPiece,
    areaValid: !!(orderQty > 0 && sheets > 0 && width > 0 && height > 0),
    rollText: String(cell('roll') || ''), printDate: r2Date_(cell('printDate')), cutDate: r2Date_(cell('cutDate')),
    printStatus: String(cell('printStatus') || ''), cutStatus: String(cell('cutStatus') || ''),
    cutEmployeeCode: cutEmployeeCode,
    cutter: r2CutterNameFromCode_(cutEmployeeCode) || (cutEmployeeCode ? 'Проверьте код ' + cutEmployeeCode : R2_CFG.CUTTER_DEFAULT),
    columns: map
  };
}

function r2OrderFromRow_(sheet, row) {
  if (row < R2_CFG.DATA_ROW || row > sheet.getLastRow()) return null;
  var map = r2HeaderMap_(sheet);
  var values = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  return r2OrderFromValues_(sheet, row, map, values);
}

function r2OrderIndex_() {
  var index = {};
  r2TargetSheets_().forEach(function(sheet) {
    var map;
    try { map = r2HeaderMap_(sheet); } catch (e) { return; }
    var last = sheet.getLastRow();
    if (last < R2_CFG.DATA_ROW) return;
    var values = sheet.getRange(R2_CFG.DATA_ROW, 1, last - R2_CFG.DATA_ROW + 1, sheet.getLastColumn()).getValues();
    values.forEach(function(rowValues, i) {
      var row = i + R2_CFG.DATA_ROW;
      var uid = String(rowValues[map.uid - 1] || '').trim();
      var article = String(rowValues[map.article - 1] || '').trim();
      if (!uid || !article) return;
      var order = r2OrderFromValues_(sheet, row, map, rowValues);
      if (!order) return;
      if (!index[uid]) index[uid] = [];
      index[uid].push(order);
    });
  });
  return index;
}

function r2GetOrder_(uid, sheetName, row) {
  uid = String(uid || '').trim();
  if (!uid) throw new Error('UID заказа не указан.');
  if (sheetName && Number(row) >= R2_CFG.DATA_ROW) {
    var sheet = r2SheetByName_(sheetName);
    var exact = r2OrderFromRow_(sheet, Number(row));
    if (!exact || exact.uid !== uid) throw new Error('Строка заказа изменилась. Обновите список.');
    return exact;
  }
  var candidates = (r2OrderIndex_()[uid] || []);
  if (!candidates.length) throw new Error('Заказ с UID «' + uid + '» не найден на видимых листах OZON или WB.');
  var active = SpreadsheetApp.getActiveRange();
  if (active && r2IsTargetSheet_(active.getSheet())) {
    var selected = candidates.filter(function(x) { return x.sheetName === active.getSheet().getName() && x.row === active.getRow(); });
    if (selected.length === 1) return selected[0];
  }
  if (candidates.length === 1) return candidates[0];
  throw new Error('UID встречается на нескольких листах OZON или WB. Выберите строку заказа и повторите действие.');
}

function r2ActiveSelection_() {
  var active = SpreadsheetApp.getActiveRange();
  if (active && r2IsTargetSheet_(active.getSheet())) {
    var sheet = active.getSheet();
    var start = Math.max(R2_CFG.DATA_ROW, active.getRow());
    var end = Math.min(sheet.getLastRow(), active.getLastRow());
    var rows = [];
    for (var row = start; row <= end; row++) {
      var order = r2OrderFromRow_(sheet, row);
      if (order && !sheet.isRowHiddenByFilter(row) && !sheet.isRowHiddenByUser(row)) rows.push({row: row, uid: order.uid});
    }
    if (rows.length) {
      var context = {sheetName: sheet.getName(), rows: rows};
      PropertiesService.getUserProperties().setProperty('R2_ACTIVE_SELECTION', JSON.stringify(context));
      return context;
    }
  }
  var raw = PropertiesService.getUserProperties().getProperty('R2_ACTIVE_SELECTION');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function r2RememberSelection_(range) {
  if (!range || !r2IsTargetSheet_(range.getSheet())) return;
  var sheet = range.getSheet();
  var start = Math.max(R2_CFG.DATA_ROW, range.getRow());
  var end = Math.min(sheet.getLastRow(), range.getLastRow());
  var rows = [];
  for (var row = start; row <= end; row++) {
    var order = r2OrderFromRow_(sheet, row);
    if (order && !sheet.isRowHiddenByFilter(row) && !sheet.isRowHiddenByUser(row)) rows.push({row: row, uid: order.uid});
  }
  if (rows.length) PropertiesService.getUserProperties().setProperty('R2_ACTIVE_SELECTION', JSON.stringify({sheetName: sheet.getName(), rows: rows}));
}

function r2OnSelectionChange(e) {
  try { if (e && e.range) r2RememberSelection_(e.range); } catch (err) {}
}

function r2EnsureHeaderSheet_(ss, name, headers, hide) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  var lastColumn = Math.max(sheet.getLastColumn(), headers.length);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    var current = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    var same = headers.every(function(h, i) { return String(current[i] || '').trim() === h; });
    if (!same) throw new Error('Заголовки листа «' + name + '» отличаются от ожидаемых. Данные не изменены.');
  }
  if (hide && !sheet.isSheetHidden()) sheet.hideSheet();
  return sheet;
}

function r2Store_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var store = r2EnsureHeaderSheet_(ss, R2_CFG.STORE, R2_CFG.STORE_HEADERS, true);
  return {sheet: store, columns: R2_CFG.STORE_HEADERS};
}

function r2ProgressStore_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return r2EnsureHeaderSheet_(ss, R2_CFG.PROGRESS_STORE, R2_CFG.PROGRESS_HEADERS, true);
}

/** Read only rows for one order by its UID, then retain the full order identity as a second check. */
function r2RowsByUid_(sheet, uidColumn, headers, uid, missingMessage, changedMessage) {
  var last = sheet.getLastRow();
  if (last < 1) throw new Error(missingMessage);
  var actualHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (!headers.every(function(header, i) { return String(actualHeaders[i] || '').trim() === header; })) {
    throw new Error(changedMessage);
  }
  uid = String(uid || '').trim();
  if (!uid || last < 2) return [];
  var matches = sheet.getRange(2, uidColumn, last - 1, 1).createTextFinder(uid)
    .matchCase(true).matchEntireCell(true).findAll();
  var rowNumbers = matches.map(function(range) { return range.getRow(); }).sort(function(a, b) { return a - b; });
  var result = [];
  for (var i = 0; i < rowNumbers.length;) {
    var start = rowNumbers[i], end = start, next = i + 1;
    while (next < rowNumbers.length && rowNumbers[next] === end + 1) { end = rowNumbers[next]; next++; }
    var values = sheet.getRange(start, 1, end - start + 1, headers.length).getValues();
    values.forEach(function(row, offset) { result.push({row: start + offset, values: row}); });
    i = next;
  }
  return result;
}

function r2EnsureVisibleSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var journal = r2EnsureHeaderSheet_(ss, R2_CFG.JOURNAL, R2_CFG.JOURNAL_HEADERS, false);
  var daily = r2EnsureHeaderSheet_(ss, R2_CFG.DAILY, R2_CFG.DAILY_HEADERS, false);
  journal.setFrozenRows(1);
  daily.setFrozenRows(1);
  if (journal.getLastRow() === 1) {
    journal.getRange(1, 1, 1, R2_CFG.JOURNAL_HEADERS.length).setFontWeight('bold');
    journal.getRange(2, 2, Math.max(journal.getMaxRows() - 1, 1), 1).setNumberFormat('dd.MM.yyyy');
    journal.getRange(2, 11, Math.max(journal.getMaxRows() - 1, 1), 2).setNumberFormat('0.000000');
    journal.getRange(2, 13, Math.max(journal.getMaxRows() - 1, 1), 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
  }
  daily.getRange(1, 1, 1, R2_CFG.DAILY_HEADERS.length).setFontWeight('bold');
  daily.getRange(2, 1, Math.max(daily.getMaxRows() - 1, 1), 1).setNumberFormat('dd.MM.yyyy');
  daily.getRange(2, 5, Math.max(daily.getMaxRows() - 1, 1), 1).setNumberFormat('0.00');
  return {journal: journal, daily: daily};
}

function r2HeaderColumns_(sheet, headers) {
  var actual = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getDisplayValues()[0];
  var map = {};
  headers.forEach(function(header) {
    var i = actual.findIndex(function(v) { return String(v || '').trim() === header; });
    if (i < 0) throw new Error('В листе «' + sheet.getName() + '» не найден столбец «' + header + '».');
    map[header] = i + 1;
  });
  return map;
}

function r2Date_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (value == null || value === '' || value === false) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    var serialDate = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000));
    return isNaN(serialDate.getTime()) ? null : serialDate;
  }
  var text = String(value).trim();
  var match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0));
  }
  var parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function r2MoscowDay_(date) {
  var key = Utilities.formatDate(date, R2_CFG.TZ, 'yyyy-MM-dd');
  return Utilities.parseDate(key, R2_CFG.TZ, 'yyyy-MM-dd');
}

function r2OrderArea_(order) {
  if (!order || !order.areaValid) throw new Error('Не удалось рассчитать площадь: проверьте листы на изделие, ширину и высоту.');
  return order.areaPerPiece;
}

function r2ReadStore_(readOnly) {
  var store = readOnly
    ? SpreadsheetApp.getActiveSpreadsheet().getSheetByName(R2_CFG.STORE)
    : r2Store_().sheet;
  if (!store) throw new Error('Хранилище рулонов не найдено. Откройте управление рулонами заново.');
  var last = store.getLastRow();
  var rows;
  if (readOnly) {
    if (last < 1) throw new Error('Заголовки хранилища рулонов не найдены. Данные не изменены.');
    rows = store.getRange(1, 1, last, R2_CFG.STORE_HEADERS.length).getValues();
    var headers = rows.shift();
    if (!R2_CFG.STORE_HEADERS.every(function(header, i) { return String(headers[i] || '').trim() === header; })) {
      throw new Error('Заголовки хранилища рулонов изменились. Данные не изменены.');
    }
  } else {
    if (last < 2) return [];
    rows = store.getRange(2, 1, last - 1, R2_CFG.STORE_HEADERS.length).getValues();
  }
  return rows.map(function(r, i) {
    return {
      row: i + 2, rollId: String(r[0] || '').trim(), uid: String(r[1] || '').trim(),
      sheetName: String(r[2] || ''), orderRow: Number(r[3]) || 0, article: String(r[4] || ''),
      name: String(r[5] || ''), number: Number(r[6]) || 0, print: r2Bool_(r[7]), cut: r2Bool_(r[8]),
      created: r[9] || '', updated: r[10] || '', quantity: Number(r[11]) || 0,
      printDoneAt: r2Date_(r[12]), printEmployee: String(r[13] || ''),
      cutDoneAt: r2Date_(r[14]), cutEmployee: String(r[15] || ''), legacy: r2Bool_(r[16])
    };
  }).filter(function(x) { return !!x.rollId; });
}


function r2WriteRoll_(roll) {
  var store = r2Store_().sheet;
  var values = [[
    roll.rollId, roll.uid, roll.sheetName || '', Number(roll.orderRow) || '', roll.article || '',
    roll.name || '', Number(roll.number) || 0, !!roll.print, !!roll.cut, roll.created || new Date(),
    roll.updated || new Date(), Number(roll.quantity) || 0, roll.printDoneAt || '', roll.printEmployee || '',
    roll.cutDoneAt || '', roll.cutEmployee || '', !!roll.legacy
  ]];
  var list = r2ReadStore_();
  var existing = list.find(function(x) { return x.rollId === roll.rollId; });
  if (existing) store.getRange(existing.row, 1, 1, R2_CFG.STORE_HEADERS.length).setValues(values);
  else store.getRange(store.getLastRow() + 1, 1, 1, R2_CFG.STORE_HEADERS.length).setValues(values);
}

function r2JournalRows_(readOnly) {
  var journal = readOnly
    ? SpreadsheetApp.getActiveSpreadsheet().getSheetByName(R2_CFG.JOURNAL)
    : r2EnsureVisibleSheets_().journal;
  if (!journal) throw new Error('Лист журнала выпуска не найден. Откройте управление рулонами заново.');
  var last = journal.getLastRow();
  var values;
  if (readOnly) {
    values = journal.getRange(1, 1, Math.max(last, 1), R2_CFG.JOURNAL_HEADERS.length).getValues();
    var headers = values.shift();
    if (!R2_CFG.JOURNAL_HEADERS.every(function(header, i) { return String(headers[i] || '').trim() === header; })) {
      throw new Error('Заголовки журнала выпуска изменились. Данные не изменены.');
    }
  } else {
    if (last < 2) return [];
    values = journal.getRange(2, 1, last - 1, R2_CFG.JOURNAL_HEADERS.length).getValues();
  }
  return values.map(function(r, i) {
    return {
      row: i + 2, id: String(r[0] || '').trim(), date: r2Date_(r[1]), employee: String(r[2] || '').trim(),
      operation: String(r[3] || '').trim(), sheetName: String(r[4] || '').trim(), sourceRow: Number(r[5]) || 0,
      article: String(r[6] || '').trim(), uid: String(r[7] || '').trim(), rollName: String(r[8] || '').trim(),
      quantity: Number(r[9]) || 0, areaPerPiece: Number(r[10]) || 0, area: Number(r[11]) || 0,
      enteredAt: r2Date_(r[12]), comment: String(r[13] || ''), rollId: String(r[14] || '').trim()
    };
  }).filter(function(x) { return !!x.id; });
}

function r2JournalMap_() {
  return r2HeaderColumns_(r2EnsureVisibleSheets_().journal, R2_CFG.JOURNAL_HEADERS);
}

function r2WriteJournal_(event) {
  var journal = r2EnsureVisibleSheets_().journal;
  var cols = r2JournalMap_();
  var row = R2_CFG.JOURNAL_HEADERS.map(function(h) {
    switch (h) {
      case 'ID записи': return event.id;
      case 'Дата': return event.date;
      case 'Сотрудник': return event.employee;
      case 'Операция': return event.operation;
      case 'Лист-источник': return event.sheetName;
      case 'Строка заказа': return event.sourceRow || '';
      case 'Артикул': return event.article;
      case 'UID заказа': return event.uid;
      case 'Рулон': return event.rollName;
      case 'Сделано': return Number(event.quantity) || 0;
      case 'м² на 1 шт.': return Number(event.areaPerPiece) || 0;
      case 'Выпуск м²': return Number(event.area) || 0;
      case 'Время записи': return event.enteredAt || new Date();
      case 'Комментарий': return event.comment || '';
      case 'ID рулона': return event.rollId;
      default: return '';
    }
  });
  var existing = r2JournalRows_().find(function(x) { return x.id === String(event.id); });
  var targetRow = existing ? existing.row : journal.getLastRow() + 1;
  journal.getRange(targetRow, 1, 1, row.length).setValues([row]);
  journal.getRange(targetRow, cols['Дата']).setNumberFormat('dd.MM.yyyy');
  journal.getRange(targetRow, cols['м² на 1 шт.'], 1, 2).setNumberFormat('0.000000');
  journal.getRange(targetRow, cols['Время записи']).setNumberFormat('dd.MM.yyyy HH:mm:ss');
  return targetRow;
}

function r2ProgressRows_(readOnly) {
  var sheet = readOnly
    ? SpreadsheetApp.getActiveSpreadsheet().getSheetByName(R2_CFG.PROGRESS_STORE)
    : r2ProgressStore_();
  if (!sheet) throw new Error('Хранилище фактического выпуска не найдено. Откройте управление рулонами заново.');
  var last = sheet.getLastRow();
  var rows;
  if (readOnly) {
    if (last < 1) throw new Error('Заголовки хранилища фактического выпуска не найдены. Данные не изменены.');
    rows = sheet.getRange(1, 1, last, R2_CFG.PROGRESS_HEADERS.length).getValues();
    var headers = rows.shift();
    if (!R2_CFG.PROGRESS_HEADERS.every(function(header, i) { return String(headers[i] || '').trim() === header; })) {
      throw new Error('Заголовки хранилища фактического выпуска изменились. Данные не изменены.');
    }
  } else {
    if (last < 2) return [];
    rows = sheet.getRange(2, 1, last - 1, R2_CFG.PROGRESS_HEADERS.length).getValues();
  }
  return rows.map(function(r, i) {
    return {
      row: i + 2, id: String(r[0] || '').trim(), rollId: String(r[1] || '').trim(),
      uid: String(r[2] || '').trim(), sheetName: String(r[3] || '').trim(), sourceRow: Number(r[4]) || 0,
      article: String(r[5] || '').trim(), operation: String(r[6] || '').trim(), employee: String(r[7] || '').trim(),
      date: r2Date_(r[8]), quantity: Number(r[9]) || 0, areaPerPiece: Number(r[10]) || 0,
      area: Number(r[11]) || 0, enteredAt: r2Date_(r[12]), comment: String(r[13] || '')
    };
  }).filter(function(x) { return !!x.id; });
}


function r2WriteProgress_(event) {
  var sheet = r2ProgressStore_();
  var existing = r2ProgressRows_().find(function(x) { return x.id === String(event.id); });
  var values = [[event.id, event.rollId, event.uid, event.sheetName, event.sourceRow || '', event.article,
    event.operation, event.employee, event.date, Number(event.quantity) || 0, Number(event.areaPerPiece) || 0,
    Number(event.area) || 0, event.enteredAt || new Date(), event.comment || '']];
  var row = existing ? existing.row : sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, R2_CFG.PROGRESS_HEADERS.length).setValues(values);
  return row;
}

function r2PartialActual_(rollId, operation) {
  return r2ProgressRows_().filter(function(x) { return x.rollId === String(rollId) && x.operation === operation; })
    .reduce(function(total, x) { return total + x.quantity; }, 0);
}

function r2ReadyActualQuantity_(roll, operation) {
  var entries = r2ProgressRows_().filter(function(x) {
    return x.rollId === roll.rollId && x.operation === operation;
  });
  if (entries.length) {
    return Math.max(0, entries.reduce(function(total, x) { return total + x.quantity; }, 0));
  }
  return Math.max(0, Number(roll.quantity) || 0);
}

function r2RollsForOrder_(order, rows) {
  return (rows || r2ReadStore_()).filter(function(x) {
    return x.uid === order.uid && x.sheetName === order.sheetName && x.article === order.article;
  });
}

function r2JournalForOrder_(order, operation, rows) {
  return (rows || r2JournalRows_()).filter(function(x) {
    return x.uid === order.uid && x.sheetName === order.sheetName && x.article === order.article &&
      (!operation || x.operation === operation);
  });
}

function r2IndexLegacyColumns_(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 9) return null;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(r2Normalize_);
  function find(name) { return headers.indexOf(r2Normalize_(name)) + 1; }
  var map = {
    uid: find('UID'), name: find('ROLL_NAME'), number: find('ROLL_NUMBER'), print: find('PRINT'), cut: find('CUT'),
    created: find('CREATED'), updated: find('UPDATED'), quantity: find('ROLL_QUANTITY'), rollId: find('ROLL_ID'),
    printDoneAt: find('PRINT_DONE_AT'), employee: find('PRINT_EMPLOYEE')
  };
  return Object.keys(map).every(function(k) { return map[k] > 0; }) ? map : null;
}

function r2VisibleRollQuantity_(order, rollName) {
  var wanted = r2Normalize_(rollName);
  if (!wanted) return null;
  var lines = String(order.rollText || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    var sep = line.search(/[—–-]/);
    if (sep < 0 || r2Normalize_(line.slice(0, sep)) !== wanted) continue;
    var match = line.slice(sep + 1).match(/(-?\d+(?:[.,]\d+)?)/);
    var quantity = match ? r2Number_(match[1]) : null;
    return quantity != null && quantity > 0 ? quantity : null;
  }
  return null;
}

function r2ResolveLegacyOrder_(candidates, rollName, storedQuantity) {
  if (!candidates || !candidates.length) return {order: null, quantity: storedQuantity || 0};
  if (candidates.length === 1) {
    return {order: candidates[0], quantity: storedQuantity || r2VisibleRollQuantity_(candidates[0], rollName) || 0};
  }
  var matches = candidates.map(function(order) {
    var shownQuantity = r2VisibleRollQuantity_(order, rollName);
    if (!shownQuantity) return null;
    if (storedQuantity > 0 && Math.abs(storedQuantity - shownQuantity) > 1e-9) return null;
    return {order: order, quantity: storedQuantity || shownQuantity};
  }).filter(function(x) { return !!x; });
  return matches.length === 1 ? matches[0] : {order: null, quantity: storedQuantity || 0};
}

function r2StatusComplete_(value) {
  var text = String(value == null ? '' : value).trim().toLowerCase();
  if (/готов|заверш/.test(text)) return true;
  var match = text.match(/(\d+)\s*из\s*(\d+)/);
  return !!(match && Number(match[1]) > 0 && Number(match[1]) >= Number(match[2]));
}

function r2RestoreLegacyHistory_(roll, order, operation, doneAt, employee, existingIds, pendingEvents) {
  if (!doneAt || !order.areaValid || roll.quantity <= 0 || !employee) return false;
  var id = 'R2_LEGACY_' + (operation === 'Печать' ? 'PRINT_' : 'CUT_') + roll.rollId;
  if (existingIds[id]) return false;
  var event = {
    id: id, date: r2MoscowDay_(doneAt), employee: employee, operation: operation,
    sheetName: order.sheetName, sourceRow: order.row, article: order.article, uid: order.uid,
    rollName: roll.name, quantity: roll.quantity, areaPerPiece: order.areaPerPiece,
    area: roll.quantity * order.areaPerPiece, enteredAt: doneAt,
    comment: 'История восстановлена по сохранённой дате завершения целевого заказа.', rollId: roll.rollId
  };
  if (pendingEvents) pendingEvents.push(event);
  else r2WriteJournal_(event);
  existingIds[id] = true;
  return true;
}

function r2MigrateLegacy_() {
  var props = PropertiesService.getDocumentProperties();
  if (props.getProperty(R2_CFG.MIGRATION_PROP)) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var source = ss.getSheetByName(R2_CFG.SYSTEM_OLD);
  var store = r2Store_().sheet;
  var existingIds = {};
  r2ReadStore_().forEach(function(x) { existingIds[x.rollId] = true; });
  var index = r2OrderIndex_();
  var migrated = 0, skipped = 0, restored = 0, unresolved = 0;
  var journalIds = {}, journalEvents = [];
  r2JournalRows_().forEach(function(j) { journalIds[j.id] = true; });
  if (source && source.getLastRow() > 1) {
    var map = r2IndexLegacyColumns_(source);
    if (!map) throw new Error('Схема _SYSTEM_ROLLS отличается от ожидаемой; перенос остановлен без изменений исходных данных.');
    var values = source.getRange(2, 1, source.getLastRow() - 1, source.getLastColumn()).getValues();
    var newRows = [];
    values.forEach(function(r) {
      var uid = String(r[map.uid - 1] || '').trim();
      var rollId = String(r[map.rollId - 1] || '').trim();
      var quantity = Number(r[map.quantity - 1]) || 0;
      if (!rollId || existingIds[rollId]) { if (uid && !rollId) skipped++; return; }
      var candidates = index[uid] || [];
      var selected = null;
      if (candidates.length) {
        var resolved = r2ResolveLegacyOrder_(candidates, String(r[map.name - 1] || ''), quantity);
        selected = resolved.order;
        quantity = resolved.quantity;
      }
      if (!selected) unresolved++;
      var printDoneAt = r2Date_(r[map.printDoneAt - 1]);
      var obj = {
        rollId: rollId, uid: uid, sheetName: selected ? selected.sheetName : '', orderRow: selected ? selected.row : 0,
        article: selected ? selected.article : '', name: String(r[map.name - 1] || ''), number: Number(r[map.number - 1]) || 0,
        print: r2Bool_(r[map.print - 1]), cut: r2Bool_(r[map.cut - 1]),
        created: r[map.created - 1] || '', updated: r[map.updated - 1] || '', quantity: quantity,
        printDoneAt: printDoneAt || (selected && r2StatusComplete_(selected.printStatus) ? selected.printDate : null),
        printEmployee: r2Employee_(r[map.employee - 1]) || '',
        cutDoneAt: selected && r2StatusComplete_(selected.cutStatus) ? selected.cutDate : null,
        cutEmployee: '', legacy: true
      };
      newRows.push([
        obj.rollId, obj.uid, obj.sheetName, obj.orderRow || '', obj.article, obj.name, obj.number,
        obj.print, obj.cut, obj.created, obj.updated, obj.quantity, obj.printDoneAt || '', obj.printEmployee,
        '', '', true
      ]);
      existingIds[rollId] = true;
      migrated++;
      if (selected) {
        var employee = r2Employee_(obj.name) || obj.printEmployee;
        if (obj.print && r2RestoreLegacyHistory_(obj, selected, 'Печать', obj.printDoneAt, employee, journalIds, journalEvents)) restored++;
        if (obj.cut && r2RestoreLegacyHistory_(obj, selected, 'Резка', obj.cutDoneAt, employee, journalIds, journalEvents)) restored++;
      }
    });
    if (journalEvents.length) {
      var journal = r2EnsureVisibleSheets_().journal;
      var journalRows = journalEvents.map(function(event) {
        return R2_CFG.JOURNAL_HEADERS.map(function(header) {
          switch (header) {
            case 'ID записи': return event.id;
            case 'Дата': return event.date;
            case 'Сотрудник': return event.employee;
            case 'Операция': return event.operation;
            case 'Лист-источник': return event.sheetName;
            case 'Строка заказа': return event.sourceRow || '';
            case 'Артикул': return event.article;
            case 'UID заказа': return event.uid;
            case 'Рулон': return event.rollName;
            case 'Сделано': return Number(event.quantity) || 0;
            case 'м² на 1 шт.': return Number(event.areaPerPiece) || 0;
            case 'Выпуск м²': return Number(event.area) || 0;
            case 'Время записи': return event.enteredAt || new Date();
            case 'Комментарий': return event.comment || '';
            case 'ID рулона': return event.rollId;
            default: return '';
          }
        });
      });
      var journalStartRow = journal.getLastRow() + 1;
      journal.getRange(journalStartRow, 1, journalRows.length, R2_CFG.JOURNAL_HEADERS.length).setValues(journalRows);
      journal.getRange(journalStartRow, 2, journalRows.length, 1).setNumberFormat('dd.MM.yyyy');
      journal.getRange(journalStartRow, 11, journalRows.length, 2).setNumberFormat('0.000000');
      journal.getRange(journalStartRow, 13, journalRows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
    }
    if (newRows.length) {
      store.getRange(store.getLastRow() + 1, 1, newRows.length, R2_CFG.STORE_HEADERS.length).setValues(newRows);
    }
  }
  SpreadsheetApp.flush();
  props.setProperty(R2_CFG.MIGRATION_PROP, JSON.stringify({date: new Date().toISOString(), migrated: migrated, skipped: skipped, unresolved: unresolved, journalRestored: restored}));
}

function r2EnsureInitialized_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getDocumentProperties();
  if (props.getProperty(R2_CFG.MIGRATION_PROP) && ss.getSheetByName(R2_CFG.STORE) &&
      ss.getSheetByName(R2_CFG.PROGRESS_STORE) && ss.getSheetByName(R2_CFG.JOURNAL) && ss.getSheetByName(R2_CFG.DAILY)) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    r2Store_();
    r2ProgressStore_();
    r2EnsureVisibleSheets_();
    r2MigrateLegacy_();
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
}

function r2Install() {
  r2EnsureInitialized_();
  var migration = PropertiesService.getDocumentProperties().getProperty(R2_CFG.MIGRATION_PROP) || '{}';
  return {message: 'Хранилище рулонов V2 и видимые листы журнала готовы.', migration: JSON.parse(migration)};
}

function r2OpenManager() {
  r2RememberSelection_(SpreadsheetApp.getActiveRange());
  r2EnsureInitialized_();
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('RollsV2Panel').setTitle('Управление рулонами'));
}

function r2OpenJournal() {
  r2EnsureInitialized_();
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(R2_CFG.JOURNAL));
}

function r2OpenDailyReport() {
  r2EnsureInitialized_();
  r2RefreshDaily_();
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(R2_CFG.DAILY));
}

function r2SelectedOrders_(readOnly) {
  if (!readOnly) r2EnsureInitialized_();
  var context = r2ActiveSelection_();
  if (!context || !context.rows || !context.rows.length) return {error: 'Выберите одну или несколько строк заказа на любом видимом листе OZON или WB.'};
  var sheet = r2SheetByName_(context.sheetName);
  var orders = [];
  context.rows.forEach(function(item) {
    var order = r2OrderFromRow_(sheet, Number(item.row));
    if (order && order.uid === String(item.uid || order.uid)) orders.push(order);
  });
  if (!orders.length) return {error: 'В выбранных строках не найдены заказы. Обновите выделение.'};
  return {orders: orders};
}

function r2ProgressActualForRoll_(roll, stats, ready) {
  if (!ready) return Math.max(0, Number(stats.partialByRoll[roll.rollId]) || 0);
  if (Object.prototype.hasOwnProperty.call(stats.releaseByRoll, roll.rollId)) {
    return Math.max(0, Number(stats.releaseByRoll[roll.rollId]) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(stats.partialByRoll, roll.rollId)) {
    return Math.max(0, Number(stats.partialByRoll[roll.rollId]) || 0);
  }
  return Math.max(0, Number(roll.quantity) || 0);
}

function r2OperationTotals_(order, operation, rolls, snapshot) {
  var releases = r2JournalForOrder_(order, operation, snapshot && snapshot.journal);
  var partial = (snapshot ? snapshot.progress : r2ProgressRows_()).filter(function(x) {
    return x.uid === order.uid && x.sheetName === order.sheetName && x.article === order.article && x.operation === operation;
  });
  var releaseByRoll = {}, partialByRoll = {};
  releases.forEach(function(x) { if (x.rollId) releaseByRoll[x.rollId] = (releaseByRoll[x.rollId] || 0) + x.quantity; });
  partial.forEach(function(x) { if (x.rollId) partialByRoll[x.rollId] = (partialByRoll[x.rollId] || 0) + x.quantity; });
  var isPrint = operation === 'Печать';
  var readyCount = 0, actual = 0, orderDate = null;
  rolls.forEach(function(roll) {
    var ready = isPrint ? roll.print : roll.cut;
    if (ready) {
      readyCount++;
      // A legacy ready mark with no completion date may inform quantity progress,
      // but it is never assigned a guessed date or restored to the release journal.
      actual += r2ProgressActualForRoll_(roll, {releaseByRoll: releaseByRoll, partialByRoll: partialByRoll}, true);
      var doneAt = isPrint ? roll.printDoneAt : roll.cutDoneAt;
      var releaseDate = releases.filter(function(x) { return x.rollId === roll.rollId && x.quantity > 0; })
        .reduce(function(latest, x) {
          var d = x.enteredAt || x.date;
          return d && (!latest || d.getTime() > latest.getTime()) ? d : latest;
        }, doneAt || null);
      if (releaseDate && (!orderDate || releaseDate.getTime() > orderDate.getTime())) orderDate = releaseDate;
    } else {
      actual += r2ProgressActualForRoll_(roll, {releaseByRoll: releaseByRoll, partialByRoll: partialByRoll}, false);
    }
  });
  return {actual: actual, readyCount: readyCount, rollCount: rolls.length, date: orderDate,
    partialByRoll: partialByRoll, releaseByRoll: releaseByRoll};
}

function r2Progress_(order, rolls, operation, snapshot) {
  var stats = r2OperationTotals_(order, operation, rolls, snapshot);
  var quantityFraction = order.orderQty > 0 ? Math.min(1, stats.actual / order.orderQty) : 0;
  var readyFraction = stats.rollCount > 0 ? stats.readyCount / stats.rollCount : 0;
  var complete = stats.rollCount > 0 && stats.readyCount === stats.rollCount && order.orderQty > 0 && stats.actual >= order.orderQty && !!stats.date;
  var percent = complete ? 100 : Math.min(99, Math.floor(Math.min(quantityFraction, readyFraction) * 100));
  return {actual: stats.actual, percent: percent, complete: complete, date: complete ? stats.date : null,
    readyCount: stats.readyCount, rollCount: stats.rollCount, partialByRoll: stats.partialByRoll, releaseByRoll: stats.releaseByRoll};
}

function r2FormatProgress_(percent) {
  var full = Math.floor(percent / 10);
  return '█'.repeat(full) + '░'.repeat(10 - full) + ' ' + percent + '%';
}

function r2WriteIfNoFormula_(sheet, row, col, value) {
  if (!col) return;
  var cell = sheet.getRange(row, col);
  if (cell.getFormula()) return;
  if (value === null) cell.clearContent();
  else cell.setValue(value);
}

/** Mirror known roll quantities in the visible "Рулоны" column without changing roll or release records. */
function r2RefreshRollCell_(order, rolls, clearWhenEmpty) {
  if ((!rolls.length && !clearWhenEmpty) || rolls.some(function(roll) {
    return !String(roll.name || '').trim() || !Number.isFinite(Number(roll.quantity)) || Number(roll.quantity) <= 0;
  })) return false;
  var sheet = r2SheetByName_(order.sheetName), map = r2HeaderMap_(sheet);
  if (!map.roll) return false;
  var cell = sheet.getRange(order.row, map.roll);
  if (cell.getFormula()) return false;
  var quantities = Object.create(null), names = [];
  rolls.forEach(function(roll) {
    var name = String(roll.name).trim();
    if (!Object.prototype.hasOwnProperty.call(quantities, name)) { quantities[name] = 0; names.push(name); }
    quantities[name] += Number(roll.quantity);
  });
  var text = names.map(function(name) { return name + ' - ' + formatQty_(quantities[name]); }).join('\n');
  if (String(cell.getValue() || '') === text) return false;
  if (text) cell.setValue(text).setWrap(true).setVerticalAlignment('middle');
  else cell.clearContent();
  return true;
}

function r2UpdateOrderProgress_(order, afterDelete, snapshot) {
  var rolls = r2RollsForOrder_(order, snapshot && snapshot.rolls);
  r2RefreshRollCell_(order, rolls, !!afterDelete);
  var progressRows = snapshot ? snapshot.progress : r2ProgressRows_();
  var partialRows = progressRows.filter(function(x) { return x.uid === order.uid && x.sheetName === order.sheetName && x.article === order.article; });
  var releaseRows = r2JournalForOrder_(order, null, snapshot && snapshot.journal);
  if (!afterDelete && !rolls.some(function(x) { return !x.legacy; }) && !partialRows.length && !releaseRows.length) return null;
  if (rolls.some(function(x) { return x.legacy && x.quantity <= 0; })) return null;
  if (afterDelete && !rolls.length && !partialRows.length && !releaseRows.length) {
    var emptySheet = r2SheetByName_(order.sheetName), emptyMap = r2HeaderMap_(emptySheet);
    r2WriteIfNoFormula_(emptySheet, order.row, emptyMap.printRemaining, order.orderQty);
    ['print', 'cut', 'printProgress', 'cutProgress', 'printDate', 'cutDate'].forEach(function(key) {
      r2WriteIfNoFormula_(emptySheet, order.row, emptyMap[key], null);
    });
    return {print: {actual: 0, percent: 0, complete: false}, cut: {actual: 0, percent: 0, complete: false}};
  }
  var print = r2Progress_(order, rolls, 'Печать', snapshot);
  var cut = r2Progress_(order, rolls, 'Резка', snapshot);
  var sheet = r2SheetByName_(order.sheetName);
  var map = r2HeaderMap_(sheet);
  r2WriteIfNoFormula_(sheet, order.row, map.printRemaining, order.orderQty - print.actual);
  r2WriteIfNoFormula_(sheet, order.row, map.print, print.complete ? 'Готов' : 'В работе');
  r2WriteIfNoFormula_(sheet, order.row, map.cut, cut.complete ? 'Готов' : 'В работе');
  r2WriteIfNoFormula_(sheet, order.row, map.printProgress, r2FormatProgress_(print.percent));
  r2WriteIfNoFormula_(sheet, order.row, map.cutProgress, r2FormatProgress_(cut.percent));
  if (print.complete && print.date) r2WriteIfNoFormula_(sheet, order.row, map.printDate, r2MoscowDay_(print.date));
  else if (!print.complete) r2WriteIfNoFormula_(sheet, order.row, map.printDate, null);
  if (cut.complete && cut.date) r2WriteIfNoFormula_(sheet, order.row, map.cutDate, r2MoscowDay_(cut.date));
  else if (!cut.complete) r2WriteIfNoFormula_(sheet, order.row, map.cutDate, null);
  return {print: print, cut: cut};
}

function r2DecorateOrder_(order, snapshot) {
  var rolls = r2RollsForOrder_(order, snapshot && snapshot.rolls).sort(function(a, b) { return a.number - b.number || a.name.localeCompare(b.name); });
  var print = r2Progress_(order, rolls, 'Печать', snapshot);
  var cut = r2Progress_(order, rolls, 'Резка', snapshot);
  var allocated = rolls.reduce(function(s, x) { return s + x.quantity; }, 0);
  order.rolls = rolls.map(function(x) {
    return {
      rollId: x.rollId, uid: x.uid, name: x.name, number: x.number, quantity: x.quantity,
      print: x.print, cut: x.cut, printDoneAt: x.printDoneAt ? Utilities.formatDate(x.printDoneAt, R2_CFG.TZ, 'dd.MM.yyyy HH:mm') : '',
      cutDoneAt: x.cutDoneAt ? Utilities.formatDate(x.cutDoneAt, R2_CFG.TZ, 'dd.MM.yyyy HH:mm') : '',
      printActual: r2ProgressActualForRoll_(x, print, x.print),
      cutActual: r2ProgressActualForRoll_(x, cut, x.cut),
      employee: r2Employee_(x.name) || x.printEmployee || x.cutEmployee || '', legacy: x.legacy
    };
  });
  order.allocated = allocated;
  order.remaining = Math.max(0, order.orderQty - allocated);
  order.over = Math.max(0, allocated - order.orderQty);
  order.print = print;
  order.cut = cut;
  order.cutter = r2CutterNameFromCode_(order.cutEmployeeCode) || (order.cutEmployeeCode ? 'Проверьте код ' + order.cutEmployeeCode : R2_CFG.CUTTER_DEFAULT);
  order.printArea = print.actual * order.areaPerPiece;
  order.cutArea = cut.actual * order.areaPerPiece;
  order.overPrint = Math.max(0, print.actual - order.orderQty);
  order.overCut = Math.max(0, cut.actual - order.orderQty);
  order.areaPerPiece = order.areaValid ? order.areaPerPiece : 0;
  order.printDate = order.printDate ? Utilities.formatDate(order.printDate, R2_CFG.TZ, 'dd.MM.yyyy HH:mm') : '';
  order.cutDate = order.cutDate ? Utilities.formatDate(order.cutDate, R2_CFG.TZ, 'dd.MM.yyyy HH:mm') : '';
  if (order.print.date) order.print.date = Utilities.formatDate(order.print.date, R2_CFG.TZ, 'dd.MM.yyyy HH:mm');
  if (order.cut.date) order.cut.date = Utilities.formatDate(order.cut.date, R2_CFG.TZ, 'dd.MM.yyyy HH:mm');
  delete order.columns;
  return order;
}

function r2GetOrders() {
  var result = r2SelectedOrders_();
  var unresolved = r2ReadStore_().filter(function(x) { return !x.sheetName || !x.article; }).length;
  if (result.error) return {error: result.error, unresolvedLegacy: unresolved,
    message: unresolved ? 'Старые рулоны без привязки к видимым заказам: ' + unresolved + '. Исходное скрытое хранилище сохранено.' : ''};
  return {orders: result.orders.map(function(order) { return r2DecorateOrder_(order); }), unresolvedLegacy: unresolved,
    message: unresolved ? 'Старые рулоны без привязки к видимым заказам: ' + unresolved + '. Они не приписаны заказам; исходное скрытое хранилище сохранено.' : ''};
}

function r2RefreshSelected() {
  r2RememberSelection_(SpreadsheetApp.getActiveRange());
  return r2GetOrders();
}

function r2AddRoll(uid, sheetName, row, name, quantity) {
  r2EnsureInitialized_();
  return withDocumentLock_(function() {
    var order = r2GetOrder_(uid, sheetName, row);
    name = String(name || '').trim();
    quantity = Number(quantity);
    if (!name) throw new Error('Введите номер или название рулона.');
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Количество должно быть целым числом больше нуля.');
    r2OrderArea_(order);
    var rolls = r2RollsForOrder_(order);
    var number = rolls.reduce(function(max, x) { return Math.max(max, x.number); }, 0) + 1;
    var now = new Date();
    r2WriteRoll_({rollId: Utilities.getUuid(), uid: order.uid, sheetName: order.sheetName, orderRow: order.row, article: order.article,
      name: name, number: number, print: false, cut: false, created: now, updated: now, quantity: quantity,
      printDoneAt: '', printEmployee: '', cutDoneAt: '', cutEmployee: '', legacy: false});
    r2UpdateOrderProgress_(order);
    SpreadsheetApp.flush();
    return r2GetOrders();
  });
}

function r2Roll_(rollId) {
  var roll = r2ReadStore_().find(function(x) { return x.rollId === String(rollId || '').trim(); });
  if (!roll) throw new Error('Рулон не найден в новом или перенесённом хранилище.');
  return roll;
}

function r2DeleteRowsByRecord_(sheet, records) {
  var seen = {}, rows = [];
  records.forEach(function(record) {
    var row = Number(record.row);
    if (!Number.isInteger(row) || row < 2 || seen[row]) return;
    seen[row] = true;
    rows.push(row);
  });
  rows.sort(function(a, b) { return a - b; });
  var blocks = [];
  rows.forEach(function(row) {
    var lastBlock = blocks[blocks.length - 1];
    if (lastBlock && row === lastBlock.start + lastBlock.count) lastBlock.count++;
    else blocks.push({start: row, count: 1});
  });
  blocks.reverse().forEach(function(block) { sheet.deleteRows(block.start, block.count); });
  return rows.length;
}

/** Delete one scoped roll and its linked facts/releases, then rebuild derived order and daily totals. */
function r2DeleteRoll(rollId, sheetName, row) {
  r2EnsureInitialized_();
  return withDocumentLock_(function() {
    rollId = String(rollId || '').trim();
    if (!rollId) throw new Error('Не указан рулон для удаления.');
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var store = ss.getSheetByName(R2_CFG.STORE);
    var matches = r2RowsByExactValue_(store, 1, R2_CFG.STORE_HEADERS, rollId,
      'Хранилище рулонов не найдено. Данные не изменены.',
      'Заголовки хранилища рулонов изменились. Данные не изменены.').map(function(item) {
        var r = item.values;
        return {row: item.row, rollId: String(r[0] || '').trim(), uid: String(r[1] || '').trim(),
          sheetName: String(r[2] || ''), orderRow: Number(r[3]) || 0, article: String(r[4] || ''),
          name: String(r[5] || ''), number: Number(r[6]) || 0, print: r2Bool_(r[7]), cut: r2Bool_(r[8]),
          created: r[9] || '', updated: r[10] || '', quantity: Number(r[11]) || 0,
          printDoneAt: r2Date_(r[12]), printEmployee: String(r[13] || ''),
          cutDoneAt: r2Date_(r[14]), cutEmployee: String(r[15] || ''), legacy: r2Bool_(r[16])};
      });
    if (!matches.length) throw new Error('Рулон уже удалён или больше не найден. Обновите карточку заказа.');
    if (matches.length !== 1) throw new Error('ID рулона повторяется в хранилище. Удаление остановлено.');

    var roll = matches[0];
    var order = r2GetOrder_(roll.uid, sheetName, row);
    if (roll.sheetName !== order.sheetName || roll.article !== order.article) {
      throw new Error('Рулон относится к другому заказу. Обновите выделение.');
    }

    var journalSheet = ss.getSheetByName(R2_CFG.JOURNAL);
    var progressStore = ss.getSheetByName(R2_CFG.PROGRESS_STORE);
    var journalMatches = r2RowsByExactValue_(journalSheet, 15, R2_CFG.JOURNAL_HEADERS, rollId,
      'Лист журнала выпуска не найден. Данные не изменены.',
      'Заголовки журнала выпуска изменились. Данные не изменены.');
    var progressMatches = r2RowsByExactValue_(progressStore, 2, R2_CFG.PROGRESS_HEADERS, rollId,
      'Хранилище фактического выпуска не найдено. Данные не изменены.',
      'Заголовки хранилища фактического выпуска изменились. Данные не изменены.');
    var mismatchedJournal = journalMatches.some(function(item) {
      var event = item.values;
      return String(event[7] || '').trim() !== order.uid || String(event[4] || '').trim() !== order.sheetName ||
        String(event[6] || '').trim() !== order.article;
    });
    var mismatchedProgress = progressMatches.some(function(item) {
      var event = item.values;
      return String(event[2] || '').trim() !== order.uid || String(event[3] || '').trim() !== order.sheetName ||
        String(event[5] || '').trim() !== order.article;
    });
    if (mismatchedJournal || mismatchedProgress) {
      throw new Error('У записей рулона расходится привязка к заказу. Данные не удалены; обновите карточку и проверьте журнал.');
    }

    var orderRolls = r2ReadStoreForOrder_(order);
    if (!orderRolls.some(function(item) { return item.rollId === rollId; })) {
      throw new Error('Рулон относится к другому заказу. Данные не удалены; обновите выделение.');
    }
    var orderJournal = r2ReadJournalForOrder_(order);
    var orderProgress = r2ReadProgressForOrder_(order);
    var snapshot = {
      rolls: orderRolls.filter(function(item) { return item.rollId !== rollId; }),
      journal: orderJournal.filter(function(item) { return item.rollId !== rollId; }),
      progress: orderProgress.filter(function(item) { return item.rollId !== rollId; })
    };

    var journalDeleted = r2DeleteRowsByRecord_(journalSheet, journalMatches);
    var progressDeleted = r2DeleteRowsByRecord_(progressStore, progressMatches);
    r2DeleteRowsByRecord_(store, matches);
    SpreadsheetApp.flush();

    var progressUpdate = r2UpdateOrderProgress_(order, true, snapshot);
    var dailyUpdate = r2RefreshDaily_();
    SpreadsheetApp.flush();

    var message = 'Рулон «' + roll.name + '» №' + roll.number + ' удалён. Записей выпуска в журнале удалено: ' + journalDeleted +
      '; фактических записей удалено: ' + progressDeleted + '.';
    if (!progressUpdate) message += ' Остаток не пересчитан: у оставшегося исторического рулона неизвестно количество.';
    return {message: message, journalDeleted: journalDeleted, progressDeleted: progressDeleted,
      progressUpdated: !!progressUpdate, dailyChanged: !!dailyUpdate.changed};
  });
}

function r2UpdateRoll(rollId, sheetName, row, name, quantity) {
  r2EnsureInitialized_();
  return withDocumentLock_(function() {
    var roll = r2Roll_(rollId);
    var order = r2GetOrder_(roll.uid, sheetName, row);
    name = String(name || '').trim();
    quantity = Number(quantity);
    if (!name) throw new Error('Введите название рулона.');
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Количество должно быть целым числом больше нуля.');
    var beforeName = roll.name;
    roll.name = name;
    roll.quantity = quantity;
    roll.sheetName = order.sheetName;
    roll.orderRow = order.row;
    roll.article = order.article;
    roll.updated = new Date();
    var journalRows = r2JournalRows_().filter(function(x) { return x.rollId === roll.rollId; });
    var printEvent = journalRows.find(function(x) { return x.id === 'AUTO_PRINT_' + roll.rollId; });
    var cutEvent = journalRows.find(function(x) { return x.id === 'AUTO_CUT_' + roll.rollId; });
    if (!roll.legacy && roll.print && (printEvent ? printEvent.quantity : 0) < quantity) {
      r2AutoEvent_(roll, order, 'Печать', false, roll.printEmployee);
      roll.print = false;
      roll.printDoneAt = '';
    }
    if (!roll.legacy && roll.cut && (cutEvent ? cutEvent.quantity : 0) < quantity) {
      r2AutoEvent_(roll, order, 'Резка', false, roll.cutEmployee);
      roll.cut = false;
      roll.cutDoneAt = '';
    }
    r2WriteRoll_(roll);
    if (roll.print && !roll.legacy) r2SetAutoEventQuantity_(roll, order, 'Печать');
    if (roll.cut && !roll.legacy) r2SetAutoEventQuantity_(roll, order, 'Резка');
    if (beforeName !== name) {
      r2JournalRows_().filter(function(x) { return x.rollId === roll.rollId; }).forEach(function(entry) {
        var current = r2JournalRows_().find(function(x) { return x.id === entry.id; });
        if (current) {
          var values = R2_CFG.JOURNAL_HEADERS.map(function(h) {
            var fields = {'ID записи': current.id, 'Дата': current.date, 'Сотрудник': current.employee, 'Операция': current.operation,
              'Лист-источник': current.sheetName, 'Строка заказа': current.sourceRow || '', 'Артикул': current.article, 'UID заказа': current.uid,
              'Рулон': name, 'Сделано': current.quantity, 'м² на 1 шт.': current.areaPerPiece, 'Выпуск м²': current.area,
              'Время записи': current.enteredAt, 'Комментарий': current.comment, 'ID рулона': current.rollId};
            return fields[h];
          });
          r2EnsureVisibleSheets_().journal.getRange(current.row, 1, 1, values.length).setValues([values]);
        }
      });
    }
    r2UpdateOrderProgress_(order);
    SpreadsheetApp.flush();
    return r2GetOrders();
  });
}

function r2AutoEvent_(roll, order, operation, ready, employee) {
  var print = operation === 'Печать';
  var id = 'AUTO_' + (print ? 'PRINT_' : 'CUT_') + roll.rollId;
  var logs = r2JournalRows_().filter(function(x) { return x.rollId === roll.rollId && x.operation === operation; });
  var previous = logs.find(function(x) { return x.id === id; });
  if (!ready) {
    var legacyId = 'R2_LEGACY_' + (print ? 'PRINT_' : 'CUT_') + roll.rollId;
    var oldEntry = previous && previous.quantity > 0 ? previous : logs.find(function(x) { return x.id === legacyId && x.quantity > 0; });
    if (!oldEntry) return;
    r2WriteJournal_({
      id: oldEntry.id, date: r2MoscowDay_(new Date()), employee: oldEntry.employee || employee, operation: operation,
      sheetName: order.sheetName, sourceRow: order.row, article: order.article, uid: order.uid, rollName: roll.name,
      quantity: 0, areaPerPiece: order.areaPerPiece, area: 0, enteredAt: new Date(),
      comment: 'Корректировка: готовность снята; прежний выпуск ' + oldEntry.quantity + ' шт. обнулён.', rollId: roll.rollId
    });
    return;
  }
  var now = new Date();
  var legacyEventId = 'R2_LEGACY_' + (print ? 'PRINT_' : 'CUT_') + roll.rollId;
  var legacyEvent = logs.find(function(x) { return x.id === legacyEventId && x.quantity > 0; });
  if (roll.legacy && legacyEvent && (print ? roll.print : roll.cut)) return;
  if (previous && previous.quantity > 0 && (print ? roll.print : roll.cut)) return;
  var quantity = r2ReadyActualQuantity_(roll, operation);
  var canonical = r2EmployeeForOperation_(roll, order, operation, employee || (print ? roll.printEmployee : roll.cutEmployee));
  if (!canonical) throw new Error('Название рулона должно начинаться с д, а или п.');
  r2WriteJournal_({
    id: id, date: r2MoscowDay_(now), employee: canonical, operation: operation,
    sheetName: order.sheetName, sourceRow: order.row, article: order.article, uid: order.uid,
    rollName: roll.name, quantity: quantity, areaPerPiece: order.areaPerPiece,
    area: quantity * order.areaPerPiece, enteredAt: now,
    comment: quantity > 0 ? 'Автоматически: рулон отмечен готовым.' : 'Отметка готовности; количество выпуска зафиксировано в истории рулона.', rollId: roll.rollId
  });
  if (print) { roll.printDoneAt = now; roll.printEmployee = canonical; }
  else { r2PersistCutterCode_(order, canonical); roll.cutDoneAt = now; roll.cutEmployee = canonical; }
}

function r2SetAutoEventQuantity_(roll, order, operation) {
  var id = 'AUTO_' + (operation === 'Печать' ? 'PRINT_' : 'CUT_') + roll.rollId;
  var existing = r2JournalRows_().find(function(x) { return x.id === id; });
  if (!existing) return;
  var quantity = r2ReadyActualQuantity_(roll, operation);
  r2WriteJournal_({
    id: id, date: existing.date || r2MoscowDay_(new Date()), employee: existing.employee || r2Employee_(roll.name),
    operation: operation, sheetName: order.sheetName, sourceRow: order.row, article: order.article, uid: order.uid,
    rollName: roll.name, quantity: quantity, areaPerPiece: order.areaPerPiece, area: quantity * order.areaPerPiece,
    enteredAt: existing.enteredAt || existing.date || new Date(),
    comment: 'Автоматическая запись скорректирована после изменения количества рулона.', rollId: roll.rollId
  });
}

function r2SetReady(rollId, sheetName, row, operation, ready, employee) {
  r2EnsureInitialized_();
  return withDocumentLock_(function() {
    if (operation !== 'Печать' && operation !== 'Резка') throw new Error('Операция должна быть «Печать» или «Резка».');
    var roll = r2Roll_(rollId);
    var order = r2GetOrder_(roll.uid, sheetName, row);
    r2OrderArea_(order);
    var canonical = r2EmployeeForOperation_(roll, order, operation, employee || (operation === 'Печать' ? roll.printEmployee : roll.cutEmployee));
    if (ready && !canonical) throw new Error('Укажите сотрудника или задайте рулону имя с первой буквой Д, А или П.');
    r2AutoEvent_(roll, order, operation, !!ready, canonical);
    if (operation === 'Печать') {
      roll.print = !!ready;
      if (!ready) roll.printDoneAt = '';
      if (canonical) roll.printEmployee = canonical;
    } else {
      roll.cut = !!ready;
      if (!ready) roll.cutDoneAt = '';
      if (canonical) roll.cutEmployee = canonical;
    }
    roll.sheetName = order.sheetName;
    roll.orderRow = order.row;
    roll.article = order.article;
    roll.updated = new Date();
    r2WriteRoll_(roll);
    r2UpdateOrderProgress_(order);
    SpreadsheetApp.flush();
    r2RefreshDaily_();
    return r2GetOrders();
  });
}

function r2SaveProductionLog(payload) {
  r2EnsureInitialized_();
  if (!payload || typeof payload !== 'object') throw new Error('Не получены данные выпуска.');
  var operation = String(payload.operation || '').trim();
  if (operation !== 'Печать' && operation !== 'Резка') throw new Error('Выберите печать или резку.');
  var quantity = Number(payload.quantity);
  if (!Number.isInteger(quantity) || quantity === 0) throw new Error('Укажите целое количество: положительное — добавить факт, отрицательное — исправить запись.');
  var requestId = String(payload.requestId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(requestId)) throw new Error('Не удалось проверить ключ сохранения. Обновите форму и повторите.');
  return withDocumentLock_(function() {
    var roll = r2Roll_(payload.rollId);
    var order = r2GetOrder_(payload.uid, payload.sheetName, payload.row);
    if (roll.uid !== order.uid || roll.sheetName !== order.sheetName || roll.article !== order.article) throw new Error('Выбранный рулон не относится к этой строке.');
    var areaPerPiece = r2OrderArea_(order);
    var employee = r2EmployeeForOperation_(roll, order, operation, payload.employee);
    if (!employee) throw new Error('Укажите сотрудника печати, задав рулону имя с д, а или п.');
    var comment = String(payload.comment || '').trim();
    if (quantity < 0 && !comment) throw new Error('Для исправления укажите причину в комментарии.');
    var id = 'UI_' + requestId;
    var existing = r2ProgressRows_().find(function(x) { return x.id === id; });
    if (existing) {
      if (existing.rollId !== roll.rollId || existing.uid !== order.uid || existing.sheetName !== order.sheetName ||
          existing.article !== order.article || existing.operation !== operation || existing.quantity !== quantity ||
          existing.employee !== employee || existing.comment !== comment) {
        throw new Error('Ключ сохранения уже использован с другими данными. Измените поле и повторите.');
      }
      return {message: 'Эта запись уже сохранена.', duplicate: true, remaining: Math.max(0, roll.quantity - r2PartialActual_(roll.rollId, operation))};
    }
    var nextActual = r2PartialActual_(roll.rollId, operation) + quantity;
    if (nextActual < 0) throw new Error('Исправление не может уменьшить фактически сделанное количество ниже нуля.');
    var now = new Date();
    if (operation === 'Резка') r2PersistCutterCode_(order, employee);
    r2WriteProgress_({
      id: id, date: r2MoscowDay_(now), employee: employee, operation: operation,
      sheetName: order.sheetName, sourceRow: order.row, article: order.article, uid: order.uid,
      rollName: roll.name, quantity: quantity, areaPerPiece: areaPerPiece,
      area: quantity * areaPerPiece, enteredAt: now, comment: comment, rollId: roll.rollId
    });
    roll.sheetName = order.sheetName;
    roll.orderRow = order.row;
    roll.article = order.article;
    roll.updated = now;
    r2WriteRoll_(roll);
    if (roll.print && operation === 'Печать' && !roll.legacy) r2SetAutoEventQuantity_(roll, order, operation);
    if (roll.cut && operation === 'Резка' && !roll.legacy) r2SetAutoEventQuantity_(roll, order, operation);
    r2UpdateOrderProgress_(order);
    SpreadsheetApp.flush();
    r2RefreshDaily_();
    return {message: quantity > 0
      ? 'Факт сохранён в истории рулона; в журнал выпуска попадёт после отметки «Готов». '
        + quantity.toLocaleString('ru-RU') + ' шт. / ' + (quantity * areaPerPiece).toLocaleString('ru-RU', {maximumFractionDigits: 4}) + ' м².'
      : 'Исправление факта сохранено: ' + quantity.toLocaleString('ru-RU') + ' шт.',
      duplicate: false, remaining: Math.max(0, roll.quantity - r2PartialActual_(roll.rollId, operation))};
  });
}

function r2RollActual_(rollId, operation) {
  var partial = Math.max(0, r2PartialActual_(rollId, operation));
  var release = r2JournalRows_().filter(function(x) {
    return x.rollId === rollId && x.operation === operation && x.quantity > 0 &&
      (x.id.indexOf('AUTO_') === 0 || x.id.indexOf('R2_LEGACY_') === 0);
  }).reduce(function(total, x) { return total + x.quantity; }, 0);
  return release || partial;
}

function r2RefreshDaily_(journalRows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var journal = ss.getSheetByName(R2_CFG.JOURNAL), daily = ss.getSheetByName(R2_CFG.DAILY);
  if (!journal || !daily || journal.getLastRow() === 0 || daily.getLastRow() === 0) {
    var sheets = r2EnsureVisibleSheets_();
    journal = sheets.journal;
    daily = sheets.daily;
  } else {
    var dailyHeaders = daily.getRange(1, 1, 1, Math.max(daily.getLastColumn(), R2_CFG.DAILY_HEADERS.length)).getDisplayValues()[0];
    if (!R2_CFG.DAILY_HEADERS.every(function(header, i) { return String(dailyHeaders[i] || '').trim() === header; })) {
      throw new Error('Заголовки листа «' + R2_CFG.DAILY + '» отличаются от ожидаемых. Данные не изменены.');
    }
  }
  var rows = journalRows || r2JournalRows_(true);
  var validSheets = {};
  ss.getSheets().forEach(function(s) {
    if (r2IsMarketplaceSheetName_(s.getName())) validSheets[s.getName()] = true;
  });
  var grouped = {};
  rows.forEach(function(x) {
    if (!x.date || !validSheets[x.sheetName] || !x.employee || (x.operation !== 'Печать' && x.operation !== 'Резка') || x.quantity <= 0) return;
    var keyDate = Utilities.formatDate(x.date, R2_CFG.TZ, 'yyyy-MM-dd');
    var key = [keyDate, x.employee, x.operation].join('|');
    if (!grouped[key]) grouped[key] = {date: r2MoscowDay_(x.date), employee: x.employee, operation: x.operation, quantity: 0, area: 0};
    grouped[key].quantity += x.quantity;
    grouped[key].area += x.area;
  });
  var output = Object.keys(grouped).map(function(k) { return grouped[k]; }).sort(function(a, b) {
    return b.date.getTime() - a.date.getTime() || a.employee.localeCompare(b.employee, 'ru') || (a.operation === 'Печать' ? -1 : 1);
  }).map(function(x) { return [x.date, x.employee, x.operation, x.quantity, x.area]; });
  
  var last = daily.getLastRow();
  var existing = last > 1 ? daily.getRange(2, 1, last - 1, R2_CFG.DAILY_HEADERS.length).getValues() : [];
  var same = existing.length === output.length && existing.every(function(r, i) {
    return r[0] instanceof Date && output[i][0] instanceof Date &&
      Utilities.formatDate(r[0], R2_CFG.TZ, 'yyyy-MM-dd') === Utilities.formatDate(output[i][0], R2_CFG.TZ, 'yyyy-MM-dd') &&
      String(r[1]) === output[i][1] && String(r[2]) === output[i][2] && Number(r[3]) === output[i][3] && Math.abs((Number(r[4]) || 0) - output[i][4]) < 1e-9;
  });
  if (same) return {rows: output.length, changed: false};
  if (last > 1) daily.getRange(2, 1, last - 1, R2_CFG.DAILY_HEADERS.length).clearContent();
  if (output.length) daily.getRange(2, 1, output.length, R2_CFG.DAILY_HEADERS.length).setValues(output);
  return {rows: output.length, changed: true};
}

function r2RefreshDailyReport() {
  r2EnsureInitialized_();
  return r2RefreshDaily_();
}

/** Existing timer trigger calls this name. Keep exactly one trigger; refresh only the derived daily report. */
function refreshKPI() {
  return r2RefreshDaily_();
}

function r2RefreshAllVisibleProgress() {
  r2EnsureInitialized_();
  return withDocumentLock_(function() {
    var seen = {};
    var index = r2OrderIndex_();
    var rollUids = {};
    r2ReadStore_().forEach(function(x) { rollUids[x.uid] = true; });
    Object.keys(rollUids).forEach(function(uid) {
      (index[uid] || []).forEach(function(order) {
        var key = order.sheetName + '|' + order.row;
        if (seen[key]) return;
        r2UpdateOrderProgress_(order);
        seen[key] = true;
      });
    });
    SpreadsheetApp.flush();
    return {updated: Object.keys(seen).length};
  });
}

function r2ShowAudit() {
  r2EnsureInitialized_();
  var rollCount = r2ReadStore_().length;
  var entries = r2JournalRows_();
  var ids = {};
  var duplicates = 0;
  entries.forEach(function(x) { if (ids[x.id]) duplicates++; ids[x.id] = true; });
  SpreadsheetApp.getActiveSpreadsheet().toast('Рулонов: ' + rollCount + ' · записей журнала: ' + entries.length + ' · повторных ID: ' + duplicates);
  return {rolls: rollCount, journalEntries: entries.length, duplicateIds: duplicates};
}


/** Panel readers fetch only matching rows; each result is still checked against UID, sheet, and article. */
function r2RowsByExactValue_(sheet, valueColumn, headers, value, missingMessage, changedMessage) {
  var last = sheet.getLastRow();
  if (last < 1) throw new Error(missingMessage);
  var actualHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (!headers.every(function(header, i) { return String(actualHeaders[i] || '').trim() === header; })) {
    throw new Error(changedMessage);
  }
  value = String(value || '').trim();
  if (!value || last < 2) return [];
  var matches = sheet.getRange(2, valueColumn, last - 1, 1).createTextFinder(value)
    .matchCase(true).matchEntireCell(true).findAll();
  var rowNumbers = matches.map(function(range) { return range.getRow(); }).sort(function(a, b) { return a - b; });
  var result = [];
  for (var i = 0; i < rowNumbers.length;) {
    var start = rowNumbers[i], end = start, next = i + 1;
    while (next < rowNumbers.length && rowNumbers[next] === end + 1) { end = rowNumbers[next]; next++; }
    var values = sheet.getRange(start, 1, end - start + 1, headers.length).getValues();
    values.forEach(function(row, offset) { result.push({row: start + offset, values: row}); });
    i = next;
  }
  return result;
}

function r2ReadStoreForOrder_(order) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(R2_CFG.STORE);
  if (!sheet) throw new Error('Хранилище рулонов не найдено. Откройте управление рулонами заново.');
  return r2RowsByUid_(sheet, 2, R2_CFG.STORE_HEADERS, order.uid,
    'Заголовки хранилища рулонов не найдены. Данные не изменены.',
    'Заголовки хранилища рулонов изменились. Данные не изменены.').map(function(item) {
      var r = item.values;
      return {
        row: item.row, rollId: String(r[0] || '').trim(), uid: String(r[1] || '').trim(),
        sheetName: String(r[2] || ''), orderRow: Number(r[3]) || 0, article: String(r[4] || ''),
        name: String(r[5] || ''), number: Number(r[6]) || 0, print: r2Bool_(r[7]), cut: r2Bool_(r[8]),
        created: r[9] || '', updated: r[10] || '', quantity: Number(r[11]) || 0,
        printDoneAt: r2Date_(r[12]), printEmployee: String(r[13] || ''),
        cutDoneAt: r2Date_(r[14]), cutEmployee: String(r[15] || ''), legacy: r2Bool_(r[16])
      };
    }).filter(function(x) {
      return !!x.rollId && x.uid === order.uid && x.sheetName === order.sheetName && x.article === order.article;
    });
}

function r2ReadJournalForOrder_(order) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(R2_CFG.JOURNAL);
  if (!sheet) throw new Error('Лист журнала выпуска не найден. Откройте управление рулонами заново.');
  return r2RowsByUid_(sheet, 8, R2_CFG.JOURNAL_HEADERS, order.uid,
    'Заголовки журнала выпуска не найдены. Данные не изменены.',
    'Заголовки журнала выпуска изменились. Данные не изменены.').map(function(item) {
      var r = item.values;
      return {
        row: item.row, id: String(r[0] || '').trim(), date: r2Date_(r[1]), employee: String(r[2] || '').trim(),
        operation: String(r[3] || '').trim(), sheetName: String(r[4] || '').trim(), sourceRow: Number(r[5]) || 0,
        article: String(r[6] || '').trim(), uid: String(r[7] || '').trim(), rollName: String(r[8] || '').trim(),
        quantity: Number(r[9]) || 0, areaPerPiece: Number(r[10]) || 0, area: Number(r[11]) || 0,
        enteredAt: r2Date_(r[12]), comment: String(r[13] || ''), rollId: String(r[14] || '').trim()
      };
    }).filter(function(x) {
      return !!x.id && x.uid === order.uid && x.sheetName === order.sheetName && x.article === order.article;
    });
}

function r2ReadProgressForOrder_(order) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(R2_CFG.PROGRESS_STORE);
  if (!sheet) throw new Error('Хранилище фактического выпуска не найдено. Откройте управление рулонами заново.');
  return r2RowsByUid_(sheet, 3, R2_CFG.PROGRESS_HEADERS, order.uid,
    'Заголовки хранилища фактического выпуска не найдены. Данные не изменены.',
    'Заголовки хранилища фактического выпуска изменились. Данные не изменены.').map(function(item) {
      var r = item.values;
      return {
        row: item.row, id: String(r[0] || '').trim(), rollId: String(r[1] || '').trim(),
        uid: String(r[2] || '').trim(), sheetName: String(r[3] || '').trim(), sourceRow: Number(r[4]) || 0,
        article: String(r[5] || '').trim(), operation: String(r[6] || '').trim(), employee: String(r[7] || '').trim(),
        date: r2Date_(r[8]), quantity: Number(r[9]) || 0, areaPerPiece: Number(r[10]) || 0,
        area: Number(r[11]) || 0, enteredAt: r2Date_(r[12]), comment: String(r[13] || '')
      };
    }).filter(function(x) {
      return !!x.id && x.uid === order.uid && x.sheetName === order.sheetName && x.article === order.article;
    });
}
