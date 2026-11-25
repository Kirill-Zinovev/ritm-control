const DB_ID = '1dn7a7s-Ev9vLuNE2W8lECVwXCdpq8DXvC5Gt_O1sBbI';
const TABLES = Object.freeze({
  shipments: 'Shipments',
  items: 'Items',
  employees: 'Employees',
  norms: 'OperationNorms',
  workLog: 'WorkLog',
  workCorrections: 'WorkLogCorrections',
  photos: 'Photos',
  cartons: 'Cartons',
  cartonContents: 'CartonContents',
});
const WORK_CORRECTION_HEADERS = Object.freeze([
  'correctionId', 'eventId', 'action', 'createdAt', 'actor', 'reason',
]);
const OPERATION_LABELS = Object.freeze({
  // Keep the stored operation IDs for WorkLog compatibility. In the real
  // production workflow, `cut` is machine cutting and legacy `assembly` is
  // the hand-cutting operation; there is no separate assembly operation.
  cut: 'Резка на станке',
  assembly: 'Ручная резка',
  packing: 'Упаковка',
});
const OPERATION_PLAN_FIELDS = Object.freeze({
  cut: 'План порезки, шт',
  assembly: 'План сборки, шт',
  packing: 'План упаковки, шт',
});
const RITM_DATA_VERSION = 'ritm.assembly.dataVersion';
const LABEL_FBO_ID = '1F3RFu4xC1Y6MMt-AjwL-D7QyJZr_NmzsvE_eaL-acWs';
const LABEL_OZON_CODES_ID = '1YTQQ1Mg9kVv7EOQiN6wOvkvnHvsiXcwbhYOERUPy8rQ';
const LABEL_CACHE_PREFIX = 'ritm.assembly.labels.v1.';
const BOX_VIEW_PREFIX = 'Короба · ';
const BOX_VIEW_MARKER = 'RITM_ASSEMBLY_BOX_VIEW_V1';

function isBlueBuildingEmployee_(name) {
  const key = String(name || '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+\d+$/, '').trim();
  return ['оля', 'оляж', 'вика', 'артем', 'давид', 'арина', 'соня', 'кристина', 'даша', 'карина'].includes(key);
}

function isCollectorWorkSource_(source) {
  return ['WEB_APP_RITM', 'WEB_APP_TEST'].includes(String(source || '').trim().toUpperCase());
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('RITM · Сборка поставок')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

const RITM_EVENT_SECRET = 'ritm.assembly.eventSecret';
const RITM_EVENT_RECEIPTS = 'ritm.assembly.eventReceipts';
const RITM_EVENT_MODE = 'ritm.assembly.eventMode';
const RITM_CONTROL_API_BASE = 'ritm.assembly.controlApiBase';
const RITM_CONTROL_API_DEFAULT = 'https://ritm-erp.zinovevkirill234.chatgpt.site';

function doPost(e) {
  let result;
  try {
    const raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || raw.length > 250000) throw new Error('invalid_request');
    result = receiveRitmAssemblyEvent_(JSON.parse(raw));
  } catch (_) { result = { ok: false, status: 'rejected' }; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function receiveRitmAssemblyEvent_(body) {
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty(RITM_EVENT_SECRET);
  const event = body && body.event;
  const expectedKeys = event && event.action === 'transfer'
    ? 'action,eventId,issuedAt,transfer,v'
    : event && event.action === 'shipment-lock'
      ? 'action,eventId,issuedAt,locked,shipmentIds,v'
      : event && event.action === 'assembly-only-remove'
        ? 'action,eventId,issuedAt,itemId,positionId,shipmentId,v'
        : 'action,eventId,issuedAt,v';
  if (!/^[a-f0-9]{64}$/i.test(secret || '') || !event ||
      Object.keys(event).sort().join(',') !== expectedKeys ||
      event.v !== 1 || !['reconcile', 'transfer', 'shipment-lock', 'assembly-only-remove'].includes(event.action) || !/^[a-f0-9-]{36}$/i.test(event.eventId || '') ||
      !Number.isSafeInteger(event.issuedAt) || Math.abs(Date.now() - event.issuedAt) > 300000 ||
      !/^[a-f0-9]{64}$/i.test(body.signature || '')) throw new Error('unauthorized_event');
  const expected = Utilities.computeHmacSha256Signature(JSON.stringify(event), secret, Utilities.Charset.UTF_8)
    .map(value => ('0' + ((value + 256) % 256).toString(16)).slice(-2)).join('');
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ body.signature.toLowerCase().charCodeAt(i);
  if (different) throw new Error('unauthorized_event');
  const receipts = parseSyncJson_(props.getProperty(RITM_EVENT_RECEIPTS), []);
  const priorReceipt = receipts.find(receipt => receipt.id === event.eventId);
  if (priorReceipt) return Object.assign({ ok: true, status: 'synced', eventId: event.eventId }, priorReceipt.result || {});
  if (event.action === 'assembly-only-remove') return receiveAssemblyOnlyRemoval_(event, props);
  if (event.action === 'shipment-lock') {
    try { return receiveRitmShipmentLockEvent_(event, props); }
    catch (error) { return { ok: false, status: 'rejected', eventId: event.eventId, reason: String(error && error.message || 'Ошибка обработки замка').slice(0, 200) }; }
  }
  if (event.action === 'transfer') return receiveRitmAssemblyTransfer_(event);
  // A new event bypasses the manual-refresh cooldown, but never the sync lease
  // or the matching ready manifests of both production departments.
  const sync = syncRitmSupplies(false, true);
  if (sync.status !== 'current' || (sync.errors || []).length) return { ok: false, status: 'pending', eventId: event.eventId };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: false, status: 'pending', eventId: event.eventId };
  try {
    appendRitmEventReceipt_(props, { id: event.eventId, at: Date.now() });
  } finally { lock.releaseLock(); }
  return { ok: true, status: 'synced', eventId: event.eventId };
}

function assemblyOnlyTombstoneKey_(positionId) {
  return 'ritm.assembly.deleted.' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(positionId))).slice(0, 42);
}
function assertAssemblyOnlyNotDeleted_(positionId) {
  if (String(positionId || '').indexOf('|manual:') >= 0 && PropertiesService.getScriptProperties().getProperty(assemblyOnlyTombstoneKey_(positionId))) throw new Error('Товар удалён из поставки. Обновите список.');
}
function receiveAssemblyOnlyRemoval_(event, props) {
  if (!/^[a-f0-9-]{36}$/i.test(String(event.itemId || '')) || String(event.positionId || '').indexOf(String(event.shipmentId) + '|manual:' + event.itemId + '|') !== 0) return {ok:false,status:'rejected',eventId:event.eventId};
  const lock=LockService.getScriptLock(); if(!lock.tryLock(5000))return {ok:false,status:'pending',eventId:event.eventId};
  try {
    const db=SpreadsheetApp.openById(DB_ID), log=db.getSheetByName(TABLES.workLog), contents=db.getSheetByName(TABLES.cartonContents);
    if(!log||!contents || [log,contents].some(sheet => sheet.getLastColumn()<1 || !sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(String).includes('positionId'))) return {ok:false,status:'pending',eventId:event.eventId};
    const wanted=new Set([String(event.positionId)]);
    if(readRowsByKey_(log,'positionId',wanted).length || readRowsByKey_(contents,'positionId',wanted).length) return {ok:false,status:'rejected',reason:'item_has_work',eventId:event.eventId};
    props.setProperty(assemblyOnlyTombstoneKey_(event.positionId),JSON.stringify({itemId:event.itemId,shipmentId:event.shipmentId,removedAt:new Date().toISOString()}));
    appendRitmEventReceipt_(props,{id:event.eventId,at:Date.now()}); bumpDataVersion_();
    return {ok:true,status:'synced',eventId:event.eventId};
  } catch (_) {return {ok:false,status:'pending',eventId:event.eventId};} finally {lock.releaseLock();}
}

function ritmShipmentLockPropertyKey_(shipmentId) {
  const id = String(shipmentId || '').trim();
  if (!/^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i.test(id))
    throw new Error('Не удалось подтвердить идентификатор поставки для замка.');
  return 'ritm.assembly.shipmentLock.' + id;
}

function receiveRitmShipmentLockEvent_(event, props) {
  if (typeof event.locked !== 'boolean' || !Array.isArray(event.shipmentIds) ||
      event.shipmentIds.length < 1 || event.shipmentIds.length > 20 ||
      new Set(event.shipmentIds).size !== event.shipmentIds.length)
    throw new Error('invalid_shipment_lock');
  const keys = event.shipmentIds.map(ritmShipmentLockPropertyKey_);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, status: 'pending', eventId: event.eventId };
  try {
    const receipts = parseSyncJson_(props.getProperty(RITM_EVENT_RECEIPTS), []);
    const prior = receipts.find(receipt => receipt.id === event.eventId);
    if (prior) return Object.assign({ ok: true, status: 'synced', eventId: event.eventId }, prior.result || {});
    const changedAt = new Date().toISOString();
    keys.forEach((key, index) => {
      if (event.locked) props.setProperty(key, JSON.stringify({ locked: true, eventId: event.eventId, shipmentId: event.shipmentIds[index], changedAt }));
      else props.deleteProperty(key);
    });
    const result = { locked: event.locked, shipmentIds: event.shipmentIds.slice() };
    appendRitmEventReceipt_(props, { id: event.eventId, at: Date.now(), result });
    return Object.assign({ ok: true, status: 'synced', eventId: event.eventId }, result);
  } finally { lock.releaseLock(); }
}

// Read only the lock signals received from RITM; never expose other script properties.
function getShipmentLockIndicators(shipmentIds) {
  if (!Array.isArray(shipmentIds) || shipmentIds.length > 500) throw new Error('Некорректный список поставок.');
  const props = PropertiesService.getScriptProperties();
  const states = {};
  shipmentIds.forEach(value => {
    const id = String(value || '');
    if (isAssemblyStock_(id)) { states[id]='not_locked_locally'; return; }
    let key;
    try { key = ritmShipmentLockPropertyKey_(id); } catch (_) { states[id] = 'unknown'; return; }
    const raw = props.getProperty(key);
    if (!raw) { states[id] = 'not_locked_locally'; return; }
    const lock = parseSyncJson_(raw, null);
    states[id] = lock && lock.locked === true && String(lock.shipmentId) === id ? 'locked' : 'unknown';
  });
  return states;
}

function assertLocalShipmentUnlocked_(shipmentId) {
  if (isAssemblyStock_(shipmentId)) return;
  const key = ritmShipmentLockPropertyKey_(shipmentId);
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return;
  const state = parseSyncJson_(raw, null);
  if (!state || state.locked !== true || String(state.shipmentId) !== String(shipmentId))
    throw new Error('Не удалось проверить локальный замок поставки. Операция не записана; обратитесь к руководителю.');
  throw new Error('Поставка закрыта для сборки руководителем. Работа не записана; обратитесь к руководителю.');
}

function assertRitmShipmentUnlocked_(shipmentId) {
  if (isAssemblyStock_(shipmentId)) return;
  const id = String(shipmentId || '').trim();
  assertLocalShipmentUnlocked_(id);
  let result;
  try { result = ritmControlApiRequest_('GET', '/api/assembly-controls?shipmentId=' + encodeURIComponent(id)); }
  catch (_) { throw new Error('Не удалось проверить замок поставки в RITM. Операция не записана; повторите после восстановления связи.'); }
  const state = result && result.shipmentLock;
  if (!result || result.ok !== true || !state || String(state.shipmentId) !== id || typeof state.locked !== 'boolean' ||
      !['locking', 'locked', 'unlocking', 'unlocked'].includes(String(state.status || '')))
    throw new Error('RITM не подтвердил состояние замка поставки. Операция не записана; обновите данные и повторите.');
  if (state.locked) throw new Error('Поставка закрыта для сборки руководителем. Работа не записана; обратитесь к руководителю.');
}

function requireAssemblyOwner_() {
  if (Session.getActiveUser().getEmail() !== 'zinovevkirill234@gmail.com' || Session.getEffectiveUser().getEmail() !== 'zinovevkirill234@gmail.com')
    throw new Error('Настройка синхронизации доступна только владельцу проекта.');
}

function configureRitmEventSync(secret) {
  requireAssemblyOwner_();
  const props = PropertiesService.getScriptProperties();
  if (secret === undefined) secret = props.getProperty(RITM_EVENT_SECRET);
  if (!/^[a-f0-9]{64}$/i.test(secret || '')) throw new Error('Нужен отдельный ключ событийной синхронизации.');
  if (props.getProperty(RITM_EVENT_MODE) === 'events' && props.getProperty(RITM_EVENT_SECRET) !== secret)
    throw new Error('Активный ключ нельзя менять без согласованной настройки отправителя.');
  if (props.getProperty(RITM_EVENT_SECRET) !== secret) props.setProperty(RITM_EVENT_RECEIPTS, '[]');
  props.setProperty(RITM_EVENT_SECRET, secret);
  return { configured: true, triggerPreserved: true };
}

function enableRitmEventSync(proofEventId) {
  requireAssemblyOwner_();
  const props = PropertiesService.getScriptProperties();
  const receipts = parseSyncJson_(props.getProperty(RITM_EVENT_RECEIPTS), []);
  const receipt = receipts.slice().reverse()
    .find(row => (!proofEventId || row.id === proofEventId) && (proofEventId || Date.now() - row.at < 900000));
  if (!props.getProperty(RITM_EVENT_SECRET) || !receipt) throw new Error('Сначала подтвердите доставку события из RITM. Минутный триггер сохранён.');
  const triggers = ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === 'syncRitmSupplies');
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  props.setProperty(RITM_EVENT_MODE, 'events');
  const result = { mode: 'events', removedMinuteTriggers: triggers.length, proofEventId: receipt.id };
  console.log(JSON.stringify(result));
  return result;
}

function restoreRitmMinuteSync() {
  requireAssemblyOwner_();
  PropertiesService.getScriptProperties().deleteProperty(RITM_EVENT_MODE);
  return installRitmSupplySync();
}

function getInitialData(shipmentId, forceSync) {
  return getAssemblySnapshot_(shipmentId, forceSync, false);
}

// A read-only navigation index. Grouping never changes a supply, position,
// journal event, lock or carton identity. Stores come from the owning catalog.
function getAssemblyDirections(fresh) {
  const db = SpreadsheetApp.openById(DB_ID);
  const shipments = assemblyShipments_(db);
  const props = PropertiesService.getScriptProperties().getProperties();
  const revision = ritmFingerprint_(Object.keys(props).filter(key => key.indexOf(RITM_SYNC_PREFIX) === 0)
    .sort().map(key => [key, props[key]]));
  const key = 'ritm.assembly.directions.v2.' + revision;
  const cache = CacheService.getScriptCache();
  if (fresh !== true) {
    const saved = parseSyncJson_(cache.get(key), null);
    if (saved && Array.isArray(saved.groups)) return saved;
  }
  const errors = [], sources = shipments.filter(shipment => !shipment.stockTask).map(shipment => {
    try { return { shipment, rows: readShipmentItems_(db, shipment, true) }; }
    catch (_) { errors.push(String(shipment.shipmentId)); return { shipment, rows: [] }; }
  });
  const lookups = sources.flatMap(source => source.rows.map(row => ({
    sku: row['Артикул'], source: shipmentMarketplace_(source.shipment),
  })));
  let stores = Object.create(null);
  try { stores = storeNumbersForItems_(lookups, fresh === true); }
  catch (_) { errors.push('stores'); }
  const groups = new Map();
  sources.forEach(({ shipment, rows }) => {
    const direction = cartonDirection_(shipment);
    const byStore = new Map();
    rows.forEach(row => {
      const found = stores[storeNumberSkuKey_(row['Артикул'], shipmentMarketplace_(shipment))];
      const store = Array.isArray(found) && found.length === 1 ? String(found[0]) : '';
      if (!byStore.has(store)) byStore.set(store, []);
      byStore.get(store).push(String(row.positionId));
    });
    if (!byStore.size) byStore.set('', []);
    byStore.forEach((positionIds, store) => {
      // Unknown destinations/stores remain source-specific rather than guessed.
      const id = direction && store ? direction.key + '|store:' + store : 'source:' + shipment.shipmentId + '|store:' + store;
      if (!groups.has(id)) groups.set(id, { id, name: direction ? direction.label : shipment['Название поставки'],
        marketplace: shipmentMarketplace_(shipment), store, directionKey: direction ? direction.key : '', sources: [] });
      groups.get(id).sources.push({ id: String(shipment.shipmentId), name: String(shipment['Название поставки']),
        sourceAvailable: shipment.sourceAvailable !== false, positionIds });
    });
  });
  groups.set('RITM-STOCK-WAREHOUSE',{id:'RITM-STOCK-WAREHOUSE',name:'Запасы',stockTask:true,marketplace:'OZON',store:'',directionKey:'',sources:[{id:'RITM-STOCK-WAREHOUSE',name:'Запасы склад · Бокс и рулонная печать',sourceAvailable:true,positionIds:[]}]});
  const result = { groups: Array.from(groups.values()), errors, revision, updatedAt: new Date().toISOString() };
  const json = JSON.stringify(result);
  if (!errors.length && json.length < 90000) cache.put(key, json, 300);
  return result;
}

// Return the already-synchronized composition first. The browser can paint the
// shipment immediately, then request authoritative work, carton and norm facts.
function getAssemblyPreview(shipmentId) {
  if (isAssemblyStock_(shipmentId)) return getAssemblySnapshot_(shipmentId,false,false);
  const props = PropertiesService.getScriptProperties();
  const sync = parseSyncJson_(props.getProperty(RITM_SYNC_STATE), null);
  if (!sync) throw new Error('Сначала обновите состав поставки.');
  const db = SpreadsheetApp.openById(DB_ID);
  const shipments = assemblyShipments_(db);
  const activeShipment = (shipmentId ? shipments.find(row => String(row.shipmentId) === String(shipmentId)) : null) || shipments[0];
  const readVersion = getDataVersion();
  if (!activeShipment) return {
    version: 'ritm-supply-sync-1', environment: 'RITM', sync, dataVersion: readVersion,
    updatedAt: new Date().toISOString(), shipments: [], shipment: null,
    operations: Object.keys(OPERATION_LABELS).map(id => ({ id, name: OPERATION_LABELS[id] })),
    employees: [], employeeShift: null, items: [], referenceIncomplete: true,
  };
  const rows = readShipmentItems_(db, activeShipment, true)
    .filter(row => String(row.shipmentId) === String(activeShipment.shipmentId) && row.directionId === activeShipment.directionId);
  const items = rows.map(row => {
    const operations = {};
    Object.keys(OPERATION_LABELS).forEach(operationId => {
      operations[operationId] = {
        id: operationId, label: OPERATION_LABELS[operationId],
        plan: toNumberOrNull_(row[OPERATION_PLAN_FIELDS[operationId]]),
        fact: null, ratio: null, overBy: null, coefficient: null,
        unknownCoefficientCount: 0, normPerPerson: null, normDetails: null,
      };
    });
    return {
      shipmentId: String(row.shipmentId), directionId: String(row.directionId),
      direction: String(row['Направление'] || ''), positionId: String(row.positionId),
      sku: String(row['Артикул'] || ''), productName: String(row['Название товара'] || ''),
      stockTask: row.stockTask === true, productionDepartment: row.productionDepartment || '', productionPrint: row.productionPrint || '', productionCut: row.productionCut || '', productionArchivedAt: row.productionArchivedAt || '',
      productType: String(row['Вид товара'] || ''), boxType: '', unitsPerBox: null,
      boxNormError: '', photoAssetKey: String(row.photoAssetKey || ''),
      photoUrl: safeRitmPhotoUrl_(row['Фото']), sheetsPerUnit: toNumberOrNull_(row['Листов на штуку']),
      packNormPerPerson: toNumberOrNull_(row['Норма упаковки, шт/чел']),
      boxCountSnapshot: null, boxNumbersSnapshot: [], cartonsSnapshot: null,
      boxedQtySnapshot: null, unboxedQtySnapshot: null, source: String(row['Источник'] || ''),
      assemblyOnly: row['Источник'] === 'RITM_ASSEMBLY_ONLY', assemblyOnlyComment: String(row.assemblyOnlyComment || ''), assemblyOnlyCreatedBy: String(row.assemblyOnlyCreatedBy || ''),
      workFactsAvailable: false, operations, workers: [], workRecords: [],
      packingRemaining: null, packingOverBy: null, status: 'Проверяем…',
      label: { status: 'not_checked' },
    };
  });
  const marketplace = labelMarketplace_(activeShipment.marketplace || activeShipment['Маркетплейс'], activeShipment['Название поставки']);
  return {
    version: 'ritm-supply-sync-1', environment: 'RITM', sync, dataVersion: readVersion,
    referenceKey: '', updatedAt: new Date().toISOString(), referenceIncomplete: true,
    shipments: shipments.map(row => ({ id: String(row.shipmentId), name: String(row['Название поставки']), stockTask: row.stockTask === true, environment: row.environment, sourceAvailable: row.sourceAvailable !== false, itemCount: Number.isSafeInteger(row.itemCount) ? row.itemCount : null })),
    shipment: {
      id: String(activeShipment.shipmentId), name: String(activeShipment['Название поставки'] || ''),
      directionId: String(activeShipment.directionId), direction: String(activeShipment['Направление'] || ''),
      sourceUrl: activeShipment.sourceUrl || '',
      assemblyUrl: activeShipment.sheetId ? 'https://docs.google.com/spreadsheets/d/' + DB_ID + '/edit#gid=' + activeShipment.sheetId : '',
      stockTask: activeShipment.stockTask === true,
      sourceAvailable: activeShipment.sourceAvailable !== false, marketplace, labelSourceStatus: 'not_checked',
    },
    operations: Object.keys(OPERATION_LABELS).map(id => ({ id, name: OPERATION_LABELS[id] })),
    employees: [], employeeShift: null, items,
  };
}

// Frequent coworker updates read only the assembly store. Product/label catalogs,
// shift reference norms and the printing-source scan belong to the full load.
function getShipmentProgress(shipmentId) {
  if (!String(shipmentId || '').trim()) throw new Error('Выберите поставку перед обновлением.');
  return getAssemblySnapshot_(shipmentId, false, true);
}

// Configure once from the Apps Script editor as the project owner. The value is
// an origin only; all requests are signed with the already configured event key.
function configureRitmControlApi(baseUrl) {
  requireAssemblyOwner_();
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+chatgpt\.site$/i.test(value))
    throw new Error('Разрешён только HTTPS-адрес RITM Sites без пути и параметров.');
  PropertiesService.getScriptProperties().setProperty(RITM_CONTROL_API_BASE, value);
  return { configured: true, origin: value };
}

function getAssemblyControlTasks(shipmentId, directionId) {
  if (isAssemblyStock_(shipmentId) && directionId === 'ROLL') return {ok:true,available:true,shipmentId,shipmentLock:{shipmentId,locked:false,status:'unlocked'},controls:[]};
  try {
    const db = SpreadsheetApp.openById(DB_ID);
    const shipment = requireRitmShipment_(db, shipmentId, directionId);
    const result = ritmControlApiRequest_('GET', '/api/assembly-controls?shipmentId=' + encodeURIComponent(String(shipment.shipmentId)));
    if (!result || result.ok !== true || !Array.isArray(result.controls) || result.controls.length > 250)
      throw new Error('Список задач не прошёл проверку.');
    const shipmentLock = result.shipmentLock;
    if (!shipmentLock || String(shipmentLock.shipmentId) !== String(shipment.shipmentId) || typeof shipmentLock.locked !== 'boolean' ||
        !['locking', 'locked', 'unlocking', 'unlocked'].includes(String(shipmentLock.status || '')))
      throw new Error('Состояние замка поставки не подтверждено.');
    const allowedKinds = ['quality_check', 'notification', 'instruction'];
    const allowedTriggers = ['shipment_received', 'before_packing', 'before_box_close'];
    const controls = result.controls.filter(control => control &&
      (Array.isArray(control.shipmentIds) ? control.shipmentIds : [control.shipmentId]).map(String).includes(String(shipment.shipmentId)) &&
      /^[a-f0-9-]{36}$/i.test(String(control.id || '')) &&
      ['shipment', 'article'].includes(control.scope) &&
      allowedKinds.includes(control.kind) && ['attention', 'urgent'].includes(control.priority) &&
      allowedTriggers.includes(control.trigger) && ['active', 'completed', 'acknowledged'].includes(control.status) &&
      (control.scope !== 'article' || String(control.article || '').trim())
    ).map(control => ({
      id: String(control.id), shipmentId: String(shipment.shipmentId), scope: control.scope,
      article: control.scope === 'article' ? String(control.article) : '',
      kind: control.kind, priority: control.priority, trigger: control.trigger,
      title: String(control.title || '').slice(0, 90), note: String(control.note || '').slice(0, 320),
      status: control.status, completedAt: String(control.completedAt || ''),
      completedBy: control.completedBy && typeof control.completedBy === 'object'
        ? { employeeName: String(control.completedBy.employeeName || '').slice(0, 100) }
        : null,
    }));
    return { ok: true, available: true, shipmentId: String(shipment.shipmentId), shipmentLock: {
      shipmentId: String(shipmentLock.shipmentId), locked: shipmentLock.locked, status: String(shipmentLock.status),
    }, controls };
  } catch (error) {
    return { ok: false, available: false, controls: [], message: String(error && error.message || 'Контроль поставки временно недоступен.').slice(0, 240) };
  }
}

function completeAssemblyControlTask(payload) {
  if (!payload || !/^[a-f0-9-]{36}$/i.test(String(payload.controlId || '')) || !String(payload.positionId || '').trim() || !String(payload.employeeId || '').trim())
    throw new Error('Выберите задачу, артикул и сотрудника.');
  const db = SpreadsheetApp.openById(DB_ID);
  const shipment = requireRitmShipment_(db, payload.shipmentId, payload.directionId);
  const item = readShipmentItems_(db, shipment).find(row =>
    String(row.shipmentId) === String(shipment.shipmentId) &&
    String(row.directionId) === String(shipment.directionId) &&
    String(row.positionId) === String(payload.positionId)
  );
  if (!item) throw new Error('Артикул не найден в выбранной поставке. Обновите данные.');
  assertRitmShipmentUnlocked_(shipment.shipmentId);
  const employee = readTable_(db, TABLES.employees).find(row =>
    String(row.employeeId) === String(payload.employeeId) &&
    (row.Активен === true || String(row.Активен).toLowerCase() === 'true') &&
    isBlueBuildingEmployee_(row['Имя'])
  );
  if (!employee) throw new Error('Сотрудник отсутствует в активном списке сборщиков.');
  const result = ritmControlApiRequest_('POST', '/api/assembly-controls/complete', {
    controlId: String(payload.controlId), shipmentId: String(shipment.shipmentId),
    positionId: String(item.positionId), article: String(item['Артикул'] || ''),
    employeeId: String(employee.employeeId), employeeName: String(employee['Имя'] || ''),
  });
  if (!result || result.ok !== true || !result.control || String(result.control.id) !== String(payload.controlId) || !['completed', 'acknowledged'].includes(result.control.status))
    throw new Error('Сервер не подтвердил выполнение задачи. Обновите список перед повтором.');
  return { ok: true, control: result.control, duplicate: result.duplicate === true };
}

// Owner-run diagnostic: requests only the configured RITM homepage and changes no data.
function authorizeRitmExternalRequests() {
  const base = String(PropertiesService.getScriptProperties().getProperty(RITM_CONTROL_API_BASE) || RITM_CONTROL_API_DEFAULT).replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+\.chatgpt\.site$/i.test(base)) throw new Error('Адрес RITM не настроен.');
  const response = UrlFetchApp.fetch(base, { muteHttpExceptions: true, followRedirects: false });
  Logger.log('RITM HTTP: ' + response.getResponseCode());
  return response.getResponseCode();
}

function ritmControlApiRequest_(method, path, body) {
  const props = PropertiesService.getScriptProperties();
  const base = String(props.getProperty(RITM_CONTROL_API_BASE) || RITM_CONTROL_API_DEFAULT).replace(/\/+$/, '');
  const secret = props.getProperty(RITM_EVENT_SECRET) || '';
  if (!/^https:\/\/[a-z0-9.-]+\.chatgpt\.site$/i.test(base) || !/^[a-f0-9]{64}$/i.test(secret))
    throw new Error('Связь с задачами RITM не настроена.');
  if (!['GET', 'POST'].includes(method) || (!(method === 'GET' && path === '/api/assembly-stocks') && !['/api/assembly-controls?shipmentId=', '/api/assembly-controls/complete', '/api/assembly-only-items?shipmentId='].some(prefix => path.indexOf(prefix) === 0)))
    throw new Error('Запрошено неподдерживаемое действие контроля.');
  const rawBody = method === 'POST' ? JSON.stringify(body || {}) : '';
  const bodyHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, rawBody, Utilities.Charset.UTF_8)
    .map(value => ('0' + ((value + 256) % 256).toString(16)).slice(-2)).join('');
  const timestamp = String(Date.now()), nonce = Utilities.getUuid().toLowerCase();
  const message = JSON.stringify([1, method, path, timestamp, nonce, bodyHash]);
  const signature = Utilities.computeHmacSha256Signature(message, secret, Utilities.Charset.UTF_8)
    .map(value => ('0' + ((value + 256) % 256).toString(16)).slice(-2)).join('');
  const options = {
    method: method.toLowerCase(), contentType: 'application/json', muteHttpExceptions: true,
    followRedirects: false,
    headers: { 'x-ritm-assembly-at': timestamp, 'x-ritm-assembly-nonce': nonce, 'x-ritm-assembly-signature': signature },
  };
  if (method === 'POST') options.payload = rawBody;
  let response;
  try { response = UrlFetchApp.fetch(base + path, options); }
  catch (error) {
    const details = String(error && error.message || error || '');
    if (/script\.external_request|permission|authori[sz]/i.test(details))
      throw new Error('Apps Script не разрешил внешний запрос к RITM. Владелец должен подтвердить разрешение на внешние запросы.');
    if (/too many times|quota|rate limit/i.test(details))
      throw new Error('Google Apps Script ограничил запрос к RITM. Состояние задачи не изменено; попробуйте позже.');
    throw new Error(method === 'POST'
      ? 'Не удалось связаться с RITM по сети. Состояние задачи не изменено; обновите список.'
      : 'Не удалось загрузить задачи из RITM. Обновите список позже.');
  }
  const status = response.getResponseCode();
  let value;
  try { value = JSON.parse(response.getContentText()); } catch (_) { throw new Error('RITM вернул неподтверждённый ответ.'); }
  if (status < 200 || status >= 300 || value.ok !== true)
    throw new Error(String(value.message || 'RITM не подтвердил действие.').slice(0, 240));
  return value;
}

