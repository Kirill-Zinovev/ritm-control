// Build bounded cell updates after the caller has re-read the source and
// confirmed the exact row, formulas and readiness snapshot. This function does
// not access Sheets or mutate the user's plans.
export function stockCellRequests(sheetId, changes) {
  if(!Number.isSafeInteger(sheetId)||sheetId<0||!Array.isArray(changes)||!changes.length)throw new Error('Не подтверждён лист запасов.');
  const used=new Set(),requests=[];
  function set(row,column,value){
    const entered=typeof value==='number'?{numberValue:value}:typeof value==='boolean'?{boolValue:value}:{stringValue:String(value??'')};
    requests.push({updateCells:{start:{sheetId,rowIndex:row-1,columnIndex:column-1},rows:[{values:[{userEnteredValue:entered}]}],fields:'userEnteredValue'}});
  }
  function formula(row,column,value){requests.push({updateCells:{start:{sheetId,rowIndex:row-1,columnIndex:column-1},rows:[{values:[{userEnteredValue:{formulaValue:value}}]}],fields:'userEnteredValue'}});}
  for(const change of changes){
    const {row,article,newQuantity,action}=change;
    if(!Number.isSafeInteger(row)||row<5||used.has(row)||!String(article||'').trim()||!Number.isSafeInteger(newQuantity)||newQuantity<=0||!['insert','increase'].includes(action))throw new Error('Не подтверждена строка запасов.');
    used.add(row);
    if(action==='insert'){
      if(!/^ritm-[a-f0-9-]{36}-\d+$/i.test(String(change.uid||'')))throw new Error('Не подтверждён ID новой позиции.');
      if(typeof change.layoutPresent!=='boolean'||!['box','roll'].includes(change.department))throw new Error('Не подтверждён макет или участок новой позиции.');
      const sku=String(article).trim().toUpperCase().replaceAll('"','""');
      set(row,5,article);set(row,6,change.extension||'');set(row,30,change.uid);
      if(change.assemblyCatalog){
        const assigned = value => `=IF(E${row}="";"";${typeof value==='number'?value:JSON.stringify(value??'')})`;
        formula(row,4,assigned(change.machine));
        formula(row,7,assigned(change.sheetsPerUnit));
        formula(row,14,assigned(change.stockMultiplicity));
        formula(row,27,assigned(change.store));
      }
      formula(row,3,`=IF(E${row}="";"";IF(UPPER(TRIM(E${row}))="${sku}";"${change.layoutPresent?'Есть':'Не в таблице макетов'}";"Проверить макет"))`);
      if(change.department==='box'){
        if(!change.assemblyCatalog)formula(row,14,`=IF(E${row}="";"";IFERROR(VLOOKUP(E${row};Cache!B:Q;16;0);VLOOKUP(E${row};'Cache FBO'!B:R;17;0)))`);
        set(row,19,false);set(row,20,false);for(const column of [25,26,28,29])set(row,column,0);
        const plan=`IF(REGEXMATCH(LOWER(TRIM(D${row}));"^(xerox|ксерокс|x|х)$");IFERROR(P${row}/N${row}*G${row};0);P${row})`;
        const line=(name,column)=>`"${name} "&REPT("■";ROUND(MIN(1;${column}${row}/(${plan}))*8;0))&REPT("□";8-ROUND(MIN(1;${column}${row}/(${plan}))*8;0))&" "&TEXT(${column}${row}/(${plan});"0%")`;
        formula(row,24,`=IFERROR(IF(${plan}>0;${line('Печать','AB')}&CHAR(10)&${line('Порезка','AC')};"План не определён");"План не определён")`);
      }else{
        formula(row,9,`=IF($E${row}="";"";IFERROR(--SUBSTITUTE(REGEXEXTRACT(SUBSTITUTE(SUBSTITUTE(LOWER(TRIM($H${row}));"х";"x");"×";"x");"^[0-9]+[,.]?[0-9]*");",";".")/100;""))`);
      }
    } else {
      const ready=change.readiness;
      if(!ready||!['box','roll'].includes(change.department))throw new Error('Не подтверждён пересчёт готовности.');
      if(change.department==='box'){
        if(typeof ready.printing!=='boolean'||typeof ready.cutting!=='boolean')throw new Error('Не подтверждён пересчёт готовности.');
        set(row,19,ready.printing);set(row,20,ready.cutting);
        if(!ready.printing)set(row,22,'');if(!ready.cutting)set(row,23,'');
      } else {
        if(!Number.isFinite(ready.remainingPrint))throw new Error('Не подтверждён остаток печати.');
        for(const [column,stage] of [[19,ready.printing],[20,ready.cutting]]){
          if(!stage||!Number.isInteger(stage.percent)||stage.percent<0||stage.percent>100)throw new Error('Не подтверждён прогресс рулонов.');
          set(row,column,stage.complete?'Готов':'В работе');
          set(row,column+2,'█'.repeat(Math.floor(stage.percent/10))+'░'.repeat(10-Math.floor(stage.percent/10))+' '+stage.percent+'%');
          if(!stage.complete)set(row,column+4,'');
        }
        set(row,25,ready.remainingPrint);
      }
    }
    set(row,16,newQuantity);
  }
  return requests;
}
