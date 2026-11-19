/** Original manager layout, backed by V2 storage. Legacy storage and KPI checks are read-only. */
/** Replace an already-open legacy sidebar before it can use the fixed-sheet handlers. */
function r2UpgradeLegacyPanel_() {
  SpreadsheetApp.getUi().showSidebar(
    HtmlService.createHtmlOutputFromFile('RollsV2Panel').setTitle('Управление рулонами')
  );
  return {orders: [], signature: 'R2_PANEL_UPGRADE', revision: 'R2_PANEL_UPGRADE',
    error: 'Загружаю актуальную панель рулонов…'};
}

function r2PanelVersion_() { return '2026-11-14.1'; }

function r2PanelSelection() {
  return r2PanelSelection_(SpreadsheetApp.getActiveRange());
}

function r2PanelRanges_(range) {
  if (!range) return [];
  var list = SpreadsheetApp.getActiveRangeList();
  var ranges = list ? list.getRanges() : [range];
  var id = range.getSheet().getSheetId();
  return ranges.filter(function(r) { return r.getSheet().getSheetId() === id; });
}

function r2PanelSelection_(range) {
  var signature = range && r2IsTargetSheet_(range.getSheet())
    ? [range.getSheet().getSheetId(), r2PanelRanges_(range).map(function(r) { return r.getA1Notation(); }).sort().join(';')].join('|') : '';
  return {signature: signature, revision: PropertiesService.getDocumentProperties().getProperty('R2_PANEL_REVISION') || ''};
}

function r2PanelTouch_() {
  PropertiesService.getDocumentProperties().setProperty('R2_PANEL_REVISION', Utilities.getUuid());
}

function r2PanelData() {
  try {
    var range = SpreadsheetApp.getActiveRange();
    return r2PanelSerializable_(r2PanelReadData_(range, r2PanelSelection_(range)));
  } catch(error) { return r2PanelReadFailure_(error); }
}

/** One request detects a new selection and returns its card. Unchanged selections read no roll history. */
function r2PanelPoll(signature, revision, retryEmpty, clientVersion, previewSelection) {
  try {
  if (clientVersion !== r2PanelVersion_()) return r2UpgradeLegacyPanel_();
  var range = SpreadsheetApp.getActiveRange();
  var selection = r2PanelSelection_(range);
  if (selection.signature === signature && selection.revision === revision &&
      !(retryEmpty && selection.signature)) return {changed: false};
  if (!selection.signature) return {changed: true, orders: [], message: 'Перейдите на видимую вкладку OZON или WB и выберите строку заказа.', signature: '', revision: selection.revision};
  // Reveal the selected articles before reading the roll and production journals.
  // This preview cannot be used for a mutation; the client immediately requests full facts.
  if (previewSelection && selection.signature !== signature) {
    var preview = r2PanelSelectedOrders_(range, true);
    preview.signature = selection.signature; preview.revision = selection.revision;
    preview.workbookId = SpreadsheetApp.getActiveSpreadsheet().getId();
    preview.preview = !!preview.orders.length; preview.changed = true;
    return r2PanelSerializable_(preview);
  }
  var result = r2PanelReadData_(range, selection);
  result.changed = true;
  return r2PanelSerializable_(result);
  } catch(error) { return r2PanelReadFailure_(error); }
}

// A transient Sheets/Properties read failure is not a missing order or a write acknowledgement.
function r2PanelReadFailure_(error) {
  var message=String(error&&error.message||error||'Не удалось прочитать заказ.');
  var retryable=/INTERNAL|ошибка сервера|server error|timed? ?out|temporar|unavailable/i.test(message);
  return {readError:true,retryable:retryable,message:retryable?'Google временно не ответил при чтении заказа.':message.slice(0,300)};
}

function r2PanelSerializable_(result){return JSON.parse(JSON.stringify(result));}

