function stockCloseArchive_(book) {
  var archive=book.getSheetByName('_RITM_STOCK_ARCHIVE');
  var headers=['Операция','Дата','Лист','Строка','UID','Артикул','План','Данные строки'];
  if(!archive){archive=book.insertSheet('_RITM_STOCK_ARCHIVE');archive.appendRow(headers);archive.hideSheet();}
  if(archive.getLastRow()===0 || archive.getRange(1,1,1,8).getValues()[0].join('|')!==headers.join('|'))
    throw new Error('Структура архива не подтверждена.');
  return archive;
}

function stockCloseBoxMetadata_(sheet,row,values,quantity) {
  var machine=String(values[3]||'').trim().toLowerCase(), xerox=/^(xerox|ксерокс|x|х)$/.test(machine);
  var plan=xerox?quantity/Number(values[13])*Number(values[6]):quantity;
  if(!machine||!Number.isSafeInteger(plan)||plan<=0||typeof values[27]!=='number'||typeof values[28]!=='number'||values[27]<plan||values[28]<plan||values[28]>values[27])
    throw new Error('Печать и порезка не подтверждены.');
  var metadata=sheet.getRange(row+':'+row).getDeveloperMetadata().filter(function(item){return item.getKey()==='RITM_BOX_POSITION';});
  if(metadata.length>1) throw new Error('Неоднозначный идентификатор работы бокса.');
  return metadata;
}

function stockCloseColumns_(department,formulas) {
  var columns=department==='box'?[3,5,6,16,19,20,21,22,23,24,25,26,28,29,30]:[3,5,6,9,16,19,20,21,22,23,24,25,26,27,28,29,30];
  return columns.filter(function(col){
    return col<=formulas.length && (!formulas[col-1]||col===3||(department==='roll'&&col===9)||(department==='box'&&col===24));
  });
}

function stockCloseRowMatches_(row,item) {
  return String(row[4]||'').trim()===item.article && row[15]===item.quantity && String(row[29]||'').trim()===item.uid;
}

// Installed in each dedicated stock workbook. The same lock as the work panel
// protects both the final readiness check and the source row mutation.
function stockCloseGateway_(input, props, department) {
  var op=String(input.operationId||''), uid=String(input.uid||''), article=String(input.article||''), row=Number(input.row), quantity=Number(input.quantity), sheetId=Number(input.sheetId);
  if(!/^[-a-f0-9]{36}$/i.test(op)||!uid||!article||!Number.isSafeInteger(row)||row<5||!Number.isSafeInteger(quantity)||quantity<=0||!Number.isSafeInteger(sheetId))throw new Error('Не подтверждена позиция запасов.');
  var lock=department==='box'?boxLocked_:withDocumentLock_;
  return lock(function(){
    var key='STOCK_CLOSE_'+op, hash=JSON.stringify([department,sheetId,row,uid,article,quantity]), saved=props.getProperty(key);
    if(saved){saved=JSON.parse(saved);if(saved.hash!==hash)throw new Error('Номер операции уже занят.');if(saved.status==='verified')return {ok:true,status:'verified',uid:uid,closedAt:saved.closedAt};return {ok:false,status:'uncertain',message:'Закрытие требует сверки.'};}
    var id=department==='box'?props.getProperty('BOX_STOCK_SOURCE_ID'):'1vzLLRe7oi4IlvzIaWZd08dte7byCkqeXVAL4iSFqhOg';
    var book=SpreadsheetApp.openById(id), sh=book.getSheetById(sheetId);
    if(!sh||['Запасы склад','Срочные 2 этаж'].indexOf(sh.getName())<0||row>sh.getMaxRows())throw new Error('Лист запасов не подтверждён.');
    var range=sh.getRange(row,1,1,sh.getLastColumn()), values=range.getValues()[0], formulas=range.getFormulas()[0];
    if(String(values[4]||'').trim()!==article||values[15]!==quantity||String(values[29]||'').trim()!==uid)throw new Error('Строка изменилась; обновите список.');
    var metadata=[];
    if(department==='box') {
      metadata=stockCloseBoxMetadata_(sh,row,values,quantity);
    } else {
      SpreadsheetApp.setActiveSpreadsheet(book);
      var order=r2GetOrder_(uid,sh.getName(),row),rolls=r2RollsForOrder_(order);
      if(!r2Progress_(order,rolls,'Печать').complete||!r2Progress_(order,rolls,'Резка').complete)throw new Error('Печать и порезка не подтверждены.');
    }
    var archive=stockCloseArchive_(book);
    var closedAt=new Date().toISOString();
    props.setProperty(key,JSON.stringify({hash:hash,status:'writing'}));
    archive.appendRow([op,closedAt,sh.getName(),row,uid,article,quantity,JSON.stringify({values:values,formulas:formulas,boxPositionId:metadata.length?metadata[0].getValue():null})]);
    SpreadsheetApp.flush();
    if(archive.getRange(archive.getLastRow(),1).getValue()!==op)throw new Error('Архив не подтверждён.');
    // Preserve lookup formulas; clear only work-specific cells. Position
    // metadata is removed so the next article receives a new box identity.
    stockCloseColumns_(department,formulas).forEach(function(col){sh.getRange(row,col).clearContent();});
    metadata.forEach(function(m){m.remove();});
    SpreadsheetApp.flush();
    if(sh.getRange(row,5).getValue()!==''||sh.getRange(row,16).getValue()!==''||sh.getRange(row,30).getValue()!=='')throw new Error('Очистка строки не подтверждена.');
    props.setProperty(key,JSON.stringify({hash:hash,status:'verified',closedAt:closedAt}));
    return {ok:true,status:'verified',uid:uid,closedAt:closedAt};
  });
}

