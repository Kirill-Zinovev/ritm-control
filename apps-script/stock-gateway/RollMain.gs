const C = {
  SHEET: 'OZON НОВЫЙ ГОД',
  SYSTEM: '_SYSTEM_ROLLS',
  START: 4,

  MACHINE: 4,
  ARTICLE: 5,
  SHEETS: 6,
  SIZE: 7,
  AREA: 10,          // J
  FOLDER: 12,
  QUANTITY: 15,      // O

  PRINT: 17,         // Q
  CUT: 18,           // R
  PRINT_DATE: 21,    // U
  CUT_DATE: 22,      // V
  DIFFERENCE: 23,    // W
  COMMENT: 24,
  SHOP: 25,
  ROLL: 26,          // Z
  UID: 32,           // AF

  SYS_UID: 1,
  SYS_NAME: 2,
  SYS_NUMBER: 3,
  SYS_PRINT: 4,
  SYS_CUT: 5,
  SYS_CREATED: 6,
  SYS_UPDATED: 7,
  SYS_QUANTITY: 8,
  SYS_ROLL_ID: 9,
  SYS_PRINT_DATE: 10,
  SYS_EMPLOYEE: 11,
  SYS_AREA: 12,
  SYS_KPI_SYNC: 13,
  SYS_COLS: 13,

  KPI_SPREADSHEET:
    '1vzLLRe7oi4IlvzIaWZd08dte7byCkqeXVAL4iSFqhOg',

  KPI_SHEET: 'KPI',
  KPI_SYS: '_KPI_SYS',
  KPI_LOG: '_ROLL_KPI_LOG',

  TIMEZONE: 'Europe/Moscow'
};


// ======================================================
// MENU
// ======================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📦 Рулоны')
    .addItem('Управление рулонами · 29.10.1', 'r2OpenManager')
    .addSeparator()
    .addItem('Проверить и начислить KPI', 'syncAllMissingKpiMenu_')
    .addItem('Обновить все статусы', 'refreshAllRollOrders')
    .addItem('Журнал выпуска', 'r2OpenJournal')
    .addItem('Выпуск по дням', 'r2OpenDailyReport')
    .addToUi();
}


function openRollManager() {
  return r2OpenManager();
  setupSystemSheet_();
  rememberSelection_();

  SpreadsheetApp.getUi().showSidebar(
    HtmlService
      .createHtmlOutputFromFile('Без названия')
      .setTitle('Управление рулонами')
  );
}


function syncAllMissingKpiMenu_() {
  var result = syncAllMissingKpi();

  SpreadsheetApp.getActive().toast(
    'Начислено: ' +
    result.added +
    ' · восстановлено: ' +
    result.repaired
  );
}


// ======================================================
// SHEETS
// ======================================================

function sheet_() {
  var s = SpreadsheetApp.getActive()
    .getSheetByName(C.SHEET);

  if (!s) {
    throw new Error(
      'Не найден лист ' + C.SHEET
    );
  }

  return s;
}


function sys_() {
  var s = SpreadsheetApp.getActive()
    .getSheetByName(C.SYSTEM);

  if (!s) {
    throw new Error(
      'Не найден лист ' + C.SYSTEM
    );
  }

  return s;
}


function val_(s, row, col) {
  return s
    .getRange(row, col)
    .getDisplayValue();
}


// ======================================================
// SETUP
// ======================================================

function setupSystemSheet_() {
  var s = sys_();

  if (s.getMaxColumns() < C.SYS_COLS) {
    s.insertColumnsAfter(
      s.getMaxColumns(),
      C.SYS_COLS - s.getMaxColumns()
    );
  }

  var headers = [
    'UID',
    'ROLL_NAME',
    'ROLL_NUMBER',
    'PRINT',
    'CUT',
    'CREATED',
    'UPDATED',
    'ROLL_QUANTITY',
    'ROLL_ID',
    'PRINT_DONE_AT',
    'PRINT_EMPLOYEE',
    'PRINT_AREA',
    'KPI_SYNC'
  ];

  var current = s
    .getRange(1, 1, 1, headers.length)
    .getValues()[0];

  for (var i = 0; i < headers.length; i++) {
    if (!current[i]) {
      current[i] = headers[i];
    }
  }

  s
    .getRange(1, 1, 1, headers.length)
    .setValues([current]);

  ensureRollIds_();
}


function ensureRollIds_() {
  var s = sys_();
  var last = s.getLastRow();

  if (last < 2) return;

  var data = s
    .getRange(
      2,
      1,
      last - 1,
      C.SYS_COLS
    )
    .getValues();

  var changed = false;

  for (var i = 0; i < data.length; i++) {
    var uid = String(data[i][0] || '').trim();
    var rollId = String(data[i][8] || '').trim();

    if (uid && !rollId) {
      data[i][8] = Utilities.getUuid();
      changed = true;
    }
  }

  if (changed) {
    s
      .getRange(
        2,
        1,
        data.length,
        C.SYS_COLS
      )
      .setValues(data);
  }
}


// ======================================================
// LOCK
// ======================================================

