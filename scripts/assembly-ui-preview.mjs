// Local-only UI fixture: no Google credentials, production data, or network clients.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const source = new URL('../apps-script/assembly/Index.html', import.meta.url);
const shipments = [
  { id: 'demo-kostroma', name: 'OZON Кострома', itemCount: 8 },
  { id: 'demo-moscow', name: 'WB МОСКВА', itemCount: 6 },
  { id: 'demo-spb', name: 'OZON Санкт-Петербург', itemCount: 4 },
  { id: 'demo-novosib', name: 'OZON Новосибирск', itemCount: 5 },
].map((row) => ({ ...row, environment: 'TEST ONLY', sourceAvailable: true }));
const employees = [
  { id: 'max', name: 'Максим' },
  { id: 'david', name: 'Давид' },
  { id: 'lukman', name: 'Лукман' },
  { id: 'anna', name: 'Анна' },
];
const labels = { cut: 'Порезка', assembly: 'Сборка', packing: 'Упаковка' };
const operations = Object.entries(labels).map(([id, name]) => ({ id, name }));
const products = [
  [
    'KT0064.A7697',
    'Ёлочные украшения «Сумерки мемы», 6 шт.',
    'Ёлочные игрушки',
    507,
    360,
    240,
    180,
  ],
  [
    'KT0064.A7698',
    'Наклейки «Новый год, котики», 35 шт.',
    'Наклейки',
    195,
    195,
    null,
    120,
  ],
  [
    'JA0037.A0225',
    'Наклейки дорожные знаки, А5',
    'Наклейки',
    170,
    170,
    null,
    170,
  ],
  ['NT0006.A4692', 'Планер на неделю, А3', 'Планеры', 60, null, null, 25],
  [
    'KS0002.A7665',
    'Наклейки «Стикерпанк», 90 шт.',
    'Наклейки',
    300,
    150,
    null,
    80,
  ],
  [
    'KT0072.A0094',
    'Магниты «Котики», набор 12 шт.',
    'Магниты',
    200,
    140,
    90,
    null,
  ],
  [
    'KT0046.A6935',
    'Наклейки интерьерные «Защити свои границы»',
    'Наклейки',
    30,
    null,
    null,
    null,
  ],
  [
    'NT0032.A5322',
    'Наклейки ростомер «Маленькая принцесса»',
    'Наклейки',
    30,
    null,
    null,
    null,
  ],
];
let dataVersion = 1;
const work = new Map();
const data = new Map(
  shipments.map((shipment, shipmentIndex) => [
    shipment.id,
    {
      environment: 'TEST ONLY',
      shipments,
      shipment: {
        ...shipment,
        directionId: 'DEMO',
        sourceUrl: '',
        assemblyUrl: '',
      },
      employees,
      operations,
      sync: { status: 'current', errors: [] },
      updatedAt: new Date().toISOString(),
      dataVersion,
      items: products.slice(0, shipment.itemCount).map((row, i) => {
        const [sku, productName, productType, plan, cut, assembly, packing] =
          row;
        const values = { cut, assembly, packing };
        const item = {
          sku,
          productName,
          productType,
          shipmentId: shipment.id,
          directionId: 'DEMO',
          positionId: shipment.id + '-' + i,
          photoAssetKey: 'preview-' + i,
          operations: {},
          workers: [],
          workRecords: [],
          boxCountSnapshot: i === 0 ? 2 : i === 2 ? 1 : null,
          boxedQtySnapshot: i === 0 ? 150 : i === 2 ? 170 : null,
          unboxedQtySnapshot: null,
        };
        for (const op of operations)
          item.operations[op.id] = {
            id: op.id,
            label: op.name,
            plan: op.id === 'packing' || values[op.id] !== null ? plan : null,
            fact: values[op.id],
            ratio: values[op.id] === null ? null : values[op.id] / plan,
            overBy: 0,
            normPerPerson:
              sku === 'JA0037.A0225' ? (op.id === 'cut' ? 7000 / 3 : op.id === 'packing' ? 825 : 550) : op.id === 'packing' ? 500 : op.id === 'assembly' ? 400 : 600,
            normDetails: sku === 'JA0037.A0225' ? { perShift: op.id === 'cut' ? 7000 : op.id === 'packing' ? 825 : 550, multiplier: op.id === 'cut' ? 3 : 1, unit: op.id === 'cut' ? 'л.' : 'шт.', source: 'Синтетическая проверка формы' } : undefined,
          };
        const quantities =
          i === 0
            ? [
                [180, 150, 100],
                [180, 90, 80],
              ]
            : i === 1
              ? [[195, 0, 120]]
              : i === 2
                ? [[170, 0, 170]]
                : i === 3
                  ? [[0, 0, 25]]
                  : i === 4
                    ? [[150, 0, 80]]
                    : i === 5
                      ? [[140, 90, 0]]
                      : [];
        quantities.forEach((values, index) => {
          const employee = employees[index];
          const createdAt = new Date(
            Date.now() - (index + 1) * 900000 - i * 600000,
          ).toISOString();
          const worker = {
            ...employee,
            operations: {},
            lastWorkedAt: createdAt,
          };
          operations.forEach((op, opIndex) => {
            const quantity = values[opIndex];
            worker.operations[op.id] = {
              quantity,
              coefficient: quantity / item.operations[op.id].normPerPerson,
              coefficientKnown: quantity > 0,
              eventCount: quantity > 0 ? 1 : 0,
            };
            if (quantity > 0) item.workRecords.push({
              eventId: `preview-${shipment.id}-${i}-${employee.id}-${op.id}`,
              shipmentId: shipment.id,
              directionId: 'DEMO',
              positionId: item.positionId,
              employeeId: employee.id,
              employeeName: employee.name,
              operationId: op.id,
              operationName: op.name,
              quantity,
              norm: item.operations[op.id].normPerPerson,
              coefficient: quantity / item.operations[op.id].normPerPerson,
              createdAt,
              source: 'WEB_APP_TEST',
              cancelled: false,
              cancelledAt: '',
              cancellationReason: '',
            });
          });
          item.workers.push(worker);
        });
        item.packingRemaining =
          packing === null ? null : Math.max(0, plan - packing);
        item.status =
          packing >= plan
            ? 'Упаковка завершена'
            : packing > 0
              ? 'Упаковка'
              : assembly > 0
                ? 'Сборка'
                : cut > 0
                  ? 'Порезка'
                  : 'Не начато';
        return item;
      }),
    },
  ]),
);