function getAssemblySnapshot_(shipmentId, forceSync, progressOnly) {
  // Switching shipments should read only the local assembly mirror. The owner-installed
  // one-minute trigger keeps that mirror fresh; a manual refresh may force a source scan.
  const props = PropertiesService.getScriptProperties();
  // Capture the version before reading ranges. A write that races this snapshot then
  // remains visible to the next cheap version poll instead of being marked as included.
  const readVersion = getDataVersion();
  const savedSync = parseSyncJson_(props.getProperty(RITM_SYNC_STATE), null);
  if (progressOnly && !savedSync && !isAssemblyStock_(shipmentId)) throw new Error('Сначала обновите состав поставки.');
  const sync = isAssemblyStock_(shipmentId) ? {status:'current',errors:[]} : forceSync === true || !savedSync
    ? syncRitmSupplies(forceSync === true)
    : savedSync;
  const db = SpreadsheetApp.openById(DB_ID);
  const shipments = assemblyShipments_(db);
  // If a selected source was deleted between polls, move to the next live supply
  // instead of leaving the app stuck on a dead shipment ID.
  const activeShipment = (shipmentId ? shipments.find(row => String(row.shipmentId) === String(shipmentId)) : null) || shipments[0];
  if (!progressOnly && forceSync === true && activeShipment && activeShipment.environment === 'RITM') {
    const marketplace = labelMarketplace_(activeShipment.marketplace || activeShipment['Маркетплейс'], activeShipment['Название поставки']);
    if (marketplace) invalidateLabelIndexCache_(marketplace);
  }
  if (progressOnly && (!activeShipment || String(activeShipment.shipmentId) !== String(shipmentId)))
    throw new Error('Поставка больше недоступна. Обновите список поставок.');
  if (!activeShipment) return {
    version: 'ritm-supply-sync-1', environment: 'RITM', sync,
    dataVersion: readVersion, updatedAt: new Date().toISOString(), shipments: [], shipment: null,
    operations: Object.keys(OPERATION_LABELS).map(id => ({ id, name: OPERATION_LABELS[id] })),
    employees: [], items: [],
  };

  const itemRows = readShipmentItems_(db, activeShipment)
    .filter(row => row.shipmentId === activeShipment.shipmentId && row.directionId === activeShipment.directionId);
  // The box type is part of the same initial snapshot as the article list. Resolve
  // all item norms in one catalog pass; cached values are display-only and every
  // placement preflight/save still forces a fresh authoritative catalog read.
  const referenceKey = ritmFingerprint_([
    shipments.map(row => [row.shipmentId, row['Название поставки'], row.sourceAvailable, row.itemCount]),
    itemRows.map(row => Object.keys(row).filter(key => key !== 'Синхронизировано' && key !== '_rowNumber').sort().map(key => [key, row[key]])),
  ]);
  const boxNorms = !progressOnly && activeShipment.environment === 'RITM'
    ? boxNormsForSkus_(itemRows.map(row => row['Артикул']), forceSync === true, shipmentMarketplace_(activeShipment))
    : Object.create(null);
  const storeNumbers = !progressOnly && activeShipment.environment === 'RITM'
    ? storeNumbersForItems_(itemRows.map(row => ({ sku: row['Артикул'], source: shipmentMarketplace_(activeShipment) })), forceSync === true)
    : Object.create(null);
  const employeeRows = readCachedTable_(db, TABLES.employees, 'ritm.assembly.ref.employees.v2', 300, forceSync === true);
  const employeeNameById = Object.create(null);
  employeeRows.forEach(row => {
    const employeeId = String(row.employeeId || '').trim();
    const name = String(row.Имя || '').trim();
    if (employeeId && name) employeeNameById[employeeId] = name;
  });
  const employees = employeeRows
    .filter(row => row.Активен === true || String(row.Активен).toLowerCase() === 'true')
    .filter(row => isBlueBuildingEmployee_(row['Имя']))
    .map(row => ({ id: String(row.employeeId), name: String(row.Имя) }));
  const norms = progressOnly ? [] : readCachedTable_(db, TABLES.norms, 'ritm.assembly.ref.norms', 300, forceSync === true);
  const shiftNorms = progressOnly ? Object.create(null) : readShiftNorms_(db, forceSync === true);
  const normByKey = Object.create(null);
  norms.forEach(row => {
    const value = toNumberOrNull_(row['Норма, шт/чел']);
    if (value !== null && value > 0) normByKey[`${row.positionId}|${row.operationId}`] = value;
  });
  const boxTotals = readBoxTotalsForShipment_(db, activeShipment);
  const cartonSnapshots = boxTotals === null ? null : readCartonSnapshotsForShipment_(db, activeShipment, boxTotals);
  const totals = Object.create(null);
  const seenEventIds = new Set();
  const workDay = moscowWorkDate_(new Date());
  const workSnapshot = readWorkSnapshot_(db, activeShipment.shipmentId, workDay);
  const workCorrections = readWorkCancellationState_(db, workSnapshot.rows);
  const employeeShift = summarizeEmployeeShift_(workSnapshot, workDay, workCorrections.byEventId);
  const workRecordsByPosition = Object.create(null);
  workSnapshot.rows
    .filter(row => String(row.shipmentId) === String(activeShipment.shipmentId))
    .filter(row => row.directionId === activeShipment.directionId).forEach(row => {
    const eventId = String(row.eventId || '');
    if (!eventId || seenEventIds.has(eventId)) return;
    seenEventIds.add(eventId);
    if (row.shipmentId !== activeShipment.shipmentId || row.directionId !== activeShipment.directionId) return;
    if (!OPERATION_LABELS[row.operationId]) return;
    const quantity = toNumberOrNull_(row['Количество, шт']);
    if (quantity === null || quantity <= 0 || !Number.isInteger(quantity)) return;

    const key = String(row.positionId || '');
    const operationId = String(row.operationId);
    const eventCoefficient = toNumberOrNull_(row['Коэффициент']);
    const norm = toNumberOrNull_(row['Норма, шт/чел']);
    const employeeId = String(row.employeeId || '').trim();
    const recordedName = String(row['Сотрудник'] || row.employeeName || '').trim();
    const employeeName = recordedName || employeeNameById[employeeId] || (employeeId ? 'Сотрудник · ' + employeeId : 'Сотрудник не указан');
    const coefficient = eventCoefficient !== null && eventCoefficient >= 0
      ? eventCoefficient
      : eventCoefficient === null && norm !== null && norm > 0
        ? quantity / norm
        : null;
    const cancellation = workCorrections.byEventId[eventId] || null;
    const record = {
      eventId,
      shipmentId: String(row.shipmentId || ''),
      directionId: String(row.directionId || ''),
      positionId: key,
      employeeId,
      employeeName,
      operationId,
      operationName: OPERATION_LABELS[operationId],
      quantity,
      norm,
      coefficient,
      createdAt: normalizeDateString_(row.createdAt),
      source: String(row['Источник'] || ''),
      canCancel: isCollectorWorkSource_(row['Источник']),
      cancelled: Boolean(cancellation),
      cancelledAt: cancellation ? cancellation.createdAt : '',
      cancellationReason: cancellation ? cancellation.reason : '',
    };
    if (!workRecordsByPosition[key]) workRecordsByPosition[key] = [];
    workRecordsByPosition[key].push(record);
    if (record.cancelled) return;

    if (!totals[key]) totals[key] = emptyTotals_();
    const operation = totals[key].operations[operationId];
    operation.quantity += quantity;
    if (coefficient !== null) {
      operation.coefficient += coefficient;
      operation.coefficientKnown = true;
    } else operation.unknownCoefficientCount++;

    // A blank name is common in older WorkLog rows; resolve it by stable employeeId.
    // Rows without an ID stay visible as separate unassigned events rather than vanishing
    // from the team or being merged with another person by a similar name.
    const workerKey = employeeId || 'unassigned:' + eventId;
    if (!totals[key].workers[workerKey]) {
      totals[key].workers[workerKey] = {
        id: employeeId || workerKey,
        employeeId,
        canRecord: Boolean(employeeId),
        name: employeeId ? employeeName : (recordedName ? recordedName + ' · ID не указан' : 'Сотрудник не указан'),
        operations: {
          cut: emptyWorkerOperation_(),
          assembly: emptyWorkerOperation_(),
          packing: emptyWorkerOperation_(),
        },
        lastWorkedAt: '',
      };
    }
    const worker = totals[key].workers[workerKey];
    const workerOperation = worker.operations[operationId];
    workerOperation.quantity += quantity;
    if (coefficient !== null) {
      workerOperation.coefficient += coefficient;
      workerOperation.coefficientKnown = true;
    } else workerOperation.unknownCoefficientCount++;
    workerOperation.eventCount += 1;
    const lastWorkedAt = record.createdAt;
    if (lastWorkedAt && (!worker.lastWorkedAt || lastWorkedAt > worker.lastWorkedAt)) worker.lastWorkedAt = lastWorkedAt;
  });

  const items = itemRows.map(row => {
    const itemTotals = totals[String(row.positionId)] || emptyTotals_();
    const boxNorm = boxNorms[normalizeBoxSku_(row['Артикул'])];
    const boxSummary = boxTotals === null ? null : (boxTotals[String(row.positionId)] || { boxes: new Set(), quantity: 0 });
    const packingPlan = toNumberOrNull_(row[OPERATION_PLAN_FIELDS.packing]);
    const item = {
      shipmentId: String(row.shipmentId),
      directionId: String(row.directionId),
      direction: String(row['Направление'] || ''),
      positionId: String(row.positionId),
      sku: String(row['Артикул']),
      storeNumbers: storeNumbers[storeNumberSkuKey_(row['Артикул'], shipmentMarketplace_(activeShipment))] ?? null,
      productName: String(row['Название товара'] || ''),
      stockTask: row.stockTask === true, productionDepartment: row.productionDepartment || '', productionPrint: row.productionPrint || '', productionCut: row.productionCut || '', productionArchivedAt: row.productionArchivedAt || '',
      productType: String(row['Вид товара'] || ''),
      boxType: boxNorm && boxNorm.boxType ? boxNorm.boxType : '',
      unitsPerBox: boxNorm && boxNorm.confirmed ? boxNorm.unitsPerBox : null,
      boxNormError: boxNorm && !boxNorm.confirmed ? boxNorm.reason : '',
      photoAssetKey: String(row.photoAssetKey || ''),
      photoUrl: safeRitmPhotoUrl_(row['Фото']),
      sheetsPerUnit: toNumberOrNull_(row['Листов на штуку']),
      packNormPerPerson: toNumberOrNull_(row['Норма упаковки, шт/чел']),
      boxCountSnapshot: boxSummary === null ? toNumberOrNull_(row['Коробов · срез']) : (boxSummary.boxes.size ? boxSummary.boxes.size : null),
      boxNumbersSnapshot: boxSummary && cartonSnapshots
        ? (cartonSnapshots[String(row.positionId)] || []).map(box => box.number).filter(Boolean)
        : [],
      cartonsSnapshot: boxSummary === null ? null : (cartonSnapshots[String(row.positionId)] || []),
      assignedQtySnapshot: boxSummary === null ? null : (boxSummary.assignedQuantity || 0),
      boxedQtySnapshot: boxSummary === null ? toNumberOrNull_(row['В коробах, шт · срез']) : (boxSummary.quantity ? boxSummary.quantity : null),
      unboxedQtySnapshot: boxSummary === null ? toNumberOrNull_(row['Не распределено, шт · срез']) : (boxSummary.quantity && packingPlan !== null ? Math.max(0, packingPlan - boxSummary.quantity) : null),
      source: String(row['Источник'] || ''),
      assemblyOnly: row['Источник'] === 'RITM_ASSEMBLY_ONLY', assemblyOnlyComment: String(row.assemblyOnlyComment || ''), assemblyOnlyCreatedBy: String(row.assemblyOnlyCreatedBy || ''),
      workFactsAvailable: workSnapshot.available,
      operations: {},
      // Keep the Blue Building roster restriction for new entries, but never hide
      // an existing WorkLog fact from the article team. Historical entries may
      // belong to former or differently named employees and still explain progress.
      workers: Object.values(itemTotals.workers).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      workRecords: (workRecordsByPosition[String(row.positionId)] || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    };
    Object.keys(OPERATION_LABELS).forEach(operationId => {
      const fact = itemTotals.operations[operationId];
      // A valid WorkLog snapshot with no event for this operation confirms a
      // zero app-recorded fact. Do not turn that into “unknown”; keep null only
      // when the journal schema itself could not be verified.
      const quantityKnown = workSnapshot.available || fact.quantity > 0 || activeShipment.environment !== 'RITM';
      const plan = toNumberOrNull_(row[OPERATION_PLAN_FIELDS[operationId]]);
      const normDetails = resolveWorkNorm_(row, operationId, normByKey[`${item.positionId}|${operationId}`], shiftNorms);
      item.operations[operationId] = {
        id: operationId,
        label: OPERATION_LABELS[operationId],
        plan,
        fact: quantityKnown ? fact.quantity : null,
        ratio: quantityKnown && plan > 0 ? fact.quantity / plan : null,
        overBy: !quantityKnown || plan === null ? null : Math.max(0, fact.quantity - plan),
        coefficient: fact.coefficientKnown ? fact.coefficient : null,
        unknownCoefficientCount: fact.unknownCoefficientCount,
        normPerPerson: normDetails.norm,
        normDetails,
      };
    });
    item.packingRemaining = item.operations.packing.plan === null || item.operations.packing.fact === null ? null : Math.max(0, item.operations.packing.plan - item.operations.packing.fact);
    item.packingOverBy = item.operations.packing.plan === null || item.operations.packing.fact === null ? null : Math.max(0, item.operations.packing.fact - item.operations.packing.plan);
    item.status = processingStatus_(item.operations);
    return item;
  });
  if (progressOnly) return {
    shipmentId: String(activeShipment.shipmentId), referenceKey,
    shipments: shipments.map(row => ({ id: String(row.shipmentId), name: String(row['Название поставки']), stockTask: row.stockTask === true, environment: row.environment, sourceAvailable: row.sourceAvailable !== false, itemCount: Number.isSafeInteger(row.itemCount) ? row.itemCount : null })),
    sync,
    dataVersion: readVersion, updatedAt: new Date().toISOString(), employeeShift,
    items: items.map(item => ({
      positionId: item.positionId, workers: item.workers, workRecords: item.workRecords,
      workFactsAvailable: item.workFactsAvailable,
      operations: Object.keys(OPERATION_LABELS).reduce((result, operationId) => {
        const operation = item.operations[operationId];
        result[operationId] = { fact: operation.fact, coefficient: operation.coefficient, unknownCoefficientCount: operation.unknownCoefficientCount };
        return result;
      }, {}),
      boxCountSnapshot: item.boxCountSnapshot, boxNumbersSnapshot: item.boxNumbersSnapshot,
      cartonsSnapshot: item.cartonsSnapshot, assignedQtySnapshot: item.assignedQtySnapshot, boxedQtySnapshot: item.boxedQtySnapshot,
      unboxedQtySnapshot: item.unboxedQtySnapshot,
    })),
  };
  // Do not block the first useful screen on a full marketplace label-index read.
  // The exact label is checked from the modal when a worker asks to print it.
  const marketplace = labelMarketplace_(activeShipment.marketplace || activeShipment['Маркетплейс'], activeShipment['Название поставки']);
  items.forEach(item => { item.label = { status: 'not_checked' }; });

  return {
    version: 'ritm-supply-sync-1',
    environment: activeShipment.environment === 'RITM' ? 'RITM' : 'TEST ONLY',
    sync,
    dataVersion: readVersion,
    referenceKey,
    updatedAt: new Date().toISOString(),
    shipments: shipments.map(row => ({ id: String(row.shipmentId), name: String(row['Название поставки']), stockTask: row.stockTask === true, environment: row.environment, sourceAvailable: row.sourceAvailable !== false, itemCount: Number.isSafeInteger(row.itemCount) ? row.itemCount : null })),
    shipment: {
      id: String(activeShipment.shipmentId),
      name: String(activeShipment['Название поставки'] || ''),
      directionId: String(activeShipment.directionId),
      direction: String(activeShipment['Направление'] || ''),
      sourceUrl: activeShipment.sourceUrl || '',
      assemblyUrl: activeShipment.sheetId ? 'https://docs.google.com/spreadsheets/d/' + DB_ID + '/edit#gid=' + activeShipment.sheetId : '',
      stockTask: activeShipment.stockTask === true,
      sourceAvailable: activeShipment.sourceAvailable !== false,
      marketplace,
      labelSourceStatus: 'not_checked',
    },
    operations: Object.keys(OPERATION_LABELS).map(id => ({ id, name: OPERATION_LABELS[id] })),
    employees,
    employeeShift,
    items,
  };
}

function labelAvailabilityForShipment_(shipment, items) {
  if (shipment.environment !== 'RITM') return { marketplace: '', status: 'demo', items: Object.create(null) };
  const marketplace = labelMarketplace_(shipment.marketplace || shipment['Маркетплейс'], shipment['Название поставки']);
  if (!marketplace) return { marketplace: '', status: 'marketplace_unknown', items: Object.create(null) };
  try {
    const index = labelIndex_(marketplace);
    const itemStatuses = Object.create(null);
    items.forEach(item => {
      const article = normalizeLabelArticle_(item.sku, marketplace);
      const match = index.labels[article] || null;
      const barcode = index.barcodes[article] || '';
      itemStatuses[item.positionId] = match
        ? match.conflict
          ? { status: 'conflict' }
          : { status: 'found', fileId: match.fileId, originalUrl: 'https://drive.google.com/file/d/' + match.fileId + '/view' }
        : barcode
          ? { status: 'barcode_only' }
          : { status: 'missing' };
    });
    return { marketplace, status: 'ready', items: itemStatuses };
  } catch (error) {
    return { marketplace, status: 'source_error', items: Object.create(null) };
  }
}

function labelMarketplace_(explicit, shipmentName) {
  const name = String(shipmentName || '').toLocaleUpperCase('ru-RU');
  const ozon = /(^|[^A-ZА-ЯЁ0-9])(?:OZON|ОЗОН)([^A-ZА-ЯЁ0-9]|$)/.test(name);
  const wb = /(^|[^A-ZА-ЯЁ0-9])(?:WB|ВБ|WILDBERRIES|ВАЙЛДБЕРРИЗ)([^A-ZА-ЯЁ0-9]|$)/.test(name);
  // The supply name is authoritative, including when old metadata is stale.
  if (ozon || wb) return ozon === wb ? '' : ozon ? 'OZON' : 'WB';
  const value = String(explicit || '').trim().toUpperCase();
  if (value === 'OZON') return 'OZON';
  if (['WB', 'WILDBERRIES', 'WILD BERRIES'].includes(value)) return 'WB';
  return '';
}

function shipmentMarketplace_(shipment) {
  return labelMarketplace_(shipment && (shipment.marketplace || shipment['Маркетплейс']),
    shipment && (shipment['Название поставки'] || shipment['Направление']));
}

function normalizeLabelArticle_(value, marketplace) {
  let article = String(value || '').trim().toUpperCase();
  const suffix = marketplace === 'OZON' ? '(OZ)' : '(WB)';
  if (article.endsWith(suffix)) article = article.slice(0, -suffix.length).trim();
  return article;
}

function labelIndex_(marketplace, forceRefresh) {
  const cache = CacheService.getScriptCache();
  const key = LABEL_CACHE_PREFIX + marketplace;
  const manifest = cache.get(key + '.manifest');
  if (manifest && !forceRefresh) {
    const count = Number(manifest);
    let json = '';
    for (let i = 0; i < count; i++) {
      const part = cache.get(key + '.' + i);
      if (part === null) { json = ''; break; }
      json += part;
    }
    if (json) {
      try { return JSON.parse(json); } catch (_) {}
    }
  }
  const ss = SpreadsheetApp.openById(LABEL_FBO_ID);
  const labelSheet = ss.getSheetByName(marketplace === 'WB' ? 'Этикетки WB' : 'Этикетки OZON');
  if (!labelSheet) throw new Error('Лист этикеток не найден.');
  const labels = Object.create(null);
  readLabelPairs_(labelSheet).forEach(pair => addLabelCandidate_(labels, pair[0], pair[1], marketplace));
  if (marketplace === 'OZON') {
    const codes = SpreadsheetApp.openById(LABEL_OZON_CODES_ID).getSheetByName('Коды');
    if (!codes) throw new Error('Лист кодов Ozon не найден.');
    readLabelPairs_(codes).forEach(pair => addLabelCandidate_(labels, pair[0], pair[1], marketplace));
  }
  const catalog = ss.getSheetByName(marketplace);
  if (!catalog) throw new Error('Лист каталога маркетплейса не найден.');
  const barcodes = Object.create(null);
  const lastRow = catalog.getLastRow();
  if (lastRow > 1) {
    const range = marketplace === 'OZON' ? catalog.getRange(2, 1, lastRow - 1, 4).getDisplayValues() : catalog.getRange(2, 1, lastRow - 1, 4).getDisplayValues();
    range.forEach(row => {
      const article = normalizeLabelArticle_(marketplace === 'OZON' ? (row[1] || row[0]) : row[0], marketplace);
      const barcode = String((marketplace === 'OZON' ? row[3] : row[2]) || '').trim();
      if (article && barcode && !/^#(N\/A|REF|VALUE|ERROR)/i.test(barcode)) barcodes[article] = barcode;
    });
  }
  const result = { labels, barcodes };
  const json = JSON.stringify(result);
  const chunkSize = 60000;
  const chunks = Math.ceil(json.length / chunkSize);
  for (let i = 0; i < chunks; i++) cache.put(key + '.' + i, json.slice(i * chunkSize, (i + 1) * chunkSize), 900);
  cache.put(key + '.manifest', String(chunks), 900);
  return result;
}

function invalidateLabelIndexCache_(marketplace) {
  if (marketplace !== 'OZON' && marketplace !== 'WB') return;
  const cache = CacheService.getScriptCache();
  const key = LABEL_CACHE_PREFIX + marketplace;
  const chunks = Number(cache.get(key + '.manifest'));
  if (Number.isInteger(chunks) && chunks > 0 && chunks <= 100) {
    for (let i = 0; i < chunks; i++) cache.remove(key + '.' + i);
  }
  cache.remove(key + '.manifest');
}

function readLabelPairs_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 2).getDisplayValues();
}

function addLabelCandidate_(labels, articleValue, urlValue, marketplace) {
  const article = normalizeLabelArticle_(articleValue, marketplace);
  const id = driveImageId_(urlValue);
  if (!article || !id) return;
  const current = labels[article];
  if (!current) labels[article] = { fileId: id, conflict: false };
  else if (current.fileId !== id) current.conflict = true;
}

function driveImageId_(value) {
  const url = String(value || '').trim();
  if (!/^https:\/\/(?:www\.)?drive\.google\.com\//i.test(url)) return '';
  const queryId = url.match(/[?&]id=([A-Za-z0-9_-]{10,})/i);
  const pathId = url.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/i);
  const id = queryId ? queryId[1] : pathId ? pathId[1] : '';
  return /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : '';
}

function getLabelImage(shipmentId, directionId, positionId) {
  return getLabelImages(shipmentId, directionId, [positionId])[0];
}

function getLabelImages(shipmentId, directionId, positionIds) {
  const db = SpreadsheetApp.openById(DB_ID);
  const shipment = assemblyShipments_(db).find(row => String(row.shipmentId) === String(shipmentId) && String(row.directionId) === String(directionId));
  if (!shipment || shipment.sourceAvailable === false) throw new Error('Поставка недоступна. Обновите её и повторите.');
  const ids = Array.from(new Set((Array.isArray(positionIds) ? positionIds : []).map(value => String(value || '').trim()).filter(Boolean)));
  if (!ids.length || ids.length > 150) throw new Error('Выберите от 1 до 150 артикулов для печати.');
  const items = readShipmentItems_(db, shipment).filter(row => row.shipmentId === shipment.shipmentId && row.directionId === shipment.directionId && ids.includes(String(row.positionId)));
  if (items.length !== ids.length) throw new Error('Часть выбранных артикулов не относится к этой поставке. Обновите список.');
  const marketplace = labelMarketplace_(shipment.marketplace, shipment['Название поставки']);
  if (!marketplace) throw new Error('Не удалось однозначно определить Ozon или Wildberries по поставке.');
  let index = labelIndex_(marketplace);
  // A previously conflicting catalog may have been corrected while its index
  // was cached. Re-read once before blocking printing; real conflicts stay blocked.
  if (items.some(item => {
    const match = index.labels[normalizeLabelArticle_(item['Артикул'], marketplace)];
    return match && match.conflict;
  })) index = labelIndex_(marketplace, true);
  let totalBytes = 0;
  const itemsById = Object.create(null);
  items.forEach(item => { itemsById[String(item.positionId)] = item; });
  const found = ids.map(positionId => {
    const item = itemsById[positionId];
    const article = normalizeLabelArticle_(item['Артикул'], marketplace);
    const match = index.labels[article];
    if (!match) return { positionId: String(item.positionId), sku: String(item['Артикул']), status: index.barcodes[article] ? 'barcode_only' : 'missing' };
    if (match.conflict) return { positionId: String(item.positionId), sku: String(item['Артикул']), status: 'conflict' };
    try {
      const file = DriveApp.getFileById(match.fileId);
      const mime = String(file.getMimeType() || '').toLowerCase();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return { positionId: String(positionId), sku: String(item['Артикул']), status: 'unsupported_format' };
      const size = file.getSize();
      if (size > 2 * 1024 * 1024) return { positionId: String(positionId), sku: String(item['Артикул']), status: 'file_too_large' };
      if (totalBytes + size > 8 * 1024 * 1024) return { positionId: String(positionId), sku: String(item['Артикул']), status: 'batch_size_limit' };
      totalBytes += size;
      return { positionId: String(positionId), sku: String(item['Артикул']), status: 'found', marketplace, mimeType: mime,
        filename: file.getName(), originalUrl: file.getUrl(), base64: Utilities.base64Encode(file.getBlob().getBytes()) };
    } catch (_) {
      return { positionId: String(item.positionId), sku: String(item['Артикул']), status: 'file_unavailable' };
    }
  });
  return found;
}

function readBoxTotalsForShipment_(db, shipment) {
  const sheet = db.getSheetByName(TABLES.cartonContents);
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return null;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  if (['shipmentId', 'directionId', 'positionId', 'cartonId', 'Количество, шт'].some(header => headers.indexOf(header) < 0)) return null;
  const records = normalizeCartonContents_(readRowsByKey_(sheet, 'shipmentId', new Set([String(shipment.shipmentId)])));
  const totals = Object.create(null);
  records.filter(row => String(row.directionId) === String(shipment.directionId)).forEach(row => {
    const positionId = String(row.positionId || '');
    const cartonId = String(row.cartonId || '');
    const quantity = validBoxQuantity_(row['Количество, шт']);
    if (!positionId || !cartonId || !quantity) return;
    if (!totals[positionId]) totals[positionId] = { boxes: new Set(), quantity: 0, assignedQuantity: 0, byCarton: Object.create(null) };
    totals[positionId].assignedQuantity += quantity;
    if (isWarehouseCartonId_(cartonId) && !shipment.stockTask) return;
    totals[positionId].boxes.add(cartonId);
    totals[positionId].quantity += quantity;
    totals[positionId].byCarton[cartonId] = (totals[positionId].byCarton[cartonId] || 0) + quantity;
  });
  return totals;
}

// Preload the compact inline article cards as part of the one supply snapshot.
// Norms are cache-only here; an uncached or unconfirmed norm remains visibly unknown.
// Opening the box drawer still performs the authoritative focused read.
function readCartonSnapshotsForShipment_(db, shipment, boxTotals) {
  const cartonIds = new Set();
  Object.values(boxTotals || {}).forEach(summary => (summary.boxes || new Set()).forEach(cartonId => cartonIds.add(String(cartonId))));
  const byPosition = Object.create(null);
  if (!cartonIds.size) return byPosition;
  const cartonSheet = db.getSheetByName(TABLES.cartons);
  const contentsSheet = db.getSheetByName(TABLES.cartonContents);
  const cartonsById = Object.create(null);
  readRowsByKey_(cartonSheet, 'cartonId', cartonIds).forEach(carton => {
    // The per-position totals prove that this shipment has an allocation in it.
    cartonsById[String(carton.cartonId)] = carton;
  });
  const contents = normalizeCartonContents_(readRowsByKey_(contentsSheet, 'cartonId', cartonIds));
  const normsBySku = sharedCartonNorms_(db, contents, shipment, false, true);
  Object.keys(boxTotals || {}).forEach(positionId => {
    const summary = boxTotals[positionId];
    const cards = Object.keys(summary.byCarton || {}).map(cartonId => {
      const carton = cartonsById[cartonId];
      if (!carton) return {
        cartonId, number: 'Короб не найден', status: 'Статус неизвестен', open: false, closed: false,
        itemQuantity: summary.byCarton[cartonId], pieceCount: null, skuCount: null,
        fillRatio: null, spaceKnown: false, blockedReason: 'Запись короба отсутствует в Cartons.',
      };
      const value = publicCarton_(carton, contents, carton._rowNumber, normsBySku, false, positionId);
      return {
        cartonId: value.cartonId, number: value.number || 'Номер не указан',
        status: value.open ? 'Открыт' : value.closed ? 'Закрыт' : (value.status || 'Статус неизвестен'),
        open: value.open, closed: value.closed, itemQuantity: value.itemQuantity,
        pieceCount: value.pieceCount, skuCount: value.skuCount,
        fillRatio: value.spaceKnown ? value.fillRatio : null, spaceKnown: value.spaceKnown,
        blockedReason: value.blockedReason || '', boxType: value.boxType || '',
      };
    });
    cards.sort((a, b) => String(a.number).localeCompare(String(b.number), 'ru', { numeric: true }));
    byPosition[positionId] = cards;
  });
  return byPosition;
}

function cachedBoxNormsForSkus_(skus, marketplace) {
  const cache = CacheService.getScriptCache();
  const result = Object.create(null);
  const keys = Array.from(new Set((skus || []).map(normalizeBoxSku_).filter(Boolean)));
  const cachedValues = keys.length ? cache.getAll(keys.map(sku => boxPackNormCacheKey_(sku, marketplace))) : {};
  keys.forEach(sku => {
    const cached = parseSyncJson_(cachedValues[boxPackNormCacheKey_(sku, marketplace)], null);
    result[sku] = cached && cached.confirmed === true
      ? cached
      : { confirmed: false, reason: 'Норма ещё не загружена для краткой карточки.' };
  });
  return result;
}

// Cheap poll endpoint: it reads Script Properties only, not any spreadsheet ranges.
function getDataVersion() {
  return Number(PropertiesService.getScriptProperties().getProperty(RITM_DATA_VERSION) || 0);
}

function getPhotos(photoAssetKeys) {
  const keys = Array.from(new Set((Array.isArray(photoAssetKeys) ? photoAssetKeys : [])
    .map(value => String(value || '').trim())
    .filter(value => /^[A-Za-z0-9_.:-]{1,160}$/.test(value)))).slice(0, 20);
  if (!keys.length) return {};
  const db = SpreadsheetApp.openById(DB_ID);
  const photos = Object.create(null);
  readRowsByKey_(db.getSheetByName(TABLES.photos), 'photoAssetKey', new Set(keys)).forEach(row => {
    if (row.photoAssetKey && row.base64Data) photos[String(row.photoAssetKey)] = `data:${row.mimeType || 'image/png'};base64,${row.base64Data}`;
  });
  return photos;
}

function saveWork(payload) {
  validateWorkPayload_(payload);
  // Resolve and validate references before the critical section. Reads of the shipment,
  // employee and norm must never hold up other employees' short append lock.
  const db = SpreadsheetApp.openById(DB_ID);
  const shipment = assemblyShipments_(db).find(row => String(row.shipmentId) === String(payload.shipmentId));
  if (!shipment || shipment.sourceAvailable === false) throw new Error('Источник поставки недоступен. Обновите список перед записью.');
  const item = String(shipment.directionId) === String(payload.directionId) ? readShipmentItem_(db, shipment, payload.positionId) : null;
  if (!item) throw new Error('Артикул не найден в выбранной поставке. Обновите страницу.');
  const employee = readTable_(db, TABLES.employees).find(row =>
    String(row.employeeId) === String(payload.employeeId) &&
    (row.Активен === true || String(row.Активен).toLowerCase() === 'true')
  );
  if (!employee) throw new Error('Сотрудник отсутствует в справочнике или неактивен.');
  const normRow = readTable_(db, TABLES.norms).find(row =>
    String(row.positionId) === String(item.positionId) && String(row.operationId) === String(payload.operationId)
  );
  const normDetails = resolveWorkNorm_(item, payload.operationId, normRow ? toNumberOrNull_(normRow['Норма, шт/чел']) : null, readShiftNorms_(db, true));
  const norm = normDetails.norm;
  const quantity = Number(payload.quantity);
  const logSheet = db.getSheetByName(TABLES.workLog);
  if (!logSheet) throw new Error('Не найден журнал WorkLog.');
  const headers = logSheet.getRange(1, 1, 1, logSheet.getLastColumn()).getValues()[0].map(String);
  if (headers.indexOf('idempotencyKey') < 0) throw new Error('В журнале не найдена колонка idempotencyKey.');
  const key = String(payload.idempotencyKey);
  const prior = findWorkByIdempotency_(logSheet, headers, key);
  if (prior) return existingWorkResult_(prior, payload);
  if (shipment.environment === 'RITM') assertRitmShipmentUnlocked_(payload.shipmentId);

  const rowByHeader = {
    eventId: Utilities.getUuid(),
    createdAt: new Date().toISOString(),
    shipmentId: String(item.shipmentId),
    directionId: String(item.directionId),
    'Направление': String(item['Направление']),
    positionId: String(item.positionId),
    'Артикул': String(item['Артикул']),
    employeeId: String(employee.employeeId),
    'Сотрудник': String(employee['Имя']),
    operationId: String(payload.operationId),
    'Операция': OPERATION_LABELS[payload.operationId],
    'Количество, шт': quantity,
    'Норма, шт/чел': norm === null ? '' : norm,
    'Коэффициент': norm === null ? '' : quantity / norm,
    'Источник': shipment.environment === 'RITM' ? 'WEB_APP_RITM' : 'WEB_APP_TEST',
    idempotencyKey: key,
  };
  const row = headers.map(header => Object.prototype.hasOwnProperty.call(rowByHeader, header) ? rowByHeader[header] : '');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Журнал сейчас занят другой записью. Данные не сохранены — повторите через несколько секунд.');
  let savedResult;
  try {
    // Required second lookup while holding the lock: two concurrent requests with the
    // same key cannot both append, even if both passed the earlier fast-path lookup.
    const duplicate = findWorkByIdempotency_(logSheet, headers, key);
    if (duplicate) return existingWorkResult_(duplicate, payload);
    if (shipment.environment === 'RITM') { assertLocalShipmentUnlocked_(payload.shipmentId); assertAssemblyOnlyNotDeleted_(payload.positionId); }
    const now = rowByHeader.createdAt;
    const eventId = rowByHeader.eventId;
    logSheet.getRange(logSheet.getLastRow() + 1, 1, 1, headers.length).setValues([row]);
    const dataVersion = bumpDataVersion_();
    savedResult = {
      ok: true, duplicate: false, eventId, dataVersion,
      shipmentId: String(payload.shipmentId), directionId: String(payload.directionId),
      positionId: String(payload.positionId), employeeId: String(employee.employeeId),
      employeeName: String(employee['Имя']), operationId: String(payload.operationId),
      quantity, norm, normDetails, coefficient: norm === null ? null : quantity / norm,
      createdAt: now,
    };
  } finally {
    lock.releaseLock();
  }
  return savedResult;
}

function existingWorkResult_(row, payload) {
  const same = String(row.shipmentId) === String(payload.shipmentId) &&
    String(row.directionId) === String(payload.directionId) &&
    String(row.positionId) === String(payload.positionId) &&
    String(row.employeeId) === String(payload.employeeId) &&
    String(row.operationId) === String(payload.operationId) &&
    Number(row['Количество, шт']) === Number(payload.quantity);
  if (!same) throw new Error('Ключ повтора уже использован для другой операции. Запись не добавлена.');
  return { ok: true, duplicate: true, eventId: String(row.eventId || ''), dataVersion: getDataVersion() };
}

function getWorkStatus(idempotencyKey) {
  const key = String(idempotencyKey || '').trim();
  if (!/^[-A-Za-z0-9_]{12,100}$/.test(key)) throw new Error('Не удалось проверить идентификатор операции.');
  const db = SpreadsheetApp.openById(DB_ID);
  const sheet = db.getSheetByName(TABLES.workLog);
  if (!sheet) throw new Error('Не найден журнал WorkLog.');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const row = findWorkByIdempotency_(sheet, headers, key);
  if (!row) return null;
  const cancellation = readWorkCancellationState_(db, [row]).byEventId[String(row.eventId || '')] || null;
  return {
    ok: true, duplicate: true, eventId: String(row.eventId || ''),
    shipmentId: String(row.shipmentId || ''), directionId: String(row.directionId || ''),
    positionId: String(row.positionId || ''), employeeId: String(row.employeeId || ''),
    employeeName: String(row['Сотрудник'] || ''), operationId: String(row.operationId || ''),
    quantity: toNumberOrNull_(row['Количество, шт']),
    norm: toNumberOrNull_(row['Норма, шт/чел']),
    coefficient: toNumberOrNull_(row['Коэффициент']),
    createdAt: normalizeDateString_(row.createdAt), cancelled: Boolean(cancellation),
    cancelledAt: cancellation ? cancellation.createdAt : '',
    cancellationReason: cancellation ? cancellation.reason : '',
    dataVersion: getDataVersion(),
  };
}

// Carton reads are a compact view over the existing Cartons, CartonContents,
// WorkLog and visible RITM catalog. A legacy per-carton piece count is never
// treated as a mixed-SKU capacity.
var cartonRequestReads_ = null;
function cartonCatalogRead_(marketplace) {
  const key=String(marketplace);
  if(cartonRequestReads_&&cartonRequestReads_.catalogs[key])return cartonRequestReads_.catalogs[key];
  const sheet=SpreadsheetApp.openById(RITM_CATALOG_ID).getSheetByName(key);
  if(!sheet||sheet.isSheetHidden())throw new Error('Видимая вкладка «'+key+'» не найдена в базе.');
  const lastRow=sheet.getLastRow(),lastColumn=sheet.getLastColumn();
  if(lastRow<1||lastColumn<2)throw new Error('Структура базы не подтверждена.');
  const result={sheet,lastRow,lastColumn,headers:sheet.getRange(1,1,1,lastColumn).getDisplayValues()[0].map(String),keyRows:lastRow>1?sheet.getRange(2,1,lastRow-1,2).getDisplayValues():[],columns:Object.create(null)};
  if(cartonRequestReads_)cartonRequestReads_.catalogs[key]=result;
  return result;
}
function cartonCatalogColumns_(catalog,first,width){
  const key=first+':'+width;
  if(!catalog.columns[key])catalog.columns[key]=catalog.lastRow>1?catalog.sheet.getRange(2,first,catalog.lastRow-1,width).getDisplayValues():[];
  return catalog.columns[key];
}
function withCartonRequestReads_(write,task) {
  const previous=cartonRequestReads_;
  cartonRequestReads_={write:write===true,tables:Object.create(null),rosters:Object.create(null),catalogs:Object.create(null)};
  try{return task();}finally{cartonRequestReads_=previous;}
}
function getBoxesForItem(shipmentId, directionId, positionId, boxSourceShipmentId) {
  return withCartonRequestReads_(false,()=>getBoxesForItemFresh_(shipmentId,directionId,positionId,boxSourceShipmentId));
}
function getBoxesForItemFresh_(shipmentId, directionId, positionId, boxSourceShipmentId) {
  const db = SpreadsheetApp.openById(DB_ID);
  const context = boxItemContext_(db, shipmentId, directionId, positionId);
  const sheets = getBoxTableSheets_(db);
  const direction = cartonDirection_(context.shipment);
  const automatic = String(boxSourceShipmentId || '') === '__direction__';
  const scope = !automatic && boxSourceShipmentId && String(boxSourceShipmentId) !== String(shipmentId)
    ? requireRitmShipment_(db, boxSourceShipmentId, directionId) : context.shipment;
  const scopes = automatic && direction ? assemblyShipments_(db).filter(s => {
    const group = cartonDirection_(s);
    return s.sourceAvailable !== false && group && group.key === direction.key;
  }) : [scope];
  if (!scopes.some(s => String(s.shipmentId) === String(scope.shipmentId))) scopes.push(scope);
  const cartons = context.shipment.stockTask ? {sheet:sheets.cartons.sheet,headers:sheets.cartons.headers,records:[]} : readOpenCartonsForShipment_(sheets.cartons.sheet, scopes);
  if (automatic || String(scope.shipmentId) === String(context.shipment.shipmentId)) {
    const allocations = normalizeCartonContents_(readRowsByKey_(sheets.contents.sheet, 'positionId', new Set([String(context.item.positionId)])));
    const linkedIds = new Set(itemAllocationsFor_(allocations, context).filter(row => !isWarehouseCartonId_(row.cartonId)).map(row => String(row.cartonId)));
    if (linkedIds.size) {
      const linked = readRowsByKey_(sheets.cartons.sheet, 'cartonId', linkedIds).filter(row => isOpenCarton_(row['Статус']));
      cartons.records = Array.from(new Map(cartons.records.concat(linked).map(row => [String(row.cartonId), row])).values());
    }
  }
  const openIds = new Set(cartons.records.map(row => String(row.cartonId)));
  const activeContents = normalizeCartonContents_(readCartonPositionContents_(sheets.contents.sheet, openIds, context.item.positionId));
  const contentsHeaders = sheets.contents.sheet.getRange(1, 1, 1, sheets.contents.sheet.getLastColumn()).getValues()[0].map(String);
  const tables = {
    cartons,
    contents: { sheet: sheets.contents.sheet, headers: contentsHeaders, records: activeContents },
    closedCount: null,
    db, listShipments: scopes,
  };
  return buildBoxOverview_(context, tables);
}

function getBoxDetails(shipmentId, directionId, cartonId, boxSourceShipmentId) {
  return withCartonRequestReads_(false,()=>getBoxDetailsFresh_(shipmentId,directionId,cartonId,boxSourceShipmentId));
}
function getBoxDetailsFresh_(shipmentId, directionId, cartonId, boxSourceShipmentId) {
  const db = SpreadsheetApp.openById(DB_ID);
  const shipment = requireRitmShipment_(db, shipmentId, directionId);
  const sheets = getBoxTableSheets_(db);
  const carton = findBoxRecordByHeaderValue_(sheets.cartons.sheet, 'cartonId', String(cartonId));
  if (!carton) throw new Error('Короб не найден. Обновите список.');
  const linked = normalizeCartonContents_(readRowsByKey_(sheets.contents.sheet, 'cartonId', new Set([String(carton.cartonId)])));
  const automatic = String(boxSourceShipmentId || '') === '__direction__';
  const source = !automatic && boxSourceShipmentId && String(boxSourceShipmentId) !== String(shipmentId)
    ? requireRitmShipment_(db, boxSourceShipmentId, directionId) : shipment;
  const direction = cartonDirection_(shipment);
  const owner = automatic ? assemblyShipments_(db).find(s => cartonMatchesShipment_(carton, s)) : null;
  const ownerDirection = owner && cartonDirection_(owner);
  const sameDirection = direction && ownerDirection && direction.key === ownerDirection.key;
  if (!cartonMatchesShipment_(carton, source) && !cartonLinkedToShipment_(carton, shipment, linked) && !sameDirection) throw new Error('Короб не найден в выбранной поставке.');
  const norms = sharedCartonNorms_(db, linked, shipment, false);
  const ids = new Set(linked.map(row => String(row.positionId || '')).filter(Boolean));
  const sheet = db.getSheetById(Number(shipment.sheetId));
  const sourceId = String(shipment.shipmentId).replace('RITM-ROLL-', '');
  if (!shipment.stockTask && (!sheet || sheet.getRange(1, 1).getNote() !== (shipment.marker || RITM_SHEET_MARKER + sourceId))) throw new Error('Не удалось подтвердить источник позиций поставки.');
  const items = (shipment.stockTask ? readAssemblyStockItems_().filter(row=>ids.has(String(row.positionId))) : readRowsByKey_(sheet, 'positionId', ids)).filter(row => String(row.shipmentId) === String(shipment.shipmentId) && String(row.directionId) === String(shipment.directionId));
  if (Array.from(ids).some(id => id.indexOf('|manual:') >= 0)) {
    readShipmentItems_(db, shipment).filter(row => ids.has(String(row.positionId)) && String(row.positionId).indexOf('|manual:') >= 0).forEach(row => items.push(row));
  }
  const itemByPosition = Object.create(null);
  items.forEach(row => { itemByPosition[String(row.positionId)] = row; });
  const origins = assemblyShipments_(db);
  const shipmentNames = new Map(origins.map(row => [String(row.shipmentId), String(row['Название поставки'] || '')]));
  origins.filter(origin => String(origin.shipmentId) !== String(shipment.shipmentId)).forEach(origin => {
    const originIds = new Set(linked.filter(row => String(row.shipmentId) === String(origin.shipmentId)).map(row => String(row.positionId || '')));
    if (!originIds.size) return;
    const originSheet = db.getSheetById(Number(origin.sheetId));
    const marker = origin.marker || RITM_SHEET_MARKER + String(origin.shipmentId).replace('RITM-ROLL-', '');
    if (!originSheet || originSheet.getRange(1, 1).getNote() !== marker) return;
    readRowsByKey_(originSheet, 'positionId', originIds).filter(row => String(row.shipmentId) === String(origin.shipmentId)).forEach(row => { itemByPosition[String(row.positionId)] = row; });
    if (Array.from(originIds).some(id => id.indexOf('|manual:') >= 0)) {
      readShipmentItems_(db, origin).filter(row => originIds.has(String(row.positionId))).forEach(row => { itemByPosition[String(row.positionId)] = row; });
    }
  });
  const box = publicCarton_(carton, linked, carton._rowNumber, norms, true);
  box.contents.forEach(entry => {
    const item = itemByPosition[String(entry.positionId)];
    entry.productName = item ? String(item['Название товара'] || '') : '';
    entry.productType = item ? String(item['Вид товара'] || '') : '';
    entry.photoAssetKey = item ? String(item.photoAssetKey || '') : '';
    entry.photoUrl = item ? safeRitmPhotoUrl_(item['Фото']) : '';
    entry.boxType = entry.norm && entry.norm.boxType ? entry.norm.boxType : '';
    entry.unitsPerBox = entry.norm && entry.norm.unitsPerBox ? entry.norm.unitsPerBox : null;
    entry.shipmentName = shipmentNames.get(String(entry.shipmentId)) || '';
  });
  return { ok: true, shipment: { id: String(shipment.shipmentId), directionId: String(shipment.directionId), name: String(shipment['Название поставки']) }, carton: box, closeRevision: cartonCloseRevision_(carton, linked), dataVersion: getDataVersion() };
}