/** Reuse current values within this response; never retain production quantities across requests. */
function r2PanelReadData_(range, selection) {
  var result = r2PanelSelectedOrders_(range);
  if (result.orders && result.orders.length) {
    
    var batch = result.orders.length > 1 ? {rolls: r2ReadStore_(true), journal: r2JournalRows_(true), progress: r2ProgressRows_(true)} : null;
    result.orders = result.orders.map(function(order) {
      var belongs = function(x) { return x.uid === order.uid && x.sheetName === order.sheetName && x.article === order.article; };
      var snapshot = batch ? {rolls: batch.rolls.filter(belongs), journal: batch.journal.filter(belongs), progress: batch.progress.filter(belongs)} : {rolls: r2ReadStoreForOrder_(order), journal: r2ReadJournalForOrder_(order), progress: r2ReadProgressForOrder_(order)};
      return r2DecorateOrder_(order, snapshot);
    });
  }
  result.signature = selection.signature;
  result.revision = selection.revision;
  result.workbookId = SpreadsheetApp.getActiveSpreadsheet().getId();
  return result;
}

function r2PanelRefreshData() {
  return r2PanelData();
}

function r2PanelSelectedOrders_(range, skipHint) {
  if (!range) return r2SelectedOrders_(true);
  var sheet = range.getSheet();
  if (!r2IsTargetSheet_(sheet)) return {orders: [], message: 'Перейдите на видимую вкладку OZON или WB и выберите строку заказа.'};
  var last = sheet.getLastRow(), wanted = {};
  r2PanelRanges_(range).forEach(function(r) {
    var end = Math.min(last, r.getLastRow());
    for (var row = Math.max(R2_CFG.DATA_ROW, r.getRow()); row <= end; row++) wanted[row] = true;
  });
  var rows = Object.keys(wanted).map(Number).sort(function(a,b) { return a-b; });
  if (!rows.length) return {orders: [], message: 'Выберите строку заказа на активной вкладке OZON или WB.'};
  var map = r2HeaderMap_(sheet), orders = [];
  for (var i = 0; i < rows.length;) {
    var start = rows[i], end = start, next = i + 1;
    while (next < rows.length && rows[next] === end + 1) { end = rows[next]; next++; }
    var values = sheet.getRange(start, 1, end-start+1, sheet.getLastColumn()).getValues();
    values.forEach(function(v, offset) {
      var row = start + offset;
      var order = r2OrderFromValues_(sheet, row, map, v);
      if (order && !sheet.isRowHiddenByFilter(row) && !sheet.isRowHiddenByUser(row)) orders.push(order);
    });
    i = next;
  }
  if (!orders.length) return {orders: [], message: 'В выделении нет видимых строк заказов.'};
  var remembered = JSON.stringify({sheetName: sheet.getName(), rows: orders.map(function(o) { return {row:o.row,uid:o.uid}; })});
  // This compatibility hint is optional; a large selection must not fail on the per-property byte quota.
  if (!skipHint && remembered.length < 2500) {
    try { PropertiesService.getUserProperties().setProperty('R2_ACTIVE_SELECTION', remembered); } catch (ignored) {}
  }
  return {orders: orders};
}