const cartons = [];
const cartonContents = [];
const demoBoxNorms = {
  'KT0064.A7697': { boxType: 'M', unitsPerBox: 200 },
  'KT0064.A7698': { boxType: 'О', unitsPerBox: 64 },
  'JA0037.A0225': { boxType: 'О', unitsPerBox: 64 },
  'NT0006.A4692': { boxType: 'M', unitsPerBox: 50 },
  'KS0002.A7665': { boxType: 'О', unitsPerBox: 64 },
  'KT0072.A0094': { boxType: 'О', unitsPerBox: 64 },
  'KT0046.A6935': { boxType: 'О', unitsPerBox: 64 },
};
const boxCreations = new Map();
const boxPlacements = new Map();
const lostBoxResponses = new Set();
cartons.push(
  { cartonId: 'preview-carton-1', shipmentId: 'demo-kostroma', directionId: 'DEMO', number: 'Короб № 1', boxType: 'M', capacity: 200, status: 'Открыт' },
  { cartonId: 'preview-carton-2', shipmentId: 'demo-kostroma', directionId: 'DEMO', number: 'Короб № 2', boxType: 'M', capacity: 300, status: 'Открыт' },
);
cartonContents.push(
  { allocationId: 'preview-allocation-1', cartonId: 'preview-carton-1', shipmentId: 'demo-kostroma', directionId: 'DEMO', positionId: 'demo-kostroma-0', sku: 'KT0064.A7697', quantity: 100 },
  { allocationId: 'preview-allocation-2', cartonId: 'preview-carton-2', shipmentId: 'demo-kostroma', directionId: 'DEMO', positionId: 'demo-kostroma-0', sku: 'KT0064.A7697', quantity: 50 },
  { allocationId: 'preview-allocation-3', cartonId: 'preview-carton-1', shipmentId: 'demo-kostroma', directionId: 'DEMO', positionId: 'demo-kostroma-3', sku: 'NT0006.A4692', quantity: 10 },
);

