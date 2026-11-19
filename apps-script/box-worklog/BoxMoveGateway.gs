// This endpoint is deployed on the existing BOX worklog script so it shares
// boxLocked_ with employee saves. Secrets stay in ScriptProperties.
function setupBoxMoveGateway(){
  var props=PropertiesService.getScriptProperties();
  if(!props.getProperty('BOX_SOURCE_ID')||!props.getProperty('BOX_JOURNAL_ID'))throw new Error('Сначала подключите журнал бокса.');
  var existing=props.getProperty('BOX_MOVE_CONFIG_ID');
  if(existing)return {configId:existing};
  var token=Utilities.getUuid()+Utilities.getUuid(),book=SpreadsheetApp.create('RITM · Подключение переноса · приватно');
  book.getSheets()[0].getRange('A1').setValue(token);
  props.setProperties({BOX_MOVE_TOKEN:token,BOX_MOVE_CONFIG_ID:book.getId()});
  return {configId:book.getId()};
}
function doPost(e){
  try{
    var request=JSON.parse(e.postData.contents),props=PropertiesService.getScriptProperties();
    if(!props.getProperty('BOX_MOVE_TOKEN')||request.token!==props.getProperty('BOX_MOVE_TOKEN'))throw new Error('Доступ не подтверждён.');
    var source=SpreadsheetApp.openById(props.getProperty('BOX_SOURCE_ID')),journal=SpreadsheetApp.openById(props.getProperty('BOX_JOURNAL_ID'));
    if(request.action==='health')return ContentService.createTextOutput(JSON.stringify({ok:true,status:'ready',sourceId:source.getId(),capabilities:['move-group-v1']})).setMimeType(ContentService.MimeType.JSON);
    var sh=source.getSheetById(Number(request.sheetId));
    if(!sh||!boxEligible_(sh)||!/^[-a-f0-9]{36}$/i.test(String(request.operationId||'')))throw new Error('Не подтверждена поставка.');
    var result;
    if(Array.isArray(request.positions))result=boxMoveGroup_({source:source,journal:journal},sh,request,props);
    else if(request.action==='lock')result=boxAcquireMove_({source:source,journal:journal},sh,request);
    else result=boxMoveApply_(sh,request,props);
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }catch(error){return ContentService.createTextOutput(JSON.stringify({ok:false,message:String(error.message||error)})).setMimeType(ContentService.MimeType.JSON);}
}
function boxMoveApply_(sh,request,props){
  return boxLocked_(function(){
    var key='BOX_MOVE_RECEIPT_'+request.operationId,prior=props.getProperty(key);
    if(prior){var receipt=JSON.parse(prior);if(receipt.sheetId!==sh.getSheetId()||receipt.uid!==request.uid||receipt.article!==request.article||receipt.quantity!==request.quantity)throw new Error('Конфликт операции переноса.');if(receipt.status==='removed')return {ok:true,status:'removed',repeated:true};}
    if(!Number.isSafeInteger(request.row)||request.row<5)throw new Error('Неверная строка.');
    var lock=boxMoveLock_(sh,request.row);
    if(request.action==='status'&&!lock&&!prior)return {ok:true,status:'absent'};
    if(request.action==='abort'){
      if(prior)throw new Error('Удаление уже начато. Отмена недоступна.');
      if(lock&&lock!==request.operationId)throw new Error('Строка занята другим переносом.');
      sh.getRange(request.row+':'+request.row).getDeveloperMetadata().filter(function(m){return m.getKey()==='RITM_BOX_MOVE';}).forEach(function(m){m.remove();});
      return {ok:true,status:'aborted'};
    }
    if(lock!==request.operationId)throw new Error('Нет подтверждённой блокировки строки.');
    var v=sh.getRange(request.row,1,1,35).getValues()[0];
    if(prior&&receipt.status==='removing'&&v[4]===''&&v[15]===''&&v[29]===''){receipt.status='removed';props.setProperty(key,JSON.stringify(receipt));boxMoveClearMetadata_(sh,request.row);return {ok:true,status:'removed'};}
    if(request.action==='status')return {ok:true,status:'locked'};
    if(request.action!=='remove')throw new Error('Неизвестное действие переноса.');
    var recovering=prior&&receipt.status==='removing';
    if(recovering ? !((v[29]===''||String(v[29])===request.uid)&&(v[4]===''||String(v[4])===request.article)&&(v[15]===''||v[15]===request.quantity)) : String(v[29])!==request.uid||String(v[4])!==request.article||v[15]!==request.quantity)throw new Error('Исходная позиция изменилась.');
    if(v[18]===true||v[19]===true||[20,21,22,34].some(function(c){return v[c]!==''&&v[c]!==null;})||[24,25,27,28].some(function(c){return v[c]!==''&&v[c]!==0;}))throw new Error('По позиции появилась работа.');
    var receipt={sheetId:sh.getSheetId(),uid:request.uid,article:request.article,quantity:request.quantity,status:'removing',at:new Date().toISOString()};
    props.setProperty(key,JSON.stringify(receipt));
    [5,6,16,18,30].forEach(function(col){var cell=sh.getRange(request.row,col);if(!cell.getFormula())cell.clearContent();});
    SpreadsheetApp.flush();
    if(sh.getRange(request.row,5).getValue()!==''||sh.getRange(request.row,16).getValue()!==''||sh.getRange(request.row,30).getValue()!=='')throw new Error('Удаление исходной позиции требует сверки.');
    receipt.status='removed';props.setProperty(key,JSON.stringify(receipt));boxMoveClearMetadata_(sh,request.row);
    return {ok:true,status:'removed'};
  });
}

