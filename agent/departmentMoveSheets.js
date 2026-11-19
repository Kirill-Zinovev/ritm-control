const key = x => String(x || '').trim().toUpperCase().replace(/\(OZ\)$/u, '');
const val = c => c?.effectiveValue?.stringValue ?? c?.effectiveValue?.numberValue ?? c?.effectiveValue?.boolValue ?? c?.userEnteredValue?.stringValue ?? c?.userEnteredValue?.numberValue ?? c?.userEnteredValue?.boolValue ?? '';
const fail = message => {throw Object.assign(new Error(message),{code:'production_move_conflict',status:409});};

// Read from the production writers, never from the UI's potentially stale snapshot.
export async function inspectDepartmentMove({input, writers, registry, readBoxJournal, legacyLinks=[], readLegacyComposition, inspection}) {
  const inspectionKey=JSON.stringify([input.shipmentId,input.sourceDepartment||'box']);
  let prepared=inspection?.prepared;
  if(prepared&&inspection.key!==inspectionKey)fail('Изменилась поставка пакета.');
  if(!prepared){
  let supply = registry.find(s => s.id === input.shipmentId), legacy=false;
  if (!supply) {
    const match=/^RITM-ROLL-(\d+)$/.exec(input.shipmentId||'');
    const links=match?legacyLinks.filter(l=>l.targetRollSheetId===Number(match[1])):[];
    if(links.length!==1)fail('Не подтверждена однозначная связь старой поставки с боксом.');
    const link=links[0];
    if(!Number.isSafeInteger(link.boxSheetId)||!link.name)fail('Некорректная связь старой поставки.');
    supply={id:input.shipmentId,name:link.name,parts:[{department:'roll',documentId:writers.roll.documentId,sheetId:Number(match[1]),name:link.name},{department:'box',documentId:writers.box.documentId,sheetId:link.boxSheetId,name:link.name}]};
    legacy=true;
  }
  const box = supply.parts.find(p => p.department === 'box');
  const roll = supply.parts.find(p => p.department === 'roll');
  if (!box || !roll) fail('Для переноса нужны оба участка этой поставки.');
  const from=input.sourceDepartment||'box',to=from==='box'?'roll':'box';
  if(!['box','roll'].includes(from))fail('Неизвестный исходный участок.');
  const rows = {};
  const manifests = [];
  await Promise.all([['box',box],['roll',roll]].map(async ([department, part], index) => {
    const writer = writers[department];
    const meta = (await writer.metadata()).find(s => s.sheetId === part.sheetId && s.title === (part.name || supply.name));
    if (!meta || meta.hidden || meta.gridProperties?.rowCount > 4096) fail('Не подтверждён производственный лист.');
    const [manifest, grid] = await Promise.all([writer.manifest(part.sheetId),writer.grid(meta.title,Math.max(meta.gridProperties.rowCount,504))]);
    if (legacy ? manifest!==null : !manifest?.ready || manifest.id !== supply.id) fail('Связь участков поставки не подтверждена.');
    manifests[index] = manifest;
    if (!grid.data?.length || grid.data.some(b => (b.startColumn || 0) !== 0)) fail('Не подтверждены колонки производственного листа.');
    if (department === 'box') {
      const header = grid.data[0].rowData?.[3]?.values || [];
      if (val(header[20]) !== 'Дата взятия в работу' || !String(val(header[27])).startsWith('Напечатано годных')) fail('Формат бокса не поддерживает безопасный перенос.');
      writer.configureLayout?.(true);
    }
    const acHeader=String(val(grid.data[0].rowData?.[3]?.values?.[28])).trim().toLowerCase();
    const legacyUidInAc=!acHeader||/^(uid|id|идентификатор|идентификатор позиции)$/.test(acHeader);
    rows[department] = (grid.data || []).flatMap(block => (block.rowData || []).flatMap((r,i) => {
      if(i+(block.startRow||0)<4)return [];
      const cells=r.values||[],generated=cells.slice(4).map(val).map(v=>String(v).trim()).filter(v=>/^ritm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$/i.test(v));
      if(generated.length>1)fail('В строке несколько идентификаторов Assembly.');
      return [{row:i+(block.startRow||0)+1,cells,assemblyUid:generated[0]||(legacyUidInAc?String(val(cells[28])).trim():'')}];
    }));
  }));
  if (JSON.stringify(manifests[0]) !== JSON.stringify(manifests[1])) fail('Участки содержат разные версии поставки.');
  if(legacy){
    if(typeof readLegacyComposition!=='function')fail('Не удалось сверить историю старой поставки.');
    const composition=await readLegacyComposition(supply);
    verifyLegacyMoveComposition(supply,rows,composition);
  }
    prepared={supply,legacy,box,roll,from,to,rows,manifests};
    if(inspection){inspection.key=inspectionKey;inspection.prepared=prepared;}
  }
  const {supply,legacy,box,roll,from,to,rows,manifests}=prepared;
  const matches=rows[from].filter(r=>key(val(r.cells[4]))===key(input.article));
  if(matches.length!==1) fail('Исходный артикул отсутствует или повторяется.');
  const source=matches[0], writer=writers[from];
  const uid=String(val(source.cells[writer.layout.uid-1]));
  const rawUid=String(input.uid).replace(new RegExp('^'+(from==='box'?box:roll).sheetId+'::'),'');
  if((uid?uid!==rawUid:!(legacy&&from==='box'&&rawUid==='row:'+source.row)) || val(source.cells[15])!==input.quantity) fail('Артикул или количество изменились.');
  if(rows[to].some(r=>key(val(r.cells[4]))===key(input.article))) fail('Артикул уже есть на участке назначения.');
  // Any recorded start, completion, good output, defect or surplus blocks moving.
  if(from==='box'&&([18,19].some(c=>val(source.cells[c])===true) || [20,21,22].some(c=>val(source.cells[c])!=='') || [24,25,27,28].some(c=>val(source.cells[c])!=='' && val(source.cells[c])!==0))) fail('По артикулу уже начата работа в боксе.');
  const journal=from==='box'?await readBoxJournal():[];
  if(!Array.isArray(journal)) fail('Журнал бокса не удалось подтвердить.');
  // Journal columns: document E, sheet F, article H, action K. Even a
  // cancelled event is conservatively retained as evidence of started work.
  if(journal.some(r=>String(r[4])===String(writer.documentId) && Number(r[5])===box.sheetId && key(r[7])===key(input.article))) fail('В журнале есть работа по этому артикулу.');
  return {shipment:supply,box,roll,from,to,legacy,manifest:legacy?{version:1,id:supply.id,name:supply.name,revision:input.operationId,parts:supply.parts.map(({department,documentId,sheetId})=>({department,documentId,sheetId})),ready:true}:manifests[0],source:{row:source.row,uid,article:val(source.cells[4]),quantity:input.quantity,cells:source.cells},workConfirmed:true};
}