function publicCarton(carton) {
  const contents = cartonContents.filter((row) => row.cartonId === carton.cartonId);
  const occupied = contents.reduce((sum, row) => sum + row.quantity, 0);
  let fillRatio = 0;
  const types = new Set();
  let spaceKnown = contents.length > 0;
  let blockedReason = '';
  for (const row of contents) {
    const norm = demoBoxNorms[row.sku];
    if (!norm || !norm.unitsPerBox || !norm.boxType) {
      spaceKnown = false;
      blockedReason ||= 'Для одного из артикулов нет подтверждённой нормы.';
      continue;
    }
    fillRatio += row.quantity / norm.unitsPerBox;
    types.add(norm.boxType);
  }
  if (types.size > 1 || (carton.boxType && [...types].some((type) => type !== carton.boxType))) {
    spaceKnown = false;
    blockedReason ||= 'Смешаны несовместимые типы коробов.';
  }
  return {
    ...carton,
    occupied,
    pieceCount: occupied,
    remaining: spaceKnown ? Math.max(0, 1 - fillRatio) : null,
    fillRatio: spaceKnown ? fillRatio : null,
    spaceKnown,
    blockedReason,
    skuCount: new Set(contents.map((row) => row.sku)).size,
    status: carton.status,
    open: carton.status === 'Открыт',
    contents: contents.map((row) => ({ ...row })),
  };
}

function articleCartonSnapshots(shipmentId, positionId) {
  const cartonIds = new Set(cartonContents
    .filter((row) => row.shipmentId === shipmentId && row.positionId === positionId)
    .map((row) => row.cartonId));
  return [...cartonIds].map((cartonId) => {
    const carton = cartons.find((row) => row.cartonId === cartonId);
    if (!carton) return null;
    const value = publicCarton(carton);
    return {
      cartonId,
      number: value.number,
      status: value.status,
      open: value.open,
      closed: value.status === 'Закрыт',
      itemQuantity: cartonContents
        .filter((row) => row.shipmentId === shipmentId && row.positionId === positionId && row.cartonId === cartonId)
        .reduce((sum, row) => sum + row.quantity, 0),
      pieceCount: value.occupied,
      skuCount: value.skuCount,
      fillRatio: value.fillRatio,
      spaceKnown: value.spaceKnown,
      blockedReason: value.blockedReason,
    };
  }).filter(Boolean).sort((a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true }));
}

for (const snapshot of data.values()) {
  for (const item of snapshot.items) {
    // Demo-only norms let the preview exercise visibly mixed box types without touching live Sheets.
    const norm = demoBoxNorms[item.sku];
    if (norm) Object.assign(item, norm);
    item.cartonsSnapshot = articleCartonSnapshots(snapshot.shipment.id, item.positionId);
  }
}

function getBoxOverview(shipmentId, positionId) {
  const snapshot = data.get(shipmentId);
  const item = snapshot?.items.find((row) => row.positionId === positionId);
  if (!snapshot || !item) throw Error('Тест: товар для коробов не найден');
  const boxes = cartons.filter((box) => box.shipmentId === shipmentId && box.directionId === item.directionId).map(publicCarton);
  const itemBoxes = boxes.filter((box) => box.contents.some((row) => row.shipmentId === shipmentId && row.positionId === positionId));
  const assigned = cartonContents.filter((row) => row.shipmentId === shipmentId && row.positionId === positionId).reduce((sum, row) => sum + row.quantity, 0);
  const numbers = boxes.map((box) => Number(box.number.match(/(\d+)\s*$/)?.[1] || 0));
  return {
    shipment: { id: snapshot.shipment.id, name: snapshot.shipment.name, directionId: item.directionId },
    item: {
      positionId, sku: item.sku, productName: item.productName, plan: item.operations.packing.plan,
      packedKnown: Number.isFinite(item.operations.packing.fact), packed: item.operations.packing.fact,
      boxType: demoBoxNorms[item.sku]?.boxType || '', unitsPerBox: demoBoxNorms[item.sku]?.unitsPerBox || null,
      normSource: demoBoxNorms[item.sku] ? 'Локальная синтетическая норма' : '',
      normError: demoBoxNorms[item.sku] ? '' : 'Норма короба не подтверждена в локальном примере.',
    },
    boxes,
    itemBoxes,
    assigned,
      available: Number.isFinite(item.operations.packing.fact)
        ? Math.max(0, item.operations.packing.fact - assigned)
        : null,
    suggestedNumber: 'Короб № ' + (Math.max(0, ...numbers) + 1),
  };
}