/** Inspect the existing KPI log without calling legacy helpers which can modify source records. */
function r2PanelKpiAudit() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logSheet = ss.getSheetByName('_ROLL_KPI_LOG');
  var logValues = logSheet && logSheet.getLastRow() > 1
    ? logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 9).getValues() : [];
  var logMap = {}, sourceMap = {}, legacyFlags = {};
  logValues.forEach(function(row) { if (row[0]) logMap[String(row[0])] = row; });
  var legacySheet = ss.getSheetByName(R2_CFG.SYSTEM_OLD);
  if (legacySheet && legacySheet.getLastRow() > 1) {
    var headers = legacySheet.getRange(1, 1, 1, legacySheet.getLastColumn()).getValues()[0].map(r2Normalize_);
    var idCol = headers.indexOf('rollid'), flagCol = headers.indexOf('kpisync');
    if (idCol >= 0 && flagCol >= 0) {
      legacySheet.getRange(2, 1, legacySheet.getLastRow() - 1, headers.length).getValues().forEach(function(row) {
        legacyFlags[String(row[idCol] || '')] = !!row[flagCol];
      });
    }
  }
  var audit = {printed: 0, inLog: 0, missing: 0, repair: 0, conflicts: 0, stale: 0, orphan: 0, errors: 0,
    missingAreaDmitry: 0, missingAreaAndrey: 0, missingAreaPasha: 0, missingItems: [], unresolved: 0,
    readOnly: true, hasKpiSheet: !!ss.getSheetByName('KPI'), hasLog: !!logSheet};
  var rolls = r2ReadStore_(true), journal = r2JournalRows_(true), releases = {};
  journal.forEach(function(event) {
    if (event.operation !== 'Печать' || event.quantity <= 0 || !event.rollId) return;
    if (!releases[event.rollId]) releases[event.rollId] = {quantity: 0, area: 0};
    releases[event.rollId].quantity += event.quantity;
    releases[event.rollId].area += event.area;
  });
  rolls.forEach(function(roll) {
    sourceMap[roll.rollId] = true;
    if (!roll.sheetName || !roll.article) audit.unresolved++;
    if (!roll.print) { if (logMap[roll.rollId]) audit.stale++; return; }
    audit.printed++;
    if (logMap[roll.rollId]) { audit.inLog++; return; }
    if (legacyFlags[roll.rollId]) { audit.conflicts++; return; }
    var employee = r2Employee_(roll.name) || roll.printEmployee;
    var release = releases[roll.rollId];
    if (!roll.sheetName || !roll.article || !employee || !release) { audit.errors++; return; }
    audit.missing++;
    if (employee === 'Дмитрий') audit.missingAreaDmitry += release.area;
    if (employee === 'Андрей') audit.missingAreaAndrey += release.area;
    if (employee === 'Паша') audit.missingAreaPasha += release.area;
    if (audit.missingItems.length < 30) audit.missingItems.push({article: roll.article, roll: roll.name,
      quantity: release.quantity, area: release.area, employee: employee});
  });
  Object.keys(logMap).forEach(function(id) { if (!sourceMap[id]) audit.orphan++; });
  return audit;
}

function r2PanelRollScope_(rollId, sheetName, row) {
  var roll = r2Roll_(rollId);
  var order = r2GetOrder_(roll.uid, sheetName, row);
  if (roll.sheetName !== order.sheetName || roll.article !== order.article) {
    throw new Error('Рулон относится к другому заказу. Обновите выделение.');
  }
  return {roll: roll, order: order};
}

function r2PanelDeleteRoll(rollId, sheetName, row) {
  var result = r2DeleteRoll(rollId, sheetName, row);
  r2PanelTouch_();
  return result;
}

function r2PanelAddRolls(uid, sheetName, row, name, quantity, count) {
  r2EnsureInitialized_();
  return withDocumentLock_(function() {
    var order = r2GetOrder_(uid, sheetName, row);
    name = String(name || '').trim(); quantity = Number(quantity);
    count = count === '' || count == null ? 1 : Number(count);
    if (!name) throw new Error('Введите номер / название рулона.');
    if (!r2Employee_(name)) throw new Error('Название рулона должно начинаться с д, а или п.');
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Штук на каждом рулоне: укажите целое число больше нуля.');
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('Количество рулонов: укажите целое число от 1 до 500.');
    r2OrderArea_(order);
    var snapshot = {rolls: r2ReadStoreForOrder_(order), journal: r2ReadJournalForOrder_(order), progress: r2ReadProgressForOrder_(order)};
    var rolls = r2RollsForOrder_(order, snapshot.rolls);
    var number = rolls.filter(function(roll) { return roll.name === name; })
      .reduce(function(max, roll) { return Math.max(max, roll.number); }, 0);
    var now = new Date(), values = [], addedRolls = [];
    var store = r2Store_().sheet, startRow = store.getLastRow() + 1;
    for (var i = 1; i <= count; i++) {
      var roll = {row: startRow + i - 1, rollId: Utilities.getUuid(), uid: order.uid, sheetName: order.sheetName,
        orderRow: order.row, article: order.article, name: name, number: number + i, print: false, cut: false,
        created: now, updated: now, quantity: quantity, printDoneAt: null, printEmployee: '',
        cutDoneAt: null, cutEmployee: '', legacy: false};
      addedRolls.push(roll);
      values.push([roll.rollId, order.uid, order.sheetName, order.row,
      order.article, name, number + i, false, false, now, now, quantity, '', '', '', '', false]);
    }
    
    store.getRange(startRow, 1, values.length, R2_CFG.STORE_HEADERS.length).setValues(values);
    snapshot.rolls = snapshot.rolls.concat(addedRolls);
    r2UpdateOrderProgress_(order, false, snapshot);
    r2PanelTouch_(); SpreadsheetApp.flush();
    var selection = r2PanelSelection_(SpreadsheetApp.getActiveRange());
    return {added: count, message: 'Рулоны добавлены: ' + count + '.', order: r2DecorateOrder_(order, snapshot),
      signature: selection.signature, revision: selection.revision};
  });
}

