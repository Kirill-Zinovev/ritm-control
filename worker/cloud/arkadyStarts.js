const value = cell => cell?.effectiveValue?.errorValue ? null : (cell?.effectiveValue?.stringValue ?? cell?.effectiveValue?.numberValue ?? cell?.effectiveValue?.boolValue ?? cell?.userEnteredValue?.stringValue ?? cell?.userEnteredValue?.numberValue ?? cell?.userEnteredValue?.boolValue ?? '');
const esc = name => String(name).replace(/'/g,"''");
const column = index => { let n=index+1,s=''; while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)} return s; };
async function readTable(reader, documentId, descriptor) {
  const count=descriptor.properties.gridProperties?.rowCount, width=descriptor.properties.gridProperties?.columnCount;
  if (!Number.isSafeInteger(count)||count<1||count>50000||!Number.isSafeInteger(width)||width<1||width>100) throw Error('Unconfirmed sheet size');
  const result=await reader.grid(documentId,[`'${esc(descriptor.properties.title)}'!A1:${column(width-1)}${count}`]);
  const found=result.sheets?.find(s=>s.properties?.sheetId===descriptor.properties.sheetId),data=found?.data?.[0];
  if(result.spreadsheetId!==documentId||!data||data.startRow||data.startColumn||!Array.isArray(data.rowData))throw Error('Unconfirmed sheet');
  return data.rowData.map(row=>Array.from({length:width},(_,i)=>value(row.values?.[i])));
}
const norm = x => String(x||'').trim().toUpperCase().replace(/\(OZ\)$/,'').trim();
export async function readArkadyStarts({reader, printing, supplies, watches, now}) {
  const out={};
  const eligible=(supplies||[]).filter(s=>{const c=watches?.[s.id],at=Date.parse(c?.createdAt||'');return c?.priority==='urgent'&&Number.isInteger(c.reminderMinutes)&&c.reminderMinutes>0&&Number.isFinite(at)&&now>=at+c.reminderMinutes*60000;});
  if (!eligible.length) return out;
  const parts=eligible.flatMap(s=>s.parts.map(part=>({s,part,key:`${s.id}:${part.department}`})));
  for (const group of ['box','roll']) {
    const selected=parts.filter(({part})=>part.department===group); if(!selected.length)continue;
    try {
      const sourceId=group+'-printing';
      const sample=printing.sheets.find(s=>s.sourceId===sourceId&&selected.some(x=>x.part.sheetId===s.sheetId));
      if(!sample?.spreadsheetId)continue;
      const documentId=sample.spreadsheetId,meta=await reader.metadata(documentId);
      if(meta.spreadsheetId!==documentId)continue;
      if(group==='box') {
        for(const {s,part,key} of selected){try{
          const descriptor=meta.sheets.find(x=>x.properties?.sheetId===part.sheetId),orders=printing.supplies.filter(o=>o.sourceId===sourceId&&o.sheetId===part.sheetId&&o.assemblyShipmentId===s.id);
          if(!descriptor||!orders.length)continue;
          const data=await readTable(reader,documentId,descriptor),header=data[3]||[],take=header.findIndex(x=>String(x||'').trim().toLocaleLowerCase('ru-RU')==='дата взятия в работу');
          if(take<0)continue;
          let started=false,valid=true;
          for(const order of orders){const row=data[order.row-1];if(!row||norm(row[4])!==norm(order.article)||Number(row[15])!==order.quantity||row[take]===null){valid=false;break}if(row[take]!==''&&row[take]!==false)started=true;}
          if(valid)out[key]=started;
        }catch{/* unknown source, do not notify */}}
      } else {
        const modern=meta.sheets.find(x=>x.properties?.title==='ROLLS_V2'); if(!modern)continue;
        const modernRows=await readTable(reader,documentId,modern),head=modernRows[0]||[];
        if(!['ROLL_ID','ORDER_UID','SHEET_SOURCE'].every((h,i)=>head[i]===h))continue;
        const legacy=meta.sheets.find(x=>x.properties?.title==='_SYSTEM_ROLLS');let legacyUids=[];
        if(legacy){const rows=await readTable(reader,documentId,legacy),headers=rows[0]||[],uid=headers.findIndex(x=>String(x||'').trim().toUpperCase()==='UID');if(uid<0)continue;legacyUids=rows.slice(1).map(r=>String(r[uid]||'')).filter(Boolean);}
        for(const {s,part,key} of selected){const sheet=printing.sheets.find(x=>x.sourceId===sourceId&&x.sheetId===part.sheetId&&x.assemblyShipmentId===s.id),orders=printing.supplies.filter(o=>o.sourceId===sourceId&&o.sheetId===part.sheetId&&o.assemblyShipmentId===s.id);if(!sheet||!orders.length||orders.some(o=>!o.rawUid))continue;
          const uids=new Set(orders.map(o=>String(o.rawUid)));if(uids.size!==orders.length)continue;
          const ambiguous=printing.supplies.some(o=>o.sourceId===sourceId&&o.sheetId!==part.sheetId&&o.rawUid&&uids.has(String(o.rawUid)));
          const created=modernRows.slice(1).some(r=>r[0]&&uids.has(String(r[1]))&&String(r[2])===String(sheet.name))||legacyUids.some(uid=>uids.has(uid));
          if(created)out[key]=true;else if(!ambiguous)out[key]=false;
        }
      }
    } catch { /* stale or unavailable source remains unknown */ }
  }
  return out;
}
