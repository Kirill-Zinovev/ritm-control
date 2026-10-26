import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const code = readFileSync(
  new URL('../apps-script/assembly/Code.gs', import.meta.url),
  'utf8',
);
const html = readFileSync(
  new URL('../apps-script/assembly/Index.html', import.meta.url),
  'utf8',
);

function transferEvent(f, department = 'roll', sheetId = 100, selected = [0]) {
  const source = f.api.readRitmTransferSource_(department, sheetId);
  const parts = source.manifest ? source.manifest.parts.map(part => {
    const actual = f.api.readRitmTransferSource_(part.department, part.sheetId);
    return { department: part.department, sheetId: part.sheetId, fingerprint: actual.fingerprint };
  }) : [{ department, sheetId, fingerprint: source.fingerprint }];
  const event = { v: 1, eventId: randomUUID(), action: 'transfer', issuedAt: Date.now(), transfer: {
    department, sheetId, name: source.name, fingerprint: source.fingerprint,
    keys: selected.map(index => f.api.ritmTransferRowKey_(source.rows[index])), parts,
  } };
  const secret = 'ab'.repeat(32);
  f.api.configureRitmEventSync(secret);
  return { event, signature: createHmac('sha256', secret).update(JSON.stringify(event)).digest('hex') };
}

test('explicit roll transfer imports selected rows only, preserves identities and work, and deduplicates retries', () => {
  const f = fixture();
  f.add('Other source must not transfer', 101, [['OTHER', 90, 'other']]);
  const first = transferEvent(f);
  const result = f.api.receiveRitmAssemblyEvent_(first);
  assert.equal(result.status, 'synced', JSON.stringify(result));
  assert.equal(result.added, 1);
  assert.equal(f.db.getSheetByName('Other source must not transfer'), null);
  let data = f.api.getInitialData('RITM-ROLL-100');
  assert.equal(data.items.length, 1);
  const position = data.items[0].positionId;
  appendPacking(f, data.items[0], 3, 'transfer-work-kept');
  const work = JSON.stringify(f.db.getSheetByName('WorkLog').rows);
  assert.equal(f.api.receiveRitmAssemblyEvent_(first).added, 1, 'same event returns its original receipt');
  const again = f.api.receiveRitmAssemblyEvent_(transferEvent(f));
  assert.equal(again.added, 0); assert.equal(again.existing, 1);
  f.api.syncRitmSupplies(true);
  data = f.api.getInitialData('RITM-ROLL-100');
  assert.equal(data.items.length, 1, 'background reconciliation cannot expand the explicit selection');
  assert.equal(data.items[0].positionId, position);
  assert.equal(JSON.stringify(f.db.getSheetByName('WorkLog').rows), work);
  const expanded = f.api.receiveRitmAssemblyEvent_(transferEvent(f, 'roll', 100, [1]));
  assert.equal(expanded.added, 1);
  assert.equal(f.api.getInitialData('RITM-ROLL-100').items.length, 2);
  assert.equal(f.print.writes, 0);
});

test('explicit box transfer writes only Assembly, survives reconciliation and keeps independent same-name identity', () => {
  const f = fixture();
  f.api.syncRitmSupplies(true);
  const box = orderSheet(f.print.name, 700, [['KNOWN', 25, 'box-1'], ['UNKNOWN', 12, 'box-2']]);
  f.boxSource.sheets.push(box);
  const result = f.api.receiveRitmAssemblyEvent_(transferEvent(f, 'box', 700));
  assert.equal(result.status, 'synced', JSON.stringify(result));
  assert.match(result.name, /Бокс/);
  let data = f.api.getInitialData('RITM-BOX-700');
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].positionId, 'RITM-BOX-700|box:700|uid:box-1|KNOWN');
  f.api.syncRitmSupplies(true);
  data = f.api.getInitialData('RITM-BOX-700');
  assert.equal(data.items.length, 1);
  assert.equal(data.shipment.sourceAvailable, true);
  assert.equal(box.writes, 0); assert.equal(f.print.writes, 0);
});

test('a stale explicit transfer is terminal without writes; offline and busy delivery remain retryable', () => {
  const f = fixture(), request = transferEvent(f);
  f.print.rows[4][14] = 101;
  const before = JSON.stringify(f.db.sheets.map(sheet => sheet.rows));
  assert.equal(f.api.receiveRitmAssemblyEvent_(request).status, 'conflict');
  assert.equal(JSON.stringify(f.db.sheets.map(sheet => sheet.rows)), before);
  const fresh = transferEvent(f);
  f.locked(true); assert.equal(f.api.receiveRitmAssemblyEvent_(fresh).status, 'pending'); f.locked(false);
  f.offline(ids.printing); assert.equal(f.api.receiveRitmAssemblyEvent_(fresh).status, 'pending'); f.offline('');
  assert.equal(f.api.receiveRitmAssemblyEvent_(fresh).status, 'synced');
});

test('linked transfer keeps the full common supply and rejects a subset without rewriting production', () => {
  const f = linkedDepartmentFixture();
  assert.equal(f.api.receiveRitmAssemblyEvent_(transferEvent(f)).status, 'conflict');
  const body = transferEvent(f, 'roll', 100, [0, 1]);
  const result = f.api.receiveRitmAssemblyEvent_(body);
  assert.equal(result.status, 'synced', JSON.stringify(result));
  assert.equal(f.api.getInitialData(f.shipmentId).items.length, 3);
  assert.equal(f.box.writes, 0); assert.equal(f.print.writes, 0);
});
const ids = {
  printing: 'PUBLIC_TEST_SHEET_ID_0014',
  catalog: 'PUBLIC_TEST_SHEET_ID_0013',
  photos: 'PUBLIC_TEST_SHEET_ID_0011',
  assembly: 'PUBLIC_TEST_SHEET_ID_0012',
};

class Sheet {
  constructor(name, rows = [], id = 1, writable = false) {
    Object.assign(this, {
      name,
      rows: structuredClone(rows),
      id,
      writable,
      formulas: {},
      notes: {},
      writes: 0,
      maxRows: 1000,
      maxCols: 32,
      hidden: false,
      rangeReads: 0,
      textFinderSearches: 0,
      metadataReads: 0,
    });
  }
  getName() {
    return this.name;
  }
  getSheetId() {
    return this.id;
  }
  getDeveloperMetadata() {
    this.metadataReads++;
    return this.manifest ? [{ getKey: () => 'RITM_SUPPLY', getValue: () => JSON.stringify(this.manifest) }] : [];
  }
  isSheetHidden() {
    return this.hidden;
  }
  getLastRow() {
    return this.rows.length;
  }
  getLastColumn() {
    return Math.max(0, ...this.rows.map((r) => r.length));
  }
  getMaxRows() {
    return this.maxRows;
  }
  getMaxColumns() {
    return this.maxCols;
  }
  mutation() {
    assert.ok(
      this.writable,
      'production printing/catalog must never be written',
    );
    this.writes++;
  }
  setName(name) {
    this.mutation();
    this.name = name;
    return this;
  }
  setFrozenRows() {
    this.mutation();
    return this;
  }
  setColumnWidth() {
    this.mutation();
    return this;
  }
  insertRowsAfter(_, count) {
    this.mutation();
    this.maxRows += count;
  }
  insertColumnsAfter(_, count) {
    this.mutation();
    this.maxCols += count;
  }
  insertColumnAfter() {
    this.mutation();
    this.maxCols += 1;
  }
  getDataRange() {
    return this.getRange(1, 1, this.getLastRow(), this.getLastColumn());
  }
  getRange(row, col, height = 1, width = 1) {
    const sheet = this;
    sheet.rangeReads += 1;
    const range = {
      getValues() {
        return Array.from({ length: height }, (_, r) =>
          Array.from(
            { length: width },
            (_, c) => sheet.rows[row - 1 + r]?.[col - 1 + c] ?? '',
          ),
        );
      },
      getDisplayValues() {
        return this.getValues().map((r) => r.map(String));
      },
      createTextFinder(needle) {
        let exact = false;
        let caseSensitive = true;
        const matches = () => {
          const found = [];
          for (let r = 0; r < height; r += 1) {
            for (let c = 0; c < width; c += 1) {
              const value = sheet.rows[row - 1 + r]?.[col - 1 + c] ?? '';
              const left = caseSensitive ? String(value) : String(value).toLocaleLowerCase('ru-RU');
              const right = caseSensitive ? String(needle) : String(needle).toLocaleLowerCase('ru-RU');
              if (exact ? left === right : left.includes(right)) found.push({ getRow: () => row + r });
            }
          }
          return found;
        };
        return {
          matchEntireCell(value) {
            exact = value;
            return this;
          },
          matchCase(value) {
            caseSensitive = value;
            return this;
          },
          findAll() {
            sheet.textFinderSearches += 1;
            return matches();
          },
          findNext() {
            sheet.textFinderSearches += 1;
            return matches()[0] || null;
          },
        };
      },
      setValues(values) {
        sheet.mutation();
        values.forEach((r, i) =>
          r.forEach((v, c) => {
            delete sheet.formulas[(row + i) + ':' + (col + c)];
            sheet.rows[row - 1 + i] ||= [];
            sheet.rows[row - 1 + i][col - 1 + c] =
              typeof v === 'string' && v.startsWith("'=") ? v.slice(1) : v;
          }),
        );
        return this;
      },
      setValue(value) {
        return this.setValues([[value]]);
      },
      clearContent() {
        return this.setValues(
          Array.from({ length: height }, () => Array(width).fill('')),
        );
      },
      getNote() {
        return sheet.notes[row + ':' + col] || '';
      },
      setNote(value) {
        sheet.mutation();
        sheet.notes[row + ':' + col] = value;
        return this;
      },
      setFormula(value) {
        sheet.mutation();
        sheet.formulas[row + ':' + col] = value;
        return this;
      },
      getFormula() {
        return sheet.formulas[row + ':' + col] || '';
      },
    };
    for (const key of ['setBackground', 'setFontColor', 'setFontWeight'])
      range[key] = function () {
        sheet.mutation();
        return this;
      };
    return range;
  }
}

function orderSheet(name, id, lines) {
  const header = Array(29).fill('');
  header[4] = 'Артикул';
  header[14] = 'Кол-во';
  const rows = [
    [],
    [],
    [],
    header,
    ...lines.map(([sku, quantity, uid]) => {
      const row = Array(29).fill('');
      row[4] = sku;
      row[14] = quantity;
      row[28] = uid;
      return row;
    }),
  ];
  return new Sheet(name, rows, id);
}

function fixture() {
  const props = new Map([
    ["RITM_ASSEMBLY_DB_ID", ids.assembly],
    ["RITM_LABEL_FBO_ID", ids.catalog],
    ["RITM_LABEL_OZON_CODES_ID", ids.catalog],
    ["RITM_ROLL_PRINTING_ID", ids.printing],
    ["RITM_BOX_PRINTING_ID", "PUBLIC_TEST_SHEET_ID_0015"],
    ["RITM_CATALOG_ID", ids.catalog],
    ["RITM_PHOTOS_ID", ids.photos],
  ]);
  const cacheValues = new Map();
  const cacheReads = { single: 0, batch: 0 };
  const properties = {
    getProperty: (key) => props.get(key) ?? null,
    setProperty: (key, value) => props.set(key, value),
    deleteProperty: (key) => props.delete(key),
    getProperties: () => Object.fromEntries(props),
  };
  let locked = false,
    assertUnlockedReads = false,
    offline = '',
    actor = 'zinovevkirill234@gmail.com',
    catalogOpenCount = 0;
  const triggers = [];
  const print = orderSheet('OZON МОСКВА', 100, [
    ['KNOWN', 100, 'a'],
    ['UNKNOWN', 40, 'b'],
    ['', '#N/A', ''],
  ]);
  const catalog = [
    new Sheet('OZON', [
      ['Артикул', '', 'Наименование', 'Баркод', 'Вид', 'Кол-во листов', 'Размер', 'Упаковка', 'Вид товара', 'Папка печати', 'Тип короба', 'Кол-во вида', 'В коробке', 'фото', 'Магазин'],
      ['KNOWN(OZ)', 'KNOWN', 'Реальное название', 'barcode', 'Наклейки А4 3-4 листа', 3, '', '', 'Наклейки', '', 'M', 100, '100 M', '', '01'],
    ]),
    new Sheet('WB', [
      ['Артикул', 'Артикул (oz)', 'Баркод', 'Баркод (OZ)', 'Название', 'Вид', 'Вид товара', 'Папка печати', 'Кто печатает', 'Кол-во листов', 'Размер', 'Упаковка', 'Вид станка по умолчанию', 'Тип короба', 'Кол-во вида', 'В коробке', 'Кратность рулонная', 'Кратность Xerox', 'фото', 'Магазин'],
      ['KNOWN', 'KNOWN(OZ)', 'barcode', 'OZ barcode', 'Другое название', 'Наклейки А4 3-4 листа', 'Наклейки', '', '', 3, '', '', '', 'M', 100, '100 M', '', '', '', '01'],
    ]),
    new Sheet('магазин', [
      ['Артикул', 'магазин'],
      ['KNOWN', '01'],
      ['KNOWN(OZ)', '01'],
    ]),
  ];
  const photoLinks = new Sheet('Ссылки', [
    ['Артикул', 'ссылка'],
    ['KNOWN', 'https://basket-33.wbbasket.ru/vol6814/part681428/681428847/images/big/1.webp'],
    ['UNKNOWN', 'https://example.com/tracker.png'],
  ]);
  const db = {
    sheets: [
      new Sheet(
        'Shipments',
        [
          ['shipmentId', 'Название поставки', 'directionId', 'Направление'],
          ['DEMO', 'Поставка тест', 'MSK', 'Москва'],
        ],
        1,
        true,
      ),
      new Sheet(
        'Items',
        [
          ['shipmentId', 'directionId', 'positionId', 'Артикул'],
          ['DEMO', 'MSK', 'demo-pos', 'DEMO-SKU'],
        ],
        2,
        true,
      ),
      new Sheet(
        'Employees',
        [
          ['employeeId', 'Имя', 'Активен'],
          ['emp', 'ОляЖ 2', true],
        ],
        3,
        true,
      ),
      new Sheet(
        'OperationNorms',
        [['positionId', 'operationId', 'Норма, шт/чел']],
        4,
        true,
      ),
      new Sheet(
        'WorkLog',
        [
          [
            'eventId',
            'createdAt',
            'shipmentId',
            'directionId',
            'Направление',
            'positionId',
            'Артикул',
            'employeeId',
            'Сотрудник',
            'operationId',
            'Операция',
            'Количество, шт',
            'Норма, шт/чел',
            'Коэффициент',
            'Источник',
            'idempotencyKey',
          ],
        ],
        5,
        true,
      ),
      new Sheet(
        'Photos',
        [['photoAssetKey', 'mimeType', 'base64Data']],
        6,
        true,
      ),
      new Sheet(
        'Cartons',
        [[
          'cartonId',
          'directionId',
          'Направление',
          'Номер',
          'Подтверждённая вместимость, шт',
          'Занято, шт',
          'Статус',
          'createdAt',
          'closedAt',
          'source',
        ]],
        7,
        true,
      ),
      new Sheet(
        'CartonContents',
        [[
          'allocationId',
          'cartonId',
          'shipmentId',
          'directionId',
          'positionId',
          'Артикул',
          'Количество, шт',
          'createdAt',
          'eventId',
        ]],
        8,
        true,
      ),
    ],
    getSheets() {
      return this.sheets;
    },
    getSheetById(id) {
      return this.sheets.find((s) => s.id === id) || null;
    },
    getSheetByName(name) {
      return this.sheets.find((s) => s.name === name) || null;
    },
    insertSheet(name) {
      assert.ok(!this.getSheetByName(name));
      const sheet = new Sheet(name, [], this.sheets.length + 1000, true);
      this.sheets.push(sheet);
      return sheet;
    },
  };
  const source = {
    sheets: [print],
    getSheetById(id) { return this.sheets.find(sheet => sheet.id === id) || null; },
    getSheets() {
      return this.sheets;
    },
  };
  const boxSource = { sheets: [], getSheets() { return this.sheets; }, getSheetById(id) { return this.sheets.find(sheet => sheet.id === id) || null; } };
  const sandbox = {
    console,
    Date,
    SpreadsheetApp: {
      openById(id) {
        if (assertUnlockedReads)
          assert.equal(
            locked,
            false,
            'bulk Sheets reads must not hold the shared script lock',
          );
        if (id === offline) throw new Error('Network unavailable');
        if (id === ids.assembly) return db;
        if (id === ids.printing) return source;
        if (id === 'PUBLIC_TEST_SHEET_ID_0015') return boxSource;
        if (id === ids.catalog) {
          catalogOpenCount += 1;
          return {
            getSheetByName: (name) => catalog.find((s) => s.name === name),
          };
        }
        if (id === ids.photos)
          return { getSheetByName: (name) => name === 'Ссылки' ? photoLinks : null };
        throw new Error('Unexpected document: ' + id);
      },
      flush() {},
    },
    PropertiesService: { getScriptProperties: () => properties },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => { cacheReads.single++; return cacheValues.get(key) || null; },
        getAll: (keys) => { cacheReads.batch++; return Object.fromEntries(keys.filter(key => cacheValues.has(key)).map(key => [key, cacheValues.get(key)])); },
        put: (key, value) => cacheValues.set(key, value),
        putAll: (values) => Object.entries(values).forEach(([key, value]) => cacheValues.set(key, value)),
        remove: (key) => cacheValues.delete(key),
        removeAll: (keys) => keys.forEach(key => cacheValues.delete(key)),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() {
          if (locked) return false;
          locked = true;
          return true;
        },
        waitLock() {
          assert.ok(!locked);
          locked = true;
        },
        releaseLock() {
          locked = false;
        },
      }),
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => actor }),
      getEffectiveUser: () => ({
        getEmail: () => 'zinovevkirill234@gmail.com',
      }),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      newTrigger(name) {
        return {
          timeBased() {
            return this;
          },
          everyMinutes(n) {
            assert.equal(n, 1);
            return this;
          },
          create() {
            triggers.push({ getHandlerFunction: () => name });
          },
        };
      },
      deleteTrigger(t) {
        triggers.splice(triggers.indexOf(t), 1);
      },
    },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      formatDate: (date, zone, pattern) => {
        assert.equal(pattern, 'yyyy-MM-dd');
        return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(date);
      },
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_, text) => createHash('sha256').update(text).digest(),
      computeHmacSha256Signature: (text, key) => Array.from(createHmac('sha256', key).update(text).digest()),
      base64EncodeWebSafe: (data) => Buffer.from(data).toString('base64url'),
      getUuid: randomUUID,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return {
    api: sandbox,
    db,
    source,
    boxSource,
    print,
    catalog,
    cacheReads,
    catalogOpenCount: () => catalogOpenCount,
    photoLinks,
    props,
    triggers,
    offline(id) {
      offline = id;
    },
    locked(value) {
      locked = value;
    },
    actor(value) {
      actor = value;
    },
    assertUnlockedReads(value) {
      assertUnlockedReads = value;
    },
    add(name, id, lines) {
      const sheet = orderSheet(name, id, lines);
      source.sheets.push(sheet);
      return sheet;
    },
  };
}

test('label lookup recognizes marketplace only from the shipment and normalizes marketplace suffixes safely', () => {
  const api = fixture().api;
  assert.equal(api.labelMarketplace_('', 'OZON Москва 10_10'), 'OZON');
  assert.equal(api.labelMarketplace_('', 'WB КАЗАНЬ 09_10'), 'WB');
  assert.equal(api.labelMarketplace_('', 'WB/OZON поставка'), '');
  assert.equal(api.labelMarketplace_('', 'Поставка WBX'), '');
  assert.equal(api.labelMarketplace_('OZON', 'WB поставка'), 'WB');
  assert.equal(api.labelMarketplace_('WB', 'OZON Москва'), 'OZON');
  assert.equal(api.labelMarketplace_('', 'вб Казань'), 'WB');
  assert.equal(api.labelMarketplace_('', 'ОЗОН Москва'), 'OZON');
  assert.equal(api.labelMarketplace_('OZON', 'OZON / WB'), '');
  assert.equal(api.normalizeLabelArticle_(' JA0037.A0225(OZ) ', 'OZON'), 'JA0037.A0225');
  assert.equal(api.normalizeLabelArticle_('JA0037.A0225(OZ)', 'WB'), 'JA0037.A0225(OZ)');
});

test('manual refresh invalidates only the selected marketplace label index', () => {
  const f = fixture();
  const cache = f.api.CacheService.getScriptCache();
  cache.put('ritm.assembly.labels.v1.OZON.manifest', '2');
  cache.put('ritm.assembly.labels.v1.OZON.0', 'stale-ozon-1');
  cache.put('ritm.assembly.labels.v1.OZON.1', 'stale-ozon-2');
  cache.put('ritm.assembly.labels.v1.WB.manifest', '1');
  cache.put('ritm.assembly.labels.v1.WB.0', 'current-wb');
  f.api.getInitialData(undefined, true);
  assert.equal(cache.get('ritm.assembly.labels.v1.OZON.manifest'), null);
  assert.equal(cache.get('ritm.assembly.labels.v1.OZON.0'), null);
  assert.equal(cache.get('ritm.assembly.labels.v1.OZON.1'), null);
  assert.equal(cache.get('ritm.assembly.labels.v1.WB.manifest'), '1');
  assert.equal(cache.get('ritm.assembly.labels.v1.WB.0'), 'current-wb');
});

function linkedDepartmentFixture() {
  const f = fixture();
  const shipmentId = 'RITM-SUPPLY-11111111-1111-4111-8111-111111111111';
  const name = 'OZON Общая поставка';
  f.print.setName = () => { throw new Error('Source must stay read-only'); };
  f.print.name = name;
  const box = orderSheet(name, 700, [['BOX-SKU', 25, 'box-uid']]);
  const manifest = { version: 1, id: shipmentId, name, revision: 'revision-1', ready: true, parts: [
    { department: 'roll', documentId: ids.printing, sheetId: f.print.id },
    { department: 'box', documentId: 'PUBLIC_TEST_SHEET_ID_0015', sheetId: box.id },
  ] };
  f.print.manifest = structuredClone(manifest); box.manifest = structuredClone(manifest);
  f.boxSource.sheets.push(box);
  return { ...f, box, manifest, shipmentId };
}

test('department jobs become one selectable Assembly supply with all actual positions and source namespaces', () => {
  const f = linkedDepartmentFixture();
  const result = f.api.syncRitmSupplies(true);
  assert.equal(result.status, 'current', JSON.stringify(result));
  const data = f.api.getInitialData(f.shipmentId);
  assert.equal(data.shipments.length, 1);
  assert.equal(data.items.length, 3);
  assert.deepEqual(Array.from(data.items, item => item.sku), ['KNOWN', 'UNKNOWN', 'BOX-SKU']);
  assert.equal(data.items[2].operations.packing.plan, 25);
  assert.match(data.items[2].positionId, /\|box:700\|uid:box-uid\|BOX-SKU$/);
  assert.equal(f.print.writes, 0);
  assert.equal(f.box.writes, 0);
  assert.equal(f.db.getSheetByName('WorkLog').writes, 0);
});

test('new department supplies sync before legacy refreshes and roll metadata is read only once', () => {
  const f = linkedDepartmentFixture();
  f.add('OZON Старая поставка', 222, [['KNOWN', 1, 'legacy-uid']]);
  const report = f.api.syncRitmSupplies(true);
  assert.equal(report.status, 'current', JSON.stringify(report));
  assert.equal(report.created[0], f.manifest.name);
  assert.equal(f.print.metadataReads, 1);
  assert.equal(f.source.sheets[1].metadataReads, 1);
});

