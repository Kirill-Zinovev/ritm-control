const ASSEMBLY_DB_PROPERTY = 'RITM_ASSEMBLY_DB_ID';
const LABEL_FBO_PROPERTY = 'RITM_LABEL_FBO_ID';
const LABEL_OZON_CODES_PROPERTY = 'RITM_LABEL_OZON_CODES_ID';
function requiredSpreadsheetId_(propertyName) {
  const value = PropertiesService.getScriptProperties().getProperty(propertyName);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(String(value || ''))) {
    throw new Error('Не настроено свойство Apps Script: ' + propertyName);
  }
  return value;
}
function openAssemblyDatabase_() {
  return SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
}
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
  if (!/^[a-f0-9]{64}$/i.test(secret || '') || !event ||
      Object.keys(event).sort().join(',') !== (event.action === 'transfer' ? 'action,eventId,issuedAt,transfer,v' : 'action,eventId,issuedAt,v') ||
      event.v !== 1 || !['reconcile', 'transfer'].includes(event.action) || !/^[a-f0-9-]{36}$/i.test(event.eventId || '') ||
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

// Return the already-synchronized composition first. The browser can paint the
// shipment immediately, then request authoritative work, carton and norm facts.
function getAssemblyPreview(shipmentId) {
  const props = PropertiesService.getScriptProperties();
  const sync = parseSyncJson_(props.getProperty(RITM_SYNC_STATE), null);
  if (!sync) throw new Error('Сначала обновите состав поставки.');
  const db = openAssemblyDatabase_();
  const shipments = assemblyShipments_(db);
  const activeShipment = (shipmentId ? shipments.find(row => String(row.shipmentId) === String(shipmentId)) : null) || shipments[0];
  const readVersion = getDataVersion();
  if (!activeShipment) return {
    version: 'ritm-supply-sync-1', environment: 'RITM', sync, dataVersion: readVersion,
    updatedAt: new Date().toISOString(), shipments: [], shipment: null,
    operations: Object.keys(OPERATION_LABELS).map(id => ({ id, name: OPERATION_LABELS[id] })),
    employees: [], employeeShift: null, items: [], referenceIncomplete: true,
  };
  const rows = readShipmentItems_(db, activeShipment)
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
      productType: String(row['Вид товара'] || ''), boxType: '', unitsPerBox: null,
      boxNormError: '', photoAssetKey: String(row.photoAssetKey || ''),
      photoUrl: safeRitmPhotoUrl_(row['Фото']), sheetsPerUnit: toNumberOrNull_(row['Листов на штуку']),
      packNormPerPerson: toNumberOrNull_(row['Норма упаковки, шт/чел']),
      boxCountSnapshot: null, boxNumbersSnapshot: [], cartonsSnapshot: null,
      boxedQtySnapshot: null, unboxedQtySnapshot: null, source: String(row['Источник'] || ''),
      workFactsAvailable: false, operations, workers: [], workRecords: [],
      packingRemaining: null, packingOverBy: null, status: 'Проверяем…',
      label: { status: 'not_checked' },
    };
  });
  const marketplace = labelMarketplace_(activeShipment.marketplace || activeShipment['Маркетплейс'], activeShipment['Название поставки']);
  return {
    version: 'ritm-supply-sync-1', environment: 'RITM', sync, dataVersion: readVersion,
    referenceKey: '', updatedAt: new Date().toISOString(), referenceIncomplete: true,
    shipments: shipments.map(row => ({ id: String(row.shipmentId), name: String(row['Название поставки']), environment: row.environment, sourceAvailable: row.sourceAvailable !== false, itemCount: Number.isSafeInteger(row.itemCount) ? row.itemCount : null })),
    shipment: {
      id: String(activeShipment.shipmentId), name: String(activeShipment['Название поставки'] || ''),
      directionId: String(activeShipment.directionId), direction: String(activeShipment['Направление'] || ''),
      sourceUrl: activeShipment.sourceUrl || '',
      assemblyUrl: activeShipment.sheetId ? 'https://docs.google.com/spreadsheets/d/' + requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY) + '/edit#gid=' + activeShipment.sheetId : '',
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

function getAssemblySnapshot_(shipmentId, forceSync, progressOnly) {
  // Switching shipments should read only the local assembly mirror. The owner-installed
  // one-minute trigger keeps that mirror fresh; a manual refresh may force a source scan.
  const props = PropertiesService.getScriptProperties();
  // Capture the version before reading ranges. A write that races this snapshot then
  // remains visible to the next cheap version poll instead of being marked as included.
  const readVersion = getDataVersion();
  const savedSync = parseSyncJson_(props.getProperty(RITM_SYNC_STATE), null);
  if (progressOnly && !savedSync) throw new Error('Сначала обновите состав поставки.');
  const sync = forceSync === true || !savedSync
    ? syncRitmSupplies(forceSync === true)
    : savedSync;
  const db = openAssemblyDatabase_();
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
      boxedQtySnapshot: boxSummary === null ? toNumberOrNull_(row['В коробах, шт · срез']) : (boxSummary.quantity ? boxSummary.quantity : null),
      unboxedQtySnapshot: boxSummary === null ? toNumberOrNull_(row['Не распределено, шт · срез']) : (boxSummary.quantity && packingPlan !== null ? Math.max(0, packingPlan - boxSummary.quantity) : null),
      source: String(row['Источник'] || ''),
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
    shipments: shipments.map(row => ({ id: String(row.shipmentId), name: String(row['Название поставки']), environment: row.environment, sourceAvailable: row.sourceAvailable !== false, itemCount: Number.isSafeInteger(row.itemCount) ? row.itemCount : null })),
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
      cartonsSnapshot: item.cartonsSnapshot, boxedQtySnapshot: item.boxedQtySnapshot,
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
    shipments: shipments.map(row => ({ id: String(row.shipmentId), name: String(row['Название поставки']), environment: row.environment, sourceAvailable: row.sourceAvailable !== false, itemCount: Number.isSafeInteger(row.itemCount) ? row.itemCount : null })),
    shipment: {
      id: String(activeShipment.shipmentId),
      name: String(activeShipment['Название поставки'] || ''),
      directionId: String(activeShipment.directionId),
      direction: String(activeShipment['Направление'] || ''),
      sourceUrl: activeShipment.sourceUrl || '',
      assemblyUrl: activeShipment.sheetId ? 'https://docs.google.com/spreadsheets/d/' + requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY) + '/edit#gid=' + activeShipment.sheetId : '',
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

function labelIndex_(marketplace) {
  const cache = CacheService.getScriptCache();
  const key = LABEL_CACHE_PREFIX + marketplace;
  const manifest = cache.get(key + '.manifest');
  if (manifest) {
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
  const ss = SpreadsheetApp.openById(requiredSpreadsheetId_(LABEL_FBO_PROPERTY));
  const labelSheet = ss.getSheetByName(marketplace === 'WB' ? 'Этикетки WB' : 'Этикетки OZON');
  if (!labelSheet) throw new Error('Лист этикеток не найден.');
  const labels = Object.create(null);
  readLabelPairs_(labelSheet).forEach(pair => addLabelCandidate_(labels, pair[0], pair[1], marketplace));
  if (marketplace === 'OZON') {
  const codes = SpreadsheetApp.openById(requiredSpreadsheetId_(LABEL_OZON_CODES_PROPERTY)).getSheetByName('Коды');
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
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
  const shipment = assemblyShipments_(db).find(row => String(row.shipmentId) === String(shipmentId) && String(row.directionId) === String(directionId));
  if (!shipment || shipment.sourceAvailable === false) throw new Error('Поставка недоступна. Обновите её и повторите.');
  const ids = Array.from(new Set((Array.isArray(positionIds) ? positionIds : []).map(value => String(value || '').trim()).filter(Boolean)));
  if (!ids.length || ids.length > 150) throw new Error('Выберите от 1 до 150 артикулов для печати.');
  const items = readShipmentItems_(db, shipment).filter(row => row.shipmentId === shipment.shipmentId && row.directionId === shipment.directionId && ids.includes(String(row.positionId)));
  if (items.length !== ids.length) throw new Error('Часть выбранных артикулов не относится к этой поставке. Обновите список.');
  const marketplace = labelMarketplace_(shipment.marketplace, shipment['Название поставки']);
  if (!marketplace) throw new Error('Не удалось однозначно определить Ozon или Wildberries по поставке.');
  const index = labelIndex_(marketplace);
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
    if (!totals[positionId]) totals[positionId] = { boxes: new Set(), quantity: 0, byCarton: Object.create(null) };
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
    if (cartonMatchesShipment_(carton, shipment)) cartonsById[String(carton.cartonId)] = carton;
  });
  const contents = normalizeCartonContents_(readRowsByKey_(contentsSheet, 'cartonId', cartonIds));
  const normsBySku = cachedBoxNormsForSkus_(contents.map(row => row['Артикул']), shipmentMarketplace_(shipment));
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
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
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
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
  const shipment = assemblyShipments_(db).find(row => String(row.shipmentId) === String(payload.shipmentId));
  if (!shipment || shipment.sourceAvailable === false) throw new Error('Источник поставки недоступен. Обновите список перед записью.');
  const item = readShipmentItems_(db, shipment).find(row =>
    String(row.positionId) === String(payload.positionId) &&
    String(row.shipmentId) === String(payload.shipmentId) &&
    String(row.directionId) === String(payload.directionId)
  );
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
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
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
function getBoxesForItem(shipmentId, directionId, positionId) {
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
  const context = boxItemContext_(db, shipmentId, directionId, positionId);
  const sheets = getBoxTableSheets_(db);
  const cartons = readOpenCartonsForShipment_(sheets.cartons.sheet, context.shipment);
  const openIds = new Set(cartons.records.map(row => String(row.cartonId)));
  const itemContents = readRowsByKey_(sheets.contents.sheet, 'positionId', new Set([String(context.item.positionId)]));
  const openContents = openIds.size ? readRowsByKey_(sheets.contents.sheet, 'cartonId', openIds) : [];
  const contentsById = new Map();
  [...itemContents, ...openContents].forEach(row => contentsById.set(String(row.allocationId || row.eventId || JSON.stringify(row)), row));
  const activeContents = normalizeCartonContents_(Array.from(contentsById.values()));
  const contentsHeaders = sheets.contents.sheet.getRange(1, 1, 1, sheets.contents.sheet.getLastColumn()).getValues()[0].map(String);
  const tables = {
    cartons,
    contents: { sheet: sheets.contents.sheet, headers: contentsHeaders, records: activeContents },
    closedCount: null,
  };
  return buildBoxOverview_(context, tables);
}

function getBoxDetails(shipmentId, directionId, cartonId) {
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
  const shipment = requireRitmShipment_(db, shipmentId, directionId);
  const sheets = getBoxTableSheets_(db);
  const carton = findBoxRecordByHeaderValue_(sheets.cartons.sheet, 'cartonId', String(cartonId));
  if (!carton || !cartonMatchesShipment_(carton, shipment)) throw new Error('Короб не найден в этой поставке. Обновите список.');
  const linked = normalizeCartonContents_(readRowsByKey_(sheets.contents.sheet, 'cartonId', new Set([String(carton.cartonId)])));
  const norms = boxNormsForSkus_(linked.map(row => row['Артикул']), false, shipmentMarketplace_(shipment));
  const items = readShipmentItems_(db, shipment);
  const itemByPosition = Object.create(null);
  items.forEach(row => { itemByPosition[String(row.positionId)] = row; });
  const box = publicCarton_(carton, linked, carton._rowNumber, norms, true);
  box.contents.forEach(entry => {
    const item = itemByPosition[String(entry.positionId)];
    entry.productName = item ? String(item['Название товара'] || '') : '';
    entry.productType = item ? String(item['Вид товара'] || '') : '';
    entry.photoAssetKey = item ? String(item.photoAssetKey || '') : '';
    entry.photoUrl = item ? safeRitmPhotoUrl_(item['Фото']) : '';
    entry.boxType = entry.norm && entry.norm.boxType ? entry.norm.boxType : '';
    entry.unitsPerBox = entry.norm && entry.norm.unitsPerBox ? entry.norm.unitsPerBox : null;
  });
  return { ok: true, shipment: { id: String(shipment.shipmentId), name: String(shipment['Название поставки']) }, carton: box, dataVersion: getDataVersion() };
}

function getClosedCartons(shipmentId, directionId, query, beforeRow) {
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
  const shipment = requireRitmShipment_(db, shipmentId, directionId);
  const cartonSheet = db.getSheetByName(TABLES.cartons);
  const contentsSheet = db.getSheetByName(TABLES.cartonContents);
  if (!cartonSheet || !contentsSheet) throw new Error('В хранилище не найдены таблицы коробов.');
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
      if (cartonMatchesShipment_(row, shipment) && isClosedCarton_(row) && (!needle || normalizeCartonNumber_(row['Номер']).includes(needle))) candidates.push(row);
    }
    scanEnd = startRow - 1;
  }
  const page = candidates.slice(0, pageSize);
  const pageIds = new Set(page.map(box => String(box.cartonId)));
  const contents = normalizeCartonContents_(readRowsByKey_(contentsSheet, 'cartonId', pageIds));
  const norms = boxNormsForSkus_(contents.map(row => row['Артикул']), false, shipmentMarketplace_(shipment));
  return {
    boxes: page.map(row => publicCarton_(row, contents, row._rowNumber, norms, false)),
    hasMore: candidates.length > pageSize,
    nextCursor: page.length ? Number(page[page.length - 1]._rowNumber) : null,
  };
}

function previewBoxPlacement(payload) {
  validateBoxPlacementPayload_(payload, false);
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
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
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
  const tables = readBoxTables_(db);
  const carton = tables.cartons.records.find(row => String(row.cartonId) === 'carton-' + key);
  if (!carton) return null;
  return { ok: true, duplicate: true, carton: publicCarton_(carton, tables.contents.records, carton._rowNumber, boxNormsForSkus_(tables.contents.records.filter(row => String(row.cartonId) === String(carton.cartonId)).map(row => row['Артикул']), false, shipmentMarketplace_(carton)), false) };
}

function saveBoxPlacement(payload) {
  let db, tables, allocationId, existing, quote = null, snapshot;
  const hasPreview = Boolean(payload && String(payload.previewId || '').trim());
  try {
    validateBoxPlacementPayload_(payload, false);
    db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
    tables = getBoxTableSheets_(db);
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
  if (quote && (!quote.scopeFingerprint || boxPlacementScopeFingerprint_(snapshot) !== String(quote.scopeFingerprint)))
    return boxPlacementNotWritten_('Данные этого артикула или короба изменились после проверки. Обновите короб и подтвердите размещение ещё раз.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return boxPlacementPending_('Короба сейчас обновляются. Проверяем сохранение операции.');
  let result = null;
  let duplicate = false;
  let rejected = null;
  let mutationStarted = false;
  try {
    const prior = findBoxRecordByHeaderValue_(tables.contents.sheet, 'allocationId', allocationId);
    if (prior) {
      if (!boxAllocationMatchesPayload_(prior, payload)) rejected = boxPlacementNotWritten_('Ключ повтора уже использован для другого размещения. Новая запись не добавлена.');
      else duplicate = true;
    }
    else {
      let liveScope;
      try {
        liveScope = boxPlacementCurrentScope_(db, payload, snapshot);
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
            snapshot.carton.number = nextCartonNumber_(snapshot.context.shipment, currentCartons, snapshot.itemStoreNumber);
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
            source: 'RITM_ASSEMBLY',
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

function ensureShipmentBoxViewSheet_(db, shipment) {
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
  sheet.getRange(2, 1).setFormula(shipmentBoxViewFormula_(shipmentId));
  props.setProperty(propKey, String(sheet.getSheetId()));
  return { sheet, created: !existingNote };
}

function shipmentBoxViewFormula_(shipmentId) {
  const id = String(shipmentId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error('Недопустимый ID поставки.');
  const query = "select Col1,Col2,Col3,sum(Col4) where Col5 = '" + id + "' and Col3 is not null group by Col1,Col2,Col3 order by Col1,Col2,Col3 label Col1 '',Col2 '',Col3 '',sum(Col4) ''";
  return '=IFNA(QUERY(QUERY(HSTACK(ARRAYFORMULA(IF(CartonContents!B2:B="";"";IFNA(VLOOKUP(CartonContents!B2:B;Cartons!A2:K;4;FALSE);"Номер не найден")));ARRAYFORMULA(IF(CartonContents!B2:B="";"";IFNA(VLOOKUP(CartonContents!B2:B;Cartons!A2:K;3;FALSE);"Поставка не найдена")));CartonContents!F2:F;CartonContents!G2:G;CartonContents!C2:C);"' + query + '";0);"select * where Col4 > 0";0);"")';
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
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Короба сейчас обновляются. Повторите построение листов через несколько секунд.');
  try {
    const shipments = assemblyShipments_(db);
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
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
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
  const norms = boxNormsForSkus_(cartonContents.map(row => row['Артикул']), false, shipmentMarketplace_(context.shipment));
  const tables = {
    cartons: { sheet: sheets.cartons.sheet, headers: [], records: [carton] },
    contents: { sheet: sheets.contents.sheet, headers: [], records: contents },
  };
  return boxPlacementResult_(context, allocation, tables, 0, true, norms);
}

function closeCarton(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Не удалось прочитать короб.');
  validateBoxIdempotencyKey_(payload.idempotencyKey);
  if (!String(payload.shipmentId || '').trim() || !String(payload.directionId || '').trim() || !String(payload.cartonId || '').trim()) throw new Error('Обновите карточку короба и повторите.');
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
  const shipment = requireRitmShipment_(db, payload.shipmentId, payload.directionId);
  const tables = readBoxTables_(db);
  const index = tables.cartons.records.findIndex(row => String(row.cartonId) === String(payload.cartonId));
  if (index < 0 || !cartonMatchesShipment_(tables.cartons.records[index], shipment)) throw new Error('Короб не найден в этой поставке.');
  const carton = tables.cartons.records[index];
  if (isClosedCarton_(carton)) return { ok: true, duplicate: true, carton: publicCarton_(carton, tables.contents.records, carton._rowNumber, boxNormsForSkus_(tables.contents.records.filter(row => String(row.cartonId) === String(carton.cartonId)).map(row => row['Артикул']), false, shipmentMarketplace_(shipment)), true), dataVersion: getDataVersion() };
  if (!isOpenCarton_(carton['Статус'])) throw new Error('Статус короба не подтверждён. Обновите данные, закрытие не выполнено.');
  const expectedVersion = Number(payload.dataVersion);
  if (!Number.isFinite(expectedVersion) || expectedVersion !== getDataVersion()) throw new Error('Состав короба изменился. Откройте его заново и подтвердите закрытие ещё раз.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Короба сейчас обновляются. Закрытие не выполнено — повторите через несколько секунд.');
  try {
    if (getDataVersion() !== expectedVersion) throw new Error('Состав короба изменился. Откройте его заново и подтвердите закрытие ещё раз.');
    const headers = tables.cartons.headers;
    updateCartonField_(tables.cartons.sheet, headers, carton._rowNumber, 'Статус', 'Закрыт');
    updateCartonField_(tables.cartons.sheet, headers, carton._rowNumber, 'closedAt', new Date().toISOString());
    const dataVersion = bumpDataVersion_();
    return { ok: true, duplicate: false, dataVersion };
  } finally {
    lock.releaseLock();
  }
}

function boxItemContext_(db, shipmentId, directionId, positionId) {
  const shipment = requireRitmShipment_(db, shipmentId, directionId);
  const item = readShipmentItems_(db, shipment).find(row =>
    String(row.shipmentId) === String(shipment.shipmentId) &&
    String(row.directionId) === String(shipment.directionId) &&
    String(row.positionId) === String(positionId)
  );
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
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 1 || lastColumn < 1) throw new Error('Лист коробов пуст: отсутствуют заголовки.');
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
  const required = ['cartonId', 'directionId', 'Направление', 'Номер', 'Статус'];
  const missing = required.filter(header => headers.indexOf(header) < 0);
  if (missing.length) throw new Error('В листе коробов отсутствуют колонки: ' + missing.join(', ') + '.');
  const records = [];
  const chunkSize = 250;
  for (let end = lastRow; end >= 2; end -= chunkSize) {
    const start = Math.max(2, end - chunkSize + 1);
    const values = sheet.getRange(start, 1, end - start + 1, lastColumn).getValues();
    values.forEach((cells, offset) => {
      if (!cells.some(value => value !== '' && value !== null)) return;
      const row = headers.reduce((record, header, index) => { record[header] = cells[index]; return record; }, {});
      row._rowNumber = start + offset;
      if (isOpenCarton_(row['Статус']) && cartonMatchesShipment_(row, shipment)) records.push(row);
    });
  }
  return { sheet, headers, records };
}

function buildBoxOverview_(context, tables) {
  const itemAllocations = itemAllocationsFor_(tables.contents.records, context);
  const assigned = sumBoxQuantities_(itemAllocations);
  const openRecords = tables.cartons.records.filter(row => cartonMatchesShipment_(row, context.shipment) && isOpenCarton_(row['Статус']));
  const openIds = new Set(openRecords.map(row => String(row.cartonId)));
  const openContents = tables.contents.records.filter(row => openIds.has(String(row.cartonId)));
  const normSkus = openContents.map(row => row['Артикул']).concat([context.item['Артикул']]);
  const norms = boxNormsForSkus_(normSkus, false, shipmentMarketplace_(context.shipment));
  const boxes = openRecords.map(row => publicCarton_(row, tables.contents.records, row._rowNumber, norms, false, context.item.positionId));
  boxes.sort((a, b) => Number(b.itemQuantity > 0) - Number(a.itemQuantity > 0) || String(a.number).localeCompare(String(b.number), 'ru'));
  const itemNorm = norms[normalizeBoxSku_(context.item['Артикул'])] || getBoxPackNorm_(context.item['Артикул'], false, shipmentMarketplace_(context.shipment));
  const packedKnown = context.packingKnown;
  const available = packedKnown ? Math.max(0, context.packed - assigned) : null;
  const itemBoxCount = new Set(itemAllocations.map(row => String(row.cartonId)).filter(Boolean)).size;
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
    assigned,
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
    cartonId: String(record.cartonId || ''), directionId: String(record.directionId || ''),
    number: String(record['Номер'] || ''), boxType: space.boxType,
    legacyCapacity: toNumberOrNull_(record['Подтверждённая вместимость, шт']),
    occupied: pieces, pieceCount: pieces, remaining: null,
    spaceUsed: space.spaceUsed, spaceRemaining: space.spaceRemaining, fillRatio: space.spaceUsed,
    spaceKnown: space.known, blockedReason: space.reason,
    status, open: isOpenCarton_(status), closed: isClosedCarton_(record),
    createdAt: normalizeDateString_(record.createdAt), rowNumber,
    itemQuantity,
    skuCount: new Set(linked.map(row => normalizeBoxSku_(row['Артикул'])).filter(Boolean)).size,
  };
  if (includeContents) result.contents = linked.map(row => {
    const norm = normsBySku[normalizeBoxSku_(row['Артикул'])] || null;
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
    const norm = normsBySku[normalizeBoxSku_(row['Артикул'])];
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
    const norm = normsBySku[normalizeBoxSku_(row['Артикул'])];
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
  const publicCarton = publicCarton_(carton, tables.contents.records, carton._rowNumber || cartonIndex + 2, normsBySku, false, allocation.positionId);
  const itemAllocations = itemAllocationsFor_(tables.contents.records, context);
  const assigned = sumBoxQuantities_(itemAllocations);
  const itemBoxCount = new Set(itemAllocations.map(row => String(row.cartonId)).filter(Boolean)).size;
  return {
    ok: true, duplicate,
    allocation: { allocationId: String(allocation.allocationId), cartonId: String(allocation.cartonId), shipmentId: String(allocation.shipmentId), directionId: String(allocation.directionId), positionId: String(allocation.positionId), quantity: Number(allocation['Количество, шт']), sku: String(allocation['Артикул'] || ''), createdAt: normalizeDateString_(allocation.createdAt) },
    carton: publicCarton,
    assigned,
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
  const rows = readRowsByKey_(sheet, 'shipmentId', new Set([String(shipment.shipmentId)]));
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
  return auditCancelledPackingCartons_(SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY)));
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
    if (!/^RITM-ROLL-\d+$/.test(String(row.shipmentId || '')) || String(row.directionId) !== 'ROLL') return;
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
  const shipmentIds = new Set(tables.contents.rawRecords.map(row => String(row.shipmentId || '')).filter(id => /^RITM-ROLL-\d+$/.test(id)));
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
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
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
    const catalog = SpreadsheetApp.openById(requiredSpreadsheetId_(RITM_CATALOG_PROPERTY));
    [marketplace].forEach(tabName => {
      const sheet = catalog.getSheetByName(tabName);
      if (!sheet || sheet.isSheetHidden()) return;
      const lastRow = sheet.getLastRow();
      const lastColumn = sheet.getLastColumn();
      if (lastRow < 2 || lastColumn < 2) return;
      const width = Math.min(30, lastColumn);
      const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(String);
      const keyWidth = Math.min(2, lastColumn);
      const keyRows = sheet.getRange(2, 1, lastRow - 1, keyWidth).getDisplayValues();
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
      const normRows = sheet.getRange(2, firstColumn + 1, lastRow - 1, normLastColumn - firstColumn + 1).getDisplayValues();
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
    const catalog = SpreadsheetApp.openById(requiredSpreadsheetId_(RITM_CATALOG_PROPERTY));
    // Store is the final column on each marketplace's product tab. Read it
    // beside that tab's article aliases so similarly named SKUs cannot cross stores.
    ['OZON', 'WB'].forEach(tabName => {
      const relevant = missing.filter(entry => entry.source === tabName);
      if (!relevant.length) return;
      const sheet = catalog.getSheetByName(tabName);
      if (!sheet || sheet.isSheetHidden() || sheet.getLastRow() < 1)
        throw new Error('Видимая вкладка «' + tabName + '» не найдена в базе.');
      const lastRow = sheet.getLastRow(), lastColumn = sheet.getLastColumn();
      const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0]
        .map(value => String(value || '').trim().toLocaleLowerCase('ru-RU'));
      const storeIndex = headers.indexOf('магазин');
      if (storeIndex < 0) throw new Error('Во вкладке «' + tabName + '» не найдена колонка «Магазин».');
      if (lastRow < 2) return;
      const articleRows = sheet.getRange(2, 1, lastRow - 1, Math.min(2, lastColumn)).getDisplayValues();
      const storeRows = sheet.getRange(2, storeIndex + 1, lastRow - 1, 1).getDisplayValues();
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

function boxPlacementSnapshot_(db, payload, forceFreshNorm) {
  const context = boxItemContext_(db, payload.shipmentId, payload.directionId, payload.positionId);
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
  const cartonRows = readRowsByKey_(sheets.contents.sheet, 'cartonId', new Set([cartonId]));
  const positionRows = readRowsByKey_(sheets.contents.sheet, 'positionId', new Set([String(context.item.positionId)]));
  const relevantContents = normalizeCartonContents_(uniqueCartonRows_(cartonRows.concat(positionRows)));
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
  const normsBySku = boxNormsForSkus_(cartonContents.map(row => row['Артикул']).concat([context.item['Артикул']]), forceFreshNorm === true, shipmentMarketplace_(context.shipment));
  const norm = normsBySku[normalizeBoxSku_(context.item['Артикул'])];
  if (!norm || !norm.confirmed) throw new Error(norm && norm.reason ? norm.reason : 'В базе нет подтверждённой нормы в коробе. Размещение заблокировано.');
  const storeNumbers = storeNumbersForItems_([
    { sku: context.item['Артикул'], source: storeSource },
  ].concat(cartonContents.map(row => ({ sku: row['Артикул'], source: storeSource }))), true);
  const itemStoreNumber = confirmedStoreNumber_(storeNumbers[itemStoreKey]);
  if (cartonContents.length) {
    cartonContents.forEach(row => {
      const cartonItemStore = confirmedStoreNumber_(storeNumbers[storeNumberSkuKey_(row['Артикул'], storeSource)]);
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
      number = nextCartonNumber_(context.shipment, tables.cartons.records, itemStoreNumber);
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
    if (!cartonMatchesShipment_(cartonRecord, context.shipment)) throw new Error('Короб относится к другой поставке. Выберите короб из текущей поставки.');
    if (!isOpenCarton_(cartonRecord['Статус'])) throw new Error('Короб закрыт или его статус не подтверждён. Выберите открытый короб.');
    cartonId = String(cartonRecord.cartonId);
    number = String(cartonRecord['Номер'] || '');
    const cartonStore = cartonStoreNumberFromNumber_(number);
    if (cartonStore !== itemStoreNumber)
      throw new Error('Нельзя смешивать магазины: короб ' + number + ' относится к магазину ' + (cartonStore || 'неизвестно') + ', выбран магазин ' + itemStoreNumber + '.');
  }
  if (cartonStoreNumberFromNumber_(number) !== itemStoreNumber)
    throw new Error('Нельзя смешивать магазины: номер короба должен начинаться с ' + itemStoreNumber + '.');
  const space = cartonSpace_(cartonRecord, cartonContents, normsBySku);
  if (!space.known) throw new Error(space.reason || 'Вместимость короба не подтверждена. Размещение заблокировано.');
  const fillAfter = space.spaceUsed + quantity / norm.unitsPerBox;
  if (fillAfter > 1 + 1e-9) throw new Error('В коробе осталось ' + Math.max(0, Math.floor((1 - space.spaceUsed) * norm.unitsPerBox)) + ' шт. этого артикула по подтверждённой норме.');
  const boxTypeAfter = cartonTypeSummary_(cartonContents.concat([{ 'Артикул': context.item['Артикул'] }]), normsBySku, cartonRecord['Тип короба']);
  // Global revisions change for unrelated articles too. Commit-time checks
  // compare only the selected article and carton under the script lock.
  const versionAfter = getDataVersion();
  return {
    mode: payload.mode, context, tables, cartonRecord, cartonIndex, carton: { cartonId, number },
    normsBySku, norm, space, fillAfter, boxTypeAfter, quantity, assigned, available, dataVersion: versionAfter,
    itemStoreNumber,
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
    if (!cartonMatchesShipment_(cartonRecord, context.shipment)) throw new Error('Короб относится к другой поставке. Выберите короб из текущей поставки.');
    if (!isOpenCarton_(cartonRecord['Статус'])) throw new Error('Короб уже закрыт. Обновите список коробов и выберите открытый.');
  } else if (cartonRecord && !cartonMatchesShipment_(cartonRecord, context.shipment)) {
    throw new Error('Ключ операции уже связан с коробом другой поставки.');
  }

  const cartonRows = readRowsByKey_(sheets.contents.sheet, 'cartonId', new Set([cartonId]));
  const positionRows = readRowsByKey_(sheets.contents.sheet, 'positionId', new Set([String(context.item.positionId)]));
  const contents = normalizeCartonContents_(uniqueCartonRows_(cartonRows.concat(positionRows)));
  const cartonContents = contents.filter(row => String(row.cartonId) === cartonId);
  const itemAllocations = itemAllocationsFor_(contents, context);
  const assigned = sumBoxQuantities_(itemAllocations);
  if (assigned > context.packed) throw new Error('В коробах уже распределено больше, чем подтверждено упаковкой. Обновите короба и проверьте остаток.');
  const available = Math.max(0, context.packed - assigned);
  if (snapshot.quantity > available) throw new Error('Теперь доступно только ' + available + ' шт. Обновите короба и проверьте количество ещё раз.');

  const effectiveCarton = cartonRecord || snapshot.cartonRecord;
  const space = cartonSpace_(effectiveCarton, cartonContents, snapshot.normsBySku);
  if (!space.known) throw new Error(space.reason || 'Вместимость короба больше нельзя подтвердить.');
  const fillAfter = space.spaceUsed + snapshot.quantity / snapshot.norm.unitsPerBox;
  if (fillAfter > 1 + 1e-9) throw new Error('В коробе осталось место максимум для ' + Math.max(0, Math.floor((1 - space.spaceUsed) * snapshot.norm.unitsPerBox)) + ' шт. Обновите короб и проверьте количество ещё раз.');

  return {
    mode: snapshot.mode, context, tables: { cartons: { sheet: sheets.cartons.sheet, headers: [], records: cartonRecord ? [cartonRecord] : [] }, contents: { sheet: sheets.contents.sheet, headers: [], records: contents } },
    cartonRecord: effectiveCarton, cartonIndex: cartonRecord ? 0 : -1, carton: snapshot.carton,
    cartonExists: Boolean(cartonRecord), cartonContents, itemAllocations, assigned, available, space, fillAfter,
    norm: snapshot.norm, normsBySku: snapshot.normsBySku, quantity: snapshot.quantity,
    itemStoreNumber: snapshot.itemStoreNumber,
  };
}

function uniqueCartonRows_(rows) {
  const byKey = new Map();
  (rows || []).forEach(row => {
    const key = String(row.allocationId || row.eventId || JSON.stringify(row));
    if (!byKey.has(key)) byKey.set(key, row);
  });
  return Array.from(byKey.values());
}

function nextCartonNumber_(shipment, cartons, storeNumber) {
  const shop = confirmedStoreNumber_([storeNumber]);
  const prefix = shop + cartonSupplyAbbreviation_(shipment);
  const matching = (cartons || [])
    .filter(row => cartonMatchesShipment_(row, shipment))
    .map(row => ({ number: String(row['Номер'] || ''), parts: cartonNumberParts_(row['Номер']) }))
    .filter(entry => entry.parts && cartonStoreNumberFromNumber_(entry.number) === shop);
  const max = Math.max(0, ...matching.map(entry => entry.parts.sequence));
  return prefix + String(max + 1);
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
  return { available: true, rows: readIndexedRows_(sheet, ['shipmentId', 'createdAt'], row => {
    const date = moscowWorkDate_(row.createdAt);
    return String(row.shipmentId) === String(shipmentId) || date === day || !date;
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
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
  const workLog = db.getSheetByName(TABLES.workLog);
  if (!workLog || workLog.getLastRow() < 2) throw new Error('Не найден журнал WorkLog.');
  // Search only the eventId column in Sheets and fetch the matching row. Avoid
  // transferring the entire growing index column to Apps Script for one delete.
  const event = findRowByHeaderValue_(workLog, 'eventId', id);
  if (!event) throw new Error('Запись не найдена в WorkLog. Обновите страницу.');
  if (!isCollectorWorkSource_(event['Источник'])) {
    throw new Error('Можно удалить только запись, созданную приложением сборщиков.');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) throw new Error('Журнал сейчас занят другой операцией. Запись не изменилась — повторите через несколько секунд.');
  try {
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
  return readIndexedRows_(sheet, [keyHeader], row => wantedValues.has(String(row[keyHeader] || '')));
}

function readIndexedRows_(sheet, keyHeaders, predicate, knownHeaders, maxGapRows) {
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
const RITM_PRINTING_PROPERTY = 'RITM_ROLL_PRINTING_ID';
const RITM_BOX_PRINTING_PROPERTY = 'RITM_BOX_PRINTING_ID';
const RITM_CATALOG_PROPERTY = 'RITM_CATALOG_ID';
const RITM_PHOTOS_PROPERTY = 'RITM_PHOTOS_ID';
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
    const source = SpreadsheetApp.openById(requiredSpreadsheetId_(RITM_PRINTING_PROPERTY));
    const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
    const rollSheets = source.getSheets();
    const manifestCache = new Map();
    const candidates = rollSheets.filter(sheet => {
      if (ritmSupplyManifest_(sheet, manifestCache)) return false;
      if (sheet.isSheetHidden() || sheet.getLastRow() < 4 || sheet.getLastColumn() < 15) return false;
      const headers = sheet.getRange(4, 5, 1, 11).getDisplayValues()[0];
      return String(headers[0]).trim() === 'Артикул' && String(headers[10]).trim() === 'Кол-во';
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
            ensureShipmentBoxViewSheet_(db, { shipmentId: prior.shipmentId, 'Название поставки': sheet.getName() });
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
          if (hasMergedBox) item.push('Рулонная печать', requiredSpreadsheetId_(RITM_PRINTING_PROPERTY));
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
          ensureShipmentBoxViewSheet_(db, { shipmentId, 'Название поставки': sheet.getName() });
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

function readRitmOrders_(sheet) {
  const last = sheet.getLastRow();
  if (last > 5000) throw new Error('В листе больше 5000 строк; требуется проверить диапазон поставки.');
  if (last < 5) return [];
  const values = sheet.getRange(5, 5, last - 4, Math.min(25, sheet.getMaxColumns() - 4)).getValues();
  const seen = new Set();
  return values.flatMap((row, index) => {
    const sku = String(row[0] || '').trim();
    if (!sku) return [];
    const uid = String(row[24] || '').trim();
    if (uid && seen.has(uid)) throw new Error('Повторяется UID позиции; синхронизация этой поставки остановлена.');
    if (uid) seen.add(uid);
    const quantity = toNumberOrNull_(row[10]);
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
    const expected = part.department === 'roll' ? requiredSpreadsheetId_(RITM_PRINTING_PROPERTY) : part.department === 'box' ? requiredSpreadsheetId_(RITM_BOX_PRINTING_PROPERTY) : '';
    if (!expected || part.documentId !== expected || !Number.isSafeInteger(part.sheetId) || part.sheetId < 0 || seen.has(part.department)) throw new Error('Некорректный источник отдела производства.');
    seen.add(part.department);
  });
  if (cache) cache.set(sheet, manifest);
  return manifest;
}

// Every participant carries the same committed manifest. A half-written supply
// must never replace the last complete Assembly snapshot.
function syncRitmDepartmentSupplies_(rollSource, db, props, report, loadCatalog, startedAt, force, rollSheets, manifestCache, onlyId, transferParts) {
  const sources = rollSource ? [{ id: requiredSpreadsheetId_(RITM_PRINTING_PROPERTY), book: rollSource, sheets: rollSheets || rollSource.getSheets() }] : [];
  let allSourcesAvailable = true;
  try { if (!onlyId || !transferParts || transferParts.some(part => part.department === 'box')) sources.push({ id: requiredSpreadsheetId_(RITM_BOX_PRINTING_PROPERTY), book: SpreadsheetApp.openById(requiredSpreadsheetId_(RITM_BOX_PRINTING_PROPERTY)) }); }
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
        const headers = source.sheet.getRange(4, 5, 1, 11).getDisplayValues()[0];
        if (headers[0] !== 'Артикул' || headers[10] !== 'Кол-во') throw new Error('Изменилась структура производственного задания.');
        const rows = readRitmOrders_(source.sheet);
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
        props.setProperty(key, JSON.stringify(Object.assign({}, prior, { sourceAvailable: true })));
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
        sourceAvailable: true, fingerprint, order: prior ? prior.order : 1000 + groups.size,
        syncedAt: new Date().toISOString(), catalogAt: startedAt }));
      ensureShipmentBoxViewSheet_(db, { shipmentId: manifest.id, 'Название поставки': manifest.name });
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
  const db = SpreadsheetApp.openById(requiredSpreadsheetId_(RITM_CATALOG_PROPERTY));
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
  const workbook = SpreadsheetApp.openById(requiredSpreadsheetId_(RITM_PHOTOS_PROPERTY));
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
  const props = PropertiesService.getScriptProperties().getProperties();
  const live = Object.keys(props).filter(key => key.indexOf(RITM_SYNC_PREFIX) === 0)
    .map(key => parseSyncJson_(props[key], null)).filter(row => row && !row.archived && !row.mergedIntoRoll && db.getSheetById(Number(row.sheetId)))
    .sort((a, b) => a.order - b.order)
    .map(row => ({ shipmentId: row.shipmentId, 'Название поставки': row.name, directionId: 'ROLL', 'Направление': row.name,
      sheetId: row.sheetId, environment: 'RITM', sourceAvailable: row.sourceAvailable, itemCount: Number.isSafeInteger(row.rows) ? row.rows : null,
      marker: row.marker || '',
      sourceUrl: 'https://docs.google.com/spreadsheets/d/' + (row.parts && row.parts[0] ? row.parts[0].documentId : requiredSpreadsheetId_(RITM_PRINTING_PROPERTY)) + '/edit#gid=' + row.sourceSheetId }));
  // Keep the old demo sheets/history intact, but never mix demo figures into this live selector.
  return live;
}

function readShipmentItems_(db, shipment) {
  if (shipment.environment !== 'RITM') return readTable_(db, TABLES.items);
  const sheet = db.getSheetById(Number(shipment.sheetId));
  const sourceSheetId = String(shipment.shipmentId).replace('RITM-ROLL-', '');
  if (!sheet || sheet.getRange(1, 1).getNote() !== (shipment.marker || RITM_SHEET_MARKER + sourceSheetId)) throw new Error('Не удалось подтвердить источник позиций поставки.');
  return readTable_(db, sheet.getName());
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
  const documentId = department === 'roll' ? requiredSpreadsheetId_(RITM_PRINTING_PROPERTY) : department === 'box' ? requiredSpreadsheetId_(RITM_BOX_PRINTING_PROPERTY) : '';
  if (!documentId || !Number.isSafeInteger(sheetId) || sheetId < 0) ritmTransferConflict_('Не подтверждён источник передачи.');
  const book = SpreadsheetApp.openById(documentId), sheet = book.getSheetById(sheetId);
  if (!sheet || sheet.isSheetHidden()) ritmTransferConflict_('Источник удалён или скрыт.');
  const headers = sheet.getRange(4, 5, 1, 11).getValues()[0];
  if (String(headers[0]).trim() !== 'Артикул' || String(headers[10]).trim() !== 'Кол-во') ritmTransferConflict_('Изменилась структура источника.');
  let rows, manifest;
  try { rows = readRitmOrders_(sheet); manifest = ritmSupplyManifest_(sheet); }
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
    part.documentId === requiredSpreadsheetId_(RITM_PRINTING_PROPERTY) && Number(part.sheetId) === Number(source.sheetId);
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
      parts[0].documentId === requiredSpreadsheetId_(RITM_PRINTING_PROPERTY) && String(parts[0].sheetId) === String(rollSourceSheetId);
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
  ensureShipmentBoxViewSheet_(db, { shipmentId: actualShipmentId, 'Название поставки': name });
  return { name, added: rows.filter(row => !previousKeys.has(ritmTransferRowKey_(row))).length,
    existing: rows.filter(row => selectedKeys.has(ritmTransferRowKey_(row)) && previousKeys.has(ritmTransferRowKey_(row))).length };
}
function syncRitmTransferredBoxSupplies_(db, props, report, catalog, startedAt, force) {
  const all = props.getProperties();
  Object.keys(all).filter(key => key.indexOf(RITM_SYNC_PREFIX) === 0).forEach(key => {
    const prior = parseSyncJson_(all[key], null);
    if (!prior || !prior.transferred || prior.archived) return;
    try {
      const source = readRitmTransferSource_('box', Number(prior.sourceSheetId));
      if (source.manifest) ritmTransferConflict_('Источник теперь связан с общей поставкой; требуется сверка.');
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
    const db = SpreadsheetApp.openById(requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
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
      const rollBook = source.department === 'roll' ? source.book : transfer.parts.some(part => part.department === 'roll') ? SpreadsheetApp.openById(requiredSpreadsheetId_(RITM_PRINTING_PROPERTY)) : null;
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