function withDocumentLock_(fn) {
  // The web gateway has no document context; the shared script lock also
  // serializes stock plan changes with every worker-side roll operation.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}


// ======================================================
// HELPERS
// ======================================================

function parseNumber_(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  if (
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return value;
  }

  var text = String(value)
    .replace(/\u00A0/g, '')
    .replace(/\s+/g, '')
    .replace(',', '.');

  var match =
    text.match(/-?\d+(?:\.\d+)?/);

  if (!match) return null;

  var n = Number(match[0]);

  return Number.isFinite(n)
    ? n
    : null;
}


function formatQty_(value) {
  var n = Number(value) || 0;

  return Number.isInteger(n)
    ? String(n)
    : String(n).replace('.', ',');
}


function roundArea_(value) {
  return Math.round(
    Number(value) * 10000
  ) / 10000;
}


function dateForClient_(value) {
  if (!value) return '';

  if (value instanceof Date) {
    return Utilities.formatDate(
      value,
      C.TIMEZONE,
      'dd.MM.yyyy HH:mm'
    );
  }

  return String(value);
}


// ======================================================
// ORDER UID
// ======================================================

function uid_(s, row) {
  var cell =
    s.getRange(row, C.UID);

  var id =
    String(cell.getValue() || '').trim();

  if (!id) {
    id = Utilities.getUuid();
    cell.setValue(id);
  }

  return id;
}


// ======================================================
// REVISION
// ======================================================

function touchRollRevision_() {
  PropertiesService
    .getDocumentProperties()
    .setProperty(
      'ROLL_REVISION',
      Date.now() +
      '-' +
      Utilities.getUuid()
    );
}


function getRollRevision_() {
  return PropertiesService
    .getDocumentProperties()
    .getProperty('ROLL_REVISION') || '0';
}


// ======================================================
// SELECTION
// ======================================================

function isVisibleRow_(s, row) {
  try {
    if (s.isRowHiddenByFilter(row)) {
      return false;
    }
  } catch (e) {}

  try {
    if (s.isRowHiddenByUser(row)) {
      return false;
    }
  } catch (e) {}

  return true;
}


function selectionRows_(range) {
  if (
    !range ||
    range.getSheet().getName() !== C.SHEET
  ) {
    return [];
  }

  var s = range.getSheet();

  var first =
    Math.max(C.START, range.getRow());

  var last =
    Math.min(
      s.getLastRow(),
      range.getLastRow()
    );

  if (last < first) return [];

  var articles = s
    .getRange(
      first,
      C.ARTICLE,
      last - first + 1,
      1
    )
    .getDisplayValues();

  var rows = [];

  for (var i = 0; i < articles.length; i++) {
    var row = first + i;

    if (!isVisibleRow_(s, row)) {
      continue;
    }

    var article =
      String(articles[i][0] || '').trim();

    if (article) {
      rows.push({
        row: row,
        article: article
      });
    }
  }

  return rows;
}


function saveSelection_(range) {
  var rows = selectionRows_(range);

  if (!rows.length) return null;

  var ctx = {
    sheet: C.SHEET,
    rows: rows
  };

  PropertiesService
    .getUserProperties()
    .setProperty(
      'ROLL_CONTEXT',
      JSON.stringify(ctx)
    );

  return ctx;
}


function onSelectionChange(e) {
  try { if (e && e.range) r2RememberSelection_(e.range); } catch (err) {}
  return;
  try {
    if (e && e.range) {
      saveSelection_(e.range);
    }
  } catch (err) {}
}


function rememberSelection_() {
  var ctx = saveSelection_(
    SpreadsheetApp.getActiveRange()
  );

  if (ctx) return ctx;

  var raw = PropertiesService
    .getUserProperties()
    .getProperty('ROLL_CONTEXT');

  if (!raw) return null;

  try {
    ctx = JSON.parse(raw);

    if (
      ctx &&
      !ctx.rows &&
      ctx.row
    ) {
      ctx.rows = [{
        row: ctx.row,
        article: ctx.article || ''
      }];
    }

    return ctx;

  } catch (e) {
    return null;
  }
}


// ======================================================
// ORDER
// ======================================================

function orderAtRow_(s, row) {
  var article =
    String(
      val_(s, row, C.ARTICLE)
    ).trim();

  if (!article) return null;

  return {
    uid: uid_(s, row),
    row: row,
    article: article,

    machine:
      val_(s, row, C.MACHINE),

    size:
      val_(s, row, C.SIZE),

    sheets:
      val_(s, row, C.SHEETS),

    quantity:
      val_(s, row, C.QUANTITY),

    orderQty:
      parseNumber_(
        s
          .getRange(row, C.QUANTITY)
          .getValue()
      ),

    totalArea:
      parseNumber_(
        s
          .getRange(row, C.AREA)
          .getValue()
      ),

    print:
      val_(s, row, C.PRINT),

    cut:
      val_(s, row, C.CUT),

    printDate:
      val_(s, row, C.PRINT_DATE),

    cutDate:
      val_(s, row, C.CUT_DATE),

    difference:
      val_(s, row, C.DIFFERENCE),

    roll:
      val_(s, row, C.ROLL),

    comment:
      val_(s, row, C.COMMENT),

    shop:
      val_(s, row, C.SHOP)
  };
}


function findOrder_(uid) {
  uid =
    String(uid || '').trim();

  if (!uid) {
    throw new Error('Не найден заказ');
  }

  var s = sheet_();
  var last = s.getLastRow();

  if (last < C.START) {
    throw new Error('Не найден заказ');
  }

  var cell = s
    .getRange(
      C.START,
      C.UID,
      last - C.START + 1,
      1
    )
    .createTextFinder(uid)
    .matchEntireCell(true)
    .findNext();

  if (!cell) {
    throw new Error(
      'Строка заказа больше не найдена'
    );
  }

  return orderAtRow_(
    s,
    cell.getRow()
  );
}


// ======================================================
// SYSTEM ROWS
// ======================================================

function rawRoll_(values, row) {
  return {
    row: row,

    uid:
      String(values[0] || ''),

    name:
      String(values[1] || ''),

    number:
      Number(values[2]) || 0,

    print:
      values[3] === true,

    cut:
      values[4] === true,

    created:
      values[5] || '',

    updated:
      values[6] || '',

    quantity:
      Number(values[7]) || 0,

    rollId:
      String(values[8] || ''),

    printDoneAt:
      values[9] || '',

    employee:
      String(values[10] || ''),

    area:
      Number(values[11]) || 0,

    kpiSync:
      values[12] || ''
  };
}


function clientRoll_(r) {
  return {
    row: r.row,
    uid: r.uid,
    name: r.name,
    number: r.number,
    print: r.print,
    cut: r.cut,
    created: dateForClient_(r.created),
    updated: dateForClient_(r.updated),
    quantity: r.quantity,
    rollId: r.rollId,
    printDoneAt:
      dateForClient_(r.printDoneAt),
    employee: r.employee,
    area: r.area,
    kpiSync:
      dateForClient_(r.kpiSync)
  };
}


function rawSystemRows_() {
  setupSystemSheet_();

  var s = sys_();
  var last = s.getLastRow();

  if (last < 2) return [];

  var values = s
    .getRange(
      2,
      1,
      last - 1,
      C.SYS_COLS
    )
    .getValues();

  var rows = [];

  for (var i = 0; i < values.length; i++) {
    var r = rawRoll_(
      values[i],
      i + 2
    );

    if (r.uid && r.rollId) {
      rows.push(r);
    }
  }

  return rows;
}


function rowsRaw_(uid) {
  uid = String(uid);

  return rawSystemRows_()
    .filter(function(r) {
      return r.uid === uid;
    });
}


// ======================================================
// GROUPS
// ======================================================

function groupRows_(list) {
  var groups = {};
  var names = [];

  list.forEach(function(x) {
    if (!groups[x.name]) {
      groups[x.name] = {
        name: x.name,
        total: 0,
        print: 0,
        cut: 0,
        pieces: 0
      };

      names.push(x.name);
    }

    var g = groups[x.name];

    g.total++;
    g.pieces += x.quantity;

    if (x.print) g.print++;
    if (x.cut) g.cut++;
  });

  return names.map(function(name) {
    return groups[name];
  });
}


function getRolls(uid) {
  return groupRows_(
    rowsRaw_(uid)
  );
}


function getRollDetails(uid, name) {
  return rowsRaw_(uid)
    .filter(function(x) {
      return x.name === String(name);
    })
    .map(clientRoll_);
}


// ======================================================
// FIND ROLL
// ======================================================

function findRoll_(rollId) {
  rollId =
    String(rollId || '').trim();

  if (!rollId) {
    throw new Error(
      'Рулон не найден'
    );
  }

  var s = sys_();
  var last = s.getLastRow();

  if (last < 2) {
    throw new Error(
      'Рулон не найден'
    );
  }

  var cell = s
    .getRange(
      2,
      C.SYS_ROLL_ID,
      last - 1,
      1
    )
    .createTextFinder(rollId)
    .matchEntireCell(true)
    .findNext();

  if (!cell) {
    throw new Error(
      'Рулон больше не найден'
    );
  }

  var row = cell.getRow();

  return rawRoll_(
    s
      .getRange(
        row,
        1,
        1,
        C.SYS_COLS
      )
      .getValues()[0],
    row
  );
}


// ======================================================
// EMPLOYEE
// ======================================================

function employeeFromRollName_(name) {
  var n =
    String(name || '')
      .trim()
      .toLowerCase();

  if (!n) return '';

  var first = n.charAt(0);

  if (
    first === 'д' ||
    first === 'd'
  ) {
    return 'Дмитрий';
  }

  if (
    first === 'а' ||
    first === 'a'
  ) {
    return 'Андрей';
  }

  return '';
}


// ======================================================
// AREA
// ======================================================

function calculateRollArea_(order, quantity) {
  var totalArea =
    Number(order.totalArea);

  var orderQty =
    Number(order.orderQty);

  quantity =
    Number(quantity);

  if (
    !Number.isFinite(totalArea) ||
    totalArea <= 0
  ) {
    throw new Error(
      'Нет общей площади в J'
    );
  }

  if (
    !Number.isFinite(orderQty) ||
    orderQty <= 0
  ) {
    throw new Error(
      'Нет количества заказа в O'
    );
  }

  return roundArea_(
    totalArea /
    orderQty *
    quantity
  );
}


// ======================================================
// SELECTED ORDERS
// ======================================================

function getSelectedOrders() {
  return r2UpgradeLegacyPanel_();
  var ctx = rememberSelection_();
  var revision = getRollRevision_();

  if (
    !ctx ||
    !ctx.rows ||
    !ctx.rows.length
  ) {
    return {
      error:
        'Выберите одну или несколько строк заказа в листе',
      revision: revision
    };
  }

  var s = sheet_();
  var orders = [];

  ctx.rows.forEach(function(x) {
    var row = Number(x.row);

    if (row >= C.START) {
      var order =
        orderAtRow_(s, row);

      if (order) {
        orders.push(order);
      }
    }
  });

  if (!orders.length) {
    return {
      error:
        'В выбранных строках нет артикулов',
      revision: revision
    };
  }

  return {
    orders: orders,

    signature:
      orders
        .map(function(o) {
          return o.row + ':' + o.uid;
        })
        .join('|'),

    revision: revision
  };
}


// ======================================================
// KPI SPREADSHEET / LOG
// ======================================================

function kpiSpreadsheet_() {
  return SpreadsheetApp.openById(
    C.KPI_SPREADSHEET
  );
}


function ensureKpiLog_() {
  var ss = kpiSpreadsheet_();

  var s =
    ss.getSheetByName(
      C.KPI_LOG
    );

  if (!s) {
    s = ss.insertSheet(
      C.KPI_LOG
    );

    s.getRange(
      1,
      1,
      1,
      9
    ).setValues([[
      'ROLL_ID',
      'ORDER_UID',
      'ARTICLE',
      'DATE',
      'EMPLOYEE',
      'QUANTITY',
      'AREA',
      'UPDATED_AT',
      'SOURCE'
    ]]);

    s.hideSheet();
  }

  return s;
}


function rawKpiLogs_() {
  var s = ensureKpiLog_();
  var last = s.getLastRow();

  if (last < 2) return [];

  var values = s
    .getRange(
      2,
      1,
      last - 1,
      9
    )
    .getValues();

  var out = [];

  for (var i = 0; i < values.length; i++) {
    var id =
      String(values[i][0] || '').trim();

    if (!id) continue;

    out.push({
      row: i + 2,
      rollId: id,
      uid:
        String(values[i][1] || ''),
      article:
        String(values[i][2] || ''),
      date: values[i][3] || '',
      employee:
        String(values[i][4] || ''),
      quantity:
        Number(values[i][5]) || 0,
      area:
        Number(values[i][6]) || 0,
      updated:
        values[i][7] || '',
      source:
        String(values[i][8] || '')
    });
  }

  return out;
}


function kpiLogMap_() {
  var map = {};

  rawKpiLogs_().forEach(function(x) {
    map[x.rollId] = x;
  });

  return map;
}


function findKpiLogRow_(rollId) {
  var s = ensureKpiLog_();
  var last = s.getLastRow();

  if (last < 2) return null;

  var cell = s
    .getRange(
      2,
      1,
      last - 1,
      1
    )
    .createTextFinder(String(rollId))
    .matchEntireCell(true)
    .findNext();

  return cell
    ? cell.getRow()
    : null;
}


function hasKpiLog_(rollId) {
  return !!findKpiLogRow_(rollId);
}


// ======================================================
// GLOBAL KPI AUDIT
// ======================================================

function getKpiAudit_() {
  var source = rawSystemRows_();
  var logs = rawKpiLogs_();

  var logMap = {};
  var sourceMap = {};

  logs.forEach(function(x) {
    logMap[x.rollId] = x;
  });

  source.forEach(function(x) {
    sourceMap[x.rollId] = x;
  });

  var audit = {
    printed: 0,
    synced: 0,
    missing: 0,
    repair: 0,
    conflicts: 0,
    stale: 0,
    orphan: 0,
    errors: 0,

    missingAreaDmitry: 0,
    missingAreaAndrey: 0,

    missingItems: [],
    errorItems: []
  };

  var orderCache = {};

  source.forEach(function(roll) {
    var log =
      logMap[roll.rollId];

    // Есть KPI, хотя печать сейчас снята.
    if (!roll.print && log) {
      audit.stale++;
      return;
    }

    if (!roll.print) {
      return;
    }

    audit.printed++;

    // Журнал есть — KPI уже начислялся.
    if (log) {
      if (roll.kpiSync) {
        audit.synced++;
      } else {
        audit.repair++;
      }

      return;
    }

    // Метка есть, а записи в журнале нет.
    // Такое автоматически не трогаем.
    if (roll.kpiSync) {
      audit.conflicts++;
      return;
    }

    try {
      var order =
        orderCache[roll.uid];

      if (!order) {
        order =
          findOrder_(roll.uid);

        orderCache[roll.uid] =
          order;
      }

      var employee =
        employeeFromRollName_(
          roll.name
        );

      if (!employee) {
        throw new Error(
          'Рулон должен начинаться с Д или А'
        );
      }

      var area =
        calculateRollArea_(
          order,
          roll.quantity
        );

      audit.missing++;

      if (employee === 'Дмитрий') {
        audit.missingAreaDmitry += area;
      }

      if (employee === 'Андрей') {
        audit.missingAreaAndrey += area;
      }

      if (
        audit.missingItems.length < 30
      ) {
        audit.missingItems.push({
          rollId: roll.rollId,
          article: order.article,
          roll: roll.name,
          quantity: roll.quantity,
          employee: employee,
          area: roundArea_(area)
        });
      }

    } catch (err) {
      audit.errors++;

      if (
        audit.errorItems.length < 20
      ) {
        audit.errorItems.push({
          roll: roll.name,
          rollId: roll.rollId,
          error: err.message
        });
      }
    }
  });

  logs.forEach(function(log) {
    if (!sourceMap[log.rollId]) {
      audit.orphan++;
    }
  });

  audit.missingAreaDmitry =
    roundArea_(
      audit.missingAreaDmitry
    );

  audit.missingAreaAndrey =
    roundArea_(
      audit.missingAreaAndrey
    );

  audit.inLog =
    audit.synced +
    audit.repair;

  return audit;
}


function getKpiAudit() {
  return getKpiAudit_();
}


// ======================================================
// MASS KPI SYNC
// ======================================================

function syncAllMissingKpi() {
  return withDocumentLock_(function() {
    var source =
      rawSystemRows_();

    var logMap =
      kpiLogMap_();

    var added = 0;
    var repaired = 0;
    var skipped = 0;
    var errors = [];

    source.forEach(function(roll) {
      if (!roll.print) {
        return;
      }

      var log =
        logMap[roll.rollId];

      // Уже есть в журнале.
      // Если потерялась метка в source —
      // просто восстанавливаем метаданные.
      if (log) {
        if (!roll.kpiSync) {
          try {
            repairSourceFromLog_(
              roll,
              log
            );

            repaired++;

          } catch (err) {
            errors.push(
              roll.name +
              ': ' +
              err.message
            );
          }
        }

        return;
      }

      // KPI_SYNC есть, а журнал потерян.
      // Нельзя автоматически начислять:
      // возможен дубль.
      if (roll.kpiSync) {
        skipped++;
        return;
      }

      try {
        syncRollKpi_(
          roll.rollId
        );

        added++;

      } catch (err) {
        errors.push(
          roll.name +
          ': ' +
          err.message
        );
      }
    });

    touchRollRevision_();

    return {
      added: added,
      repaired: repaired,
      skipped: skipped,
      errors: errors,
      audit: getKpiAudit_()
    };
  });
}


function repairSourceFromLog_(
  roll,
  log
) {
  var s = sys_();

  var date =
    log.date instanceof Date
      ? log.date
      : new Date();

  if (!roll.printDoneAt) {
    s
      .getRange(
        roll.row,
        C.SYS_PRINT_DATE
      )
      .setValue(date);
  }

  s
    .getRange(
      roll.row,
      C.SYS_EMPLOYEE
    )
    .setValue(log.employee);

  s
    .getRange(
      roll.row,
      C.SYS_AREA
    )
    .setValue(log.area);

  s
    .getRange(
      roll.row,
      C.SYS_KPI_SYNC
    )
    .setValue(new Date());
}


// ======================================================
// SIDEBAR DATA
// ======================================================

function getSidebarData() {
  return r2UpgradeLegacyPanel_();
  var audit =
    getKpiAudit_();

  var result =
    getSelectedOrders();

  result.kpiAudit =
    audit;

  if (result.error) {
    return result;
  }

  var all =
    rawSystemRows_();

  var byUid = {};

  all.forEach(function(r) {
    if (!byUid[r.uid]) {
      byUid[r.uid] = [];
    }

    byUid[r.uid].push(r);
  });

  result.orders.forEach(function(order) {
    var list =
      byUid[order.uid] || [];

    var allocated = 0;
    var printedQty = 0;
    var cutQty = 0;
    var printDone = 0;
    var cutDone = 0;

    list.forEach(function(r) {
      allocated += r.quantity;

      if (r.print) {
        printDone++;
        printedQty += r.quantity;
      }

      if (r.cut) {
        cutDone++;
        cutQty += r.quantity;
      }
    });

    var total =
      list.length;

    order.groups =
      groupRows_(list);

    order.allocated =
      allocated;

    order.totalRolls =
      total;

    order.printDone =
      printDone;

    order.cutDone =
      cutDone;

    order.printedQty =
      printedQty;

    order.cutQty =
      cutQty;

    order.remaining =
      order.orderQty !== null
        ? order.orderQty - allocated
        : null;

    order.over =
      order.orderQty !== null &&
      allocated > order.orderQty
        ? allocated - order.orderQty
        : 0;

    order.print =
      total > 0 &&
      printDone === total &&
      order.orderQty !== null &&
      printedQty >= order.orderQty
        ? 'Готов'
        : 'В работе';

    order.cut =
      total > 0 &&
      cutDone === total &&
      order.orderQty !== null &&
      cutQty >= order.orderQty
        ? 'Готов'
        : 'В работе';
  });

  return result;
}


function refreshSidebarData() {
  return r2UpgradeLegacyPanel_();
  saveSelection_(
    SpreadsheetApp.getActiveRange()
  );

  return getSidebarData();
}


function refreshOrderContext() {
  return refreshSidebarData();
}


function getSelectedOrder() {
  var result =
    getSelectedOrders();

  if (result.error) {
    return result;
  }

  return result.orders[0];
}


// ======================================================
// ADD ROLL
// ======================================================

function saveRollFor(
  uid,
  name,
  pieces,
  count
) {
  return withDocumentLock_(function() {
    setupSystemSheet_();

    var order =
      findOrder_(uid);

    name =
      String(name || '').trim();

    pieces =
      Number(pieces);

    count =
      Number(count);

    if (!name) {
      throw new Error(
        'Введите номер или название рулона'
      );
    }

    if (
      !Number.isInteger(pieces) ||
      pieces < 1
    ) {
      throw new Error(
        'Количество штук должно быть целым'
      );
    }

    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 500
    ) {
      throw new Error(
        'Проверьте количество рулонов'
      );
    }

    var old =
      rowsRaw_(uid);

    var next =
      old.reduce(
        function(max, x) {
          return Math.max(
            max,
            x.number
          );
        },
        0
      ) + 1;

    var now =
      new Date();

    var values = [];

    for (var i = 0; i < count; i++) {
      values.push([
        order.uid,
        name,
        next + i,
        false,
        false,
        now,
        now,
        pieces,
        Utilities.getUuid(),
        '',
        '',
        '',
        ''
      ]);
    }

    var db = sys_();

    db.getRange(
      db.getLastRow() + 1,
      1,
      values.length,
      C.SYS_COLS
    ).setValues(values);

    refreshRollCell_(uid);
    refresh_(uid);
    touchRollRevision_();

    return getRolls(uid);
  });
}