function getClosedCartons(shipmentId, directionId, query, beforeRow, boxSourceShipmentId) {
  const db = SpreadsheetApp.openById(DB_ID);
  const shipment = requireRitmShipment_(db, shipmentId, directionId);
  const automatic = String(boxSourceShipmentId || '') === '__direction__';
  const scope = !automatic && boxSourceShipmentId && String(boxSourceShipmentId) !== String(shipmentId)
    ? requireRitmShipment_(db, boxSourceShipmentId, directionId) : shipment;
  const direction = automatic && cartonDirection_(shipment);
  const scopes = direction ? assemblyShipments_(db).filter(s => { const d = cartonDirection_(s); return d && d.key === direction.key; }) : [scope];
  const cartonSheet = db.getSheetByName(TABLES.cartons);
  const contentsSheet = db.getSheetByName(TABLES.cartonContents);
  if (!cartonSheet || !contentsSheet) throw new Error('В хранилище не найдены таблицы коробов.');
  const linkedCartonIds = new Set(normalizeCartonContents_(readRowsByKey_(contentsSheet, 'shipmentId', new Set([String(shipment.shipmentId)]))).map(row => String(row.cartonId)));
  const needle = normalizeCartonNumber_(query);
  const pageSize = 25;
  const sheetLastRow = cartonSheet.getLastRow();
  let scanEnd = Math.min(sheetLastRow, (Number(beforeRow) > 1 ? Number(beforeRow) : sheetLastRow + 1) - 1);
  const lastColumn = cartonSheet.getLastColumn();
  if (scanEnd < 2 || lastColumn < 1) return { boxes: [], hasMore: false, nextCursor: null };
  const headers = cartonSheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
  const required = ['cartonId', 'directionId', 'Направление', 'Номер', 'Статус', 'closedAt'];
  const missing = required.filter(header => headers.indexOf(header) < 0);
  if (missing.length) throw new Error('В листе коробов отсутствуют колонки: ' + missing.join(', ') + '.');
  const candidates = [];
  const chunkSize = 200;
  while (scanEnd >= 2 && candidates.length <= pageSize) {
    const startRow = Math.max(2, scanEnd - chunkSize + 1);
    const values = cartonSheet.getRange(startRow, 1, scanEnd - startRow + 1, lastColumn).getValues();
    for (let offset = values.length - 1; offset >= 0 && candidates.length <= pageSize; offset -= 1) {
      const cells = values[offset];
      if (!cells.some(value => value !== '' && value !== null)) continue;
      const row = headers.reduce((record, header, index) => { record[header] = cells[index]; return record; }, {});
      row._rowNumber = startRow + offset;
      if (!isWarehouseCartonId_(row.cartonId) && (scopes.some(s => cartonMatchesShipment_(row, s)) || ((automatic || scope === shipment) && linkedCartonIds.has(String(row.cartonId)))) && isClosedCarton_(row) && (!needle || normalizeCartonNumber_(row['Номер']).includes(needle))) candidates.push(row);
    }
    scanEnd = startRow - 1;
  }
  const page = candidates.slice(0, pageSize);
  const pageIds = new Set(page.map(box => String(box.cartonId)));
  const contents = normalizeCartonContents_(readRowsByKey_(contentsSheet, 'cartonId', pageIds));
  const norms = sharedCartonNorms_(db, contents, shipment, false);
  return {
    boxes: page.map(row => publicCarton_(row, contents, row._rowNumber, norms, true)),
    hasMore: candidates.length > pageSize,
    nextCursor: page.length ? Number(page[page.length - 1]._rowNumber) : null,
  };
}

function previewBoxPlacement(payload) {
  validateBoxPlacementPayload_(payload, false);
  const db = SpreadsheetApp.openById(DB_ID);
  const snapshot = boxPlacementSnapshot_(db, payload, true);
  const quoteId = Utilities.getUuid();
  const quote = {
    quoteId,
    payload: boxPlacementRequestKey_(payload),
    scopeFingerprint: boxPlacementScopeFingerprint_(snapshot),
    createdAt: Date.now(),
  };
  CacheService.getScriptCache().put(boxQuoteCacheKey_(quoteId), JSON.stringify(quote), 300);
  return {
    ok: true,
    previewId: quoteId,
    mode: snapshot.mode,
    shipment: { id: String(snapshot.context.shipment.shipmentId), name: String(snapshot.context.shipment['Название поставки']) },
    item: { positionId: String(snapshot.context.item.positionId), sku: String(snapshot.context.item['Артикул'] || ''), productName: String(snapshot.context.item['Название товара'] || '') },
    carton: { cartonId: snapshot.carton.cartonId, number: snapshot.carton.number, boxType: snapshot.boxTypeAfter, fillBefore: snapshot.space.spaceUsed, fillAfter: snapshot.fillAfter },
    quantity: snapshot.quantity,
    packed: snapshot.context.packed,
    assigned: snapshot.assigned,
    available: snapshot.available,
    spaceNorm: { boxType: snapshot.norm.boxType, unitsPerBox: snapshot.norm.unitsPerBox, source: snapshot.norm.source },
    dataVersion: snapshot.dataVersion,
  };
}

function createCarton() {
  throw new Error('Ручное создание короба отключено. Создайте его вместе с подтверждённым размещением товара.');
}

function getCartonCreationStatus(idempotencyKey) {
  const key = validateBoxIdempotencyKey_(idempotencyKey);
  const db = SpreadsheetApp.openById(DB_ID);
  const tables = readBoxTables_(db);
  const carton = tables.cartons.records.find(row => String(row.cartonId) === 'carton-' + key);
  if (!carton) return null;
  return { ok: true, duplicate: true, carton: publicCarton_(carton, tables.contents.records, carton._rowNumber, boxNormsForSkus_(tables.contents.records.filter(row => String(row.cartonId) === String(carton.cartonId)).map(row => row['Артикул']), false, shipmentMarketplace_(carton)), false) };
}

