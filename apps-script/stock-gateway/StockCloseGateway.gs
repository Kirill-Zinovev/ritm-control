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
      var machine=String(values[3]||'').trim().toLowerCase(), xerox=/^(xerox|ксерокс|x|х)$/.test(machine), plan=xerox?quantity/Number(values[13])*Number(values[6]):quantity;
      if(!machine||!Number.isSafeInteger(plan)||plan<=0||typeof values[27]!=='number'||typeof values[28]!=='number'||values[27]<plan||values[28]<plan||values[28]>values[27])throw new Error('Печать и порезка не подтверждены.');
      metadata=sh.getRange(row+':'+row).getDeveloperMetadata().filter(function(m){return m.getKey()==='RITM_BOX_POSITION';});
      if(metadata.length>1)throw new Error('Неоднозначный идентификатор работы бокса.');
    } else {
      SpreadsheetApp.setActiveSpreadsheet(book);
      var order=r2GetOrder_(uid,sh.getName(),row),rolls=r2RollsForOrder_(order);
      if(!r2Progress_(order,rolls,'Печать').complete||!r2Progress_(order,rolls,'Резка').complete)throw new Error('Печать и порезка не подтверждены.');
    }
    var archive=book.getSheetByName('_RITM_STOCK_ARCHIVE');
    if(!archive){archive=book.insertSheet('_RITM_STOCK_ARCHIVE');archive.appendRow(['Операция','Дата','Лист','Строка','UID','Артикул','План','Данные строки']);archive.hideSheet();}
    if(archive.getLastRow() && archive.getRange(1,1,1,8).getValues()[0].join('|')!=='Операция|Дата|Лист|Строка|UID|Артикул|План|Данные строки')throw new Error('Структура архива не подтверждена.');
    var closedAt=new Date().toISOString();
    props.setProperty(key,JSON.stringify({hash:hash,status:'writing'}));
    archive.appendRow([op,closedAt,sh.getName(),row,uid,article,quantity,JSON.stringify({values:values,formulas:formulas,boxPositionId:metadata.length?metadata[0].getValue():null})]);
    SpreadsheetApp.flush();
    if(archive.getRange(archive.getLastRow(),1).getValue()!==op)throw new Error('Архив не подтверждён.');
    // Preserve lookup formulas; clear only work-specific cells. Position
    // metadata is removed so the next article receives a new box identity.
    var cols=department==='box'?[3,5,6,16,19,20,21,22,23,24,25,26,28,29,30]:[3,5,6,9,16,19,20,21,22,23,24,25,26,27,28,29,30];
    cols.forEach(function(col){if(col<=sh.getLastColumn()&&(!formulas[col-1]||col===3||(department==='roll'&&col===9)||(department==='box'&&col===24)))sh.getRange(row,col).clearContent();});
    metadata.forEach(function(m){m.remove();});
    SpreadsheetApp.flush();
    if(sh.getRange(row,5).getValue()!==''||sh.getRange(row,16).getValue()!==''||sh.getRange(row,30).getValue()!=='')throw new Error('Очистка строки не подтверждена.');
    props.setProperty(key,JSON.stringify({hash:hash,status:'verified',closedAt:closedAt}));
    return {ok:true,status:'verified',uid:uid,closedAt:closedAt};
  });
}