function saveRoll(
  name,
  pieces,
  count
) {
  var o =
    getSelectedOrder();

  if (o.error) {
    throw new Error(o.error);
  }

  return saveRollFor(
    o.uid,
    name,
    pieces,
    count
  );
}


// ======================================================
// RENAME
// ======================================================

function renameRollGroup(
  uid,
  oldName,
  newName
) {
  return withDocumentLock_(function() {
    oldName =
      String(oldName || '').trim();

    newName =
      String(newName || '').trim();

    if (!newName) {
      throw new Error(
        'Введите новый номер рулона'
      );
    }

    var list =
      rowsRaw_(uid)
        .filter(function(x) {
          return x.name === oldName;
        });

    if (!list.length) {
      throw new Error(
        'Рулон не найден'
      );
    }

    var s = sys_();
    var now = new Date();

    list.forEach(function(x) {
      s
        .getRange(
          x.row,
          C.SYS_NAME
        )
        .setValue(newName);

      s
        .getRange(
          x.row,
          C.SYS_UPDATED
        )
        .setValue(now);

      if (
        x.print &&
        hasKpiLog_(x.rollId)
      ) {
        syncRollKpi_(
          x.rollId
        );
      }
    });

    refreshRollCell_(uid);
    refresh_(uid);
    touchRollRevision_();

    return getRolls(uid);
  });
}


