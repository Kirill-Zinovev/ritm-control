/* RITM Box: physical-sheet work journal. No production spreadsheet ID in source. */
var BOXW = Object.freeze({ header: 4, first: 5, version: 1,
  actions: {take:'Взяли в работу',print:'Печать',cut:'Порезка',defect:'Брак',surplus:'Излишек',cancel:'Отмена'},
  totals: ['Брак, листы', 'Излишек, листы', 'Напечатано годных, листы', 'Порезано годных, листы'],
  eventHeaders: ['eventId','requestHash','at','positionId','sourceId','sheetId','shipment','article','employeeId','employee','action','unit','enteredQuantity','sheets','kits','areaM2','planKits','sheetsPerKit','planSheets','widthM','heightM','stage','reason','reverses'],
  eventTitles: ['ID записи','Контроль запроса','Время','ID позиции','ID таблицы','ID листа','Поставка','Артикул','ID сотрудника','Сотрудник','Действие','Единица','Введено','Физических листов','Комплектов','Площадь, м²','План, комплектов','Листов в комплекте','План, листов','Ширина, м','Высота, м','Этап','Комментарий / причина','Отменяет ID'],
  positionHeaders: ['positionId','sourceId','sheetId','article','baseTaken','basePrinted','baseCut','baseDefect','baseSurplus','createdAt','baseTakenAt','basePrintedAt','baseCutAt'],
  guard: '_RITM_BOX_GUARD' });