test('147 sparse product norms use a single cache batch and bounded catalog reads', () => {
  const f = fixture();
  const sheet = f.catalog[0], header = sheet.rows[0];
  sheet.rows = [header];
  const skus = Array.from({ length: 147 }, (_, i) => 'PERF-' + i);
  skus.forEach(sku => {
    sheet.rows.push(...Array.from({ length: 4 }, () => Array(header.length).fill('')));
    const row = Array(header.length).fill('');
    row[0] = sku + '(OZ)'; row[1] = sku; row[10] = 'M'; row[11] = 100; row[12] = '100 M';
    sheet.rows.push(row);
  });
  const resolved = f.api.boxNormsForSkus_(skus, false, 'OZON');
  assert.ok(skus.every(sku => resolved[sku].confirmed && resolved[sku].unitsPerBox === 100));
  assert.equal(f.cacheReads.single, 0);
  assert.equal(f.cacheReads.batch, 1);
  assert.ok(f.catalog.reduce((sum, tab) => sum + tab.rangeReads, 0) <= 6);
  const readsBefore = f.catalog.reduce((sum, tab) => sum + tab.rangeReads, 0);
  f.api.boxNormsForSkus_(skus, false, 'OZON');
  assert.equal(f.cacheReads.batch, 2);
  assert.equal(f.catalog.reduce((sum, tab) => sum + tab.rangeReads, 0), readsBefore);
  sheet.rows[5][11] = 50; sheet.rows[5][12] = '50 M';
  assert.equal(f.api.boxNormsForSkus_([skus[0]], true, 'OZON')[skus[0]].unitsPerBox, 50, 'placement preflight bypasses display caches');
});

test('initial Assembly screen does not wait for the marketplace label index', () => {
  const f = linkedDepartmentFixture();
  f.api.syncRitmSupplies(true);
  f.api.labelAvailabilityForShipment_ = () => {
    throw new Error('label index must be checked only when a worker opens label printing');
  };
  const data = f.api.getInitialData(f.shipmentId);
  assert.equal(data.shipment.labelSourceStatus, 'not_checked');
  assert.ok(data.items.every(item => item.label.status === 'not_checked'));
});

test('fast Assembly preview reads the local composition without loading work or catalog sources', () => {
  const f = linkedDepartmentFixture();
  f.api.syncRitmSupplies(true);
  for (const name of ['boxNormsForSkus_', 'readShiftNorms_', 'readWorkSnapshot_']) {
    f.api[name] = () => { throw new Error(`${name} must run after the first paint`); };
  }
  const preview = f.api.getAssemblyPreview(f.shipmentId);
  assert.equal(preview.referenceIncomplete, true);
  assert.equal(preview.items.length, 3);
  assert.equal(preview.items[0].operations.packing.fact, null);
  assert.equal(preview.items[0].workFactsAvailable, false);
  assert.equal(preview.items[0].status, 'Проверяем…');
  assert.equal(preview.items[0].sku, 'KNOWN');
});

test('indexed WorkLog reads merge nearby matches while returning only exact matches', () => {
  const f = fixture();
  const sheet = new Sheet('Indexed fixture', [['shipmentId', 'createdAt', 'value']]);
  for (let index = 0; index < 240; index += 1) {
    sheet.rows.push([index % 10 === 0 ? 'target' : 'other', `2026-10-20T10:${String(index % 60).padStart(2, '0')}:00Z`, index]);
  }
  const headers = sheet.rows[0];
  sheet.rangeReads = 0;
  const records = f.api.readIndexedRows_(sheet, ['shipmentId', 'createdAt'], row => row.shipmentId === 'target', headers, 20);
  assert.equal(records.length, 24);
  assert.ok(records.every(row => row.shipmentId === 'target'));
  assert.ok(sheet.rangeReads <= 2, `expected one index read and one merged block, got ${sheet.rangeReads}`);
});

test('partial department commit and an unavailable box preserve the previous complete Assembly composition', () => {
  const f = linkedDepartmentFixture();
  f.api.syncRitmSupplies(true);
  const target = f.db.getSheetByName(f.manifest.name);
  const before = structuredClone(target.rows);
  f.print.manifest.ready = false;
  const pending = f.api.syncRitmSupplies(true);
  assert.equal(pending.status, 'partial');
  assert.deepEqual(target.rows, before);
  f.print.manifest.ready = true;
  f.offline('PUBLIC_TEST_SHEET_ID_0015');
  assert.equal(f.api.syncRitmSupplies(true).status, 'partial');
  assert.deepEqual(target.rows, before);
});

test('adopting a legacy roll supply into a common supply preserves its saved WorkLog position identity', () => {
  const f = fixture(); f.api.syncRitmSupplies(true);
  const before = f.api.getInitialData('RITM-ROLL-100').items[0].positionId;
  const box = orderSheet(f.print.name, 700, [['BOX-SKU', 25, 'box-uid']]);
  const manifest = { version: 1, id: 'RITM-ROLL-100', name: f.print.name, revision: 'revision-1', ready: true, parts: [
    { department: 'roll', documentId: ids.printing, sheetId: 100 },
    { department: 'box', documentId: 'PUBLIC_TEST_SHEET_ID_0015', sheetId: 700 },
  ] };
  f.print.manifest = manifest; box.manifest = structuredClone(manifest); f.boxSource.sheets.push(box);
  assert.equal(f.api.syncRitmSupplies(true).status, 'current');
  const data = f.api.getInitialData('RITM-ROLL-100');
  assert.equal(data.items[0].positionId, before);
  assert.equal(data.items.length, 3);
});

test('label index accepts only Google Drive file URLs and detects distinct-file conflicts', () => {
  const api = fixture().api;
  assert.equal(api.driveImageId_('https://drive.google.com/open?id=1Abcdefghij_123'), '1Abcdefghij_123');
  assert.equal(api.driveImageId_('https://drive.google.com/file/d/1Abcdefghij_123/view'), '1Abcdefghij_123');
  assert.equal(api.driveImageId_('https://evil.example/open?id=1Abcdefghij_123'), '');
  const index = Object.create(null);
  api.addLabelCandidate_(index, 'JA0037.A0225(OZ)', 'https://drive.google.com/open?id=1Abcdefghij_123', 'OZON');
  api.addLabelCandidate_(index, 'JA0037.A0225', 'https://drive.google.com/file/d/1Abcdefghij_123/view', 'OZON');
  assert.deepEqual(JSON.parse(JSON.stringify(index['JA0037.A0225'])), { fileId: '1Abcdefghij_123', conflict: false });
  api.addLabelCandidate_(index, 'JA0037.A0225', 'https://drive.google.com/open?id=1DifferentFile_123', 'OZON');
  assert.equal(index['JA0037.A0225'].conflict, true);
});

function appendPacking(f, item, quantity, eventId = 'pack-' + Math.random().toString(36).slice(2)) {
  const sheet = f.db.getSheetByName('WorkLog');
  const record = {
    eventId, createdAt: '2026-10-16T07:00:00.000Z', shipmentId: item.shipmentId,
    directionId: item.directionId, 'Направление': item.direction || 'Москва',
    positionId: item.positionId, 'Артикул': item.sku, employeeId: 'emp',
    'Сотрудник': 'ОляЖ 2', operationId: 'packing', 'Операция': 'Упаковка',
    'Количество, шт': quantity, 'Норма, шт/чел': '', 'Коэффициент': '',
    'Источник': 'WEB_APP_RITM', idempotencyKey: 'work-' + eventId,
  };
  sheet.rows.push(sheet.rows[0].map((header) => record[header] ?? ''));
}

function appendWorkEvent(f, item, overrides = {}) {
  const sheet = f.db.getSheetByName('WorkLog');
  const record = {
    eventId: 'work-' + randomUUID(),
    createdAt: new Date().toISOString(),
    shipmentId: item.shipmentId,
    directionId: item.directionId,
    'Направление': item.direction || 'Москва',
    positionId: item.positionId,
    'Артикул': item.sku,
    employeeId: 'emp',
    'Сотрудник': 'ОляЖ 2',
    operationId: 'packing',
    'Операция': 'Упаковка',
    'Количество, шт': 20,
    'Норма, шт/чел': 200,
    'Коэффициент': 0.1,
    'Источник': 'WEB_APP_RITM',
    idempotencyKey: 'work-key-' + randomUUID().replaceAll('-', ''),
    ...overrides,
  };
  sheet.rows.push(sheet.rows[0].map((header) => record[header] ?? ''));
  return record;
}

function seedCarton(f, shipment, number, options = {}) {
  const sheet = f.db.getSheetByName('Cartons');
  const record = {
    cartonId: options.cartonId || 'carton-' + number,
    shipmentId: options.shipmentId ?? shipment.id,
    directionId: shipment.directionId,
    'Направление': shipment.direction || shipment.name,
    'Номер': number,
    'Подтверждённая вместимость, шт': options.legacyCapacity ?? 1,
    'Занято, шт': options.occupied ?? 0,
    'Статус': options.status || 'Открыт',
    createdAt: '2026-10-01T00:00:00.000Z',
    closedAt: options.closedAt || '',
    source: 'TEST_FIXTURE',
    'Тип короба': options.boxType || '',
  };
  sheet.rows.push(sheet.rows[0].map((header) => record[header] ?? ''));
  return record;
}

function seedAllocation(f, shipment, item, cartonId, quantity, allocationId = randomUUID()) {
  const sheet = f.db.getSheetByName('CartonContents');
  const record = {
    allocationId, cartonId, shipmentId: shipment.id, directionId: shipment.directionId,
    positionId: item.positionId, 'Артикул': item.sku, 'Количество, шт': quantity,
    createdAt: '2026-10-16T07:01:00.000Z', eventId: 'allocation-event-' + allocationId,
  };
  sheet.rows.push(sheet.rows[0].map((header) => record[header] ?? ''));
  return record;
}

function addCatalogNorm(f, sku, boxType, unitsPerBox) {
  const sheet = f.catalog[0];
  sheet.rows.push([sku + '(OZ)', sku, 'Название ' + sku, 'barcode', 'Наклейки А4 3-4 листа', 1, '', '', 'Наклейки', '', boxType, unitsPerBox, unitsPerBox + ' ' + boxType, '', '1']);
}

function placementPayload(item, options = {}) {
  return {
    mode: options.mode || 'existing', shipmentId: item.shipmentId, directionId: item.directionId,
    positionId: item.positionId, cartonId: options.cartonId || '', quantity: options.quantity || 1,
    idempotencyKey: options.idempotencyKey || 'placement-key-' + randomUUID().replaceAll('-', ''),
  };
}

function previewAndSave(api, payload) {
  const preview = api.previewBoxPlacement(payload);
  return { preview, result: api.saveBoxPlacement({ ...payload, previewId: preview.previewId }) };
}

test('RITM-created print tab produces a same-name assembly tab and selectable actual articles', () => {
  const f = fixture();
  const protectedBefore = f.db.sheets
    .slice(0, 6)
    .map((s) => JSON.stringify(s.rows));
  const r = f.api.syncRitmSupplies(true);
  assert.deepEqual(Array.from(r.created), ['OZON МОСКВА']);
  f.add('OZON Новая поставка', 200, [['SECOND', 55, 'new-uid']]);
  f.api.syncRitmSupplies(true);
  const data = f.api.getInitialData('RITM-ROLL-200');
  assert.equal(data.shipment.name, 'OZON Новая поставка');
  assert.equal(data.items[0].sku, 'SECOND');
  assert.equal(data.items[0].operations.packing.plan, 55);
  assert.ok(f.db.getSheetByName('OZON Новая поставка'));
  assert.equal(
    data.shipments.filter((s) => s.environment === 'RITM').length,
    2,
  );
  assert.deepEqual(
    f.db.sheets.slice(0, 6).map((s) => JSON.stringify(s.rows)),
    protectedBefore,
  );
  assert.equal(f.print.writes, 0);
  assert.ok(f.catalog.every((s) => s.writes === 0));
});

test('each RITM shipment gets an auto-updating four-column box view filtered by stable shipment ID', () => {
  const f = fixture();
  f.api.syncRitmSupplies(true);
  const first = f.db.getSheetByName('Короба · OZON МОСКВА');
  assert.ok(first);
  assert.deepEqual(first.rows[0], ['Номер короба', 'Поставка', 'Артикул', 'Количество']);
  assert.equal(first.getRange(1, 1).getNote(), 'RITM_ASSEMBLY_BOX_VIEW_V1:RITM-ROLL-100');
  const firstFormula = first.getRange(2, 1).getFormula();
  assert.match(firstFormula, /CartonContents!C2:C/);
  assert.match(firstFormula, /Col5 = 'RITM-ROLL-100'/);
  assert.match(firstFormula, /sum\(Col4\)/);

  f.add('OZON Новая поставка', 200, [['SECOND', 55, 'new-uid']]);
  f.api.syncRitmSupplies(true);
  const second = f.db.getSheetByName('Короба · OZON Новая поставка');
  assert.ok(second);
  assert.match(second.getRange(2, 1).getFormula(), /Col5 = 'RITM-ROLL-200'/);
  assert.doesNotMatch(second.getRange(2, 1).getFormula(), /RITM-ROLL-100/);
  assert.equal(f.db.getSheetByName('CartonContents').rows.length, 1, 'view setup does not add carton events');
});

test('box-view backfill is owner-only and idempotently repairs formula views', () => {
  const f = fixture();
  f.api.syncRitmSupplies(true);
  const view = f.db.getSheetByName('Короба · OZON МОСКВА');
  view.getRange(2, 1).setFormula('=1');
  f.actor('stranger@example.com');
  assert.throws(() => f.api.buildShipmentBoxViews(), /владельцу/);
  f.actor('zinovevkirill234@gmail.com');
  const firstRun = f.api.buildShipmentBoxViews();
  assert.equal(firstRun.length, 1);
  assert.equal(firstRun[0].created, false);
  assert.match(view.getRange(2, 1).getFormula(), /RITM-ROLL-100/);
  const secondRun = f.api.buildShipmentBoxViews();
  assert.equal(secondRun.length, 1);
  assert.equal(f.db.sheets.filter((sheet) => sheet.name.startsWith('Короба · ')).length, 1);
});

test('a renamed RITM shipment keeps one stable box-view tab and updates its label', () => {
  const f = fixture();
  f.api.syncRitmSupplies(true);
  const original = f.db.getSheetByName('Короба · OZON МОСКВА');
  assert.ok(original);
  f.print.name = 'OZON Москва — новое название';
  f.api.syncRitmSupplies(true);
  const renamed = f.db.getSheetByName('Короба · OZON Москва — новое название');
  assert.equal(renamed?.getSheetId(), original.getSheetId());
  assert.equal(f.db.sheets.filter((sheet) => sheet.name.startsWith('Короба · ')).length, 1);
  assert.match(renamed.getRange(2, 1).getFormula(), /RITM-ROLL-100/);
});

test('a same-name user tab is preserved and the generated box view receives a stable suffix', () => {
  const f = fixture();
  const userSheet = f.db.insertSheet('Короба · OZON МОСКВА');
  userSheet.getRange(1, 1).setValues([['Содержимое пользователя']]);
  f.api.syncRitmSupplies(true);
  const generated = f.db.getSheetByName('Короба · OZON МОСКВА · ROLL-100');
  assert.ok(generated);
  assert.equal(userSheet.rows[0][0], 'Содержимое пользователя');
  assert.match(generated.getRange(2, 1).getFormula(), /RITM-ROLL-100/);
});

test('catalog aliases enrich articles; missing catalog values never suppress an article or invent norms/boxes', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  assert.equal(data.items.length, 2);
  assert.equal(data.items[0].productName, 'Реальное название');
  assert.equal(data.items[0].boxType, 'M');
  assert.equal(data.items[0].unitsPerBox, 100);
  assert.deepEqual(Array.from(data.items[0].storeNumbers), ['01']);
  assert.equal(data.items[1].sku, 'UNKNOWN');
  assert.deepEqual(Array.from(data.items[1].storeNumbers), []);
  assert.equal(data.items[1].productName, '');
  assert.equal(data.items[1].boxType, '');
  assert.equal(data.items[1].unitsPerBox, null);
  assert.equal(data.items[0].operations.cut.normPerPerson, null);
  assert.equal(data.items[0].boxCountSnapshot, null);
  assert.equal(data.items[0].operations.cut.fact, 0, 'a valid empty WorkLog is a confirmed zero in the app');
});

test('store numbers are cached for display and a forced refresh reads current catalog values', () => {
  const f = fixture();
  assert.deepEqual(Array.from(f.api.getInitialData().items[0].storeNumbers), ['01']);
  f.catalog[0].rows[1][14] = '002';
  assert.deepEqual(Array.from(f.api.getInitialData().items[0].storeNumbers), ['01'], 'ordinary snapshots reuse the short display cache');
  assert.deepEqual(Array.from(f.api.getInitialData(undefined, true).items[0].storeNumbers), ['002'], 'manual refresh bypasses the store cache');
  assert.ok(f.catalog.every(sheet => sheet.writes === 0), 'catalog lookups never write to source sheets');
});

test('store assignments read the lowercase final column on the owning marketplace tab', () => {
  const f = fixture();
  f.catalog[0].rows[0][14] = 'магазин';
  f.catalog[0].rows[1][14] = '1';
  f.catalog[1].rows[1][19] = '9';
  const staleDedicatedSheet = f.catalog.find(sheet => sheet.name === 'магазин');
  staleDedicatedSheet.rows.push(['KNOWN', '9']);
  for (const sku of ['LT0001.A5427', 'JA0037.A0225', 'NT0006.A4692', 'KS0002.A7665']) {
    const row = Array(15).fill('');
    row[0] = sku + '(OZ)';
    row[1] = sku;
    row[14] = '1';
    f.catalog[0].rows.push(row);
  }
  const data = f.api.getInitialData();
  assert.deepEqual(Array.from(data.items[0].storeNumbers), ['1']);
  assert.equal(data.items[1].storeNumbers.length, 0);
  const actualScreenshotSkus = f.api.storeNumbersForItems_(
    ['LT0001.A5427', 'JA0037.A0225', 'NT0006.A4692', 'KS0002.A7665'].map(sku => ({ sku, source: 'OZON' })),
    true,
  );
  for (const sku of ['LT0001.A5427', 'JA0037.A0225', 'NT0006.A4692', 'KS0002.A7665'])
    assert.deepEqual(Array.from(actualScreenshotSkus['OZON|' + sku]), ['1']);
});

test('current OZON and WB tabs restore article aliases, details, box norms and photos', () => {
  const f = fixture();
  const catalog = f.api.readRitmCatalog_();
  for (const alias of ['KNOWN', 'KNOWN(OZ)']) {
    const product = catalog.get('OZON|' + alias);
    assert.equal(product.name, 'Реальное название');
    assert.equal(product.type, 'Наклейки А4 3-4 листа');
    assert.equal(product.sheetsPerUnit, 3);
    assert.equal(product.photoUrl, 'https://basket-33.wbbasket.ru/vol6814/part681428/681428847/images/big/1.webp');
    assert.equal(product.source, 'OZON');
  }
  const norm = f.api.boxNormsForSkus_(['KNOWN'], true, 'OZON').KNOWN;
  assert.deepEqual([norm.confirmed, norm.boxType, norm.unitsPerBox], [true, 'M', 100]);
  assert.match(norm.source, /БАЗА FBO · OZON · строка 2/);
  assert.ok(f.catalog.every((sheet) => sheet.writes === 0));
});

test('initial shipment snapshot exposes only confirmed box types and leaves conflicting norms unknown', () => {
  const f = fixture();
  addCatalogNorm(f, 'KNOWN', 'L', 50);
  const data = f.api.getInitialData();
  const known = data.items.find((item) => item.sku === 'KNOWN');
  const unknown = data.items.find((item) => item.sku === 'UNKNOWN');
  assert.equal(known.boxType, '', 'conflicting catalog values must not select a type for display');
  assert.equal(known.unitsPerBox, null);
  assert.match(known.boxNormError, /расходятся тип короба или количество/);
  assert.equal(unknown.boxType, '');
  assert.equal(unknown.unitsPerBox, null);
});

test('a known carton type remains visible when catalog capacity fields disagree, without allowing placement', () => {
  const f = fixture();
  for (const sheet of f.catalog) {
    const headers = sheet.rows[0];
    sheet.rows[1][headers.indexOf('Тип короба')] = 'М';
    sheet.rows[1][headers.indexOf('Кол-во вида')] = 255;
    sheet.rows[1][headers.indexOf('В коробке')] = '156 М';
  }
  const data = f.api.getInitialData();
  const item = data.items.find(entry => entry.sku === 'KNOWN');
  assert.equal(item.boxType, 'М');
  assert.equal(item.unitsPerBox, null);
  assert.match(item.boxNormError, /расходятся «Кол-во вида» и «В коробке»/);
  appendPacking(f, item, 20, 'type-known-capacity-conflict');
  const overview = f.api.getBoxesForItem(item.shipmentId, item.directionId, item.positionId);
  assert.equal(overview.item.boxType, 'М');
  assert.equal(overview.item.unitsPerBox, null);
  assert.match(overview.item.normError, /расходятся/);
  assert.throws(() => f.api.previewBoxPlacement(placementPayload(item, { mode: 'new' })), /расходятся/);
  for (const sheet of f.catalog) sheet.rows[1][sheet.rows[0].indexOf('В коробке')] = '255 М';
  const corrected = f.api.getInitialData().items.find(entry => entry.sku === 'KNOWN');
  assert.equal(corrected.boxType, 'М');
  assert.equal(corrected.unitsPerBox, 255, 'a corrected catalog norm is picked up on the next full read');
  assert.equal(corrected.boxNormError, '');
  assert.ok(f.catalog.every(sheet => sheet.writes === 0));
});

test('capacity disagreement between catalog rows preserves a shared type but conflicting types remain unknown', () => {
  const f = fixture();
  addCatalogNorm(f, 'KNOWN', 'M', 50);
  const norm = f.api.boxNormsForSkus_(['KNOWN'], true, 'OZON').KNOWN;
  assert.equal(norm.confirmed, false);
  assert.equal(norm.boxType, 'M');
  assert.equal(norm.unitsPerBox, undefined);
  const conflicting = f.api.boxPackNormFromCatalogRow_({ 'Тип короба': 'M', 'В коробке': '100 L' }, 'WB', 2);
  assert.equal(conflicting.confirmed, false);
  assert.ok(!conflicting.boxType);
});

test('RITM operations show station cutting, hand cutting and packing; an empty valid WorkLog gives a full remaining plan', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items.find((entry) => entry.sku === 'KNOWN');
  assert.deepEqual(Array.from(data.operations, (operation) => operation.name), [
    'Резка на станке',
    'Ручная резка',
    'Упаковка',
  ]);
  assert.equal(item.operations.cut.plan, 100);
  assert.equal(item.operations.cut.fact, 0);
  assert.equal(item.operations.assembly.plan, 100);
  assert.equal(item.operations.assembly.fact, 0);
  assert.equal(item.operations.packing.plan, 100);
  assert.equal(item.operations.packing.fact, 0);
});

test('WorkLog facts always appear in the team, resolve blank labels by employeeId, and keep unlinked employees separate', () => {
  const f = fixture();
  const item = f.api.getInitialData().items[0];
  appendWorkEvent(f, item, { eventId: 'blank-label-event', 'Сотрудник': '', 'Количество, шт': 17 });
  appendWorkEvent(f, item, { eventId: 'no-employee-id-event', employeeId: '', 'Сотрудник': 'ОляЖ 2', 'Количество, шт': 4 });
  appendWorkEvent(f, item, { eventId: 'employee-outside-entry-roster', employeeId: 'emp-016', 'Сотрудник': 'Алексей', 'Количество, шт': 9 });

  const data = f.api.getInitialData(item.shipmentId);
  const result = data.items.find((row) => row.positionId === item.positionId);
  assert.equal(result.operations.packing.fact, 30);
  assert.equal(result.workers.length, 3, 'all recorded employees remain visible, even when they are not in the new-entry roster');
  const identified = result.workers.find((worker) => worker.employeeId === 'emp');
  assert.equal(identified.name, 'ОляЖ 2', 'blank WorkLog labels resolve through the Employees ID map');
  assert.equal(identified.operations.packing.quantity, 17);
  assert.equal(result.workers.find((worker) => !worker.employeeId).name, 'ОляЖ 2 · ID не указан');
  assert.equal(result.workers.find((worker) => worker.employeeId === 'emp-016').operations.packing.quantity, 9);
  assert.equal(result.workRecords.length, 3);
});