function saveBoxPlacement(payload) {
  // Catalog data is read freshly once in this request. Operational rows are
  // deliberately never memoized on a write: the ScriptLock recheck stays fresh.
  return withCartonRequestReads_(true,()=>saveBoxPlacementFresh_(payload));
}
function saveBoxPlacementFresh_(payload) {
  let db, tables, allocationId, existing, quote = null, snapshot;
  const hasPreview = Boolean(payload && String(payload.previewId || '').trim());
  try {
    validateBoxPlacementPayload_(payload, false);
    db = SpreadsheetApp.openById(DB_ID);
    tables = getBoxTableSheets_(db);
    assertStockReservation_(payload);
    allocationId = 'allocation-' + String(payload.idempotencyKey);
    existing = findBoxRecordByHeaderValue_(tables.contents.sheet, 'allocationId', allocationId);
  } catch (error) {
    return boxPlacementNotWritten_(error);
  }
  if (existing) {
    if (!boxAllocationMatchesPayload_(existing, payload)) return boxPlacementNotWritten_('Ключ повтора уже использован для другого размещения. Новая запись не добавлена.');
    return getBoxPlacementStatus(payload.idempotencyKey);
  }

  if (hasPreview) {
    let quoteText;
    try { quoteText = CacheService.getScriptCache().get(boxQuoteCacheKey_(payload.previewId)); }
    catch (error) { return boxPlacementNotWritten_(error); }
    if (!quoteText) return boxPlacementNotWritten_('Проверка устарела. Нажмите «Добавить в короб» ещё раз.');
    quote = parseSyncJson_(quoteText, null);
    if (!quote || quote.quoteId !== String(payload.previewId) || JSON.stringify(quote.payload) !== JSON.stringify(boxPlacementRequestKey_(payload))) {
      return boxPlacementNotWritten_('Данные не совпадают с проверенным товаром или количеством. Обновите данные и повторите добавление.');
    }
  }

  // The current UI sends one placement request. Validate from a fresh snapshot
  // in this call; older open tabs may still submit a preview token, which keeps
  // the existing quote-and-confirm safety check until those tabs are reloaded.
  try { snapshot = boxPlacementSnapshot_(db, payload, true); }
  catch (error) { return boxPlacementNotWritten_(error); }
  try { assertStockPlan_(payload, snapshot.context); }
  catch (error) { return boxPlacementNotWritten_(error); }
  if (quote && (!quote.scopeFingerprint || boxPlacementScopeFingerprint_(snapshot) !== String(quote.scopeFingerprint)))
    return boxPlacementNotWritten_('Данные этого артикула или короба изменились после проверки. Обновите короб и подтвердите размещение ещё раз.');
  if (snapshot.context.shipment.environment === 'RITM') {
    try {
      assertRitmShipmentUnlocked_(snapshot.context.shipment.shipmentId);
      if (String(snapshot.boxOwner.shipmentId) !== String(snapshot.context.shipment.shipmentId)) assertRitmShipmentUnlocked_(snapshot.boxOwner.shipmentId);
    }
    catch (error) { return boxPlacementNotWritten_(error); }
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return boxPlacementPending_('Короба сейчас обновляются. Проверяем сохранение операции.');
  let result = null;
  let duplicate = false;
  let rejected = null;
  let mutationStarted = false;
  try {
    assertStockReservation_(payload);
    const prior = findBoxRecordByHeaderValue_(tables.contents.sheet, 'allocationId', allocationId);
    if (prior) {
      if (!boxAllocationMatchesPayload_(prior, payload)) rejected = boxPlacementNotWritten_('Ключ повтора уже использован для другого размещения. Новая запись не добавлена.');
      else duplicate = true;
    }
    else {
      let liveScope;
      try {
        if (snapshot.context.shipment.environment === 'RITM') {
          assertLocalShipmentUnlocked_(snapshot.context.shipment.shipmentId);
          if (String(snapshot.boxOwner.shipmentId) !== String(snapshot.context.shipment.shipmentId)) assertLocalShipmentUnlocked_(snapshot.boxOwner.shipmentId);
          assertAssemblyOnlyNotDeleted_(payload.positionId);
        }
        liveScope = boxPlacementCurrentScope_(db, payload, snapshot);
        assertStockPlan_(payload, liveScope.context);
        if (quote && boxPlacementScopeFingerprint_(liveScope) !== String(quote.scopeFingerprint))
          throw new Error('Данные этого артикула или короба изменились после проверки. Обновите короб и подтвердите размещение ещё раз.');

        if (!quote) {
          // A one-click placement can safely use the newest scoped values now:
          // another worker may have packed or boxed this SKU while the request
          // was waiting for the shared write lock.
          snapshot.context = liveScope.context;
          snapshot.tables.cartons.records = liveScope.tables.cartons.records;
          snapshot.tables.contents.records = liveScope.tables.contents.records;
          snapshot.tables.contents.rawRecords = liveScope.tables.contents.records;
          snapshot.cartonRecord = liveScope.cartonRecord;
          snapshot.cartonIndex = liveScope.cartonIndex;
          snapshot.space = liveScope.space;
          snapshot.fillAfter = liveScope.fillAfter;
          snapshot.assigned = liveScope.assigned;
          snapshot.available = liveScope.available;
          snapshot.itemStoreNumber = liveScope.itemStoreNumber;

          if (snapshot.mode === 'new' && !liveScope.cartonExists) {
            const byShipment = readRowsByKey_(tables.cartons.sheet, 'shipmentId', new Set([String(snapshot.context.shipment.shipmentId)]));
            const byDirection = readRowsByKey_(tables.cartons.sheet, 'directionId', new Set([String(snapshot.context.shipment.directionId)]));
            const currentCartons = uniqueCartonRows_(byShipment.concat(byDirection)).filter(row => cartonMatchesShipment_(row, snapshot.context.shipment));
            snapshot.carton.number = payload.warehouse === true
              ? nextWarehouseCartonNumber_(snapshot.itemStoreNumber, tables.cartons.sheet)
              : nextCartonNumber_(snapshot.context.shipment, currentCartons, snapshot.itemStoreNumber, tables.cartons.sheet);
            snapshot.cartonRecord['Номер'] = snapshot.carton.number;
          }
        }

        if (snapshot.mode === 'new') {
          const sameNumber = findBoxRecordByHeaderValue_(tables.cartons.sheet, 'Номер', snapshot.carton.number);
          if (sameNumber && String(sameNumber.cartonId) !== String(snapshot.carton.cartonId))
            throw new Error('Номер нового короба уже заняли. Обновите список коробов и проверьте размещение ещё раз.');
        }
      } catch (error) {
        rejected = boxPlacementNotWritten_(error);
      }
      if (!rejected) {
        mutationStarted = true;
        let carton = snapshot.cartonRecord;
        let cartonIndex = snapshot.cartonIndex;
        let cartonHeaders = snapshot.tables.cartons.headers;
        if (snapshot.mode === 'new' && cartonIndex < 0) {
          if (!cartonHeaders.includes('shipmentId')) cartonHeaders = ensureCartonColumn_(tables.cartons.sheet, 'shipmentId');
          if (!cartonHeaders.includes('Тип короба')) cartonHeaders = ensureCartonColumn_(tables.cartons.sheet, 'Тип короба');
          const newRecord = {
            cartonId: snapshot.carton.cartonId,
            shipmentId: String(snapshot.context.shipment.shipmentId),
            directionId: String(snapshot.context.shipment.directionId),
            'Направление': String(snapshot.context.shipment['Направление'] || snapshot.context.shipment.directionId),
            'Номер': snapshot.carton.number,
            'Подтверждённая вместимость, шт': snapshot.norm.unitsPerBox,
            'Занято, шт': 0,
            'Статус': 'Подготовка',
            'Тип короба': snapshot.norm.boxType,
            createdAt: new Date().toISOString(),
            closedAt: '',
            source: payload.warehouse === true ? 'RITM_ASSEMBLY_STOCK' : 'RITM_ASSEMBLY',
          };
          appendRecordByHeaders_(tables.cartons.sheet, cartonHeaders, newRecord);
          carton = Object.assign({ _rowNumber: tables.cartons.sheet.getLastRow() }, newRecord);
          cartonIndex = snapshot.tables.cartons.records.length;
          snapshot.tables.cartons.records.push(carton);
          snapshot.tables.cartons.headers = cartonHeaders;
        }
        if (!carton || cartonIndex < 0) throw new Error('Короб изменился. Повторите проверку.');
        const record = {
          allocationId,
          cartonId: String(carton.cartonId),
          shipmentId: String(snapshot.context.shipment.shipmentId),
          directionId: String(snapshot.context.shipment.directionId),
          positionId: String(snapshot.context.item.positionId),
          'Артикул': String(snapshot.context.item['Артикул'] || ''),
          'Количество, шт': snapshot.quantity,
          createdAt: new Date().toISOString(),
          eventId: Utilities.getUuid(),
        };
        if (payload.warehouse === true) {
          const operation = parseSyncJson_(PropertiesService.getScriptProperties().getProperty(stockOperationKey_(payload.parentKey)), null);
          if (!operation) throw new Error('Не подтверждён автор складского размещения.');
          record.employeeId = String(operation.employeeId || '');
          record['Сотрудник'] = String(operation.employeeName || '');
        }
        appendRecordByHeaders_(tables.contents.sheet, snapshot.tables.contents.headers, record);
        snapshot.tables.contents.records.push(record);
        const status = String(carton['Статус'] || '');
        updateCartonDerived_(tables.cartons.sheet, cartonHeaders, carton._rowNumber, { occupied: cartonDerived_(carton, snapshot.tables.contents.records, snapshot.normsBySku).occupied, status: status === 'Подготовка' ? 'Открыт' : status });
        const statusColumn = cartonHeaders.indexOf('Статус');
        if (statusColumn >= 0 && status === 'Подготовка') tables.cartons.sheet.getRange(carton._rowNumber, statusColumn + 1).setValue('Открыт');
        const dataVersion = bumpDataVersion_();
        result = Object.assign(boxPlacementResult_(snapshot.context, record, snapshot.tables, cartonIndex, false, snapshot.normsBySku), {
          dataVersion,
        });
      }
    }
  } catch (error) {
    if (mutationStarted) throw error;
    rejected = boxPlacementNotWritten_(error);
  } finally {
    lock.releaseLock();
  }
  if (rejected) return rejected;
  if (quote) CacheService.getScriptCache().remove(boxQuoteCacheKey_(payload.previewId));
  return duplicate ? getBoxPlacementStatus(payload.idempotencyKey) : result;
}

function boxPlacementPending_(message) {
  return { ok: false, status: 'pending', pending: true, message: String(message || 'Проверяем сохранение операции.') };
}

function boxPlacementNotWritten_(error) {
  return {
    ok: false,
    status: 'not_written',
    notWritten: true,
    message: error && error.message ? String(error.message) : String(error || 'Размещение не записано.'),
  };
}

// Only recognized marketplace/city pairs are combined automatically. Unknown
// names retain the existing per-supply sheet instead of guessing a direction.
function cartonDirection_(shipment) {
  const market = shipmentMarketplace_(shipment);
  const name = String(shipment && (shipment['Название поставки'] || shipment['Направление']) || '').toLocaleUpperCase('ru-RU');
  if (!market) return null;
  const cities = [
    ['SPB','СПБ',/(^|[^A-ZА-ЯЁ0-9])(?:СПБ|САНКТ[ -]?ПЕТЕРБУРГ|САНКТ[ -]?ПЕТЕРБУРГА|ПИТЕР)(?=$|[^A-ZА-ЯЁ0-9])/],
    ['MOSCOW','МОСКВА',/(^|[^A-ZА-ЯЁ0-9])(?:МОСКВА|МОСКВЫ|МСК)(?=$|[^A-ZА-ЯЁ0-9])/],
    ['EKATERINBURG','ЕКАТЕРИНБУРГ',/(^|[^A-ZА-ЯЁ0-9])(?:ЕКБ|ЕКАТЕРИНБУРГ)(?=$|[^A-ZА-ЯЁ0-9])/],
    ['NOVOSIBIRSK','НОВОСИБИРСК',/(^|[^A-ZА-ЯЁ0-9])(?:НОВОСИБ|НОВОСИБИРСК)(?=$|[^A-ZА-ЯЁ0-9])/],
    ['KAZAN','КАЗАНЬ',/(^|[^A-ZА-ЯЁ0-9])(?:КАЗАНЬ|КАЗАНИ)(?=$|[^A-ZА-ЯЁ0-9])/],
    ['ROSTOV','РОСТОВ',/(^|[^A-ZА-ЯЁ0-9])(?:РОСТОВ|РОСТОВА)(?=$|[^A-ZА-ЯЁ0-9])/],
    ['KOSTROMA','КОСТРОМА',/(^|[^A-ZА-ЯЁ0-9])(?:КОСТРОМА|КОСТРОМЫ)(?=$|[^A-ZА-ЯЁ0-9])/],
  ];
  const matches = cities.filter(city => city[2].test(name));
  return matches.length === 1 ? { key: market + '_' + matches[0][0], label: market + ' ' + matches[0][1] } : null;
}

function boxViewFormulaWhenEntriesExist_(formula) {
  return '=IF(COUNT(CartonContents!G2:G)=0;"";' + formula.slice(1) + ')';
}

function directionBoxViewFormula_(shipments) {
  const entries = (shipments || []).map(s => ({ id: String(s.shipmentId || '').trim(), name: String(s['Название поставки'] || '').trim() }));
  if (!entries.length || entries.some(s => !/^[A-Za-z0-9_-]{1,120}$/.test(s.id) || !s.name)) throw new Error('Не подтверждены поставки направления.');
  if (new Set(entries.map(s => s.id)).size !== entries.length) throw new Error('Повторяется ID поставки направления.');
  const nameExpr = entries.reduceRight((fallback, entry) => 'IF(CartonContents!C2:C="' + entry.id + '";"' + entry.name.replace(/"/g, '""') + '";' + fallback + ')', '"Поставка не найдена"');
  const ids = entries.map(s => s.id).join('|');
  const query = "select Col1,Col2,Col3,sum(Col4) where Col5 matches '" + ids + "' and Col3 is not null and not Col6 matches 'carton-stock-.*' group by Col1,Col2,Col3 order by Col1,Col2,Col3 label Col1 '',Col2 '',Col3 '',sum(Col4) ''";
  return boxViewFormulaWhenEntriesExist_('=IFNA(QUERY(QUERY(HSTACK(ARRAYFORMULA(IF(CartonContents!B2:B="";"";IFNA(VLOOKUP(CartonContents!B2:B;Cartons!A2:K;4;FALSE);"Номер не найден")));ARRAYFORMULA(IF(CartonContents!C2:C="";"";' + nameExpr + '));CartonContents!F2:F;CartonContents!G2:G;CartonContents!C2:C;CartonContents!B2:B);"' + query + '";0);"select * where Col4 > 0";0);"")');
}

// The stock report uses carton identity, not article names or allocation
// quantity, so corrections remain attached to the original physical carton.
function warehouseBoxViewFormula_() {
  const q = "select Col1,Col2,Col3,sum(Col4),Col6,Col7 where Col5 matches 'carton-stock-.*' and Col3 is not null and Col4 > 0 group by Col1,Col2,Col3,Col6,Col7 order by Col1,Col3,Col7 label Col1 '',Col2 '',Col3 '',sum(Col4) '',Col6 '',Col7 ''";
  return boxViewFormulaWhenEntriesExist_('=IFNA(QUERY(HSTACK(ARRAYFORMULA(IF(CartonContents!B2:B="";"";IFNA(VLOOKUP(CartonContents!B2:B;Cartons!A2:K;4;FALSE);"Номер не найден")));ARRAYFORMULA(IF(CartonContents!B2:B="";"";IFNA(VLOOKUP(CartonContents!B2:B;Cartons!A2:K;3;FALSE);"Поставка не найдена")));CartonContents!F2:F;ARRAYFORMULA(IF(CartonContents!J2:J="REMOVE";0;CartonContents!G2:G+SUMIF(CartonContents!K2:K;CartonContents!A2:A;CartonContents!G2:G)));CartonContents!B2:B;ARRAYFORMULA(IF(CartonContents!O2:O="";"Не указан · старая запись";CartonContents!O2:O));ARRAYFORMULA(IF(CartonContents!H2:H="";"";IFERROR(TEXT(DATEVALUE(LEFT(CartonContents!H2:H;10))+TIMEVALUE(MID(CartonContents!H2:H;12;8))+3/24;"dd.mm.yyyy hh:mm");CartonContents!H2:H))));"' + q + '";0);"")');
}

function refreshLegacyViewsForWarehouse_(db, shipment) {
  const shipmentId = String(shipment.shipmentId || '');
  const marker = BOX_VIEW_MARKER + ':' + shipmentId;
  db.getSheets().forEach(sheet => {
    if (String(sheet.getRange(1, 1).getNote() || '') !== marker) return;
    const old = String(sheet.getRange(2, 1).getFormula() || '');
    if (!old || old.charAt(0) !== '=') throw new Error('Старый лист коробов изменён вручную; излишек не записан.');
    const updated = shipmentBoxViewFormula_(shipmentId, shipment['Название поставки']);
    if (old !== updated) sheet.getRange(2, 1).setFormula(updated);
  });
  SpreadsheetApp.flush();
}

function ensureWarehouseBoxViewSheet_(db) {
  const name = BOX_VIEW_PREFIX + 'На склад';
  const marker = BOX_VIEW_MARKER + ':warehouse:v1';
  const props = PropertiesService.getScriptProperties();
  const key = 'ritm.assembly.boxView.warehouse';
  const saved = Number(props.getProperty(key) || 0);
  let sheet = saved ? db.getSheetById(saved) : null;
  if (sheet && String(sheet.getRange(1, 1).getNote() || '') !== marker) sheet = null;
  if (!sheet) {
    const existing = db.getSheetByName(name);
    if (existing && String(existing.getRange(1, 1).getNote() || '') !== marker) throw new Error('Лист «' + name + '» уже существует и не принадлежит системе. Данные не изменены.');
    sheet = existing || db.insertSheet(name);
  }
  const note = String(sheet.getRange(1, 1).getNote() || '');
  if (!note) {
    sheet.getRange(1, 1, 1, 4).setValues([['Номер короба','Поставка','Артикул','Количество']]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 145); sheet.setColumnWidth(2, 260); sheet.setColumnWidth(3, 170); sheet.setColumnWidth(4, 125);
    sheet.getRange(1, 1, 1, 4).setBackground('#e7f6ed').setFontWeight('bold');
    sheet.getRange(1, 1).setNote(marker);
  }
  const auditHeaders = sheet.getRange(1, 5, 1, 2).getValues()[0].map(String);
  if (auditHeaders.some((value, i) => value && value !== ['Отправил на склад', 'Дата · МСК'][i])) throw new Error('Колонки складского отчёта заняты другими данными.');
  sheet.getRange(1, 5, 1, 2).setValues([['Отправил на склад', 'Дата · МСК']]);
  sheet.setColumnWidth(5, 220); sheet.setColumnWidth(6, 175);
  const formula = warehouseBoxViewFormula_();
  if (sheet.getRange(2, 1).getFormula() !== formula) sheet.getRange(2, 1).setFormula(formula);
  SpreadsheetApp.flush();
  const value = String(sheet.getRange(2, 1).getDisplayValues()[0][0] || '');
  if (sheet.getRange(2, 1).getFormula().charAt(0) !== '=' || /^#(?:ERROR!|REF!|N\/A|VALUE!|NAME\?|NUM!)/i.test(value)) throw new Error('Не удалось подтвердить отчёт по складским коробам.');
  props.setProperty(key, String(sheet.getSheetId()));
  return sheet;
}

function ensureDirectionBoxViewSheet_(db, direction, shipments) {
  const marker = BOX_VIEW_MARKER + ':direction:' + direction.key;
  const property = 'ritm.assembly.boxView.direction.' + direction.key;
  const props = PropertiesService.getScriptProperties();
  const saved = Number(props.getProperty(property) || 0);
  let sheet = saved ? db.getSheetById(saved) : null;
  if (sheet && String(sheet.getRange(1, 1).getNote() || '') !== marker) sheet = null;
  const base = BOX_VIEW_PREFIX + direction.label;
  if (!sheet) {
    const names = [base, (base + ' · общий').slice(0, 100)];
    for (const candidate of names) {
      const existing = db.getSheetByName(candidate);
      if (!existing) { sheet = db.insertSheet(candidate); break; }
      if (String(existing.getRange(1, 1).getNote() || '') === marker) { sheet = existing; break; }
    }
    if (!sheet) throw new Error('Имена общего листа направления заняты. Существующие листы не изменены.');
  }
  const note = String(sheet.getRange(1, 1).getNote() || '');
  if (note !== marker && sheet.getLastRow() > 0 && sheet.getRange(1, 1, 1, 4).getValues()[0].some(Boolean)) throw new Error('Общий лист содержит данные без служебной метки.');
  if (note !== marker) {
    sheet.getRange(1, 1, 1, 4).setValues([['Номер короба','Поставка','Артикул','Количество']]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 145); sheet.setColumnWidth(2, 260); sheet.setColumnWidth(3, 170); sheet.setColumnWidth(4, 125);
    sheet.getRange(1, 1, 1, 4).setBackground('#eaf2ff').setFontWeight('bold');
    sheet.getRange(1, 1).setNote(marker);
  }
  const formula = directionBoxViewFormula_(shipments);
  if (sheet.getRange(2, 1).getFormula() !== formula) sheet.getRange(2, 1).setFormula(formula);
  SpreadsheetApp.flush();
  const confirmedFormula = sheet.getRange(2, 1).getFormula();
  const displayed = String(sheet.getRange(2, 1).getDisplayValues()[0][0] || '');
  if (confirmedFormula.charAt(0) !== '=' || /^#(?:ERROR!|REF!|N\/A|VALUE!|NAME\?|NUM!)/i.test(displayed))
    throw new Error('Не удалось подтвердить формулу общего листа «' + sheet.getName() + '». Старые листы сохранены.');
  props.setProperty(property, String(sheet.getSheetId()));
  return { sheet, created: !note };
}

function directionBoxShipments_(props, direction, current) {
  const all = props.getProperties();
  const byId = new Map();
  Object.keys(all).filter(key => key.indexOf(RITM_SYNC_PREFIX) === 0).forEach(key => {
    const row = parseSyncJson_(all[key], null);
    if (!row || !row.shipmentId || !row.name) return;
    const item = { shipmentId: String(row.shipmentId), 'Название поставки': String(row.name) };
    const candidate = cartonDirection_(item);
    if (candidate && candidate.key === direction.key) byId.set(item.shipmentId, item);
  });
  if (current && current.shipmentId) byId.set(String(current.shipmentId), current);
  return Array.from(byId.values()).sort((a, b) => String(a.shipmentId).localeCompare(String(b.shipmentId)));
}

function syncDirectionBoxViews_(db, props) {
  const all = props.getProperties();
  const groups = new Map();
  Object.keys(all).filter(key => key.indexOf(RITM_SYNC_PREFIX) === 0).forEach(key => {
    const row = parseSyncJson_(all[key], null);
    if (!row || !row.shipmentId || !row.name) return;
    const item = { shipmentId: String(row.shipmentId), 'Название поставки': String(row.name) };
    const direction = cartonDirection_(item);
    if (direction) groups.set(direction.key, direction);
  });
  const results = [];
  groups.forEach(direction => {
    const shipments = directionBoxShipments_(props, direction);
    const signature = JSON.stringify(['v2-stock-separated', shipments.map(s => [s.shipmentId, s['Название поставки']])]);
    const signatureKey = 'ritm.assembly.boxView.direction.sig.' + direction.key;
    const sheetKey = 'ritm.assembly.boxView.direction.' + direction.key;
    const sheetId = Number(props.getProperty(sheetKey) || 0);
    if (props.getProperty(signatureKey) === signature && sheetId && db.getSheetById(sheetId)) return;
    const view = ensureDirectionBoxViewSheet_(db, direction, shipments);
    shipments.forEach(item => props.setProperty(boxViewPropertyKey_(item.shipmentId), String(view.sheet.getSheetId())));
    props.setProperty(signatureKey, signature);
    results.push({ direction: direction.label, sheet: view.sheet.getName(), created: view.created });
  });
  return results;
}

function ensureShipmentBoxViewSheet_(db, shipment) {
  const direction = cartonDirection_(shipment);
  if (direction) {
    const props = PropertiesService.getScriptProperties();
    const group = directionBoxShipments_(props, direction, shipment);
    const view = ensureDirectionBoxViewSheet_(db, direction, group);
    group.forEach(item => props.setProperty(boxViewPropertyKey_(item.shipmentId), String(view.sheet.getSheetId())));
    return view;
  }
  return ensureLegacyShipmentBoxViewSheet_(db, shipment);
}

function ensureShipmentBoxViewBestEffort_(db, shipment) {
  try { return ensureShipmentBoxViewSheet_(db, shipment); }
  catch (error) {
    console.warn('Общий лист коробов не обновлён; состав поставки сохранён: ' + String(error.message || error).slice(0, 160));
    return null;
  }
}

function ensureLegacyShipmentBoxViewSheet_(db, shipment) {
  const shipmentId = String(shipment.shipmentId || '').trim();
  if (!shipmentId) throw new Error('Не удалось определить поставку для листа коробов.');
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(shipmentId)) throw new Error('ID поставки содержит недопустимые символы для автоматического листа коробов.');
  const markerPrefix = BOX_VIEW_MARKER + ':' + shipmentId;
  const props = PropertiesService.getScriptProperties();
  const propKey = boxViewPropertyKey_(shipmentId);
  const savedSheetId = Number(props.getProperty(propKey) || 0);
  let sheet = savedSheetId ? db.getSheetById(savedSheetId) : null;
  if (sheet && String(sheet.getRange(1, 1).getNote() || '').indexOf(markerPrefix) !== 0) sheet = null;

  const baseName = boxViewBaseName_(shipment);
  if (!sheet) {
    const candidates = [baseName, boxViewNameWithId_(baseName, shipmentId)];
    for (const candidate of candidates) {
      const found = db.getSheetByName(candidate);
      if (!found) {
        sheet = db.insertSheet(candidate);
        break;
      }
      if (String(found.getRange(1, 1).getNote() || '').indexOf(markerPrefix) === 0) {
        sheet = found;
        break;
      }
    }
    if (!sheet) throw new Error('Не удалось создать отдельный лист коробов: имя занято другой вкладкой.');
  } else if (sheet.getName() !== baseName) {
    const candidates = [baseName, boxViewNameWithId_(baseName, shipmentId)];
    for (const candidate of candidates) {
      const occupant = db.getSheetByName(candidate);
      if (occupant && occupant.getSheetId() !== sheet.getSheetId()) continue;
      sheet.setName(candidate);
      break;
    }
  }

  const headers = ['Номер короба', 'Поставка', 'Артикул', 'Количество'];
  const currentHeaders = sheet.getLastRow() > 0 ? sheet.getRange(1, 1, 1, 4).getValues()[0].map(String) : [];
  const existingNote = String(sheet.getRange(1, 1).getNote() || '');
  if (existingNote.indexOf(markerPrefix) !== 0 && currentHeaders.some(Boolean)) {
    throw new Error('Вкладка «' + sheet.getName() + '» уже существует и не принадлежит представлению коробов.');
  }
  if (existingNote.indexOf(markerPrefix) !== 0 || headers.some((header, index) => currentHeaders[index] !== header)) {
    sheet.getRange(1, 1, 1, 4).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 145);
    sheet.setColumnWidth(2, 220);
    sheet.setColumnWidth(3, 170);
    sheet.setColumnWidth(4, 125);
    sheet.getRange(1, 1, 1, 4).setBackground('#eaf2ff').setFontWeight('bold');
  }
  sheet.getRange(1, 1).setNote(markerPrefix);
  sheet.getRange(2, 1).setFormula(shipmentBoxViewFormula_(shipmentId, shipment['Название поставки']));
  props.setProperty(propKey, String(sheet.getSheetId()));
  return { sheet, created: !existingNote };
}

function shipmentBoxViewFormula_(shipmentId, shipmentName) {
  const id = String(shipmentId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error('Недопустимый ID поставки.');
  const query = "select Col1,Col2,Col3,sum(Col4) where Col5 = '" + id + "' and Col3 is not null and not Col6 matches 'carton-stock-.*' group by Col1,Col2,Col3 order by Col1,Col2,Col3 label Col1 '',Col2 '',Col3 '',sum(Col4) ''";
  const name = String(shipmentName || '').replace(/"/g, '""');
  const supplyColumn = name ? 'ARRAYFORMULA(IF(CartonContents!B2:B="";"";"' + name + '"))' : 'ARRAYFORMULA(IF(CartonContents!B2:B="";"";IFNA(VLOOKUP(CartonContents!B2:B;Cartons!A2:K;3;FALSE);"Поставка не найдена")))';
  return boxViewFormulaWhenEntriesExist_('=IFNA(QUERY(QUERY(HSTACK(ARRAYFORMULA(IF(CartonContents!B2:B="";"";IFNA(VLOOKUP(CartonContents!B2:B;Cartons!A2:K;4;FALSE);"Номер не найден")));' + supplyColumn + ';CartonContents!F2:F;CartonContents!G2:G;CartonContents!C2:C;CartonContents!B2:B);"' + query + '";0);"select * where Col4 > 0";0);"")');
}

function boxViewBaseName_(shipment) {
  const name = String(shipment['Название поставки'] || shipment.shipmentId || 'Поставка')
    .replace(/[\\/?:*\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (BOX_VIEW_PREFIX + name).slice(0, 100);
}

function boxViewNameWithId_(baseName, shipmentId) {
  const suffix = ' · ' + String(shipmentId).slice(-8);
  return baseName.slice(0, 100 - suffix.length) + suffix;
}

function boxViewPropertyKey_(shipmentId) {
  return 'ritm.assembly.boxView.' + Utilities.base64EncodeWebSafe(String(shipmentId)).slice(0, 100);
}

function buildShipmentBoxViews() {
  if (Session.getActiveUser().getEmail() !== 'zinovevkirill234@gmail.com' || Session.getEffectiveUser().getEmail() !== 'zinovevkirill234@gmail.com') {
    throw new Error('Создание листов коробов доступно только владельцу проекта.');
  }
  const db = SpreadsheetApp.openById(DB_ID);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Короба сейчас обновляются. Повторите построение листов через несколько секунд.');
  try {
    const shipments = assemblyShipments_(db).filter(row=>!row.stockTask);
    return shipments.map(shipment => {
      const view = ensureShipmentBoxViewSheet_(db, shipment);
      return { shipment: String(shipment['Название поставки']), sheet: view.sheet.getName(), created: view.created };
    });
  } finally {
    lock.releaseLock();
  }
}

function getBoxPlacementStatus(idempotencyKey) {
  const key = validateBoxIdempotencyKey_(idempotencyKey);
  const db = SpreadsheetApp.openById(DB_ID);
  const sheets = getBoxTableSheets_(db);
  const allocation = findBoxRecordByHeaderValue_(sheets.contents.sheet, 'allocationId', 'allocation-' + key);
  if (!allocation) return null;
  const carton = findBoxRecordByHeaderValue_(sheets.cartons.sheet, 'cartonId', String(allocation.cartonId));
  if (!carton) throw new Error('Размещение найдено, но короб отсутствует. Обновите данные и обратитесь к руководителю.');
  const context = boxItemContext_(db, allocation.shipmentId, allocation.directionId, allocation.positionId);
  // Read only this carton and this article. Status checks run frequently while
  // many employees work, so scanning the entire history here creates needless
  // delays and keeps their dialogs in the uncertain state longer.
  const byCarton = readRowsByKey_(sheets.contents.sheet, 'cartonId', new Set([String(allocation.cartonId)]));
  const byPosition = readRowsByKey_(sheets.contents.sheet, 'positionId', new Set([String(allocation.positionId)]));
  const contents = normalizeCartonContents_(uniqueCartonRows_(byCarton.concat(byPosition)));
  const cartonContents = contents.filter(row => String(row.cartonId) === String(allocation.cartonId));
  const norms = sharedCartonNorms_(db, cartonContents, context.shipment, false);
  const tables = {
    cartons: { sheet: sheets.cartons.sheet, headers: [], records: [carton] },
    contents: { sheet: sheets.contents.sheet, headers: [], records: contents },
  };
  return boxPlacementResult_(context, allocation, tables, 0, true, norms);
}

function cartonCloseRevision_(carton, contents) {
  const items = normalizeCartonContents_(contents || []).filter(row => String(row.cartonId) === String(carton.cartonId)).map(row => [String(row.allocationId || ''),String(row.shipmentId || ''),String(row.directionId || ''),String(row.positionId || ''),String(row['Артикул'] || ''),Number(row['Количество, шт'])]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return stockDigest_(JSON.stringify([String(carton.cartonId),String(carton['Статус']),items]));
}

function cartonCloseAllowed_(db, carton, shipment, contents) {
  if (isWarehouseCartonId_(carton.cartonId) || isCancelledCarton_(carton)) return false;
  if (cartonLinkedToShipment_(carton, shipment, contents)) return true;
  const owner = assemblyShipments_(db).find(origin => cartonMatchesShipment_(carton, origin));
  const selectedDirection = cartonDirection_(shipment), ownerDirection = owner && cartonDirection_(owner);
  return !!(selectedDirection && ownerDirection && selectedDirection.key === ownerDirection.key);
}

function assertCartonCloseRevision_(payload, carton, contents) {
  if (payload.closeRevision) {
    if (typeof payload.closeRevision !== 'string' || payload.closeRevision !== cartonCloseRevision_(carton, contents)) throw new Error('Состав короба изменился. Откройте его заново и подтвердите закрытие ещё раз.');
  } else if (!Number.isFinite(Number(payload.dataVersion)) || Number(payload.dataVersion) !== getDataVersion()) throw new Error('Состав короба изменился. Откройте его заново и подтвердите закрытие ещё раз.');
}

function closeCarton(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Не удалось прочитать короб.');
  validateBoxIdempotencyKey_(payload.idempotencyKey);
  if (!String(payload.shipmentId || '').trim() || !String(payload.directionId || '').trim() || !String(payload.cartonId || '').trim()) throw new Error('Обновите карточку короба и повторите.');
  const db = SpreadsheetApp.openById(DB_ID);
  const shipment = requireRitmShipment_(db, payload.shipmentId, payload.directionId);
  const tables = readBoxTables_(db);
  const carton = tables.cartons.records.find(row => String(row.cartonId) === String(payload.cartonId));
  if (!carton || !cartonCloseAllowed_(db,carton,shipment,tables.contents.records)) throw new Error('Короб не найден в этой поставке или направлении.');
  if (isClosedCarton_(carton)) return {ok:true,duplicate:true,dataVersion:getDataVersion()};
  const relatedIds = new Set(normalizeCartonContents_(tables.contents.records).filter(row => String(row.cartonId) === String(carton.cartonId)).map(row => String(row.shipmentId || '')).filter(Boolean));
  relatedIds.add(String(shipment.shipmentId)); if(carton.shipmentId)relatedIds.add(String(carton.shipmentId));
  relatedIds.forEach(id => assertRitmShipmentUnlocked_(id));
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Короба сейчас обновляются. Повторите закрытие через несколько секунд.');
  try {
    const fresh=readBoxTables_(db), current=fresh.cartons.records.find(row=>String(row.cartonId)===String(payload.cartonId));
    if(!current || !cartonCloseAllowed_(db,current,shipment,fresh.contents.records)) throw new Error('Короб больше не доступен в этом направлении. Обновите список.');
    if(isClosedCarton_(current))return {ok:true,duplicate:true,dataVersion:getDataVersion()};
    if(!isOpenCarton_(current['Статус']))throw new Error('Статус короба не подтверждён. Обновите данные.');
    assertCartonCloseRevision_(payload,current,fresh.contents.records);
    relatedIds.forEach(id=>assertLocalShipmentUnlocked_(id));
    updateCartonField_(fresh.cartons.sheet,fresh.cartons.headers,current._rowNumber,'Статус','Закрыт');
    updateCartonField_(fresh.cartons.sheet,fresh.cartons.headers,current._rowNumber,'closedAt',new Date().toISOString());
    return {ok:true,duplicate:false,dataVersion:bumpDataVersion_()};
  } finally {lock.releaseLock();}
}

function closeWarehouseCarton(payload) {
  validateBoxIdempotencyKey_(payload && payload.idempotencyKey);
  if(!isWarehouseCartonId_(payload && payload.cartonId))throw new Error('Выберите складской короб.');
  const lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw new Error('Склад обновляется. Повторите закрытие с тем же запросом.');
  try {
    const db=SpreadsheetApp.openById(DB_ID),tables=readBoxTables_(db);
    const carton=tables.cartons.records.find(row=>String(row.cartonId)===String(payload.cartonId));
    if(!carton || isCancelledCarton_(carton))throw new Error('Складской короб не найден. Обновите список.');
    if(isClosedCarton_(carton))return {ok:true,duplicate:true,cartonId:String(carton.cartonId),number:String(carton['Номер']),dataVersion:getDataVersion()};
    if(!isOpenCarton_(carton['Статус']))throw new Error('Статус складского короба не подтверждён.');
    assertCartonCloseRevision_(payload,carton,tables.contents.records);
    const market=shipmentMarketplace_(carton),store=cartonStoreNumberFromNumber_(carton['Номер']);
    const props=PropertiesService.getScriptProperties(),property=warehouseCartonKey_(store,market);
    updateCartonField_(tables.cartons.sheet,tables.cartons.headers,carton._rowNumber,'Статус','Закрыт');
    updateCartonField_(tables.cartons.sheet,tables.cartons.headers,carton._rowNumber,'closedAt',new Date().toISOString());
    if(props.getProperty(property)===String(carton.cartonId))props.deleteProperty(property);
    return {ok:true,duplicate:false,cartonId:String(carton.cartonId),number:String(carton['Номер']),dataVersion:bumpDataVersion_()};
  } finally {lock.releaseLock();}
}

function boxItemContext_(db, shipmentId, directionId, positionId) {
  const shipment = requireRitmShipment_(db, shipmentId, directionId);
  const item = readShipmentItem_(db, shipment, positionId);
  if (!item) throw new Error('Товар не найден в выбранной поставке. Обновите данные.');
  const packing = readPackedQuantityForItem_(db, shipment, item);
  const workLog = db.getSheetByName(TABLES.workLog);
  return {
    shipment,
    item,
    plan: toNumberOrNull_(item[OPERATION_PLAN_FIELDS.packing]),
    packed: packing.quantity,
    packingKnown: packing.known,
    packingReason: packing.reason,
    workLogLastRow: workLog ? workLog.getLastRow() : 0,
  };
}

function requireRitmShipment_(db, shipmentId, directionId) {
  const shipment = assemblyShipments_(db).find(row =>
    String(row.shipmentId) === String(shipmentId) && String(row.directionId) === String(directionId)
  );
  if (!shipment || shipment.sourceAvailable === false) throw new Error('Источник поставки недоступен. Обновите список перед работой с коробами.');
  return shipment;
}

function cartonMatchesShipment_(carton, shipment) {
  const savedShipmentId = String(carton.shipmentId || '').trim();
  if (savedShipmentId) return savedShipmentId === String(shipment.shipmentId);
  return String(carton.directionId) === String(shipment.directionId) &&
    normalizeCartonScope_(carton['Направление']) === normalizeCartonScope_(shipment['Направление']);
}

// CartonContents is the source of truth for the shipments represented in a
// carton. Never infer an item's origin from the owner of the physical carton.
function cartonLinkedToShipment_(carton, shipment, contents) {
  if (cartonMatchesShipment_(carton, shipment)) return true;
  return (contents || []).some(row => String(row.cartonId || '') === String(carton.cartonId || '') &&
    String(row.shipmentId || '') === String(shipment.shipmentId || '') &&
    String(row.directionId || '') === String(shipment.directionId || ''));
}

function sharedCartonNormKey_(row) {
  return String(row.shipmentId || '') + '|' + normalizeBoxSku_(row['Артикул']);
}

// Preserve the marketplace of every allocation: the same article can have
// different capacity norms in WB and OZON.
function sharedCartonNorms_(db, rows, extraShipment, forceFresh, cacheOnly) {
  const shipments = new Map(assemblyShipments_(db).map(s => [String(s.shipmentId), s]));
  if (extraShipment) shipments.set(String(extraShipment.shipmentId), extraShipment);
  const grouped = { OZON: [], WB: [] };
  (rows || []).forEach(row => {
    const shipment = shipments.get(String(row.shipmentId || ''));
    const market = shipment && shipmentMarketplace_(shipment);
    if (grouped[market]) grouped[market].push(row);
  });
  const result = Object.create(null);
  Object.keys(grouped).forEach(market => {
    const entries = grouped[market];
    if (!entries.length) return;
    const skus = entries.map(row => row['Артикул']);
    const bySku = cacheOnly ? cachedBoxNormsForSkus_(skus, market) : boxNormsForSkus_(skus, forceFresh, market);
    entries.forEach(row => { result[sharedCartonNormKey_(row)] = bySku[normalizeBoxSku_(row['Артикул'])]; });
  });
  return result;
}

function cartonRowNorm_(row, normsBySku) {
  return normsBySku[sharedCartonNormKey_(row)] || normsBySku[normalizeBoxSku_(row['Артикул'])] || null;
}

function ensureCartonShipmentIdColumn_(sheet) { return ensureCartonColumn_(sheet, 'shipmentId'); }

function ensureCartonColumn_(sheet, header) {
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) throw new Error('В листе коробов отсутствуют заголовки.');
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
  if (headers.indexOf(header) >= 0) return headers;
  const nextColumn = lastColumn + 1;
  if (nextColumn > sheet.getMaxColumns()) sheet.insertColumnAfter(sheet.getMaxColumns());
  sheet.getRange(1, nextColumn).setValue(header);
  return headers.concat(header);
}

function normalizeCartonScope_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

function getBoxTableSheets_(db) {
  const cartonsSheet = db.getSheetByName(TABLES.cartons);
  const contentsSheet = db.getSheetByName(TABLES.cartonContents);
  if (!cartonsSheet || !contentsSheet) throw new Error('В хранилище не найдены таблицы коробов.');
  return { cartons: { sheet: cartonsSheet }, contents: { sheet: contentsSheet } };
}

function readBoxTables_(db, sheets) {
  const found = sheets || getBoxTableSheets_(db);
  const cartons = readBoxRecords_(found.cartons.sheet, [
    'cartonId', 'directionId', 'Направление', 'Номер', 'Подтверждённая вместимость, шт',
    'Занято, шт', 'Статус', 'createdAt', 'closedAt', 'source',
  ]);
  const contents = readBoxRecords_(found.contents.sheet, [
    'allocationId', 'cartonId', 'shipmentId', 'directionId', 'positionId', 'Артикул',
    'Количество, шт', 'createdAt', 'eventId',
  ]);
  contents.rawRecords = contents.records;
  contents.records = normalizeCartonContents_(contents.records);
  return { cartons, contents };
}

function boxPlacementTableHeaders_(sheet, requiredHeaders) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) throw new Error('Лист коробов пуст: отсутствуют заголовки.');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const missing = requiredHeaders.filter(header => !headers.includes(header));
  if (missing.length) throw new Error('В листе «' + sheet.getName() + '» отсутствуют колонки: ' + missing.join(', ') + '.');
  return headers;
}

function isWarehouseCartonId_(cartonId) { return String(cartonId || '').startsWith('carton-stock-'); }

function normalizeCartonContents_(rows) {
  const removedByAllocation = Object.create(null);
  const additions = [];
  (rows || []).forEach(row => {
    if (String(row.action || '').trim().toUpperCase() !== 'REMOVE') {
      additions.push(row);
      return;
    }
    const sourceAllocationId = String(row.sourceAllocationId || '').trim();
    const rawQuantity = toNumberOrNull_(row['Количество, шт']);
    if (!sourceAllocationId || rawQuantity === null || rawQuantity >= 0) {
      throw new Error('Журнал коробов содержит некорректную корректировку состава. Обновите данные и обратитесь к руководителю.');
    }
    removedByAllocation[sourceAllocationId] = (removedByAllocation[sourceAllocationId] || 0) + Math.abs(rawQuantity);
  });
  return additions.map(row => {
    const allocationId = String(row.allocationId || '').trim();
    const quantity = validBoxQuantity_(row['Количество, шт']);
    const remaining = Math.max(0, quantity - (removedByAllocation[allocationId] || 0));
    return remaining > 0 ? Object.assign({}, row, { 'Количество, шт': remaining }) : null;
  }).filter(Boolean);
}

function readBoxRecords_(sheet, requiredHeaders) {
  const lastColumn = sheet.getLastColumn();
  if (sheet.getLastRow() < 1 || lastColumn < 1) throw new Error('Лист коробов пуст: отсутствуют заголовки.');
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const missing = requiredHeaders.filter(header => headers.indexOf(header) < 0);
  if (missing.length) throw new Error('В листе «' + sheet.getName() + '» отсутствуют колонки: ' + missing.join(', ') + '.');
  const records = values.slice(1).map((row, index) => ({
    rowNumber: index + 2,
    value: headers.reduce((record, header, column) => { record[header] = row[column]; return record; }, {}),
  })).filter(entry => Object.values(entry.value).some(value => value !== '' && value !== null))
    .map(entry => Object.assign({ _rowNumber: entry.rowNumber }, entry.value));
  return { sheet, headers, records };
}

function readOpenCartonsForShipment_(sheet, shipment) {
  const shipments = Array.isArray(shipment) ? shipment : [shipment];
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 1 || lastColumn < 1) throw new Error('Лист коробов пуст: отсутствуют заголовки.');
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
  const required = ['cartonId', 'directionId', 'Направление', 'Номер', 'Статус'];
  const missing = required.filter(header => headers.indexOf(header) < 0);
  if (missing.length) throw new Error('В листе коробов отсутствуют колонки: ' + missing.join(', ') + '.');
  const records = [];
  if (lastRow < 2) return { sheet, headers, records };
  // Closed cartons form the bulk of the history. Read their single status
  // column first and fetch full rows only around open cartons.
  const statusColumn = headers.indexOf('Статус') + 1;
  const statuses = sheet.getRange(2, statusColumn, lastRow - 1, 1).getValues();
  const blocks = [];
  statuses.forEach((cells, index) => {
    if (!isOpenCarton_(cells[0])) return;
    const row = index + 2;
    const previous = blocks[blocks.length - 1];
    if (previous && row <= previous.end + 21) previous.end = row;
    else blocks.push({ start: row, end: row });
  });
  // A dense or scattered set is cheaper as one read than many small requests.
  const totalRows = blocks.reduce((sum, block) => sum + block.end - block.start + 1, 0);
  const ranges = blocks.length > 30 || totalRows > (lastRow - 1) * 0.6
    ? [{ start: 2, end: lastRow }]
    : blocks;
  ranges.forEach(({ start, end }) => {
    const values = sheet.getRange(start, 1, end - start + 1, lastColumn).getValues();
    values.forEach((cells, offset) => {
      if (!cells.some(value => value !== '' && value !== null)) return;
      const row = headers.reduce((record, header, index) => { record[header] = cells[index]; return record; }, {});
      row._rowNumber = start + offset;
      if (!isWarehouseCartonId_(row.cartonId) && isOpenCarton_(row['Статус']) && shipments.some(scope => cartonMatchesShipment_(row, scope))) records.push(row);
    });
  });
  return { sheet, headers, records };
}

function buildBoxOverview_(context, tables) {
  const itemAllocations = itemAllocationsFor_(tables.contents.records, context);
  const assigned = sumBoxQuantities_(itemAllocations);
  const shipmentAssigned = sumBoxQuantities_(itemAllocations.filter(row => !isWarehouseCartonId_(row.cartonId)));
  const openRecords = tables.cartons.records.filter(row => isOpenCarton_(row['Статус']) &&
    ((tables.listShipments || [context.shipment]).some(scope => cartonMatchesShipment_(row, scope)) || cartonLinkedToShipment_(row, context.shipment, tables.contents.records)));
  const openIds = new Set(openRecords.map(row => String(row.cartonId)));
  const openContents = tables.contents.records.filter(row => openIds.has(String(row.cartonId)));
  const normSkus = openContents.map(row => row['Артикул']).concat([context.item['Артикул']]);
  const norms = sharedCartonNorms_(tables.db, openContents.concat([{ shipmentId: context.shipment.shipmentId, 'Артикул': context.item['Артикул'] }]), context.shipment, false);
  const contentsByCarton = new Map();
  openContents.forEach(row => {
    const id = String(row.cartonId);
    if (!contentsByCarton.has(id)) contentsByCarton.set(id, []);
    contentsByCarton.get(id).push(row);
  });
  const boxes = openRecords.map(row => publicCarton_(row, contentsByCarton.get(String(row.cartonId)) || [], row._rowNumber, norms, true, context.item.positionId));
  boxes.sort((a, b) => Number(b.itemQuantity > 0) - Number(a.itemQuantity > 0) || String(a.number).localeCompare(String(b.number), 'ru'));
  const itemNorm = norms[sharedCartonNormKey_({ shipmentId: context.shipment.shipmentId, 'Артикул': context.item['Артикул'] })] || getBoxPackNorm_(context.item['Артикул'], false, shipmentMarketplace_(context.shipment));
  const packedKnown = context.packingKnown;
  const available = packedKnown ? Math.max(0, context.packed - assigned) : null;
  const itemBoxCount = new Set(itemAllocations.filter(row => !isWarehouseCartonId_(row.cartonId)).map(row => String(row.cartonId)).filter(Boolean)).size;
  return {
    shipment: { id: String(context.shipment.shipmentId), name: String(context.shipment['Название поставки']), directionId: String(context.shipment.directionId), direction: String(context.shipment['Направление']) },
    item: {
      positionId: String(context.item.positionId), sku: String(context.item['Артикул'] || ''), productName: String(context.item['Название товара'] || ''),
      plan: context.plan, packed: packedKnown ? context.packed : null, packedKnown,
      boxType: itemNorm && itemNorm.boxType ? itemNorm.boxType : '',
      unitsPerBox: itemNorm && itemNorm.confirmed ? itemNorm.unitsPerBox : null,
      normSource: itemNorm && itemNorm.confirmed ? itemNorm.source : '',
      normError: itemNorm && !itemNorm.confirmed ? itemNorm.reason : '',
    },
    boxes,
    itemBoxes: boxes.filter(box => box.itemQuantity > 0),
    itemBoxCount,
    assigned, shipmentAssigned,
    available,
    overAllocated: packedKnown && assigned > context.packed,
    closedCount: Number.isFinite(tables.closedCount) ? tables.closedCount : null,
    packingReason: context.packingReason || '',
    dataVersion: getDataVersion(),
  };
}

function publicCarton_(record, contents, rowNumber, normsBySku, includeContents, selectedPositionId) {
  const linked = contents.filter(row => String(row.cartonId) === String(record.cartonId));
  const pieces = linked.reduce((sum, row) => sum + validBoxQuantity_(row['Количество, шт']), 0);
  const space = cartonSpace_(record, linked, normsBySku || {});
  const status = String(record['Статус'] || '');
  const itemQuantity = selectedPositionId
    ? linked.filter(row => String(row.positionId) === String(selectedPositionId)).reduce((sum, row) => sum + validBoxQuantity_(row['Количество, шт']), 0)
    : pieces;
  const result = {
    cartonId: String(record.cartonId || ''), directionId: String(record.directionId || ''), shipmentId: String(record.shipmentId || ''),
    number: String(record['Номер'] || ''), storeNumber: cartonStoreNumberFromNumber_(record['Номер']), boxType: space.boxType,
    legacyCapacity: toNumberOrNull_(record['Подтверждённая вместимость, шт']),
    occupied: pieces, pieceCount: pieces, remaining: null,
    spaceUsed: space.spaceUsed, spaceRemaining: space.spaceRemaining, fillRatio: space.spaceUsed,
    spaceKnown: space.known, blockedReason: space.reason,
    status, open: isOpenCarton_(status), closed: isClosedCarton_(record),
    createdAt: normalizeDateString_(record.createdAt), rowNumber,
    itemQuantity, closeRevision:cartonCloseRevision_(record,contents),
    skuCount: new Set(linked.map(row => normalizeBoxSku_(row['Артикул'])).filter(Boolean)).size,
  };
  if (includeContents) result.contents = linked.map(row => {
    const norm = cartonRowNorm_(row, normsBySku);
    return {
      shipmentId: String(row.shipmentId || ''), positionId: String(row.positionId || ''),
      sku: String(row['Артикул'] || ''), quantity: validBoxQuantity_(row['Количество, шт']),
      norm: norm && norm.confirmed ? { boxType: norm.boxType, unitsPerBox: norm.unitsPerBox, source: norm.source } : null,
    };
  });
  return result;
}

function cartonTypeSummary_(linked, normsBySku, declaredType) {
  const types = Object.create(null);
  (linked || []).forEach(row => {
    const norm = cartonRowNorm_(row, normsBySku);
    if (!norm || !norm.confirmed || !norm.boxType) return;
    const key = normalizeCartonScope_(norm.boxType);
    if (key && !types[key]) types[key] = String(norm.boxType).trim();
  });
  const values = Object.keys(types).map(key => types[key]).sort((a, b) => a.localeCompare(b, 'ru'));
  if (!values.length && String(declaredType || '').trim()) values.push(String(declaredType).trim());
  return values.length > 1 ? 'Микс: ' + values.join(' + ') : (values[0] || '');
}

function cartonSpace_(carton, linked, normsBySku) {
  let spaceUsed = 0;
  let known = true;
  let reason = '';
  linked.forEach(row => {
    const quantity = validBoxQuantity_(row['Количество, шт']);
    const norm = cartonRowNorm_(row, normsBySku);
    if (!norm || !norm.confirmed || !norm.unitsPerBox || !norm.boxType) {
      known = false;
      reason = reason || ('Не найдена подтверждённая норма короба для ' + String(row['Артикул'] || 'артикула') + '.');
      return;
    }
    spaceUsed += quantity / norm.unitsPerBox;
  });
  const declaredType = String(carton['Тип короба'] || '').trim();
  const boxType = cartonTypeSummary_(linked, normsBySku || {}, declaredType);
  if (!linked.length && !boxType) {
    known = false;
    reason = reason || 'Для пустого короба не подтверждён тип. Используйте «Новый короб».';
  }
  if (!known) return { known: false, reason, boxType, spaceUsed: null, spaceRemaining: null };
  return { known: true, reason: '', boxType, spaceUsed, spaceRemaining: Math.max(0, 1 - spaceUsed) };
}

function boxPlacementResult_(context, allocation, tables, cartonIndex, duplicate, normsBySku) {
  const carton = tables.cartons.records[cartonIndex];
  const publicCarton = publicCarton_(carton, tables.contents.records, carton._rowNumber || cartonIndex + 2, normsBySku, true, allocation.positionId);
  const itemAllocations = itemAllocationsFor_(tables.contents.records, context);
  const assigned = sumBoxQuantities_(itemAllocations);
  const shipmentAssigned = sumBoxQuantities_(itemAllocations.filter(row => !isWarehouseCartonId_(row.cartonId)));
  const itemBoxCount = new Set(itemAllocations.filter(row => !isWarehouseCartonId_(row.cartonId)).map(row => String(row.cartonId)).filter(Boolean)).size;
  return {
    ok: true, duplicate,
    allocation: { allocationId: String(allocation.allocationId), cartonId: String(allocation.cartonId), shipmentId: String(allocation.shipmentId), directionId: String(allocation.directionId), positionId: String(allocation.positionId), quantity: Number(allocation['Количество, шт']), sku: String(allocation['Артикул'] || ''), createdAt: normalizeDateString_(allocation.createdAt) },
    carton: publicCarton,
    assigned, shipmentAssigned,
    available: context.packingKnown ? Math.max(0, context.packed - assigned) : null,
    itemBoxCount,
    dataVersion: getDataVersion(),
  };
}

function boxAllocationMatchesPayload_(allocation, payload) {
  const expectedCartonId = payload.mode === 'new' ? 'carton-' + String(payload.idempotencyKey) : String(payload.cartonId || '');
  return String(allocation.shipmentId) === String(payload.shipmentId) &&
    String(allocation.directionId) === String(payload.directionId) &&
    String(allocation.positionId) === String(payload.positionId) &&
    String(allocation.cartonId) === expectedCartonId &&
    Number(allocation['Количество, шт']) === Number(payload.quantity);
}

function cartonDerived_(carton, contents, normsBySku) {
  const linked = contents.filter(row => String(row.cartonId) === String(carton.cartonId));
  return { occupied: linked.reduce((sum, row) => sum + validBoxQuantity_(row['Количество, шт']), 0), space: cartonSpace_(carton, linked, normsBySku || {}), status: String(carton['Статус'] || 'Открыт') };
}

function updateCartonDerived_(sheet, headers, rowNumber, derived) {
  const occupiedIndex = headers.indexOf('Занято, шт');
  if (occupiedIndex >= 0) sheet.getRange(rowNumber, occupiedIndex + 1).setValue(derived.occupied);
}

function updateCartonField_(sheet, headers, rowNumber, field, value) {
  const index = headers.indexOf(field);
  if (index >= 0) sheet.getRange(rowNumber, index + 1).setValue(value);
}

function appendRecordByHeaders_(sheet, headers, record) {
  const row = headers.map(header => Object.prototype.hasOwnProperty.call(record, header) ? ritmLiteral_(record[header]) : '');
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length).setValues([row]);
}

function validateBoxPlacementPayload_(payload, requirePreview) {
  if (!payload || typeof payload !== 'object') throw new Error('Не удалось прочитать размещение.');
  validateBoxIdempotencyKey_(payload.idempotencyKey);
  if (!String(payload.shipmentId || '').trim() || !String(payload.directionId || '').trim() || !String(payload.positionId || '').trim()) throw new Error('Выберите товар из поставки.');
  if (payload.mode !== 'new' && payload.mode !== 'existing') throw new Error('Выберите существующий короб или «Новый короб».');
  if (payload.mode === 'existing' && !String(payload.cartonId || '').trim()) throw new Error('Выберите открытый короб.');
  if (payload.mode === 'existing' && isWarehouseCartonId_(payload.cartonId) && payload.warehouse !== true) throw new Error('Складской короб нельзя использовать как короб поставки.');
  if (payload.warehouse === true && (!String(payload.parentKey || '').trim() || !String(payload.idempotencyKey || '').startsWith('stock-') || (payload.mode === 'existing' && !isWarehouseCartonId_(payload.cartonId)))) throw new Error('Складской короб используется только при подтверждённом распределении излишка.');
  if (requirePreview && !String(payload.previewId || '').trim()) throw new Error('Сначала нажмите «Проверить и добавить».');
  const quantity = Number(payload.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Количество должно быть целым числом больше нуля.');
}

function validateBoxIdempotencyKey_(value) {
  const key = String(value || '').trim();
  if (!/^[-A-Za-z0-9_]{12,100}$/.test(key)) throw new Error('Не удалось проверить повторную отправку. Обновите форму и повторите.');
  return key;
}

function normalizeCartonNumber_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

function normalizeBoxSku_(value) { return String(value || '').trim().toLocaleUpperCase('ru-RU'); }

function boxQuoteCacheKey_(id) { return 'ritm.assembly.boxQuote.' + String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100); }

function boxPlacementRequestKey_(payload) {
  return {
    idempotencyKey: String(payload.idempotencyKey), mode: String(payload.mode),
    shipmentId: String(payload.shipmentId), directionId: String(payload.directionId),
    positionId: String(payload.positionId), cartonId: String(payload.cartonId || ''), quantity: Number(payload.quantity),
    boxSourceShipmentId: String(payload.boxSourceShipmentId || ''),
    ...(payload.employeeId ? { employeeId: String(payload.employeeId) } : {}),
  };
}

function itemAllocationsFor_(contents, context) {
  return contents.filter(row => {
    if (String(row.directionId) !== String(context.shipment.directionId) || String(row.positionId) !== String(context.item.positionId)) return false;
    const shipmentId = String(row.shipmentId || '').trim();
    return !shipmentId || shipmentId === String(context.shipment.shipmentId);
  });
}

function sumBoxQuantities_(rows) { return rows.reduce((sum, row) => sum + validBoxQuantity_(row['Количество, шт']), 0); }

function readPackedQuantityForItem_(db, shipment, item) {
  const sheet = db.getSheetByName(TABLES.workLog);
  if (!sheet || sheet.getLastRow() < 1) return { known: false, quantity: null, reason: 'Журнал WorkLog недоступен.' };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const required = ['eventId', 'shipmentId', 'directionId', 'positionId', 'operationId', 'Количество, шт'];
  const missing = required.filter(header => headers.indexOf(header) < 0);
  if (missing.length) return { known: false, quantity: null, reason: 'В WorkLog отсутствуют поля: ' + missing.join(', ') + '.' };
  // Position IDs are stable and selective. Still verify shipment, direction,
  // operation, source and cancellations below before using any quantity.
  const rows = readRowsByKey_(sheet, 'positionId', new Set([String(item.positionId)]));
  const matchingRows = rows.filter(row =>
    String(row.shipmentId) === String(shipment.shipmentId) &&
    String(row.directionId) === String(shipment.directionId) &&
    String(row.positionId) === String(item.positionId) &&
    String(row.operationId) === 'packing' &&
    String(row['Источник'] || '').trim().toUpperCase() === 'WEB_APP_RITM'
  );
  // A cancelled WorkLog row stays in the append-only history, but it is no
  // longer evidence that any units are available to place in a carton.
  const cancelledEventIds = readWorkCancellationState_(db, matchingRows).byEventId;
  let quantity = 0;
  let invalid = false;
  const seen = new Set();
  matchingRows.forEach(row => {
    const eventId = String(row.eventId || '').trim();
    if (!eventId) { invalid = true; return; }
    if (seen.has(eventId)) return;
    seen.add(eventId);
    if (cancelledEventIds[eventId]) return;
    const amount = toNumberOrNull_(row['Количество, шт']);
    if (!Number.isSafeInteger(amount) || amount < 1) { invalid = true; return; }
    quantity += amount;
  });
  if (invalid) return { known: false, quantity: null, reason: 'В журнале есть некорректные записи упаковки; проверьте WorkLog.' };
  return { known: true, quantity, reason: '' };
}

function reconcileBoxContentsAfterWorkCancellation_(db, event, cancelledEventId, cancellationReason) {
  if (String(event.operationId || '') !== 'packing') return { removed: 0, cartons: 0 };
  const shipmentId = String(event.shipmentId || '').trim();
  const directionId = String(event.directionId || '').trim();
  const positionId = String(event.positionId || '').trim();
  if (!shipmentId || !directionId || !positionId) throw new Error('Не удалось сверить короб с отменённой упаковкой. Повторите отмену позже.');

  const context = { shipment: { shipmentId, directionId }, item: { positionId } };
  const packed = readPackedQuantityForItem_(db, context.shipment, context.item);
  if (!packed.known || packed.quantity === null) throw new Error(packed.reason || 'Не удалось подтвердить упаковку после отмены.');
  const contentsSheet = db.getSheetByName(TABLES.cartonContents);
  const cartonsSheet = db.getSheetByName(TABLES.cartons);
  if (!contentsSheet || !cartonsSheet) throw new Error('В хранилище не найдены таблицы коробов.');
  const rawContents = readRowsByKey_(contentsSheet, 'positionId', new Set([positionId]));
  const allocations = itemAllocationsFor_(normalizeCartonContents_(rawContents), context)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || Number(b._rowNumber || 0) - Number(a._rowNumber || 0));
  const assigned = sumBoxQuantities_(allocations);
  let excess = Math.max(0, assigned - packed.quantity);
  const priorRemovals = rawContents.filter(row =>
    String(row.action || '').trim().toUpperCase() === 'REMOVE' &&
    String(row.sourceWorkEventId || '') === cancelledEventId
  );
  const affectedCartons = new Set(priorRemovals.map(row => String(row.cartonId || '')).filter(Boolean));
  const removedByCarton = Object.create(null);
  priorRemovals.forEach(row => {
    const cartonId = String(row.cartonId || '');
    const amount = Math.abs(toNumberOrNull_(row['Количество, шт']) || 0);
    if (!cartonId || !amount) return;
    removedByCarton[cartonId] = (removedByCarton[cartonId] || 0) + amount;
  });
  if (!excess && !affectedCartons.size) return { removed: 0, cartons: 0 };

  let contentsHeaders = contentsSheet.getRange(1, 1, 1, contentsSheet.getLastColumn()).getValues()[0].map(String);
  ['action', 'sourceAllocationId', 'sourceWorkEventId', 'reason'].forEach(header => {
    contentsHeaders = ensureCartonColumn_(contentsSheet, header);
  });
  let newlyRemoved = 0;
  allocations.forEach(allocation => {
    if (!excess) return;
    const available = validBoxQuantity_(allocation['Количество, шт']);
    if (!available) return;
    const amount = Math.min(excess, available);
    const hashInput = [cancelledEventId, allocation.allocationId, String(excess), String(amount)].join('|');
    const correctionId = 'remove-' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, hashInput)).slice(0, 40);
    const correction = {
      allocationId: correctionId,
      cartonId: String(allocation.cartonId || ''),
      shipmentId,
      directionId,
      positionId,
      'Артикул': String(allocation['Артикул'] || event['Артикул'] || ''),
      'Количество, шт': -amount,
      createdAt: new Date().toISOString(),
      eventId: Utilities.getUuid(),
      action: 'REMOVE',
      sourceAllocationId: String(allocation.allocationId || ''),
      sourceWorkEventId: cancelledEventId,
      reason: String(cancellationReason || ''),
    };
    appendRecordByHeaders_(contentsSheet, contentsHeaders, correction);
    const cartonId = String(allocation.cartonId || '');
    affectedCartons.add(cartonId);
    removedByCarton[cartonId] = (removedByCarton[cartonId] || 0) + amount;
    newlyRemoved += amount;
    excess -= amount;
  });
  if (excess > 0) throw new Error('Не удалось полностью сверить состав короба с активной упаковкой. Проверьте короб и повторите отмену.');

  const updatedContents = normalizeCartonContents_(readRowsByKey_(contentsSheet, 'cartonId', affectedCartons));
  let cartonHeaders = cartonsSheet.getRange(1, 1, 1, cartonsSheet.getLastColumn()).getValues()[0].map(String);
  let derivedChanged = false;
  const cancelledCartonIds = [];
  affectedCartons.forEach(cartonId => {
    const carton = findRowByHeaderValue_(cartonsSheet, 'cartonId', cartonId);
    if (!carton) return;
    const occupied = updatedContents
      .filter(row => String(row.cartonId) === cartonId)
      .reduce((sum, row) => sum + validBoxQuantity_(row['Количество, шт']), 0);
    if (toNumberOrNull_(carton['Занято, шт']) !== occupied) {
      updateCartonDerived_(cartonsSheet, cartonHeaders, carton._rowNumber, { occupied });
      derivedChanged = true;
    }
    if (occupied === 0 && !isCancelledCarton_(carton)) {
      ['cancelledAt', 'cancelledByWorkEventId', 'cancellationReason', 'statusBeforeCancellation'].forEach(header => {
        cartonHeaders = ensureCartonColumn_(cartonsSheet, header);
      });
      updateCartonField_(cartonsSheet, cartonHeaders, carton._rowNumber, 'statusBeforeCancellation', String(carton['Статус'] || ''));
      updateCartonField_(cartonsSheet, cartonHeaders, carton._rowNumber, 'cancelledAt', new Date().toISOString());
      updateCartonField_(cartonsSheet, cartonHeaders, carton._rowNumber, 'cancelledByWorkEventId', cancelledEventId);
      updateCartonField_(cartonsSheet, cartonHeaders, carton._rowNumber, 'cancellationReason', String(cancellationReason || 'Отмена упаковки'));
      updateCartonField_(cartonsSheet, cartonHeaders, carton._rowNumber, 'Статус', 'Отменён');
      derivedChanged = true;
      cancelledCartonIds.push(cartonId);
    }
  });
  const removed = Object.keys(removedByCarton).reduce((sum, cartonId) => sum + removedByCarton[cartonId], 0);
  return { removed, removedByCarton, cancelledCartonIds, cartons: affectedCartons.size, changed: newlyRemoved > 0 || derivedChanged };
}

// Owner maintenance is separate from normal read endpoints. Re-publishing code
// does not replay historical cancellations; this audits the whole carton ledger
// and resumes only cancellations that already have explicit CANCEL evidence.
function auditCancelledPackingCartons() {
  requireAssemblyMaintenanceOwner_();
  return auditCancelledPackingCartons_(SpreadsheetApp.openById(DB_ID));
}

function requireAssemblyMaintenanceOwner_() {
  if (Session.getActiveUser().getEmail() !== 'zinovevkirill234@gmail.com' ||
      Session.getEffectiveUser().getEmail() !== 'zinovevkirill234@gmail.com') {
    throw new Error('Сверка коробов доступна только владельцу проекта.');
  }
}