// ======================================================
// UPDATE ROLL NUMBER
// ======================================================

function updateRollNumber(
  rollId,
  number
) {
  return withDocumentLock_(function() {
    number = Number(number);

    if (
      !Number.isInteger(number) ||
      number < 1
    ) {
      throw new Error(
        'Номер должен быть целым числом больше нуля'
      );
    }

    var roll =
      findRoll_(rollId);

    var duplicate =
      rowsRaw_(roll.uid)
        .some(function(x) {
          return (
            x.rollId !== roll.rollId &&
            x.number === number
          );
        });

    if (duplicate) {
      throw new Error(
        'У заказа уже есть рулон № ' +
        number
      );
    }

    var s = sys_();

    s
      .getRange(
        roll.row,
        C.SYS_NUMBER
      )
      .setValue(number);

    s
      .getRange(
        roll.row,
        C.SYS_UPDATED
      )
      .setValue(new Date());

    touchRollRevision_();

    return true;
  });
}


// ======================================================
// UPDATE QUANTITY
// ======================================================

function updateRollQuantity(
  rollId,
  quantity
) {
  return withDocumentLock_(function() {
    quantity =
      Number(quantity);

    if (
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      throw new Error(
        'Количество должно быть целым числом больше нуля'
      );
    }

    var roll =
      findRoll_(rollId);

    var s = sys_();

    s
      .getRange(
        roll.row,
        C.SYS_QUANTITY
      )
      .setValue(quantity);

    s
      .getRange(
        roll.row,
        C.SYS_UPDATED
      )
      .setValue(new Date());

    // Если KPI уже реально есть в журнале —
    // пересчитываем его.
    if (
      roll.print &&
      hasKpiLog_(rollId)
    ) {
      syncRollKpi_(rollId);
    }

    refreshRollCell_(roll.uid);
    refresh_(roll.uid);
    touchRollRevision_();

    return true;
  });
}


