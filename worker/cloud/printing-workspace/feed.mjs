import { CloudError, json, readJson } from '../access.js';
import { CloudSheetsReader } from '../googleSheets.js';
import { isPrintingDepartment } from './printing-departments.mjs';
import { fields, formatRows, grouped, quote, status } from './workspace-data.mjs';
import { applyBoxContext, prepareCloudWrite, rowIdentity, validSupplyId, writePrinting } from './workspace-write.mjs';
import { callPrintingGateway, parsePrintingConnections } from './workspace-gateway.mjs';

const rollBooks = new Map();
const rollTitles = ['ROLLS_V2','_SYSTEM_ROLLS','ROLLS_V2_PROGRESS','Журнал выпуска'];
const metadataFields = 'spreadsheetId,sheets(properties(title))';
const maximumAge = 45000;

async function readSpreadsheet(reader,documentId,fields,ranges = []) {
  const url = new URL('https://sheets.googleapis.com/v4/spreadsheets/'+documentId);
  url.searchParams.set('fields',fields);
  if (ranges.length) url.searchParams.set('includeGridData','true');
  for (const range of ranges) url.searchParams.append('ranges',range);
  return (await reader.request(url.href)).json();
}

async function readGrid(reader,documentId,ranges,withRowIds = false) {
  const metadata = withRowIds ? ',developerMetadata(metadataKey,metadataValue,location)' : '';
  const reply = await readSpreadsheet(reader,documentId,
    `spreadsheetId,sheets(properties(title),data(rowData(values(effectiveValue,hyperlink)))${metadata})`,ranges);
  return reply.sheets || [];
}

async function readRollBook(reader,documentId,fresh = false) {
  const cached = rollBooks.get(documentId);
  if (!fresh && cached?.expires > Date.now()) return cached.sheets;
  let ranges = cached?.ranges;
  let checked = cached?.checked || 0;
  if (!ranges || Date.now()-checked > 15*60*1000) {
    const metadata = await readSpreadsheet(reader,documentId,metadataFields);
    const existing = new Set((metadata.sheets || []).map(sheet => sheet.properties.title));
    ranges = rollTitles.filter(title => existing.has(title)).map(title => quote(title)+'!A1:Q');
    checked = Date.now();
  }
  const sheets = ranges.length ? await readGrid(reader,documentId,ranges) : [];
  rollBooks.set(documentId,{sheets,ranges,checked,expires:Date.now()+maximumAge});
  return sheets;
}

function connectionFor(bindings,department) {
  try { return parsePrintingConnections(bindings.RITM_PRINTING_WORK_CONNECTIONS)[department]; }
  catch { return null; }
}

async function readBoxContext(connection,orders,fetcher) {
  const responses = [];
  for (let offset=0;offset<orders.length;offset+=500) {
    const batch = await callPrintingGateway(connection,{
      command:'context',sheetId:orders[0].sheetId,items:orders.slice(offset,offset+500).map(rowIdentity),
    },fetcher);
    if (batch?.ok !== true || !Array.isArray(batch.items)) return null;
    responses.push(batch);
  }
  return {ok:true,employees:responses[0].employees,items:responses.flatMap(reply => reply.items)};
}

function previewRows(group, source) {
  return {id:group.id,...formatRows(group),partial:true,writeReady:false,stale:!!source.stale};
}