test('cancelling app work keeps WorkLog immutable, removes its fact from progress and records an idempotent audit trail', () => {
  const f = fixture();
  const item = f.api.getInitialData().items[0];
  const event = appendWorkEvent(f, item, { eventId: 'cancel-me', 'Количество, шт': 24, 'Коэффициент': 0.12 });
  const workLog = f.db.getSheetByName('WorkLog');
  const workLogTextFindersBefore = workLog.textFinderSearches;
  const workLogBefore = JSON.stringify(workLog.rows);
  const before = f.api.getInitialData(item.shipmentId).items.find((row) => row.positionId === item.positionId);
  assert.equal(before.operations.packing.fact, 24);

  const cancelled = f.api.cancelWork(event.eventId, 'Выбран неправильный сотрудник');
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.alreadyCancelled, false);
  assert.equal(workLog.textFinderSearches - workLogTextFindersBefore, 1, 'cancellation locates one event with a targeted Sheets search');
  assert.equal(JSON.stringify(workLog.rows), workLogBefore, 'original work facts are never edited or deleted');
  const corrections = f.db.getSheetByName('WorkLogCorrections');
  assert.equal(corrections.rows.length, 2);
  assert.equal(corrections.rows[1][1], event.eventId);
  assert.equal(corrections.rows[1][2], 'CANCEL');
  assert.equal(corrections.rows[1][4], 'zinovevkirill234@gmail.com');

  const afterData = f.api.getInitialData(item.shipmentId);
  const after = afterData.items.find((row) => row.positionId === item.positionId);
  assert.equal(after.operations.packing.fact, 0);
  assert.equal(after.workers.length, 0);
  assert.equal(after.workRecords.length, 1);
  assert.equal(after.workRecords[0].cancelled, true);
  assert.equal(afterData.employeeShift.employees.emp, undefined, 'cancelled events leave shift coefficients too');

  const repeated = f.api.cancelWork(event.eventId, 'Повторный запрос');
  assert.equal(repeated.alreadyCancelled, true);
  assert.equal(corrections.rows.length, 2, 'retries do not append duplicate cancellations');
  assert.equal(JSON.stringify(workLog.rows), workLogBefore);
});

test('explicit shipment refresh bypasses stale carton capacity and refreshes the display cache', () => {
  const f = fixture();
  const initial = f.api.getInitialData();
  assert.equal(initial.items.find(item => item.sku === 'KNOWN').unitsPerBox, 100);
  for (const sheet of f.catalog) {
    const headers = sheet.rows[0];
    sheet.rows[1][headers.indexOf('Кол-во вида')] = 300;
    sheet.rows[1][headers.indexOf('В коробке')] = '300 M';
  }
  const refreshed = f.api.getInitialData(initial.shipment.id, true);
  assert.equal(refreshed.items.find(item => item.sku === 'KNOWN').unitsPerBox, 300);
  assert.equal(f.api.getInitialData(initial.shipment.id).items.find(item => item.sku === 'KNOWN').unitsPerBox, 300);
  assert.ok(f.catalog.every(sheet => sheet.writes === 0));
});

test('box norms resolve multiple SKUs with one catalog open and cache only confirmed values', () => {
  const f = fixture();
  addCatalogNorm(f, 'BATCH-1', 'M', 80);
  addCatalogNorm(f, 'BATCH-2', 'L', 40);
  const rangeReadsBefore = f.catalog.reduce((sum, sheet) => sum + sheet.rangeReads, 0);
  const textSearchesBefore = f.catalog.reduce((sum, sheet) => sum + sheet.textFinderSearches, 0);

  const norms = f.api.boxNormsForSkus_(['KNOWN', 'BATCH-1', 'BATCH-2'], true, 'OZON');

  assert.equal(f.catalogOpenCount(), 1, 'a mixed-carton lookup opens the catalog once, not once per SKU');
  assert.equal(f.catalog.reduce((sum, sheet) => sum + sheet.textFinderSearches, 0) - textSearchesBefore, 0);
  assert.ok(f.catalog.reduce((sum, sheet) => sum + sheet.rangeReads, 0) - rangeReadsBefore <= 6);
  assert.deepEqual(
    ['KNOWN', 'BATCH-1', 'BATCH-2'].map(sku => [norms[sku].confirmed, norms[sku].boxType, norms[sku].unitsPerBox]),
    [[true, 'M', 100], [true, 'M', 80], [true, 'L', 40]],
  );

  const opensAfterFreshRead = f.catalogOpenCount();
  f.api.boxNormsForSkus_(['KNOWN', 'BATCH-1', 'BATCH-2'], false, 'OZON');
  assert.equal(f.catalogOpenCount(), opensAfterFreshRead, 'confirmed catalog norms are served from the short-lived cache');
});

test('carton overview reports only confirmed packed facts and orders cartons containing the selected article first', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const unknownItem = data.items[1];
  const unknownBox = seedCarton(f, data.shipment, '1мск211', { cartonId: 'known-box' });
  const emptyBox = seedCarton(f, data.shipment, '1мск212', { cartonId: 'empty-box' });
  appendPacking(f, item, 100);
  seedAllocation(f, data.shipment, item, unknownBox.cartonId, 40, 'alloc-known-001');
  assert.equal(unknownItem.sku, 'UNKNOWN');

  const result = f.api.getBoxesForItem(item.shipmentId, item.directionId, item.positionId);
  assert.equal(result.item.plan, 100);
  assert.equal(result.item.packedKnown, true);
  assert.equal(result.item.packed, 100);
  assert.equal(result.assigned, 40);
  assert.equal(result.available, 60);
  assert.equal(result.boxes[0].cartonId, 'known-box');
  assert.equal(result.boxes[0].itemQuantity, 40);
  assert.equal(result.boxes[1].cartonId, 'empty-box');
  assert.equal(result.boxes[1].itemQuantity, 0);
  assert.equal(result.itemBoxes.length, 1);
});

test('initial shipment snapshot includes article quantities and confirmed physical carton fill', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const carton = seedCarton(f, data.shipment, '1мск251', { cartonId: 'box-with-number' });
  seedAllocation(f, data.shipment, item, carton.cartonId, 30, 'number-snapshot-allocation');
  f.api.getBoxesForItem(data.shipment.id, data.shipment.directionId, item.positionId);

  const refreshed = f.api.getInitialData(data.shipment.id);
  assert.equal(refreshed.items[0].boxCountSnapshot, 1);
  assert.deepEqual(Array.from(refreshed.items[0].boxNumbersSnapshot), ['1мск251']);
  assert.equal(refreshed.items[0].cartonsSnapshot[0].cartonId, carton.cartonId);
  assert.equal(refreshed.items[0].cartonsSnapshot[0].itemQuantity, 30);
  assert.equal(refreshed.items[0].cartonsSnapshot[0].spaceKnown, true);
  assert.equal(refreshed.items[0].cartonsSnapshot[0].fillRatio, 0.3);
});

test('mixed carton snapshot repeats the physical fill per article and refuses to guess when a SKU norm is missing', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const known = data.items.find(item => item.sku === 'KNOWN');
  const unknown = data.items.find(item => item.sku === 'UNKNOWN');
  const carton = seedCarton(f, data.shipment, '1мск252', { cartonId: 'mixed-snapshot-box' });
  addCatalogNorm(f, 'UNKNOWN', 'M', 50);
  seedAllocation(f, data.shipment, known, carton.cartonId, 40, 'mixed-known-allocation');
  seedAllocation(f, data.shipment, unknown, carton.cartonId, 10, 'mixed-unknown-allocation');
  f.api.getBoxesForItem(data.shipment.id, data.shipment.directionId, known.positionId);

  const refreshed = f.api.getInitialData(data.shipment.id);
  const knownBox = refreshed.items.find(item => item.sku === 'KNOWN').cartonsSnapshot[0];
  const unknownBox = refreshed.items.find(item => item.sku === 'UNKNOWN').cartonsSnapshot[0];
  assert.equal(knownBox.cartonId, unknownBox.cartonId);
  assert.equal(knownBox.itemQuantity, 40);
  assert.equal(unknownBox.itemQuantity, 10);
  assert.equal(knownBox.pieceCount, 50);
  assert.equal(knownBox.skuCount, 2);
  assert.ok(Math.abs(knownBox.fillRatio - 0.6) < 1e-9);
  assert.ok(Math.abs(unknownBox.fillRatio - 0.6) < 1e-9);

  const missingFixture = fixture();
  const missingData = missingFixture.api.getInitialData();
  const missingKnown = missingData.items.find(item => item.sku === 'KNOWN');
  const missingUnknown = missingData.items.find(item => item.sku === 'UNKNOWN');
  const missingCarton = seedCarton(missingFixture, missingData.shipment, '1мск253', { cartonId: 'mixed-unknown-norm-box' });
  seedAllocation(missingFixture, missingData.shipment, missingKnown, missingCarton.cartonId, 40, 'missing-known-allocation');
  seedAllocation(missingFixture, missingData.shipment, missingUnknown, missingCarton.cartonId, 10, 'missing-unknown-allocation');
  missingFixture.api.getBoxesForItem(missingData.shipment.id, missingData.shipment.directionId, missingKnown.positionId);
  const missingSnapshot = missingFixture.api.getInitialData(missingData.shipment.id);
  const unknownCard = missingSnapshot.items.find(item => item.sku === 'UNKNOWN').cartonsSnapshot[0];
  assert.equal(unknownCard.spaceKnown, false);
  assert.equal(unknownCard.fillRatio, null);
  assert.match(unknownCard.blockedReason, /UNKNOWN/);
});

test('legacy preview token remains scoped and deduplicates retries', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const carton = seedCarton(f, data.shipment, '1мск211', { cartonId: 'carton-existing', legacyCapacity: 10000 });
  appendPacking(f, item, 100);
  seedAllocation(f, data.shipment, item, carton.cartonId, 20, 'alloc-existing-001');
  const contents = f.db.getSheetByName('CartonContents');
  const workLog = f.db.getSheetByName('WorkLog');
  const workBefore = structuredClone(workLog.rows);
  const payload = placementPayload(item, { cartonId: carton.cartonId, quantity: 30, idempotencyKey: 'place-existing-key-001' });

  const catalogOpensBeforePreview = f.catalogOpenCount();
  const preview = f.api.previewBoxPlacement(payload);
  assert.equal(f.catalogOpenCount() - catalogOpensBeforePreview, 2, 'preflight freshly confirms box norms and store assignment');
  assert.equal(preview.carton.fillBefore, 0.2);
  assert.equal(preview.carton.fillAfter, 0.5);
  const mismatched = f.api.saveBoxPlacement({ ...payload, quantity: 31, previewId: preview.previewId });
  assert.equal(mismatched.notWritten, true);
  assert.match(mismatched.message, /не совпадают с проверенным/);
  const catalogOpensBeforeSave = f.catalogOpenCount();
  const saved = f.api.saveBoxPlacement({ ...payload, previewId: preview.previewId });
  assert.equal(f.catalogOpenCount() - catalogOpensBeforeSave, 2, 'final server validation freshly confirms norms and store assignment');
  assert.equal(saved.duplicate, false);
  assert.equal(saved.assigned, 50);
  assert.equal(saved.available, 50);
  assert.equal(saved.carton.occupied, 50);
  assert.equal(saved.carton.itemQuantity, 50);
  assert.equal(contents.rows.length, 3);
  const duplicate = f.api.saveBoxPlacement({ ...payload, previewId: preview.previewId });
  assert.equal(duplicate.duplicate, true);
  assert.equal(contents.rows.length, 3, 'same action key cannot append twice');
  const reusedKey = f.api.saveBoxPlacement({ ...payload, quantity: 31, previewId: preview.previewId });
  assert.equal(reusedKey.notWritten, true);
  assert.match(reusedKey.message, /Ключ повтора уже использован/);
  const status = f.api.getBoxPlacementStatus(payload.idempotencyKey);
  assert.equal(status.allocation.quantity, 30);
  assert.equal(status.assigned, 50);
  assert.equal(status.itemBoxCount, 1);
  assert.deepEqual(workLog.rows, workBefore, 'carton changes never write to WorkLog');
  assert.equal(f.print.writes, 0);
  assert.ok(f.catalog.every((sheet) => sheet.writes === 0));
});

test('one-call placement validates the latest carton scope and deduplicates the same action key', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const carton = seedCarton(f, data.shipment, '1мск211', { cartonId: 'one-call-target' });
  appendPacking(f, item, 100, 'one-call-packed');
  seedAllocation(f, data.shipment, item, carton.cartonId, 3, 'one-call-existing');
  const payload = placementPayload(item, { cartonId: carton.cartonId, quantity: 10, idempotencyKey: 'one-call-place-key-01' });
  const currentScope = f.api.boxPlacementCurrentScope_;
  let concurrentWriteAdded = false;
  f.api.boxPlacementCurrentScope_ = (...args) => {
    if (!concurrentWriteAdded) {
      concurrentWriteAdded = true;
      seedAllocation(f, data.shipment, item, carton.cartonId, 5, 'one-call-concurrent-add');
    }
    return currentScope(...args);
  };

  const result = f.api.saveBoxPlacement(payload);
  assert.equal(concurrentWriteAdded, true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.assigned, 18, 'the save uses the latest packed allocation total');
  assert.equal(result.carton.fillRatio, 0.18, 'the latest carton fill is validated and returned');
  const contents = f.db.getSheetByName('CartonContents');
  const rowCount = contents.rows.length;
  const duplicate = f.api.saveBoxPlacement(payload);
  assert.equal(duplicate.duplicate, true);
  assert.equal(contents.rows.length, rowCount, 'repeating the action key cannot append twice');
  assert.equal(f.api.getBoxPlacementStatus(payload.idempotencyKey).allocation.quantity, 10);
});

test('placement lock contention is reported as pending, not a confirmed no-write', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  appendPacking(f, item, 100, 'busy-target-packed');
  const payload = placementPayload(item, { mode: 'new', quantity: 10, idempotencyKey: 'busy-placement-key-01' });
  f.locked(true);

  const result = f.api.saveBoxPlacement(payload);
  assert.equal(result.status, 'pending', JSON.stringify(result));
  assert.equal(result.pending, true);
  assert.equal(result.notWritten, undefined, 'an operation awaiting the shared write lock is not called a failed write');
  assert.equal(f.api.getBoxPlacementStatus(payload.idempotencyKey), null);
  assert.equal(f.db.getSheetByName('CartonContents').rows.length, 1);
});

test('one-call placement on a 3% carton survives unrelated employees changing other articles and cartons', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const other = data.items[1];
  const carton = seedCarton(f, data.shipment, '1мск211', { cartonId: 'low-fill-target' });
  appendPacking(f, item, 100, 'low-fill-packed');
  seedAllocation(f, data.shipment, item, carton.cartonId, 3, 'low-fill-existing');
  const payload = placementPayload(item, { cartonId: carton.cartonId, quantity: 10, idempotencyKey: 'unrelated-work-quote-01' });
  const currentScope = f.api.boxPlacementCurrentScope_;
  f.api.boxPlacementCurrentScope_ = (...args) => {
    appendPacking(f, other, 12, 'other-article-packed-during-save');
    seedCarton(f, data.shipment, '1мск299', { cartonId: 'unrelated-new-carton' });
    return currentScope(...args);
  };
  const saved = f.api.saveBoxPlacement(payload);

  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.carton.fillRatio, 0.13);
  assert.equal(saved.assigned, 13);
  assert.equal(f.api.getBoxPlacementStatus(payload.idempotencyKey).allocation.quantity, 10);
});

test('placement quote is safely rejected when the selected carton changes during confirmation', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const carton = seedCarton(f, data.shipment, '1мск211', { cartonId: 'changed-target' });
  appendPacking(f, item, 100, 'changed-target-packed');
  seedAllocation(f, data.shipment, item, carton.cartonId, 2, 'changed-target-existing');
  const payload = placementPayload(item, { cartonId: carton.cartonId, quantity: 10, idempotencyKey: 'changed-scope-key-01' });
  const preview = f.api.previewBoxPlacement(payload);
  seedAllocation(f, data.shipment, item, carton.cartonId, 3, 'another-worker-used-target');
  const contents = f.db.getSheetByName('CartonContents');
  const before = contents.rows.length;

  const rejected = f.api.saveBoxPlacement({ ...payload, previewId: preview.previewId });
  assert.equal(rejected.notWritten, true);
  assert.match(rejected.message, /изменились после проверки/);
  assert.equal(contents.rows.length, before, 'a changed preview never appends the requested allocation');
  assert.equal(f.api.getBoxPlacementStatus(payload.idempotencyKey), null);
});

test('commit rechecks the selected carton under the write lock before appending', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const carton = seedCarton(f, data.shipment, '1мск211', { cartonId: 'lock-recheck-target' });
  appendPacking(f, item, 100, 'lock-recheck-packed');
  seedAllocation(f, data.shipment, item, carton.cartonId, 2, 'lock-recheck-existing');
  const payload = placementPayload(item, { cartonId: carton.cartonId, quantity: 10, idempotencyKey: 'lock-recheck-key-001' });
  const preview = f.api.previewBoxPlacement(payload);
  const contents = f.db.getSheetByName('CartonContents');
  const rowsBeforeCommit = contents.rows.length;
  const currentScope = f.api.boxPlacementCurrentScope_;
  let injected = false;
  f.api.boxPlacementCurrentScope_ = (...args) => {
    if (!injected) {
      injected = true;
      seedAllocation(f, data.shipment, item, carton.cartonId, 3, 'second-worker-filled-target');
    }
    return currentScope(...args);
  };

  const result = f.api.saveBoxPlacement({ ...payload, previewId: preview.previewId });
  assert.equal(injected, true);
  assert.equal(result.notWritten, true);
  assert.match(result.message, /изменились после проверки/);
  assert.equal(contents.rows.length, rowsBeforeCommit + 1, 'only the concurrent worker allocation exists');
  assert.equal(f.api.getBoxPlacementStatus(payload.idempotencyKey), null);
});

test('placement status reads norms only for the affected carton, excluding unrelated history', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const carton = seedCarton(f, data.shipment, '1мск211', { cartonId: 'status-target' });
  const historical = seedCarton(f, data.shipment, '1мск212', { cartonId: 'status-unrelated' });
  appendPacking(f, item, 100);
  seedAllocation(f, data.shipment, item, carton.cartonId, 20, 'allocation-status-target-001');
  seedAllocation(f, data.shipment, data.items[1], historical.cartonId, 10, 'allocation-unrelated-001');
  const original = f.api.boxNormsForSkus_;
  const requests = [];
  f.api.boxNormsForSkus_ = (skus, fresh, marketplace) => { requests.push(Array.from(skus)); return original(skus, fresh, marketplace); };
  const result = f.api.getBoxPlacementStatus('status-target-001');
  assert.equal(result.carton.cartonId, carton.cartonId);
  assert.equal(result.assigned, 20);
  assert.deepEqual(requests, [['KNOWN']]);
});

test('mixed cartons calculate occupied space by each confirmed SKU norm, not by total piece count', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const other = data.items[1];
  addCatalogNorm(f, other.sku, 'O', 200);
  appendPacking(f, item, 100);
  appendPacking(f, other, 60, 'pack-other-001');
  const carton = seedCarton(f, data.shipment, '1мск211', { cartonId: 'mixed-box', legacyCapacity: 20 });
  seedAllocation(f, data.shipment, item, carton.cartonId, 50, 'alloc-mixed-known');
  seedAllocation(f, data.shipment, other, carton.cartonId, 20, 'alloc-mixed-other');

  const before = f.api.getBoxDetails(data.shipment.id, data.shipment.directionId, carton.cartonId);
  assert.equal(before.carton.pieceCount, 70);
  assert.equal(before.carton.fillRatio, 0.6);
  const payload = placementPayload(other, { cartonId: carton.cartonId, quantity: 30, idempotencyKey: 'mixed-placement-key-01' });
  const { preview, result } = previewAndSave(f.api, payload);
  assert.match(preview.carton.boxType, /M.*O|O.*M/, 'preflight describes a mixed-type carton');
  assert.equal(preview.carton.fillAfter, 0.75);
  assert.match(result.carton.boxType, /M.*O|O.*M/, 'the saved carton keeps both item box types visible');
  assert.equal(result.carton.pieceCount, 100);
  assert.equal(result.carton.fillRatio, 0.75);
  assert.equal(result.carton.itemQuantity, 50, 'card count is for the selected SKU, not all mixed pieces');
  assert.equal(result.available, 10);
});

test('missing packing facts or catalog norms fail closed instead of using plan or legacy capacity', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const known = data.items[0];
  const unknown = data.items[1];
  const workLogIndex = f.db.sheets.findIndex((sheet) => sheet.name === 'WorkLog');
  f.db.sheets.splice(workLogIndex, 1);
  const empty = f.api.getBoxesForItem(known.shipmentId, known.directionId, known.positionId);
  assert.equal(empty.item.packedKnown, false);
  assert.equal(empty.available, null, 'plan is not treated as actual packed quantity');
  assert.throws(() => f.api.previewBoxPlacement(placementPayload(known, { mode: 'new', quantity: 10 })), /WorkLog недоступен/);

  f.db.sheets.splice(workLogIndex, 0, new Sheet('WorkLog', [[
    'eventId', 'createdAt', 'shipmentId', 'directionId', 'Направление', 'positionId', 'Артикул',
    'employeeId', 'Сотрудник', 'operationId', 'Операция', 'Количество, шт', 'Норма, шт/чел',
    'Коэффициент', 'Источник', 'idempotencyKey',
  ]], 5, true));
  appendPacking(f, unknown, 30);
  assert.throws(() => f.api.previewBoxPlacement(placementPayload(unknown, { mode: 'new', quantity: 10 })), /не подтверждены|не найдена/i);
  addCatalogNorm(f, unknown.sku, 'M', 200);
  appendPacking(f, known, 100, 'pack-known-001');
  appendPacking(f, unknown, 180, 'pack-other-180');
  const box = seedCarton(f, data.shipment, '1мск211', { cartonId: 'legacy-box', legacyCapacity: 20 });
  seedAllocation(f, data.shipment, unknown, box.cartonId, 180, 'alloc-legacy-capacity');
  const preview = f.api.previewBoxPlacement(placementPayload(known, { cartonId: box.cartonId, quantity: 5 }));
  assert.ok(Math.abs(preview.carton.fillAfter - 0.95) < 1e-9, 'legacy piece capacity is ignored in favor of each confirmed catalog norm');
  assert.throws(() => f.api.createCarton({}), /Ручное создание короба отключено/);
});