function onOpen() {
  SpreadsheetApp.getUi().createMenu('RITM · Бокс').addItem('Записать работу', 'openBoxWorklog')
    .addItem('Открыть журнал и сотрудников', 'openBoxJournal').addItem('Подключить учёт', 'setupBoxWorklog').addToUi();
}
function openBoxWorklog() {
  var sh=SpreadsheetApp.getActiveSheet(); boxSchema_(sh);
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('BoxPanel').setTitle('RITM · Учёт бокса'));
}
function openBoxJournal() {
  var id=PropertiesService.getScriptProperties().getProperty('BOX_JOURNAL_ID');
  if (!id) throw new Error('Сначала выполните «Подключить учёт».');
  var html=HtmlService.createHtmlOutput('<p><a target="_blank" rel="noopener" href="https://docs.google.com/spreadsheets/d/'+encodeURIComponent(id)+'/edit">Открыть журнал и список сотрудников</a></p>');
  SpreadsheetApp.getUi().showModalDialog(html,'Журнал бокса');
}
function setupBoxWorklog() {
  return boxLocked_(function(){
    var source=SpreadsheetApp.getActiveSpreadsheet(), props=PropertiesService.getScriptProperties();
    var configured=props.getProperty('BOX_SOURCE_ID');
    if(configured && configured!==source.getId()) throw new Error('Этот проект уже подключён к другой таблице.');
    var id=props.getProperty('BOX_JOURNAL_ID'), journal;
    if(id) journal=SpreadsheetApp.openById(id);
    else {
      journal=SpreadsheetApp.create('RITM · Журнал работы бокса');journal.getSheets()[0].setName('Сотрудники');
      // Persist immediately so interrupted setup can safely resume the same file.
      props.setProperties({BOX_SOURCE_ID:source.getId(),BOX_JOURNAL_ID:journal.getId()});
    }
    if(journal.getId()===source.getId()) throw new Error('Журнал должен находиться в отдельном файле.');
    boxJournalSheet_(journal,'Журнал',BOXW.eventTitles);
    boxJournalSheet_(journal,'_Позиции',BOXW.positionHeaders).hideSheet();
    var employees=boxJournalSheet_(journal,'Сотрудники',['Имя','Активен','ID']);
    employees.getRange('A1:C1').setNotes([['Введите имена сотрудников бокса, по одному на строку','FALSE — отключить сотрудника. Пусто или TRUE — активен','Заполняется системой автоматически. Не меняйте.']]);employees.hideColumns(3);
    var guard=source.getSheetByName(BOXW.guard)||source.insertSheet(BOXW.guard);
    if(!guard.getLastRow()) guard.appendRow(['positionId','sheetId','taken','printed','cut','defect','surplus','takenAt','printedAt','cutAt']);
    guard.hideSheet();
    var count=0;
    source.getSheets().forEach(function(sh){if(boxEligible_(sh)){boxEnsureColumns_(sh);count++;}});
    props.setProperties({BOX_SOURCE_ID:source.getId(),BOX_JOURNAL_ID:journal.getId()});
    var result={ok:true,journalUrl:journal.getUrl(),sheets:count};console.log(JSON.stringify(result));return result;
  });
}
function boxJournalSheet_(book,name,headers){
  var sh=book.getSheetByName(name)||book.insertSheet(name);
  if(!sh.getLastRow()) {sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold').setBackground('#eaf2ff');sh.setFrozenRows(1);}
  else if(JSON.stringify(sh.getRange(1,1,1,headers.length).getValues()[0])!==JSON.stringify(headers)) throw new Error('Структура журнала '+name+' отличается. Запись остановлена.');
  return sh;
}
function boxEligible_(sh){return !!sh && !sh.isSheetHidden() && /^(OZON|WB)\s+\S/i.test(sh.getName().trim());}
function boxFold_(v){return String(v||'').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim();}
function boxSchema_(sh){
  if(!boxEligible_(sh)) throw new Error('Выберите рабочий лист, начинающийся с OZON или WB.');
  var h=sh.getRange(BOXW.header,1,1,Math.min(sh.getMaxColumns(),34)).getDisplayValues()[0].map(boxFold_);
  function find(names,required){var hits=[];h.forEach(function(v,i){if(names.indexOf(v)>=0)hits.push(i+1);});if(hits.length>1 || (required && !hits.length)) throw new Error('Не подтверждена колонка «'+names[0]+'».');return hits[0]||0;}
  return {article:find(['артикул'],true),plan:find(['кол-во','количество'],true),factor:find(['кол-во листов','количество листов'],true),
    width:find(['ширина']),height:find(['высота']),taken:find(['взяли в работу','взяли в рабоу','взят в работу']),
    printed:find(['завершил печать','завершили печать','готовность печати'],true),cut:find(['завершил порезку','завершили порезку','готовность порезки'],true),
    printedAt:find(['дата готовности печати']),cutAt:find(['дата готовности порезки'])};
}
function boxEnsureColumns_(sh){
  boxSchema_(sh);
  if(sh.getMaxColumns()<35)sh.insertColumnsAfter(sh.getMaxColumns(),35-sh.getMaxColumns());
  var range=sh.getRange(4,31,1,4), existing=range.getValues()[0];
  existing.forEach(function(v,i){if(v!=='' && v!==BOXW.totals[i])throw new Error('Колонка '+(31+i)+' занята другими данными.');});
  range.setValues([BOXW.totals]).setFontWeight('bold').setBackground('#eaf2ff').setWrap(true);
  var dateHeader=sh.getRange(4,35);if(dateHeader.getValue()!==''&&dateHeader.getValue()!=='Дата взятия в работу')throw new Error('Колонка AI занята.');
  dateHeader.setValue('Дата взятия в работу').setFontWeight('bold').setBackground('#eaf2ff').setWrap(true);
  var schema=boxSchema_(sh);[schema.taken,schema.printed,schema.cut].filter(Boolean).forEach(function(c){sh.hideColumns(c);});
}
function boxBooks_(){
  var p=PropertiesService.getScriptProperties(), source=SpreadsheetApp.getActiveSpreadsheet();
  if(!p.getProperty('BOX_JOURNAL_ID') || source.getId()!==p.getProperty('BOX_SOURCE_ID'))throw new Error('Учёт ещё не подключён. Владелец должен выполнить «Подключить учёт».');
  return {source:source,journal:SpreadsheetApp.openById(p.getProperty('BOX_JOURNAL_ID'))};
}
function boxLocked_(fn){var lock=LockService.getScriptLock();if(!lock.tryLock(10000))throw new Error('Сейчас сохраняется другая запись. Повторите с тем же запросом.');try{return fn();}finally{lock.releaseLock();}}
function boxFind_(sh,col,value){if(sh.getLastRow()<2)return null;var cells=sh.getRange(2,col,sh.getLastRow()-1,1).createTextFinder(String(value)).matchEntireCell(true).useRegularExpression(false).findAll();if(cells.length>1)throw new Error('Повторный идентификатор в журнале. Запись остановлена.');return cells[0]||null;}
function boxIdentity_(sh,row){
  var range=sh.getRange(row+':'+row);
  var found=range.getDeveloperMetadata().filter(function(m){return m.getKey()==='RITM_BOX_POSITION';});
  if(found.length>1)throw new Error('Неоднозначный идентификатор строки.');
  if(found.length)return found[0].getValue();
  return boxLocked_(function(){
    var current=range.getDeveloperMetadata().filter(function(m){return m.getKey()==='RITM_BOX_POSITION';});
    if(current.length>1)throw new Error('Неоднозначный идентификатор строки.');
    if(current.length)return current[0].getValue();
    var id=Utilities.getUuid();range.addDeveloperMetadata('RITM_BOX_POSITION',id);return id;
  });
}
function boxRow_(sh,id){
  var matches=sh.createDeveloperMetadataFinder().withKey('RITM_BOX_POSITION').withValue(id).find();
  if(matches.length!==1)throw new Error('Позиция перемещена или удалена. Выберите артикул заново.');
  return matches[0].getLocation().getRow().getRow();
}
function boxNumber_(v){if(v===''||v===null||typeof v==='boolean')return null;var n=Number(String(v).replace(',','.'));return isFinite(n)?n:null;}
function boxPosition_(sh,row){
  var schema=boxSchema_(sh);if(row<5)throw new Error('Выберите строку с артикулом.');
  var values=sh.getRange(row,1,1,Math.min(35,sh.getMaxColumns())).getValues()[0], article=String(values[schema.article-1]||'').trim();
  if(!article || article[0]==='#')throw new Error('В выбранной строке нет подтверждённого артикула.');
  var kits=boxNumber_(values[schema.plan-1]),factor=boxNumber_(values[schema.factor-1]);
  if(!Number.isSafeInteger(kits)||kits<=0||!Number.isSafeInteger(factor)||factor<=0)throw new Error('Не подтверждены план и количество физических листов в комплекте.');
  var width=schema.width?boxNumber_(values[schema.width-1]):null,height=schema.height?boxNumber_(values[schema.height-1]):null;
  var position={sheetId:sh.getSheetId(),row:row,shipment:sh.getName(),article:article,planKits:kits,sheetsPerKit:factor,planSheets:kits*factor,widthM:width>0?width:null,heightM:height>0?height:null,schema:schema};
  function dateAt(col){var v=col?values[col-1]:null;return v instanceof Date&&!isNaN(v.getTime())?v.toISOString():'';}
  position.legacyDates={takenAt:dateAt(35),printedAt:dateAt(schema.printedAt),cutAt:dateAt(schema.cutAt)};
  position.fingerprint=boxHash_([position.sheetId,article,kits,factor,position.widthM,position.heightM]);
  position.legacy={taken:schema.taken&&values[schema.taken-1]===true?position.planSheets:0,printed:values[schema.printed-1]===true?position.planSheets:0,cut:values[schema.cut-1]===true?position.planSheets:0};
  return position;
}
function boxHash_(data){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(data),Utilities.Charset.UTF_8).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
function boxEmployees_(journal){var sh=journal.getSheetByName('Сотрудники');if(!sh||sh.getLastRow()<2)return [];var seen={},names={},result=[];sh.getRange(2,1,sh.getLastRow()-1,3).getValues().forEach(function(r,i){var name=String(r[0]||'').trim();if(!name||r[1]===false||String(r[1]).toUpperCase()==='FALSE')return;var id=String(r[2]||'').trim();if(!id){id=Utilities.getUuid();sh.getRange(i+2,3).setValue(id);}if(seen[id]||names[boxFold_(name)])throw new Error('Повторный сотрудник в списке бокса.');seen[id]=true;names[boxFold_(name)]=true;result.push({id:id,name:name});});return result;}
function boxBaseline_(books,p,id,create){
  var sh=books.journal.getSheetByName('_Позиции'), hit=boxFind_(sh,1,id);
  if(hit){var v=sh.getRange(hit.getRow(),1,1,BOXW.positionHeaders.length).getValues()[0];if(v[1]!==books.source.getId()||Number(v[2])!==p.sheetId||v[3]!==p.article)throw new Error('Изменилась связь позиции с журналом.');return {taken:Number(v[4]),printed:Number(v[5]),cut:Number(v[6]),defect:Number(v[7]),surplus:Number(v[8]),takenAt:v[10]||'',printedAt:v[11]||'',cutAt:v[12]||'',positionId:id};}
  if(create!==false)sh.appendRow([id,books.source.getId(),p.sheetId,p.article,p.legacy.taken,p.legacy.printed,p.legacy.cut,0,0,new Date().toISOString(),p.legacyDates.takenAt,p.legacyDates.printedAt,p.legacyDates.cutAt]);return Object.assign({taken:p.legacy.taken,printed:p.legacy.printed,cut:p.legacy.cut,defect:0,surplus:0,positionId:id},p.legacyDates);
}
function boxEvents_(journal,id){var sh=journal.getSheetByName('Журнал');if(sh.getLastRow()<2)return [];return sh.getRange(2,4,sh.getLastRow()-1,1).createTextFinder(id).matchEntireCell(true).useRegularExpression(false).findAll().map(function(cell){var v=sh.getRange(cell.getRow(),1,1,BOXW.eventHeaders.length).getValues()[0],e={};BOXW.eventHeaders.forEach(function(k,i){e[k]=v[i];});Object.keys(BOXW.actions).forEach(function(k){if(e.action===BOXW.actions[k])e.action=k;});return e;});}
function boxTotals_(base,events){var totals=Object.assign({},base),cancelled={};events.forEach(function(e){if(e.action==='cancel')cancelled[e.reverses]=true;});['take','print','cut'].forEach(function(action){var key={take:'taken',print:'printed',cut:'cut'}[action];if(cancelled['baseline:'+action+':'+base.positionId]){totals[key]=0;totals[key+'At']='';}});events.forEach(function(e){if(e.action!=='cancel'&&!cancelled[e.eventId]){var key={take:'taken',print:'printed',cut:'cut',defect:'defect',surplus:'surplus'}[e.action];if(!key)throw new Error('Неизвестная операция в журнале.');totals[key]+=Number(e.sheets);if(['taken','printed','cut'].indexOf(key)>=0)totals[key+'At']=e.at;}});return {totals:totals,cancelled:cancelled};}
function boxProject_(books,sh,p,id,totals){
  boxEnsureColumns_(sh);
  var guard=books.source.getSheetByName(BOXW.guard),hit=boxFind_(guard,1,id),value=[id,p.sheetId,totals.taken,totals.printed,totals.cut,totals.defect,totals.surplus,totals.takenAt||'',totals.printedAt||'',totals.cutAt||''];
  if(hit)guard.getRange(hit.getRow(),1,1,10).setValues([value]);else guard.appendRow(value);
  sh.getRange(p.row,31,1,4).setValues([[totals.defect,totals.surplus,totals.printed,totals.cut]]);
  if(p.schema.taken)sh.getRange(p.row,p.schema.taken).setValue(totals.taken>0);
  sh.getRange(p.row,p.schema.printed).setValue(totals.printed>=p.planSheets);
  sh.getRange(p.row,p.schema.cut).setValue(totals.cut>=p.planSheets);
  if(p.schema.printedAt&&totals.printedAt)sh.getRange(p.row,p.schema.printedAt).setValue(new Date(totals.printedAt)).setNumberFormat('dd.MM.yyyy HH:mm');
  else if(p.schema.printedAt)sh.getRange(p.row,p.schema.printedAt).clearContent();
  if(p.schema.cutAt&&totals.cutAt)sh.getRange(p.row,p.schema.cutAt).setValue(new Date(totals.cutAt)).setNumberFormat('dd.MM.yyyy HH:mm');
  else if(p.schema.cutAt)sh.getRange(p.row,p.schema.cutAt).clearContent();
  sh.getRange(p.row,35).setValue(totals.takenAt?new Date(totals.takenAt):'').setNumberFormat('dd.MM.yyyy HH:mm');
}
function getBoxPanelSelection(){var book=SpreadsheetApp.getActiveSpreadsheet(),range=book.getActiveRange(),sh=range&&range.getSheet();return {eligible:boxEligible_(sh),signature:sh?[sh.getSheetId(),range.getRow(),PropertiesService.getScriptProperties().getProperty('BOX_REVISION')||''].join(':'):''};}
function getBoxPanelContext(lastKey){
  var source=SpreadsheetApp.getActiveSpreadsheet(),range=source.getActiveRange(),sh=range&&range.getSheet(),props=PropertiesService.getScriptProperties();
  if(!boxEligible_(sh)||range.getRow()<5)throw new Error('Выберите артикул на рабочем листе OZON или WB.');
  if(props.getProperty('BOX_SOURCE_ID')!==source.getId())throw new Error('Учёт ещё не подключён.');
  var key=[sh.getSheetId(),range.getRow(),boxHash_(sh.getRange(range.getRow(),5,1,12).getValues()[0]),props.getProperty('BOX_REVISION')||''].join(':');
  // Unchanged selections never open the journal, wait for a writer or rewrite cells.
  if(lastKey===key)return {unchanged:true,key:key};
  var cache=null,cacheKey='boxcard:'+boxHash_([source.getId(),props.getProperty('BOX_JOURNAL_ID'),key]);
  try{cache=CacheService.getScriptCache();var cached=lastKey&&cache.get(cacheKey);if(cached){var card=JSON.parse(cached);if(card.key===key)return card;}}catch(ignore){}
  var result=(function(){var books=boxBooks_();
    var p=boxPosition_(sh,range.getRow()),id=boxIdentity_(sh,p.row);
    var base=boxBaseline_(books,p,id,false),events=boxEvents_(books.journal,id),state=boxTotals_(base,events);
    return {key:key,positionId:id,sheetId:p.sheetId,shipment:p.shipment,article:p.article,fingerprint:p.fingerprint,planKits:p.planKits,sheetsPerKit:p.sheetsPerKit,planSheets:p.planSheets,totals:state.totals,employees:boxEmployees_(books.journal),
      journalUrl:books.journal.getUrl(),history:boxHistory_(base,events,state.cancelled)};
  })();
  try{if(cache)cache.put(cacheKey,JSON.stringify(result),60);}catch(ignore){}
  return result;
}
function boxHistory_(base,events,cancelled){var history=[];['take','print','cut'].forEach(function(action){var key={take:'taken',print:'printed',cut:'cut'}[action];if(base[key]>0)history.push({eventId:'baseline:'+action+':'+base.positionId,at:base[key+'At']||'',employee:'До подключения учёта',action:action,sheets:base[key]});});return history.concat(events.filter(function(e){return e.action!=='cancel';})).slice(-12).reverse().map(function(e){return {id:e.eventId,at:e.at,employee:e.employee,action:e.action,sheets:e.sheets,cancelled:!!cancelled[e.eventId]};});}
function saveBoxWork(request){var outcome={written:false,confirmedAbsent:false};try{return boxSaveCore_(request,outcome);}catch(e){throw new Error((outcome.confirmedAbsent&&!outcome.written?'NOT_SAVED: ':'')+(e.message||String(e)));}}
function boxSaveCore_(request,outcome){
  return boxLocked_(function(){
    var books=boxBooks_();
    if(!request||!/^[-a-zA-Z0-9]{16,80}$/.test(request.requestId||''))throw new Error('Не подтверждён ID записи.');
    var allowed=['take','print','cut','defect','surplus','cancel'];if(allowed.indexOf(request.action)<0)throw new Error('Выберите действие.');
    var employee=boxEmployees_(books.journal).filter(function(e){return e.id===request.employeeId;})[0];
    var hash=boxHash_([request.positionId,request.sheetId,request.fingerprint,request.action,request.employeeId,request.unit,request.quantity,request.stage||'',request.reason||'',request.reverses||'']);
    var journal=books.journal.getSheetByName('Журнал'),prior=boxFind_(journal,1,request.requestId);
    outcome.confirmedAbsent=!prior;
    if(!prior&&!employee)throw new Error('Выберите сотрудника из отдельного списка бокса. Без имени запись и отмена запрещены.');
    if(prior){outcome.written=true;var v=journal.getRange(prior.getRow(),1,1,BOXW.eventHeaders.length).getValues()[0];if(v[1]!==hash)throw new Error('Этот ID уже относится к другой записи.');}
    var sh=books.source.getSheetById(Number(request.sheetId));if(!sh)throw new Error('Поставка удалена.');
    var row=boxRow_(sh,request.positionId),p=boxPosition_(sh,row),base=boxBaseline_(books,p,request.positionId),events=boxEvents_(books.journal,request.positionId),state=boxTotals_(base,events);
    if(!prior){
      if(request.fingerprint!==p.fingerprint)throw new Error('План или размеры изменились. Обновите панель перед записью.');
      var sheets=0,quantity=Number(request.quantity),unit=request.unit,reason=String(request.reason||'').trim(),stage=String(request.stage||'');
      if(reason.length>500)throw new Error('Комментарий должен быть короче 500 знаков.');
      if(request.action==='cancel'){
        var target=events.filter(function(e){return e.eventId===request.reverses&&e.action!=='cancel';})[0];
        if(!target){['take','print','cut'].forEach(function(a){var k={take:'taken',print:'printed',cut:'cut'}[a];if(request.reverses==='baseline:'+a+':'+request.positionId&&base[k]>0)target={eventId:request.reverses,action:a,sheets:base[k]};});}
        if(!target||state.cancelled[target.eventId])throw new Error('Запись не найдена или уже отменена.');
        if(!reason)throw new Error('Укажите причину отмены.');
        sheets=Number(target.sheets);quantity=0;unit='sheets';
        var check=Object.assign({},state.totals),key={take:'taken',print:'printed',cut:'cut',defect:'defect',surplus:'surplus'}[target.action];check[key]-=sheets;
        if(check[key]<0||(target.action==='print'&&check.printed<check.cut))throw new Error('Сначала отмените связанную порезку: она превышает остаток годной печати.');
      } else {
        if(!Number.isSafeInteger(quantity)||quantity<=0||quantity>1000000||['sheets','kits'].indexOf(unit)<0)throw new Error('Введите целое количество больше нуля.');
        if((request.action==='defect'||request.action==='surplus')&&unit!=='sheets')throw new Error('Брак и излишек записываются целыми физическими листами.');
        if(request.action==='defect'&&['print','cut'].indexOf(stage)<0)throw new Error('Выберите этап возникновения брака.');
        sheets=quantity*(unit==='kits'?p.sheetsPerKit:1);
        if(request.action==='take'&&state.totals.taken+sheets>p.planSheets)throw new Error('Взятое в работу количество превышает план.');
        if(request.action==='print'&&state.totals.printed+sheets>p.planSheets)throw new Error('Годная печать превысит план. Листы сверх плана добавьте как излишек.');
        if(request.action==='cut'&&state.totals.cut+sheets>state.totals.printed)throw new Error('Порезка превышает подтверждённое количество годных напечатанных листов.');
      }
      var area=p.widthM&&p.heightM?sheets*p.widthM*p.heightM:'';
      var event={eventId:request.requestId,requestHash:hash,at:new Date().toISOString(),positionId:request.positionId,sourceId:books.source.getId(),sheetId:p.sheetId,shipment:p.shipment,article:p.article,employeeId:employee.id,employee:employee.name,action:request.action,unit:unit,enteredQuantity:quantity,sheets:sheets,kits:sheets/p.sheetsPerKit,areaM2:area,planKits:p.planKits,sheetsPerKit:p.sheetsPerKit,planSheets:p.planSheets,widthM:p.widthM||'',heightM:p.heightM||'',stage:stage,reason:reason,reverses:request.reverses||''};
      outcome.written=true;
      journal.appendRow(BOXW.eventHeaders.map(function(k){var v=k==='action'?BOXW.actions[event[k]]:k==='unit'?(event[k]==='kits'?'Комплекты / шт.':'Листы'):k==='stage'?(BOXW.actions[event[k]]||''):event[k];return typeof v==='string'&&v.charAt(0)==='='?"'"+v:v;}));events.push(event);
      PropertiesService.getScriptProperties().setProperty('BOX_REVISION',event.eventId);
      // Journal is the commit point. A retry repairs projection, never re-appends.
      state=boxTotals_(base,events);
    }
    boxProject_(books,sh,p,request.positionId,state.totals);
    return {ok:true,eventId:request.requestId,repeated:!!prior,totals:state.totals};
  });
}
function onEdit(e){
  if(!e||!e.range||!boxEligible_(e.range.getSheet()))return;
  var sh=e.range.getSheet(),schema;
  try{schema=boxSchema_(sh);}catch(ignore){return;}
  var cols=[schema.taken,schema.printed,schema.cut,schema.printedAt,schema.cutAt,31,32,33,34,35].filter(Boolean);
  if(!cols.some(function(c){return c>=e.range.getColumn()&&c<=e.range.getLastColumn();}))return;
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)){if(e.range.getNumRows()===1&&e.range.getNumColumns()===1)e.range.setValue(e.oldValue===undefined?'':e.oldValue==='TRUE'?true:e.oldValue==='FALSE'?false:e.oldValue);return;}
  try{
    var guard=e.source.getSheetByName(BOXW.guard);
    for(var row=Math.max(5,e.range.getRow());row<=e.range.getLastRow();row++){
      var meta=sh.getRange(row+':'+row).getDeveloperMetadata().filter(function(m){return m.getKey()==='RITM_BOX_POSITION';}),hit=meta.length===1&&guard?boxFind_(guard,1,meta[0].getValue()):null;
      if(hit){var v=guard.getRange(hit.getRow(),1,1,10).getValues()[0],p=boxPosition_(sh,row);boxProject_({source:e.source},sh,p,v[0],{taken:Number(v[2]),printed:Number(v[3]),cut:Number(v[4]),defect:Number(v[5]),surplus:Number(v[6]),takenAt:v[7],printedAt:v[8],cutAt:v[9]});}
      else if(e.range.getNumRows()===1&&e.range.getNumColumns()===1)e.range.setValue(e.oldValue===undefined?'':e.oldValue==='TRUE'?true:e.oldValue==='FALSE'?false:e.oldValue);
    }
    e.source.toast('Запишите действие через меню RITM · Бокс → Записать работу. Имя обязательно.','Учёт через панель',5);
  }finally{lock.releaseLock();}
}