function auditCancelledPackingCartons_(db) {
  const tables = readBoxTables_(db);
  const groups = new Map();
  tables.contents.records.forEach(row => {
    if (!(/^RITM-ROLL-\d+$/.test(String(row.shipmentId || '')) || isAssemblyStock_(row.shipmentId)) || String(row.directionId) !== 'ROLL') return;
    const key = JSON.stringify([String(row.shipmentId), String(row.directionId), String(row.positionId)]);
    if (!groups.has(key)) groups.set(key, {
      shipmentId: String(row.shipmentId), directionId: String(row.directionId),
      positionId: String(row.positionId), sku: String(row['Артикул'] || ''),
      assigned: 0, packed: 0, cancelledEventId: '', cancelledAt: '', cartons: [],
    });
    const group = groups.get(key);
    group.assigned += validBoxQuantity_(row['Количество, шт']);
    if (!group.cartons.includes(String(row.cartonId))) group.cartons.push(String(row.cartonId));
  });
  const workLog = db.getSheetByName(TABLES.workLog);
  if (!workLog || workLog.getLastColumn() < 1) throw new Error('Журнал WorkLog недоступен; состав коробов не менялся.');
  const headers = workLog.getRange(1, 1, 1, workLog.getLastColumn()).getValues()[0].map(String);
  if (['eventId', 'shipmentId', 'directionId', 'positionId', 'operationId', 'Источник', 'Количество, шт'].some(h => !headers.includes(h))) {
    throw new Error('Структура WorkLog не подтверждена; состав коробов не менялся.');
  }
  // Include fully reversed allocations too: their empty cartons may still have
  // an old open/closed status from before audited carton cancellation existed.
  const shipmentIds = new Set(tables.contents.rawRecords.map(row => String(row.shipmentId || '')).filter(id => /^RITM-ROLL-\d+$/.test(id) || isAssemblyStock_(id)));
  const rows = readRowsByKey_(workLog, 'shipmentId', shipmentIds);
  const cancellations = readWorkCancellationState_(db, rows).byEventId;
  const seen = new Set();
  rows.forEach(row => {
    if (String(row['Источник'] || '').trim().toUpperCase() !== 'WEB_APP_RITM' || String(row.operationId) !== 'packing') return;
    const key = JSON.stringify([String(row.shipmentId), String(row.directionId), String(row.positionId)]);
    const group = groups.get(key);
    if (!group) return;
    const eventId = String(row.eventId || '').trim();
    if (!eventId || seen.has(eventId)) throw new Error('В WorkLog отсутствует или повторяется ID события; сверка остановлена.');
    seen.add(eventId);
    const quantity = toNumberOrNull_(row['Количество, шт']);
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('В WorkLog некорректное количество; сверка остановлена.');
    const cancellation = cancellations[eventId];
    if (!cancellation) group.packed += quantity;
    else if (cancellation.createdAt > group.cancelledAt) {
      group.cancelledEventId = eventId;
      group.cancelledAt = cancellation.createdAt;
    }
  });
  const positions = Array.from(groups.values(), group => Object.assign(group, {
    excess: Math.max(0, group.assigned - group.packed),
    canReconcile: Boolean(group.cancelledEventId),
  }));
  const cartonTotals = tables.cartons.records.map(carton => {
    const cartonId = String(carton.cartonId);
    const assigned = sumBoxQuantities_(tables.contents.records.filter(row => String(row.cartonId) === cartonId));
    const removal = tables.contents.rawRecords.find(row => String(row.cartonId) === cartonId &&
      String(row.action || '').toUpperCase() === 'REMOVE' && cancellations[String(row.sourceWorkEventId || '')] &&
      rows.some(event => String(event.eventId) === String(row.sourceWorkEventId) && String(event.operationId) === 'packing' &&
        String(event.shipmentId) === String(row.shipmentId) && String(event.directionId) === String(row.directionId) && String(event.positionId) === String(row.positionId)));
    return { cartonId, number: String(carton['Номер']), status: String(carton['Статус']),
      stored: toNumberOrNull_(carton['Занято, шт']), assigned,
      retireEventId: assigned === 0 && !isCancelledCarton_(carton) && removal ? String(removal.sourceWorkEventId) : '',
    };
  });
  return { positions, cartons: cartonTotals, excess: positions.reduce((sum, position) => sum + position.excess, 0) };
}

function reconcileCancelledPackingCartons() {
  requireAssemblyMaintenanceOwner_();
  const db = SpreadsheetApp.openById(DB_ID);
  const before = auditCancelledPackingCartons_(db);
  const results = [];
  const eventIds = new Set(before.positions.filter(position => position.excess > 0 && position.canReconcile).map(position => position.cancelledEventId));
  before.cartons.forEach(carton => { if (carton.retireEventId) eventIds.add(carton.retireEventId); });
  eventIds.forEach(eventId => {
    // cancelWork takes the script lock and rereads active facts before writing.
    // A concurrent new packing event can therefore reduce the required removal.
    results.push(cancelWork(eventId, 'Сверка состава короба после ранее отменённой упаковки'));
  });
  return { before, after: auditCancelledPackingCartons_(db), results };
}

function boxNormsForSkus_(skus, forceFresh, marketplace) {
  const result = Object.create(null);
  const keys = Array.from(new Set((skus || []).map(normalizeBoxSku_).filter(Boolean)));
  if (!['OZON', 'WB'].includes(marketplace)) {
    keys.forEach(sku => { result[sku] = { confirmed: false, reason: 'Не удалось определить OZON или WB по названию поставки.' }; });
    return result;
  }

  const cache = CacheService.getScriptCache();
  // A forced read must retire the old confirmation even if the new value is
  // missing, conflicting or temporarily unavailable. Compact carton cards must
  // not resurrect a capacity which the owner has just refreshed.
  if (forceFresh === true && keys.length) cache.removeAll(keys.map(sku => boxPackNormCacheKey_(sku, marketplace)));
  const cachedValues = forceFresh === true || !keys.length ? {} : cache.getAll(keys.map(sku => boxPackNormCacheKey_(sku, marketplace)));
  const missing = [];
  keys.forEach(sku => {
    const cached = cachedValues[boxPackNormCacheKey_(sku, marketplace)];
    const parsed = cached ? parseSyncJson_(cached, null) : null;
    if (parsed && parsed.confirmed === true) result[sku] = parsed;
    else missing.push(sku);
  });
  if (!missing.length) return result;

  // Resolve every cache miss from the selected marketplace catalog tab in one pass.
  // The previous implementation reopened the workbook and searched both tabs
  // once per SKU, making a mixed carton's preflight especially slow.
  const wanted = new Set(missing);
  const matchesBySku = Object.create(null);
  missing.forEach(sku => { matchesBySku[sku] = []; });
  try {
    [marketplace].forEach(tabName => {
      const catalog=cartonCatalogRead_(tabName),sheet=catalog.sheet;
      const lastRow = catalog.lastRow;
      const lastColumn = catalog.lastColumn;
      if (lastRow < 2 || lastColumn < 2) return;
      const width = Math.min(30, lastColumn);
      const headers = catalog.headers.slice(0,width);
      const keyWidth = Math.min(2, lastColumn);
      const keyRows = catalog.keyRows;
      const matchedRows = new Set();
      keyRows.forEach((cells, offset) => {
        const rowNumber = offset + 2;
        const rowKeys = new Set(cells.map(value => String(value || '').toLocaleUpperCase('ru-RU')));
        rowKeys.forEach(key => {
          if (!wanted.has(key)) return;
          matchedRows.add(rowNumber);
        });
      });
      if (!matchedRows.size) return;

      // Read only the norm columns, once for the selected catalog tab. Sparse per-SKU row
      // reads made a 147-item shipment wait for dozens of Sheets round trips.
      const normColumns = ['В коробке', 'Кол-во вида', 'Тип короба'].map(name => headers.indexOf(name)).filter(index => index >= 0);
      if (!normColumns.length) return;
      const firstColumn = Math.min(...normColumns), normLastColumn = Math.max(...normColumns);
      const normRows = cartonCatalogColumns_(catalog,firstColumn+1,normLastColumn-firstColumn+1);
      matchedRows.forEach(rowNumber => {
        const rowValues = normRows[rowNumber - 2];
        const row = {};
        normColumns.forEach(index => { row[headers[index]] = rowValues[index - firstColumn]; });
        const rowNorm = boxPackNormFromCatalogRow_(row, tabName, rowNumber);
        const rowKeys = new Set(keyRows[rowNumber - 2].map(value => String(value || '').toLocaleUpperCase('ru-RU')));
        rowKeys.forEach(key => { if (wanted.has(key)) matchesBySku[key].push({ norm: rowNorm, rowNumber, tabName }); });
      });
    });

    const confirmedCache = {};
    missing.forEach(sku => {
      const matches = matchesBySku[sku].map(match => match.norm);
      const valid = matches.filter(row => row.confirmed);
      // The catalog can confirm a type even when capacity values disagree.
      // Expose that type for display; placement still requires confirmed=true.
      const types = Array.from(new Set(matches.map(row => row.boxType).filter(Boolean).map(normalizeCartonScope_)));
      const displayType = types.length === 1 && matches.every(row => row.boxType)
        ? matches[0].boxType : '';
      if (!valid.length) {
        result[sku] = Object.assign({}, matches[0] || { confirmed: false, reason: 'Во вкладке ' + marketplace + ' базы не найдена подтверждённая норма «Тип короба» / «В коробке».' }, { boxType: displayType });
        return;
      }
      const signatures = Array.from(new Set(valid.map(row => normalizeCartonScope_(row.boxType) + '|' + row.unitsPerBox)));
      if (signatures.length !== 1) {
        result[sku] = { confirmed: false, boxType: displayType, reason: 'Во вкладке ' + marketplace + ' базы для артикула расходятся тип короба или количество в коробе.' };
        return;
      }
      result[sku] = valid[0];
      // Display snapshots reuse these rare-changing norms for ten minutes.
      // Final placement checks call this resolver with forceFresh=true.
      confirmedCache[boxPackNormCacheKey_(sku, marketplace)] = JSON.stringify(valid[0]);
    });
    if (Object.keys(confirmedCache).length) cache.putAll(confirmedCache, 600);
  } catch (error) {
    const reason = 'Не удалось прочитать норму короба из базы: ' + String(error.message || 'ошибка доступа').slice(0, 120);
    missing.forEach(sku => { result[sku] = { confirmed: false, reason }; });
  }
  return result;
}

function boxPackNormCacheKey_(keySku, marketplace) {
  return 'ritm.assembly.packNorm.v2.' + String(marketplace || 'unknown') + '.' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, keySku)).slice(0, 40);
}

function storeNumberSkuKey_(sku, source) {
  return String(source || '*').trim().toLocaleUpperCase('ru-RU') + '|' + normalizeBoxSku_(sku);
}

function storeNumbersForItems_(items, forceFresh) {
  const result = Object.create(null);
  const entries = Array.from(new Map((items || []).map(item => {
    const sku = normalizeBoxSku_(item && item.sku);
    const source = ['OZON', 'WB'].includes(String(item && item.source || '').trim().toLocaleUpperCase('ru-RU'))
      ? String(item.source).trim().toLocaleUpperCase('ru-RU') : '';
    return [storeNumberSkuKey_(sku, source), { sku, source }];
  }).filter(entry => entry[1].sku)).values()).filter(entry => {
    if (entry.source) return true;
    result[storeNumberSkuKey_(entry.sku, '')] = null;
    return false;
  });
  const keys = entries.map(entry => storeNumberSkuKey_(entry.sku, entry.source));
  if (!keys.length) return result;
  const cache = CacheService.getScriptCache();
  const cacheKeys = keys.map(storeNumberCacheKey_);
  const cached = forceFresh === true ? {} : cache.getAll(cacheKeys);
  const missing = [];
  entries.forEach((entry, index) => {
    const parsed = parseSyncJson_(cached[cacheKeys[index]], null);
    const key = keys[index];
    if (Array.isArray(parsed)) result[key] = parsed;
    else missing.push(entry);
  });
  if (!missing.length) return result;

  const wanted = new Set(missing.map(entry => storeNumberSkuKey_(entry.sku, entry.source)));
  const storesBySku = Object.create(null);
  missing.forEach(entry => { storesBySku[storeNumberSkuKey_(entry.sku, entry.source)] = new Set(); });
  try {
    // Store is the final column on each marketplace's product tab. Read it
    // beside that tab's article aliases so similarly named SKUs cannot cross stores.
    ['OZON', 'WB'].forEach(tabName => {
      const relevant = missing.filter(entry => entry.source === tabName);
      if (!relevant.length) return;
      const catalog=cartonCatalogRead_(tabName),sheet=catalog.sheet;
      const lastRow = catalog.lastRow, lastColumn = catalog.lastColumn;
      const headers = catalog.headers
        .map(value => String(value || '').trim().toLocaleLowerCase('ru-RU'));
      const storeIndex = headers.indexOf('магазин');
      if (storeIndex < 0) throw new Error('Во вкладке «' + tabName + '» не найдена колонка «Магазин».');
      if (lastRow < 2) return;
      const articleRows = catalog.keyRows;
      const storeRows = cartonCatalogColumns_(catalog,storeIndex+1,1);
      articleRows.forEach((row, offset) => {
        const store = String(storeRows[offset][0] || '').trim();
        if (!store || /^#(?:N\/A|REF!|VALUE!|ERROR!)/i.test(store)) return;
        row.forEach(alias => {
          const sku = normalizeBoxSku_(alias);
          const exactKey = storeNumberSkuKey_(sku, tabName);
          if (wanted.has(exactKey)) storesBySku[exactKey].add(store);
        });
      });
    });
    const writeCache = {};
    missing.forEach(entry => {
      const key = storeNumberSkuKey_(entry.sku, entry.source);
      result[key] = Array.from(storesBySku[key]).sort((a, b) => a.localeCompare(b, 'ru-RU', { numeric: true }));
      writeCache[storeNumberCacheKey_(key)] = JSON.stringify(result[key]);
    });
    if (Object.keys(writeCache).length) cache.putAll(writeCache, 300);
  } catch (_) {
    missing.forEach(entry => { result[storeNumberSkuKey_(entry.sku, entry.source)] = null; });
  }
  return result;
}

function storeNumberCacheKey_(sku) {
  return 'ritm.assembly.store.v3.' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, sku)).slice(0, 40);
}

function getBoxPackNorm_(sku, forceFresh, marketplace) {
  const keySku = normalizeBoxSku_(sku);
  if (!keySku) return { confirmed: false, reason: 'Артикул не указан.' };
  return boxNormsForSkus_([keySku], forceFresh === true, marketplace)[keySku] || { confirmed: false, reason: 'Не удалось прочитать норму короба.' };
}

function boxPackNormFromCatalogRow_(record, tabName, rowNumber) {
  const capacityText = String(record['В коробке'] || '').trim();
  const capacityMatch = capacityText.match(/^(\d+(?:[.,]\d+)?)(?:\s+(.+))?$/);
  const fromBox = capacityMatch ? toNumberOrNull_(capacityMatch[1].replace(',', '.')) : null;
  const fromType = toNumberOrNull_(record['Кол-во вида']);
  const declaredType = String(record['Тип короба'] || '').trim();
  const suffixType = capacityMatch && capacityMatch[2] ? String(capacityMatch[2]).trim() : '';
  const boxType = declaredType || suffixType;
  if (declaredType && suffixType && normalizeCartonScope_(declaredType) !== normalizeCartonScope_(suffixType)) return { confirmed: false, reason: 'В каталоге для артикула расходятся колонки «Тип короба» и «В коробке».' };
  if (fromBox !== null && fromType !== null && fromBox !== fromType) return { confirmed: false, boxType, reason: 'В каталоге для артикула расходятся «Кол-во вида» и «В коробке».' };
  const unitsPerBox = fromBox !== null ? fromBox : fromType;
  if (!boxType || !Number.isSafeInteger(unitsPerBox) || unitsPerBox < 1) return { confirmed: false, boxType, reason: 'Для артикула в каталоге не подтверждены тип короба и целое количество штук в коробе.' };
  return { confirmed: true, boxType, unitsPerBox, source: 'БАЗА FBO · ' + tabName + ' · строка ' + rowNumber };
}

// Split a single request using confirmed quantities, never the total amount
// entered in previous work events. Physical cartons already on the warehouse
// are included in totalAssigned but not shipmentAssigned.
function planExcessPlacement_(input) {
  const keys = ['plan', 'packed', 'totalAssigned', 'shipmentAssigned', 'quantity', 'capacity'];
  const values = Object.create(null);
  keys.forEach(key => {
    if (input[key] === null || input[key] === undefined || input[key] === '') throw new Error('Не подтверждены целые количества плана, упаковки или короба.');
    const value = Number(input[key]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Не подтверждены целые количества плана, упаковки или короба.');
    values[key] = value;
  });
  if (!values.quantity || !values.capacity) throw new Error('Количество и вместимость должны быть больше нуля.');
  if (values.shipmentAssigned > values.totalAssigned || values.totalAssigned > values.packed) throw new Error('Распределение не совпадает с подтверждённой упаковкой.');
  if (values.quantity > values.packed - values.totalAssigned) throw new Error('Недостаточно подтверждённой упаковки для размещения.');
  const shipment = Math.min(values.quantity, Math.max(0, values.plan - values.shipmentAssigned));
  const excess = values.quantity - shipment;
  // Warehouse containers are changed manually. Capacity limits still apply to
  // shipment cartons, but never split warehouse excess into a carton per SKU.
  const stockBoxes = excess ? [excess] : [];
  return { shipment, excess, stockBoxes };
}

function stockDigest_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text))).slice(0, 32);
}

function stockReservationKey_(shipmentId, positionId) {
  return 'ritm.assembly.stock.reservation.' + stockDigest_(String(shipmentId) + '|' + String(positionId));
}

function stockOperationKey_(idempotencyKey) { return 'ritm.assembly.stock.operation.' + stockDigest_(idempotencyKey); }

function ensureStockAuditColumns_(db) {
  const sheet = db.getSheetByName(TABLES.cartonContents);
  if (!sheet) throw new Error('Журнал состава коробов не найден.');
  ['action', 'sourceAllocationId', 'sourceWorkEventId', 'reason'].forEach(header => ensureCartonColumn_(sheet, header));
  const expected = ['employeeId', 'Сотрудник'];
  const current = sheet.getRange(1, 14, 1, 2).getValues()[0].map(String);
  if (current.some((value, i) => value && value !== expected[i])) throw new Error('Колонки автора в журнале заняты другими данными.');
  if (current.some((value, i) => value !== expected[i])) sheet.getRange(1, 14, 1, 2).setValues([expected]);
}

// Read-only warehouse view: corrections are normalized, packing and shipment boxes are untouched.
function getWarehouseStock() {
  const db = SpreadsheetApp.openById(DB_ID);
  const cartons = readTable_(db, TABLES.cartons).filter(row => isWarehouseCartonId_(row.cartonId) && !isCancelledCarton_(row));
  const ids = new Set(cartons.map(row => String(row.cartonId)));
  const contents = normalizeCartonContents_(readTable_(db, TABLES.cartonContents).filter(row => ids.has(String(row.cartonId))));
  const products = warehouseStockProducts_(db, cartons, contents);
  let sourceNames = new Map();
  try { sourceNames = new Map(assemblyShipments_(db).map(shipment => [String(shipment.shipmentId),String(shipment['Направление'] || shipment['Название поставки'] || '')])); } catch (_) { /* Physical stock remains visible with historical source IDs. */ }
  const props = PropertiesService.getScriptProperties();
  return { ok: true, dataVersion:getDataVersion(), checkedAt: new Date().toISOString(), cartons: cartons.map(carton => ({
    cartonId: String(carton.cartonId), number: String(carton['Номер'] || ''), shipment: String(carton['Направление'] || ''), status: String(carton['Статус'] || ''),
    current: isCurrentWarehouseCarton_(carton, cartons, props),
    open:isOpenCarton_(carton['Статус']), closedAt:normalizeDateString_(carton.closedAt), closeRevision:cartonCloseRevision_(carton,contents),
    marketplace: shipmentMarketplace_(carton), storeNumber: cartonStoreNumberFromNumber_(carton['Номер']),
    contents: contents.filter(row => String(row.cartonId) === String(carton.cartonId)).map(row => ({
      allocationId: String(row.allocationId), sku: String(row['Артикул'] || ''), quantity: validBoxQuantity_(row['Количество, шт']),
      employee: String(row['Сотрудник'] || ''), createdAt: normalizeDateString_(row.createdAt),
      shipment: sourceNames.get(String(row.shipmentId)) || (/^RITM-WAREHOUSE-MANUAL-(OZON|WB)-\d+$/.test(String(row.shipmentId)) ? 'Ручное поступление на склад' : String(row.shipmentId || '')),
      comment: String(row.reason || ''),
      ...(products.get(String(row.shipmentId) + '|' + String(row.positionId)) || { productName: '', photoUrl: '', photoAssetKey: '' }),
    })),
  })).filter(carton => carton.contents.length || carton.current) };
}

function warehouseCartonKey_(store, market) {
  if (!['OZON','WB'].includes(market)) throw new Error('Не подтверждён маркетплейс складского короба.');
  return 'ritm.assembly.warehouse.current.' + market + '.' + confirmedStoreNumber_([store]);
}

function warehouseCartonCompatible_(carton, store, market) {
  return isWarehouseCartonId_(carton.cartonId) && !isCancelledCarton_(carton) && isOpenCarton_(carton['Статус']) &&
    cartonStoreNumberFromNumber_(carton['Номер']) === store && shipmentMarketplace_(carton) === market;
}

function chooseWarehouseCarton_(cartons, store, market, currentId) {
  const candidates = cartons.filter(carton => warehouseCartonCompatible_(carton,store,market));
  return candidates.find(carton => String(carton.cartonId) === String(currentId || '')) || candidates.sort((a,b) =>
    (cartonNumberParts_(a['Номер'])?.sequence || 0) - (cartonNumberParts_(b['Номер'])?.sequence || 0))[0] || null;
}

function isCurrentWarehouseCarton_(carton, cartons, props) {
  const market = shipmentMarketplace_(carton), store = cartonStoreNumberFromNumber_(carton['Номер']);
  if (!market || !store) return false;
  const current = chooseWarehouseCarton_(cartons,store,market,props.getProperty(warehouseCartonKey_(store,market)));
  return !!current && String(current.cartonId) === String(carton.cartonId);
}

// Called only under ScriptLock. Empty carton creation is idempotent; quantity
// and employee history remain append-only in the original allocation journal.
function createWarehouseCartonRecord_(db, shipment, store, market, key, props) {
  const tables = getBoxTableSheets_(db), id = 'carton-stock-' + stockDigest_(key);
  const previous = findBoxRecordByHeaderValue_(tables.cartons.sheet,'cartonId',id);
  if (previous) {
    if (!warehouseCartonCompatible_(previous,store,market)) throw new Error('Ключ создания уже связан с другим коробом.');
    return previous;
  }
  let headers = boxPlacementTableHeaders_(tables.cartons.sheet,['cartonId','directionId','Направление','Номер','Подтверждённая вместимость, шт','Занято, шт','Статус','createdAt','closedAt','source']);
  if (!headers.includes('shipmentId')) headers = ensureCartonColumn_(tables.cartons.sheet,'shipmentId');
  if (!headers.includes('Тип короба')) headers = ensureCartonColumn_(tables.cartons.sheet,'Тип короба');
  const record = {cartonId:id,shipmentId:String(shipment.shipmentId || ''),directionId:String(shipment.directionId || ''),
    'Направление':String(shipment['Направление'] || shipment['Название поставки'] || market),
    'Номер':nextWarehouseCartonNumber_(store,tables.cartons.sheet),'Подтверждённая вместимость, шт':'','Занято, шт':0,
    'Статус':'Открыт','Тип короба':'Склад',createdAt:new Date().toISOString(),closedAt:'',source:'RITM_ASSEMBLY_STOCK'};
  appendRecordByHeaders_(tables.cartons.sheet,headers,record);
  props.setProperty(warehouseCartonKey_(store,market),id);
  return Object.assign({_rowNumber:tables.cartons.sheet.getLastRow()},record);
}

function createWarehouseCarton(payload) {
  const key = validateBoxIdempotencyKey_(payload && payload.idempotencyKey);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Склад сейчас обновляется. Повторите с тем же запросом.');
  try {
    const db = SpreadsheetApp.openById(DB_ID), tables = getBoxTableSheets_(db);
    const source = findBoxRecordByHeaderValue_(tables.cartons.sheet,'cartonId',String(payload.sourceCartonId || ''));
    if (!source || !isWarehouseCartonId_(source.cartonId) || isCancelledCarton_(source)) throw new Error('Исходный складской короб не подтверждён.');
    const store = cartonStoreNumberFromNumber_(source['Номер']), market = shipmentMarketplace_(source);
    const carton = createWarehouseCartonRecord_(db,source,store,market,'manual-' + key,PropertiesService.getScriptProperties());
    ensureWarehouseBoxViewSheet_(db); bumpDataVersion_();
    return {ok:true,cartonId:String(carton.cartonId),number:String(carton['Номер'])};
  } finally {lock.releaseLock();}
}


// Read only the stock positions from existing marked Assembly mirrors. These
// details are already enriched from the correct marketplace during supply sync.
function warehouseStockProducts_(db, cartons, contents) {
  const result = new Map();
  let origins = [];
  try { origins = assemblyShipments_(db); } catch (_) { /* Physical stock remains visible without a current roster. */ }
  origins.forEach(origin => {
    const wanted = contents.filter(row => String(row.shipmentId) === String(origin.shipmentId));
    if (!wanted.length) return;
    let rows = [];
    try {
      if (origin.environment !== 'RITM') rows = readTable_(db, TABLES.items);
      else {
        const sheet = db.getSheetById(Number(origin.sheetId));
        const marker = origin.marker || RITM_SHEET_MARKER + String(origin.shipmentId).replace('RITM-ROLL-', '');
        if (sheet && sheet.getRange(1, 1).getNote() === marker)
          rows = readRowsByKey_(sheet, 'positionId', new Set(wanted.map(row => String(row.positionId))));
        wanted.filter(row => String(row.positionId).includes('|manual:')).forEach(row => {
          const item = readShipmentItem_(db, origin, row.positionId);
          if (item) rows.push(item);
        });
      }
    } catch (_) { /* Optional product details must not hide stock or its audit. */ }
    wanted.forEach(row => {
      const matches = rows.filter(item => String(item.shipmentId) === String(row.shipmentId) && String(item.positionId) === String(row.positionId) && normalizeBoxSku_(item['Артикул']) === normalizeBoxSku_(row['Артикул']));
      if (matches.length !== 1) return;
      const item = matches[0];
      result.set(String(row.shipmentId) + '|' + String(row.positionId), { productName: String(item['Название товара'] || ''), photoUrl: safeRitmPhotoUrl_(item['Фото']), photoAssetKey: String(item.photoAssetKey || '') });
    });
  });
  const missing = contents.filter(row => !result.has(String(row.shipmentId) + '|' + String(row.positionId)));
  if (missing.length) {
    let catalog = new Map();
    try { catalog = readRitmCatalog_(); } catch (_) { /* Unavailable catalog is shown as missing text/photo, not missing stock. */ }
    const cartonById = new Map(cartons.map(carton => [String(carton.cartonId), carton]));
    missing.forEach(row => {
      const carton = cartonById.get(String(row.cartonId));
      const market = labelMarketplace_('', carton && carton['Направление']);
      const product = market ? catalog.get(market + '|' + normalizeBoxSku_(row['Артикул'])) : null;
      if (product) result.set(String(row.shipmentId) + '|' + String(row.positionId), { productName: String(product.name || ''), photoUrl: safeRitmPhotoUrl_(product.photoUrl), photoAssetKey: '' });
    });
  }
  return result;
}


function stockOperationSheet_(db) {
  const name = 'StockPlacementOperations';
  const marker = 'RITM_ASSEMBLY_STOCK_OPERATIONS_V1';
  const expected = ['operationId', 'request', 'shipmentQuantity', 'stockQuantity', 'completedAt'];
  let sheet = db.getSheetByName(name);
  if (!sheet) {
    sheet = db.insertSheet(name);
    sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
    sheet.getRange(1, 1).setNote(marker);
    if (typeof sheet.hideSheet === 'function') sheet.hideSheet();
  }
  if (String(sheet.getRange(1, 1).getNote() || '') !== marker) throw new Error('Имя журнала складских операций занято другим листом; данные не изменены.');
  const headers = sheet.getRange(1, 1, 1, expected.length).getValues()[0].map(String);
  if (headers.some((header, i) => header !== expected[i])) throw new Error('Журнал складских операций имеет неизвестный формат; данные не изменены.');
  return { sheet, headers };
}

function assertStockReservation_(payload) {
  const props = PropertiesService.getScriptProperties();
  const owner = props.getProperty(stockReservationKey_(payload.shipmentId, payload.positionId));
  const parent = String(payload.parentKey || '');
  if (owner && owner !== parent) throw new Error('Для этого товара ещё сохраняется распределение излишка. Сначала проверьте его результат.');
  if (parent) {
    const operation = parseSyncJson_(props.getProperty(stockOperationKey_(parent)), null);
    if (!owner || owner !== parent || !operation || operation.status !== 'pending') throw new Error('Распределение излишка не подтверждено.');
    const part = (operation.parts || []).find(row => row.idempotencyKey === String(payload.idempotencyKey));
    if (!part || JSON.stringify(boxPlacementRequestKey_(part)) !== JSON.stringify(boxPlacementRequestKey_(payload)) || Boolean(part.warehouse) !== Boolean(payload.warehouse)) throw new Error('Состав распределения излишка изменился. Обновите данные.');
  } else if (payload.warehouse === true) throw new Error('Складской короб создаётся только при распределении излишка.');
}

function assertStockPlan_(payload, context) {
  if (!payload.parentKey) return;
  const operation = parseSyncJson_(PropertiesService.getScriptProperties().getProperty(stockOperationKey_(payload.parentKey)), null);
  if (!operation || Number(context.plan) !== operation.plan) throw new Error('План изменился во время распределения. Требуется сверка.');
}

function nextWarehouseCartonNumber_(storeNumber, cartonSheet) {
  const prefix = confirmedStoreNumber_([storeNumber]) + 'скл';
  const highest = readCartonNumbers_(cartonSheet).map(cartonNumberParts_).filter(Boolean)
    .filter(part => part.prefix.toLocaleLowerCase('ru-RU') === prefix.toLocaleLowerCase('ru-RU'))
    .reduce((value, part) => Math.max(value, part.sequence), 0);
  if (!Number.isSafeInteger(highest) || highest >= Number.MAX_SAFE_INTEGER) throw new Error('Не удалось определить номер складского короба.');
  return prefix + String(highest + 1);
}

function finalizeStockSplitPart_(db, part) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Короба заняты, проверяем сохранение.');
  try {
    assertStockReservation_(part);
    const tables = getBoxTableSheets_(db);
    const allocation = findBoxRecordByHeaderValue_(tables.contents.sheet, 'allocationId', 'allocation-' + part.idempotencyKey);
    if (!allocation || !boxAllocationMatchesPayload_(allocation, part)) throw new Error('Размещение ещё не подтверждено.');
    const carton = findBoxRecordByHeaderValue_(tables.cartons.sheet, 'cartonId', String(allocation.cartonId));
    if (!carton || isCancelledCarton_(carton)) throw new Error('Короб не подтверждён или отменён.');
    const contents = normalizeCartonContents_(readRowsByKey_(tables.contents.sheet, 'cartonId', new Set([String(carton.cartonId)])));
    const headers = boxPlacementTableHeaders_(tables.cartons.sheet, ['cartonId', 'Занято, шт', 'Статус']);
    updateCartonDerived_(tables.cartons.sheet, headers, carton._rowNumber, { occupied: sumBoxQuantities_(contents) });
    if (String(carton['Статус'] || '') === 'Подготовка') updateCartonField_(tables.cartons.sheet, headers, carton._rowNumber, 'Статус', 'Открыт');
  } finally { lock.releaseLock(); }
}

function saveStockSplitPlacement(payload) {
  let db, key, request, operation;
  try {
    validateBoxPlacementPayload_(payload, false);
    if (payload.warehouse || payload.parentKey) throw new Error('Не удалось подтвердить распределение.');
    db = SpreadsheetApp.openById(DB_ID);
    key = String(payload.idempotencyKey);
    request = boxPlacementRequestKey_(payload);
    const props = PropertiesService.getScriptProperties();
    const operationKey = stockOperationKey_(key);
    const reservationKey = stockReservationKey_(payload.shipmentId, payload.positionId);
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return boxPlacementPending_('Короба сейчас обновляются. Проверяем сохранение операции.');
    try {
      const journal = stockOperationSheet_(db);
      const completed = findRowByHeaderValue_(journal.sheet, 'operationId', key);
      if (completed) {
        if (String(completed.request || '') !== JSON.stringify(request)) throw new Error('Ключ повтора уже использован для другого распределения.');
        if (props.getProperty(reservationKey) === key) props.deleteProperty(reservationKey);
        props.deleteProperty(operationKey);
        return { ok: true, duplicate: true, shipmentQuantity: Number(completed.shipmentQuantity), stockQuantity: Number(completed.stockQuantity), dataVersion: getDataVersion() };
      }
      operation = parseSyncJson_(props.getProperty(operationKey), null);
      if (operation && JSON.stringify(operation.request) !== JSON.stringify(request)) throw new Error('Ключ повтора уже использован для другого распределения.');
      if (!operation) {
        if (props.getProperty(reservationKey)) throw new Error('Для товара уже выполняется другое распределение.');
        const employee = readTable_(db, TABLES.employees).find(row => String(row.employeeId) === String(payload.employeeId || '') && (row.Активен === true || String(row.Активен).toLowerCase() === 'true'));
        if (!employee) throw new Error('Выберите сотрудника, который отправляет излишек на склад.');
        const employeeName = String(employee.Имя || '').trim();
        if (!employeeName) throw new Error('Имя сотрудника не подтверждено.');
        ensureStockAuditColumns_(db);
        const context = boxItemContext_(db, payload.shipmentId, payload.directionId, payload.positionId);
        if (!context.packingKnown || context.packed === null || context.plan === null) throw new Error('План или упаковка не подтверждены. Обновите данные.');
        if (context.shipment.environment === 'RITM') { assertLocalShipmentUnlocked_(payload.shipmentId); assertAssemblyOnlyNotDeleted_(payload.positionId); }
        const sheets = getBoxTableSheets_(db);
        const records = normalizeCartonContents_(readRowsByKey_(sheets.contents.sheet, 'positionId', new Set([String(context.item.positionId)])));
        const allocations = itemAllocationsFor_(records, context);
        const norm = getBoxPackNorm_(context.item['Артикул'], true, shipmentMarketplace_(context.shipment));
        if (!norm || !norm.confirmed) throw new Error(norm && norm.reason ? norm.reason : 'Не подтверждена вместимость короба.');
        const split = planExcessPlacement_({ plan: context.shipment.stockTask ? 0 : context.plan, packed: context.packed, totalAssigned: sumBoxQuantities_(allocations), shipmentAssigned: sumBoxQuantities_(allocations.filter(row => !isWarehouseCartonId_(row.cartonId))), quantity: Number(payload.quantity), capacity: norm.unitsPerBox });
        if (!split.excess) throw new Error('В указанном количестве нет излишка для склада.');
        const digest = stockDigest_(key);
        const base = { shipmentId: String(payload.shipmentId), directionId: String(payload.directionId), positionId: String(payload.positionId), parentKey: key, employeeId: String(payload.employeeId) };
        const parts = [];
        if (split.shipment) parts.push(Object.assign({}, base, { mode: payload.mode, cartonId: String(payload.cartonId || ''), boxSourceShipmentId: String(payload.boxSourceShipmentId || ''), quantity: split.shipment, idempotencyKey: 'ship-' + digest }));
        // Validate the selected shipment carton before creating a warehouse container.
        if (split.shipment) boxPlacementSnapshot_(db, parts[0], true);
        const market = shipmentMarketplace_(context.shipment);
        const storeMap = storeNumbersForItems_([{sku:context.item['Артикул'],source:market}],true);
        const store = confirmedStoreNumber_(storeMap[storeNumberSkuKey_(context.item['Артикул'],market)]);
        const warehouseRows = readTable_(db,TABLES.cartons).filter(row => isWarehouseCartonId_(row.cartonId));
        let stockCarton = chooseWarehouseCarton_(warehouseRows,store,market,props.getProperty(warehouseCartonKey_(store,market)));
        if (!stockCarton) stockCarton = createWarehouseCartonRecord_(db,context.shipment,store,market,'auto-' + key,props);
        parts.push(Object.assign({},base,{mode:'existing',cartonId:String(stockCarton.cartonId),boxSourceShipmentId:'',quantity:split.excess,idempotencyKey:'stock-' + digest + '-' + parts.length,warehouse:true}));
        const direction = cartonDirection_(context.shipment);
        if (direction) ensureDirectionBoxViewSheet_(db, direction, directionBoxShipments_(props, direction, context.shipment));
        else if (!context.shipment.stockTask) ensureLegacyShipmentBoxViewSheet_(db, context.shipment);
        refreshLegacyViewsForWarehouse_(db, context.shipment);
        ensureWarehouseBoxViewSheet_(db);
        operation = { status: 'pending', request, parts, shipment: split.shipment, excess: split.excess, plan: context.plan, employeeId: String(payload.employeeId), employeeName };
        if (JSON.stringify(operation).length > 7500) { operation = null; throw new Error('Слишком много коробов для одной операции. Разделите количество на несколько добавлений.'); }
        const initialProperties = {};
        initialProperties[operationKey] = JSON.stringify(operation);
        initialProperties[reservationKey] = key;
        props.setProperties(initialProperties);
      } else if (operation.status === 'complete') {
        return { ok: true, duplicate: true, shipmentQuantity: operation.shipment, stockQuantity: operation.excess, dataVersion: getDataVersion() };
      } else if (props.getProperty(reservationKey) !== key) throw new Error('Не удалось подтвердить незавершённое распределение.');
    } finally { lock.releaseLock(); }
    for (const part of operation.parts) {
      let result;
      try { result = saveBoxPlacement(part); }
      catch (error) { return boxPlacementPending_('Проверяем сохранение распределения: ' + String(error.message || error)); }
      if (!result || result.ok !== true) {
        if (result && result.notWritten === true) {
          const check = LockService.getScriptLock();
          if (check.tryLock(5000)) {
            try {
              const sheets = getBoxTableSheets_(db);
              const started = operation.parts.some(row => findBoxRecordByHeaderValue_(sheets.contents.sheet, 'allocationId', 'allocation-' + row.idempotencyKey) || (row.mode === 'new' && findBoxRecordByHeaderValue_(sheets.cartons.sheet, 'cartonId', 'carton-' + row.idempotencyKey)));
              if (!started && props.getProperty(reservationKey) === key) {
                props.deleteProperty(reservationKey);
                props.deleteProperty(operationKey);
                operation = null;
                return boxPlacementNotWritten_(result.message || 'Распределение не сохранено.');
              }
            } finally { check.releaseLock(); }
          }
        }
        return boxPlacementPending_((result && result.message) || 'Проверяем сохранение распределения.');
      }
      try { finalizeStockSplitPart_(db, part); }
      catch (error) { return boxPlacementPending_('Проверяем состояние коробов: ' + String(error.message || error)); }
    }
    const finish = LockService.getScriptLock();
    if (!finish.tryLock(5000)) return boxPlacementPending_('Проверяем завершение распределения.');
    try {
      const journal = stockOperationSheet_(db);
      const completed = findRowByHeaderValue_(journal.sheet, 'operationId', key);
      if (!completed) appendRecordByHeaders_(journal.sheet, journal.headers, { operationId: key, request: JSON.stringify(request), shipmentQuantity: operation.shipment, stockQuantity: operation.excess, completedAt: new Date().toISOString() });
      else if (String(completed.request || '') !== JSON.stringify(request)) throw new Error('Ключ повтора уже использован для другого распределения.');
      if (props.getProperty(reservationKey) === key) props.deleteProperty(reservationKey);
      props.deleteProperty(operationKey);
    } finally { finish.releaseLock(); }
    return { ok: true, duplicate: false, shipmentQuantity: operation.shipment, stockQuantity: operation.excess, dataVersion: getDataVersion() };
  } catch (error) {
    return operation ? boxPlacementPending_('Проверяем сохранение распределения: ' + String(error.message || error)) : boxPlacementNotWritten_(error);
  }
}