test('cancelling the last packing record appends a carton correction and removes its contents', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const otherItem = data.items[1];
  const carton = seedCarton(f, data.shipment, '1мск260', { cartonId: 'cancelled-work-box', status: 'Закрыт', closedAt: '2026-10-16T09:00:00.000Z', occupied: 160 });
  const anna = appendWorkEvent(f, item, { eventId: 'pack-to-cancel-anna', 'Количество, шт': 100 });
  const liza = appendWorkEvent(f, item, { eventId: 'pack-to-cancel-liza', 'Количество, шт': 67 });
  const olya = appendWorkEvent(f, item, { eventId: 'pack-to-cancel-olya', 'Количество, шт': 3 });
  appendWorkEvent(f, item, { eventId: 'demo-packing-must-not-count', 'Количество, шт': 999, 'Источник': 'WEB_APP_TEST' });
  appendWorkEvent(f, otherItem, { eventId: 'other-article-active-packing', 'Количество, шт': 60 });
  const workLog = f.db.getSheetByName('WorkLog');
  const workBefore = JSON.stringify(workLog.rows);
  seedAllocation(f, data.shipment, item, carton.cartonId, 100, 'cancelled-work-allocation');
  seedAllocation(f, data.shipment, otherItem, carton.cartonId, 10, 'kept-other-sku-allocation');
  seedAllocation(f, data.shipment, otherItem, carton.cartonId, 50, 'kept-other-sku-allocation-2');

  f.api.cancelWork(liza.eventId, 'Ошибочно записана упаковка');
  const afterFirstCancel = f.api.getBoxesForItem(data.shipment.id, data.shipment.directionId, item.positionId);
  assert.equal(afterFirstCancel.assigned, 100, '100 active packed units still support the existing 100-unit placement');
  f.api.cancelWork(anna.eventId, 'Ошибочно записана упаковка');
  f.api.cancelWork(olya.eventId, 'Ошибочно записана упаковка');

  const boxes = f.api.getBoxesForItem(data.shipment.id, data.shipment.directionId, item.positionId);
  assert.equal(boxes.item.packed, 0, 'cancelled WorkLog facts no longer count as packed units');
  assert.equal(boxes.assigned, 0, 'a carton cannot retain units after all packing facts are cancelled');
  assert.equal(boxes.available, 0);
  assert.equal(boxes.overAllocated, false);
  const boxDetails = f.api.getBoxDetails(data.shipment.id, data.shipment.directionId, carton.cartonId).carton;
  assert.equal(boxDetails.itemQuantity, 60);
  assert.deepEqual(Array.from(boxDetails.contents, row => [row.sku, row.quantity]), [[otherItem.sku, 10], [otherItem.sku, 50]]);
  const contents = f.db.getSheetByName('CartonContents');
  const headers = contents.rows[0];
  const removals = contents.rows.slice(1).filter(row => row[headers.indexOf('action')] === 'REMOVE');
  assert.equal(removals.reduce((sum, row) => sum + row[headers.indexOf('Количество, шт')], 0), -100);
  assert.ok(removals.every(row => row[headers.indexOf('sourceAllocationId')] === 'cancelled-work-allocation'));
  assert.deepEqual(new Set(removals.map(row => row[headers.indexOf('sourceWorkEventId')])), new Set([anna.eventId, olya.eventId]));
  assert.equal(JSON.stringify(workLog.rows), workBefore, 'WorkLog stays immutable while the carton ledger records reversals');
  assert.equal(f.db.getSheetByName('Cartons').rows[1][5], 60, 'derived occupied count keeps the other two articles');
});

test('owner reconciliation audits all old cancellations across open and closed cartons and is idempotent', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const first = data.items[0];
  const second = data.items[1];
  const third = { ...first, positionId: first.positionId + '-third', sku: 'THIRD' };
  const keep = { ...first, positionId: first.positionId + '-keep', sku: 'KEEP' };
  const events = [
    appendWorkEvent(f, first, { eventId: 'old-sonya-10', 'Количество, шт': 10 }),
    appendWorkEvent(f, second, { eventId: 'old-alex-100', 'Количество, шт': 100 }),
    appendWorkEvent(f, second, { eventId: 'old-olya-100', 'Количество, шт': 100 }),
    appendWorkEvent(f, third, { eventId: 'old-vika-20', 'Количество, шт': 20 }),
  ];
  appendWorkEvent(f, keep, { eventId: 'still-active', 'Количество, шт': 7 });
  const closed = seedCarton(f, data.shipment, '1мск211', { cartonId: 'old-closed', status: 'Закрыт', closedAt: '2026-10-19T08:53:48Z', occupied: 60 });
  const open = seedCarton(f, data.shipment, '1мск212', { cartonId: 'old-open', occupied: 120 });
  const kept = seedCarton(f, data.shipment, '1мск213', { cartonId: 'kept-open', occupied: 7 });
  seedAllocation(f, data.shipment, first, closed.cartonId, 10, 'old-10');
  seedAllocation(f, data.shipment, second, closed.cartonId, 50, 'old-50');
  seedAllocation(f, data.shipment, second, open.cartonId, 100, 'old-100');
  seedAllocation(f, data.shipment, third, open.cartonId, 20, 'old-20');
  seedAllocation(f, data.shipment, keep, kept.cartonId, 7, 'keep-7');
  const corrections = new Sheet('WorkLogCorrections', [
    ['correctionId', 'eventId', 'action', 'createdAt', 'actor', 'reason'],
    ...events.map((event, index) => ['old-cancel-' + index, event.eventId, 'CANCEL', '2026-10-19T08:54:0' + index + 'Z', 'Сборщик', 'Ошибочная упаковка']),
  ], 50, true);
  f.db.sheets.push(corrections);
  const workBefore = JSON.stringify(f.db.getSheetByName('WorkLog').rows);
  const correctionsBefore = JSON.stringify(corrections.rows);
  const originalAllocations = JSON.stringify(f.db.getSheetByName('CartonContents').rows);
  const audit = f.api.auditCancelledPackingCartons();
  assert.equal(audit.excess, 180);
  assert.equal(audit.positions.filter(position => position.excess > 0).length, 3);
  assert.equal(JSON.stringify(f.db.getSheetByName('CartonContents').rows), originalAllocations, 'audit must be read-only');
  f.actor('collector@example.com');
  assert.throws(() => f.api.reconcileCancelledPackingCartons(), /владельцу/);
  f.actor('zinovevkirill234@gmail.com');
  const repaired = f.api.reconcileCancelledPackingCartons();
  assert.equal(repaired.after.excess, 0);
  const totals = Object.fromEntries(Array.from(repaired.after.cartons, carton => [carton.cartonId, carton]));
  assert.equal(totals['old-closed'].stored, 0);
  assert.equal(totals['old-closed'].assigned, 0);
  assert.equal(totals['old-closed'].status, 'Отменён');
  assert.equal(totals['old-open'].stored, 0);
  assert.equal(totals['old-open'].status, 'Отменён');
  assert.equal(totals['kept-open'].assigned, 7);
  assert.equal(totals['kept-open'].status, 'Открыт');
  assert.equal(f.api.getClosedCartons(data.shipment.id, data.shipment.directionId, '', '').boxes.length, 0, 'cancelled empty cartons must not reappear because closedAt is retained');
  const contents = f.db.getSheetByName('CartonContents');
  const actionIndex = contents.rows[0].indexOf('action');
  const removals = contents.rows.slice(1).filter(row => row[actionIndex] === 'REMOVE');
  assert.equal(removals.length, 4);
  assert.equal(removals.reduce((sum, row) => sum + row[6], 0), -180);
  const afterFirst = JSON.stringify(contents.rows);
  assert.equal(f.api.reconcileCancelledPackingCartons().results.length, 0);
  assert.equal(JSON.stringify(contents.rows), afterFirst, 'repeat reconciliation must not append more removals');
  assert.equal(JSON.stringify(f.db.getSheetByName('WorkLog').rows), workBefore);
  assert.equal(JSON.stringify(corrections.rows), correctionsBefore);
});

test('reconciliation retires already-empty cartons with old removal evidence and preserves their audit', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const event = appendWorkEvent(f, item, { eventId: 'old-fully-removed', 'Количество, шт': 10 });
  const carton = seedCarton(f, data.shipment, '1мск299', { cartonId: 'old-empty', status: 'Закрыт', closedAt: '2026-10-19T08:00:00Z', occupied: 10 });
  seedAllocation(f, data.shipment, item, carton.cartonId, 10, 'old-empty-allocation');
  f.api.cancelWork(event.eventId, 'Ошибочная упаковка');
  const cartons = f.db.getSheetByName('Cartons');
  const statusIndex = cartons.rows[0].indexOf('Статус');
  cartons.rows[1][statusIndex] = 'Закрыт'; // State left by the earlier implementation.
  const contentsBefore = JSON.stringify(f.db.getSheetByName('CartonContents').rows);
  const repaired = f.api.reconcileCancelledPackingCartons();
  assert.equal(repaired.before.excess, 0);
  assert.equal(repaired.results.length, 1);
  assert.equal(cartons.rows[1][statusIndex], 'Отменён');
  assert.equal(cartons.rows[1][8], '2026-10-19T08:00:00Z', 'original closure evidence is retained');
  assert.equal(JSON.stringify(f.db.getSheetByName('CartonContents').rows), contentsBefore, 'retiring an already empty carton does not append duplicate removals');
  assert.equal(f.api.reconcileCancelledPackingCartons().results.length, 0);
});

test('automatic carton numbering follows a unique existing store pattern and appends metadata without shifting rows', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  const cartons = f.db.getSheetByName('Cartons');
  const historical = seedCarton(f, data.shipment, '1мск211', { cartonId: 'historical-box' });
  const legacyBefore = cartons.rows[1].slice();
  appendPacking(f, item, 100);
  const payload = placementPayload(item, { mode: 'new', quantity: 30, idempotencyKey: 'auto-carton-key-0001' });
  const { preview, result } = previewAndSave(f.api, payload);

  assert.equal(preview.carton.number, '1мос212');
  assert.equal(result.carton.number, '1мос212');
  assert.equal(cartons.rows[0][10], 'shipmentId');
  assert.equal(cartons.rows[0][11], 'Тип короба');
  assert.deepEqual(cartons.rows[1].slice(0, legacyBefore.length), legacyBefore, 'legacy rows and their positions are preserved');
  assert.equal(cartons.rows.at(-1)[10], data.shipment.id, 'new cartons retain the stable shipment ID');
  assert.equal(cartons.rows.at(-1)[11], 'M');
  assert.equal(cartons.rows.length, 3);
  assert.ok(historical);
  assert.equal(f.print.writes, 0);
  assert.ok(f.catalog.every((sheet) => sheet.writes === 0));
});

test('Ozon individual cartons start at 1инд1 and continue the shared creation sequence', () => {
  const next = (cartons) => fixture().api.nextCartonNumber_({
    'Название поставки': 'OZON индивидуалка',
    'Направление': 'Индивидуальная поставка',
    directionId: 'BOX',
  }, cartons, '1');

  assert.equal(next([]), '1инд1');
  assert.equal(next([
    { 'Номер': '1инд1', directionId: 'BOX', 'Направление': 'Индивидуальная поставка' },
    { 'Номер': '1инд3', directionId: 'BOX', 'Направление': 'Индивидуальная поставка' },
    { 'Номер': '1мск88', directionId: 'ROLL', 'Направление': 'Москва' },
  ]), '1инд4');
  assert.equal(fixture().api.nextCartonNumber_({
    'Название поставки': 'WB Кострома 06_10', 'Направление': 'Кострома', directionId: 'WB-1', shipmentId: 'WB-1',
  }, [], '2'), '2кос1', 'the same store-based numbering rule applies to WB supplies');
});

test('automatic number generation starts from the store digit and supply abbreviation without a template', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  appendPacking(f, item, 10);
  const preview = f.api.previewBoxPlacement(placementPayload(item, { mode: 'new', quantity: 1 }));
  assert.equal(preview.carton.number, '1мос1');
  assert.equal(f.db.getSheetByName('Cartons').rows.length, 1, 'preview still does not create a carton');
});

test('a store 2 article cannot enter a store 1 carton and receives its own number sequence', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  appendPacking(f, item, 10);
  f.catalog[0].rows[1][14] = '2';
  const existingStoreOne = seedCarton(f, data.shipment, '1мос1', { cartonId: 'store-one-box' });
  assert.throws(() => f.api.previewBoxPlacement(placementPayload(item, {
    cartonId: existingStoreOne.cartonId, quantity: 1, idempotencyKey: 'wrong-store-box-0001',
  })), /Нельзя смешивать магазины/);
  const preview = f.api.previewBoxPlacement(placementPayload(item, {
    mode: 'new', quantity: 1, idempotencyKey: 'store-two-box-0001',
  }));
  assert.equal(preview.carton.number, '2мос1');
});

test('an existing carton cannot mix store 1 contents with a store 2 article', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  appendPacking(f, item, 10);
  const otherCatalogRow = ['OTHER(OZ)', 'OTHER', 'Другой товар', 'barcode', 'Наклейки А4 3-4 листа', 1, '', '', 'Наклейки', '', 'M', 100, '100 M', '', '2'];
  f.catalog[0].rows.push(otherCatalogRow);
  f.catalog[1].rows.push(['OTHER', 'OTHER(OZ)', 'barcode', 'OZ barcode', 'Другой товар', 'Наклейки А4 3-4 листа', 'Наклейки', '', '', 1, '', '', '', 'M', 100, '100 M', '', '', '', '2']);
  const carton = seedCarton(f, data.shipment, '1мос1', { cartonId: 'mixed-store-box' });
  seedAllocation(f, data.shipment, { positionId: 'other-position', sku: 'OTHER' }, carton.cartonId, 1, 'other-store-content');
  assert.throws(() => f.api.previewBoxPlacement(placementPayload(item, {
    cartonId: carton.cartonId, quantity: 1, idempotencyKey: 'mixed-store-try-0001',
  })), /В один короб нельзя добавлять товары разных магазинов/);
});

test('carton operations remain scoped to their shipment, and a full carton is not auto-closed', () => {
  const f = fixture();
  f.add('OZON СПБ', 200, [['KNOWN', 100, 'same-article']]);
  f.api.syncRitmSupplies(true);
  const a = f.api.getInitialData('RITM-ROLL-100');
  const b = f.api.getInitialData('RITM-ROLL-200');
  appendPacking(f, a.items[0], 100, 'pack-a');
  appendPacking(f, b.items[0], 100, 'pack-b');
  const cartonA = seedCarton(f, a.shipment, '1мск211', { cartonId: 'shipment-a-box' });
  const cartonB = seedCarton(f, b.shipment, '1спб211', { cartonId: 'shipment-b-box' });
  const boxesInB = f.api.getBoxesForItem(b.shipment.id, b.shipment.directionId, b.items[0].positionId);
  assert.deepEqual(Array.from(boxesInB.boxes, row => row.cartonId), [cartonB.cartonId]);
  const crossSupply = placementPayload(b.items[0], { cartonId: cartonA.cartonId, quantity: 10, idempotencyKey: 'cross-supply-key-0001' });
  assert.throws(() => f.api.previewBoxPlacement(crossSupply), /другой поставке/);
});

test('closing a carton requires current data version and does not happen automatically at full capacity', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  const item = data.items[0];
  appendPacking(f, item, 100);
  const carton = seedCarton(f, data.shipment, '1мск211', { cartonId: 'close-box' });
  seedAllocation(f, data.shipment, item, carton.cartonId, 100, 'alloc-full-box');
  const details = f.api.getBoxDetails(data.shipment.id, data.shipment.directionId, carton.cartonId);
  assert.equal(details.carton.fillRatio, 1);
  assert.equal(details.carton.open, true);
  assert.throws(() => f.api.closeCarton({ shipmentId: data.shipment.id, directionId: data.shipment.directionId, cartonId: carton.cartonId, dataVersion: details.dataVersion - 1, idempotencyKey: 'close-carton-key-001' }), /изменился/);
  const result = f.api.closeCarton({ shipmentId: data.shipment.id, directionId: data.shipment.directionId, cartonId: carton.cartonId, dataVersion: details.dataVersion, idempotencyKey: 'close-carton-key-002' });
  assert.equal(result.ok, true);
  assert.equal(f.api.getBoxDetails(data.shipment.id, data.shipment.directionId, carton.cartonId).carton.closed, true);
});

test('closed cartons are fetched as 25-row pages only when requested', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  for (let index = 1; index <= 30; index += 1) {
    seedCarton(f, data.shipment, '1мск' + String(index).padStart(3, '0'), {
      cartonId: 'closed-' + index, status: 'Закрыт', closedAt: '2026-10-16T08:00:00.000Z',
    });
  }
  const first = f.api.getClosedCartons(data.shipment.id, data.shipment.directionId, '', '');
  assert.equal(first.boxes.length, 25);
  assert.equal(first.hasMore, true);
  assert.equal(first.boxes[0].number, '1мск030');
  const second = f.api.getClosedCartons(data.shipment.id, data.shipment.directionId, '', first.nextCursor);
  assert.equal(second.boxes.length, 5);
  assert.equal(second.hasMore, false);
  assert.equal(second.boxes[0].number, '1мск005');
});

test('sync is idempotent and unchanged supply is not written again', () => {
  const f = fixture();
  f.api.syncRitmSupplies(false);
  const sheet = f.db.getSheetByName('OZON МОСКВА'),
    writes = sheet.writes;
  f.api.syncRitmSupplies(false);
  f.api.getInitialData();
  assert.equal(f.db.sheets.filter((s) => s.name === 'OZON МОСКВА').length, 1);
  assert.equal(sheet.writes, writes);
});

test('same SKU across supplies has isolated position IDs, work logs and switching', () => {
  const f = fixture();
  f.add('СПБ', 200, [['KNOWN', 20, 'a']]);
  const a = f.api.getInitialData('RITM-ROLL-100'),
    b = f.api.getInitialData('RITM-ROLL-200');
  assert.notEqual(a.items[0].positionId, b.items[0].positionId);
  const payload = {
    shipmentId: a.shipment.id,
    directionId: 'ROLL',
    positionId: a.items[0].positionId,
    employeeId: 'emp',
    operationId: 'cut',
    quantity: 12,
    idempotencyKey: 'test-idempotency-123',
  };
  const saved = f.api.saveWork(payload),
    duplicate = f.api.saveWork(payload);
  assert.equal(saved.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.eventId, saved.eventId);
  assert.equal(duplicate.dataVersion, saved.dataVersion);
  assert.throws(
    () => f.api.saveWork({ ...payload, quantity: 13 }),
    /Ключ повтора уже использован/,
  );
  assert.equal(f.api.getDataVersion(), saved.dataVersion);
  const status = f.api.getWorkStatus(payload.idempotencyKey);
  assert.equal(status.eventId, saved.eventId);
  assert.equal(status.quantity, 12);
  assert.equal(
    f.api.getInitialData(a.shipment.id).items[0].operations.cut.fact,
    12,
  );
  assert.equal(
    f.api.getInitialData(b.shipment.id).items[0].operations.cut.fact,
    0,
  );
  assert.equal(f.db.getSheetByName('WorkLog').getLastRow(), 2);
  assert.throws(
    () => f.api.saveWork({ ...payload, shipmentId: b.shipment.id }),
    /Артикул не найден/,
  );
});

test('bulk supply sync releases the critical lock before opening or reading Sheets', () => {
  const f = fixture();
  f.assertUnlockedReads(true);
  const report = f.api.syncRitmSupplies(true);
  assert.equal(report.status, 'current');
  assert.equal(f.api.getDataVersion(), 1);
});

test('catalog photos are added as trusted lazy URLs and legacy photo assets stay bounded', () => {
  const f = fixture();
  f.db.getSheetByName('Photos').rows.push(['photo-1', 'image/png', 'YWJj']);
  const data = f.api.getInitialData();
  assert.equal(data.items[0].photoAssetKey, '');
  assert.equal(data.items[0].photoUrl, 'https://basket-33.wbbasket.ru/vol6814/part681428/681428847/images/big/1.webp');
  const mirror = f.db.getSheetByName('OZON МОСКВА');
  const workLogBefore = JSON.stringify(f.db.getSheetByName('WorkLog').rows);
  f.photoLinks.rows[1][1] = 'https://basket-33.wbbasket.ru/vol6814/part681428/681428847/images/big/2.webp';
  const refreshed = f.api.syncRitmSupplies(true);
  assert.equal(refreshed.status, 'current');
  assert.equal(mirror.rows[0][21], 'Фото');
  assert.equal(mirror.rows[1][21], 'https://basket-33.wbbasket.ru/vol6814/part681428/681428847/images/big/2.webp');
  assert.equal(JSON.stringify(f.db.getSheetByName('WorkLog').rows), workLogBefore);
  assert.equal(
    f.api.getPhotos(['photo-1', 'photo-1', 'invalid key'])['photo-1'],
    'data:image/png;base64,YWJj',
  );
  for (let i = 0; i < 25; i += 1)
    f.db.getSheetByName('Photos').rows.push(['p' + i, 'image/png', 'YWJj']);
  assert.equal(
    Object.keys(f.api.getPhotos(Array.from({ length: 25 }, (_, i) => 'p' + i)))
      .length,
    20,
  );
  const article = data.items.find((item) => item.sku === 'UNKNOWN');
  assert.equal(article.photoUrl, '');
  assert.ok(html.includes('else img.src = item.photoUrl'));
  assert.ok(html.includes('else image.src = sourceItem.photoUrl'));
});

test('photo URL allowlist accepts current Wildberries image CDN hosts only', () => {
  const api = fixture().api;
  assert.equal(api.safeRitmPhotoUrl_('https://mow-basket-cdn-42.geobasket.ru/vol12819/part1281969/1281969040/images/big/1.webp'),
    'https://mow-basket-cdn-42.geobasket.ru/vol12819/part1281969/1281969040/images/big/1.webp');
  assert.equal(api.safeRitmPhotoUrl_('https://mow-basket-cdn-43.geobasket.ru/vol15037/part1503706/1503706301/images/big/1.webp'),
    'https://mow-basket-cdn-43.geobasket.ru/vol15037/part1503706/1503706301/images/big/1.webp');
  assert.equal(api.safeRitmPhotoUrl_('https://basket-33.wbbasket.ru/vol6814/part681428/681428847/images/big/1.webp'),
    'https://basket-33.wbbasket.ru/vol6814/part681428/681428847/images/big/1.webp');
  assert.equal(api.safeRitmPhotoUrl_('https://mow-basket-cdn-43.geobasket.ru.attacker.example/image.webp'), '');
  assert.equal(api.safeRitmPhotoUrl_('https://example.com/image.webp'), '');
});

test('catalog photo refresh carries geobasket product links into the Assembly mirror', () => {
  const f = fixture();
  const url = 'https://mow-basket-cdn-42.geobasket.ru/vol12819/part1281969/1281969040/images/big/1.webp';
  f.photoLinks.rows[1][1] = url;
  const report = f.api.syncRitmSupplies(true);
  assert.equal(report.status, 'current');
  const mirror = f.db.getSheetByName('OZON МОСКВА');
  assert.equal(mirror.rows[1][21], url);
  assert.equal(f.api.getInitialData().items[0].photoUrl, url);
});

function addTypeShiftNorms(f, sheetsPerUnit = 3) {
  const sheet = new Sheet('нормы', [
    ['вид', 'Резка, л', 'Упаковка', 'Норма резки и прочего'],
    ['Наклейки А4 3-4 листа', 7000, 850, 650],
  ], 900);
  f.db.sheets.push(sheet);
  const sheetCountColumn = f.catalog[0].rows[0].indexOf('Кол-во листов');
  f.catalog[0].rows[1][sheetCountColumn] = sheetsPerUnit;
  return sheet;
}

test('type shift norms reproduce FBO sheets, manual work and packaging coefficients for one employee', () => {
  const f = fixture();
  addTypeShiftNorms(f);
  const data = f.api.getInitialData();
  const item = data.items[0];
  assert.equal(item.sheetsPerUnit, 3);
  assert.equal(item.operations.cut.normPerPerson, 7000 / 3);
  assert.equal(item.operations.cut.normDetails.perShift, 7000);
  assert.equal(item.operations.cut.normDetails.unit, 'л.');
  const expected = { cut: 100 * 3 / 7000, assembly: 100 / 650, packing: 100 / 850 };
  const payload = { shipmentId: item.shipmentId, directionId: item.directionId, positionId: item.positionId, employeeId: 'emp', quantity: 100 };
  for (const operationId of ['cut', 'assembly', 'packing']) {
    const saved = f.api.saveWork({ ...payload, operationId, idempotencyKey: 'shift-norm-' + operationId + '-123' });
    assert.ok(Math.abs(saved.coefficient - expected[operationId]) < 1e-12);
  }
  const day = f.api.getInitialData().employeeShift.employees.emp;
  assert.equal(day.eventCount, 3);
  assert.equal(day.unknownCount, 0);
  assert.ok(Math.abs(day.coefficient - Object.values(expected).reduce((a, b) => a + b, 0)) < 1e-12);
  f.api.saveWork({ ...payload, operationId: 'packing', idempotencyKey: 'shift-norm-packing-123' });
  assert.equal(f.db.getSheetByName('WorkLog').rows.length, 4);
  assert.equal(f.api.getInitialData().employeeShift.employees.emp.eventCount, 3);
});

