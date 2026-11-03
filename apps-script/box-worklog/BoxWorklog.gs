/* RITM Box: physical-sheet work journal. No production spreadsheet ID in source. */
var BOXW = Object.freeze({ header: 4, first: 5, version: 2,
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
  return {article:find(['артикул'],true),plan:find(['кол-во','количество'],true),factor:find(['кол-во листов','количество листов'],true),multiplicity:find(['кратность'],true),
    machine:find(['станок'],true),width:find(['ширина']),height:find(['высота']),planArea:find(['объем на все кол-во скинули']),taken:find(['взяли в работу','взяли в рабоу','взят в работу']),
    printed:find(['завершил печать','завершили печать','готовность печати'],true),cut:find(['завершил порезку','завершили порезку','готовность порезки'],true),
    printedAt:find(['дата готовности печати','дата завершения печати']),cutAt:find(['дата готовности порезки','дата завершения порезки'])};
}
function boxCompact_(sh){return boxFold_(sh.getRange(4,24).getValue())==='прогресс печати / порезки';}
function boxEnsureColumns_(sh){
  var schema=boxSchema_(sh);
  if(sh.getMaxColumns()<30)sh.insertColumnsAfter(sh.getMaxColumns(),30-sh.getMaxColumns());
  if(!boxCompact_(sh))throw new Error('Владелец должен завершить перенос колонок учёта.');
  [schema.taken,schema.printed,schema.cut].filter(Boolean).forEach(function(c){sh.hideColumns(c);});
}
function boxProgressFormula_(row){
  var plan='IF(REGEXMATCH(LOWER(TRIM(D'+row+'));"^(xerox|ксерокс|x|х)$");IFERROR(P'+row+'/N'+row+'*G'+row+';0);P'+row+')';
  function line(label,col){var ratio=col+row+'/('+plan+')';return '"'+label+' "&REPT("■";ROUND(MIN(1;'+ratio+')*8;0))&REPT("□";8-ROUND(MIN(1;'+ratio+')*8;0))&" "&TEXT('+ratio+';"0%")';}
  return '=IFERROR(IF('+plan+'>0;'+line('Печать','AB')+'&CHAR(10)&'+line('Порезка','AC')+';"План не определён");"План не определён")';
}
function boxDates_(totals,plan){
  function date(value){var d=value?new Date(value):null;return d&&!isNaN(d.getTime())?d:'';}
  return [date(totals.takenAt),totals.printed>=plan?date(totals.printedAt):'',totals.cut>=plan?date(totals.cutAt):''];
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
  var kits=boxNumber_(values[schema.plan-1]),factor=boxNumber_(values[schema.factor-1]),multiplicity=boxNumber_(values[schema.multiplicity-1]);
  var machine=boxFold_(values[schema.machine-1]),xerox=/^(xerox|ксерокс|x|х)$/.test(machine);
  if(!machine)throw new Error('У артикула не указан станок. Заполните колонку «Станок».');
  if(!Number.isSafeInteger(kits)||kits<=0)throw new Error('Не подтверждён план в штуках в колонке P.');
  if(xerox&&(!Number.isSafeInteger(factor)||factor<=0||!Number.isSafeInteger(multiplicity)||multiplicity<=0))throw new Error('Для Xerox заполните кратность и количество листов на товар.');
  if(!xerox){factor=1;multiplicity=1;}
  var width=schema.width?boxNumber_(values[schema.width-1]):null,height=schema.height?boxNumber_(values[schema.height-1]):null,planArea=schema.planArea?boxNumber_(values[schema.planArea-1]):null;
  var position={sheetId:sh.getSheetId(),row:row,shipment:sh.getName(),article:article,xerox:xerox,machine:machine,planKits:kits,sheetsPerKit:factor,multiplicity:multiplicity,planSheets:kits/multiplicity*factor,planArea:planArea>0?planArea:null,widthM:width>0?width:null,heightM:height>0?height:null,schema:schema};
  function dateAt(col){var v=col?values[col-1]:null;return v instanceof Date&&!isNaN(v.getTime())?v.toISOString():'';}
  position.legacyDates={takenAt:dateAt(boxCompact_(sh)?21:35),printedAt:dateAt(schema.printedAt),cutAt:dateAt(schema.cutAt)};
  position.fingerprint=boxHash_([position.sheetId,article,kits,factor,multiplicity,position.widthM,position.heightM,machine,position.planArea]);
  position.legacy={taken:schema.taken&&values[schema.taken-1]===true?position.planSheets:0,printed:values[schema.printed-1]===true?position.planSheets:0,cut:values[schema.cut-1]===true?position.planSheets:0};
  return position;
}
function boxHash_(data){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(data),Utilities.Charset.UTF_8).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
function boxEmployees_(journal){var sh=journal.getSheetByName('Сотрудники');if(!sh||sh.getLastRow()<2)return [];var seen={},names={},result=[];sh.getRange(2,1,sh.getLastRow()-1,3).getValues().forEach(function(r,i){var name=String(r[0]||'').trim();if(!name||r[1]===false||String(r[1]).toUpperCase()==='FALSE')return;var id=String(r[2]||'').trim();if(!id){id=Utilities.getUuid();sh.getRange(i+2,3).setValue(id);}if(seen[id]||names[boxFold_(name)])throw new Error('Повторный сотрудник в списке бокса.');seen[id]=true;names[boxFold_(name)]=true;result.push({id:id,name:name});});return result;}
function boxBaseline_(books,p,id,create){
  var sh=books.journal.getSheetByName('_Позиции'), hit=boxFind_(sh,1,id);
  if(hit){var v=sh.getRange(hit.getRow(),1,1,BOXW.positionHeaders.length).getValues()[0];if(v[1]!==books.source.getId()||Number(v[2])!==p.sheetId||v[3]!==p.article)throw new Error('Изменилась связь позиции с журналом.');return {taken:p.xerox?Number(v[4]):(Number(v[4])>0?p.planKits:0),printed:p.xerox?Number(v[5]):(Number(v[5])>0?p.planKits:0),cut:p.xerox?Number(v[6]):(Number(v[6])>0?p.planKits:0),defect:Number(v[7]),surplus:Number(v[8]),takenAt:v[10]||'',printedAt:v[11]||'',cutAt:v[12]||'',positionId:id};}
  if(create!==false)sh.appendRow([id,books.source.getId(),p.sheetId,p.article,p.legacy.taken,p.legacy.printed,p.legacy.cut,0,0,new Date().toISOString(),p.legacyDates.takenAt,p.legacyDates.printedAt,p.legacyDates.cutAt]);return Object.assign({taken:p.legacy.taken,printed:p.legacy.printed,cut:p.legacy.cut,defect:0,surplus:0,positionId:id},p.legacyDates);
}
function boxEvents_(journal,id){var sh=journal.getSheetByName('Журнал');if(sh.getLastRow()<2)return [];return sh.getRange(2,4,sh.getLastRow()-1,1).createTextFinder(id).matchEntireCell(true).useRegularExpression(false).findAll().map(function(cell){var v=sh.getRange(cell.getRow(),1,1,BOXW.eventHeaders.length).getValues()[0],e={};BOXW.eventHeaders.forEach(function(k,i){e[k]=v[i];});Object.keys(BOXW.actions).forEach(function(k){if(e.action===BOXW.actions[k])e.action=k;});return e;});}
function boxEventsMany_(journal,ids){
  var wanted={};ids.forEach(function(id){wanted[id]=true;});var result={};ids.forEach(function(id){result[id]=[];});
  var sh=journal.getSheetByName('Журнал'),last=sh.getLastRow();if(last<2)return result;
  sh.getRange(2,1,last-1,BOXW.eventHeaders.length).getValues().forEach(function(v){var id=String(v[3]||'');if(!wanted[id])return;var e={};BOXW.eventHeaders.forEach(function(k,i){e[k]=v[i];});Object.keys(BOXW.actions).forEach(function(k){if(e.action===BOXW.actions[k])e.action=k;});result[id].push(e);});
  return result;
}
function boxTotals_(base,events,p){var totals=Object.assign({},base),cancelled={};events.forEach(function(e){if(e.action==='cancel')cancelled[e.reverses]=true;});['take','print','cut'].forEach(function(action){var key={take:'taken',print:'printed',cut:'cut'}[action];if(cancelled['baseline:'+action+':'+base.positionId]){totals[key]=0;totals[key+'At']='';}});events.forEach(function(e){if(e.action!=='cancel'&&!cancelled[e.eventId]){var key={take:'taken',print:'printed',cut:'cut',defect:'defect',surplus:'surplus'}[e.action];if(!key)throw new Error('Неизвестная операция в журнале.');var amount=p&&!p.xerox?Number(e.kits):Number(e.sheets);if(p&&!p.xerox&&(e.kits===''||e.kits===undefined||e.kits===null)||!isFinite(amount)||amount<0)throw new Error('Не подтверждена единица исторической записи '+e.eventId);totals[key]+=amount;if(['taken','printed','cut'].indexOf(key)>=0){if(key!=='taken'||!totals.takenAt)totals[key+'At']=e.at;}}});return {totals:totals,cancelled:cancelled};}
function boxProject_(books,sh,p,id,totals){
  boxEnsureColumns_(sh);
  sh.getRange(4,25,1,2).setValues([['Брак (Xerox — листы, остальные — шт.)','Излишек (Xerox — листы, остальные — шт.)']]);
  sh.getRange(4,28,1,2).setValues([['Напечатано годных (Xerox — листы, остальные — шт.)','Порезано годных (Xerox — листы, остальные — шт.)']]);
  var guard=books.source.getSheetByName(BOXW.guard),hit=boxFind_(guard,1,id),value=[id,p.sheetId,totals.taken,totals.printed,totals.cut,totals.defect,totals.surplus,totals.takenAt||'',totals.printedAt||'',totals.cutAt||''];
  if(hit)guard.getRange(hit.getRow(),1,1,10).setValues([value]);else guard.appendRow(value);
  var dates=boxDates_(totals,p.planSheets);
  sh.getRange(p.row,21,1,3).setValues([dates]).setNumberFormat('dd.MM.yyyy HH:mm');
  sh.getRange(p.row,24).setFormula(boxProgressFormula_(p.row));
  sh.getRange(p.row,25,1,2).setValues([[totals.defect,totals.surplus]]).setNumberFormat('0');
  sh.getRange(p.row,28,1,2).setValues([[totals.printed,totals.cut]]).setNumberFormat('0');
  if(p.schema.taken)sh.getRange(p.row,p.schema.taken).setValue(totals.taken>0);
  sh.getRange(p.row,p.schema.printed).setValue(totals.printed>=p.planSheets);
  sh.getRange(p.row,p.schema.cut).setValue(totals.cut>=p.planSheets);
}
function boxSelection_(){
  var book=SpreadsheetApp.getActiveSpreadsheet(),active=book.getActiveRange(),list=book.getActiveRangeList(),ranges=list?list.getRanges():[];
  if(!ranges.length&&active)ranges=[active];
  var sh=active&&active.getSheet();if(!sh||!boxEligible_(sh))return {sheet:sh,rows:[]};
  var schema=boxSchema_(sh),seen={},rows=[];
  ranges.forEach(function(range){if(range.getSheet().getSheetId()!==sh.getSheetId())throw new Error('Выберите артикулы на одном листе поставки.');for(var row=range.getRow();row<=range.getLastRow();row++){if(row>=5&&!seen[row]){seen[row]=true;rows.push(row);}}});
  rows.sort(function(a,b){return a-b;});
  if(rows.length){var first=rows[0],last=rows[rows.length-1],articles=sh.getRange(first,schema.article,last-first+1,1).getDisplayValues();rows=rows.filter(function(row){return !sh.isRowHiddenByFilter(row)&&!sh.isRowHiddenByUser(row)&&String(articles[row-first][0]||'').trim()!=='';});}
  return {sheet:sh,rows:rows};
}
function getBoxPanelSelection(){var selection=boxSelection_(),sh=selection.sheet,props=PropertiesService.getScriptProperties();return {eligible:boxEligible_(sh),signature:sh?[sh.getSheetId(),selection.rows.join(','),props.getProperty('BOX_REVISION')||''].join(':'):''};}
function getBoxMachineList(){
  var source=SpreadsheetApp.getActiveSpreadsheet(),sh=source.getActiveSheet();
  if(!boxEligible_(sh))throw new Error('Откройте лист поставки OZON или WB.');
  var schema=boxSchema_(sh),last=sh.getLastRow(),machines={};
  if(last>=5){var rows=sh.getRange(5,1,last-4,Math.max(schema.article,schema.machine)).getDisplayValues();rows.forEach(function(row,i){var n=i+5,article=String(row[schema.article-1]||'').trim(),machine=String(row[schema.machine-1]||'').trim();if(!article||!machine||sh.isRowHiddenByFilter(n)||sh.isRowHiddenByUser(n))return;var key=boxFold_(machine);if(!machines[key])machines[key]={key:key,name:machine,count:0};machines[key].count++;});}
  return {sheetId:sh.getSheetId(),shipment:sh.getName(),machines:Object.keys(machines).sort().map(function(key){return machines[key];})};
}
function getBoxMachineContext(sheetId,machine,offset,limit){
  var source=SpreadsheetApp.getActiveSpreadsheet(),sh=source.getActiveSheet();
  if(!boxEligible_(sh)||sh.getSheetId()!==Number(sheetId))throw new Error('Лист поставки изменился. Обновите список станков.');
  if(!machine)throw new Error('Выберите станок.');
  var schema=boxSchema_(sh),last=sh.getLastRow(),rows=[];
  if(last>=5){var values=sh.getRange(5,1,last-4,Math.max(schema.article,schema.machine)).getDisplayValues();values.forEach(function(row,i){var n=i+5;if(String(row[schema.article-1]||'').trim()&&boxFold_(row[schema.machine-1])===machine&&!sh.isRowHiddenByFilter(n)&&!sh.isRowHiddenByUser(n))rows.push(n);});}
  if(!rows.length)throw new Error('Для станка нет видимых артикулов. Обновите фильтр или список станков.');
  offset=Number(offset)||0;limit=Number(limit)||10;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20||offset>=rows.length)throw new Error('Список станка изменился. Обновите его.');
  var revision=PropertiesService.getScriptProperties().getProperty('BOX_REVISION')||'',signature=boxHash_([sh.getSheetId(),machine,rows,revision]);
  var result=boxPanelContextForRows_(source,sh,rows.slice(offset,offset+limit),'',true);
  result.machinePage={total:rows.length,next:Math.min(offset+limit,rows.length),signature:signature};
  return result;
}
function getBoxPanelContext(lastKey){
  var source=SpreadsheetApp.getActiveSpreadsheet(),selection=boxSelection_(),sh=selection.sheet,rows=selection.rows,props=PropertiesService.getScriptProperties();
  if(!boxEligible_(sh)||!rows.length)throw new Error('Выберите одну или несколько строк с артикулами на рабочем листе OZON или WB.');
  return boxPanelContextForRows_(source,sh,rows,lastKey);
}
function boxPanelContextForRows_(source,sh,rows,lastKey,forceBatch){
  var props=PropertiesService.getScriptProperties();
  if(props.getProperty('BOX_SOURCE_ID')!==source.getId())throw new Error('Учёт ещё не подключён.');
  var rowKeys=rows.map(function(row){return row+':'+boxHash_(sh.getRange(row,4,1,13).getValues()[0]);}),key=['units-v3',sh.getSheetId(),rowKeys.join('|'),props.getProperty('BOX_REVISION')||''].join(':');
  // Unchanged selections never open the journal, wait for a writer or rewrite cells.
  if(lastKey===key)return {unchanged:true,key:key};
  var cache=null,cacheKey='boxcard:'+boxHash_([source.getId(),props.getProperty('BOX_JOURNAL_ID'),key]);
  try{cache=CacheService.getScriptCache();var cached=lastKey&&cache.get(cacheKey);if(cached){var card=JSON.parse(cached);if(card.key===key)return card;}}catch(ignore){}
  var result=(function(){var books=boxBooks_(),employees=boxEmployees_(books.journal),positions=rows.map(function(row){var p=boxPosition_(sh,row);return {p:p,id:boxIdentity_(sh,p.row)};}),eventMap=rows.length>1?boxEventsMany_(books.journal,positions.map(function(x){return x.id;})):null,items=positions.map(function(entry){
    var p=entry.p,id=entry.id,base=boxBaseline_(books,p,id,false),events=eventMap?eventMap[id]:boxEvents_(books.journal,id),state=boxTotals_(base,events,p);
    return {positionId:id,row:p.row,sheetId:p.sheetId,shipment:p.shipment,article:p.article,fingerprint:p.fingerprint,planKits:p.planKits,sheetsPerKit:p.sheetsPerKit,multiplicity:p.multiplicity,planSheets:p.planSheets,xerox:p.xerox,machine:p.machine,totals:state.totals,history:boxHistory_(base,events,state.cancelled,p)};
  });
    var common={key:key,shipment:sh.getName(),sheetId:sh.getSheetId(),employees:employees,journalUrl:books.journal.getUrl()};
    return items.length===1&&!forceBatch?Object.assign(common,items[0]):Object.assign(common,{batch:true,items:items});
  })();
  try{if(cache)cache.put(cacheKey,JSON.stringify(result),60);}catch(ignore){}
  return result;
}
function boxHistory_(base,events,cancelled,p){var history=[];['take','print','cut'].forEach(function(action){var key={take:'taken',print:'printed',cut:'cut'}[action];if(base[key]>0)history.push({eventId:'baseline:'+action+':'+base.positionId,at:base[key+'At']||'',employee:'До подключения учёта',action:action,sheets:base[key]});});return history.concat(events.filter(function(e){return e.action!=='cancel';})).slice(-12).reverse().map(function(e){return {id:e.eventId,at:e.at,employee:e.employee,action:e.action,sheets:p&&!p.xerox&&e.kits!==undefined?e.kits:e.sheets,cancelled:!!cancelled[e.eventId]};});}
function saveBoxWork(request){var outcome={written:false,confirmedAbsent:false};try{return boxSaveCore_(request,outcome);}catch(e){throw new Error((outcome.confirmedAbsent&&!outcome.written?'NOT_SAVED: ':'')+(e.message||String(e)));}}
function saveBoxWorkBatch(requests){
  if(!Array.isArray(requests)||!requests.length||requests.length>20)throw new Error('Пакет должен содержать от 1 до 20 артикулов.');
  return boxLocked_(function(){var books=boxBooks_(),employees=boxEmployees_(books.journal),eventMap=boxEventsMany_(books.journal,requests.map(function(request){return request&&request.positionId||'';})),results=[];
    requests.forEach(function(request,index){var outcome={written:false,confirmedAbsent:false};try{var result=boxSaveCore_(request,outcome,books,employees,eventMap);results.push({index:index,ok:true,eventId:result.eventId,repeated:result.repeated,totals:result.totals});}catch(e){var message=e.message||String(e),notSaved=outcome.confirmedAbsent&&!outcome.written;if(notSaved)message='NOT_SAVED: '+message;results.push({index:index,ok:false,notSaved:notSaved,error:message.replace(/^NOT_SAVED: /,'')});}});
    return {ok:results.every(function(result){return result.ok;}),results:results};
  });
}
function boxSaveCore_(request,outcome,sharedBooks,sharedEmployees,sharedEvents){
  var run=function(){
    var books=sharedBooks||boxBooks_();
    if(!request||!/^[-a-zA-Z0-9]{16,80}$/.test(request.requestId||''))throw new Error('Не подтверждён ID записи.');
    var allowed=['take','print','cut','defect','surplus','cancel'];if(allowed.indexOf(request.action)<0)throw new Error('Выберите действие.');
    var employee=(sharedEmployees||boxEmployees_(books.journal)).filter(function(e){return e.id===request.employeeId;})[0];
    var hash=boxHash_([request.positionId,request.sheetId,request.fingerprint,request.action,request.employeeId,request.unit,request.quantity,request.stage||'',request.reason||'',request.reverses||'']);
    var journal=books.journal.getSheetByName('Журнал'),prior=boxFind_(journal,1,request.requestId);
    outcome.confirmedAbsent=!prior;
    if(PropertiesService.getScriptProperties().getProperty('BOX_LAYOUT_V2_MIGRATING'))throw new Error('Перенос колонок выполняется. Подождите и повторите тот же запрос.');
    if(!prior&&!employee)throw new Error('Выберите сотрудника из отдельного списка бокса. Без имени запись и отмена запрещены.');
    if(prior){outcome.written=true;var v=journal.getRange(prior.getRow(),1,1,BOXW.eventHeaders.length).getValues()[0];if(v[1]!==hash)throw new Error('Этот ID уже относится к другой записи.');}
    var sh=books.source.getSheetById(Number(request.sheetId));if(!sh)throw new Error('Поставка удалена.');
    var row=boxRow_(sh,request.positionId);
    if(sharedEvents&&!prior&&(sh.isRowHiddenByFilter(row)||sh.isRowHiddenByUser(row)))throw new Error('Строка скрыта. Обновите выделение перед записью.');
    var p=boxPosition_(sh,row),base=boxBaseline_(books,p,request.positionId),events=sharedEvents?sharedEvents[request.positionId]||[]:boxEvents_(books.journal,request.positionId),state=boxTotals_(base,events,p);
    if(!prior){
      if(request.fingerprint!==p.fingerprint)throw new Error('План или размеры изменились. Обновите панель перед записью.');
      var sheets=0,quantity=Number(request.quantity),unit=request.unit,reason=String(request.reason||'').trim(),stage=String(request.stage||'');
      if(reason.length>500)throw new Error('Комментарий должен быть короче 500 знаков.');
      if(request.action==='cancel'){
        var target=events.filter(function(e){return e.eventId===request.reverses&&e.action!=='cancel';})[0];
        if(!target){['take','print','cut'].forEach(function(a){var k={take:'taken',print:'printed',cut:'cut'}[a];if(request.reverses==='baseline:'+a+':'+request.positionId&&base[k]>0)target={eventId:request.reverses,action:a,sheets:base[k]};});}
        if(!target||state.cancelled[target.eventId])throw new Error('Запись не найдена или уже отменена.');
        if(!reason)throw new Error('Укажите причину отмены.');
        sheets=Number(!p.xerox&&target.kits!==undefined?target.kits:target.sheets);quantity=0;unit=p.xerox?'sheets':'pieces';
        var check=Object.assign({},state.totals),key={take:'taken',print:'printed',cut:'cut',defect:'defect',surplus:'surplus'}[target.action];check[key]-=sheets;
        if(check[key]<0||(target.action==='print'&&check.printed<check.cut))throw new Error('Сначала отмените связанную порезку: она превышает остаток годной печати.');
      } else {
        if(!Number.isSafeInteger(quantity)||quantity<=0||quantity>1000000||['sheets','kits','pieces'].indexOf(unit)<0)throw new Error('Введите целое количество больше нуля.');
        if(!p.xerox&&unit!=='pieces')throw new Error('Для этого станка вводите штуки товара. Обновите панель.');
        if(p.xerox&&unit==='pieces')throw new Error('Для Xerox выберите листы или штуки товара.');
        if(p.xerox&&(request.action==='defect'||request.action==='surplus')&&unit!=='sheets')throw new Error('Брак и излишек записываются целыми физическими листами.');
        if(request.action==='defect'&&['print','cut'].indexOf(stage)<0)throw new Error('Выберите этап возникновения брака.');
        if(unit==='kits'){
          var conversionNumerator=quantity*p.sheetsPerKit;
          if(!Number.isSafeInteger(conversionNumerator)||conversionNumerator%p.multiplicity!==0)throw new Error('Это количество товара не даёт целое число физических листов по кратности. Введите фактическое количество листов.');
          sheets=conversionNumerator/p.multiplicity;
        }else sheets=quantity;
        if(request.action==='take'&&state.totals.taken+sheets>p.planSheets)throw new Error('Взятое в работу количество превышает план.');
        if(request.action==='print'&&state.totals.printed+sheets>p.planSheets)throw new Error('Годная печать превысит план. Листы сверх плана добавьте как излишек.');
        if(request.action==='cut'&&state.totals.cut+sheets>state.totals.printed)throw new Error('Порезка превышает подтверждённое количество годных напечатанных листов.');
      }
      var goods=p.xerox?sheets/p.sheetsPerKit*p.multiplicity:sheets;
      var area=p.planArea>0&&p.planKits>0&&request.action!=='cancel'&&(!p.xerox||['take','print','cut'].indexOf(request.action)>=0)?p.planArea*goods/p.planKits:'';
      var event={eventId:request.requestId,requestHash:hash,at:new Date().toISOString(),positionId:request.positionId,sourceId:books.source.getId(),sheetId:p.sheetId,shipment:p.shipment,article:p.article,employeeId:employee.id,employee:employee.name,action:request.action,unit:unit,enteredQuantity:quantity,sheets:p.xerox?sheets:'',kits:goods,areaM2:area,planKits:p.planKits,sheetsPerKit:p.sheetsPerKit,planSheets:p.planSheets,widthM:p.widthM||'',heightM:p.heightM||'',stage:stage,reason:reason,reverses:request.reverses||''};
      outcome.written=true;
      journal.appendRow(BOXW.eventHeaders.map(function(k){var v=k==='action'?BOXW.actions[event[k]]:k==='unit'?(event[k]==='kits'||event[k]==='pieces'?'Шт. товара':'Листы'):k==='stage'?(BOXW.actions[event[k]]||''):event[k];return typeof v==='string'&&v.charAt(0)==='='?"'"+v:v;}));events.push(event);
      PropertiesService.getScriptProperties().setProperty('BOX_REVISION',event.eventId);
      // Journal is the commit point. A retry repairs projection, never re-appends.
      state=boxTotals_(base,events,p);
    }
    boxProject_(books,sh,p,request.positionId,state.totals);
    return {ok:true,eventId:request.requestId,repeated:!!prior,totals:state.totals};
  };
  return sharedBooks?run():boxLocked_(run);
}
function onEdit(e){
  if(!e||!e.range||!boxEligible_(e.range.getSheet()))return;
  var sh=e.range.getSheet(),schema;
  try{schema=boxSchema_(sh);}catch(ignore){return;}
  var cols=[schema.taken,schema.printed,schema.cut,schema.printedAt,schema.cutAt,21,22,23,24,25,26,28,29].filter(Boolean);
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

// Owner-run, resumable layout migration. No event is appended, removed or rewritten.
function migrateBoxWorklogLayout(){
  return boxLocked_(function(){
    var books=boxBooks_(),props=PropertiesService.getScriptProperties(),report=[];
    props.setProperty('BOX_LAYOUT_V2_MIGRATING','1');
    var archive=books.journal.getSheetByName('_Колонки_резерв')||books.journal.insertSheet('_Колонки_резерв');
    if(!archive.getLastRow())archive.appendRow(['sheetId','part','snapshot']);archive.hideSheet();
    books.source.getSheets().forEach(function(sh){
      if(!boxEligible_(sh))return;
      var key='BOX_LAYOUT_V2_'+sh.getSheetId();if(props.getProperty(key)==='done'){report.push({sheetId:sh.getSheetId(),unchanged:true});return;}
      var saved=archive.getLastRow()>1?archive.getRange(2,1,archive.getLastRow()-1,3).getValues().filter(function(r){return Number(r[0])===sh.getSheetId();}).sort(function(a,b){return a[1]-b[1];}):[];
      var snapshot;
      if(saved.length){snapshot=JSON.parse(saved.map(function(r){return r[2];}).join(''));}
      else{
        if(boxCompact_(sh))throw new Error('Компактный лист без резервной записи: '+sh.getName());
        var schema=boxSchema_(sh),last=sh.getLastRow(),values=sh.getRange(5,1,Math.max(1,last-4),35).getValues(),formulas=sh.getRange(5,1,Math.max(1,last-4),35).getFormulas();
        snapshot={schema:schema,values:values,formulas:formulas};
        var json=JSON.stringify(snapshot),parts=[];for(var offset=0;offset<json.length;offset+=40000)parts.push([sh.getSheetId(),parts.length,json.slice(offset,offset+40000)]);
        archive.getRange(archive.getLastRow()+1,1,parts.length,3).setValues(parts);
        SpreadsheetApp.flush();
      }
      // Reject occupied destination cells instead of silently replacing user data.
      snapshot.values.forEach(function(r){[24,25,27,28].forEach(function(c){if(r[c]!==''&&r[c]!==undefined)throw new Error('Занята колонка назначения '+(c+1)+' в '+sh.getName());});});
      var byRow={};sh.createDeveloperMetadataFinder().withKey('RITM_BOX_POSITION').find().forEach(function(m){var location=m.getLocation().getRow();if(location)byRow[location.getRow()]=m.getValue();});
      var output=[],positions=0,sums=[0,0,0,0];
      snapshot.values.forEach(function(v,i){
        var row=i+5,article=String(v[snapshot.schema.article-1]||'').trim(),store=snapshot.formulas[i][26]||v[26]||'';
        if(!article){output.push(['','','','','','',store,'','']);return;}
        positions++;
        var plan=Number(v[snapshot.schema.plan-1])/Number(v[snapshot.schema.multiplicity-1])*Number(v[snapshot.schema.factor-1]),totals={taken:0,printed:0,cut:0,defect:0,surplus:0,takenAt:'',printedAt:'',cutAt:''};
        if(isFinite(plan)&&plan>0){
          totals.taken=snapshot.schema.taken&&v[snapshot.schema.taken-1]===true?plan:0;
          totals.printed=v[snapshot.schema.printed-1]===true?plan:0;totals.cut=v[snapshot.schema.cut-1]===true?plan:0;
          totals.takenAt=v[34]||'';totals.printedAt=v[snapshot.schema.printedAt-1]||'';totals.cutAt=v[snapshot.schema.cutAt-1]||'';
          if(byRow[row]){
            var p={sheetId:sh.getSheetId(),article:article,legacy:{taken:totals.taken,printed:totals.printed,cut:totals.cut},legacyDates:{takenAt:totals.takenAt,printedAt:totals.printedAt,cutAt:totals.cutAt}};
            totals=boxTotals_(boxBaseline_(books,p,byRow[row],false),boxEvents_(books.journal,byRow[row]),p).totals;
          }
        }
        [totals.defect,totals.surplus,totals.printed,totals.cut].forEach(function(n,j){if(Number(v[30+j])>0&&Number(v[30+j])!==n)throw new Error('Итоги журнала не совпали: '+article);sums[j]+=n;});
        var dates=boxDates_(totals,plan);
        output.push([dates[0],dates[1],dates[2],boxProgressFormula_(row),totals.defect,totals.surplus,store,totals.printed,totals.cut]);
      });
      sh.getRange(4,21,1,6).setValues([['Дата взятия в работу','Дата завершения печати','Дата завершения порезки','Прогресс печати / порезки','Брак, листы','Излишек, листы']]);
      sh.getRange(4,28,1,2).setValues([['Напечатано годных, листы','Порезано годных, листы']]);
      sh.getRange(5,25,output.length,2).setNumberFormat('0');sh.getRange(5,28,output.length,2).setNumberFormat('0');
      sh.getRange(5,21,output.length,9).clearDataValidations().setValues(output);
      sh.getRange(5,24,output.length,1).setNumberFormat('General').setFormulas(output.map(function(r){return [r[3]];}));
      sh.getRange(5,21,output.length,3).setNumberFormat('dd.MM.yyyy HH:mm');
      sh.getRange(5,25,output.length,2).setNumberFormat('0');sh.getRange(5,28,output.length,2).setNumberFormat('0');
      sh.getRange(4,21,output.length+1,9).setWrap(true).setVerticalAlignment('middle').setBorder(true,true,true,true,true,true,'#b8c7d6',SpreadsheetApp.BorderStyle.SOLID);
      sh.getRange(4,21,1,9).setBackground('#edf3fa').setFontWeight('bold').setFontSize(10);
      sh.getRange(5,21,output.length,9).setFontSize(10);
      sh.getRange(5,24,output.length,1).setFontColor('#2563a6');
      sh.getRange(5,25,output.length,1).setBackground('#fff1e9');sh.getRange(5,26,output.length,1).setBackground('#e8f5ef');
      sh.setColumnWidths(21,3,145);sh.setColumnWidth(24,235);sh.setColumnWidths(25,2,95);sh.setColumnWidths(28,2,120);
      sh.showColumns(21,9);sh.hideColumns(30,6);
      SpreadsheetApp.flush();
      var check=sh.getRange(5,25,output.length,5).getDisplayValues(),actual=[0,0,0,0];check.forEach(function(r){[r[0],r[1],r[3],r[4]].forEach(function(v,j){actual[j]+=Number(v)||0;});});
      if(JSON.stringify(actual)!==JSON.stringify(sums))throw new Error('Проверка переноса не прошла: '+sh.getName()+' expected='+JSON.stringify(sums)+' actual='+JSON.stringify(actual));
      props.setProperty(key,'done');report.push({sheetId:sh.getSheetId(),positions:positions,totals:sums});
    });
    props.deleteProperty('BOX_LAYOUT_V2_MIGRATING');props.setProperty('BOX_REVISION','layout-v2-'+Date.now());
    console.log(JSON.stringify({ok:true,sheets:report}));return {ok:true,sheets:report};
  });
}