function boxPlacementSnapshot_(db, payload, forceFreshNorm) {
  const context = boxItemContext_(db, payload.shipmentId, payload.directionId, payload.positionId);
  const boxOwner = payload.mode === 'existing' && payload.boxSourceShipmentId && String(payload.boxSourceShipmentId) !== String(payload.shipmentId)
    ? requireRitmShipment_(db, payload.boxSourceShipmentId, payload.directionId) : context.shipment;
  if (!context.packingKnown || context.packed === null) throw new Error(context.packingReason || 'Фактическое количество упаковки не подтверждено. Размещение заблокировано.');
  const storeSource = shipmentMarketplace_(context.shipment);
  const itemStoreKey = storeNumberSkuKey_(context.item['Артикул'], storeSource);
  const sheets = getBoxTableSheets_(db);
  const cartonHeaders = boxPlacementTableHeaders_(sheets.cartons.sheet, [
    'cartonId', 'directionId', 'Направление', 'Номер', 'Подтверждённая вместимость, шт',
    'Занято, шт', 'Статус', 'createdAt', 'closedAt', 'source',
  ]);
  const contentsHeaders = boxPlacementTableHeaders_(sheets.contents.sheet, [
    'allocationId', 'cartonId', 'shipmentId', 'directionId', 'positionId', 'Артикул',
    'Количество, шт', 'createdAt', 'eventId',
  ]);
  const isNew = payload.mode === 'new';
  let cartonId = isNew ? 'carton-' + String(payload.idempotencyKey) : String(payload.cartonId || '');
  const scopedContents = readCartonPositionContents_(sheets.contents.sheet, new Set([cartonId]), context.item.positionId);
  const relevantContents = normalizeCartonContents_(scopedContents);
  const tables = {
    cartons: { sheet: sheets.cartons.sheet, headers: cartonHeaders, records: [] },
    contents: { sheet: sheets.contents.sheet, headers: contentsHeaders, records: relevantContents, rawRecords: relevantContents },
  };
  const itemAllocations = itemAllocationsFor_(relevantContents, context);
  const assigned = sumBoxQuantities_(itemAllocations);
  if (assigned > context.packed) throw new Error('В коробах уже распределено ' + assigned + ' шт., а в WorkLog подтверждено только ' + context.packed + ' шт. Сначала проверьте данные.');
  const available = Math.max(0, context.packed - assigned);
  const quantity = Number(payload.quantity);
  if (quantity > available) throw new Error('Доступно для размещения только ' + available + ' шт. по факту WorkLog.');
  const cartonContents = relevantContents.filter(row => String(row.cartonId) === cartonId);
  const currentRow = { shipmentId: context.shipment.shipmentId, 'Артикул': context.item['Артикул'] };
  const normsBySku = sharedCartonNorms_(db, cartonContents.concat([currentRow]), context.shipment, forceFreshNorm === true);
  const norm = cartonRowNorm_(currentRow, normsBySku);
  if (!norm || !norm.confirmed) throw new Error(norm && norm.reason ? norm.reason : 'В базе нет подтверждённой нормы в коробе. Размещение заблокировано.');
  const shipmentMarkets = new Map(assemblyShipments_(db).map(s => [String(s.shipmentId), shipmentMarketplace_(s)]));
  shipmentMarkets.set(String(context.shipment.shipmentId), storeSource);
  const storeNumbers = storeNumbersForItems_([
    { sku: context.item['Артикул'], source: storeSource },
  ].concat(cartonContents.map(row => ({ sku: row['Артикул'], source: shipmentMarkets.get(String(row.shipmentId)) || '' }))), true);
  const itemStoreNumber = confirmedStoreNumber_(storeNumbers[itemStoreKey]);
  if (cartonContents.length) {
    cartonContents.forEach(row => {
      const cartonItemStore = confirmedStoreNumber_(storeNumbers[storeNumberSkuKey_(row['Артикул'], shipmentMarkets.get(String(row.shipmentId)) || '')]);
      if (cartonItemStore !== itemStoreNumber)
        throw new Error('В один короб нельзя добавлять товары разных магазинов. В этом коробе уже есть магазин ' + cartonItemStore + ', выбран магазин ' + itemStoreNumber + '.');
    });
  }
  let cartonIndex = -1;
  let cartonRecord = null;
  let number = '';
  if (isNew) {
    const byShipment = readRowsByKey_(sheets.cartons.sheet, 'shipmentId', new Set([String(context.shipment.shipmentId)]));
    const byDirection = readRowsByKey_(sheets.cartons.sheet, 'directionId', new Set([String(context.shipment.directionId)]));
    tables.cartons.records = uniqueCartonRows_(byShipment.concat(byDirection)).filter(row => cartonMatchesShipment_(row, context.shipment));
    cartonRecord = findBoxRecordByHeaderValue_(sheets.cartons.sheet, 'cartonId', cartonId);
    cartonIndex = tables.cartons.records.findIndex(row => String(row.cartonId) === cartonId);
    if (cartonIndex >= 0) {
      tables.cartons.records[cartonIndex] = cartonRecord;
      if (!cartonMatchesShipment_(cartonRecord, context.shipment)) throw new Error('Ключ операции уже связан с коробом другой поставки.');
      number = String(cartonRecord['Номер'] || '');
    } else {
      cartonRecord = null;
      number = payload.warehouse === true ? nextWarehouseCartonNumber_(itemStoreNumber, sheets.cartons.sheet) : nextCartonNumber_(context.shipment, tables.cartons.records, itemStoreNumber, sheets.cartons.sheet);
      const duplicateNumber = findBoxRecordByHeaderValue_(sheets.cartons.sheet, 'Номер', number);
      if (duplicateNumber) throw new Error('Следующий номер короба уже занят. Обновите список коробов и повторите.');
    }
    if (!cartonRecord) cartonRecord = {
      cartonId, directionId: String(context.shipment.directionId), 'Направление': String(context.shipment['Направление'] || ''),
      'Номер': number, 'Тип короба': norm.boxType, 'Подтверждённая вместимость, шт': norm.unitsPerBox, 'Статус': 'Подготовка',
    };
  } else {
    cartonRecord = findBoxRecordByHeaderValue_(sheets.cartons.sheet, 'cartonId', String(payload.cartonId));
    if (!cartonRecord) throw new Error('Короб не найден. Обновите список.');
    cartonIndex = 0;
    tables.cartons.records = [cartonRecord];
    if (payload.warehouse === true ? !warehouseCartonCompatible_(cartonRecord,itemStoreNumber,storeSource) : !cartonMatchesShipment_(cartonRecord, boxOwner)) throw new Error(payload.warehouse === true ? 'Складской короб относится к другому магазину или маркетплейсу.' : 'Короб относится к другой поставке. Выберите её в списке и повторите.');
    if (!isOpenCarton_(cartonRecord['Статус'])) throw new Error('Короб закрыт или его статус не подтверждён. Выберите открытый короб.');
    cartonId = String(cartonRecord.cartonId);
    number = String(cartonRecord['Номер'] || '');
    const cartonStore = cartonStoreNumberFromNumber_(number);
    if (cartonStore !== itemStoreNumber)
      throw new Error('Нельзя смешивать магазины: короб ' + number + ' относится к магазину ' + (cartonStore || 'неизвестно') + ', выбран магазин ' + itemStoreNumber + '.');
  }
  if (cartonStoreNumberFromNumber_(number) !== itemStoreNumber)
    throw new Error('Нельзя смешивать магазины: номер короба должен начинаться с ' + itemStoreNumber + '.');
  const space = payload.warehouse === true ? {known:true,spaceUsed:0,spaceRemaining:1,boxType:'Склад'} : cartonSpace_(cartonRecord, cartonContents, normsBySku);
  if (!space.known) throw new Error(space.reason || 'Вместимость короба не подтверждена. Размещение заблокировано.');
  const fillAfter = space.spaceUsed + quantity / norm.unitsPerBox;
  if (payload.warehouse !== true && fillAfter > 1 + 1e-9) throw new Error('В коробе осталось ' + Math.max(0, Math.floor((1 - space.spaceUsed) * norm.unitsPerBox)) + ' шт. этого артикула по подтверждённой норме.');
  const boxTypeAfter = cartonTypeSummary_(cartonContents.concat([currentRow]), normsBySku, cartonRecord['Тип короба']);
  // Global revisions change for unrelated articles too. Commit-time checks
  // compare only the selected article and carton under the script lock.
  const versionAfter = getDataVersion();
  return {
    mode: payload.mode, context, tables, cartonRecord, cartonIndex, carton: { cartonId, number },
    normsBySku, norm, space, fillAfter, boxTypeAfter, quantity, assigned, available, dataVersion: versionAfter,
    itemStoreNumber, boxOwner,
  };
}

function boxPlacementScopeFingerprint_(snapshot) {
  const contents = snapshot.tables.contents.records || [];
  const cartonId = String(snapshot.carton.cartonId);
  const cartonContents = contents.filter(row => String(row.cartonId) === cartonId);
  const itemAllocations = itemAllocationsFor_(contents, snapshot.context);
  const rowKey = row => [
    String(row.allocationId || ''), String(row.cartonId || ''), String(row.shipmentId || ''),
    String(row.directionId || ''), String(row.positionId || ''), normalizeBoxSku_(row['Артикул']),
    validBoxQuantity_(row['Количество, шт']),
  ].join('|');
  const orderedKeys = rows => rows.map(rowKey).sort();
  const record = snapshot.cartonIndex >= 0 ? snapshot.cartonRecord : null;
  const norm = snapshot.norm || {};
  return JSON.stringify({
    shipmentId: String(snapshot.context.shipment.shipmentId),
    directionId: String(snapshot.context.shipment.directionId),
    positionId: String(snapshot.context.item.positionId),
    packedKnown: Boolean(snapshot.context.packingKnown),
    packed: snapshot.context.packed,
    itemAllocations: orderedKeys(itemAllocations),
    cartonExists: Boolean(record),
    carton: record ? [
      String(record.cartonId || ''), String(record.shipmentId || ''), String(record.directionId || ''),
      String(record['Направление'] || ''), String(record['Номер'] || ''), String(record['Статус'] || ''),
      toNumberOrNull_(record['Подтверждённая вместимость, шт']), String(record['Тип короба'] || ''),
    ] : null,
    cartonContents: orderedKeys(cartonContents),
    fillBefore: snapshot.space.spaceUsed,
    itemStoreNumber: String(snapshot.itemStoreNumber || ''),
    norm: [Boolean(norm.confirmed), String(norm.boxType || ''), toNumberOrNull_(norm.unitsPerBox)],
  });
}

function boxPlacementCurrentScope_(db, payload, snapshot) {
  const savedContext = snapshot.context;
  const packed = readPackedQuantityForItem_(db, savedContext.shipment, savedContext.item);
  const context = Object.assign({}, savedContext, {
    packed: packed.quantity,
    packingKnown: packed.known,
    packingReason: packed.reason,
  });
  if (!context.packingKnown || context.packed === null)
    throw new Error(context.packingReason || 'Фактическая упаковка не подтверждена. Размещение пока невозможно.');
  const sheets = getBoxTableSheets_(db);
  const cartonId = String(snapshot.carton.cartonId);
  const cartonRecord = findBoxRecordByHeaderValue_(sheets.cartons.sheet, 'cartonId', cartonId);
  if (payload.mode === 'existing') {
    if (!cartonRecord) throw new Error('Короб больше не найден. Обновите список коробов и подтвердите размещение ещё раз.');
    if (payload.warehouse === true ? !warehouseCartonCompatible_(cartonRecord,snapshot.itemStoreNumber,shipmentMarketplace_(context.shipment)) : !cartonMatchesShipment_(cartonRecord, snapshot.boxOwner || context.shipment)) throw new Error('Короб не относится к выбранному магазину или направлению. Обновите список.');
    if (!isOpenCarton_(cartonRecord['Статус'])) throw new Error('Короб уже закрыт. Обновите список коробов и выберите открытый.');
  } else if (cartonRecord && !cartonMatchesShipment_(cartonRecord, context.shipment)) {
    throw new Error('Ключ операции уже связан с коробом другой поставки.');
  }

  const scopedContents = readCartonPositionContents_(sheets.contents.sheet, new Set([cartonId]), context.item.positionId);
  const contents = normalizeCartonContents_(scopedContents);
  const cartonContents = contents.filter(row => String(row.cartonId) === cartonId);
  const itemAllocations = itemAllocationsFor_(contents, context);
  const assigned = sumBoxQuantities_(itemAllocations);
  if (assigned > context.packed) throw new Error('В коробах уже распределено больше, чем подтверждено упаковкой. Обновите короба и проверьте остаток.');
  const available = Math.max(0, context.packed - assigned);
  if (snapshot.quantity > available) throw new Error('Теперь доступно только ' + available + ' шт. Обновите короба и проверьте количество ещё раз.');

  const effectiveCarton = cartonRecord || snapshot.cartonRecord;
  const space = payload.warehouse === true ? {known:true,spaceUsed:0,spaceRemaining:1,boxType:'Склад'} : cartonSpace_(effectiveCarton, cartonContents, snapshot.normsBySku);
  if (!space.known) throw new Error(space.reason || 'Вместимость короба больше нельзя подтвердить.');
  const fillAfter = space.spaceUsed + snapshot.quantity / snapshot.norm.unitsPerBox;
  if (payload.warehouse !== true && fillAfter > 1 + 1e-9) throw new Error('В коробе осталось место максимум для ' + Math.max(0, Math.floor((1 - space.spaceUsed) * snapshot.norm.unitsPerBox)) + ' шт. Обновите короб и проверьте количество ещё раз.');

  return {
    mode: snapshot.mode, context, tables: { cartons: { sheet: sheets.cartons.sheet, headers: [], records: cartonRecord ? [cartonRecord] : [] }, contents: { sheet: sheets.contents.sheet, headers: [], records: contents } },
    cartonRecord: effectiveCarton, cartonIndex: cartonRecord ? 0 : -1, carton: snapshot.carton,
    cartonExists: Boolean(cartonRecord), cartonContents, itemAllocations, assigned, available, space, fillAfter,
    norm: snapshot.norm, normsBySku: snapshot.normsBySku, quantity: snapshot.quantity,
    itemStoreNumber: snapshot.itemStoreNumber,
  };
}

// Read the union once: capacity needs all carton entries, availability needs
// all entries for this position, including REMOVE events and closed cartons.
function readCartonPositionContents_(sheet, cartonIds, positionId) {
  const wanted = new Set(Array.from(cartonIds || [], String));
  const id = String(positionId || '');
  const width = sheet.getLastColumn();
  if (width < 1) throw new Error('Не удалось проверить структуру состава коробов.');
  const headers = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
  if (!headers.includes('cartonId') || !headers.includes('positionId')) throw new Error('В составе коробов отсутствуют идентификаторы.');
  return uniqueCartonRows_(readIndexedRows_(sheet, ['cartonId', 'positionId'], row => wanted.has(String(row.cartonId)) || String(row.positionId) === id, headers, 20));
}

function uniqueCartonRows_(rows) {
  const byKey = new Map();
  (rows || []).forEach(row => {
    const key = String(row.allocationId || row.eventId || JSON.stringify(row));
    if (!byKey.has(key)) byKey.set(key, row);
  });
  return Array.from(byKey.values());
}

function nextCartonNumber_(shipment, cartons, storeNumber, cartonSheet) {
  const shop = confirmedStoreNumber_([storeNumber]);
  const prefix = shop + cartonSupplyAbbreviation_(shipment);
  const matching = (cartons || [])
    .filter(row => cartonMatchesShipment_(row, shipment))
    .map(row => ({ number: String(row['Номер'] || ''), parts: cartonNumberParts_(row['Номер']) }))
    .filter(entry => entry.parts && cartonStoreNumberFromNumber_(entry.number) === shop);
  // Numbers are globally unique, although the visible list is shipment-scoped.
  // Scan only the number column, including closed/cancelled cartons. Re-run
  // under the existing placement ScriptLock immediately before creation.
  const globalNumbers = cartonSheet ? readCartonNumbers_(cartonSheet) : [];
  const taken = globalNumbers.map(cartonNumberParts_).filter(parts => parts &&
    parts.prefix.toLocaleLowerCase('ru-RU') === prefix.toLocaleLowerCase('ru-RU'));
  const max = matching.map(entry => entry.parts.sequence).concat(taken.map(parts => parts.sequence))
    .reduce((highest, sequence) => {
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER)
        throw new Error('Некорректный номер короба. Требуется проверка журнала.');
      return Math.max(highest, sequence);
    }, 0);
  return prefix + String(max + 1);
}

function readCartonNumbers_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const index = headers.indexOf('Номер');
  if (index < 0) throw new Error('В журнале коробов не найдена колонка «Номер». Короб не создан.');
  return sheet.getRange(2, index + 1, sheet.getLastRow() - 1, 1).getValues().map(row => String(row[0] || '').trim());
}

function cartonSupplyAbbreviation_(shipment) {
  const source = String(shipment && (shipment['Название поставки'] || shipment['Направление']) || '')
    .replace(/^\s*(?:ozon|wildberries|wb)\s*/i, '')
    .replace(/\s+\d{1,2}[_./-]\d{1,2}\s*$/i, '')
    .replace(/\s+\d{1,4}\s*$/i, '');
  const letters = source.toLocaleLowerCase('ru-RU').replace(/[^a-zа-яё]/gi, '');
  if (letters.length < 3) throw new Error('В названии поставки не удалось определить первые три буквы для короба.');
  return letters.slice(0, 3);
}

function confirmedStoreNumber_(values) {
  if (!Array.isArray(values)) throw new Error('Не удалось прочитать магазин артикула из базы. Короб не создан.');
  const unique = Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
  if (unique.length !== 1) throw new Error(unique.length
    ? 'Для артикула в каталоге указано несколько магазинов. Уточните магазин в базе; короб не создан.'
    : 'Для артикула не указан магазин в базе. Укажите магазин перед созданием короба.');
  const match = unique[0].match(/^\s*(?:магазин\s*)?(\d+)\s*$/i);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('Магазин артикула должен быть указан номером в базе. Короб не создан.');
  return String(Number(match[1]));
}

function cartonStoreNumberFromNumber_(value) {
  const match = String(value || '').trim().match(/^(\d+)/);
  return match && Number.isSafeInteger(Number(match[1])) ? String(Number(match[1])) : '';
}

function cartonNumberParts_(value) {
  const number = String(value || '').trim();
  const suffix = number.match(/\d+$/);
  if (!suffix) return null;
  const prefix = number.slice(0, number.length - suffix[0].length);
  if (!prefix) return null;
  return { prefix, sequence: Number(suffix[0]), width: suffix[0].length };
}

function cartonStoreKey_(value) {
  return normalizeCartonScope_(String(value || '')
    .replace(/^ozon\s+/i, '')
    .replace(/\s+\d{1,2}[_./-]\d{1,2}\s*$/i, '')
    .replace(/\s+\d{1,4}\s*$/i, ''));
}

function findBoxRecordByHeaderValue_(sheet, header, value) {
  return findRowByHeaderValue_(sheet, header, value);
}

function findRowByHeaderValue_(sheet, header, value) {
  if (!sheet || sheet.getLastRow() < 2) return null;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const index = headers.indexOf(header);
  if (index < 0) return null;
  const match = sheet.getRange(2, index + 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(value)).matchEntireCell(true).matchCase(true).findNext();
  if (!match) return null;
  const rowNumber = match.getRow();
  const values = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  const record = { _rowNumber: rowNumber };
  headers.forEach((name, i) => { record[name] = values[i]; });
  return record;
}

function validBoxQuantity_(value) {
  const quantity = toNumberOrNull_(value);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0;
}

function isOpenCarton_(status) {
  const value = String(status || '').trim().toLocaleLowerCase('ru-RU');
  return value === 'открыт' || value === 'open' || value === 'active';
}

function isCancelledCarton_(carton) {
  const value = String(carton && carton['Статус'] || '').trim().toLocaleLowerCase('ru-RU');
  return value === 'отменён' || value === 'отменен' || value === 'cancelled';
}

function isClosedCarton_(carton) {
  if (isCancelledCarton_(carton)) return false;
  const value = String(carton && carton['Статус'] || '').trim().toLocaleLowerCase('ru-RU');
  return value === 'закрыт' || value === 'closed' || Boolean(carton && carton.closedAt);
}

function findWorkByIdempotency_(sheet, headers, key) {
  const index = headers.indexOf('idempotencyKey');
  const lastRow = sheet.getLastRow();
  if (index < 0 || lastRow < 2 || !key) return null;
  const match = sheet.getRange(2, index + 1, lastRow - 1, 1)
    .createTextFinder(key).matchEntireCell(true).findNext();
  if (!match) return null;
  const values = sheet.getRange(match.getRow(), 1, 1, headers.length).getValues()[0];
  const result = {};
  headers.forEach((header, i) => { result[header] = values[i]; });
  return result;
}

function bumpDataVersion_() {
  const props = PropertiesService.getScriptProperties();
  const next = Number(props.getProperty(RITM_DATA_VERSION) || 0) + 1;
  props.setProperty(RITM_DATA_VERSION, String(next));
  return next;
}

function readTable_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw new Error(`Не найден лист «${sheetName}».`);
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  const headers = values[0].map(value => String(value));
  return values.slice(1).filter(row => row.some(value => value !== '' && value !== null)).map(row => {
    const record = {};
    headers.forEach((header, index) => { record[header] = row[index]; });
    return record;
  });
}

function readCachedTable_(spreadsheet, sheetName, cacheKey, ttlSeconds, fresh) {
  const cache = CacheService.getScriptCache();
  if (fresh === true) cache.remove(cacheKey);
  const cached = fresh === true ? null : cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) { /* discard corrupt or old cache entry */ }
  }
  const rows = readTable_(spreadsheet, sheetName);
  const json = JSON.stringify(rows);
  // Cache is only a UI/reference optimization. saveWork always rereads authoritative rows.
  if (json.length < 40000) cache.put(cacheKey, json, ttlSeconds);
  return rows;
}

// The owner's type-based shift norms use the same three bases as FBO:
// machine cut = pieces * sheets per piece / sheet norm; hand cut and pack = pieces / piece norm.
function readShiftNorms_(db, fresh) {
  const key = 'ritm.assembly.ref.shiftNorms.v1';
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    try { const cached = cache.get(key); if (cached) return JSON.parse(cached); } catch (_) {}
  }
  const result = { available: false, byType: Object.create(null), reason: 'Не найден лист «нормы».' };
  const sheet = db.getSheetByName('нормы');
  if (!sheet || sheet.getLastRow() < 2) return result;
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 4).getValues();
  const headers = values[0].map(value => String(value || '').trim().toLocaleLowerCase('ru-RU'));
  if (headers[0] !== 'вид' || headers[1] !== 'резка, л' || headers[2] !== 'упаковка' || headers[3] !== 'норма резки и прочего') {
    result.reason = 'В листе «нормы» изменились заголовки; коэффициент требует проверки.';
    return result;
  }
  result.available = true;
  result.reason = '';
  values.slice(1).forEach((row, i) => {
    const type = productTypeKey_(row[0]);
    if (!type || type.startsWith('#')) return;
    const record = { row: i + 2 };
    ['cut', 'packing', 'assembly'].forEach((operationId, column) => {
      const value = toNumberOrNull_(row[column + 1]);
      record[operationId] = value !== null && value > 0 ? value : null;
    });
    const prior = result.byType[type];
    if (prior && ['cut', 'packing', 'assembly'].some(id => prior[id] !== record[id])) {
      prior.conflict = true;
    } else if (!prior) result.byType[type] = record;
  });
  const json = JSON.stringify(result);
  if (json.length < 40000) cache.put(key, json, 60);
  return result;
}

function productTypeKey_(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
}

function resolveWorkNorm_(item, operationId, explicitNorm, shiftNorms) {
  const result = { norm: null, perShift: null, unit: 'шт.', multiplier: 1, source: '', reason: '' };
  if (Number.isFinite(explicitNorm) && explicitNorm > 0) {
    return Object.assign(result, { norm: explicitNorm, perShift: explicitNorm, source: 'OperationNorms' });
  }
  const type = productTypeKey_(item['Вид товара']);
  const record = shiftNorms && shiftNorms.available && Object.prototype.hasOwnProperty.call(shiftNorms.byType, type) ? shiftNorms.byType[type] : null;
  if (record) {
    if (record.conflict) return Object.assign(result, { reason: 'Для этого вида товара указаны разные нормы. Проверьте лист «нормы».' });
    const perShift = record[operationId];
    const column = operationId === 'cut' ? 'B' : operationId === 'packing' ? 'C' : 'D';
    result.source = 'нормы!' + column + record.row;
    if (!(perShift > 0)) return Object.assign(result, { reason: 'Для этой операции норма за смену не заполнена.' });
    const multiplier = operationId === 'cut' ? toNumberOrNull_(item['Листов на штуку']) : 1;
    result.unit = operationId === 'cut' ? 'л.' : 'шт.';
    if (!(multiplier > 0)) return Object.assign(result, { multiplier: null, reason: 'Неизвестно число листов на изделие. Обновите данные поставки и проверьте каталог.' });
    return Object.assign(result, { norm: perShift / multiplier, perShift, multiplier });
  }
  const legacy = operationId === 'packing' ? toNumberOrNull_(item['Норма упаковки, шт/чел']) : null;
  if (legacy > 0) return Object.assign(result, { norm: legacy, perShift: legacy, source: 'Норма упаковки, шт/чел' });
  return Object.assign(result, { reason: shiftNorms && !shiftNorms.available ? shiftNorms.reason : 'В листе «нормы» нет точного совпадения вида товара.' });
}

function moscowWorkDate_(value) {
  const iso = normalizeDateString_(value);
  return iso ? Utilities.formatDate(new Date(iso), 'Europe/Moscow', 'yyyy-MM-dd') : '';
}

function readWorkSnapshot_(db, shipmentId, day) {
  const sheet = db.getSheetByName(TABLES.workLog);
  if (!sheet || sheet.getLastColumn() < 1) return { rows: [], available: false };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const valid = ['shipmentId', 'createdAt', 'employeeId', 'eventId', 'idempotencyKey', 'Источник', 'operationId', 'Количество, шт', 'Коэффициент', 'Норма, шт/чел'].every(header => headers.includes(header));
  if (!valid) return { rows: readRowsByKey_(sheet, 'shipmentId', new Set([shipmentId])), available: false };
  // Work day is today's Moscow date. Compare numeric boundaries instead of
  // invoking Google's timezone formatter once per historical WorkLog row.
  const dayStart = Date.parse(String(day) + 'T00:00:00+03:00');
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  return { available: true, rows: readIndexedRows_(sheet, ['shipmentId', 'createdAt'], row => {
    const time = row.createdAt instanceof Date ? row.createdAt.getTime() : Date.parse(String(row.createdAt || '').trim());
    return String(row.shipmentId) === String(shipmentId) || !Number.isFinite(time) ||
      (Number.isFinite(dayStart) && time >= dayStart && time < dayEnd);
  }, headers, 20) };
}

function readWorkCancellationState_(db, sourceRows) {
  const byEventId = Object.create(null);
  const sheet = db.getSheetByName(TABLES.workCorrections);
  if (!sheet || sheet.getLastRow() < 2) return { byEventId };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const required = ['eventId', 'action', 'createdAt', 'reason'];
  const missing = required.filter(header => !headers.includes(header));
  if (missing.length) throw new Error('Журнал исправлений WorkLog повреждён: отсутствуют колонки ' + missing.join(', ') + '.');
  const eventIds = new Set((sourceRows || []).map(row => String(row.eventId || '').trim()).filter(Boolean));
  if (!eventIds.size) return { byEventId };
  readRowsByKey_(sheet, 'eventId', eventIds).forEach(row => {
    const eventId = String(row.eventId || '').trim();
    if (!eventId || String(row.action || '').toUpperCase() !== 'CANCEL') return;
    const createdAt = normalizeDateString_(row.createdAt);
    if (!byEventId[eventId] || createdAt > String(byEventId[eventId].createdAt || '')) {
      byEventId[eventId] = { createdAt, reason: String(row.reason || '') };
    }
  });
  return { byEventId };
}

function getOrCreateWorkCorrectionsSheet_(db) {
  let sheet = db.getSheetByName(TABLES.workCorrections);
  if (!sheet) {
    sheet = db.insertSheet(TABLES.workCorrections);
    sheet.getRange(1, 1, 1, WORK_CORRECTION_HEADERS.length).setValues([WORK_CORRECTION_HEADERS.slice()]);
  } else if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, WORK_CORRECTION_HEADERS.length).setValues([WORK_CORRECTION_HEADERS.slice()]);
  }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const missing = WORK_CORRECTION_HEADERS.filter(header => !headers.includes(header));
  if (missing.length) throw new Error('В журнале исправлений WorkLog отсутствуют колонки: ' + missing.join(', ') + '.');
  return { sheet, headers };
}

function currentWorkActor_() {
  try {
    return Session.getActiveUser().getEmail() || 'Сборщик (аккаунт не передан)';
  } catch (error) {
    return 'Сборщик (аккаунт не передан)';
  }
}

function cancelWork(eventId, reason) {
  const id = String(eventId || '').trim();
  if (!id || id.length > 200) throw new Error('Не удалось определить запись для удаления. Обновите страницу.');
  const cancellationReason = String(reason || '').trim().slice(0, 240);
  if (!cancellationReason) throw new Error('Укажите причину отмены записи.');
  const db = SpreadsheetApp.openById(DB_ID);
  const workLog = db.getSheetByName(TABLES.workLog);
  if (!workLog || workLog.getLastRow() < 2) throw new Error('Не найден журнал WorkLog.');
  // Search only the eventId column in Sheets and fetch the matching row. Avoid
  // transferring the entire growing index column to Apps Script for one delete.
  const event = findRowByHeaderValue_(workLog, 'eventId', id);
  if (!event) throw new Error('Запись не найдена в WorkLog. Обновите страницу.');
  if (!isCollectorWorkSource_(event['Источник'])) {
    throw new Error('Можно удалить только запись, созданную приложением сборщиков.');
  }
  assertRitmShipmentUnlocked_(event.shipmentId);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) throw new Error('Журнал сейчас занят другой операцией. Запись не изменилась — повторите через несколько секунд.');
  try {
    if (String(event.operationId || '') === 'packing' && PropertiesService.getScriptProperties().getProperty(stockReservationKey_(event.shipmentId, event.positionId))) throw new Error('Сначала дождитесь завершения распределения излишка этого товара.');
    const corrections = db.getSheetByName(TABLES.workCorrections);
    const duplicate = findRowByHeaderValue_(corrections, 'eventId', id);
    if (duplicate && String(duplicate.action || '').trim().toUpperCase() === 'CANCEL') {
      const boxCorrection = reconcileBoxContentsAfterWorkCancellation_(db, event, id, cancellationReason || duplicate.reason);
      const dataVersion = boxCorrection.changed ? bumpDataVersion_() : getDataVersion();
      return {
        ok: true, alreadyCancelled: true, eventId: id,
        cancelledAt: normalizeDateString_(duplicate.createdAt),
        reason: String(duplicate.reason || ''), boxCorrection, dataVersion,
      };
    }
    assertLocalShipmentUnlocked_(event.shipmentId);
    if (String(event.operationId || '') === 'packing') {
      const packedBefore = readPackedQuantityForItem_(db,
        { shipmentId: String(event.shipmentId || ''), directionId: String(event.directionId || '') },
        { positionId: String(event.positionId || '') }
      );
      if (!packedBefore.known) throw new Error('Не удалось проверить упаковку и состав коробов; запись не отменена. ' + (packedBefore.reason || ''));
    }
    const target = getOrCreateWorkCorrectionsSheet_(db);
    const createdAt = new Date().toISOString();
    const rowByHeader = {
      correctionId: Utilities.getUuid(),
      eventId: id,
      action: 'CANCEL',
      createdAt,
      actor: currentWorkActor_(),
      reason: cancellationReason,
    };
    const values = target.headers.map(header => Object.prototype.hasOwnProperty.call(rowByHeader, header) ? rowByHeader[header] : '');
    target.sheet.getRange(target.sheet.getLastRow() + 1, 1, 1, target.headers.length).setValues([values]);
    const boxCorrection = reconcileBoxContentsAfterWorkCancellation_(db, event, id, cancellationReason);
    const dataVersion = bumpDataVersion_();
    return {
      ok: true, alreadyCancelled: false, eventId: id, shipmentId: String(event.shipmentId || ''),
      directionId: String(event.directionId || ''), positionId: String(event.positionId || ''),
      employeeId: String(event.employeeId || ''), operationId: String(event.operationId || ''),
      quantity: toNumberOrNull_(event['Количество, шт']), createdAt: normalizeDateString_(event.createdAt),
      cancelledAt: createdAt, reason: rowByHeader.reason, boxCorrection, dataVersion,
    };
  } finally {
    lock.releaseLock();
  }
}

function summarizeEmployeeShift_(snapshot, day, cancellations) {
  const result = { date: day, scope: 'RITM Assembly · все поставки', available: snapshot.available, employees: Object.create(null) };
  const cancelledEventIds = cancellations || Object.create(null);
  const seenIds = new Set();
  const seenKeys = new Set();
  snapshot.rows.forEach(row => {
    if (String(row['Источник']) !== 'WEB_APP_RITM' || !OPERATION_LABELS[row.operationId]) return;
    const date = moscowWorkDate_(row.createdAt);
    if (date && date !== day) return;
    const id = String(row.eventId || '');
    if (cancelledEventIds[id]) { seenIds.add(id); return; }
    const key = String(row.idempotencyKey || '');
    const employeeId = String(row.employeeId || '');
    const quantity = toNumberOrNull_(row['Количество, шт']);
    if (!id || !key || !employeeId || !Number.isSafeInteger(quantity) || quantity < 1) { result.available = false; return; }
    if (seenIds.has(id) || seenKeys.has(key)) return;
    seenIds.add(id); seenKeys.add(key);
    if (!Object.prototype.hasOwnProperty.call(result.employees, employeeId)) result.employees[employeeId] = { coefficient: 0, unknownCount: 0, eventCount: 0 };
    const employee = result.employees[employeeId];
    employee.eventCount++;
    const saved = toNumberOrNull_(row['Коэффициент']);
    const norm = toNumberOrNull_(row['Норма, шт/чел']);
    const coefficient = saved !== null ? saved : norm > 0 ? quantity / norm : null;
    if (!date || coefficient === null || coefficient < 0 || !Number.isFinite(coefficient)) employee.unknownCount++;
    else employee.coefficient += coefficient;
  });
  return result;
}

// Read a narrow index column first, then fetch only matching row blocks. WorkLog and Photos
// grow over time; loading their full historical/payload columns on every shipment switch is costly.
function readRowsByKey_(sheet, keyHeader, wantedValues) {
  if (!sheet || !wantedValues || !wantedValues.size) return [];
  // Coalesce nearby journal rows into fewer Sheets requests. Photos can contain
  // large base64 values, so retain exact row reads for that payload-heavy sheet.
  const gap = sheet.getName() === TABLES.photos ? 0 : 20;
  return readIndexedRows_(sheet, [keyHeader], row => wantedValues.has(String(row[keyHeader] || '')), undefined, gap);
}

function readIndexedRows_(sheet, keyHeaders, predicate, knownHeaders, maxGapRows) {
  const name=sheet.getName();
  if(cartonRequestReads_&&!cartonRequestReads_.write&&[TABLES.cartons,TABLES.cartonContents].includes(name))
    return readCartonRequestRows_(sheet,keyHeaders,predicate,knownHeaders,maxGapRows);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];
  const headers = knownHeaders || sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
  const indices = keyHeaders.map(header => headers.indexOf(header));
  if (indices.some(index => index < 0)) return [];
  const first = Math.min(...indices), last = Math.max(...indices);
  const matches = sheet.getRange(2, first + 1, lastRow - 1, last - first + 1).getValues()
    .map((row, index) => {
      const record = {};
      keyHeaders.forEach((header, i) => { record[header] = row[indices[i] - first]; });
      return predicate(record) ? index + 2 : 0;
    })
    .filter(Boolean);
  if (!matches.length) return [];
  const allowedGap = Number.isSafeInteger(maxGapRows) ? Math.max(0, Math.min(100, maxGapRows)) : 0;
  const blocks = [];
  matches.forEach(row => {
    const last = blocks[blocks.length - 1];
    if (last && row <= last.end + allowedGap + 1) last.end = row;
    else blocks.push({ start: row, end: row });
  });
  // Reduce remote Sheets calls for fragmented operational journals. Keep photo
  // rows separate because their large payloads can make a broad read expensive.
  // The same predicate below is still applied to every returned row.
  if (sheet.getName() !== TABLES.photos && blocks.length > 3 &&
      (blocks[blocks.length - 1].end - blocks[0].start + 1) * lastColumn <= 100000) {
    blocks.splice(0, blocks.length, { start: blocks[0].start, end: blocks[blocks.length - 1].end });
  }
  const records = [];
  blocks.forEach(block => sheet.getRange(block.start, 1, block.end - block.start + 1, lastColumn).getValues().forEach(values => {
    if (!values.some(value => value !== '' && value !== null)) return;
    const record = {};
    headers.forEach((header, index) => { record[header] = values[index]; });
    const keyRecord = {};
    keyHeaders.forEach(header => { keyRecord[header] = record[header]; });
    if (!predicate(keyRecord)) return;
    records.push(record);
  }));
  return records;
}