test('shift contribution spans supplies and uses the Moscow production day without mixing demo or older work', () => {
  const f = fixture();
  addTypeShiftNorms(f, 1);
  f.add('OZON СПБ', 200, [['KNOWN', 100, 'other']]);
  const a = f.api.getInitialData('RITM-ROLL-100');
  const b = f.api.getInitialData('RITM-ROLL-200');
  for (const [data, operationId, quantity] of [[a, 'cut', 3500], [b, 'packing', 425]])
    f.api.saveWork({ shipmentId: data.shipment.id, directionId: 'ROLL', positionId: data.items[0].positionId, employeeId: 'emp', operationId, quantity, idempotencyKey: 'cross-shift-' + operationId + '-123' });
  const shift = f.api.getInitialData(a.shipment.id).employeeShift;
  assert.equal(shift.employees.emp.coefficient, 1);
  const event = { eventId: 'edge-event', idempotencyKey: 'edge-key', employeeId: 'emp', operationId: 'cut', 'Источник': 'WEB_APP_RITM', 'Количество, шт': 100, 'Коэффициент': 0.5 };
  const snapshot = { available: true, rows: [
    { ...event, createdAt: '2026-10-15T21:00:00.000Z' },
    { ...event, eventId: 'old', idempotencyKey: 'old-key', createdAt: '2026-10-15T20:59:59.999Z' },
    { ...event, eventId: 'demo', idempotencyKey: 'demo-key', 'Источник': 'WEB_APP_TEST', createdAt: '2026-10-16T10:00:00Z' },
    { ...event, eventId: 'duplicate-key-event', createdAt: '2026-10-15T21:00:00.000Z' },
  ] };
  assert.equal(f.api.summarizeEmployeeShift_(snapshot, '2026-10-16').employees.emp.coefficient, 0.5);
});

test('saved coefficients keep their original norm while the next save rereads edited shift norms', () => {
  const f = fixture();
  const sheet = addTypeShiftNorms(f);
  const data = f.api.getInitialData();
  const payload = { shipmentId: data.shipment.id, directionId: 'ROLL', positionId: data.items[0].positionId, employeeId: 'emp', operationId: 'packing', quantity: 100, idempotencyKey: 'old-shift-norm-123' };
  const first = f.api.saveWork(payload);
  const originalRow = JSON.stringify(f.db.getSheetByName('WorkLog').rows[1]);
  sheet.rows[1][2] = 1000;
  const second = f.api.saveWork({ ...payload, idempotencyKey: 'new-shift-norm-123' });
  assert.equal(first.norm, 850);
  assert.equal(second.norm, 1000);
  assert.equal(second.coefficient, 0.1);
  assert.equal(JSON.stringify(f.db.getSheetByName('WorkLog').rows[1]), originalRow);
  assert.equal(f.api.getWorkStatus(payload.idempotencyKey).coefficient, 100 / 850);
});

test('missing and conflicting shift norms stay unknown, and unpriced old events prevent a false shift remainder', () => {
  for (const sheets of ['', '#N/A', 0]) {
    const f = fixture();
    addTypeShiftNorms(f, sheets);
    const data = f.api.getInitialData();
    assert.equal(data.items[0].operations.cut.normPerPerson, sheets === '' ? 7000 : null);
  }
  const f = fixture();
  const sheet = addTypeShiftNorms(f);
  sheet.rows.push(['Наклейки А4 3-4 листа', 8000, 900, 700]);
  const data = f.api.getInitialData();
  assert.equal(data.items[0].operations.packing.normPerPerson, null);
  assert.match(data.items[0].operations.packing.normDetails.reason, /разные нормы/);
  f.api.saveWork({ shipmentId: data.shipment.id, directionId: 'ROLL', positionId: data.items[0].positionId, employeeId: 'emp', operationId: 'packing', quantity: 10, idempotencyKey: 'missing-norm-work-123' });
  assert.equal(f.api.getInitialData().employeeShift.employees.emp.unknownCount, 1);
});

test('cached employee and norm labels are never authoritative for a save', () => {
  const f = fixture();
  const norms = f.db.getSheetByName('OperationNorms');
  norms.rows.push(['RITM-ROLL-100|uid:a|KNOWN', 'cut', 20]);
  f.api.getInitialData(); // warms the display cache
  norms.rows[1][2] = 10;
  const data = f.api.getInitialData();
  const item = data.items[0];
  const result = f.api.saveWork({
    shipmentId: item.shipmentId,
    directionId: item.directionId,
    positionId: item.positionId,
    employeeId: 'emp',
    operationId: 'cut',
    quantity: 10,
    idempotencyKey: 'fresh-norm-save-123',
  });
  assert.equal(result.norm, 10);
  f.db.getSheetByName('Employees').rows[1][2] = false;
  assert.throws(
    () =>
      f.api.saveWork({
        shipmentId: item.shipmentId,
        directionId: item.directionId,
        positionId: item.positionId,
        employeeId: 'emp',
        operationId: 'cut',
        quantity: 1,
        idempotencyKey: 'inactive-employee-123',
      }),
    /отсутствует в справочнике или неактивен/,
  );
});

test('append, quantity update and rename preserve stable positions and work history', () => {
  const f = fixture();
  const before = f.api.getInitialData();
  const id = before.items[0].positionId;
  f.print.name = 'OZON Москва новая';
  f.print.rows[4][14] = 130;
  const extra = Array(29).fill('');
  extra[4] = 'APPENDED';
  extra[14] = 17;
  extra[28] = 'c';
  f.print.rows.push(extra);
  f.api.syncRitmSupplies(true);
  const after = f.api.getInitialData(before.shipment.id);
  assert.equal(after.items[0].positionId, id);
  assert.equal(after.items[0].operations.packing.plan, 130);
  assert.equal(after.items[2].sku, 'APPENDED');
  assert.ok(f.db.getSheetByName('OZON Москва новая'));
});

test('hidden source tabs and service sheets are excluded', () => {
  const f = fixture();
  f.add('Hidden', 200, [['X', 10, 'a']]).hidden = true;
  f.source.sheets.push(
    new Sheet('Журнал выпуска', [['Артикул', 'Количество']]),
  );
  assert.equal(
    f.api.getInitialData().shipments.filter((s) => s.environment === 'RITM')
      .length,
    1,
  );
});

test('catalog outage still imports articles and plan; source outage retains last known data', () => {
  const f = fixture();
  f.offline(ids.catalog);
  const r = f.api.syncRitmSupplies(true);
  assert.equal(r.status, 'partial');
  assert.equal(f.api.getInitialData('RITM-ROLL-100').items[0].sku, 'KNOWN');
  f.offline(ids.printing);
  assert.equal(f.api.syncRitmSupplies(true).status, 'error');
  assert.equal(f.api.getInitialData('RITM-ROLL-100').items.length, 2);
});

test('unrelated same-name destination is never overwritten', () => {
  const f = fixture();
  const sheet = new Sheet('OZON МОСКВА', [['important']], 500, true);
  f.db.sheets.push(sheet);
  const report = f.api.syncRitmSupplies(true);
  assert.equal(report.status, 'partial');
  assert.equal(sheet.writes, 0);
  assert.equal(sheet.rows[0][0], 'important');
});

test('deleted and recreated same-name source archives old derived rows and isolates work', () => {
  const f = fixture();
  const before = f.api.getInitialData();
  f.api.saveWork({
    shipmentId: before.shipment.id,
    directionId: 'ROLL',
    positionId: before.items[0].positionId,
    employeeId: 'emp',
    operationId: 'cut',
    quantity: 12,
    idempotencyKey: 'old-supply-work-123',
  });
  const old = f.db.getSheetByName('OZON МОСКВА'),
    rows = JSON.stringify(old.rows);
  const log = JSON.stringify(f.db.getSheetByName('WorkLog').rows);
  f.source.sheets = [];
  f.add('OZON МОСКВА', 200, [['KNOWN', 507, 'new']]);
  assert.equal(f.api.syncRitmSupplies(true).status, 'current');
  assert.equal(old.name, 'OZON МОСКВА · архив 100');
  assert.equal(JSON.stringify(old.rows), rows);
  assert.equal(JSON.stringify(f.db.getSheetByName('WorkLog').rows), log);
  const after = f.api.getInitialData('RITM-ROLL-200');
  assert.equal(after.shipments.length, 1);
  assert.equal(after.items[0].operations.cut.fact, 0);
  assert.equal(after.items[0].operations.cut.plan, 507);
  assert.throws(
    () =>
      f.api.saveWork({
        shipmentId: before.shipment.id,
        directionId: 'ROLL',
        positionId: before.items[0].positionId,
        employeeId: 'emp',
        operationId: 'cut',
        quantity: 1,
        idempotencyKey: 'blocked-old-work-123',
      }),
    /Поставка не найдена|недоступен/,
  );
  const writes = f.db.getSheetByName('OZON МОСКВА').writes;
  f.api.syncRitmSupplies(false);
  assert.equal(f.db.getSheetByName('OZON МОСКВА').writes, writes);
});

test('hidden or unregistered marked source is never archived to resolve a name conflict', () => {
  for (const registered of [true, false]) {
    const f = fixture();
    f.api.syncRitmSupplies(true);
    const old = f.db.getSheetByName('OZON МОСКВА'),
      writes = old.writes;
    if (registered) f.print.hidden = true;
    else {
      f.source.sheets = [];
      f.props.delete('ritm.assembly.supply.100');
    }
    f.add('OZON МОСКВА', 200, [['NEW', 5, 'new']]);
    assert.equal(f.api.syncRitmSupplies(true).status, 'partial');
    assert.equal(old.name, 'OZON МОСКВА');
    assert.equal(old.writes, writes);
  }
});

test('duplicate source UIDs stop only affected supply and preserve existing destination', () => {
  const f = fixture();
  f.api.syncRitmSupplies(true);
  const sheet = f.db.getSheetByName('OZON МОСКВА');
  const before = JSON.stringify(sheet.rows);
  f.print.rows[5][28] = 'a';
  f.add('Healthy', 200, [['OTHER', 10, 'ok']]);
  const r = f.api.syncRitmSupplies(true);
  assert.equal(r.status, 'partial');
  assert.equal(JSON.stringify(sheet.rows), before);
  assert.ok(f.db.getSheetByName('Healthy'));
});

test('deleting a source supply archives its assembly sheet, hides it from the app, and preserves work history', () => {
  const f = fixture();
  f.add('СПБ', 200, [['OTHER', 20, 'b']]);
  const data = f.api.getInitialData('RITM-ROLL-100');
  f.api.saveWork({
    shipmentId: data.shipment.id,
    directionId: 'ROLL',
    positionId: data.items[0].positionId,
    employeeId: 'emp',
    operationId: 'cut',
    quantity: 12,
    idempotencyKey: 'deleted-supply-work-123',
  });
  const workLog = JSON.stringify(f.db.getSheetByName('WorkLog').rows);
  f.source.sheets = f.source.sheets.filter(
    (sheet) => sheet.getSheetId() !== 100,
  );
  f.api.syncRitmSupplies(true);
  assert.equal(
    f.db.getSheetByName('OZON МОСКВА · архив 100').getRange(1, 1).getNote(),
    'RITM_ASSEMBLY_SUPPLY_V1:100',
  );
  assert.deepEqual(
    Array.from(
      f.api.getInitialData(data.shipment.id).shipments,
      (row) => row.id,
    ),
    ['RITM-ROLL-200'],
  );
  assert.equal(JSON.stringify(f.db.getSheetByName('WorkLog').rows), workLog);
  assert.throws(
    () =>
      f.api.saveWork({
        shipmentId: data.shipment.id,
        directionId: 'ROLL',
        positionId: data.items[0].positionId,
        employeeId: 'emp',
        operationId: 'cut',
        quantity: 1,
        idempotencyKey: 'deleted-supply-work-456',
      }),
    /Поставка не найдена|недоступен/,
  );
});

test('when the last RITM supply is deleted, the app receives an empty state instead of a dead selection', () => {
  const f = fixture();
  const data = f.api.getInitialData();
  f.source.sheets = [];
  f.api.syncRitmSupplies(true);
  const next = f.api.getInitialData(data.shipment.id);
  assert.equal(next.shipment, null);
  assert.deepEqual(Array.from(next.shipments), []);
});

test('a held sync/work lock prevents duplicate runs and Google reads', () => {
  const f = fixture();
  f.locked(true);
  f.offline(ids.printing);
  assert.equal(f.api.syncRitmSupplies(true).status, 'running');
  assert.equal(f.db.sheets.length, 8);
});

test('trigger setup is owner-only and idempotent', () => {
  const f = fixture();
  f.actor('stranger@example.com');
  assert.throws(() => f.api.installRitmSupplySync(), /владельцу/);
  assert.equal(f.triggers.length, 0);
  f.actor('zinovevkirill234@gmail.com');
  f.api.installRitmSupplySync();
  f.api.installRitmSupplySync();
  assert.equal(f.triggers.length, 1);
});

function signedAssemblyEvent(secret, overrides = {}) {
  const event = { v: 1, eventId: randomUUID(), action: 'reconcile', issuedAt: Date.now(), ...overrides };
  return { event, signature: createHmac('sha256', secret).update(JSON.stringify(event)).digest('hex') };
}

test('signed events reconcile immediately and minute sync is removed only after a proven receipt', () => {
  const f = fixture(), secret = 'ab'.repeat(32);
  f.api.installRitmSupplySync();
  f.api.configureRitmEventSync(secret);
  assert.throws(() => f.api.enableRitmEventSync(randomUUID()), /Сначала подтвердите/);
  assert.equal(f.triggers.length, 1);
  f.add('WB Событие', 444, [['KNOWN', 7, 'event-uid']]);
  const body = signedAssemblyEvent(secret);
  const receipt = f.api.receiveRitmAssemblyEvent_(body);
  assert.equal(receipt.status, 'synced');
  assert.ok(f.api.getInitialData().shipments.some(shipment => shipment.name === 'WB Событие'), 'event bypasses recent sync cooldown');
  const writes = f.db.sheets.reduce((sum, sheet) => sum + sheet.writes, 0);
  assert.equal(f.api.receiveRitmAssemblyEvent_(body).ok, true);
  assert.equal(f.db.sheets.reduce((sum, sheet) => sum + sheet.writes, 0), writes, 'a receipt prevents replay');
  const other = { getHandlerFunction: () => 'unrelatedJob' };
  f.triggers.push(other);
  assert.equal(f.api.enableRitmEventSync(body.event.eventId).removedMinuteTriggers, 1);
  assert.deepEqual(f.triggers, [other]);
  assert.throws(() => f.api.installRitmSupplySync(), /минутный триггер не установлен/);
  f.api.restoreRitmMinuteSync();
  assert.equal(f.triggers.length, 2, 'rollback restores only the sync trigger');
  assert.equal(f.print.writes, 0);
  assert.equal(f.db.getSheetByName('WorkLog').writes, 0);
});

test('invalid signatures, expired events and non-owner setup cannot read or change production', () => {
  const f = fixture(), secret = 'ab'.repeat(32);
  f.actor('outsider@example.com');
  assert.throws(() => f.api.configureRitmEventSync(secret), /владельцу/);
  f.actor('zinovevkirill234@gmail.com');
  f.api.configureRitmEventSync(secret);
  f.source.getSheets = () => { throw new Error('an unauthorized event must never reach sources'); };
  assert.throws(() => f.api.receiveRitmAssemblyEvent_(signedAssemblyEvent('cd'.repeat(32))), /unauthorized/);
  assert.throws(() => f.api.receiveRitmAssemblyEvent_(signedAssemblyEvent(secret, { issuedAt: Date.now() - 600000 })), /unauthorized/);
  assert.throws(() => f.api.receiveRitmAssemblyEvent_(signedAssemblyEvent(secret, { action: 'delete' })), /unauthorized/);
  assert.equal(f.db.getSheetByName('WorkLog').writes, 0);
});

test('busy or partial event sync cannot acknowledge delivery or disable the minute fallback', () => {
  const f = linkedDepartmentFixture(), secret = 'ab'.repeat(32);
  f.actor('zinovevkirill234@gmail.com');
  f.api.configureRitmEventSync(secret);
  const body = signedAssemblyEvent(secret);
  f.locked(true);
  assert.equal(f.api.receiveRitmAssemblyEvent_(body).status, 'pending');
  f.locked(false);
  f.print.manifest.ready = false;
  assert.equal(f.api.receiveRitmAssemblyEvent_(body).status, 'pending');
  assert.throws(() => f.api.enableRitmEventSync(body.event.eventId), /Сначала подтвердите/);
  f.print.manifest.ready = true;
  assert.equal(f.api.receiveRitmAssemblyEvent_(body).status, 'synced');
});

test('event deletion archives a common supply only after all source jobs are confirmed absent', () => {
  const f = linkedDepartmentFixture(), secret = 'ab'.repeat(32);
  f.api.syncRitmSupplies(true);
  const initial = f.api.getInitialData(f.shipmentId);
  appendPacking(f, initial.items[0], 1, 'keep-archived-work');
  const work = JSON.stringify(f.db.getSheetByName('WorkLog').rows);
  f.api.configureRitmEventSync(secret);
  f.source.sheets = [];
  f.offline('PUBLIC_TEST_SHEET_ID_0015');
  assert.equal(f.api.receiveRitmAssemblyEvent_(signedAssemblyEvent(secret)).status, 'pending');
  assert.equal(f.api.getInitialData().shipments.length, 1, 'a network failure is never proof of deletion');
  f.offline('');
  f.boxSource.sheets = [];
  assert.equal(f.api.receiveRitmAssemblyEvent_(signedAssemblyEvent(secret)).status, 'synced');
  assert.equal(f.api.getInitialData().shipments.length, 0);
  assert.ok(f.db.sheets.some(sheet => sheet.name.includes('архив')));
  assert.equal(JSON.stringify(f.db.getSheetByName('WorkLog').rows), work);
});

test('an already removed derived tab is retired without blocking notifications for other supplies', () => {
  const f = linkedDepartmentFixture();
  f.api.syncRitmSupplies(true);
  f.db.sheets = f.db.sheets.filter(sheet => sheet.name !== f.manifest.name);
  f.source.sheets = []; f.boxSource.sheets = [];
  const result = f.api.syncRitmSupplies(true);
  assert.equal(result.status, 'current', JSON.stringify(result));
  assert.equal(f.api.getInitialData().shipments.length, 0);
});

test('restoring after interrupted create adopts only a marked sheet', () => {
  const f = fixture();
  const orphan = f.db.insertSheet('OZON МОСКВА');
  orphan.getRange(1, 1).setNote('RITM_ASSEMBLY_SUPPLY_V1:100');
  f.api.syncRitmSupplies(true);
  assert.equal(f.db.sheets.filter((s) => s.name === 'OZON МОСКВА').length, 1);
  assert.equal(f.api.getInitialData().items.length, 2);
});

test('missing quantity stays unknown, and changing SKU cannot inherit previous position history', () => {
  const f = fixture();
  f.print.rows[4][14] = '';
  const before = f.api.getInitialData();
  assert.equal(before.items[0].operations.packing.plan, null);
  f.print.rows[4][4] = 'NEW-SKU';
  f.api.syncRitmSupplies(true);
  assert.notEqual(
    f.api.getInitialData(before.shipment.id).items[0].positionId,
    before.items[0].positionId,
  );
});

test('catalog content is literal text, not executable formulas or HTML', () => {
  const f = fixture();
  f.catalog[0].rows[1][2] = '=IMPORTDATA("example")';
  const data = f.api.getInitialData();
  assert.equal(data.items[0].productName, '=IMPORTDATA("example")');
  assert.ok(html.includes('el.textContent = String(text)'));
});

