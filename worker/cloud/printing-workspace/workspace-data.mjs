import { isXerox, unitFactor } from './printing-workflow.mjs';
import { rollCutAvailable, shipmentOrderFacts, summarizeShipment } from './shipment-progress.mjs';

const sheetKey = (row) => `${row.spreadsheetId}:${row.sheetId}`;
const departments = { 'roll-printing': 'roll', 'box-printing': 'box' };
export const quote = (name) => "'" + name.replaceAll("'", "''") + "'";
const scalar = (c) => c?.effectiveValue?.stringValue ?? c?.effectiveValue?.numberValue ?? c?.effectiveValue?.boolValue ?? '';
const grid = (block) => (block?.rowData || []).map(row => (row.values || []).map(scalar));
const norm = (s) => String(s ?? '').trim().toLocaleLowerCase('ru');

function detailUrl(row) {
  if (!/^[A-Za-z0-9_-]+$/.test(row.spreadsheetId) || !Number.isInteger(row.sheetId)) return '';
  return `https://docs.google.com/spreadsheets/d/${row.spreadsheetId}/edit#gid=${row.sheetId}${row.row > 0 ? '&range=A'+row.row : ''}`;
}

export function grouped(data) {
  const orders = data.supplies.filter(row => departments[row.sourceId]);
  const groups = new Map(data.sheets.filter(row => departments[row.sourceId]).map(sheet => [sheetKey(sheet), { id: sheetKey(sheet), name: sheet.name, department: departments[sheet.sourceId], orders: [], sourceUrl: detailUrl(sheet) }]));
  for (const row of orders) groups.get(sheetKey(row))?.orders.push(row);
  return [...groups.values()];
}

export function status(rows) {
  if (rows.length && rows.every(r => r.productionTabComplete === true && r.quantity > 0 && r.printProgress >= r.quantity && r.cutProgress >= r.quantity)) return 'completed';
  if (rows.some(r => r.productionTabComplete === false || (r.productionTabComplete === true && ((r.printProgress != null && r.printProgress < r.quantity) || (r.cutProgress != null && r.cutProgress < r.quantity))))) return 'open';
  return 'unknown';
}

export async function fields(groups, readRollBook) {
  const rollLookups = new Map();
  for (const group of groups) {
    const book = group.orders[0]?.spreadsheetId;
    if (readRollBook && group.department === 'roll' && book && !rollLookups.has(book)) {
      rollLookups.set(book, Promise.resolve().then(() => readRollBook(book)).then(lookupRolls).catch(() => null));
    }
  }
  return Promise.all(groups.map(async ({orders,...supply}) => {
    const lookup = await rollLookups.get(orders[0]?.spreadsheetId);
    const progress = summarizeShipment(orders.map(order => {
      const facts = shipmentOrderFacts(order);
      return supply.department !== 'roll' ? facts : {
        ...facts, cutAvailable:rollCutAvailable(lookup?.(order),facts.printed,facts.cut),
      };
    }));
    return {...supply,status:status(orders),count:orders.length,progress};
  }));
}

const qty = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export const rowKey = order => order.uid + ':' + order.row;

function lookupRolls(sheets) {
  const byName = new Map(sheets.map(sheet => [sheet.properties.title,sheet.data?.[0]]));
  if (!byName.has('ROLLS_V2') && !byName.has('_SYSTEM_ROLLS')) return () => null;
  const index = (name, key) => {
    const entries = new Map();
    for (const row of grid(byName.get(name)).slice(1)) {
      const id = key(row);
      if (id == null) continue;
      const existing = entries.get(id);
      if (existing) existing.push(row);
      else entries.set(id,[row]);
    }
    return entries;
  };
  const orderKey = (uid, sheet, article) => JSON.stringify([uid,sheet,article]);
  const rollV2 = index('ROLLS_V2', row => row[0] ? orderKey(row[1],row[2],row[4]) : null);
  const legacy = index('_SYSTEM_ROLLS', row => row[8] ? row[0] : null);
  const indexJournal = (name,idCol,opCol,qtyCol) => {
    const entries = new Map();
    for (const entry of grid(byName.get(name)).slice(1)) {
      if (!entry[idCol]) continue;
      const operation = norm(entry[opCol]).replace(/^порезка$/, 'резка');
      const key = JSON.stringify([entry[idCol],operation]);
      entries.set(key, (entries.get(key) || 0) + (Number(entry[qtyCol]) || 0));
    }
    return entries;
  };
  const progress = indexJournal('ROLLS_V2_PROGRESS',1,6,9);
  const journal = indexJournal('Журнал выпуска',14,3,9);
  const completed = value => [true,1,'true','1','да','готов'].includes(typeof value === 'string' ? norm(value) : value);
  const row = (id,name,number,quantity,printed,cut,printEmployee = '') => {
    const fact = (operation, ready) => {
      const key = JSON.stringify([id,operation]);
      return Math.max(0, ready ? journal.get(key) ?? progress.get(key) ?? quantity : progress.get(key) ?? 0);
    };
    return {id,name,number,quantity,printed:fact('печать',completed(printed)),cut:fact('резка',completed(cut)),printEmployee};
  };
  return order => {
    const uid = order.rawUid || order.uid;
    const v2 = rollV2.get(orderKey(uid,order.sheetName,order.article)) || [];
    const seen = new Set(v2.flatMap(r => [r[0],r[16]]).filter(Boolean));
    const old = (legacy.get(uid) || []).filter(r => !seen.has(r[8]));
    return [...v2.map(r => row(r[0],r[5],r[6],Number(r[11]),r[7],r[8],r[13])),
      ...old.map(r => ({...row(r[8],r[1],r[2],Number(r[7]),r[3],r[4]),legacyOnly:true}))].filter(r => r.quantity > 0);
  };
}