// Keep all receipts independent and verify the archive before clearing any row.
function stockCloseBatchGateway_(input,props,department) {
  if(!Array.isArray(input.tasks)||!input.tasks.length||input.tasks.length>24) throw new Error('Список завершения недействителен.');
  var plans=input.tasks, ids=new Set(), positions=new Set();
  plans.forEach(function(item){
    if(!item || !/^[-a-f0-9]{36}$/i.test(item.operationId) || !item.uid || !item.article ||
      !['warehouse','urgent'].includes(item.destination) || !Number.isSafeInteger(item.sheetId) || item.sheetId<0 ||
      !Number.isSafeInteger(item.row) || item.row<5 || item.row>4096 || !Number.isSafeInteger(item.quantity) || item.quantity<=0)
      throw new Error('Не подтверждена позиция запасов.');
    var position=item.sheetId+':'+item.row;
    if(ids.has(item.operationId)||positions.has(position)) throw new Error('В списке повторяется позиция.');
    ids.add(item.operationId);positions.add(position);
  });
  var lock=department==='box'?boxLocked_:withDocumentLock_;
  return lock(function(){
    var results={}, stored=props.getProperties(), groups={}, ready=[];
    function reply(item,status,message,closedAt) {
      results[item.operationId]={operationId:item.operationId,uid:item.uid,status:status,message:message,closedAt:closedAt};
    }
    function response() {
      return {ok:true,status:'close_batch',results:plans.map(function(item){return results[item.operationId];})};
    }
    plans.forEach(function(item){
      var key='STOCK_CLOSE_'+item.operationId;
      var hash=JSON.stringify([department,item.sheetId,item.row,item.uid,item.article,item.quantity]), prior=stored[key];
      if(prior) {
        prior=JSON.parse(prior);
        if(prior.hash!==hash) throw new Error('Номер операции уже занят.');
        if(prior.status==='verified') reply(item,'verified',undefined,prior.closedAt);
        else reply(item,'uncertain','Закрытие требует сверки.');
        return;
      }
      if(!groups[item.sheetId])groups[item.sheetId]=[];
      groups[item.sheetId].push({item:item,key:key,hash:hash});
    });
    if(!Object.keys(groups).length)return response();
    var id=department==='box'?props.getProperty('BOX_STOCK_SOURCE_ID'):'1vzLLRe7oi4IlvzIaWZd08dte7byCkqeXVAL4iSFqhOg';
    var book=SpreadsheetApp.openById(id), rollHistory=null;
    if(department==='roll') {
      SpreadsheetApp.setActiveSpreadsheet(book);
      rollHistory={rolls:r2ReadStore_(true),progress:r2ProgressRows_(true),journal:r2JournalRows_(true)};
    }
    var ranges=[];
    Object.keys(groups).forEach(function(key){
      var group=groups[key], sheet=book.getSheetById(Number(key));
      var sheetName=sheet&&sheet.getName(), width=sheet&&sheet.getLastColumn(), maxRows=sheet&&sheet.getMaxRows();
      if(!['Запасы склад','Срочные 2 этаж'].includes(sheetName) || width<30 ||
        group.some(function(x){return x.item.row>maxRows;})) {
        group.forEach(function(x){reply(x.item,'not_saved','Лист или строки запасов изменились.');});
        return;
      }
      var rows=group.map(function(x){return x.item.row;});
      var first=Math.min.apply(null,rows), length=Math.max.apply(null,rows)-first+1;
      var range=sheet.getRange(first,1,length,width), values=range.getValues(), formulas=range.getFormulas();
      var header=rollHistory?r2HeaderMap_(sheet):null;
      var region={sheet:sheet,first:first,length:length,entries:[]};
      ranges.push(region);
      group.forEach(function(entry){
        var item=entry.item, index=item.row-first, row=values[index], formula=formulas[index];
        var expected=item.destination==='urgent'?'Срочные 2 этаж':'Запасы склад';
        try {
          if(sheetName!==expected || !stockCloseRowMatches_(row,item))
            throw new Error('Строка изменилась. Обновите список.');
          var meta=[];
          if(rollHistory) {
            var order=r2OrderFromValues_(sheet,item.row,header,row), rolls=order&&r2RollsForOrder_(order,rollHistory.rolls);
            if(!order || order.uid!==item.uid || order.article!==item.article || order.orderQty!==item.quantity ||
              !r2Progress_(order,rolls,'Печать',rollHistory).complete || !r2Progress_(order,rolls,'Резка',rollHistory).complete)
              throw new Error('Печать и порезка не подтверждены.');
          } else meta=stockCloseBoxMetadata_(sheet,item.row,row,item.quantity);
          var cols=stockCloseColumns_(department,formula);
          if(![5,16,30].every(function(col){return cols.includes(col);})) throw new Error('Ключевые ячейки строки содержат формулы.');
          entry.metadata=meta;
          entry.backup=JSON.stringify({values:row,formulas:formula,boxPositionId:meta.length?meta[0].getValue():null});
          entry.sheetName=sheetName;
          entry.cells=cols.map(function(col){return (col<=26?String.fromCharCode(64+col):'A'+String.fromCharCode(38+col))+item.row;});
          region.entries.push(entry);
          ready.push(entry);
        } catch(error) {reply(item,'not_saved',String(error.message||error));}
      });
    });
    if(!ready.length)return response();
    var archive=stockCloseArchive_(book), firstArchive=archive.getLastRow()+1, closedAt=new Date().toISOString();
    var writing={};
    ready.forEach(function(entry){writing[entry.key]=JSON.stringify({hash:entry.hash,status:'writing'});});
    props.setProperties(writing);
    var data=ready.map(function(entry){
      var item=entry.item;
      return [item.operationId,closedAt,entry.sheetName,item.row,item.uid,item.article,item.quantity,entry.backup];
    });
    var requiredRows=firstArchive+data.length-1;
    if(requiredRows>archive.getMaxRows()) archive.insertRowsAfter(archive.getMaxRows(),requiredRows-archive.getMaxRows());
    var archiveRange=archive.getRange(firstArchive,1,data.length,8);
    archiveRange.setValues(data);
    SpreadsheetApp.flush();
    var archived=archiveRange.getValues();
    if(data.some(function(row,index){return JSON.stringify(row)!==JSON.stringify(archived[index]);}))
      throw new Error('Архив пакета не подтверждён.');
    ranges.forEach(function(region){
      if(!region.entries.length)return;
      // Manual edits in Sheets are outside the script lock. Recheck the row
      // identity immediately before the grouped clear.
      var latest=region.sheet.getRange(region.first,1,region.length,30).getValues();
      region.entries=region.entries.filter(function(entry){
        if(stockCloseRowMatches_(latest[entry.item.row-region.first],entry.item))return true;
        reply(entry.item,'uncertain','Строка изменилась после архивации. Нужна сверка.');
        return false;
      });
      var cells=region.entries.flatMap(function(entry){return entry.cells;});
      if(cells.length) region.sheet.getRangeList(cells).clearContent();
      region.entries.forEach(function(entry){entry.metadata.forEach(function(item){item.remove();});});
    });
    SpreadsheetApp.flush();
    var verified={};
    ranges.forEach(function(region){
      if(!region.entries.length)return;
      var rows=region.sheet.getRange(region.first,1,region.length,30).getValues();
      region.entries.forEach(function(entry){
        var row=rows[entry.item.row-region.first];
        if(row[4]!==''||row[15]!==''||row[29]!=='') {reply(entry.item,'uncertain','Очистка строки не подтверждена.');return;}
        verified[entry.key]=JSON.stringify({hash:entry.hash,status:'verified',closedAt:closedAt});
        reply(entry.item,'verified',undefined,closedAt);
      });
    });
    if(Object.keys(verified).length)props.setProperties(verified);
    return response();
  });
}