export async function printingWorkspaceFeed(url,bindings,fetcher,readSnapshot,readModel) {
  const department = url.searchParams.get('department');
  const id = url.searchParams.get('supply');
  if (!isPrintingDepartment(department) || id != null && !validSupplyId(id)) {
    throw new CloudError('invalid_printing_workspace','Укажите участок и существующую поставку.',400);
  }
  const connection = url.searchParams.get('work') === '1' ? connectionFor(bindings,department) : null;
  const boot = url.searchParams.get('boot') === '1';
  const fresh = url.searchParams.get('fresh') === '1';
  const reader = new CloudSheetsReader(bindings,{fetcher});
  const source = await readSnapshot();
  const groups = grouped(source).filter(group => group.department === department);
  if (!id) {
    const supplies = await fields(groups,boot ? undefined : documentId => readRollBook(reader,documentId,fresh));
    const first = boot && (supplies.find(supply => supply.status === 'open') || supplies[0]);
    const preview = first && groups.find(supply => supply.id === first.id);
    return json({supplies,at:source.snapshotAt || source.updatedAt,stale:!!source.stale,
      working:!!connection,readOnly:!connection,supportsSupplyPreview:true,
      ...(preview ? {preview:previewRows(preview,source)} : {})});
  }
  const group = groups.find(supply => supply.id === id);
  if (!group) throw new CloudError('unknown_printing_supply','Поставка отсутствует в текущем снимке РИТМ.',404);
  if (url.searchParams.get('preview') === '1') return json(previewRows(group,source));
  const first = group.orders[0];
  if (!first) return json({rows:[],detailsAvailable:true});
  if (source.stale && source.refreshInProgress) {
    const result = json({...formatRows(group),writeReady:false,partial:true,retryAfterMs:2500});
    result.headers.set('X-RITM-Progress-Pending','1');
    return result;
  }
  const roll = department === 'roll';
  const canWork = connection?.sourceId === first.spreadsheetId && status(group.orders) === 'open' && !source.stale;
  const lastRow = group.orders.reduce((max,order) => Math.max(max,order.row),5);
  try {
    const load = async () => {
      const context = !roll && canWork ? readBoxContext(connection,group.orders,fetcher).catch(() => null) : null;
      const [sheet,related] = await Promise.all([
        readGrid(reader,first.spreadsheetId,[quote(first.sheetName)+'!A1:AZ'+lastRow],!roll && !canWork),
        (roll ? readRollBook(reader,first.spreadsheetId,fresh || canWork && !!readModel)
          : canWork ? Promise.resolve([]) : readGrid(reader,first.spreadsheetId,["'_RITM_BOX_GUARD'!A1:C"])).catch(() => []),
      ]);
      const details = formatRows(group,[...sheet,...related],source.boxPrinting);
      if (!canWork) return {...details,writeReady:false,
        writeMessage:connection && source.stale ? 'РИТМ не подтвердил свежие данные. Обновите поставку.' : ''};
      if (roll) return {...details,writeReady:details.rows.some(row => Array.isArray(row.rolls))};
      try {
        return {...applyBoxContext(details,group,await context),writeReady:true};
      } catch {
        return {...details,writeReady:false,writeMessage:'Журнал бокса недоступен. Обновите поставку.'};
      }
    };
    const details = canWork && readModel ? await readModel.read(group,source,fresh,load) : await load();
    return json(details ?? {...previewRows(group,source),retryAfterMs:1500,retryFresh:false});
  } catch {
    return json({...formatRows(group),writeReady:false,writeMessage:canWork ? 'Данные для записи временно недоступны.' : ''});
  }
}

export async function printingWorkspaceWrite(request,bindings,fetcher,readSnapshot,onChanged,readModel) {
  const input = prepareCloudWrite(await readJson(request,300000));
  if (!input) return json({rejected:true,message:'Проверьте параметры записи.'},400);
  const reject = message => json(input.checking ? {uncertain:true,message} : {rejected:true,message},409);
  const connection = connectionFor(bindings,input.department);
  if (!connection) return reject('Подключение журнала не подтверждено.');
  const source = await readSnapshot();
  if (source.stale) return reject('Данные РИТМ обновляются. Повторите запрос.');
  const group = grouped(source).find(supply => supply.id === input.supplyId && supply.department === input.department);
  const first = group?.orders[0];
  if (first?.spreadsheetId !== connection.sourceId || status(group.orders) !== 'open') {
    return reject('Поставка изменилась или уже завершена. Проверьте журнал в таблице.');
  }
  if (readModel) {
    try { await readModel.invalidate(group); }
    catch { return reject('Не удалось обновить состояние поставки в РИТМ. Повторите запрос.'); }
  }
  try {
    let reply;
    try { reply = await writePrinting(connection,group,input,(link,message) => callPrintingGateway(link,message,fetcher)); }
    finally { await readModel?.invalidate(group).catch(() => {}); }
    if (reply.confirmed || reply.results?.some(item => item.ok) || reply.uncertain) {
      rollBooks.delete(first.spreadsheetId);
      onChanged?.();
    }
    return json(reply);
  } catch {
    rollBooks.delete(first.spreadsheetId);
    onChanged?.();
    return json({uncertain:true,message:'Журнал не вернул подтверждение. Повторите тот же запрос.'},502);
  }
}