// Cache narrow key columns and only the matched row blocks, never download the
// entire historical contents table merely to display several open cartons.
function readCartonRequestRows_(sheet,keyHeaders,predicate,knownHeaders,maxGapRows){
  const name=sheet.getName();
  let memo=cartonRequestReads_.tables[name];
  if(!memo){
    const lastRow=sheet.getLastRow(),lastColumn=sheet.getLastColumn();
    if(lastRow<2||lastColumn<1)return [];
    memo={lastRow,lastColumn,headers:knownHeaders||sheet.getRange(1,1,1,lastColumn).getValues()[0].map(String),keys:Object.create(null),rows:Object.create(null)};
    cartonRequestReads_.tables[name]=memo;
  }
  const indices=keyHeaders.map(header=>memo.headers.indexOf(header));
  if(indices.some(index=>index<0))return [];
  const missing=indices.filter(index=>!memo.keys[index]);
  if(missing.length){
    const first=Math.min(...missing),last=Math.max(...missing);
    const values=sheet.getRange(2,first+1,memo.lastRow-1,last-first+1).getValues();
    for(let c=first;c<=last;c++)memo.keys[c]=values.map(row=>row[c-first]);
  }
  const matches=[];
  for(let i=0;i<memo.lastRow-1;i++){
    const key={};keyHeaders.forEach((header,j)=>{key[header]=memo.keys[indices[j]][i];});
    if(predicate(key))matches.push(i+2);
  }
  const absent=matches.filter(row=>!memo.rows[row]),gap=Number.isSafeInteger(maxGapRows)?Math.max(0,Math.min(100,maxGapRows)):0,blocks=[];
  absent.forEach(row=>{const last=blocks[blocks.length-1];if(last&&row<=last.end+gap+1)last.end=row;else blocks.push({start:row,end:row});});
  if(blocks.length>3&&(blocks[blocks.length-1].end-blocks[0].start+1)*memo.lastColumn<=100000)blocks.splice(0,blocks.length,{start:blocks[0].start,end:blocks[blocks.length-1].end});
  blocks.forEach(block=>sheet.getRange(block.start,1,block.end-block.start+1,memo.lastColumn).getValues().forEach((values,i)=>{
    const row={};memo.headers.forEach((header,c)=>{row[header]=values[c];});memo.rows[block.start+i]=row;
  }));
  return matches.filter(row=>predicate(memo.rows[row])).map(row=>Object.assign({},memo.rows[row]));
}

function emptyTotals_() {
  return {
    operations: {
      cut: emptyOperation_(),
      assembly: emptyOperation_(),
      packing: emptyOperation_(),
    },
    workers: Object.create(null),
  };
}

function emptyOperation_() {
  return { quantity: 0, coefficient: 0, coefficientKnown: false, unknownCoefficientCount: 0 };
}

function emptyWorkerOperation_() {
  return { quantity: 0, coefficient: 0, coefficientKnown: false, unknownCoefficientCount: 0, eventCount: 0 };
}

function processingStatus_(operations) {
  if (Object.keys(operations).every(key => operations[key].fact === null)) return 'Нет записей';
  if (operations.packing.plan > 0 && operations.packing.fact >= operations.packing.plan) return 'Упаковка завершена';
  if (operations.packing.fact > 0) return 'Упаковка';
  if (operations.assembly.fact > 0) return 'Ручная резка';
  if (operations.cut.fact > 0) return 'Резка на станке';
  return 'Не начато';
}

function normalizeDateString_(value) {
  if (!value) return '';
  if (value instanceof Date && !isNaN(value.getTime())) return value.toISOString();
  const text = String(value).trim();
  const time = Date.parse(text);
  return Number.isNaN(time) ? '' : new Date(time).toISOString();
}

function toNumberOrNull_(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validateWorkPayload_(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Не удалось прочитать данные записи.');
  if (!Object.prototype.hasOwnProperty.call(OPERATION_LABELS, String(payload.operationId))) {
    throw new Error('Выбрана неизвестная операция.');
  }
  if (!String(payload.employeeId || '').trim()) throw new Error('Выберите сотрудника.');
  if (!String(payload.positionId || '').trim() || !String(payload.shipmentId || '').trim() || !String(payload.directionId || '').trim()) {
    throw new Error('Выберите артикул из поставки.');
  }
  if (!/^[-A-Za-z0-9_]{12,100}$/.test(String(payload.idempotencyKey || ''))) {
    throw new Error('Не удалось проверить повторную отправку. Обновите форму и повторите.');
  }
  const quantity = Number(payload.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Количество должно быть целым числом больше нуля.');
}

// Printing is the canonical supply list. Only this app's named sheets are written.
const RITM_PRINTING_ID = '1hojhKS4Av_yy5sUMJcsoeJ_MQRU3V5g9P-fP61PO6Cs';
const RITM_BOX_PRINTING_ID = '1Uqan6nEN7drtLJd0V7yJjlQrdN5jabqS2c26XG2yy4s';
const RITM_CATALOG_ID = '1F3RFu4xC1Y6MMt-AjwL-D7QyJZr_NmzsvE_eaL-acWs';
const RITM_PHOTOS_ID = '1_oKOKNdlcjnQUEg_Z9A43-VEJ7P1JeRgmRZ9j85xmhw';
const RITM_SYNC_PREFIX = 'ritm.assembly.supply.';
const RITM_SYNC_STATE = 'ritm.assembly.sync';
const RITM_SHEET_MARKER = 'RITM_ASSEMBLY_SUPPLY_V1:';
const RITM_ITEM_HEADERS = [
  'shipmentId', 'directionId', 'Направление', 'positionId', 'Артикул',
  'Название товара', 'Вид товара', 'photoAssetKey', 'Норма упаковки, шт/чел',
  'План порезки, шт', 'План сборки, шт', 'План упаковки, шт',
  'Коробов · срез', 'В коробах, шт · срез', 'Не распределено, шт · срез', 'Источник',
  'sourceSheetId', 'sourceRow', 'sourceUid', 'Источник каталога', 'Синхронизировано', 'Фото', 'Листов на штуку',
];

function syncRitmSupplies(force, fromEvent) {
  const props = PropertiesService.getScriptProperties();
  const previous = Object.assign({ status: 'not_checked', errors: [] }, parseSyncJson_(props.getProperty(RITM_SYNC_STATE), {}));
  const requestAt = Date.now();
  const maxExecutionMs = 7 * 60 * 1000; // Apps Script executions are limited to six minutes.
  if (previous.status === 'running' && requestAt - Number(previous.startedAt || 0) < maxExecutionMs) return previous;
  if (force !== true && fromEvent !== true && previous.status !== 'running' && requestAt - Number(previous.startedAt || 0) < 20000) return previous;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return Object.assign({}, previous, { status: 'running' });
  const startedAt = Date.now();
  const syncId = Utilities.getUuid();
  const report = { status: 'running', syncId, startedAt, at: new Date().toISOString(), created: [], updated: [], archived: [], errors: [] };
  let reserved = false;
  try {
    // Reserve the sync lease under a short lock, then release it before any Sheets I/O.
    const recent = parseSyncJson_(props.getProperty(RITM_SYNC_STATE), {});
    const age = startedAt - Number(recent.startedAt || 0);
    if (recent.status === 'running' && age < maxExecutionMs) return recent;
    if (force !== true && fromEvent !== true && recent.status !== 'running' && age < 20000) return recent;
    props.setProperty(RITM_SYNC_STATE, JSON.stringify(report));
    reserved = true;
  } finally {
    lock.releaseLock();
  }
  if (!reserved) return report;

  try {
    const source = SpreadsheetApp.openById(RITM_PRINTING_ID);
    const db = SpreadsheetApp.openById(DB_ID);
    const rollSheets = source.getSheets();
    const manifestCache = new Map();
    const candidates = rollSheets.filter(sheet => {
      if (ritmSupplyManifest_(sheet, manifestCache)) return false;
      if (sheet.isSheetHidden() || sheet.getLastRow() < 4 || sheet.getLastColumn() < 15) return false;
      try { ritmOrderColumns_(sheet); return true; }
      catch (_) { return false; }
    });
    const activeIds = new Set(candidates.map(sheet => String(sheet.getSheetId())));
    // Hidden tabs still exist: never treat hiding as deletion or reuse their identity.
    const existingIds = new Set(rollSheets.map(sheet => String(sheet.getSheetId())));
    let catalog;
    const loadCatalog = () => {
      if (catalog) return catalog;
      try { catalog = readRitmCatalog_(); }
      catch (error) {
        catalog = new Map();
        report.errors.push('Каталог временно недоступен; артикулы и план сохранены без дополнительных сведений.');
      }
      return catalog;
    };
    // Newly committed department jobs take priority over refreshing old legacy
    // supplies. Reuse metadata already read above within this execution.
    syncRitmDepartmentSupplies_(source, db, props, report, loadCatalog, startedAt, force, rollSheets, manifestCache);
    candidates.forEach((sheet, index) => {
      const key = RITM_SYNC_PREFIX + sheet.getSheetId();
      try {
        let rows = readRitmOrders_(sheet);
        const prior = parseSyncJson_(props.getProperty(key), null);
        let target = prior && db.getSheetById(Number(prior.sheetId));
        const marker = RITM_SHEET_MARKER + sheet.getSheetId();
        if (prior && prior.transferSelection) {
          if (!target) throw new Error('Не найден выбранный состав Assembly; требуется повторная передача.');
          rows = selectedRitmTransferRows_(rows, target, sheet.getSheetId());
        }
        const fingerprint = ritmFingerprint_([sheet.getName(), rows]);
        if (!target) {
          target = db.getSheetByName(sheet.getName());
          if (target && target.getRange(1, 1).getNote() !== marker) {
            archiveReplacedRitmSheet_(db, props, target, existingIds);
            target = db.getSheetByName(sheet.getName());
          }
          if (target && target.getRange(1, 1).getNote() !== marker) throw new Error('В хранилище сборщиков уже есть чужой одноимённый лист.');
        }
        const catalogDue = force === true || !prior || startedAt - Number(prior.catalogAt || 0) > 15 * 60000;
        if (target && prior && prior.fingerprint === fingerprint && !catalogDue) {
          if (prior.sourceAvailable === false || prior.order !== index) report.updated.push(sheet.getName());
          props.setProperty(key, JSON.stringify(Object.assign({}, prior, { sourceAvailable: true, order: index })));
          if (!props.getProperty(boxViewPropertyKey_(prior.shipmentId))) {
            ensureShipmentBoxViewBestEffort_(db, { shipmentId: prior.shipmentId, 'Название поставки': sheet.getName() });
          }
          return;
        }
        const isNew = !target;
        if (!target) {
          target = db.insertSheet(sheet.getName());
          // If execution stops later, only this exact marked sheet can be adopted.
          target.getRange(1, 1).setNote(marker);
        }
        if (target.getRange(1, 1).getNote() !== marker) throw new Error('Метка листа сборщиков изменилась; обновление остановлено.');
        if (target.getName() !== sheet.getName()) {
          const collision = db.getSheetByName(sheet.getName());
          if (collision && collision.getSheetId() !== target.getSheetId()) throw new Error('Новое название поставки уже занято.');
          target.setName(sheet.getName());
        }
        const shipmentId = 'RITM-ROLL-' + sheet.getSheetId();
        const hasMergedBox = ritmMergedBoxSourceIds_(props, sheet.getSheetId()).size > 0;
        const headers = hasMergedBox
          ? RITM_ITEM_HEADERS.concat(['Отдел производства', 'Документ производства'])
          : RITM_ITEM_HEADERS;
        const items = rows.map(row => {
          const item = ritmItemRow_(shipmentId, sheet.getName(), sheet.getSheetId(), row, loadCatalog());
          if (hasMergedBox) item.push('Рулонная печать', RITM_PRINTING_ID);
          return item;
        });
        const preservedBoxRows = hasMergedBox ? ritmMergedBoxRowsForRoll_(target, props, sheet.getSheetId()) : [];
        const values = [headers].concat(items, preservedBoxRows);
        if (target.getMaxRows() < values.length) target.insertRowsAfter(target.getMaxRows(), values.length - target.getMaxRows());
        if (target.getMaxColumns() < headers.length) target.insertColumnsAfter(target.getMaxColumns(), headers.length - target.getMaxColumns());
        const oldRows = target.getLastRow();
        target.getRange(1, 1, values.length, headers.length).setValues(values.map(row => row.map(ritmLiteral_)));
        if (oldRows > values.length) target.getRange(values.length + 1, 1, oldRows - values.length, headers.length).clearContent();
        if (isNew) {
          target.setFrozenRows(1);
          target.getRange(1, 1, 1, headers.length).setBackground('#14293d').setFontColor('#ffffff').setFontWeight('bold');
          target.setColumnWidth(5, 180);
          target.setColumnWidth(6, 360);
        }
        SpreadsheetApp.flush();
        const readback = target.getRange(1, 1, values.length, headers.length).getValues();
        if (readback.length !== values.length || readback.some((row, i) => row.some((cell, c) => String(cell) !== String(values[i][c])))) {
          throw new Error('Проверка состава листа сборщиков не завершилась. Повтор не создаст новый лист.');
        }
        props.setProperty(key, JSON.stringify({
          shipmentId, name: sheet.getName(), sheetId: target.getSheetId(), sourceSheetId: sheet.getSheetId(),
          sourceAvailable: true, fingerprint, rows: values.length - 1, order: index,
          syncedAt: new Date().toISOString(), catalogAt: report.errors.length ? 0 : startedAt,
          transferSelection: !!(prior && prior.transferSelection),
        }));
        if (isNew || !props.getProperty(boxViewPropertyKey_(shipmentId)) || (prior && prior.name !== sheet.getName())) {
          ensureShipmentBoxViewBestEffort_(db, { shipmentId, 'Название поставки': sheet.getName() });
        }
        report[isNew ? 'created' : 'updated'].push(sheet.getName());
      } catch (error) {
        const failedTransfer = parseSyncJson_(props.getProperty(key), null);
        if (failedTransfer && failedTransfer.transferSelection) props.setProperty(key, JSON.stringify(Object.assign({}, failedTransfer, { sourceAvailable: false })));
        report.errors.push(sheet.getName() + ': ' + String(error.message || 'Ошибка синхронизации.').slice(0, 240));
      }
    });
    syncRitmTransferredBoxSupplies_(db, props, report, loadCatalog, startedAt, force);
    const all = props.getProperties();
    Object.keys(all).filter(key => key.indexOf(RITM_SYNC_PREFIX) === 0).forEach(key => {
      const record = parseSyncJson_(all[key], null);
      if (record && (record.routed || record.transferred)) return;
      if (record && !record.archived && !existingIds.has(String(record.sourceSheetId))) {
        archiveDeletedRitmSupply_(db, props, record);
        report.archived.push(record.name);
      } else if (record && !activeIds.has(String(record.sourceSheetId))) {
        if (record.sourceAvailable !== false) report.updated.push(record.name);
        props.setProperty(key, JSON.stringify(Object.assign({}, record, { sourceAvailable: false })));
      }
    });
    // A reporting-view problem must never block receiving production jobs.
    try { syncDirectionBoxViews_(db, props); }
    catch (error) { report.boxViewWarning = 'Общие листы коробов: ' + String(error.message || error).slice(0, 200); }
    if (report.errors.length) report.status = 'partial';
  } catch (error) {
    report.status = 'error';
    report.errors.push('Не удалось прочитать поставки печатников. Показаны ранее полученные данные.');
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAt;
    // Publish the result and its data version in a second short critical section.
    const finishLock = LockService.getScriptLock();
    finishLock.waitLock(5000);
    try {
      const latest = parseSyncJson_(props.getProperty(RITM_SYNC_STATE), {});
      if (latest.syncId === syncId) {
        report.status = report.status === 'running' ? 'current' : report.status;
        if (report.created.length || report.updated.length || report.archived.length) report.dataVersion = bumpDataVersion_();
        props.setProperty(RITM_SYNC_STATE, JSON.stringify(report));
      }
    } finally {
      finishLock.releaseLock();
    }
  }
  return report;
}

function archiveReplacedRitmSheet_(db, props, target, existingIds) {
  const note = target.getRange(1, 1).getNote();
  if (note.indexOf(RITM_SHEET_MARKER) !== 0) return;
  const sourceId = note.slice(RITM_SHEET_MARKER.length);
  if (!/^\d+$/.test(sourceId) || existingIds.has(sourceId)) return;
  const key = RITM_SYNC_PREFIX + sourceId;
  const record = parseSyncJson_(props.getProperty(key), null);
  if (!record || String(record.sourceSheetId) !== sourceId || Number(record.sheetId) !== target.getSheetId()) return;
  const suffix = ' · архив ' + sourceId;
  const base = target.getName().slice(0, 90 - suffix.length) + suffix;
  let archiveName = base, attempt = 1;
  while (db.getSheetByName(archiveName)) archiveName = base + ' ' + attempt++;
  // Persist before rename, so interruption is recoverable without overwriting old rows.
  props.setProperty(key, JSON.stringify(Object.assign({}, record, {
    sourceAvailable: false, archived: true, archivedName: archiveName,
  })));
  target.setName(archiveName);
}

function archiveDeletedRitmSupply_(db, props, record) {
  const sourceId = String(record.sourceSheetId || '');
  const target = db.getSheetById(Number(record.sheetId));
  if (!/^\d+$/.test(sourceId) || !target || target.getRange(1, 1).getNote() !== RITM_SHEET_MARKER + sourceId) {
    // Preserve the last known record but don't rename or hide an unverified sheet.
    props.setProperty(RITM_SYNC_PREFIX + sourceId, JSON.stringify(Object.assign({}, record, {
      sourceAvailable: false, deletionPending: true,
    })));
    return;
  }
  if (record.archived && target.getName() === record.archivedName) return;
  const suffix = ' · архив ' + sourceId;
  const base = target.getName().slice(0, 90 - suffix.length) + suffix;
  let archiveName = base, attempt = 1;
  while (db.getSheetByName(archiveName) && db.getSheetByName(archiveName).getSheetId() !== target.getSheetId()) archiveName = base + ' ' + attempt++;
  props.setProperty(RITM_SYNC_PREFIX + sourceId, JSON.stringify(Object.assign({}, record, {
    sourceAvailable: false, archived: true, archivedName: archiveName, deletedAt: new Date().toISOString(),
  })));
  if (target.getName() !== archiveName) target.setName(archiveName);
}

function installRitmSupplySync() {
  // Provisioning is an editor/owner action, never a public Web App capability.
  if (Session.getActiveUser().getEmail() !== 'zinovevkirill234@gmail.com' || Session.getEffectiveUser().getEmail() !== 'zinovevkirill234@gmail.com') {
    throw new Error('Настройка синхронизации доступна только владельцу проекта.');
  }
  if (PropertiesService.getScriptProperties().getProperty(RITM_EVENT_MODE) === 'events')
    throw new Error('Включена синхронизация по событиям RITM; минутный триггер не установлен.');
  const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncRitmSupplies');
  if (!triggers.length) ScriptApp.newTrigger('syncRitmSupplies').timeBased().everyMinutes(1).create();
  triggers.slice(1).forEach(t => ScriptApp.deleteTrigger(t));
  const result = syncRitmSupplies(true);
  console.log(JSON.stringify(result));
  return result;
}

function ritmOrderColumns_(sheet) {
  const width = Math.min(40, sheet.getMaxColumns() - 4);
  if (!Number.isSafeInteger(width) || width < 2) throw new Error('Не удалось проверить заголовки производственного задания.');
  const headers = sheet.getRange(4, 5, 1, width).getDisplayValues()[0].map(value =>
    String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru-RU')
  );
  const articleColumns = [], quantityColumns = [];
  headers.forEach((header, index) => {
    if (header === 'артикул') articleColumns.push(index);
    if (header === 'кол-во' || header === 'количество') quantityColumns.push(index);
  });
  if (articleColumns.length !== 1 || quantityColumns.length !== 1) {
    throw new Error('В строке 4 должны быть единственные столбцы «Артикул» и «Кол-во».');
  }
  // AC used to hold legacy IDs; newer box sheets use it for cut quantities.
  // Only an empty or explicitly ID-labelled header can be a legacy UID column.
  const acHeader = headers[24] || '';
  return { width, articleIndex: articleColumns[0], quantityIndex: quantityColumns[0], legacyUidInAc: !acHeader || /^(uid|id|идентификатор|идентификатор позиции)$/.test(acHeader) };
}

function ritmSourceUid_(row, legacyUidInAc) {
  const generatedPattern = /^ritm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$/i;
  const generated = row.map(value => String(value || '').trim()).filter(value => generatedPattern.test(value));
  if (generated.length > 1) throw new Error('В строке найдено несколько UID позиции.');
  if (generated.length === 1) return generated[0];
  // Older source tabs stored the UID in AC without the newer "ritm-...-row" prefix.
  return legacyUidInAc ? String(row[24] || '').trim() : '';
}

function readRitmOrders_(sheet, columns) {
  const last = sheet.getLastRow();
  if (last > 5000) throw new Error('В листе больше 5000 строк; требуется проверить диапазон поставки.');
  if (last < 5) return [];
  columns = columns || ritmOrderColumns_(sheet);
  const values = sheet.getRange(5, 5, last - 4, columns.width).getValues();
  const seen = new Set();
  return values.flatMap((row, index) => {
    const sku = String(row[columns.articleIndex] || '').trim();
    if (!sku) return [];
    const uid = ritmSourceUid_(row, columns.legacyUidInAc);
    if (uid && seen.has(uid)) throw new Error('Повторяется UID позиции; синхронизация этой поставки остановлена.');
    if (uid) seen.add(uid);
    const quantity = toNumberOrNull_(row[columns.quantityIndex]);
    return [{ sku, uid, row: index + 5, quantity: Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null }];
  });
}

function ritmSupplyManifest_(sheet, cache) {
  if (cache && cache.has(sheet)) return cache.get(sheet);
  const entries = sheet.getDeveloperMetadata().filter(entry => entry.getKey() === 'RITM_SUPPLY');
  if (!entries.length) { if (cache) cache.set(sheet, null); return null; }
  if (entries.length !== 1) throw new Error('У задания несколько связей с поставкой.');
  const manifest = parseSyncJson_(entries[0].getValue(), null);
  if (!manifest || manifest.version !== 1 || !/^RITM-(?:SUPPLY-[a-f0-9-]{36}|ROLL-\d+|BOX-\d+)$/.test(manifest.id) ||
      typeof manifest.name !== 'string' || !manifest.name || manifest.name.length > 100 ||
      !Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > 2) throw new Error('Некорректная связь производственного задания.');
  const seen = new Set();
  manifest.parts.forEach(part => {
    const expected = part.department === 'roll' ? RITM_PRINTING_ID : part.department === 'box' ? RITM_BOX_PRINTING_ID : '';
    if (!expected || part.documentId !== expected || !Number.isSafeInteger(part.sheetId) || part.sheetId < 0 || seen.has(part.department)) throw new Error('Некорректный источник отдела производства.');
    seen.add(part.department);
  });
  if (cache) cache.set(sheet, manifest);
  return manifest;
}

// Every participant carries the same committed manifest. A half-written supply
// must never replace the last complete Assembly snapshot.
function syncRitmDepartmentSupplies_(rollSource, db, props, report, loadCatalog, startedAt, force, rollSheets, manifestCache, onlyId, transferParts) {
  const sources = rollSource ? [{ id: RITM_PRINTING_ID, book: rollSource, sheets: rollSheets || rollSource.getSheets() }] : [];
  let allSourcesAvailable = true;
  try { if (!onlyId || !transferParts || transferParts.some(part => part.department === 'box')) sources.push({ id: RITM_BOX_PRINTING_ID, book: SpreadsheetApp.openById(RITM_BOX_PRINTING_ID) }); }
  catch (_) { allSourcesAvailable = false; report.errors.push('Источник бокса временно недоступен; общий состав сохранён без изменений.'); }
  const discovered = new Map(), groups = new Map(), badGroups = new Set();
  const existingRefs = new Set();
  sources.forEach(source => (source.sheets || source.book.getSheets()).forEach(sheet => {
    existingRefs.add(source.id + ':' + sheet.getSheetId());
    try {
      const manifest = ritmSupplyManifest_(sheet, manifestCache);
      if (!manifest) return;
      const ref = source.id + ':' + sheet.getSheetId();
      discovered.set(ref, { sheet, manifest });
      if (groups.has(manifest.id) && ritmFingerprint_(groups.get(manifest.id)) !== ritmFingerprint_(manifest)) badGroups.add(manifest.id);
      groups.set(manifest.id, manifest);
    } catch (error) { if (!onlyId) report.errors.push(sheet.getName() + ': ' + String(error.message || error)); }
  }));
  const touched = new Set();
  groups.forEach(manifest => {
    if (onlyId && manifest.id !== onlyId) return;
    const legacyId = /^RITM-ROLL-(\d+)$/.exec(manifest.id);
    const identity = legacyId ? legacyId[1] : 'linked-' + manifest.id;
    const key = RITM_SYNC_PREFIX + identity;
    const marker = RITM_SHEET_MARKER + identity;
    touched.add(key);
    const prior = parseSyncJson_(props.getProperty(key), null);
    try {
      if (!manifest.ready || badGroups.has(manifest.id)) throw new Error('Загрузка отделов ещё не завершена. Показан предыдущий полный состав.');
      const parts = manifest.parts.map(part => {
        const source = discovered.get(part.documentId + ':' + part.sheetId);
        if (!source || source.sheet.isSheetHidden() || ritmFingerprint_(source.manifest) !== ritmFingerprint_(manifest)) throw new Error('Не все производственные задания подтверждены. Предыдущий состав сохранён.');
        if (!manifest.parts.some(p => p.documentId === part.documentId && p.sheetId === source.sheet.getSheetId())) throw new Error('Источник задания не совпал со связью поставки.');
        const columns = ritmOrderColumns_(source.sheet);
        const rows = readRitmOrders_(source.sheet, columns);
        if (transferParts) {
          const expected = transferParts.find(p => p.department === part.department && p.sheetId === part.sheetId);
          if (!expected || ritmTransferFingerprint_(part.department, part.sheetId, source.sheet.getName(), source.manifest, rows) !== expected.fingerprint)
            ritmTransferConflict_('Состав участка изменился перед передачей.');
        }
        return { ref: part, rows };
      });
      const fingerprint = ritmFingerprint_([manifest, parts.map(p => [p.ref, p.rows])]);
      let target = prior && db.getSheetById(Number(prior.sheetId));
      const catalogDue = force === true || !prior || startedAt - Number(prior.catalogAt || 0) > 15 * 60000;
      if (target && prior.fingerprint === fingerprint && !catalogDue) {
        if (prior.sourceAvailable === false) report.updated.push(manifest.name);
        props.setProperty(key, JSON.stringify(Object.assign({}, prior, { sourceAvailable: true, manifestRevision: manifest.revision })));
        return;
      }
      if (!target) {
        target = db.getSheetByName(manifest.name);
        if (target && target.getRange(1, 1).getNote() !== marker) throw new Error('Одноимённый лист сборщиков принадлежит другой поставке.');
      }
      const isNew = !target;
      if (!target) { target = db.insertSheet(manifest.name); target.getRange(1, 1).setNote(marker); }
      if (target.getRange(1, 1).getNote() !== marker) throw new Error('Изменилась метка общего состава.');
      const catalog = loadCatalog();
      const items = [];
      parts.forEach(part => part.rows.forEach(row => {
        const item = ritmItemRow_(manifest.id, manifest.name, part.ref.sheetId, row, catalog);
        // Existing roll WorkLog identities remain byte-for-byte unchanged.
        if (part.ref.department === 'box') item[3] = manifest.id + '|box:' + part.ref.sheetId + '|' + (row.uid ? 'uid:' + row.uid : 'row:' + row.row) + '|' + row.sku;
        item[15] = part.ref.department === 'box' ? 'RITM_BOX_PRINTING' : 'RITM_ROLL_PRINTING';
        item.push(part.ref.department === 'box' ? 'Бокс' : 'Рулонная печать', part.ref.documentId);
        items.push(item);
      }));
      const headers = RITM_ITEM_HEADERS.concat(['Отдел производства', 'Документ производства']);
      const values = [headers].concat(items).map(row => row.map(ritmLiteral_));
      if (target.getMaxRows() < values.length) target.insertRowsAfter(target.getMaxRows(), values.length - target.getMaxRows());
      if (target.getMaxColumns() < headers.length) target.insertColumnsAfter(target.getMaxColumns(), headers.length - target.getMaxColumns());
      const oldRows = target.getLastRow();
      target.getRange(1, 1, values.length, headers.length).setValues(values);
      if (oldRows > values.length) target.getRange(values.length + 1, 1, oldRows - values.length, headers.length).clearContent();
      if (isNew) { target.setFrozenRows(1); target.getRange(1, 1, 1, headers.length).setBackground('#14293d').setFontColor('#ffffff').setFontWeight('bold'); }
      SpreadsheetApp.flush();
      const actual = target.getRange(1, 1, values.length, headers.length).getValues();
      if (actual.some((row, i) => row.some((cell, c) => String(cell) !== String(values[i][c])))) throw new Error('Общий состав не прошёл проверку записи.');
      props.setProperty(key, JSON.stringify({ shipmentId: manifest.id, name: manifest.name, sheetId: target.getSheetId(),
        sourceSheetId: parts[0].ref.sheetId, parts: manifest.parts, marker, routed: true, rows: items.length,
        sourceAvailable: true, fingerprint, manifestRevision: manifest.revision, order: prior ? prior.order : 1000 + groups.size,
        syncedAt: new Date().toISOString(), catalogAt: startedAt }));
      ensureShipmentBoxViewBestEffort_(db, { shipmentId: manifest.id, 'Название поставки': manifest.name });
      report[isNew ? 'created' : 'updated'].push(manifest.name);
    } catch (error) {
      if (onlyId && error.transferConflict) throw error;
      if (prior) {
        if (prior.sourceAvailable !== false) report.updated.push(manifest.name);
        props.setProperty(key, JSON.stringify(Object.assign({}, prior, { sourceAvailable: false })));
      }
      report.errors.push(manifest.name + ': ' + String(error.message || error).slice(0, 240));
    }
  });
  if (onlyId) return;
  const all = props.getProperties();
  Object.keys(all).filter(key => key.indexOf(RITM_SYNC_PREFIX) === 0 && !touched.has(key)).forEach(key => {
    const record = parseSyncJson_(all[key], null);
    if (record && record.routed && !record.archived && allSourcesAvailable && record.parts &&
        record.parts.every(part => !existingRefs.has(part.documentId + ':' + part.sheetId))) {
      try {
        const target = db.getSheetById(Number(record.sheetId));
        if (!target) {
          // A previously removed derived tab must not keep every later event
          // pending. Sources are confirmed absent; only retire its registry row.
          props.setProperty(key, JSON.stringify(Object.assign({}, record, { sourceAvailable: false, archived: true })));
          report.archived.push(record.name);
          return;
        }
        if (!record.marker || target.getRange(1, 1).getNote() !== record.marker) throw new Error('Не подтверждена метка архивируемого состава.');
        const suffix = ' · архив ' + target.getSheetId();
        const base = record.name.slice(0, 90 - suffix.length) + suffix;
        let archiveName = base, attempt = 1;
        while (db.getSheetByName(archiveName) && db.getSheetByName(archiveName).getSheetId() !== target.getSheetId()) archiveName = base + ' ' + attempt++;
        props.setProperty(key, JSON.stringify(Object.assign({}, record, { sourceAvailable: false, archived: true, archivedName: archiveName })));
        if (target.getName() !== archiveName) target.setName(archiveName);
        report.archived.push(record.name);
      } catch (_) { report.errors.push(record.name + ': удаление общего состава требует проверки.'); }
    } else if (record && record.routed && !record.archived && record.sourceAvailable !== false) {
      props.setProperty(key, JSON.stringify(Object.assign({}, record, { sourceAvailable: false })));
      report.updated.push(record.name);
    }
  });
}

function readRitmCatalog_() {
  const catalog = new Map();
  const db = SpreadsheetApp.openById(RITM_CATALOG_ID);
  let photos = new Map();
  try { photos = readRitmPhotoMap_(); } catch (_) { /* Photo lookup must never block supply sync. */ }
  // Current visible catalog tabs only. Hidden catalog copies are excluded.
  ['OZON', 'WB'].forEach(name => {
    const sheet = db.getSheetByName(name);
    if (!sheet || sheet.isSheetHidden()) return;
    const values = sheet.getRange(1, 1, sheet.getLastRow(), Math.min(30, sheet.getLastColumn())).getValues();
    const headers = values[0].map(String);
    const at = label => headers.indexOf(label);
    values.slice(1).forEach(row => {
      const cell = label => {
        const value = at(label) < 0 ? '' : row[at(label)];
        return /^#(?:N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|ERROR!)/i.test(String(value)) ? '' : value;
      };
      // Column B of «OZON» is its explicit article alias (its header is empty).
      const aliases = [cell('Артикул'), name === 'OZON' ? row[1] : cell('Артикул (oz)')];
      const sheetCountIndex = at('Кол-во листов');
      const rawSheetCount = sheetCountIndex < 0 ? undefined : row[sheetCountIndex];
      // Existing FBO formula E = IF(D=""; pieces; pieces*D): blank means one sheet.
      // An absent column or an error/invalid value must remain unknown.
      const sheetCount = rawSheetCount === '' || rawSheetCount === null ? 1 : toNumberOrNull_(rawSheetCount);
      const record = { name: String(cell('Наименование') || cell('Название') || ''), type: String(cell('Вид') || cell('Вид товара') || ''),
        packNorm: toNumberOrNull_(cell('Норма упаковки, шт/чел')),
        sheetsPerUnit: sheetCount > 0 ? sheetCount : null,
        photoUrl: photos.get(String(aliases[0] || '').trim().toUpperCase()) || photos.get(String(aliases[1] || '').trim().toUpperCase()) || '', source: name };
      aliases.forEach(alias => {
        const aliasKey = String(alias || '').trim().toUpperCase();
        const key = name + '|' + aliasKey;
        if (aliasKey && !aliasKey.startsWith('#') && !catalog.has(key)) catalog.set(key, record);
      });
    });
  });
  return catalog;
}

function readRitmPhotoMap_() {
  const workbook = SpreadsheetApp.openById(RITM_PHOTOS_ID);
  const sheet = workbook.getSheetByName('Ссылки');
  if (!sheet || sheet.isSheetHidden() || sheet.getLastRow() < 2) return new Map();
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues();
  const photos = new Map();
  rows.forEach(row => {
    const sku = String(row[0] || '').trim().toUpperCase();
    const url = safeRitmPhotoUrl_(row[1]);
    if (sku && url && !photos.has(sku)) photos.set(sku, url);
  });
  return photos;
}

function safeRitmPhotoUrl_(value) {
  const url = String(value || '').trim();
  // Wildberries catalog photos use both basket.wbbasket.ru and mow-basket-cdn.geobasket.ru.
  // Keep the allowlist exact so arbitrary catalog URLs are never embedded.
  return url.length <= 2048 && /^https:\/\/(?:basket-\d+\.wbbasket\.ru|mow-basket-cdn-\d+\.geobasket\.ru)\/[A-Za-z0-9_./%-]+(?:\?[A-Za-z0-9_=&%-]*)?$/i.test(url) ? url : '';
}

function ritmItemRow_(shipmentId, name, sheetId, row, catalog) {
  const marketplace = labelMarketplace_('', name);
  const product = marketplace ? catalog.get(marketplace + '|' + row.sku.toUpperCase()) || {} : {};
  const positionId = shipmentId + '|' + (row.uid ? 'uid:' + row.uid : 'row:' + row.row) + '|' + row.sku;
  const quantity = row.quantity === null ? '' : row.quantity;
  return [shipmentId, 'ROLL', name, positionId, row.sku, product.name || '', product.type || '', '',
    product.packNorm > 0 ? product.packNorm : '', quantity, quantity, quantity, '', '', '', 'RITM_ROLL_PRINTING',
    sheetId, row.row, row.uid, product.source || '', new Date().toISOString(), safeRitmPhotoUrl_(product.photoUrl), product.sheetsPerUnit > 0 ? product.sheetsPerUnit : ''];
}

function assemblyShipments_(db) {
  if(!cartonRequestReads_)return assemblyShipmentsFresh_(db);
  const key=typeof db.getId==='function'?String(db.getId()):'request-db';
  if(cartonRequestReads_&&cartonRequestReads_.rosters[key])return cartonRequestReads_.rosters[key].map(row=>Object.assign({},row));
  const result=assemblyShipmentsFresh_(db);
  if(cartonRequestReads_)cartonRequestReads_.rosters[key]=result;
  return result;
}
function assemblyShipmentsFresh_(db) {
  const props = PropertiesService.getScriptProperties().getProperties();
  // Resolve the existing sheets once instead of making a separate lookup for
  // every shipment. The selected sheet is independently verified when read.
  const sheetIds = new Set(db.getSheets().map(sheet => Number(sheet.getSheetId())));
  const live = Object.keys(props).filter(key => key.indexOf(RITM_SYNC_PREFIX) === 0)
    .map(key => parseSyncJson_(props[key], null)).filter(row => row && !row.archived && !row.mergedIntoRoll && sheetIds.has(Number(row.sheetId)))
    .sort((a, b) => a.order - b.order)
    .map(row => ({ shipmentId: row.shipmentId, 'Название поставки': row.name, directionId: 'ROLL', 'Направление': row.name,
      sheetId: row.sheetId, environment: 'RITM', sourceAvailable: row.sourceAvailable, itemCount: Number.isSafeInteger(row.rows) ? row.rows : null,
      marker: row.marker || '',
      sourceUrl: 'https://docs.google.com/spreadsheets/d/' + (row.parts && row.parts[0] ? row.parts[0].documentId : RITM_PRINTING_ID) + '/edit#gid=' + row.sourceSheetId }));
  // Keep the old demo sheets/history intact, but never mix demo figures into this live selector.
  return live.concat([assemblyStockShipment_()]);
}

function getAssemblyOnlyItemIds(shipmentId) {
  if (isAssemblyStock_(shipmentId)) return [];
  const result = ritmControlApiRequest_('GET', '/api/assembly-only-items?shipmentId=' + encodeURIComponent(String(shipmentId || '')));
  if (!result || result.ok !== true || !Array.isArray(result.items)) throw new Error('Дополнительные товары временно недоступны.');
  return result.items.map(item => String(item.positionId || '')).sort();
}

// Mutation preflights need one verified position, not the complete enriched list.
// Manual additions still use the authoritative RITM registry and deletion guard.
function readShipmentItem_(db, shipment, positionId) {
  if (shipment.stockTask) return readAssemblyStockItems_().find(row => row.positionId === String(positionId)) || null;
  const id = String(positionId || '');
  if (shipment.environment !== 'RITM' || id.indexOf('|manual:') >= 0) {
    return readShipmentItems_(db, shipment).find(row => String(row.positionId) === id && String(row.shipmentId) === String(shipment.shipmentId) && String(row.directionId) === String(shipment.directionId)) || null;
  }
  const sheet = db.getSheetById(Number(shipment.sheetId));
  const sourceId = String(shipment.shipmentId).replace('RITM-ROLL-', '');
  if (!sheet || sheet.getRange(1, 1).getNote() !== (shipment.marker || RITM_SHEET_MARKER + sourceId)) throw new Error('Не удалось подтвердить источник позиций поставки.');
  const matches = readRowsByKey_(sheet, 'positionId', new Set([id])).filter(row => String(row.shipmentId) === String(shipment.shipmentId) && String(row.directionId) === String(shipment.directionId));
  if (matches.length > 1) throw new Error('Повторяется идентификатор позиции. Запись остановлена.');
  return matches[0] || null;
}

function readShipmentItems_(db, shipment, previewOnly) {
  if (shipment.stockTask) return readAssemblyStockItems_();
  if (shipment.environment !== 'RITM') return readTable_(db, TABLES.items);
  const sheet = db.getSheetById(Number(shipment.sheetId));
  const sourceSheetId = String(shipment.shipmentId).replace('RITM-ROLL-', '');
  if (!sheet || sheet.getRange(1, 1).getNote() !== (shipment.marker || RITM_SHEET_MARKER + sourceSheetId)) throw new Error('Не удалось подтвердить источник позиций поставки.');
  const base = readTable_(db, sheet.getName());
  // A preview is explicitly incomplete and cannot be used to record work.
  // Load additional Assembly-only items in the authoritative snapshot instead
  // of blocking the first paint on an external request.
  if (previewOnly === true) return base;
  const response = ritmControlApiRequest_('GET', '/api/assembly-only-items?shipmentId=' + encodeURIComponent(String(shipment.shipmentId)));
  if (!response || response.ok !== true || !Array.isArray(response.items) || response.items.length > 500)
    throw new Error('Не удалось проверить дополнительные товары для сборки. Обновите данные.');
  const market = labelMarketplace_('', shipment['Название поставки']);
  const cache = CacheService.getScriptCache();
  const products = new Map();
  let photos = null;
  const missing = [];
  response.items.forEach(item => {
    const key = market + '|' + String(item.article || '').toUpperCase();
    const cached = parseSyncJson_(cache.get('ritm.assembly.manual.product.v2.' + key), null);
    if (cached) products.set(key, cached); else missing.push(key);
  });
  if (missing.length) {
    let catalog = new Map();
    try { catalog = readRitmCatalog_(); } catch (_) { /* Product text may be unavailable independently. */ }
    try { photos = readRitmPhotoMap_(); } catch (_) { photos = new Map(); }
    missing.forEach(key => { const sku = key.slice(key.indexOf('|') + 1); const product = Object.assign({}, catalog.get(key) || {}); if (!product.photoUrl) product.photoUrl = photos.get(sku) || ''; products.set(key, product); if (product.name || product.type) cache.put('ritm.assembly.manual.product.v2.' + key, JSON.stringify(product), 60); });
  }
  const extra = response.items.filter(item => !PropertiesService.getScriptProperties().getProperty(assemblyOnlyTombstoneKey_(item.positionId))).map(item => {
    if (!item || String(item.shipmentId) !== String(shipment.shipmentId) || !/^[a-f0-9-]{36}$/i.test(String(item.id || '')) ||
        !/^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9._-]{0,79}$/i.test(String(item.article || '')) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
        String(item.positionId) !== String(shipment.shipmentId) + '|manual:' + item.id + '|' + item.article) throw new Error('Дополнительные товары не прошли проверку.');
    const product = products.get(market + '|' + String(item.article).toUpperCase()) || {};
    return {shipmentId:String(shipment.shipmentId),directionId:String(shipment.directionId),'Направление':String(shipment['Название поставки']),
      positionId:String(item.positionId),'Артикул':String(item.article),'Название товара':String(product.name || ''),'Вид товара':String(product.type || ''),
      'Норма упаковки, шт/чел':product.packNorm || '', 'Листов на штуку':product.sheetsPerUnit || '', 'Фото':safeRitmPhotoUrl_(product.photoUrl),
      'План порезки, шт':'','План сборки, шт':'','План упаковки, шт':item.quantity,'Источник':'RITM_ASSEMBLY_ONLY',
      assemblyOnlyComment:String(item.comment || '').slice(0,500),assemblyOnlyCreatedBy:String(item.createdBy || '').slice(0,120)};
  });
  return base.concat(extra);
}

function parseSyncJson_(text, fallback) {
  try { return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; }
}

function ritmFingerprint_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value)));
}