test('browser script parses and exposes navigation, source labels, dirty-input protection and no direct sheet API', () => {
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.ok(html.includes('id="shipmentSelect"'));
  assert.ok(html.includes('hasUnsavedInput()'));
  assert.ok(html.includes('request !== state.request'));
  assert.ok(
    html.includes(
      '.getInitialData(state.selectedShipmentId, forceSync === true)',
    ),
  );
  assert.ok(html.includes('.getDataVersion()'));
  assert.ok(html.includes('.getPhotos(keys)'));
  assert.match(html, /verifyWriteByKey\(\s*payload\.idempotencyKey/);
  assert.ok(html.includes('photoObserver.observe(img)'));
  assert.ok(html.includes('dataCache[data.shipment.id] = data'));
  assert.ok(
    /\$\('refreshButton'\)\.addEventListener\(\s*'click',\s*\(\) =>\s*loadData\(false, true\)/.test(
      html,
    ),
  );
  assert.ok(html.includes('state.photoCacheEpoch++'));
  assert.ok(html.includes('if (epoch !== state.photoCacheEpoch) return'));
  assert.ok(html.includes('function applySavedWork(result, payload)'));
  assert.ok(html.includes('if (row) row.replaceWith(renderItem(item))'));
  assert.ok(!/showToast\(result\.duplicate[^;]+;\s*loadData\(\);/.test(html));
  assert.ok(!html.includes('sheets.googleapis.com'));
});

test('first paint shows the synced composition while facts load, and keeps work actions disabled until complete', () => {
  const { sandbox, runner, calls, elements } = browserFixture();
  assert.equal(calls[0].method, 'getAssemblyPreview');
  const preview = uiSnapshot();
  preview.environment = 'RITM';
  preview.referenceIncomplete = true;
  preview.items[0].status = 'Проверяем…';
  runner.success(preview);
  assert.equal(vm.runInContext('state.loading', sandbox), false);
  assert.equal(elements.get('dataOrigin').textContent, 'Состав из RITM · проверяем факты и короба');
  assert.equal(elements.get('openWorkButton').disabled, true);
  assert.equal(elements.get('openBoxesButton').disabled, true);
  sandbox.openWorkModal('A1');
  sandbox.openBoxes('A1');
  assert.equal(Boolean(elements.get('workModal').open), false);
  assert.equal(Boolean(elements.get('boxesPanel').open), false);
  assert.equal(calls.at(-1).method, 'getInitialData');
  const complete = uiSnapshot();
  complete.environment = 'RITM';
  runner.success(complete);
  assert.equal(elements.get('openWorkButton').disabled, false);
  assert.equal(elements.get('dataOrigin').textContent, 'Состав из RITM · факты из журнала выбранной поставки');
});

function browserFixture(options = {}) {
  class Element {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.style.setProperty = (name, value) => { this.style[name] = value; };
      const classes = new Set();
      this.classList = {
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        add: (...names) => names.forEach((name) => classes.add(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
      };
      Object.defineProperty(this, 'className', {
        get: () => Array.from(classes).join(' '),
        set: (value) => {
          classes.clear();
          String(value || '').split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
        },
      });
      this.text = '';
      this.value = '';
    }
    set textContent(v) {
      this.text = String(v);
    }
    get textContent() {
      return (
        this.text +
        this.children
          .map((c) => (typeof c === 'string' ? c : c.textContent))
          .join('')
      );
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    appendChild(node) {
      this.append(node);
      return node;
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    insertBefore(node, before) {
      const index = this.children.indexOf(before);
      if (index < 0) this.children.push(node);
      else this.children.splice(index, 0, node);
      return node;
    }
    addEventListener(name, handler) {
      this.handlers ||= {};
      this.handlers[name] = handler;
    }
    setAttribute(name, value) {
      this[name] = value;
    }
    getAttribute(name) {
      return this[name] ?? null;
    }
    removeAttribute(name) {
      delete this[name];
    }
    querySelectorAll() {
      return [];
    }
    focus() {}
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
    }
    reset() {}
    querySelector() {
      return new Element();
    }
    scrollIntoView() {}
    replaceWith(next) {
      this.replacement = next;
    }
  }
  const elements = new Map();
  for (const match of html.matchAll(/id="([^"]+)"/g))
    elements.set(match[1], new Element());
  const calls = [];
  const timers = [];
  const runner = {
    withSuccessHandler(fn) {
      this.success = fn;
      return this;
    },
    withFailureHandler(fn) {
      this.failure = fn;
      return this;
    },
    getInitialData(id) {
      this.lastId = id;
      calls.push({
        method: 'getInitialData',
        args: [id],
        success: this.success,
        failure: this.failure,
      });
    },
    getAssemblyPreview(id) {
      this.lastId = id;
      calls.push({ method: 'getAssemblyPreview', args: [id], success: this.success, failure: this.failure });
    },
    getShipmentProgress(id) {
      calls.push({ method: 'getShipmentProgress', args: [id], success: this.success, failure: this.failure });
    },
    getDataVersion() {
      calls.push({ method: 'getDataVersion', success: this.success, failure: this.failure });
    },
    saveWork(payload) {
      calls.push({
        method: 'saveWork',
        payload,
        success: this.success,
        failure: this.failure,
      });
    },
    getWorkStatus(key) {
      calls.push({
        method: 'getWorkStatus',
        key,
        success: this.success,
        failure: this.failure,
      });
    },
    getPhotos(keys) {
      calls.push({
        method: 'getPhotos',
        keys,
        success: this.success,
        failure: this.failure,
      });
    },
    getBoxesForItem(shipmentId, directionId, positionId) {
      calls.push({ method: 'getBoxesForItem', args: [shipmentId, directionId, positionId], success: this.success, failure: this.failure });
    },
    previewBoxPlacement(payload) {
      calls.push({ method: 'previewBoxPlacement', payload, success: this.success, failure: this.failure });
    },
    saveBoxPlacement(payload) {
      calls.push({ method: 'saveBoxPlacement', payload, success: this.success, failure: this.failure });
    },
    getBoxPlacementStatus(key) {
      calls.push({ method: 'getBoxPlacementStatus', key, success: this.success, failure: this.failure });
    },
    getBoxDetails(...args) {
      calls.push({ method: 'getBoxDetails', args, success: this.success, failure: this.failure });
    },
    getClosedCartons(...args) {
      calls.push({ method: 'getClosedCartons', args, success: this.success, failure: this.failure });
    },
    closeCarton(payload) {
      calls.push({ method: 'closeCarton', payload, success: this.success, failure: this.failure });
    },
    cancelWork(eventId, reason) {
      calls.push({ method: 'cancelWork', eventId, reason, success: this.success, failure: this.failure });
    },
  };
  const sandbox = {
    console,
    Intl,
    Date,
    Set,
    Object,
    Number,
    Option: function (text, value) {
      this.textContent = text;
      this.value = value;
    },
    sessionStorage: {
      getItem: key => options.session?.get(key) ?? null,
      setItem: (key, value) => { options.session ||= new Map(); options.session.set(key, value); },
    },
    localStorage: {
      getItem: key => options.local?.get(key) ?? null,
      setItem: (key, value) => { options.local ||= new Map(); options.local.set(key, value); },
      removeItem: key => options.local?.delete(key),
    },
    document: {
      visibilityState: 'visible',
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
      createElement: () => new Element(),
      createTextNode: (text) => ({ textContent: text }),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {
      setTimeout: (handler) => {
        timers.push(handler);
        return timers.length;
      },
      clearTimeout() {},
      setInterval() {},
      prompt: () => 'Ошибочно выбраны сотрудник или тип работы',
    },
    google: { script: { run: runner } },
  };
  vm.createContext(sandbox);
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], sandbox);
  return { sandbox, runner, elements, calls, timers };
}

function uiSnapshot() {
  const operations = {
    cut: { label: 'Резка на станке', plan: null, fact: null },
    assembly: { label: 'Ручная резка', plan: null, fact: null },
    packing: {
      label: 'Упаковка',
      plan: 100,
      fact: 20,
      ratio: 0.2,
      normPerPerson: 500,
    },
  };
  return {
    shipment: { id: 'A', name: 'Поставка А', directionId: 'D', sourceAvailable: true },
    shipments: [{ id: 'A', name: 'Поставка А', itemCount: 1 }],
    environment: 'TEST ONLY',
    sync: { status: 'current', errors: [] },
    updatedAt: '2026-10-16T07:00:00Z',
    dataVersion: 1,
    employees: [{ id: 'max', name: 'Максим' }],
    operations: [
      { id: 'cut', name: 'Резка на станке' },
      { id: 'assembly', name: 'Ручная резка' },
      { id: 'packing', name: 'Упаковка' },
    ],
    items: [
      {
        shipmentId: 'A',
        directionId: 'D',
        positionId: 'A1',
        sku: 'SKU-1',
        productName: 'Товар',
        productType: 'Наклейки',
        operations,
        workers: [],
        packingRemaining: 80,
        status: 'Упаковка',
      },
    ],
  };
}

function uiBoxesSnapshot() {
  const box = (cartonId, number, itemQuantity = 0) => ({
    cartonId, directionId: 'D', number, boxType: 'M', itemQuantity,
    skuCount: itemQuantity ? 1 : 2, occupied: itemQuantity, pieceCount: itemQuantity,
    fillRatio: 0.2, spaceUsed: 0.2, spaceKnown: true, open: true,
    status: 'Открыт', blockedReason: '',
  });
  return {
    shipment: { id: 'A', name: 'Поставка А', directionId: 'D', direction: 'Москва' },
    item: {
      positionId: 'A1', sku: 'SKU-1', productName: 'Товар', packed: 100, packedKnown: true,
      plan: 100, boxType: 'M', unitsPerBox: 100, normSource: 'БАЗА FBO · OZON · строка 2', normError: '',
    },
    boxes: [box('carton-1', '1мск211', 20), box('carton-2', '1мск212')],
    itemBoxes: [box('carton-1', '1мск211', 20)],
    assigned: 20, available: 80, overAllocated: false, closedCount: 1, dataVersion: 1,
  };
}

test('each static action is bound to a handler or native form submission', () => {
  const f = browserFixture();
  for (const match of html.matchAll(/<button\b([^>]*)>/g)) {
    const attributes = match[1],
      id = attributes.match(/\bid="([^"]+)"/)?.[1];
    if (/\bdisabled\b/.test(attributes) || /type="submit"/.test(attributes))
      continue;
    assert.ok(
      id && f.elements.get(id)?.handlers?.click,
      'Missing click handler for ' + id,
    );
  }
});

test('route-aware modal has a single save and excludes unneeded operations without extra RPC', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  const before = f.calls.length;
  f.sandbox.toggleItem('A1');
  f.elements.get('searchInput').value = 'SKU-1';
  f.sandbox.render();
  f.sandbox.openWorkModal('A1');
  assert.equal(f.elements.get('operationSelect').children.length, 1);
  assert.equal(f.elements.get('operationSelect').children[0].value, 'packing');
  assert.equal(f.elements.get('itemSelect').value, 'A1');
  assert.equal(f.elements.get('workModal').open, true);
  assert.equal(f.calls.length, before);
  assert.ok(!html.includes('worker-entry-controls'));
  assert.ok(!html.includes('function saveInlineWork('));
});

test('work history shows exact event details and offers audited cancellation only for app-owned events', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  const item = vm.runInContext('state.data.items[0]', f.sandbox);
  item.workFactsAvailable = true;
  item.operations.packing.fact = 30;
  item.operations.packing.ratio = 0.3;
  item.workers = [{
    id: 'max', employeeId: 'max', name: 'Максим',
    operations: {
      cut: { quantity: 0, coefficient: 0, coefficientKnown: false, unknownCoefficientCount: 0, eventCount: 0 },
      assembly: { quantity: 0, coefficient: 0, coefficientKnown: false, unknownCoefficientCount: 0, eventCount: 0 },
      packing: { quantity: 30, coefficient: 0.06, coefficientKnown: true, unknownCoefficientCount: 0, eventCount: 1 },
    },
    lastWorkedAt: '2026-10-16T07:30:00Z',
  }];
  item.workRecords = [{
    eventId: 'event-to-cancel', employeeId: 'max', employeeName: 'Максим',
    operationId: 'packing', quantity: 30, norm: 500, coefficient: 0.06,
    createdAt: '2026-10-16T07:30:00Z', source: ' web_app_ritm ', cancelled: false,
  }];
  const panel = f.sandbox.renderWorkerHistory(item);
  assert.equal(panel.hidden, false, 'article work records are visible as soon as its details are expanded');
  assert.match(panel.textContent, /Максим · Упаковка · 30 шт/);
  assert.match(panel.textContent, /кэф\. 0,060/);
  const entry = panel.children.find((child) => child.className.includes('history-event'));
  const actions = entry.children[1];
  const remove = actions.children.find((child) => child.textContent === 'Удалить запись');
  assert.ok(remove);
  remove.handlers.click();
  const cancellation = f.calls.at(-1);
  assert.equal(cancellation.method, 'cancelWork');
  assert.equal(cancellation.eventId, 'event-to-cancel');
  assert.equal(cancellation.reason, 'Исправление: ошибочно выбраны сотрудник или тип работы');
  cancellation.success({ ok: true, alreadyCancelled: false, dataVersion: 2 });
  assert.equal(f.calls.at(-1).method, 'cancelWork', 'successful cancellation does not reload the whole supply');
  assert.equal(item.operations.packing.fact, 0, 'the visible progress updates immediately after the server confirms the cancellation');
  assert.equal(item.workers.length, 0, 'the cancelled event is removed from the employee summary immediately');
  assert.equal(item.workRecords[0].cancelled, true, 'the event remains in history with an audited cancellation state');
  const cancelledPanel = f.sandbox.renderWorkerHistory(item);
  assert.equal(cancelledPanel.hidden, true, 'cancelled-only history is hidden from the article card');
  assert.doesNotMatch(cancelledPanel.textContent, /Отменена/);
  assert.doesNotMatch(cancelledPanel.textContent, /Удалить запись/);

  const otherSource = { ...item.workRecords[0], eventId: 'external-event', source: 'FBO', cancelled: false };
  const readOnlyPanel = f.sandbox.renderWorkerHistory({ ...item, workRecords: [otherSource] });
  assert.doesNotMatch(readOnlyPanel.textContent, /Удалить запись/);
  const mixedPanel = f.sandbox.renderWorkerHistory({ ...item, workRecords: [item.workRecords[0], otherSource] });
  assert.equal(mixedPanel.children.filter((child) => child.className.includes('history-event')).length, 1);
  assert.deepEqual(Array.from(f.sandbox.activeWorkRecords({ workRecords: [item.workRecords[0], otherSource] }), (record) => record.eventId), ['external-event']);
});

test('packing cancellation immediately removes reconciled carton quantities and refreshes snapshots in the background', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  const item = vm.runInContext('state.data.items[0]', f.sandbox);
  item.workFactsAvailable = true;
  item.operations.packing.fact = 20;
  item.boxedQtySnapshot = 20;
  item.boxCountSnapshot = 1;
  item.boxNumbersSnapshot = ['1мск211'];
  item.cartonsSnapshot = [{ cartonId: 'carton-1', number: '1мск211', itemQuantity: 20, pieceCount: 40, occupied: 40, fillRatio: 0.5, spaceKnown: true }];
  item.workRecords = [{
    eventId: 'event-box-correction', employeeId: 'max', employeeName: 'Максим',
    operationId: 'packing', quantity: 20, norm: 500, coefficient: 0.04,
    createdAt: '2026-10-16T07:30:00Z', source: 'WEB_APP_RITM', cancelled: false,
  }];

  const panel = f.sandbox.renderWorkerHistory(item);
  const entry = panel.children.find((child) => child.className.includes('history-event'));
  entry.children[1].children.find((child) => child.textContent === 'Удалить запись').handlers.click();
  f.calls.at(-1).success({
    ok: true, alreadyCancelled: false, dataVersion: 3,
    boxCorrection: { removed: 20, removedByCarton: { 'carton-1': 20 } },
  });

  assert.equal(item.operations.packing.fact, 0);
  assert.equal(item.boxedQtySnapshot, 0);
  assert.equal(item.boxCountSnapshot, 0);
  assert.deepEqual(Array.from(item.cartonsSnapshot), []);
  assert.equal(f.calls.at(-1).method, 'getShipmentProgress', 'the corrected article snapshot refreshes without reloading reference catalogs');
  assert.match(f.elements.get('toast').textContent, /из коробов убрано 20 шт/);
});

test('confirmed cancellation clears the pending button before reconciling an incomplete snapshot', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  const item = vm.runInContext('state.data.items[0]', f.sandbox);
  item.workFactsAvailable = false;
  item.workers = [{
    id: 'max', employeeId: 'max', name: 'Максим',
    operations: {
      cut: { quantity: 0, coefficient: 0, coefficientKnown: false, unknownCoefficientCount: 0, eventCount: 0 },
      assembly: { quantity: 0, coefficient: 0, coefficientKnown: false, unknownCoefficientCount: 0, eventCount: 0 },
      packing: { quantity: 20, coefficient: 0.04, coefficientKnown: true, unknownCoefficientCount: 0, eventCount: 1 },
    },
    lastWorkedAt: '2026-10-16T07:30:00Z',
  }];
  item.workRecords = [{
    eventId: 'event-in-incomplete-snapshot', employeeId: 'max', employeeName: 'Максим',
    operationId: 'packing', quantity: 20, norm: 500, coefficient: 0.04,
    createdAt: '2026-10-16T07:30:00Z', source: 'WEB_APP_RITM', cancelled: false,
  }];

  const panel = f.sandbox.renderWorkerHistory(item);
  const entry = panel.children.find((child) => child.className.includes('history-event'));
  entry.children[1].children.find((child) => child.textContent === 'Удалить запись').handlers.click();
  const cancellation = f.calls.at(-1);
  assert.equal(cancellation.method, 'cancelWork');
  assert.equal(vm.runInContext('state.cancellingEventId', f.sandbox), 'event-in-incomplete-snapshot');

  cancellation.success({ ok: true, alreadyCancelled: false, cancelledAt: '2026-10-19T08:51:13.216Z', dataVersion: 2 });

  assert.equal(vm.runInContext('state.cancellingEventId', f.sandbox), '');
  assert.equal(item.workRecords[0].cancelled, true);
  assert.equal(item.operations.packing.fact, null, 'incomplete source facts remain unknown after the event is removed');
  assert.equal(f.sandbox.renderWorkerHistory(item).textContent.includes('Удаляем…'), false);
  assert.equal(f.calls.at(-1).method, 'getShipmentProgress', 'only a background reconciliation follows the immediate local update');
});

test('retry reconciliation does not put an already-cancelled event back into progress', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openWorkModal('A1');
  f.elements.get('employeeSelect').value = 'max';
  f.elements.get('operationSelect').value = 'packing';
  f.elements.get('quantityInput').value = '30';
  f.sandbox.submitWork({ preventDefault() {} });
  f.calls.at(-1).failure(new Error('Ответ потерян'));
  const status = f.calls.at(-1);
  status.success({
    ok: true, duplicate: true, cancelled: true, eventId: 'cancelled-event',
    shipmentId: 'A', directionId: 'D', positionId: 'A1', dataVersion: 3,
  });
  assert.equal(f.elements.get('workModal').open, false);
  assert.equal(vm.runInContext('state.data.items[0].operations.packing.fact', f.sandbox), 20);
  assert.equal(f.calls.filter((call) => call.method === 'getShipmentProgress').length, 1);
});

test('work modal shows confirmed operation remainder and a local after-save estimate', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openWorkModal('A1');
  f.elements.get('operationSelect').value = 'packing';
  f.elements.get('quantityInput').value = '30';
  f.sandbox.updateNormHint();
  assert.equal(f.elements.get('workRemainingTitle').textContent, 'Осталось: Упаковка');
  assert.equal(f.elements.get('workRemainingValue').textContent, '80 шт.');
  assert.equal(f.elements.get('workRemainingNote').textContent, 'Выполнено 20 из 100 шт.');
  assert.equal(f.elements.get('workRemainingPreview').textContent, 'После этой записи останется 50 шт.');
  assert.equal(f.calls.length, 1, 'remaining and estimate must use the loaded snapshot');

  const missing = uiSnapshot();
  missing.items[0].operations.packing.plan = null;
  missing.items[0].operations.packing.fact = null;
  const unknown = browserFixture();
  unknown.runner.success(missing);
  unknown.sandbox.openWorkModal('A1');
  unknown.elements.get('operationSelect').value = 'packing';
  unknown.sandbox.updateNormHint();
  assert.equal(unknown.elements.get('workRemainingValue').textContent, 'Нет данных');
  assert.match(unknown.elements.get('workRemainingNote').textContent, /не подтверждён/);
});

