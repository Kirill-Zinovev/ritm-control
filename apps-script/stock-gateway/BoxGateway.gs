// Dedicated stock workbook only. Every mutation is serialized with boxLocked_.
function setupStockGateway(){
  var props=PropertiesService.getScriptProperties(),token=Utilities.getUuid()+Utilities.getUuid();
  props.setProperty('STOCK_GATEWAY_TOKEN',token);
  SpreadsheetApp.openById('1TTFCNPc5n4564FLhmk1sOCyUaiNApCAu8v_-LLdOJhE').getSheets()[0].getRange('A1').setValue(token);
  return 'Подключение бокса подготовлено.';
}
function doPost(e) {
  try {
    var input=JSON.parse(e.postData.contents), props=PropertiesService.getScriptProperties();
    var token=props.getProperty('STOCK_GATEWAY_TOKEN');
    if(!token || input.token!==token)throw new Error('Доступ не подтверждён.');
    var result=input.action==='health'?stockGatewayHealth_(props):input.action==='close'?stockCloseGateway_(input,props,'box'):
      input.action==='closeBatch'?stockCloseBatchGateway_(input,props,'box'):stockGatewayApply_(input,props);
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch(error) { return ContentService.createTextOutput(JSON.stringify({ok:false,message:String(error.message||error)})).setMimeType(ContentService.MimeType.JSON); }
}
function stockGatewayHealth_(props){return boxLocked_(function(){var book=SpreadsheetApp.openById(props.getProperty('BOX_STOCK_SOURCE_ID'));var names=['Запасы склад','Срочные 2 этаж'];names.forEach(function(name){var sheet=book.getSheetByName(name);if(!sheet||!boxEligible_(sheet))throw new Error('Лист запасов не подтверждён.');boxSchema_(sheet);});return {ok:true,status:'ready'};});}

function stockMultiplicityFormula_(row){return '=IF(E'+row+'=\"\";\"\";IFERROR(VLOOKUP(E'+row+';Cache!B:Q;16;0);VLOOKUP(E'+row+';\'Cache FBO\'!B:R;17;0)))';}

function stockCatalogInsert_(sh,row,item,write){
  if(item.assemblyCatalog!==true)return;
  var machine=String(item.machine||'').trim(),store=String(item.store||'');
  var validNumber=function(value){return value==null||Number.isSafeInteger(value)&&value>0;};
  if(!/^(?:XEROX|DTF|УФ\s+ПЛАНШЕТ)$/i.test(machine)||!/^(?:[0-9]{1,3})?$/.test(store)||
     !validNumber(item.sheetsPerUnit)||!validNumber(item.stockMultiplicity)||
     (/^XEROX$/i.test(machine)&&(!item.sheetsPerUnit||!item.stockMultiplicity||
       !Number.isSafeInteger(item.newQuantity*item.sheetsPerUnit/item.stockMultiplicity))))
    throw new Error('Не подтверждены параметры новой строки из справочника Assembly.');
  if(!write){
    [[4,'станок'],[7,'кол-во листов'],[14,'кратность'],[27,'магазин']].forEach(function(pair){
      if(String(sh.getRange(4,pair[0]).getValue()).trim().toLowerCase()!==pair[1])throw new Error('Изменились заголовки печати.');
    });
    if(sh.getRange(row,27).getValue()!==''&&!sh.getRange(row,27).getFormula())throw new Error('Магазин новой строки уже заполнен.');
    return;
  }
  var assigned=function(value){return '=IF(E'+row+'="";"";'+JSON.stringify(value==null?'':value)+')';};
  sh.getRange(row,4).setFormula(assigned(machine));
  sh.getRange(row,7).setFormula(assigned(item.sheetsPerUnit));
  sh.getRange(row,14).setFormula(assigned(item.stockMultiplicity));
  sh.getRange(row,27).setFormula(assigned(store));
}

function stockGatewayApply_(input,props) {
  if(!/^[-a-f0-9]{36}$/i.test(String(input.operationId||''))||!Array.isArray(input.entries)||!input.entries.length||input.entries.length>500)throw new Error('Неверные параметры операции.');
  var hash=boxHash_([input.sheetId,input.entries]), key='STOCK_OP_'+input.operationId;
  return boxLocked_(function(){
    var existing=props.getProperty(key);
    if(existing){var saved=JSON.parse(existing);if(saved.hash!==hash)throw new Error('Номер операции уже занят.');return saved.status==='verified'?{ok:true,status:'verified'}:{ok:false,status:'uncertain',message:'Результат требует сверки.'};}
    var book=SpreadsheetApp.openById(props.getProperty('BOX_STOCK_SOURCE_ID')),sh=book.getSheetById(Number(input.sheetId));
    if(!sh||['Запасы склад','Срочные 2 этаж'].indexOf(sh.getName())<0)throw new Error('Лист запасов не подтверждён.');
    var used={};
    input.entries.forEach(function(item){
      var row=Number(item.row),before=Number(item.previousQuantity),after=Number(item.newQuantity);
      if(!Number.isSafeInteger(row)||row<5||row>sh.getMaxRows()||used[row]||!Number.isSafeInteger(after)||after<=0)throw new Error('Не подтверждена строка запасов.');
      if(!/^[A-Za-z0-9][A-Za-z0-9._() -]{0,119}$/.test(String(item.article||''))||/^[=+@-]/.test(String(item.extension||'')))throw new Error('Не подтверждены данные артикула.');
      used[row]=true;var values=sh.getRange(row,1,1,30).getValues()[0],sku=String(values[4]||'').trim();
      if(item.action==='increase'){
        if(sku!==item.article||values[15]!==before||after<=before)throw new Error('План изменился; повторите проверку.');
        var machine=String(values[3]||'').trim().toLowerCase(),xerox=/^(xerox|ксерокс|x|х)$/.test(machine),plan=xerox?after/Number(values[13])*Number(values[6]):after;
        if(!machine||!Number.isSafeInteger(plan)||plan<=0||!Number.isFinite(values[27])||!Number.isFinite(values[28])||values[28]>values[27]||values[27]>plan)throw new Error('Не подтверждена готовность позиции.');
      }else if(item.action==='insert'){
        stockCatalogInsert_(sh,row,item,false);
        if(sku||values[15]!==''||!/^ritm-[-a-f0-9]{36}-\d+$/i.test(String(item.uid||''))||typeof item.layoutPresent!=='boolean')throw new Error('Строка занята или данные позиции не подтверждены.');
        [4,7,8,10,11].forEach(function(col){if(!sh.getRange(row,col).getFormula())throw new Error('В строке не подтверждены формулы.');});
        var existingMultiplicity=sh.getRange(row,14).getFormula();
        if(item.assemblyCatalog!==true && existingMultiplicity!=='=VLOOKUP(E:E;Cache!B:Q;16;0)'&&existingMultiplicity!==stockMultiplicityFormula_(row))throw new Error('Формула кратности изменена; требуется сверка.');
        [3,5,6,16,30].forEach(function(col){if(sh.getRange(row,col).getValue()!==''||sh.getRange(row,col).getFormula())throw new Error('Строка содержит данные.');});
      }else throw new Error('Неизвестное действие.');
    });
    if(input.dryRun===true)return {ok:true,status:'validated'};
    props.setProperty(key,JSON.stringify({hash:hash,status:'writing'}));
    input.entries.forEach(function(item){var row=Number(item.row),qty=Number(item.newQuantity);
      if(item.action==='insert'){
        sh.getRange(row,5).setValue(item.article);sh.getRange(row,6).setValue(item.extension||'');sh.getRange(row,30).setValue(item.uid);
        var sku=String(item.article).trim().toUpperCase().replace(/"/g,'""');
        sh.getRange(row,3).setFormula('=IF(E'+row+'="";"";IF(UPPER(TRIM(E'+row+'))="'+sku+'";"'+(item.layoutPresent?'Есть':'Не в таблице макетов')+'";"Проверить макет"))');
        if(item.assemblyCatalog===true)stockCatalogInsert_(sh,row,item,true);
        else sh.getRange(row,14).setFormula(stockMultiplicityFormula_(row));
        sh.getRange(row,19,1,2).setValues([[false,false]]);sh.getRange(row,25,1,2).setValues([[0,0]]);sh.getRange(row,28,1,2).setValues([[0,0]]);sh.getRange(row,24).setFormula(boxProgressFormula_(row));
      }else{
        var values=sh.getRange(row,1,1,30).getValues()[0],machine=String(values[3]).trim().toLowerCase(),plan=/^(xerox|ксерокс|x|х)$/.test(machine)?qty/Number(values[13])*Number(values[6]):qty;
        sh.getRange(row,19,1,2).setValues([[values[27]>=plan,values[28]>=plan]]);
        if(values[27]<plan)sh.getRange(row,22).clearContent();if(values[28]<plan)sh.getRange(row,23).clearContent();
      }
      sh.getRange(row,16).setValue(qty);
    });
    SpreadsheetApp.flush();
    input.entries.forEach(function(item){var row=Number(item.row);if(sh.getRange(row,5).getValue()!==item.article||sh.getRange(row,16).getValue()!==Number(item.newQuantity))throw new Error('Запись не подтверждена.');});
    props.setProperty(key,JSON.stringify({hash:hash,status:'verified'}));return {ok:true,status:'verified'};
  });
}
