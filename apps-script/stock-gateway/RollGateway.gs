// Dedicated stock workbook only. The lock is shared with roll operations.
function setupStockGateway(){
  var props=PropertiesService.getScriptProperties(),token=Utilities.getUuid()+Utilities.getUuid();
  props.setProperty('STOCK_GATEWAY_TOKEN',token);
  SpreadsheetApp.openById('1TTFCNPc5n4564FLhmk1sOCyUaiNApCAu8v_-LLdOJhE').getSheets()[0].getRange('A2').setValue(token);
  return 'Подключение рулонов подготовлено.';
}
function doPost(e) {
  try {
    var input=JSON.parse(e.postData.contents),props=PropertiesService.getScriptProperties(),token=props.getProperty('STOCK_GATEWAY_TOKEN');
    if(!token||input.token!==token)throw new Error('Доступ не подтверждён.');
    var result=input.action==='health'?stockGatewayHealth_():input.action==='close'?stockCloseGateway_(input,props,'roll'):
      input.action==='closeBatch'?stockCloseBatchGateway_(input,props,'roll'):stockGatewayApply_(input,props);
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch(error) {return ContentService.createTextOutput(JSON.stringify({ok:false,message:String(error.message||error)})).setMimeType(ContentService.MimeType.JSON);}
}
function stockGatewayHealth_(){return withDocumentLock_(function(){var book=SpreadsheetApp.openById('1vzLLRe7oi4IlvzIaWZd08dte7byCkqeXVAL4iSFqhOg');SpreadsheetApp.setActiveSpreadsheet(book);['Запасы склад','Срочные 2 этаж'].forEach(function(name){var sheet=book.getSheetByName(name);if(!sheet||!r2IsTargetSheet_(sheet))throw new Error('Лист запасов не подтверждён.');r2HeaderMap_(sheet);});return {ok:true,status:'ready',panelCheck:r2StockPanelHealth_()};});}
function stockGatewayHash_(data){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(data),Utilities.Charset.UTF_8).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
function stockCatalogInsert_(sh,row,item,write){
  if(item.assemblyCatalog!==true)return;
  var machine=String(item.machine||'').trim(),store=String(item.store||'');
  var validNumber=function(value){return value==null||Number.isSafeInteger(value)&&value>0;};
  if(!/^(?:2-GO|УФ|УФ\s+БЕЛ\.|УФ\.\s+БЕЛ|УФ\s+БЕЛЫЙ|УФ\s+ДВУСТОРОННИЙ)$/i.test(machine)||!/^(?:[0-9]{1,3})?$/.test(store)||
     !validNumber(item.sheetsPerUnit)||!validNumber(item.stockMultiplicity))
    throw new Error('Не подтверждены параметры новой строки из справочника Assembly.');
  var details=item.stockDetails,photo=String(item.photoUrl||'');
  if(details && (![details.size,details.printFolder].every(function(value){return typeof value==='string'&&value.length<=500;}) ||
    (photo && (photo.length>2000 || !/^https:\/\//.test(photo)))))
    throw new Error('Не подтверждены фото или данные печати из справочника Assembly.');
  if(!write){
    var headers=[[4,'станок'],[7,'кол-во листов'],[14,'кратность'],[27,'магазин']];
    if(details)headers.push([2,'фото'],[8,'размер'],[13,'папка печати']);
    headers.forEach(function(pair){
      if(String(sh.getRange(4,pair[0]).getValue()).trim().toLowerCase()!==pair[1])throw new Error('Изменились заголовки печати.');
    });
    if(sh.getRange(row,27).getValue()!==''&&!sh.getRange(row,27).getFormula())throw new Error('Магазин новой строки уже заполнен.');
    return;
  }
  var quoted=function(value){return '"'+String(value==null?'':value).replace(/"/g,'""')+'"';};
  var assigned=function(value){return '=IF(E'+row+'="";"";'+(typeof value==='number'?value:quoted(value))+')';};
  sh.getRange(row,4).setFormula(assigned(machine));
  sh.getRange(row,7).setFormula(assigned(item.sheetsPerUnit));
  sh.getRange(row,14).setFormula(assigned(item.stockMultiplicity));
  sh.getRange(row,27).setFormula(assigned(store));
  if(details){
    sh.getRange(row,2).setFormula(photo?'=IF(E'+row+'="";"";IFERROR(IMAGE('+quoted(photo)+');""))':assigned(''));
    sh.getRange(row,8).setFormula(assigned(details.size));
    sh.getRange(row,13).setFormula(assigned(details.printFolder));
  }
}
function stockGatewayApply_(input,props){
  if(!/^[-a-f0-9]{36}$/i.test(String(input.operationId||''))||!Array.isArray(input.entries)||!input.entries.length||input.entries.length>500)throw new Error('Неверные параметры операции.');
  var hash=stockGatewayHash_([input.sheetId,input.entries]),key='STOCK_OP_'+input.operationId;
  return withDocumentLock_(function(){
    var saved=props.getProperty(key);if(saved){saved=JSON.parse(saved);if(saved.hash!==hash)throw new Error('Номер операции уже занят.');return saved.status==='verified'?{ok:true,status:'verified'}:{ok:false,status:'uncertain',message:'Результат требует сверки.'};}
    var book=SpreadsheetApp.openById('1vzLLRe7oi4IlvzIaWZd08dte7byCkqeXVAL4iSFqhOg'),sh=book.getSheetById(Number(input.sheetId));
    if(!sh||['Запасы склад','Срочные 2 этаж'].indexOf(sh.getName())<0)throw new Error('Лист запасов не подтверждён.');
    SpreadsheetApp.setActiveSpreadsheet(book);var used={};
    input.entries.forEach(function(item){var row=Number(item.row),before=Number(item.previousQuantity),after=Number(item.newQuantity);
      if(!Number.isSafeInteger(row)||row<5||row>sh.getMaxRows()||used[row]||!Number.isSafeInteger(after)||after<=0)throw new Error('Не подтверждена строка запасов.');used[row]=true;
      if(item.stockDetails && (!Number.isSafeInteger(item.stockMultiplicity) || item.stockMultiplicity<=0 || after%item.stockMultiplicity))
        throw new Error('Итоговый план не соответствует кратности рулонной печати из справочника Assembly.');
      if(!/^[A-Za-z0-9][A-Za-z0-9._() -]{0,119}$/.test(String(item.article||''))||/^[=+@-]/.test(String(item.extension||'')))throw new Error('Не подтверждены данные артикула.');
      var values=sh.getRange(row,1,1,30).getValues()[0],sku=String(values[4]||'').trim();
      if(item.action==='increase'){
        if(sku!==item.article||values[15]!==before||after<=before||!values[29])throw new Error('План или идентификатор изменился.');
        var order=r2GetOrder_(String(values[29]),sh.getName(),row);if(order.article!==sku)throw new Error('Артикул рулона не подтверждён.');
      }else if(item.action==='insert'){
        stockCatalogInsert_(sh,row,item,false);
        if(sku||values[15]!==''||!/^ritm-[-a-f0-9]{36}-\d+$/i.test(String(item.uid||''))||typeof item.layoutPresent!=='boolean')throw new Error('Строка занята или данные позиции не подтверждены.');
        [4,7,8,10,11].forEach(function(col){if(!sh.getRange(row,col).getFormula())throw new Error('В строке не подтверждены формулы.');});
        [3,5,6,9,16,30].forEach(function(col){if(sh.getRange(row,col).getValue()!==''||sh.getRange(row,col).getFormula())throw new Error('Строка содержит данные.');});
      }else throw new Error('Неизвестное действие.');
    });
    if(input.dryRun===true)return {ok:true,status:'validated'};
    props.setProperty(key,JSON.stringify({hash:hash,status:'writing'}));
    input.entries.forEach(function(item){var row=Number(item.row),qty=Number(item.newQuantity);
      if(item.action==='insert'){
        sh.getRange(row,5).setValue(item.article);sh.getRange(row,6).setValue(item.extension||'');sh.getRange(row,30).setValue(item.uid);
        stockCatalogInsert_(sh,row,item,true);
        var sku=String(item.article).trim().toUpperCase().replace(/"/g,'""');
        sh.getRange(row,3).setFormula('=IF(E'+row+'="";"";IF(UPPER(TRIM(E'+row+'))="'+sku+'";"'+(item.layoutPresent?'Есть':'Не в таблице макетов')+'";"Проверить макет"))');
        sh.getRange(row,9).setFormula('=IF($E'+row+'="";"";IFERROR(--SUBSTITUTE(REGEXEXTRACT(SUBSTITUTE(SUBSTITUTE(LOWER(TRIM($H'+row+'));"х";"x");"×";"x");"^[0-9]+[,.]?[0-9]*");",";".")/100;""))');
      }
      sh.getRange(row,16).setValue(qty);SpreadsheetApp.flush();
      if(item.action==='increase'){
        var uid=String(sh.getRange(row,30).getValue()),order=r2GetOrder_(uid,sh.getName(),row);
        if(!r2UpdateOrderProgress_(order))r2WriteIfNoFormula_(sh,row,r2HeaderMap_(sh).printRemaining,qty);
      }
    });
    SpreadsheetApp.flush();input.entries.forEach(function(item){var row=Number(item.row);if(sh.getRange(row,5).getValue()!==item.article||sh.getRange(row,16).getValue()!==Number(item.newQuantity))throw new Error('Запись не подтверждена.');});
    props.setProperty(key,JSON.stringify({hash:hash,status:'verified'}));return {ok:true,status:'verified'};
  });
}