test('product type is a client-side column and combined filter, supplier shipment badges show Ozon and WB', () => {
  const f = browserFixture();
  const data = uiSnapshot();
  data.shipments = [
    { id: 'A', name: 'OZON Кострома', itemCount: 2 },
    { id: 'B', name: 'WB Москва', itemCount: 1 },
    { id: 'C', name: 'Внутренняя поставка', itemCount: 0 },
  ];
  data.items.push({
    ...structuredClone(data.items[0]),
    positionId: 'A2',
    sku: 'SKU-2',
    productType: 'Магниты',
    boxType: 'М',
    unitsPerBox: 155,
  });
  for (const [index, status] of ['Ручная резка', 'Резка на станке', 'Не начато', 'Упаковка завершена'].entries()) {
    data.items.push({
      ...structuredClone(data.items[0]),
      positionId: 'A' + (index + 3),
      sku: 'SKU-' + (index + 3),
      productType: 'Планеры',
      boxType: index === 0 ? '' : index === 2 ? 'М' : 'О',
      unitsPerBox: index === 0 ? null : 64,
      status,
    });
  }
  data.items[0].boxType = 'О';
  data.items[0].unitsPerBox = 64;
  data.items.forEach(item => {
    item.storeNumbers = item.sku === 'SKU-2' ? ['02'] : item.sku === 'SKU-3' ? [] : ['01'];
  });
  f.runner.success(data);
  const filter = f.elements.get('productTypeFilter');
  assert.deepEqual(filter.children.map((option) => option.value), ['', 'Магниты', 'Наклейки', 'Планеры']);
  assert.deepEqual(f.elements.get('boxTypeFilter').children.map((option) => option.value), ['', 'М', 'О', '__unknown_box_type__']);
  assert.deepEqual(f.elements.get('storeFilter').children.map((option) => option.value), ['', '01', '02', '__store_unknown__']);
  assert.deepEqual(
    f.elements.get('statusFilter').children.map((option) => option.value),
    ['', 'Упаковка завершена', 'Упаковка', 'Ручная резка', 'Резка на станке', 'Не начато'],
  );
  assert.equal(f.elements.get('shipmentList').children[0].children[0].textContent, 'OZON');
  assert.equal(f.elements.get('shipmentList').children[1].children[0].textContent, 'WB');
  assert.match(f.elements.get('articleList').textContent, /Магазин 01/);

  const statusClasses = [];
  const collectStatusClasses = (element) => {
    if (element?.className?.includes('status-')) statusClasses.push(element.className);
    (element?.children || []).forEach((child) => {
      if (typeof child !== 'string') collectStatusClasses(child);
    });
  };
  f.elements.get('articleList').children.forEach(collectStatusClasses);
  for (const status of ['status-packing', 'status-assembly', 'status-cut', 'status-not-started', 'status-done'])
    assert.ok(statusClasses.some((className) => className.includes(status)), 'Missing visible status style ' + status);

  f.elements.get('statusFilterMobile').handlers.change({ target: { value: 'Упаковка завершена' } });
  assert.equal(f.elements.get('statusFilter').value, 'Упаковка завершена');
  assert.equal(f.elements.get('articleList').children.length, 1);
  assert.match(f.elements.get('articleList').children[0].textContent, /SKU-6/);
  assert.equal(f.calls.filter((call) => call.method === 'getInitialData').length, 0);
  f.elements.get('statusFilter').handlers.change({ target: { value: '' } });

  filter.value = 'Магниты';
  filter.handlers.change();
  assert.equal(f.elements.get('articleList').children.length, 1);
  assert.match(f.elements.get('articleList').children[0].textContent, /SKU-2/);
  assert.doesNotMatch(f.elements.get('articleList').children[0].textContent, /SKU-1/);
  assert.equal(f.calls.filter((call) => call.method === 'getInitialData').length, 0);

  filter.value = '';
  const boxTypeFilter = f.elements.get('boxTypeFilter');
  boxTypeFilter.value = 'М';
  boxTypeFilter.handlers.change();
  assert.equal(f.elements.get('articleList').children.length, 2);
  assert.match(f.elements.get('articleList').textContent, /SKU-2/);
  assert.match(f.elements.get('articleList').textContent, /SKU-5/);
  assert.doesNotMatch(f.elements.get('articleList').textContent, /SKU-1/);
  boxTypeFilter.value = '__unknown_box_type__';
  boxTypeFilter.handlers.change();
  assert.equal(f.elements.get('articleList').children.length, 1);
  assert.match(f.elements.get('articleList').textContent, /SKU-3/);
  assert.match(f.elements.get('articleList').textContent, /Тип короба не указан/);
  boxTypeFilter.value = '';
  boxTypeFilter.handlers.change();
  const row = f.elements.get('articleList').children[0];
  assert.match(row.textContent, /Короб О/);
  assert.match(row.textContent, /64 шт\. \/ короб/);
  assert.equal(f.calls.filter((call) => call.method === 'getInitialData').length, 0, 'box type filtering must use the loaded snapshot');

  const storeFilter = f.elements.get('storeFilter');
  storeFilter.value = '02';
  storeFilter.handlers.change();
  assert.equal(f.elements.get('articleList').children.length, 1);
  assert.match(f.elements.get('articleList').textContent, /SKU-2/);
  assert.match(f.elements.get('articleList').textContent, /Магазин 02/);
  storeFilter.value = '__store_unknown__';
  storeFilter.handlers.change();
  assert.equal(f.elements.get('articleList').children.length, 1);
  assert.match(f.elements.get('articleList').textContent, /SKU-3/);
  storeFilter.value = '';
  storeFilter.handlers.change();

  assert.match(html, /\.status-done\s*\{[\s\S]*?background:\s*#d9f8e7/);
  assert.match(html, /\.status-not-started\s*\{[\s\S]*?background:\s*#fff4d9/);
  assert.match(html, /\.mobile-product-type\s*\{[\s\S]*?display:\s*inline-flex/);
  assert.match(html, /\.mobile-box-type\s*\{[\s\S]*?display:\s*inline-flex/);
});

test('work form previews the shift contribution and remaining packaging quota locally, including mixed work', () => {
  const f = browserFixture();
  const snapshot = uiSnapshot();
  snapshot.employeeShift = { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()), available: true, employees: { max: { coefficient: 0.5, unknownCount: 0, eventCount: 1 } } };
  f.runner.success(snapshot);
  f.sandbox.openWorkModal('A1');
  f.elements.get('employeeSelect').value = 'max';
  f.elements.get('operationSelect').value = 'packing';
  f.elements.get('quantityInput').value = '100';
  const before = f.calls.length;
  f.sandbox.updateNormHint();
  assert.match(f.elements.get('normHint').textContent, /за смену: 500/);
  assert.match(f.elements.get('normHint').textContent, /кэф 0,2/);
  assert.match(f.elements.get('normHint').textContent, /до кэфа 1: 250/);
  assert.equal(f.calls.length, before);
  f.sandbox.applySavedWork({ shipmentId: 'A', directionId: 'D', positionId: 'A1', eventId: 'saved-event', employeeId: 'max', employeeName: 'Максим', operationId: 'packing', quantity: 100, coefficient: 0.2, norm: 500, createdAt: new Date().toISOString(), dataVersion: 2 }, {});
  assert.equal(snapshot.employeeShift.employees.max.coefficient, 0.7);
  snapshot.employeeShift.employees.max.unknownCount = 1;
  f.sandbox.updateNormHint();
  assert.match(f.elements.get('normHint').textContent, /остаток смены неизвестен/);
  assert.doesNotMatch(f.elements.get('normHint').textContent, /до кэфа 1:/);
  snapshot.items[0].operations.cut.normPerPerson = 7000 / 3;
  snapshot.items[0].operations.cut.normDetails = { perShift: 7000, multiplier: 3, unit: 'л.', source: 'нормы!B2' };
  f.elements.get('operationSelect').value = 'cut';
  f.sandbox.updateNormHint();
  assert.match(f.elements.get('normHint').textContent, /На изделие: 3 л/);
  assert.match(f.elements.get('normHint').textContent, /0,043/);
});

test('unknown write freezes payload; retry checks status before resending the exact key', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openWorkModal('A1');
  f.elements.get('employeeSelect').value = 'max';
  f.elements.get('operationSelect').value = 'packing';
  f.elements.get('quantityInput').value = '30';
  f.sandbox.submitWork({ preventDefault() {} });
  const first = f.calls.at(-1);
  assert.equal(first.method, 'saveWork');
  f.sandbox.submitWork({ preventDefault() {} });
  assert.equal(f.calls.at(-1), first, 'double-click is ignored');
  first.failure(new Error('Connection lost'));
  const status = f.calls.at(-1);
  assert.equal(status.method, 'getWorkStatus');
  assert.equal(status.key, first.payload.idempotencyKey);
  status.failure(new Error('Still offline'));
  assert.equal(f.elements.get('quantityInput').disabled, true);
  assert.equal(f.elements.get('closeModalButton').disabled, true);
  f.sandbox.closeWorkModal();
  assert.equal(f.elements.get('workModal').open, true);
  f.sandbox.submitWork({ preventDefault() {} });
  const nextStatus = f.calls.at(-1);
  assert.equal(nextStatus.method, 'getWorkStatus');
  nextStatus.success(null);
  const retry = f.calls.at(-1);
  assert.equal(retry.method, 'saveWork');
  assert.deepEqual(retry.payload, first.payload);
});

test('lost save response found in WorkLog completes once and only updates the changed item', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openWorkModal('A1');
  f.elements.get('employeeSelect').value = 'max';
  f.elements.get('operationSelect').value = 'packing';
  f.elements.get('quantityInput').value = '30';
  f.sandbox.submitWork({ preventDefault() {} });
  const first = f.calls.at(-1);
  first.failure(new Error('Response lost'));
  f.calls.at(-1).success({
    ...first.payload,
    eventId: 'recovered-event',
    duplicate: true,
    quantity: 30,
    employeeName: 'Максим',
    coefficient: 0.06,
    createdAt: '2026-10-16T07:30:00Z',
    dataVersion: 2,
  });
  assert.equal(f.elements.get('workModal').open, false);
  assert.equal(
    vm.runInContext('state.data.items[0].operations.packing.fact', f.sandbox),
    50,
  );
  assert.equal(
    vm.runInContext('state.data.items[0].packingRemaining', f.sandbox),
    50,
  );
  assert.equal(
    f.calls.filter((call) => call.method === 'getInitialData').length,
    0,
  );
  first.success({ ...first.payload, quantity: 30 });
  assert.equal(
    vm.runInContext('state.data.items[0].operations.packing.fact', f.sandbox),
    50,
    'late callback does not count twice',
  );
});

test('box drawer loads once, sorts related boxes first and keeps selection and search on the client', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openBoxes('A1');
  const lookup = f.calls.at(-1);
  assert.equal(lookup.method, 'getBoxesForItem');
  assert.deepEqual(lookup.args, ['A', 'D', 'A1']);
  lookup.success(uiBoxesSnapshot());
  assert.equal(f.elements.get('boxCards').children.length, 2);
  assert.equal(f.elements.get('boxProductSku').textContent, 'SKU-1');
  assert.equal(f.elements.get('boxPackedValue').textContent, '100 шт.');
  assert.equal(f.elements.get('boxAssignedValue').textContent, '20 шт.');
  assert.equal(f.elements.get('boxAvailableValue').textContent, '80 шт.');
  const secondCardButton = f.elements.get('boxCards').children[1].children[0];
  secondCardButton.handlers.click();
  f.elements.get('boxSearchInput').value = '211';
  f.elements.get('boxSearchInput').handlers.input();
  assert.equal(f.elements.get('boxCards').children.length, 1);
  assert.equal(f.elements.get('boxCards').children[0].textContent.includes('1мск211'), true);
  assert.equal(f.calls.filter((call) => call.method === 'getBoxesForItem').length, 1, 'selecting a card and searching must not call Sheets');
});

test('carton placement allows mixed box types and still checks the shared capacity', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openBoxes('A1');
  const snapshot = uiBoxesSnapshot();
  snapshot.item.boxType = 'О';
  snapshot.item.unitsPerBox = 64;
  snapshot.item.normError = '';
  snapshot.boxes[0].boxType = 'М';
  snapshot.boxes[0].spaceUsed = 0.65;
  snapshot.boxes[0].fillRatio = 0.65;
  snapshot.itemBoxes = [];
  snapshot.available = 100;
  snapshot.assigned = 0;
  f.calls.at(-1).success(snapshot);
  f.elements.get('boxQuantityInput').value = '20';
  f.sandbox.updateBoxPreview();
  assert.match(f.elements.get('boxGuidance').textContent, /Нажмите один раз/);
  assert.doesNotMatch(f.elements.get('boxCards').textContent, /Нужен тип О/);
  assert.match(f.elements.get('boxFillHint').textContent, /96%/);
  assert.equal(f.elements.get('boxGuidance').className.includes('is-error'), false);
  assert.equal(f.elements.get('preflightBoxButton').disabled, false);
});

test('expanded article shows related carton number and physical fill from its initial snapshot without an RPC', () => {
  const f = browserFixture();
  const data = uiSnapshot();
  data.items[0].boxCountSnapshot = 1;
  data.items[0].boxNumbersSnapshot = ['1мск251'];
  data.items[0].cartonsSnapshot = [{
    cartonId: 'carton-251', number: '1мск251', itemQuantity: 30, pieceCount: 50,
    skuCount: 2, fillRatio: 0.6, spaceKnown: true, open: true, closed: false, status: 'Открыт',
  }];
  f.runner.success(data);
  const beforeExpansion = f.calls.length;
  f.sandbox.toggleItem('A1');
  const row = f.elements.get('articleList').children[0];
  const expandedRow = row.replacement;
  const rendered = expandedRow.textContent;
  assert.ok(rendered.includes('1мск251'));
  assert.match(rendered, /30 шт\. этого артикула/);
  assert.match(rendered, /Заполнено на 60%/);
  assert.equal(f.calls.length, beforeExpansion, 'expanding an article must use its existing supply snapshot');
  assert.equal(f.calls.filter((call) => call.method === 'getBoxesForItem').length, 0);
});

test('expanded team cards scale from one to ten employees and hide operations the article does not need', () => {
  for (const count of [1, 3, 10]) {
    const f = browserFixture();
    const data = uiSnapshot();
    data.items[0].operations.cut.plan = null;
    data.items[0].operations.assembly.plan = null;
    data.items[0].workers = Array.from({ length: count }, (_, index) => ({
      id: 'worker-' + index,
      name: index === 0 ? 'Анна' : 'Сотрудник ' + index,
      lastWorkedAt: '2026-10-16T07:00:00.000Z',
      operations: {
        cut: { quantity: 0, coefficientKnown: false },
        assembly: { quantity: 0, coefficientKnown: false },
        packing: { quantity: index ? 0 : 10, coefficient: 0.02, coefficientKnown: true, unknownCoefficientCount: 0 },
      },
    }));
    f.runner.success(data);
    f.sandbox.toggleItem('A1');
    const expanded = f.elements.get('articleList').children[0].replacement;
    const cards = [];
    let teamPanel;
    const walk = element => {
      if (element?.className === 'worker-card') cards.push(element);
      if (element?.className === 'team-panel') teamPanel = element;
      (element?.children || []).forEach(child => { if (typeof child !== 'string') walk(child); });
    };
    walk(expanded);
    assert.equal(cards.length, count);
    assert.match(teamPanel.textContent, /Упаковка/);
    assert.doesNotMatch(teamPanel.textContent, /Резка на станке|Ручная резка|(?:^|\D)0 шт\./);
  }
});

test('expanded carton shows unknown occupancy as unknown, without a false percentage', () => {
  const f = browserFixture();
  const data = uiSnapshot();
  data.items[0].cartonsSnapshot = [{
    cartonId: 'carton-unknown', number: '1мск299', itemQuantity: 20, pieceCount: 50,
    skuCount: 2, fillRatio: null, spaceKnown: false, blockedReason: 'Не найдена подтверждённая норма для второго артикула.',
    open: true, closed: false, status: 'Открыт',
  }];
  f.runner.success(data);
  f.sandbox.toggleItem('A1');
  const expanded = f.elements.get('articleList').children[0].replacement;
  assert.match(expanded.textContent, /20 шт\. этого артикула/);
  assert.match(expanded.textContent, /Заполненность неизвестна/);
  assert.doesNotMatch(expanded.textContent, /Заполнено на 0%/);
  assert.equal(f.calls.filter((call) => call.method === 'getBoxesForItem').length, 0);
});

test('expanded carton actions load details or select the requested open carton only after an explicit click', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openBoxes('A1', 'carton-2', false);
  f.calls.at(-1).success(uiBoxesSnapshot());
  assert.equal(vm.runInContext('state.selectedBoxId', f.sandbox), 'carton-2');
  assert.equal(f.calls.filter((call) => call.method === 'getBoxDetails').length, 0);

  f.sandbox.openBoxes('A1', 'carton-1', true);
  f.calls.at(-1).success(uiBoxesSnapshot());
  const detailCall = f.calls.at(-1);
  assert.equal(detailCall.method, 'getBoxDetails');
  assert.deepEqual(detailCall.args, ['A', 'D', 'carton-1']);
});

test('box placement adds in one click, then updates only the affected article', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openBoxes('A1');
  f.calls.at(-1).success(uiBoxesSnapshot());
  f.elements.get('boxQuantityInput').value = '30';
  f.elements.get('preflightBoxButton').handlers.click();
  const save = f.calls.at(-1);
  assert.equal(save.method, 'saveBoxPlacement');
  assert.equal(save.payload.mode, 'existing');
  assert.equal(save.payload.cartonId, 'carton-1');
  assert.equal(save.payload.quantity, 30);
  assert.equal('previewId' in save.payload, false);
  assert.equal(f.calls.filter((call) => call.method === 'previewBoxPlacement').length, 0, 'one click does not make a separate preflight call');
  assert.equal(f.calls.filter((call) => call.method === 'saveBoxPlacement').length, 1);
  save.success({
    ok: true, duplicate: false,
    allocation: { allocationId: 'allocation-test', cartonId: 'carton-1', shipmentId: 'A', directionId: 'D', positionId: 'A1', quantity: 30, sku: 'SKU-1' },
    carton: { ...uiBoxesSnapshot().boxes[0], number: '1мск211', occupied: 50, pieceCount: 50, itemQuantity: 50, fillRatio: 0.5, spaceUsed: 0.5 },
    assigned: 50, available: 50, dataVersion: 2,
  });
  assert.equal(vm.runInContext('state.data.items[0].boxedQtySnapshot', f.sandbox), 50);
  assert.equal(vm.runInContext('state.data.items[0].unboxedQtySnapshot', f.sandbox), 50);
  assert.deepEqual(Array.from(vm.runInContext('state.data.items[0].boxNumbersSnapshot', f.sandbox)), ['1мск211']);
  assert.equal(vm.runInContext('state.data.items[0].cartonsSnapshot[0].number', f.sandbox), '1мск211');
  assert.equal(vm.runInContext('state.data.items[0].cartonsSnapshot[0].itemQuantity', f.sandbox), 50);
  assert.equal(f.calls.filter((call) => call.method === 'saveWork').length, 0);
  assert.equal(f.calls.filter((call) => call.method === 'getInitialData').length, 0, 'placement does not reload the whole supply');
});

test('box placement timeout reconciles the operation ID before any retry', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openBoxes('A1');
  f.calls.at(-1).success(uiBoxesSnapshot());
  f.elements.get('boxQuantityInput').value = '30';
  f.elements.get('preflightBoxButton').handlers.click();
  const save = f.calls.at(-1);
  assert.equal(save.method, 'saveBoxPlacement');
  f.timers.at(-1)();
  const status = f.calls.at(-1);
  assert.equal(status.method, 'getBoxPlacementStatus');
  assert.equal(status.key, save.payload.idempotencyKey);
  status.success({
    ok: true,
    duplicate: true,
    allocation: { allocationId: 'allocation-test', cartonId: 'carton-1', shipmentId: 'A', directionId: 'D', positionId: 'A1', quantity: 30, sku: 'SKU-1' },
    carton: { ...uiBoxesSnapshot().boxes[0], occupied: 50, pieceCount: 50, itemQuantity: 50, fillRatio: 0.5, spaceUsed: 0.5 },
    assigned: 30,
    available: 70,
    dataVersion: 2,
  });
  assert.equal(f.calls.filter((call) => call.method === 'saveBoxPlacement').length, 1);
  assert.equal(vm.runInContext('state.boxPending', f.sandbox), null);
});

test('a delayed carton write is discovered automatically after an initially missing status without resending', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openBoxes('A1');
  f.calls.at(-1).success(uiBoxesSnapshot());
  f.elements.get('boxQuantityInput').value = '30';
  f.elements.get('preflightBoxButton').handlers.click();
  const save = f.calls.at(-1);
  assert.equal(save.method, 'saveBoxPlacement');
  f.timers.at(-1)();
  const initialStatus = f.calls.at(-1);
  initialStatus.success(null);
  assert.match(f.elements.get('boxResult').textContent, /автоматически/);
  f.timers.at(-1)();
  const recheck = f.calls.at(-1);
  assert.equal(recheck.method, 'getBoxPlacementStatus');
  assert.equal(recheck.key, save.payload.idempotencyKey);
  recheck.success({ ok: true, duplicate: true, allocation: { cartonId: 'carton-1', positionId: 'A1', quantity: 30 }, carton: { ...uiBoxesSnapshot().boxes[0], itemQuantity: 50 }, assigned: 50, available: 50, itemBoxCount: 1, dataVersion: 2 });
  assert.equal(vm.runInContext('state.boxPending', f.sandbox), null);
  assert.equal(vm.runInContext('state.boxData.assigned', f.sandbox), 50);
  assert.equal(f.calls.filter(call => call.method === 'saveBoxPlacement').length, 1);
  const count = f.calls.length;
  f.timers.at(-1)();
  assert.equal(f.calls.length, count, 'expired status timers cannot revive a finished operation');
});

test('a missing status callback is retried read-only and a late positive response still finishes once', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openBoxes('A1');
  f.calls.at(-1).success(uiBoxesSnapshot());
  vm.runInContext("state.boxPending = { kind: 'placement', payload: { idempotencyKey: 'pending-status-key' } }; reconcileBoxOperation(state.boxPending);", f.sandbox);
  const first = f.calls.at(-1);
  f.timers.at(-1)();
  f.timers.at(-1)();
  const second = f.calls.at(-1);
  assert.equal(second.method, 'getBoxPlacementStatus');
  assert.notEqual(first, second);
  first.success({ ok: true, duplicate: true, allocation: { cartonId: 'carton-1', positionId: 'A1', quantity: 30 }, carton: { ...uiBoxesSnapshot().boxes[0], itemQuantity: 50 }, assigned: 50, available: 50, itemBoxCount: 1, dataVersion: 2 });
  second.success(null);
  assert.equal(vm.runInContext('state.boxPending', f.sandbox), null);
  assert.equal(vm.runInContext('state.boxData.assigned', f.sandbox), 50);
  assert.equal(f.calls.filter(call => call.method === 'saveBoxPlacement').length, 0);
});

test('changed carton data keeps the rejection reason and creates a fresh idempotent request on retry', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openBoxes('A1');
  f.calls.at(-1).success(uiBoxesSnapshot());
  f.elements.get('boxQuantityInput').value = '30';
  f.elements.get('preflightBoxButton').handlers.click();
  const save = f.calls.at(-1);
  assert.equal(save.method, 'saveBoxPlacement');
  const reason = 'Данные изменились после проверки. Обновите короба и проверьте размещение ещё раз.';
  save.success({ ok: false, status: 'not_written', notWritten: true, message: reason });
  assert.equal(f.calls.at(-1).method, 'getBoxesForItem', 'a definite rejection reloads only the selected article and its cartons');
  f.calls.at(-1).success(uiBoxesSnapshot());
  assert.equal(vm.runInContext('state.boxPending', f.sandbox), null);
  assert.equal(vm.runInContext('state.boxUncertain', f.sandbox), false);
  assert.match(f.elements.get('boxError').textContent, /Данные изменились после проверки/);
  assert.equal(f.calls.filter((call) => call.method === 'saveBoxPlacement').length, 1);
  assert.equal(f.calls.filter((call) => call.method === 'getBoxPlacementStatus').length, 0, 'known no-write rejections do not poll status');
  f.elements.get('preflightBoxButton').handlers.click();
  const retry = f.calls.at(-1);
  assert.equal(retry.method, 'saveBoxPlacement');
  assert.notEqual(retry.payload.idempotencyKey, save.payload.idempotencyKey, 'a rejected request gets a new retry identity');
  assert.equal(f.calls.filter((call) => call.method === 'previewBoxPlacement').length, 0);
});

test('new carton mode creates a carton with its first item in one click and selects it afterward', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openBoxes('A1');
  f.calls.at(-1).success(uiBoxesSnapshot());
  f.elements.get('newBoxButton').handlers.click();
  assert.equal(vm.runInContext('state.boxMode', f.sandbox), 'new');
  assert.equal(html.includes('id="boxNumberInput"'), false);
  assert.equal(html.includes('id="boxCapacityInput"'), false);
  f.elements.get('boxQuantityInput').value = '30';
  f.elements.get('preflightBoxButton').handlers.click();
  const save = f.calls.at(-1);
  assert.equal(save.method, 'saveBoxPlacement');
  assert.equal(save.payload.mode, 'new');
  assert.equal(save.payload.cartonId, '');
  assert.equal('previewId' in save.payload, false);
  save.success({
    ok: true, duplicate: false,
    allocation: { allocationId: 'allocation-new', cartonId: 'generated-carton', shipmentId: 'A', directionId: 'D', positionId: 'A1', quantity: 30, sku: 'SKU-1' },
    carton: { cartonId: 'generated-carton', number: '1мск213', boxType: 'M', itemQuantity: 30, occupied: 30, pieceCount: 30, fillRatio: 0.3, spaceUsed: 0.3, open: true },
    assigned: 50, available: 50, itemBoxCount: 2, dataVersion: 2,
  });
  assert.equal(vm.runInContext('state.boxMode', f.sandbox), 'existing');
  assert.equal(vm.runInContext('state.selectedBoxId', f.sandbox), 'generated-carton');
  assert.ok(vm.runInContext('state.boxData.boxes.some(box => box.cartonId === "generated-carton")', f.sandbox));
  assert.equal(f.calls.filter((call) => call.method === 'previewBoxPlacement').length, 0);
  assert.equal(f.calls.filter((call) => call.method === 'createCarton').length, 0);
});

test('closed boxes and composition load only when requested; close requires an explicit confirmation click', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openBoxes('A1');
  f.calls.at(-1).success(uiBoxesSnapshot());
  const before = f.calls.length;
  f.elements.get('closedBoxesButton').handlers.click();
  const closed = f.calls.at(-1);
  assert.equal(closed.method, 'getClosedCartons');
  assert.equal(f.calls.length, before + 1);
  closed.success({ boxes: [], nextCursor: null, hasMore: false });
  f.elements.get('backToOpenBoxes').handlers.click();
  f.elements.get('boxCards').children[0].children[1].children[0].handlers.click();
  const details = f.calls.at(-1);
  assert.equal(details.method, 'getBoxDetails');
  details.success({
    ok: true, shipment: { id: 'A', name: 'Поставка А', directionId: 'D' }, dataVersion: 1,
    carton: { ...uiBoxesSnapshot().boxes[0], contents: [{ sku: 'SKU-1', boxType: 'M', productType: 'Наклейки', quantity: 12 }], pieceCount: 12, fillRatio: 0.12, status: 'Открыт', open: true },
  });
  assert.match(f.elements.get('boxCards').textContent, /SKU-1.*Наклейки.*12 шт\./);
  const manage = f.elements.get('boxCards').children[0].children[2].children[2];
  assert.equal(manage.textContent, 'Управление коробом');
  manage.handlers.click();
  f.elements.get('closeCartonButton').handlers.click();
  assert.equal(f.elements.get('boxCloseConfirmation').hidden, false);
  assert.equal(f.calls.filter((call) => call.method === 'closeCarton').length, 0);
  f.elements.get('confirmCloseCartonButton').handlers.click();
  assert.equal(f.calls.at(-1).method, 'closeCarton');
  f.calls.at(-1).success({ ok: true, dataVersion: 2 });
  assert.equal(f.elements.get('boxDetails').hidden, true);
});

test('missing save callback checks the operation after timeout without a blind replay', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openWorkModal('A1');
  f.elements.get('employeeSelect').value = 'max';
  f.elements.get('operationSelect').value = 'packing';
  f.elements.get('quantityInput').value = '30';
  f.sandbox.submitWork({ preventDefault() {} });
  const first = f.calls.at(-1);
  f.timers.at(-1)();
  assert.equal(f.calls.at(-1).method, 'getWorkStatus');
  assert.equal(f.calls.at(-1).key, first.payload.idempotencyKey);
  assert.equal(f.calls.filter((call) => call.method === 'saveWork').length, 1);
});

test('rendered progress treats omitted RPC fields, null and invalid numbers as unknown', () => {
  const { sandbox } = browserFixture();
  for (const value of [undefined, null, NaN, 'invalid']) {
    const result = sandbox.renderStage(
      { label: 'Резка на станке', fact: value, ratio: value, plan: 170 },
      'cut',
    );
    assert.ok(result.getAttribute('aria-label').includes('нет записей'));
    assert.ok(
      !result.textContent.includes('NaN') &&
        !result.textContent.includes('не число'),
    );
    assert.ok(!result.textContent.includes('%'));
  }
  const known = sandbox.renderStage(
    { label: 'Резка на станке', fact: 85, ratio: 0.5, plan: 170 },
    'cut',
  );
  assert.ok(known.textContent.includes('85'));
  assert.ok(known.textContent.includes('50%'));
});

test('shipment sync warning remains visible through fact refresh and clears only after a clean sync status', () => {
  const f = browserFixture();
  const initial = uiSnapshot();
  initial.sync = { status: 'partial', errors: ['Ошибка подтверждения состава'] };
  initial.items[0].workRecords = [];
  initial.items[0].cartonsSnapshot = [];
  f.runner.success(initial);
  const warning = f.elements.get('networkError');
  assert.ok(warning.className.includes('visible'));

  const progress = {
    ...initial,
    shipmentId: 'A',
    referenceKey: undefined,
    sync: { status: 'partial', errors: ['Ошибка подтверждения состава'] },
  };
  f.sandbox.refreshProgress();
  f.calls.at(-1).success(progress);
  assert.ok(warning.className.includes('visible'));
  assert.equal(warning.textContent, 'Ошибка подтверждения состава');

  f.sandbox.refreshProgress();
  f.calls.at(-1).success({ ...progress, sync: { status: 'current', errors: [] } });
  assert.ok(!warning.className.includes('visible'));
});