export function formatRows(group, sheets = [], boxJournal = null) {
  const byName = new Map(sheets.map(sheet => [sheet.properties.title, sheet.data?.[0]]));
  const raw = grid(byName.get(group.name));
  const rowHeader = (names) => raw.slice(0,7).map(head=>head.findIndex(v=>names.includes(norm(v)))).find(n=>n>=0) ?? -1;
  const material = rowHeader(['материал', 'материал печати']);
  const layout = rowHeader(['макет', 'наличие макета', 'макеты']);
  const extension = rowHeader(['расширение печати','расширения','расширение']);
  const cutter = rowHeader(['код сотрудника порезки','сотрудник порезки','резчик']);
  const taken = rowHeader(['взяли в работу','взяли в рабоу','взят в работу']);
  const takenAt = rowHeader(['дата взятия в работу']);
  const article = rowHeader(['артикул']);
  const guard = grid(byName.get('_RITM_BOX_GUARD'));
  const guardAvailable = guard[0]?.slice(0,3).join('|') === 'positionId|sheetId|taken';
  const guards = new Map(guard.slice(1).map(([id,sheetId,value])=>[`${sheetId}:${id}`,qty(value)]));
  const rowIds = new Map();
  for (const entry of sheets.find(s => s.properties.title === group.name)?.developerMetadata || []) {
    const range = entry.location?.dimensionRange;
    if (entry.metadataKey !== 'RITM_BOX_POSITION' || range?.dimension !== 'ROWS' ||
        range.endIndex !== range.startIndex + 1) continue;
    const n = range.startIndex + 1;
    rowIds.set(n, rowIds.has(n) ? null : entry.metadataValue);
  }
  const journalIds = new Map();
  const articleCounts = new Map();
  for (const order of group.orders) {
    articleCounts.set(order.article, (articleCounts.get(order.article) || 0) + 1);
  }
  // Bound Apps Script row metadata can be private to its Google project.
  // Existing journal identities are a fallback only on an unambiguous live row.
  if (group.department === 'box' && boxJournal?.status === 'available') {
    const first = group.orders[0];
    for (const entry of [...boxJournal.events || [], ...boxJournal.cutEvents || []]) {
      if (entry.spreadsheetId !== first?.spreadsheetId || entry.sheetId !== first.sheetId ||
          entry.shipment !== group.name || !entry.positionId || articleCounts.get(entry.article) !== 1) continue;
      const ids = journalIds.get(entry.article) || new Set();
      ids.add(entry.positionId);
      journalIds.set(entry.article, ids);
    }
  }

  function boxTaken(order, row, rawRow) {
    if (!rawRow.length || norm(rawRow[article]) !== norm(order.article)) return null;
    if (isXerox(row) && unitFactor(row,'sheets') == null) return null;
    const matched = journalIds.get(order.article);
    const positionId = rowIds.has(order.row) ? rowIds.get(order.row) :
      matched?.size === 1 ? matched.values().next().value : null;
    const key = `${order.sheetId}:${positionId}`;
    if (positionId && guards.has(key)) {
      const saved = guards.get(key);
      return saved == null ? null : saved * (isXerox(row) ? unitFactor(row,'sheets') : 1);
    }
    if (rawRow[taken] === true) return row.plan;
    if (rowIds.has(order.row) && (!positionId || !guardAvailable)) return null;
    if (takenAt >= 0 && !rawRow[takenAt]) return 0;
    return null;
  }
  const rollRows = group.department === 'roll' ? lookupRolls(sheets) : () => null;
  return {detailsAvailable: sheets.length>0, rows: group.orders.map(order=>{
    const rawRow=raw[order.row-1] || [];
    const layoutText=norm(rawRow[layout]);
    const link=byName.get(group.name)?.rowData?.[order.row-1]?.values?.[layout]?.hyperlink;
    const layoutState=link || /^(?:есть(?:\s|$)|готов)/iu.test(layoutText) ? 'available' :
      /нет макета|не в таблице макетов|^нет$/i.test(layoutText) ? 'missing' : 'unknown';
    const row = {
      id:rowKey(order), article:order.article, name:order.productName || '', photo:order.photoUrl || '',
      machine: order.machine || order.planningMachine || '', material:String(order.material || rawRow[material] || ''),
      extension:String(order.extension || rawRow[extension] || ''), layout: layoutState,
      layoutUrl: /^https:\/\//.test(link||'') ? link : '', plan:order.quantity,
      printed:qty(order.printProgress), cut:qty(order.cutProgress),
      sheetsInProduct:qty(order.sheetsInProduct), multiplicity:qty(order.multiplicity),
      url:detailUrl(order), rolls:rollRows(order),
      cutEmployeeCode:group.department==='roll' && norm(rawRow[article]) === norm(order.article) ?
        String(rawRow[cutter] ?? '') : null,
    };
    return group.department==='box' ? {...row, taken:boxTaken(order,row,rawRow)} : row;
  })};
}