function boxMoveClearMetadata_(sh,row){sh.getRange(row+':'+row).getDeveloperMetadata().filter(function(m){return ['RITM_BOX_MOVE','RITM_BOX_POSITION'].indexOf(m.getKey())>=0;}).forEach(function(m){m.remove();});}

function boxMoveGroup_(books,sh,q,props){
  return departmentMoveGroup_(sh,q,props,{
    prefix:'BOX_MOVE_RECEIPT_',markerKey:'RITM_BOX_MOVE',columns:[5,6,16,18,30],lock:boxLocked_,marker:boxMoveLock_,
    clearMarker:function(sheet,row,all){if(all)boxMoveClearMetadata_(sheet,row);else sheet.getRange(row+':'+row).getDeveloperMetadata().filter(function(m){return m.getKey()==='RITM_BOX_MOVE';}).forEach(function(m){m.remove();});},
    unstarted:function(sheet,entries){
      if(!entries.length)return;
      var missing=[],ids=entries.map(function(e){
        var metadata=sheet.getRange(e.p.row+':'+e.p.row).getDeveloperMetadata().filter(function(m){return m.getKey()==='RITM_BOX_POSITION';});
        if(metadata.length>1)throw Error('Неоднозначный идентификатор позиции.');
        if(!metadata.length&&e.marker)throw Error('Исчез идентификатор заблокированной позиции.');
        var id=metadata.length?metadata[0].getValue():Utilities.getUuid();
        if(!metadata.length)missing.push({row:e.p.row,id:id});
        var v=e.values;
        if(v[18]===true||v[19]===true||[20,21,22,34].some(function(c){return v[c]!==''&&v[c]!==null&&v[c]!==undefined;})||[24,25,27,28].some(function(c){return v[c]!==''&&v[c]!==0&&v[c]!==undefined;}))throw Error('По позиции '+e.p.article+' появилась работа.');
        return id;
      }),events=boxEventsMany_(books.journal,ids),baseline=books.journal.getSheetByName('_Позиции'),byId=Object.create(null);
      if(!baseline)throw Error('Не подтверждён журнал позиций.');
      if(baseline.getLastRow()>1)baseline.getRange(2,1,baseline.getLastRow()-1,BOXW.positionHeaders.length).getValues().forEach(function(v){if(ids.indexOf(String(v[0]))<0)return;if(byId[v[0]])throw Error('Повтор позиции в журнале.');byId[v[0]]=v;});
      entries.forEach(function(e,i){var b=byId[ids[i]];
        if(b&&(b[1]!==books.source.getId()||Number(b[2])!==sheet.getSheetId()||b[3]!==e.p.article))throw Error('Изменилась связь с журналом.');
        if((events[ids[i]]||[]).length||b&&([4,5,6,7,8].some(function(c){return Number(b[c])>0;})||b[10]||b[11]||b[12]))throw Error('По позиции '+e.p.article+' есть история работы.');
      });
      missing.forEach(function(e){sheet.getRange(e.row+':'+e.row).addDeveloperMetadata('RITM_BOX_POSITION',e.id);});
    }
  });
}