// The linked manifest uses the existing legacy shipment identity. Verify every
// Assembly position before adopting it, so historical work keeps its exact IDs.
export function verifyLegacyMoveComposition(supply,rows,composition){
  if(!Array.isArray(composition))fail('Не подтверждён состав Assembly старой поставки.');
  const expected=new Map();
  for(const department of ['roll','box'])for(const row of rows[department]){
    const article=String(val(row.cells[4])).trim();if(!article)continue;
    const uid=row.assemblyUid??String(val(row.cells[29])).trim();
    const part=supply.parts.find(p=>p.department===department);
    const id=supply.id+(department==='box'?'|box:'+part.sheetId:'')+'|'+(uid?'uid:'+uid:'row:'+row.row)+'|'+article;
    if(expected.has(id))fail('Повтор позиции старой поставки.');
    expected.set(id,{article,quantity:val(row.cells[15])});
  }
  const actual=composition.filter(r=>r[0]===supply.id);
  const seen=new Set();
  if(actual.length!==expected.size)fail('Состав Assembly отличается от производственных листов. Обновите поставку перед переносом.');
  for(const row of actual){const entry=expected.get(row[3]);if(!entry||seen.has(row[3])||entry.article!==row[4]||entry.quantity!==row[9])fail('Идентификаторы или план Assembly изменились. Перенос остановлен для сохранения истории.');seen.add(row[3]);}
}