// ======================================================
// DELETE ROLL
// ======================================================

function deleteRoll(rollId) {
  return withDocumentLock_(function() {
    var roll = findRoll_(rollId);

    // Если площадь уже начислена, сначала корректно снимаем KPI.
    if (roll.print) {
      syncRollKpiRemoval_(rollId);
    }

    var uid = roll.uid;
    sys_().deleteRow(roll.row);

    refreshRollCell_(uid);
    refresh_(uid);
    touchRollRevision_();

    return true;
  });
}


// ======================================================
// UPDATE STATUS
// ======================================================

function updateRoll(
  rollId,
  print,
  cut
) {
  return withDocumentLock_(function() {
    var roll =
      findRoll_(rollId);

    var s = sys_();

    if (
      print !== null &&
      print !== undefined
    ) {
      var newPrint =
        !!print;

      // FALSE -> TRUE
      if (
        !roll.print &&
        newPrint
      ) {
        var order =
          findOrder_(roll.uid);

        var employee =
          employeeFromRollName_(
            roll.name
          );

        if (!employee) {
          throw new Error(
            'Название рулона должно начинаться с Д или А'
          );
        }

        calculateRollArea_(
          order,
          roll.quantity
        );

        s
          .getRange(
            roll.row,
            C.SYS_PRINT
          )
          .setValue(true);

        s
          .getRange(
            roll.row,
            C.SYS_PRINT_DATE
          )
          .setValue(new Date());

        try {
          syncRollKpi_(rollId);

        } catch (err) {
          s
            .getRange(
              roll.row,
              C.SYS_PRINT
            )
            .setValue(false);

          s
            .getRange(
              roll.row,
              C.SYS_PRINT_DATE,
              1,
              4
            )
            .clearContent();

          throw err;
        }
      }

      // TRUE -> FALSE
      else if (
        roll.print &&
        !newPrint
      ) {
        // Журнал — источник истины.
        // Если записи нет, функция просто ничего не вычтет.
        syncRollKpiRemoval_(
          rollId
        );

        s
          .getRange(
            roll.row,
            C.SYS_PRINT
          )
          .setValue(false);

        s
          .getRange(
            roll.row,
            C.SYS_PRINT_DATE,
            1,
            4
          )
          .clearContent();
      }
    }

    if (
      cut !== null &&
      cut !== undefined
    ) {
      s
        .getRange(
          roll.row,
          C.SYS_CUT
        )
        .setValue(!!cut);
    }

    s
      .getRange(
        roll.row,
        C.SYS_UPDATED
      )
      .setValue(new Date());

    refresh_(roll.uid);
    touchRollRevision_();

    return true;
  });
}