function svgPhoto(key) {
  const index = Number(key.split('-').at(-1)) || 0;
  const colors = ['#bbd5eb', '#f4d7b7', '#d6e7d0', '#d8d0ed'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96" viewBox="0 0 80 96"><rect x="8" y="5" width="64" height="86" rx="5" fill="white" stroke="#d3dce6"/><rect x="13" y="11" width="54" height="14" rx="2" fill="${colors[index % 4]}"/><text x="40" y="21" font-family="sans-serif" font-size="7" font-weight="bold" text-anchor="middle" fill="#24405d">RITM · ТЕСТ</text><circle cx="29" cy="43" r="10" fill="${colors[(index + 1) % 4]}"/><rect x="44" y="34" width="16" height="19" rx="4" fill="${colors[(index + 2) % 4]}"/><rect x="19" y="60" width="18" height="19" rx="5" fill="${colors[index % 4]}"/><circle cx="52" cy="70" r="10" fill="${colors[(index + 3) % 4]}"/></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
function rpc(method, args, mode) {
  if (method === 'getAssemblyPreview') {
    const snapshot = rpc('getInitialData', args, mode);
    snapshot.referenceIncomplete = true;
    snapshot.employees = [];
    snapshot.items.forEach(item => {
      item.workers = []; item.workRecords = []; item.workFactsAvailable = false;
      Object.values(item.operations).forEach(operation => { operation.fact = null; operation.ratio = null; });
    });
    return snapshot;
  }
  if (method === 'getShipmentProgress') {
    const snapshot = rpc('getInitialData', args, mode);
    return { shipmentId: snapshot.shipment.id, referenceKey: snapshot.referenceKey,
      dataVersion: snapshot.dataVersion, updatedAt: snapshot.updatedAt,
      employeeShift: snapshot.employeeShift, items: snapshot.items };
  }
  if (method === 'getInitialData') {
    if (mode === 'offline')
      throw Error('Тест: источник недоступен. Последние данные сохранены.');
    const result = structuredClone(data.get(args[0]) || data.values().next().value);
    result.shipment.marketplace = /(^|[^A-Z0-9])OZON([^A-Z0-9]|$)/i.test(result.shipment.name) ? 'OZON' : /(^|[^A-Z0-9])WB([^A-Z0-9]|$)/i.test(result.shipment.name) ? 'WB' : '';
    result.shipment.labelSourceStatus = 'demo';
    for (const item of result.items) item.label = { status: 'demo' };
    const employeeNames = ['Анна', 'Оля', 'Максим', 'Давид', 'Лукман', 'Ирина', 'Павел', 'Светлана', 'Егор', 'Мария'];
    const staffCount = mode === 'staff-1' ? 1 : mode === 'staff-3' ? 3 : mode === 'staff-10' ? 10 : 0;
    if (staffCount && result.items[0]) {
      const sample = result.items[0].workers[0];
      result.items[0].workers = Array.from({ length: staffCount }, (_, index) => ({
        ...structuredClone(sample),
        id: 'preview-worker-' + index,
        name: employeeNames[index],
        lastWorkedAt: new Date(Date.now() - index * 3600000).toISOString(),
        operations: Object.fromEntries(Object.entries(sample.operations).map(([op, value]) => [op, { ...value, quantity: index === 0 ? value.quantity : 0, coefficient: index === 0 ? value.coefficient : 0, coefficientKnown: index === 0 && value.coefficientKnown, eventCount: index === 0 ? value.eventCount : 0 }])),
      }));
    }
    if (mode === 'missing-operations' && result.items[0]) {
      for (const id of ['cut', 'assembly']) {
        result.items[0].operations[id].plan = null;
        result.items[0].operations[id].fact = null;
        result.items[0].operations[id].ratio = null;
      }
    }
    const employeeShift = { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()), available: true, scope: 'Локальная фикстура', employees: {} };
    for (const snapshot of data.values()) for (const item of snapshot.items) for (const worker of item.workers) {
      const entry = employeeShift.employees[worker.id] ||= { coefficient: 0, unknownCount: 0, eventCount: 0 };
      for (const operation of Object.values(worker.operations)) {
        if (!operation.eventCount) continue;
        entry.eventCount += operation.eventCount;
        if (operation.coefficientKnown) entry.coefficient += operation.coefficient;
        else entry.unknownCount += operation.eventCount;
      }
    }
    return { ...result, employeeShift, dataVersion, updatedAt: new Date().toISOString() };
  }
  if (method === 'getDataVersion') return dataVersion;
  if (method === 'getPhotos')
    return Object.fromEntries(args[0].map((key) => [key, svgPhoto(key)]));
  if (method === 'getLabelImage') return { status: 'missing' };
  if (method === 'getLabelImages') {
    const selected = data.get(args[0])?.items || [];
    return args[2].map((positionId) => {
      const item = selected.find((row) => row.positionId === positionId);
      return { positionId, sku: item?.sku || '', status: 'missing' };
    });
  }
  if (method === 'getBoxesForItem') return getBoxOverview(args[0], args[2]);
  if (method === 'getBoxDetails') {
    const [shipmentId, , cartonId] = args;
    const shipment = data.get(shipmentId)?.shipment;
    const carton = cartons.find((row) => row.cartonId === cartonId && row.shipmentId === shipmentId);
    if (!shipment || !carton) throw Error('Тест: короб не найден');
    const value = publicCarton(carton);
    value.contents = value.contents.map((entry) => {
      const snapshot = data.get(shipmentId);
      const item = snapshot?.items.find((row) => row.positionId === entry.positionId);
      const norm = demoBoxNorms[entry.sku];
      return {
        ...entry,
        productName: item?.productName || '',
        norm: norm ? { ...norm, source: 'Локальная синтетическая норма' } : null,
      };
    });
    return { ok: true, shipment: { id: shipment.id, name: shipment.name }, carton: value, dataVersion };
  }
  if (method === 'createCarton') {
    const payload = args[0];
    const prior = boxCreations.get(payload.idempotencyKey);
    if (prior) return { ok: true, duplicate: true, carton: publicCarton(prior), dataVersion };
    if (cartons.some((box) => box.shipmentId === payload.shipmentId && box.directionId === payload.directionId && box.number.trim().toLocaleLowerCase('ru-RU') === payload.number.trim().toLocaleLowerCase('ru-RU')))
      throw Error('Тест: короб с таким номером уже существует');
    const carton = { cartonId: 'carton-' + payload.idempotencyKey, shipmentId: payload.shipmentId, directionId: payload.directionId, number: payload.number, capacity: Number(payload.capacity), status: 'Открыт' };
    cartons.push(carton);
    boxCreations.set(payload.idempotencyKey, carton);
    dataVersion++;
    if (mode === 'lost-response' && !lostBoxResponses.has(payload.idempotencyKey)) {
      lostBoxResponses.add(payload.idempotencyKey);
      throw Error('Тест: ответ создания потерян после сохранения');
    }
    return { ok: true, duplicate: false, carton: publicCarton(carton), dataVersion };
  }
  if (method === 'getCartonCreationStatus') {
    const carton = boxCreations.get(args[0]);
    return carton ? { ok: true, duplicate: true, carton: publicCarton(carton), dataVersion } : null;
  }
  if (method === 'saveBoxPlacement') {
    const payload = args[0];
    const prior = boxPlacements.get(payload.idempotencyKey);
    if (prior) return { ...prior, duplicate: true, dataVersion };
    const snapshot = data.get(payload.shipmentId);
    const item = snapshot?.items.find((row) => row.positionId === payload.positionId);
    const carton = cartons.find((box) => box.cartonId === payload.cartonId);
    if (!item || !carton || carton.shipmentId !== payload.shipmentId || !publicCarton(carton).open) throw Error('Тест: товар или открытый короб недоступен');
    const quantity = Number(payload.quantity);
    const used = cartonContents.filter((row) => row.cartonId === carton.cartonId).reduce((sum, row) => sum + row.quantity, 0);
    const assigned = cartonContents.filter((row) => row.shipmentId === payload.shipmentId && row.positionId === payload.positionId).reduce((sum, row) => sum + row.quantity, 0);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > carton.capacity - used || quantity > item.operations.packing.plan - assigned) throw Error('Тест: количество превышает остаток');
    const allocation = { allocationId: 'allocation-' + payload.idempotencyKey, cartonId: carton.cartonId, shipmentId: payload.shipmentId, directionId: payload.directionId, positionId: payload.positionId, quantity, sku: item.sku, createdAt: new Date().toISOString() };
    cartonContents.push(allocation);
    const updated = getBoxOverview(payload.shipmentId, payload.positionId);
    item.boxCountSnapshot = updated.itemBoxes.length;
    item.boxedQtySnapshot = updated.assigned;
    item.unboxedQtySnapshot = updated.available;
    const result = { ok: true, duplicate: false, allocation, carton: publicCarton(carton), assigned: updated.assigned, available: updated.available, dataVersion: ++dataVersion };
    boxPlacements.set(payload.idempotencyKey, result);
    if (mode === 'lost-response' && !lostBoxResponses.has(payload.idempotencyKey)) {
      lostBoxResponses.add(payload.idempotencyKey);
      throw Error('Тест: ответ размещения потерян после сохранения');
    }
    return result;
  }
  if (method === 'getBoxPlacementStatus') {
    const result = boxPlacements.get(args[0]);
    return result ? { ...result, duplicate: true, dataVersion } : null;
  }
  if (method === 'getWorkStatus') {
    if (mode === 'unknown') throw Error('Тест: журнал временно недоступен');
    const result = work.get(args[0]);
    return result ? { ...result, duplicate: true } : null;
  }
  if (method === 'cancelWork') {
    const [eventId, reason] = args;
    for (const snapshot of data.values()) {
      for (const item of snapshot.items) {
        const record = item.workRecords.find((row) => row.eventId === eventId);
        if (!record) continue;
        if (record.cancelled) return { ok: true, alreadyCancelled: true, eventId, dataVersion };
        record.cancelled = true;
        record.cancelledAt = new Date().toISOString();
        record.cancellationReason = String(reason || 'Исправление ошибочной записи');
        const operation = item.operations[record.operationId];
        operation.fact = Math.max(0, Number(operation.fact || 0) - record.quantity);
        operation.ratio = operation.plan > 0 ? operation.fact / operation.plan : null;
        const worker = item.workers.find((row) => row.id === record.employeeId);
        const workerOperation = worker?.operations[record.operationId];
        if (workerOperation) {
          workerOperation.quantity = Math.max(0, workerOperation.quantity - record.quantity);
          workerOperation.coefficient = Math.max(0, workerOperation.coefficient - (record.coefficient || 0));
          workerOperation.eventCount = Math.max(0, workerOperation.eventCount - 1);
          workerOperation.coefficientKnown = workerOperation.eventCount > 0;
        }
        if (worker && Object.values(worker.operations).every((value) => value.eventCount === 0))
          item.workers = item.workers.filter((row) => row.id !== worker.id);
        item.packingRemaining = Number.isFinite(item.operations.packing.fact)
          ? Math.max(0, item.operations.packing.plan - item.operations.packing.fact)
          : null;
        item.status = item.operations.packing.fact >= item.operations.packing.plan
          ? 'Упаковка завершена'
          : item.operations.packing.fact > 0
            ? 'Упаковка'
            : item.operations.assembly.fact > 0
              ? 'Сборка'
              : item.operations.cut.fact > 0
                ? 'Порезка'
                : 'Не начато';
        dataVersion++;
        return { ok: true, alreadyCancelled: false, eventId, dataVersion };
      }
    }
    throw Error('Тест: запись не найдена');
  }
  if (method === 'saveWork') {
    const payload = args[0];
    const prior = work.get(payload.idempotencyKey);
    if (prior) return { ...prior, duplicate: true };
    if (mode === 'reject') throw Error('Тест: запись отклонена сервером');
    if (mode === 'unknown')
      throw Error('Тест: связь прервалась, результат неизвестен');
    const snapshot = data.get(payload.shipmentId),
      item = snapshot?.items.find(
        (row) => row.positionId === payload.positionId,
      ),
      employee = employees.find((row) => row.id === payload.employeeId);
    if (
      !item ||
      !employee ||
      !Number.isSafeInteger(Number(payload.quantity)) ||
      Number(payload.quantity) < 1 ||
      !(item.operations[payload.operationId]?.plan > 0)
    )
      throw Error('Тест: некорректные данные');
    const quantity = Number(payload.quantity),
      operation = item.operations[payload.operationId],
      createdAt = new Date().toISOString(),
      coefficient = quantity / operation.normPerPerson;
    const result = {
      ...payload,
      quantity,
      eventId: randomUUID(),
      employeeName: employee.name,
      coefficient,
      norm: operation.normPerPerson,
      normDetails: operation.normDetails,
      createdAt,
      dataVersion: ++dataVersion,
    };
    work.set(payload.idempotencyKey, result);
    item.workRecords.push({
      eventId: result.eventId,
      shipmentId: result.shipmentId,
      directionId: result.directionId,
      positionId: result.positionId,
      employeeId: result.employeeId,
      employeeName: result.employeeName,
      operationId: result.operationId,
      operationName: labels[result.operationId],
      quantity,
      norm: result.norm,
      coefficient,
      createdAt,
      source: 'WEB_APP_TEST',
      cancelled: false,
      cancelledAt: '',
      cancellationReason: '',
    });
    operation.fact = (operation.fact || 0) + quantity;
    operation.ratio = operation.fact / operation.plan;
    let worker = item.workers.find((row) => row.id === employee.id);
    if (!worker) {
      worker = {
        ...employee,
        operations: Object.fromEntries(
          operations.map((op) => [
            op.id,
            {
              quantity: 0,
              coefficient: 0,
              coefficientKnown: false,
              eventCount: 0,
            },
          ]),
        ),
      };
      item.workers.push(worker);
    }
    const workerOperation = worker.operations[payload.operationId];
    workerOperation.quantity += quantity;
    workerOperation.coefficient += coefficient;
    workerOperation.coefficientKnown = true;
    workerOperation.eventCount++;
    worker.lastWorkedAt = createdAt;
    item.packingRemaining =
      item.operations.packing.fact === null
        ? null
        : Math.max(
            0,
            item.operations.packing.plan - item.operations.packing.fact,
          );
    item.status =
      item.operations.packing.fact >= item.operations.packing.plan
        ? 'Упаковка завершена'
        : item.operations.packing.fact > 0
          ? 'Упаковка'
          : item.operations.assembly.fact > 0
            ? 'Сборка'
            : 'Порезка';
    if (mode === 'lost-response')
      throw Error('Тест: ответ потерян после сохранения');
    return result;
  }
  throw Error('Unknown local fixture method');
}
const mock = `<script>
window.google={script:{}};
// Each request gets an independent callback chain, just like google.script.run.
Object.defineProperty(google.script,'run',{get(){let ok=()=>{},fail=()=>{};const proxy=new Proxy({}, {get(_,method){if(method==='withSuccessHandler')return fn=>{ok=fn;return proxy};if(method==='withFailureHandler')return fn=>{fail=fn;return proxy};return(...args)=>fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,args,mode:new URLSearchParams(location.search).get('scenario')})}).then(response=>response.json()).then(result=>{if(result.error)fail(new Error(result.error));else ok(result.data)}).catch(fail)}});return proxy}});
</script>`;
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/rpc' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 100000) {
        res.writeHead(413).end();
        return;
      }
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const { method, args, mode } = JSON.parse(body);
      if (mode === 'slow-load' && method === 'getInitialData') await new Promise(resolve => setTimeout(resolve, 5000));
      res.end(JSON.stringify({ data: rpc(method, args, mode) }));
    } catch (error) {
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  let html = readFileSync(source, 'utf8').replace(
    '<script>',
    mock + '<script>',
  );
  html = html.replace(
    '<title>RITM Assembly</title>',
    '<title>RITM Assembly · локальный дизайн</title>',
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
});
const port = Number(process.env.RITM_ASSEMBLY_PREVIEW_PORT || 4327);
server.listen(port, '127.0.0.1', () =>
  console.log(
    'RITM Assembly local fixture: http://127.0.0.1:' + port + ' · test data only',
  ),
);