/** Complete one name group or the whole selected order under a single document lock. */
function r2PanelRollValues_(roll) {
  return [roll.rollId, roll.uid, roll.sheetName || '', Number(roll.orderRow) || '', roll.article || '',
    roll.name || '', Number(roll.number) || 0, !!roll.print, !!roll.cut, roll.created || new Date(),
    roll.updated || new Date(), Number(roll.quantity) || 0, roll.printDoneAt || '', roll.printEmployee || '',
    roll.cutDoneAt || '', roll.cutEmployee || '', !!roll.legacy];
}

function r2PanelJournalValues_(event) {
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
}

/** Write existing rows and appends in contiguous blocks to avoid one spreadsheet call per roll. */
function r2PanelWriteRecordBlocks_(sheet, records, width, valuesForRecord) {
  var nextRow = sheet.getLastRow() + 1, appendCount = 0;
  var entries = records.map(function(record) {
    var row = Number(record.row) || 0;
    if (row < 2) { row = nextRow + appendCount; appendCount++; }
    return {record: record, row: row, values: valuesForRecord(record)};
  }).sort(function(a, b) { return a.row - b.row; });
  var blocks = [];
  entries.forEach(function(entry) {
    var block = blocks[blocks.length - 1];
    if (block && entry.row === block.start + block.values.length) block.values.push(entry.values);
    else blocks.push({start: entry.row, values: [entry.values]});
    entry.record.row = entry.row;
  });
  blocks.forEach(function(block) {
    sheet.getRange(block.start, 1, block.values.length, width).setValues(block.values);
  });
  if (appendCount && sheet.getName() === R2_CFG.JOURNAL) {
    sheet.getRange(nextRow, 2, appendCount, 1).setNumberFormat('dd.MM.yyyy');
    sheet.getRange(nextRow, 11, appendCount, 2).setNumberFormat('0.000000');
    sheet.getRange(nextRow, 13, appendCount, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
  }
}

/** Complete one name group or the whole selected order under a single document lock. */
function r2PanelComplete(uid, sheetName, row, operation, groupName) {
  r2EnsureInitialized_();
  return withDocumentLock_(function() {
    if (operation !== 'Печать' && operation !== 'Резка') throw new Error('Выберите печать или порезку.');
    var order = r2GetOrder_(uid, sheetName, row);
    r2OrderArea_(order);
    var isPrint = operation === 'Печать';
    var snapshot = {
      rolls: r2ReadStoreForOrder_(order),
      journal: r2JournalRows_(true),
      progress: r2ProgressRows_(true)
    };
    var rolls = r2RollsForOrder_(order, snapshot.rolls).filter(function(roll) {
      return !groupName || roll.name === groupName;
    });
    if (!rolls.length) throw new Error('Сначала добавьте рулоны этой строке.');
    var pending = rolls.filter(function(roll) { return !(isPrint ? roll.print : roll.cut); });
    var employees = Object.create(null);
    pending.forEach(function(roll) {
      var employee = r2EmployeeForOperation_(roll, order, operation, isPrint ? roll.printEmployee : roll.cutEmployee);
      if (!employee) throw new Error('Название рулона «' + roll.name + '» должно начинаться с д, а или п.');
      employees[roll.rollId] = employee;
    });
    if (pending.length) {
      if (!isPrint) r2PersistCutterCode_(order, R2_CFG.CUTTER_DEFAULT);
      var journalById = Object.create(null), journalIndexById = Object.create(null);
      snapshot.journal.forEach(function(event, index) {
        if (!Object.prototype.hasOwnProperty.call(journalById, event.id)) {
          journalById[event.id] = event;
          journalIndexById[event.id] = index;
        }
      });
      var events = [];
      pending.forEach(function(roll) {
        var now = new Date(), employee = employees[roll.rollId];
        var progress = snapshot.progress.filter(function(entry) {
          return entry.rollId === roll.rollId && entry.operation === operation;
        });
        var quantity = progress.length
          ? Math.max(0, progress.reduce(function(total, entry) { return total + entry.quantity; }, 0))
          : Math.max(0, Number(roll.quantity) || 0);
        var eventId = 'AUTO_' + (isPrint ? 'PRINT_' : 'CUT_') + roll.rollId;
        var event = {
          id: eventId, date: r2MoscowDay_(now), employee: employee, operation: operation,
          sheetName: order.sheetName, sourceRow: order.row, article: order.article, uid: order.uid,
          rollName: roll.name, quantity: quantity, areaPerPiece: order.areaPerPiece,
          area: quantity * order.areaPerPiece, enteredAt: now,
          comment: quantity > 0 ? 'Автоматически: рулон отмечен готовым.' : 'Отметка готовности; количество выпуска зафиксировано в истории рулона.',
          rollId: roll.rollId
        };
        var existingIndex = journalIndexById[eventId];
        if (existingIndex == null) snapshot.journal.push(event);
        else { event.row = snapshot.journal[existingIndex].row; snapshot.journal[existingIndex] = event; }
        journalById[eventId] = event;
        events.push(event);
        if (isPrint) { roll.print = true; roll.printDoneAt = now; roll.printEmployee = employee; }
        else { roll.cut = true; roll.cutDoneAt = now; roll.cutEmployee = employee; }
        roll.updated = now; roll.orderRow = order.row;
      });
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var store = ss.getSheetByName(R2_CFG.STORE);
      var journal = ss.getSheetByName(R2_CFG.JOURNAL);
      r2PanelWriteRecordBlocks_(store, pending, R2_CFG.STORE_HEADERS.length, r2PanelRollValues_);
      r2PanelWriteRecordBlocks_(journal, events, R2_CFG.JOURNAL_HEADERS.length, r2PanelJournalValues_);
      r2UpdateOrderProgress_(order, false, snapshot);
      r2RefreshDaily_(snapshot.journal); r2PanelTouch_(); SpreadsheetApp.flush();
    }
    return {updated: pending.length, message: operation === 'Печать' ? 'Печать завершена.' : 'Порезка завершена.'};
  });
}

function r2PanelSetReady(rollId, sheetName, row, operation, ready) {
  var scoped = r2PanelRollScope_(rollId, sheetName, row);
  var employee = r2EmployeeForOperation_(scoped.roll, scoped.order, operation,
    operation === 'Печать' ? scoped.roll.printEmployee : scoped.roll.cutEmployee);
  if (ready && !employee) throw new Error('Название рулона должно начинаться с д, а или п.');
  var result = r2SetReady(rollId, sheetName, row, operation, ready, employee);
  r2PanelTouch_(); return result;
}

function r2PanelUpdateRoll(rollId, sheetName, row, name, quantity) {
  r2PanelRollScope_(rollId, sheetName, row);
  if (!r2Employee_(name)) throw new Error('Название рулона должно начинаться с д, а или п.');
  var result = r2UpdateRoll(rollId, sheetName, row, name, quantity);
  r2PanelTouch_(); return result;
}

function r2PanelUpdateNumber(rollId, sheetName, row, number) {
  return withDocumentLock_(function() {
    var scoped = r2PanelRollScope_(rollId, sheetName, row);
    number = Number(number);
    if (!Number.isInteger(number) || number < 1) throw new Error('Номер рулона должен быть целым числом больше нуля.');
    var duplicate = r2RollsForOrder_(scoped.order).some(function(roll) {
      return roll.rollId !== rollId && roll.name === scoped.roll.name && roll.number === number;
    });
    if (duplicate) throw new Error('В этой группе уже есть рулон с таким номером.');
    scoped.roll.number = number; scoped.roll.updated = new Date();
    r2WriteRoll_(scoped.roll); r2PanelTouch_();
    return {message: 'Номер сохранён.'};
  });
}

function r2PanelRenameGroup(uid, sheetName, row, oldName, name) {
  return withDocumentLock_(function() {
    var order = r2GetOrder_(uid, sheetName, row);
    name = String(name || '').trim();
    if (!r2Employee_(name)) throw new Error('Название рулона должно начинаться с д, а или п.');
    var rolls = r2RollsForOrder_(order).filter(function(roll) { return roll.name === oldName; });
    if (!rolls.length) throw new Error('Группа рулонов не найдена. Обновите выделение.');
    var journal = r2JournalRows_(), ids = {};
    rolls.forEach(function(roll) {
      ids[roll.rollId] = true; roll.name = name; roll.updated = new Date(); r2WriteRoll_(roll);
    });
    journal.filter(function(event) { return ids[event.rollId]; }).forEach(function(event) {
      event.rollName = name; r2WriteJournal_(event);
    });
    r2UpdateOrderProgress_(order); r2PanelTouch_(); SpreadsheetApp.flush();
    return {message: 'Название группы сохранено.'};
  });
}

function r2PanelSaveFact(payload) {
  var scoped = r2PanelRollScope_(payload.rollId, payload.sheetName, payload.row);
  payload.employee = r2EmployeeForOperation_(scoped.roll, scoped.order, payload.operation,
    payload.operation === 'Печать' ? scoped.roll.printEmployee : scoped.roll.cutEmployee);
  if (!payload.employee) throw new Error('Название рулона должно начинаться с д, а или п.');
  var result = r2SaveProductionLog(payload);
  r2PanelTouch_(); return result;
}

// Authenticated stock gateway health also exercises the actual read/decorate
// path against one existing order per tab. This never creates rolls or facts.
function r2StockPanelHealth_(){
  var book=SpreadsheetApp.getActiveSpreadsheet(),snapshot={rolls:r2ReadStore_(true),journal:r2JournalRows_(true),progress:r2ProgressRows_(true)};
  return ['Запасы склад','Срочные 2 этаж'].map(function(name){
    var sheet=book.getSheetByName(name),map=r2HeaderMap_(sheet),last=sheet.getLastRow();
    if(last>4096)throw Error('Лист запасов превышает допустимый размер проверки.');
    var values=last>=5?sheet.getRange(5,1,last-4,sheet.getLastColumn()).getValues():[],order=null;
    for(var i=0;i<values.length&&!order;i++)order=r2OrderFromValues_(sheet,i+5,map,values[i]);
    if(!order)return {sheetId:sheet.getSheetId(),status:'empty'};
    var matches=function(r){return r.uid===order.uid&&r.sheetName===order.sheetName&&r.article===order.article;};
    var result=r2PanelSerializable_(r2DecorateOrder_(order,{rolls:snapshot.rolls.filter(matches),journal:snapshot.journal.filter(matches),progress:snapshot.progress.filter(matches)}));
    return {sheetId:sheet.getSheetId(),status:'ready',article:result.article,quantity:result.orderQty,rolls:result.rolls.length,printed:result.print.actual,cut:result.cut.actual};
  });
}