// ======================================================
// KPI SYNC ONE ROLL
// ======================================================

function syncRollKpi_(rollId) {
  var roll =
    findRoll_(rollId);

  if (!roll.print) {
    throw new Error(
      'Рулон не отмечен напечатанным'
    );
  }

  var order =
    findOrder_(roll.uid);

  var employee =
    employeeFromRollName_(
      roll.name
    );

  if (!employee) {
    throw new Error(
      'Название рулона должно начинаться с Д или А'
    );
  }

  var area =
    calculateRollArea_(
      order,
      roll.quantity
    );

  var printDate;

  if (roll.printDoneAt instanceof Date) {
    printDate =
      roll.printDoneAt;

  } else if (roll.updated instanceof Date) {
    printDate =
      roll.updated;

  } else {
    printDate =
      new Date();
  }

  var log =
    ensureKpiLog_();

  var logRow =
    findKpiLogRow_(rollId);

  // Если запись уже существует —
  // сначала снимаем старое значение.
  if (logRow) {
    var old =
      log
        .getRange(
          logRow,
          1,
          1,
          9
        )
        .getValues()[0];

    var oldDate =
      old[3];

    var oldEmployee =
      String(old[4] || '');

    var oldArea =
      Number(old[6]) || 0;

    if (
      oldDate &&
      oldEmployee &&
      oldArea
    ) {
      applyKpiDelta_(
        oldDate,
        oldEmployee,
        -oldArea
      );
    }

  } else {
    logRow =
      log.getLastRow() + 1;
  }

  log
    .getRange(
      logRow,
      1,
      1,
      9
    )
    .setValues([[
      rollId,
      roll.uid,
      order.article,
      printDate,
      employee,
      roll.quantity,
      area,
      new Date(),
      C.SHEET
    ]]);

  applyKpiDelta_(
    printDate,
    employee,
    area
  );
    syncCompletedPrintToJournal_(roll, order, employee, printDate, area);

  var s = sys_();

  s
    .getRange(
      roll.row,
      C.SYS_PRINT_DATE
    )
    .setValue(printDate);

  s
    .getRange(
      roll.row,
      C.SYS_EMPLOYEE
    )
    .setValue(employee);

  s
    .getRange(
      roll.row,
      C.SYS_AREA
    )
    .setValue(area);

  s
    .getRange(
      roll.row,
      C.SYS_KPI_SYNC
    )
    .setValue(new Date());
}