function ritmLiteral_(value) {
  // Do not turn article/catalog text into a formula when writing a derived sheet.
  return typeof value === 'string' && value.startsWith('=') ? "'" + value : value;
}

// Explicit transfers read the two production books and write only marked mirrors
// in the existing Assembly store. Source cells and WorkLog are never edited.
function ritmTransferConflict_(message) {
  const error = new Error(message); error.transferConflict = true; throw error;
}
function ritmTransferRowKey_(row) {
  return (row.uid ? 'uid:' + row.uid : 'row:' + row.row) + '|' + row.sku;
}
function appendRitmEventReceipt_(props, receipt) {
  const receipts = parseSyncJson_(props.getProperty(RITM_EVENT_RECEIPTS), []).filter(row => row.id !== receipt.id).slice(-39);
  receipts.push(receipt);
  while (receipts.length > 1 && encodeURIComponent(JSON.stringify(receipts)).replace(/%[A-F\d]{2}/gi, 'x').length > 7800) receipts.shift();
  props.setProperty(RITM_EVENT_RECEIPTS, JSON.stringify(receipts));
}
function ritmTransferFingerprint_(department, sheetId, name, manifest, rows) {
  return Array.from(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify([department, sheetId, name, manifest, rows]), Utilities.Charset.UTF_8))
    .map(value => ('0' + ((value + 256) % 256).toString(16)).slice(-2)).join('');
}
function readRitmTransferSource_(department, sheetId) {
  const documentId = department === 'roll' ? RITM_PRINTING_ID : department === 'box' ? RITM_BOX_PRINTING_ID : '';
  if (!documentId || !Number.isSafeInteger(sheetId) || sheetId < 0) ritmTransferConflict_('Не подтверждён источник передачи.');
  const book = SpreadsheetApp.openById(documentId), sheet = book.getSheetById(sheetId);
  if (!sheet || sheet.isSheetHidden()) ritmTransferConflict_('Источник удалён или скрыт.');
  let rows, manifest;
  try { rows = readRitmOrders_(sheet, ritmOrderColumns_(sheet)); manifest = ritmSupplyManifest_(sheet); }
  catch (_) { ritmTransferConflict_('Не подтверждены позиции или связь поставки.'); }
  rows = rows.map(row => Object.assign({}, row, { quantity: row.quantity > 1000000 ? null : row.quantity }));
  if (rows.some(row => row.sku.length > 120 || row.uid.length > 240 || row.sku.startsWith('#'))) ritmTransferConflict_('Неверные артикулы или UID источника.');
  const source = { department, sheetId, name: sheet.getName(), manifest, rows, sheet, book, documentId };
  source.fingerprint = ritmTransferFingerprint_(department, sheetId, source.name, manifest, rows);
  return source;
}
function ritmTransferIdentity_(source) {
  return source.department === 'roll' ? String(source.sheetId) : 'linked-RITM-BOX-' + source.sheetId;
}
function ritmTransferMirrorKeys_(target, sourceSheetId) {
  const values = target.getRange(1, 1, Math.max(1, target.getLastRow()), RITM_ITEM_HEADERS.length).getValues();
  if (RITM_ITEM_HEADERS.some((header, index) => values[0][index] !== header)) ritmTransferConflict_('Изменилась структура состава Assembly.');
  return values.slice(1).filter(row => row[4] && (sourceSheetId === undefined || String(row[16]) === String(sourceSheetId)))
    .map(row => ritmTransferRowKey_({ sku: String(row[4]), uid: String(row[18] || ''), row: Number(row[17]) }));
}
function selectedRitmTransferRows_(rows, target, sourceSheetId) {
  const keys = new Set(ritmTransferMirrorKeys_(target, sourceSheetId));
  const selected = rows.filter(row => keys.has(ritmTransferRowKey_(row)));
  if (selected.length !== keys.size) ritmTransferConflict_('Ранее переданные позиции изменились или удалены в источнике. Предыдущий состав сохранён.');
  return selected;
}
function ritmAssemblySheetHasHistory_(db, shipmentId) {
  const id = String(shipmentId || '');
  if (!id) return false;
  return [TABLES.workLog, TABLES.cartons, TABLES.cartonContents].some(name => {
    const sheet = db.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) return false;
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    const column = headers.indexOf('shipmentId');
    if (column < 0) return false;
    return sheet.getRange(2, column + 1, sheet.getLastRow() - 1, 1).getDisplayValues().some(row => String(row[0]) === id);
  });
}
function ritmIsStandaloneRollTarget_(source) {
  if (!source || source.department !== 'roll') return false;
  if (!source.manifest) return true;
  const manifest = source.manifest, part = manifest.parts && manifest.parts[0];
  return manifest.ready === true && manifest.parts.length === 1 && part.department === 'roll' &&
    part.documentId === RITM_PRINTING_ID && Number(part.sheetId) === Number(source.sheetId);
}
function ritmResolveRollMirror_(source, db, props, requestedSourceSheetId) {
  const rollSourceSheetId = requestedSourceSheetId !== undefined
    ? Number(requestedSourceSheetId)
    : source && source.department === 'roll' ? Number(source.sheetId) : null;
  if (!Number.isSafeInteger(rollSourceSheetId) || rollSourceSheetId < 0) return null;
  if (source && source.department === 'roll' && !ritmIsStandaloneRollTarget_(source)) {
    if (requestedSourceSheetId !== undefined) ritmTransferConflict_('Выбранный рулонный источник теперь входит в другую поставку.');
    return null;
  }
  const all = props.getProperties();
  const candidates = [];
  Object.keys(all).filter(key => key.indexOf(RITM_SYNC_PREFIX) === 0).forEach(key => {
    const record = parseSyncJson_(all[key], null);
    if (!record || record.archived || record.transferred || String(record.sourceSheetId || '') !== String(rollSourceSheetId)) return;
    const shipmentId = String(record.shipmentId || ''), legacy = /^RITM-ROLL-(\d+)$/.exec(shipmentId);
    const linked = /^RITM-SUPPLY-[a-f0-9-]{36}$/i.test(shipmentId);
    const identity = legacy ? legacy[1] : linked ? 'linked-' + shipmentId : '';
    const parts = record.parts;
    const validParts = Array.isArray(parts) && parts.length === 1 && parts[0].department === 'roll' &&
      parts[0].documentId === RITM_PRINTING_ID && String(parts[0].sheetId) === String(rollSourceSheetId);
    const validLegacyIdentity = legacy && String(legacy[1]) === String(rollSourceSheetId) &&
      (!parts || validParts);
    if (!identity || key !== RITM_SYNC_PREFIX + identity || !(validLegacyIdentity || (linked && validParts))) return;
    const sourceId = String(record.sourceSheetId || '');
    const target = db.getSheetById(Number(record.sheetId));
    const marker = RITM_SHEET_MARKER + identity;
    if (!/^\d+$/.test(sourceId) || String(sourceId) !== String(rollSourceSheetId) || !target ||
        !String(record.name || '').trim() || target.getName() !== record.name ||
        (record.marker && record.marker !== marker) || target.getRange(1, 1).getNote() !== marker) return;
    candidates.push({ key, record, sourceSheetId: Number(sourceId), target, shipmentId: record.shipmentId, name: record.name, marker });
  });
  if (requestedSourceSheetId !== undefined && candidates.length !== 1)
    ritmTransferConflict_('Не удалось подтвердить выбранную рулонную поставку в Assembly. Сначала обновите её состав.');
  if (candidates.length > 1) ritmTransferConflict_('Найдено несколько возможных рулонных поставок. Объединение остановлено.');
  return candidates[0] || null;
}
function ritmMergedBoxSourceIds_(props, rollSourceSheetId) {
  const result = new Set();
  const all = props.getProperties();
  Object.keys(all).filter(key => key.indexOf(RITM_SYNC_PREFIX) === 0).forEach(key => {
    const record = parseSyncJson_(all[key], null);
    if (record && record.transferred && record.mergedIntoRoll && !record.archived &&
        String(record.mergedRollSourceSheetId) === String(rollSourceSheetId)) result.add(String(record.sourceSheetId));
  });
  return result;
}
function ritmMergedBoxRowsForRoll_(target, props, rollSourceSheetId) {
  const sourceIds = ritmMergedBoxSourceIds_(props, rollSourceSheetId);
  if (!target || !sourceIds.size || target.getLastRow() < 2 || target.getMaxColumns() < RITM_ITEM_HEADERS.length + 2) return [];
  const width = RITM_ITEM_HEADERS.length + 2;
  const values = target.getRange(1, 1, target.getLastRow(), width).getValues();
  if (RITM_ITEM_HEADERS.some((header, index) => values[0][index] !== header) ||
      values[0][RITM_ITEM_HEADERS.length] !== 'Отдел производства' ||
      values[0][RITM_ITEM_HEADERS.length + 1] !== 'Документ производства')
    ritmTransferConflict_('Не удалось подтвердить объединённый состав Assembly.');
  return values.slice(1).filter(row => row[4] && sourceIds.has(String(row[16])) && String(row[RITM_ITEM_HEADERS.length]) === 'Бокс')
    .map(row => row.slice(0, width));
}
function archiveRitmTransferMirror_(target, name, expectedMarker) {
  if (!target || target.getRange(1, 1).getNote() !== expectedMarker) return;
  const suffix = ' · архив переноса ' + target.getSheetId();
  const base = String(name || target.getName()).slice(0, 99 - suffix.length) + suffix;
  let archiveName = base, attempt = 1;
  while (target.getParent().getSheetByName(archiveName) && target.getParent().getSheetByName(archiveName).getSheetId() !== target.getSheetId()) archiveName = base + ' ' + attempt++;
  if (target.getName() !== archiveName) target.setName(archiveName);
}
function syncRitmTransferMirror_(source, keys, db, props, catalog, startedAt, force, requestedRollMirror) {
  const identity = ritmTransferIdentity_(source), key = RITM_SYNC_PREFIX + identity, marker = RITM_SHEET_MARKER + identity;
  const prior = parseSyncJson_(props.getProperty(key), null);
  if (prior && prior.routed) ritmTransferConflict_('Лист уже входит в общую поставку RITM. Обновите список источников.');
  let rollMirror = requestedRollMirror || null;
  if (source.department === 'box' && prior && prior.mergedRollSourceSheetId && !rollMirror)
    rollMirror = ritmResolveRollMirror_(source, db, props, Number(prior.mergedRollSourceSheetId));
  if (source.department === 'box' && rollMirror && prior && prior.mergedRollSourceSheetId &&
      String(prior.mergedRollSourceSheetId) !== String(rollMirror.sourceSheetId))
    ritmTransferConflict_('Эта часть уже присоединена к другой поставке Assembly.');
  const oldMirror = prior && db.getSheetById(Number(prior.sheetId));
  let target = rollMirror ? rollMirror.target : oldMirror;
  let name = rollMirror ? rollMirror.name : prior && prior.name || source.name;
  let targetMarker = rollMirror ? rollMirror.marker : prior && (prior.targetMarker || prior.marker) || marker;
  const priorMarker = prior && (prior.sourceMirrorMarker || prior.marker);
  if (rollMirror && oldMirror && oldMirror.getSheetId() !== target.getSheetId() &&
      oldMirror.getRange(1, 1).getNote() !== priorMarker)
    ritmTransferConflict_('Старую вкладку Assembly не удалось подтвердить. Объединение остановлено.');
  if (!target) {
    target = db.getSheetByName(name);
    if (target && target.getRange(1, 1).getNote() !== marker && source.department === 'box' && !prior) {
      name = source.name.slice(0, 92) + ' · Бокс'; target = db.getSheetByName(name);
    }
  }
  if (target && target.getRange(1, 1).getNote() !== targetMarker) ritmTransferConflict_('Название Assembly занято другой поставкой.');
  if (prior && !target) ritmTransferConflict_('Ранее созданный состав Assembly отсутствует. Требуется сверка.');
  const previousKeys = target && target.getLastRow() ? new Set(ritmTransferMirrorKeys_(target, rollMirror ? source.sheetId : undefined)) : new Set();
  const selectedKeys = new Set(keys), desired = new Set([...previousKeys, ...selectedKeys]);
  const rows = source.rows.filter(row => desired.has(ritmTransferRowKey_(row)));
  if (rows.length !== desired.size || rows.some(row => row.quantity === null)) ritmTransferConflict_('Передаваемые или уже переданные позиции изменились. Проверьте источник.');
  const fingerprint = ritmFingerprint_([name, rows]);
  const result = { name, added: rows.filter(row => !previousKeys.has(ritmTransferRowKey_(row))).length,
    existing: rows.filter(row => selectedKeys.has(ritmTransferRowKey_(row)) && previousKeys.has(ritmTransferRowKey_(row))).length };
  if (target && prior && prior.fingerprint === fingerprint && !force && startedAt - Number(prior.catalogAt || 0) < 900000) {
    if (prior.sourceAvailable === false) props.setProperty(key, JSON.stringify(Object.assign({}, prior, { sourceAvailable: true })));
    return result;
  }
  const isNew = !target;
  if (!target) { target = db.insertSheet(name); target.getRange(1, 1).setNote(marker); targetMarker = marker; }
  const shipmentId = 'RITM-' + (source.department === 'box' ? 'BOX-' : 'ROLL-') + source.sheetId;
  const headers = RITM_ITEM_HEADERS.concat(['Отдел производства', 'Документ производства']);
  const actualShipmentId = rollMirror ? rollMirror.shipmentId : shipmentId;
  const rollKey = rollMirror ? rollMirror.key : null;
  const rollRecord = rollMirror ? parseSyncJson_(props.getProperty(rollKey), null) : null;
  if (rollMirror && (!rollRecord || Number(rollRecord.sheetId) !== target.getSheetId()))
    ritmTransferConflict_('Основная поставка изменилась во время объединения.');
  if (target.getMaxColumns() < headers.length) target.insertColumnsAfter(target.getMaxColumns(), headers.length - target.getMaxColumns());
  const retainedRows = rollMirror && target.getLastRow() > 1
    ? target.getRange(2, 1, target.getLastRow() - 1, headers.length).getValues()
        .filter(row => row[4] && String(row[16]) !== String(source.sheetId)).map(row => row.slice(0, headers.length))
    : [];
  const addedRows = rows.map(row => {
    const item = ritmItemRow_(actualShipmentId, name, source.sheetId, row, catalog());
    if (source.department === 'box') item[3] = actualShipmentId + '|box:' + source.sheetId + '|' + ritmTransferRowKey_(row);
    item[15] = source.department === 'box' ? 'RITM_BOX_PRINTING' : 'RITM_ROLL_PRINTING';
    item.push(source.department === 'box' ? 'Бокс' : 'Рулонная печать', source.documentId);
    return item;
  });
  const values = [headers].concat(retainedRows, addedRows).map(row => row.map(ritmLiteral_));
  if (target.getMaxRows() < values.length) target.insertRowsAfter(target.getMaxRows(), values.length - target.getMaxRows());
  const oldRows = target.getLastRow();
  target.getRange(1, 1, values.length, headers.length).setValues(values);
  if (oldRows > values.length) target.getRange(values.length + 1, 1, oldRows - values.length, headers.length).clearContent();
  if (isNew) { target.setFrozenRows(1); target.getRange(1, 1, 1, headers.length).setBackground('#14293d').setFontColor('#ffffff').setFontWeight('bold'); }
  SpreadsheetApp.flush();
  const actual = target.getRange(1, 1, values.length, headers.length).getValues();
  if (actual.some((row, i) => row.some((cell, c) => String(cell) !== String(values[i][c])))) throw new Error('Состав Assembly ожидает повторной проверки.');
  const nextRecord = { shipmentId: actualShipmentId, name, sheetId: target.getSheetId(), sourceSheetId: source.sheetId,
    marker: targetMarker, targetMarker, sourceMirrorMarker: priorMarker || marker,
    transferred: source.department === 'box', transferSelection: prior ? !!prior.transferSelection : true,
    parts: [{ department: source.department, documentId: source.documentId, sheetId: source.sheetId }],
    rows: rows.length, sourceAvailable: true, fingerprint, order: prior ? prior.order : 2000 + source.sheetId,
    ...(rollMirror ? { mergedIntoRoll: true, mergedRollSourceSheetId: rollMirror.sourceSheetId } : {}),
    syncedAt: new Date().toISOString(), catalogAt: startedAt };
  props.setProperty(key, JSON.stringify(nextRecord));
  if (rollMirror) {
    props.setProperty(rollKey, JSON.stringify(Object.assign({}, rollRecord, { rows: values.length - 1 })));
    if (oldMirror && oldMirror.getSheetId() !== target.getSheetId()) archiveRitmTransferMirror_(oldMirror, prior.name, priorMarker);
  }
  ensureShipmentBoxViewBestEffort_(db, { shipmentId: actualShipmentId, 'Название поставки': name });
  return { name, added: rows.filter(row => !previousKeys.has(ritmTransferRowKey_(row))).length,
    existing: rows.filter(row => selectedKeys.has(ritmTransferRowKey_(row)) && previousKeys.has(ritmTransferRowKey_(row))).length };
}
// A formerly explicit box transfer can become part of the same committed
// multi-department supply. Its old registry pointer then remains as an audit,
// not as a second synchronizer competing with the canonical supply.
function retireSupersededRitmBoxTransfer_(source, prior, key, db, props, startedAt) {
  const manifest = source.manifest;
  if (!manifest || manifest.ready !== true || !prior.mergedIntoRoll) return false;
  const legacy = /^RITM-ROLL-(\d+)$/.exec(manifest.id);
  const identity = legacy ? legacy[1] : 'linked-' + manifest.id;
  const canonicalKey = RITM_SYNC_PREFIX + identity;
  if (key === canonicalKey) return false;
  const canonical = parseSyncJson_(props.getProperty(canonicalKey), null);
  const roll = manifest.parts.find(part => part.department === 'roll');
  const box = manifest.parts.find(part => part.department === 'box');
  if (!canonical || !canonical.routed || canonical.archived || canonical.sourceAvailable !== true ||
      canonical.shipmentId !== manifest.id || prior.shipmentId !== manifest.id ||
      canonical.manifestRevision !== manifest.revision ||
      JSON.stringify(canonical.parts) !== JSON.stringify(manifest.parts) ||
      Number(canonical.sheetId) !== Number(prior.sheetId) ||
      !roll || Number(prior.mergedRollSourceSheetId) !== Number(roll.sheetId) ||
      !box || box.documentId !== source.documentId || Number(box.sheetId) !== Number(source.sheetId)) return false;
  const target = db.getSheetById(Number(canonical.sheetId));
  if (!target || !canonical.marker || target.getRange(1, 1).getNote() !== canonical.marker) return false;
  props.setProperty(key, JSON.stringify(Object.assign({}, prior, {
    archived: true, sourceAvailable: false, supersededBy: canonical.shipmentId,
    supersededAt: new Date(startedAt).toISOString(),
  })));
  return true;
}
function syncRitmTransferredBoxSupplies_(db, props, report, catalog, startedAt, force) {
  const all = props.getProperties();
  Object.keys(all).filter(key => key.indexOf(RITM_SYNC_PREFIX) === 0).forEach(key => {
    const prior = parseSyncJson_(all[key], null);
    if (!prior || !prior.transferred || prior.archived) return;
    try {
      const source = readRitmTransferSource_('box', Number(prior.sourceSheetId));
      if (source.manifest) {
        if (retireSupersededRitmBoxTransfer_(source, prior, key, db, props, startedAt)) return;
        ritmTransferConflict_('Источник теперь связан с общей поставкой; требуется сверка.');
      }
      let rollMirror = null;
      if (prior.mergedRollSourceSheetId) rollMirror = ritmResolveRollMirror_(source, db, props, Number(prior.mergedRollSourceSheetId));
      else rollMirror = ritmResolveRollMirror_(source, db, props);
      if (rollMirror && prior.shipmentId !== rollMirror.shipmentId && ritmAssemblySheetHasHistory_(db, prior.shipmentId))
        ritmTransferConflict_('В отдельной поставке бокса уже есть работа или короба. Объединение остановлено, история сохранена.');
      const target = rollMirror ? rollMirror.target : db.getSheetById(Number(prior.sheetId));
      const marker = rollMirror ? rollMirror.marker : prior.targetMarker || prior.marker;
      if (!target || target.getRange(1, 1).getNote() !== marker) throw new Error('Не подтверждён состав Assembly.');
      const keyTarget = rollMirror && !prior.mergedIntoRoll ? db.getSheetById(Number(prior.sheetId)) : target;
      const keyMarker = rollMirror && !prior.mergedIntoRoll ? prior.targetMarker || prior.marker : marker;
      if (!keyTarget || keyTarget.getRange(1, 1).getNote() !== keyMarker) throw new Error('Не подтверждена исходная вкладка бокса.');
      const result = syncRitmTransferMirror_(source, ritmTransferMirrorKeys_(keyTarget, source.sheetId), db, props, catalog, startedAt, force, rollMirror);
      if (JSON.stringify(prior) !== props.getProperty(key)) report.updated.push(result.name);
    } catch (error) {
      if (error && error.transferConflict) {
        report.errors.push(prior.name + ': ' + String(error.message || 'Объединение остановлено.').slice(0, 240));
        return;
      }
      props.setProperty(key, JSON.stringify(Object.assign({}, prior, { sourceAvailable: false })));
      report.errors.push(prior.name + ': источник передачи временно не подтверждён; предыдущий состав сохранён.');
    }
  });
}
function receiveRitmAssemblyTransfer_(event) {
  const transfer = event.transfer;
  const transferKeys = transfer && Object.keys(transfer).sort().join(',');
  const baseTransferKeys = 'department,fingerprint,keys,name,parts,sheetId';
  const mergeTransferKeys = baseTransferKeys + ',targetRollFingerprint,targetRollSheetId';
  if (!transfer || ![baseTransferKeys, mergeTransferKeys].includes(transferKeys) ||
      !Array.isArray(transfer.keys) || !transfer.keys.length || transfer.keys.length > 500 || new Set(transfer.keys).size !== transfer.keys.length ||
      transfer.keys.some(key => typeof key !== 'string' || key.length > 400) || !/^[a-f0-9]{64}$/.test(transfer.fingerprint || '') ||
      !Array.isArray(transfer.parts) || !transfer.parts.length || transfer.parts.length > 2 ||
      (transferKeys === mergeTransferKeys && (transfer.department !== 'box' || !Number.isSafeInteger(transfer.targetRollSheetId) || transfer.targetRollSheetId <= 0 || !/^[a-f0-9]{64}$/.test(transfer.targetRollFingerprint || ''))))
    return { ok: false, status: 'conflict', eventId: event.eventId };
  const props = PropertiesService.getScriptProperties(), lock = LockService.getScriptLock(), at = Date.now();
  if (!lock.tryLock(1000)) return { ok: false, status: 'pending', eventId: event.eventId };
  const previous = parseSyncJson_(props.getProperty(RITM_SYNC_STATE), {}), syncId = Utilities.getUuid();
  try {
    if (previous.status === 'running' && at - Number(previous.startedAt || 0) < 420000) return { ok: false, status: 'pending', eventId: event.eventId };
    props.setProperty(RITM_SYNC_STATE, JSON.stringify({ status: 'running', syncId, startedAt: at, errors: [] }));
  } finally { lock.releaseLock(); }
  const report = { status: 'running', syncId, startedAt: at, at: new Date().toISOString(), created: [], updated: [], archived: [], errors: [] };
  let result;
  try {
    const source = readRitmTransferSource_(transfer.department, transfer.sheetId);
    if (source.name !== transfer.name || source.fingerprint !== transfer.fingerprint) ritmTransferConflict_('Источник изменился после подтверждения.');
    const selected = source.rows.filter(row => transfer.keys.includes(ritmTransferRowKey_(row)));
    if (selected.length !== transfer.keys.length || selected.some(row => row.quantity === null)) ritmTransferConflict_('Выбранные позиции не подтверждены.');
    const expectedParts = source.manifest ? source.manifest.parts : [{ department: source.department, sheetId: source.sheetId }];
    if (transfer.parts.length !== expectedParts.length) ritmTransferConflict_('Изменились участки поставки.');
    const seen = new Set();
    transfer.parts.forEach(part => {
      if (!part || Object.keys(part).sort().join(',') !== 'department,fingerprint,sheetId' || seen.has(part.department) || !expectedParts.some(p => p.department === part.department && p.sheetId === part.sheetId)) ritmTransferConflict_('Не подтверждены участки поставки.');
      seen.add(part.department);
      const current = part.department === source.department && part.sheetId === source.sheetId ? source : readRitmTransferSource_(part.department, part.sheetId);
      if (current.fingerprint !== part.fingerprint || JSON.stringify(current.manifest) !== JSON.stringify(source.manifest) || (source.manifest && current.rows.some(row => row.quantity === null))) ritmTransferConflict_('Состав участков изменился.');
    });
    const db = SpreadsheetApp.openById(DB_ID);
    let requestedRollMirror = null;
    if (transfer.targetRollSheetId !== undefined) {
      const rollSource = readRitmTransferSource_('roll', transfer.targetRollSheetId);
      if (source.manifest || !ritmIsStandaloneRollTarget_(rollSource) || rollSource.name !== source.name || rollSource.fingerprint !== transfer.targetRollFingerprint)
        ritmTransferConflict_('Рулонная поставка изменилась или не совпадает с выбранной. Подготовьте передачу заново.');
      requestedRollMirror = ritmResolveRollMirror_(rollSource, db, props, transfer.targetRollSheetId);
      const priorBox = parseSyncJson_(props.getProperty(RITM_SYNC_PREFIX + ritmTransferIdentity_(source)), null);
      if (priorBox && priorBox.shipmentId !== requestedRollMirror.shipmentId && ritmAssemblySheetHasHistory_(db, priorBox.shipmentId))
        ritmTransferConflict_('В отдельной поставке бокса уже есть работа или короба. История должна быть сверена перед объединением.');
    }
    let catalog; const loadCatalog = () => { if (!catalog) catalog = readRitmCatalog_(); return catalog; };
    if (source.manifest) {
      if (!source.manifest.ready || selected.length !== source.rows.length) ritmTransferConflict_('Общая поставка передаётся целиком после подтверждения участков.');
      const legacy = /^RITM-ROLL-(\d+)$/.exec(source.manifest.id);
      const key = RITM_SYNC_PREFIX + (legacy ? legacy[1] : 'linked-' + source.manifest.id);
      const prior = parseSyncJson_(props.getProperty(key), null);
      const target = prior && db.getSheetById(Number(prior.sheetId));
      const before = target ? ritmTransferMirrorKeys_(target).length : 0;
      const rollBook = source.department === 'roll' ? source.book : transfer.parts.some(part => part.department === 'roll') ? SpreadsheetApp.openById(RITM_PRINTING_ID) : null;
      syncRitmDepartmentSupplies_(rollBook, db, props, report, loadCatalog, at, true, null, new Map(), source.manifest.id, transfer.parts);
      const after = parseSyncJson_(props.getProperty(key), null);
      if (report.errors.length || !after || !after.sourceAvailable) throw new Error('Общий состав ещё не подтверждён.');
      result = { name: after.name, added: Math.max(0, after.rows - before), existing: Math.min(before, after.rows) };
    } else {
      result = syncRitmTransferMirror_(source, transfer.keys, db, props, loadCatalog, at, true, requestedRollMirror);
      report.updated.push(result.name);
    }
    result = Object.assign({ ok: true, status: 'synced', eventId: event.eventId }, result);
    report.status = 'current';
  } catch (error) {
    result = { ok: false, status: error.transferConflict ? 'conflict' : 'pending', eventId: event.eventId,
      message: error.transferConflict ? String(error.message || 'Передача остановлена: источник не подтверждён.').slice(0, 240) : undefined };
    report.status = error.transferConflict ? (previous.status === 'current' ? 'current' : 'not_checked') : 'partial';
    if (!error.transferConflict) report.errors.push('Передача в Assembly ожидает повторной проверки.');
  } finally {
    const finishLock = LockService.getScriptLock(); finishLock.waitLock(5000);
    try {
      if (parseSyncJson_(props.getProperty(RITM_SYNC_STATE), {}).syncId === syncId) {
        report.finishedAt = new Date().toISOString(); report.durationMs = Date.now() - at;
        if (result && result.ok) {
          report.dataVersion = bumpDataVersion_();
          appendRitmEventReceipt_(props, { id: event.eventId, at: Date.now(), result });
        }
        props.setProperty(RITM_SYNC_STATE, JSON.stringify(report));
      }
    } finally { finishLock.releaseLock(); }
  }
  return result;
}


// Warehouse production jobs retain their source UID after production archival.
// They use the existing WorkLog and carton journals, never copied work facts.
function isAssemblyStock_(id) { return String(id || '') === 'RITM-STOCK-WAREHOUSE'; }
function assemblyStockShipment_() {
  return {shipmentId:'RITM-STOCK-WAREHOUSE','Название поставки':'OZON · Запасы склад',directionId:'ROLL',
    'Направление':'OZON · Запасы склад',environment:'RITM',sourceAvailable:true,stockTask:true,marketplace:'OZON',sourceUrl:'',sheetId:null};
}
let assemblyStockRequest_ = null;
function readAssemblyStockItems_() {
  if (assemblyStockRequest_) return assemblyStockRequest_;
  const result = ritmControlApiRequest_('GET','/api/assembly-stocks');
  if (!result || result.ok !== true || !isAssemblyStock_(result.shipmentId) || result.destination !== 'warehouse' ||
      result.marketplace !== 'OZON' || !Array.isArray(result.items) || result.items.length > 1500)
    throw new Error('Задания запасов не подтверждены. Обновите данные перед записью работы.');
  const seen = new Set();
  result.items.forEach(item => {
    const expected = 'RITM-STOCK-WAREHOUSE|uid:' + item.department + ':' + item.documentId + ':' + item.sheetId + ':' + item.uid + '|' + item.article;
    if (!['box','roll'].includes(item.department) || !item.uid || !item.documentId || !Number.isSafeInteger(item.sheetId) ||
        !/^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9._-]{0,119}$/i.test(String(item.article || '')) ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.positionId !== expected || seen.has(expected))
      throw new Error('Не подтверждена позиция запасов. Запись остановлена.');
    seen.add(expected);
  });
  const cache = CacheService.getScriptCache(), products = new Map(), missing = [];
  result.items.forEach(item => {
    const key = 'OZON|' + item.article.toUpperCase();
    const saved = parseSyncJson_(cache.get('ritm.assembly.manual.product.v2.' + key), null);
    if (saved) products.set(key,saved); else missing.push(key);
  });
  if (missing.length) {
    let catalog = new Map(), photos = new Map();
    try { catalog=readRitmCatalog_(); } catch (_) { /* Optional product text never hides a job. */ }
    try { photos=readRitmPhotoMap_(); } catch (_) {}
    Array.from(new Set(missing)).forEach(key => {
      const product=Object.assign({},catalog.get(key)||{});
      if (!product.photoUrl) product.photoUrl=photos.get(key.slice(5))||'';
      products.set(key,product);
      if (product.name || product.type) cache.put('ritm.assembly.manual.product.v2.'+key,JSON.stringify(product),60);
    });
  }
  assemblyStockRequest_ = result.items.map(item => {
    const product=products.get('OZON|'+item.article.toUpperCase())||{};
    return {shipmentId:result.shipmentId,directionId:'ROLL','Направление':'OZON · Запасы склад',positionId:item.positionId,
      'Артикул':item.article,'Название товара':product.name||'','Вид товара':product.type||'',
      'Норма упаковки, шт/чел':product.packNorm||'','Листов на штуку':product.sheetsPerUnit||'',
      'Фото':safeRitmPhotoUrl_(product.photoUrl),'План порезки, шт':item.quantity,'План сборки, шт':item.quantity,
      'План упаковки, шт':item.quantity,'Источник':'RITM_WAREHOUSE_STOCK',sourceUid:item.uid,
      stockTask:true,productionDepartment:item.department,productionPrint:item.print,productionCut:item.cut,
      productionArchivedAt:item.archivedAt||''};
  });
  return assemblyStockRequest_;
}