test('shipment readiness counts only packing and carton fill, shows over-plan packing, and excludes cutting', () => {
  const { sandbox } = browserFixture();
  const item = {
    operations: {
      cut: { plan: 3000, fact: 0 },
      assembly: { plan: 3000, fact: 0 },
      packing: { plan: 3000, fact: 3039 },
    },
    boxedQtySnapshot: 3000,
  };
  assert.equal(sandbox.shipmentReadiness([item]).percent, 101);

  item.boxedQtySnapshot = null;
  item.cartonsSnapshot = [];
  assert.equal(sandbox.shipmentReadiness([item]).percent, 50);

  item.operations.cut.fact = 3000;
  item.operations.assembly.fact = 3000;
  assert.equal(sandbox.shipmentReadiness([item]).percent, 50);
});

test('failed supply switch retains prior data and restores its selectable identity', () => {
  const { sandbox, runner, elements, calls } = browserFixture();
  runner.success({
    shipment: { id: 'A', name: 'Поставка А' },
    shipments: [
      { id: 'A', name: 'Поставка А', environment: 'RITM' },
      { id: 'B', name: 'Поставка Б', environment: 'RITM' },
    ],
    environment: 'RITM',
    items: [],
    updatedAt: '2026-10-15T10:00:00Z',
    sync: { status: 'current', errors: [] },
  });
  sandbox.switchShipment('B');
  assert.equal(runner.lastId, 'B');
  assert.equal(calls.at(-1).method, 'getAssemblyPreview');
  runner.failure(new Error('Сеть недоступна'));
  assert.equal(calls.at(-1).method, 'getInitialData');
  runner.failure(new Error('Сеть недоступна'));
  assert.equal(elements.get('shipmentSelect').value, 'A');
  assert.equal(elements.get('shipmentSelect').disabled, false);
  assert.equal(elements.get('topShipment').textContent, 'Поставка А');
  assert.equal(elements.get('networkError').textContent, 'Сеть недоступна');
});

test('normal shipment reads use the local mirror; only an explicit forced refresh scans printing sources', () => {
  const f = fixture();
  f.api.syncRitmSupplies(true);
  let sourceReads = 0;
  f.source.getSheets = () => {
    sourceReads += 1;
    return [f.print];
  };
  f.api.getInitialData('RITM-ROLL-100');
  assert.equal(sourceReads, 0);
  f.api.getInitialData('RITM-ROLL-100', true);
  assert.ok(sourceReads > 0);
});

test('switching back to a cached shipment paints immediately and refreshes progress only', () => {
  const { sandbox, runner, elements, calls } = browserFixture();
  const shipments = [
    { id: 'A', name: 'Поставка А', environment: 'RITM' },
    { id: 'B', name: 'Поставка Б', environment: 'RITM' },
  ];
  const data = (id, name) => ({
    shipment: { id, name },
    shipments,
    environment: 'RITM',
    items: [],
    employees: [],
    operations: [],
    updatedAt: '2026-10-15T10:00:00Z',
    sync: { status: 'current', errors: [] },
  });
  runner.success(data('A', 'Поставка А'));
  sandbox.switchShipment('B');
  runner.success(data('B', 'Поставка Б'));
  sandbox.switchShipment('A');
  assert.equal(elements.get('topShipment').textContent, 'Поставка А');
  assert.equal(elements.get('shipmentSelect').value, 'A');
  assert.equal(calls.at(-1).method, 'getShipmentProgress');
  assert.equal(calls.at(-1).args[0], 'A');
  assert.equal(vm.runInContext('state.loading', sandbox), false);
  assert.equal(vm.runInContext('state.refreshing', sandbox), false);
});

test('other shipment snapshots warm in the background for the first tab switch', () => {
  const { sandbox, runner, calls, timers } = browserFixture();
  const shipments = [
    { id: 'A', name: 'Поставка А', environment: 'RITM' },
    { id: 'B', name: 'Поставка Б', environment: 'RITM' },
  ];
  const data = id => ({
    shipment: { id, name: id === 'A' ? 'Поставка А' : 'Поставка Б' },
    shipments,
    environment: 'RITM',
    items: [],
    employees: [],
    operations: [],
    sync: { status: 'current', errors: [] },
    dataVersion: 4,
    updatedAt: '2026-10-15T10:00:00Z',
  });
  runner.success(data('A'));
  timers.at(-1)();
  const prefetch = calls.at(-1);
  assert.equal(prefetch.method, 'getInitialData');
  assert.deepEqual(prefetch.args, ['B']);
  prefetch.success(data('B'));
  assert.equal(vm.runInContext("state.dataCache.B.shipment.id", sandbox), 'B');
});

test('progress refresh reads no external catalogs or printing sources and preserves cancellations', () => {
  const f = fixture();
  f.api.syncRitmSupplies(true);
  const initial = f.api.getInitialData('RITM-ROLL-100');
  const item = initial.items[0];
  appendPacking(f, item, 17, 'progress-only-event');
  const catalogReads = f.catalogOpenCount();
  const writes = () => f.db.sheets.reduce((count, sheet) => count + sheet.writes, 0);
  const writesBefore = writes();
  f.source.getSheets = () => { throw new Error('progress must not scan printing sources'); };
  f.offline(ids.catalog);
  const next = f.api.getShipmentProgress(initial.shipment.id);
  assert.equal(next.referenceKey, initial.referenceKey);
  assert.equal(next.items[0].operations.packing.fact, 17);
  assert.equal(next.items[0].workers[0].name, 'ОляЖ 2');
  assert.equal(Object.hasOwn(next.items[0], 'photoUrl'), false);
  assert.equal(Object.hasOwn(next.items[0], 'label'), false);
  assert.equal(Object.hasOwn(next.items[0].operations.packing, 'normDetails'), false);
  assert.equal(f.catalogOpenCount(), catalogReads);
  assert.equal(writes(), writesBefore, 'background updates are read-only');
  f.api.cancelWork('progress-only-event', 'Контрактный тест');
  const cancelled = f.api.getShipmentProgress(initial.shipment.id);
  assert.equal(cancelled.items[0].operations.packing.fact, 0);
  assert.equal(cancelled.items[0].workRecords[0].cancelled, true);
  assert.equal(cancelled.items[0].workers.length, 0);
  assert.throws(() => f.api.getShipmentProgress('deleted-shipment'), /недоступна/);
});

function progressSnapshot(data, version = 2) {
  return { shipmentId: data.shipment.id, referenceKey: data.referenceKey,
    dataVersion: version, updatedAt: new Date().toISOString(), employeeShift: data.employeeShift,
    items: structuredClone(data.items).map(item => ({ ...item, workRecords: item.workRecords || [] })) };
}

test('progress publishes a newly synced supply list without another catalog read', () => {
  const f = fixture();
  const initial = f.api.getInitialData();
  f.add('WB Новая поставка', 333, [['KNOWN', 5, 'new-supply-uid']]);
  f.api.syncRitmSupplies(true);
  const readsBefore = f.catalogOpenCount();
  const progress = f.api.getShipmentProgress(initial.shipment.id);
  assert.ok(progress.shipments.some(shipment => shipment.name === 'WB Новая поставка' && shipment.itemCount === 1));
  assert.equal(f.catalogOpenCount(), readsBefore);
});

test('new supplies are selectable before a slow reference load finishes, and late responses cannot undo the switch', () => {
  const f = browserFixture();
  const initial = uiSnapshot();
  f.runner.success(initial);
  f.sandbox.refreshProgress();
  const progress = f.calls.at(-1);
  const update = progressSnapshot(initial, 4);
  update.referenceKey = 'changed-list';
  update.shipments = [...initial.shipments, { id: 'B', name: 'WB Новая поставка', environment: 'RITM', itemCount: 1 }];
  progress.success(update);
  const oldFullLoad = f.calls.at(-1);
  assert.equal(oldFullLoad.method, 'getInitialData');
  assert.equal(f.elements.get('shipmentCount').textContent, '2');
  assert.ok(f.elements.get('shipmentList').children.every(button => !button.disabled));
  f.sandbox.requestShipment('B');
  assert.equal(f.calls.at(-1).method, 'getAssemblyPreview');
  const other = uiSnapshot();
  other.shipment = { ...other.shipment, id: 'B', name: 'WB Новая поставка' };
  other.dataVersion = 4;
  f.calls.at(-1).success(other);
  assert.equal(vm.runInContext('state.data.shipment.id', f.sandbox), 'B');
  oldFullLoad.success(initial);
  assert.equal(vm.runInContext('state.data.shipment.id', f.sandbox), 'B');
});

test('incomplete previews never enter the complete shipment cache and a failed load can recover', () => {
  const f = browserFixture();
  const preview = uiSnapshot();
  preview.referenceIncomplete = true;
  f.runner.success(preview);
  assert.equal(vm.runInContext('Boolean(state.dataCache.A)', f.sandbox), false);
  f.calls.at(-1).failure(new Error('temporary full load failure'));
  f.sandbox.loadData(true);
  assert.equal(f.calls.at(-1).method, 'getInitialData', 'recovery needs complete references rather than progress-only facts');
});

test('background refresh leaves work controls enabled and never overwrites an open form', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.refreshProgress();
  const refresh = f.calls.at(-1);
  assert.equal(refresh.method, 'getShipmentProgress');
  assert.equal(vm.runInContext('state.loading', f.sandbox), false);
  f.sandbox.openWorkModal('A1');
  f.elements.get('quantityInput').value = '19';
  refresh.success(progressSnapshot(uiSnapshot()));
  assert.equal(f.elements.get('workModal').open, true);
  assert.equal(f.elements.get('quantityInput').value, '19');
  assert.equal(vm.runInContext('state.progressDirty', f.sandbox), true);
  assert.equal(vm.runInContext('state.data.items[0].operations.packing.fact', f.sandbox), 20);
});

test('late background response cannot roll back a local write even after the form closes', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.refreshProgress();
  const staleRead = f.calls.at(-1);
  f.sandbox.markLocalMutation();
  f.sandbox.applySavedWork({ shipmentId: 'A', directionId: 'D', positionId: 'A1', eventId: 'new-local', employeeId: 'max', employeeName: 'Максим', operationId: 'packing', quantity: 10, coefficient: 0.02, norm: 500, dataVersion: 3 }, {});
  staleRead.success(progressSnapshot(uiSnapshot(), 2));
  assert.equal(vm.runInContext('state.data.items[0].operations.packing.fact', f.sandbox), 30);
  assert.equal(vm.runInContext('state.dataVersion', f.sandbox), 3);
  assert.equal(vm.runInContext('state.progressDirty', f.sandbox), true);
  f.sandbox.refreshProgress();
  const next = progressSnapshot(uiSnapshot(), 4);
  next.items[0].operations.packing.fact = 47;
  f.calls.at(-1).success(next);
  assert.equal(vm.runInContext('state.data.items[0].operations.packing.fact', f.sandbox), 47);
  assert.equal(vm.runInContext('state.data.items[0].operations.packing.normPerPerson', f.sandbox), 500);
  assert.equal(vm.runInContext('state.progressDirty', f.sandbox), false);
});

test('failed progress refresh retains quantities and a second request is coalesced', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.refreshProgress();
  f.sandbox.refreshProgress();
  assert.equal(f.calls.filter(call => call.method === 'getShipmentProgress').length, 1);
  f.calls.at(-1).failure(new Error('Журнал временно недоступен'));
  assert.equal(vm.runInContext('state.data.items[0].operations.packing.fact', f.sandbox), 20);
  assert.equal(f.elements.get('networkError').textContent, 'Журнал временно недоступен');
  assert.equal(vm.runInContext('state.progressLoading', f.sandbox), false);
});

test('five employee tabs keep independent names despite shared local storage and retain their name on reload', () => {
  const local = new Map([['ritmAssemblyEmployee', 'old-shared-name']]);
  const tabs = Array.from({ length: 5 }, () => {
    const session = new Map();
    return { session, fixture: browserFixture({ session, local }) };
  });
  tabs.forEach(({ fixture: f }, index) => f.sandbox.rememberEmployee('employee-' + index));
  tabs.forEach(({ fixture: f, session }, index) => {
    assert.equal(f.sandbox.rememberedEmployee(), 'employee-' + index);
    const reloaded = browserFixture({ session, local });
    assert.equal(reloaded.sandbox.rememberedEmployee(), 'employee-' + index);
  });
  assert.equal(local.get('ritmAssemblyEmployee'), 'old-shared-name', 'employee identity is no longer written to shared local storage');
});

test('a late progress read never resurrects a cancelled event', () => {
  const f = browserFixture();
  const initial = uiSnapshot();
  const item = initial.items[0];
  item.workFactsAvailable = true;
  item.workRecords = [{ eventId: 'cancel-during-read', shipmentId: 'A', positionId: 'A1', employeeId: 'max', employeeName: 'Максим', operationId: 'packing', quantity: 20, cancelled: false, source: 'WEB_APP_TEST' }];
  f.runner.success(initial);
  f.sandbox.refreshProgress();
  const stale = f.calls.at(-1);
  const oldSnapshot = progressSnapshot(initial, 1);
  f.sandbox.cancelWorkRecord(item, item.workRecords[0]);
  f.calls.at(-1).success({ ok: true, eventId: 'cancel-during-read', dataVersion: 2 });
  stale.success(oldSnapshot);
  assert.equal(item.workRecords[0].cancelled, true);
  assert.equal(item.operations.packing.fact, 0);
  assert.equal(vm.runInContext('state.progressDirty', f.sandbox), true);
});

test('malformed progress cannot partially replace known facts with invalid quantities', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.refreshProgress();
  const invalid = progressSnapshot(uiSnapshot());
  invalid.items[0].operations.packing.fact = -1;
  f.calls.at(-1).success(invalid);
  assert.equal(vm.runInContext('state.data.items[0].operations.packing.fact', f.sandbox), 20);
  assert.match(f.elements.get('networkError').textContent, /Не удалось подтвердить/);
});

test('carton refresh preserves entered quantity and never replaces an uncertain placement', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.openBoxes('A1');
  f.calls.at(-1).success(uiBoxesSnapshot());
  f.elements.get('boxQuantityInput').value = '17';
  f.elements.get('refreshBoxesButton').handlers.click();
  assert.equal(f.calls.at(-1).method, 'getBoxesForItem');
  f.calls.at(-1).success(uiBoxesSnapshot());
  assert.equal(f.elements.get('boxQuantityInput').value, '17');
  vm.runInContext('state.boxUncertain = true', f.sandbox);
  const before = f.calls.length;
  f.elements.get('refreshBoxesButton').handlers.click();
  assert.equal(f.calls.length, before);
  assert.equal(f.elements.get('boxQuantityInput').value, '17');
});

test('manual reference refresh allows entry and defers its response until the form closes', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.loadData(false, true);
  const full = f.calls.at(-1);
  assert.equal(full.method, 'getInitialData');
  assert.equal(vm.runInContext('state.loading', f.sandbox), false);
  assert.equal(vm.runInContext('state.refreshing', f.sandbox), true);
  f.sandbox.openWorkModal('A1');
  f.elements.get('quantityInput').value = '17';
  full.success(uiSnapshot());
  assert.equal(f.elements.get('quantityInput').value, '17');
  assert.equal(f.elements.get('workModal').open, true);
  assert.equal(vm.runInContext('state.referenceDirty', f.sandbox), true);
  f.sandbox.closeWorkModal();
  const retry = f.calls.at(-1);
  assert.equal(retry.method, 'getInitialData');
  assert.notEqual(retry, full);
  retry.success(uiSnapshot());
  assert.equal(vm.runInContext('state.referenceDirty', f.sandbox), false);
  assert.equal(vm.runInContext('state.refreshing', f.sandbox), false);
});

test('changed supply references request a full read without locking work on the existing supply', () => {
  const f = browserFixture();
  f.runner.success(uiSnapshot());
  f.sandbox.refreshProgress();
  const changed = progressSnapshot(uiSnapshot());
  changed.referenceKey = 'new-plan-or-shipment';
  f.calls.at(-1).success(changed);
  assert.equal(f.calls.at(-1).method, 'getInitialData');
  assert.equal(vm.runInContext('state.loading', f.sandbox), false);
  f.sandbox.openWorkModal('A1');
  assert.equal(f.elements.get('workModal').open, true);
});


test('marketplace norm caches never mix OZON and WB capacities of the same SKU', () => {
  const f = fixture();
  const wb = f.catalog[1];
  wb.rows[1][13] = 'L'; wb.rows[1][14] = 50; wb.rows[1][15] = '50 L';
  const ozon = f.api.boxNormsForSkus_(['KNOWN'], false, 'OZON').KNOWN;
  const wbReads = wb.rangeReads;
  const ozonReads = f.catalog[0].rangeReads;
  const wildberries = f.api.boxNormsForSkus_(['KNOWN'], false, 'WB').KNOWN;
  assert.deepEqual([ozon.boxType, ozon.unitsPerBox], ['M', 100]);
  assert.deepEqual([wildberries.boxType, wildberries.unitsPerBox], ['L', 50]);
  assert.equal(wbReads, 0, 'OZON lookup cannot scan WB norms');
  assert.equal(f.catalog[0].rangeReads, ozonReads, 'WB lookup cannot scan OZON norms');
  assert.equal(f.api.boxNormsForSkus_(['KNOWN'], false, 'OZON').KNOWN.unitsPerBox, 100);
  assert.equal(f.api.cachedBoxNormsForSkus_(['KNOWN'], 'OZON').KNOWN.unitsPerBox, 100);
  assert.equal(f.api.cachedBoxNormsForSkus_(['KNOWN'], 'WB').KNOWN.unitsPerBox, 50);
  const unknown = f.api.boxNormsForSkus_(['KNOWN'], true, '').KNOWN;
  assert.equal(unknown.confirmed, false);
  assert.match(unknown.reason, /названию поставки/);
  assert.equal(f.api.storeNumbersForItems_([{ sku: 'KNOWN', source: '' }], true)['*|KNOWN'], null);
});

test('WB supply uses WB product details, store and capacity even with a stale OZON catalog marker', () => {
  const f = fixture();
  f.print.name = 'WB Казань';
  const wb = f.catalog[1];
  wb.rows[1][13] = 'L'; wb.rows[1][14] = 50; wb.rows[1][15] = '50 L'; wb.rows[1][19] = '2';
  let data = f.api.getInitialData();
  let item = data.items.find(row => row.sku === 'KNOWN');
  assert.equal(item.productName, 'Другое название');
  assert.deepEqual([item.boxType, item.unitsPerBox], ['L', 50]);
  assert.deepEqual(Array.from(item.storeNumbers), ['2']);
  const mirror = f.db.getSheetByName('WB Казань');
  mirror.rows[1][mirror.rows[0].indexOf('Источник каталога')] = 'OZON';
  data = f.api.getInitialData('RITM-ROLL-100');
  item = data.items.find(row => row.sku === 'KNOWN');
  assert.deepEqual(Array.from(item.storeNumbers), ['2']);
  appendPacking(f, item, 20, 'wb-marketplace-pack');
  const overview = f.api.getBoxesForItem(item.shipmentId, item.directionId, item.positionId);
  assert.deepEqual([overview.item.boxType, overview.item.unitsPerBox], ['L', 50]);
  const payload = placementPayload(item, { mode: 'new', quantity: 10 });
  const saved = previewAndSave(f.api, payload);
  assert.equal(saved.preview.spaceNorm.unitsPerBox, 50);
  assert.equal(saved.preview.carton.number, '2каз1');
  assert.equal(f.api.getBoxPlacementStatus(payload.idempotencyKey).carton.spaceKnown, true);
  assert.equal(f.api.getBoxDetails(item.shipmentId, item.directionId, saved.result.carton.cartonId).carton.spaceKnown, true);
  assert.ok(f.catalog.every(sheet => sheet.writes === 0));
});

test('a catalog record on the other marketplace never enriches or confirms a missing article', () => {
  const f = fixture();
  f.catalog[0].rows.splice(1);
  const data = f.api.getInitialData();
  const item = data.items.find(row => row.sku === 'KNOWN');
  assert.ok(item, 'missing catalog details never remove an article from its supply');
  assert.equal(item.productName, '');
  assert.equal(item.unitsPerBox, null);
  assert.match(item.boxNormError, /OZON/);
  const catalog = f.api.readRitmCatalog_();
  assert.equal(catalog.has('OZON|KNOWN'), false);
  assert.equal(catalog.get('WB|KNOWN').name, 'Другое название');
  assert.equal(catalog.has('KNOWN'), false, 'there is no unscoped fallback entry');
});

test('manual refresh bypasses cached operation norms and roster without changing historical work', () => {
  const f = fixture();
  const initial = f.api.getInitialData();
  const item = initial.items[0];
  const norms = f.db.getSheetByName('OperationNorms');
  norms.rows.push([item.positionId, 'packing', 900]);
  assert.equal(f.api.getInitialData().items[0].operations.packing.normPerPerson, null, 'ordinary display reuses its reference cache');
  let fresh = f.api.getInitialData(initial.shipment.id, true);
  assert.equal(fresh.items[0].operations.packing.normPerPerson, 900);
  norms.rows[1][2] = 1000;
  f.db.getSheetByName('Employees').rows.push(['new-person', 'Даша', true]);
  const workBefore = JSON.stringify(f.db.getSheetByName('WorkLog').rows);
  fresh = f.api.getInitialData(initial.shipment.id, true);
  assert.equal(fresh.items[0].operations.packing.normPerPerson, 1000);
  assert.ok(fresh.employees.some(employee => employee.name === 'Даша'));
  assert.equal(JSON.stringify(f.db.getSheetByName('WorkLog').rows), workBefore);
  assert.ok(f.catalog.every(sheet => sheet.writes === 0));
});

test('fresh conflicting or missing carton norms cannot resurrect an obsolete cached capacity', () => {
  const f = fixture();
  assert.equal(f.api.boxNormsForSkus_(['KNOWN'], false, 'OZON').KNOWN.unitsPerBox, 100);
  f.catalog[0].rows[1][11] = 300;
  const fresh = f.api.boxNormsForSkus_(['KNOWN'], true, 'OZON').KNOWN;
  assert.equal(fresh.confirmed, false);
  assert.equal(f.api.cachedBoxNormsForSkus_(['KNOWN'], 'OZON').KNOWN.confirmed, false);
  assert.equal(f.api.boxNormsForSkus_(['KNOWN'], false, 'OZON').KNOWN.confirmed, false);
  f.catalog[0].rows[1][12] = '300 M';
  assert.equal(f.api.boxNormsForSkus_(['KNOWN'], true, 'OZON').KNOWN.unitsPerBox, 300);
  assert.equal(f.api.cachedBoxNormsForSkus_(['KNOWN'], 'OZON').KNOWN.unitsPerBox, 300);
});

test('manual refresh updates unchanged OZON and WB supplies using their own current catalog and shift norms', () => {
  for (const marketplace of ['OZON', 'WB']) {
    const f = fixture();
    f.print.name = marketplace + ' Проверка';
    const shifts = addTypeShiftNorms(f, 3);
    const before = f.api.getInitialData();
    const tab = f.catalog[marketplace === 'OZON' ? 0 : 1];
    const headers = tab.rows[0];
    tab.rows[1][headers.indexOf('Кол-во вида')] = 300;
    tab.rows[1][headers.indexOf('В коробке')] = '300 M';
    tab.rows[1][headers.indexOf('Магазин')] = '2';
    shifts.rows[1][2] = 975;
    const after = f.api.getInitialData(before.shipment.id, true);
    assert.equal(after.items[0].positionId, before.items[0].positionId);
    assert.equal(after.items[0].unitsPerBox, 300);
    assert.equal(after.items[0].operations.packing.normPerPerson, 975);
    assert.deepEqual(Array.from(after.items[0].storeNumbers), ['2']);
    assert.equal(after.items[0].operations.packing.plan, before.items[0].operations.packing.plan);
    assert.ok(f.catalog.every(sheet => sheet.writes === 0));
  }
});