// ======================================================
// KPI REMOVE
// ======================================================

function syncRollKpiRemoval_(
  rollId
) {
    removeCompletedPrintFromJournal_(rollId);
var log =
    ensureKpiLog_();

  var row =
    findKpiLogRow_(rollId);

  if (!row) {
    return;
  }

  var old =
    log
      .getRange(
        row,
        1,
        1,
        9
      )
      .getValues()[0];

  var date = old[3];

  var employee =
    String(old[4] || '');

  var area =
    Number(old[6]) || 0;

  if (
    date &&
    employee &&
    area
  ) {
    applyKpiDelta_(
      date,
      employee,
      -area
    );
  }

  log.deleteRow(row);
}


// ======================================================
// APPLY KPI DELTA
// ======================================================

function applyKpiDelta_(
  date,
  employee,
  delta
) {
  if (!(date instanceof Date)) {
    date = new Date(date);
  }

  delta =
    Number(delta) || 0;

  if (!delta) return;

  var ss =
    kpiSpreadsheet_();

  var sheet =
    ss.getSheetByName(
      C.KPI_SHEET
    );

  if (!sheet) {
    throw new Error(
      'Не найден лист KPI'
    );
  }

  var day =
    Number(
      Utilities.formatDate(
        date,
        C.TIMEZONE,
        'd'
      )
    );

  var row;

  if (employee === 'Дмитрий') {
    row = 11;

  } else if (
    employee === 'Андрей'
  ) {
    row = 12;

  } else {
    throw new Error(
      'Неизвестный сотрудник: ' +
      employee
    );
  }

  var col =
    day + 1;

  var employeeCell =
    sheet.getRange(
      row,
      col
    );

  var teamCell =
    sheet.getRange(
      13,
      col
    );

  var employeeOld =
    Number(
      employeeCell.getValue()
    ) || 0;

  var teamOld =
    Number(
      teamCell.getValue()
    ) || 0;

  var employeeNew =
    Math.max(
      0,
      employeeOld + delta
    );

  var teamNew =
    Math.max(
      0,
      teamOld + delta
    );

  employeeCell
    .setValue(
      roundArea_(
        employeeNew
      )
    )
    .setNumberFormat('0.00');

  teamCell
    .setValue(
      roundArea_(
        teamNew
      )
    )
    .setNumberFormat('0.00');

  updateKpiSystemDay_(
    date,
    employee,
    employeeNew,
    teamNew
  );
}


// ======================================================
// KPI SYS
// ======================================================

function updateKpiSystemDay_(
  date,
  employee,
  employeeValue,
  teamValue
) {
  var ss =
    kpiSpreadsheet_();

  var s =
    ss.getSheetByName(
      C.KPI_SYS
    );

  if (!s) return;

  var key =
    Utilities.formatDate(
      date,
      C.TIMEZONE,
      'dd.MM'
    );

  var last =
    s.getLastRow();

  var row = null;

  if (last >= 2) {
    var dates =
      s
        .getRange(
          2,
          1,
          last - 1,
          1
        )
        .getDisplayValues();

    for (
      var i = 0;
      i < dates.length;
      i++
    ) {
      if (
        String(dates[i][0]) === key
      ) {
        row = i + 2;
        break;
      }
    }
  }

  if (!row) {
    row =
      Math.max(2, last + 1);

    s
      .getRange(row, 1)
      .setValue(date)
      .setNumberFormat('dd.MM');
  }

  if (employee === 'Дмитрий') {
    s
      .getRange(row, 2)
      .setValue(employeeValue);
  }

  if (employee === 'Андрей') {
    s
      .getRange(row, 3)
      .setValue(employeeValue);
  }

  s
    .getRange(row, 4)
    .setValue(teamValue);
}


// ======================================================
// COMPLETE GROUP / ORDER
// ======================================================

function completeRollGroup(
  uid,
  name,
  stage
) {
  if (
    stage !== 'print' &&
    stage !== 'cut'
  ) {
    throw new Error(
      'Неизвестный этап'
    );
  }

  var list =
    rowsRaw_(uid)
      .filter(function(x) {
        return x.name === name;
      });

  if (!list.length) {
    throw new Error(
      'Рулон не найден'
    );
  }

  list.forEach(function(x) {
    if (
      stage === 'print' &&
      !x.print
    ) {
      updateRoll(
        x.rollId,
        true,
        null
      );
    }

    if (
      stage === 'cut' &&
      !x.cut
    ) {
      updateRoll(
        x.rollId,
        null,
        true
      );
    }
  });

  return true;
}


function completeOrder(
  uid,
  stage
) {
  if (
    stage !== 'print' &&
    stage !== 'cut'
  ) {
    throw new Error(
      'Неизвестный этап'
    );
  }

  var list =
    rowsRaw_(uid);

  if (!list.length) {
    throw new Error(
      'Сначала добавьте рулоны'
    );
  }

  list.forEach(function(x) {
    if (
      stage === 'print' &&
      !x.print
    ) {
      updateRoll(
        x.rollId,
        true,
        null
      );
    }

    if (
      stage === 'cut' &&
      !x.cut
    ) {
      updateRoll(
        x.rollId,
        null,
        true
      );
    }
  });

  return true;
}


// ======================================================
// COLUMN Z
// ======================================================

function refreshRollCell_(uid) {
  var list =
    rowsRaw_(uid);

  var groups = {};
  var names = [];

  list.forEach(function(x) {
    var name =
      String(x.name || '').trim();

    if (!name) return;

    if (
      !Object.prototype
        .hasOwnProperty
        .call(groups, name)
    ) {
      groups[name] = 0;
      names.push(name);
    }

    groups[name] +=
      Number(x.quantity) || 0;
  });

  var lines =
    names.map(function(name) {
      return (
        name +
        ' - ' +
        formatQty_(groups[name])
      );
    });

  var order =
    findOrder_(uid);

  sheet_()
    .getRange(
      order.row,
      C.ROLL
    )
    .setValue(
      lines.join('\n')
    )
    .setWrap(true)
    .setVerticalAlignment('middle');
}


// ======================================================
// Q / R / U / V / W
// ======================================================

function refresh_(uid) {
  var list =
    rowsRaw_(uid);

  var order =
    findOrder_(uid);

  var totalRolls =
    list.length;

  var printDone = 0;
  var cutDone = 0;

  var printedQty = 0;
  var cutQty = 0;

  list.forEach(function(x) {
    if (x.print) {
      printDone++;
      printedQty +=
        Number(x.quantity) || 0;
    }

    if (x.cut) {
      cutDone++;
      cutQty +=
        Number(x.quantity) || 0;
    }
  });

  var orderQty =
    Number(order.orderQty) || 0;

  var printReady =
    totalRolls > 0 &&
    printDone === totalRolls &&
    printedQty >= orderQty;

  var cutReady =
    totalRolls > 0 &&
    cutDone === totalRolls &&
    cutQty >= orderQty;

  var s = sheet_();

  s
    .getRange(
      order.row,
      C.PRINT
    )
    .clearDataValidations()
    .setNumberFormat('@')
    .setValue(
      printDone +
      ' из ' +
      totalRolls
    )
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  s
    .getRange(
      order.row,
      C.CUT
    )
    .clearDataValidations()
    .setNumberFormat('@')
    .setValue(
      cutDone +
      ' из ' +
      totalRolls
    )
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  var differenceText = '';

  if (orderQty > 0) {
    if (printedQty < orderQty) {
      differenceText =
        'Осталось - ' +
        formatQty_(
          orderQty - printedQty
        );

    } else if (
      printedQty > orderQty
    ) {
      differenceText =
        'Лишнее - ' +
        formatQty_(
          printedQty - orderQty
        );

    } else {
      differenceText =
        'Готово';
    }
  }

  s
    .getRange(
      order.row,
      C.DIFFERENCE
    )
    .setValue(differenceText)
    .setWrap(true)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  var printDate =
    s.getRange(
      order.row,
      C.PRINT_DATE
    );

  if (printReady) {
    if (!printDate.getValue()) {
      printDate.setValue(
        new Date()
      );
    }
  } else {
    printDate.clearContent();
  }

  var cutDate =
    s.getRange(
      order.row,
      C.CUT_DATE
    );

  if (cutReady) {
    if (!cutDate.getValue()) {
      cutDate.setValue(
        new Date()
      );
    }
  } else {
    cutDate.clearContent();
  }
}


// ======================================================
// REFRESH ALL
// ======================================================

function refreshAllRollOrders() {
  return r2RefreshAllVisibleProgress();
  setupSystemSheet_();

  var all =
    rawSystemRows_();

  var seen = {};

  all.forEach(function(x) {
    if (seen[x.uid]) return;

    seen[x.uid] = true;

    try {
      refreshRollCell_(x.uid);
      refresh_(x.uid);

    } catch (err) {
      Logger.log(
        x.uid +
        ': ' +
        err.message
      );
    }
  });

  SpreadsheetApp.getActive().toast(
    'Статусы рулонов обновлены'
  );
}
