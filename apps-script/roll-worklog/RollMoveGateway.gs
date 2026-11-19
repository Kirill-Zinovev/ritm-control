// Production roll -> box gateway. Uses the same ScriptLock as roll writers.
function setupRollMoveGateway(){
 var p=PropertiesService.getScriptProperties(),token=SpreadsheetApp.openById('137J7p5T5jZvGMasnN_WfY2-pomZnebUo0Q2zjdfHI_c').getSheets()[0].getRange('A1').getValue();
 if(typeof token!=='string'||token.length<32)throw Error('Подключение переноса не найдено.');
 p.setProperties({ROLL_MOVE_TOKEN:token,ROLL_MOVE_SOURCE:'1hojhKS4Av_yy5sUMJcsoeJ_MQRU3V5g9P-fP61PO6Cs'});
 return {ok:true};
}
function rollMoveAssertWritable_(){
 var ss=SpreadsheetApp.getActiveSpreadsheet();
 if(ss&&ss.createDeveloperMetadataFinder().withKey('RITM_ROLL_MOVE').find().length)throw Error('Выполняется перенос артикула в бокс. Повторите запись через несколько секунд.');
}
function rollMoveMarker_(sh,row){var found=sh.getRange(row+':'+row).getDeveloperMetadata().filter(function(m){return m.getKey()==='RITM_ROLL_MOVE';});if(found.length>1)throw Error('Конфликт блокировки.');return found.length?found[0].getValue():null;}
function rollMoveClear_(sh,row){sh.getRange(row+':'+row).getDeveloperMetadata().filter(function(m){return m.getKey()==='RITM_ROLL_MOVE';}).forEach(function(m){m.remove();});}
function rollMoveUnstarted_(sh,row,uid,operation,props,historyTables){
 var map=r2HeaderMap_(sh),v=sh.getRange(row,1,1,sh.getLastColumn()).getValues()[0];
 function value(k){return map[k]?v[map[k]-1]:'';}
 if(map.article!==5||map.quantity!==16||map.uid!==30)throw Error('Не подтверждены колонки исходного листа.');
 if(['printDate','cutDate','roll'].some(function(k){return value(k)!=='';}))throw Error('По артикулу уже начата работа.');
 if(['print','cut','printProgress','cutProgress'].some(function(k){var x=value(k);return x===true||(typeof x==='number'&&x>0)||(/^(?:готов|готово|true|да)$/i.test(String(x).trim()))||parseFloat(String(x).replace(',','.'))>0;}))throw Error('По артикулу уже записана работа.');
 var book=sh.getParent(),required=['ROLLS_V2','Журнал выпуска'];
 required.forEach(function(name){if(!book.getSheetByName(name))throw Error('Не подтверждён журнал рулонов.');});
 var approvedHistory=false;
 ['ROLLS_V2','ROLLS_V2_PROGRESS','_SYSTEM_ROLLS','Журнал выпуска','_KPI_LOG'].forEach(function(name){var log=book.getSheetByName(name);if(log&&log.getLastRow()>1&&[uid].concat(typeof v[28]==='string'&&/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(v[28])?[v[28]]:[]).some(function(id){return historyTables?historyTables[name].some(function(row){return row.some(function(c){return String(c)===String(id);});}):log.getDataRange().createTextFinder(id).matchEntireCell(true).useRegularExpression(false).findNext();})){if(!approvedHistory)approvedHistory=rollMoveHistoryApproved_(sh,uid,operation,props);if(!approvedHistory&&(!v[28]||String(v[28])===String(uid)))approvedHistory=rollMoveDifferentArticleHistory_(book,uid,operation.article);if(!approvedHistory)throw Error('По артикулу есть рулон или запись в журнале.');}});
 return v;
}

// Some legacy rows reused an old order UID. Ignore history only when every
// occurrence can be matched to a canonical roll for a *different* article.
// Unknown schemas, orphan IDs and matching articles remain blocked.
function rollMoveDifferentArticleHistory_(book,uid,article){
 if(!uid||!article)return false;
 var names=['ROLLS_V2','ROLLS_V2_PROGRESS','_SYSTEM_ROLLS','Журнал выпуска','_KPI_LOG'],all={},target=String(article).trim().toUpperCase(),key=String(uid);
 for(var i=0;i<names.length;i++){
  var sh=book.getSheetByName(names[i]);if(!sh||sh.getLastRow()<2)continue;
  var values=sh.getDataRange().getValues();all[names[i]]=values;
 }
 var rolls=all.ROLLS_V2;if(!rolls||rolls[0][0]!=='ROLL_ID'||rolls[0][1]!=='ORDER_UID'||rolls[0][4]!=='ARTICLE')return false;
 var canonical={},found=false;
 for(var r=1;r<rolls.length;r++){
  var line=rolls[r];if(!line.some(function(c){return String(c)===key;}))continue;
  if(String(line[1])!==key||!line[0]||!line[4]||String(line[4]).trim().toUpperCase()===target||canonical[String(line[0])])return false;
  canonical[String(line[0])]=true;found=true;
 }
 if(!found)return false;
 var defs={'ROLLS_V2_PROGRESS':[2,5,1,'ORDER_UID','ARTICLE','ROLL_ID'],'_SYSTEM_ROLLS':[0,-1,8,'UID',null,'ROLL_ID'],'Журнал выпуска':[7,6,14,'UID заказа','Артикул','ID рулона']};
 for(var n in all){if(n==='ROLLS_V2')continue;var rows=all[n],def=defs[n];
  for(var j=1;j<rows.length;j++){var row=rows[j];if(!row.some(function(c){return String(c)===key;}))continue;
   if(!def||rows[0][def[0]]!==def[3]||rows[0][def[2]]!==def[5]||(def[1]>=0&&rows[0][def[1]]!==def[4])||String(row[def[0]])!==key||!canonical[String(row[def[2]])])return false;
   if(def[1]>=0&&(!row[def[1]]||String(row[def[1]]).trim().toUpperCase()===target))return false;
  }
 }
 return true;
}
function rollMoveApply_(sh,q,props){
 var lock=LockService.getScriptLock();if(!lock.tryLock(10000))throw Error('Рулоны заняты другой записью. Повторите тот же запрос.');
 try{
  if(!Number.isSafeInteger(q.row)||q.row<5||!/^[-a-f0-9]{36}$/i.test(q.operationId||''))throw Error('Не подтверждена позиция.');
  var key='ROLL_MOVE_RECEIPT_'+q.operationId,prior=props.getProperty(key),receipt=prior?JSON.parse(prior):null,marker=rollMoveMarker_(sh,q.row);
  if(receipt&&(receipt.sheetId!==sh.getSheetId()||receipt.uid!==q.uid||receipt.article!==q.article||receipt.quantity!==q.quantity))throw Error('Конфликт операции.');
  if(receipt&&receipt.status==='removed')return {ok:true,status:'removed',repeated:true};
  if(q.action==='status'&&!marker&&!prior)return {ok:true,status:'absent'};
  if(q.action==='abort'){if(prior||marker&&marker!==q.operationId)throw Error('Отмена недоступна.');rollMoveClear_(sh,q.row);return {ok:true,status:'aborted'};}
  var v=sh.getRange(q.row,1,1,sh.getLastColumn()).getValues()[0],recovering=receipt&&receipt.status==='removing';
  if(q.action==='lock'){
   if(String(v[4])!==q.article||String(v[29])!==q.uid||v[15]!==q.quantity)throw Error('Исходная позиция изменилась.');
   if(marker&&marker!==q.operationId)throw Error('Строка уже переносится.');
   if(!marker){rollMoveUnstarted_(sh,q.row,q.uid,q,props);sh.getRange(q.row+':'+q.row).addDeveloperMetadata('RITM_ROLL_MOVE',q.operationId);SpreadsheetApp.flush();}
   return {ok:true,status:'locked'};
  }
  if(marker!==q.operationId)throw Error('Нет подтверждённой блокировки.');
  if(q.action==='status')return {ok:true,status:'locked'};
  if(q.action!=='remove')throw Error('Неизвестное действие.');
  if(recovering? !((v[4]===''||String(v[4])===q.article)&&(v[29]===''||String(v[29])===q.uid)&&(v[15]===''||v[15]===q.quantity)) : String(v[4])!==q.article||String(v[29])!==q.uid||v[15]!==q.quantity)throw Error('Исходная позиция изменилась.');
  rollMoveUnstarted_(sh,q.row,q.uid,q,props);
  receipt={sheetId:sh.getSheetId(),uid:q.uid,article:q.article,quantity:q.quantity,status:'removing'};props.setProperty(key,JSON.stringify(receipt));
  [5,6,16,25,30].forEach(function(c){var cell=sh.getRange(q.row,c);if(!cell.getFormula())cell.clearContent();});SpreadsheetApp.flush();
  if(sh.getRange(q.row,5).getValue()!==''||sh.getRange(q.row,16).getValue()!==''||sh.getRange(q.row,30).getValue()!=='')throw Error('Удаление требует сверки.');
  receipt.status='removed';props.setProperty(key,JSON.stringify(receipt));var approvalKey='ROLL_MOVE_HISTORY_APPROVAL_'+q.uid,approvalText=props.getProperty(approvalKey);if(approvalText){var approval=JSON.parse(approvalText);if(approval.operationId===q.operationId){approval.completed=true;approval.completedAt=new Date().toISOString();props.setProperty(approvalKey,JSON.stringify(approval));}}rollMoveClear_(sh,q.row);return {ok:true,status:'removed'};
 }finally{lock.releaseLock();}
}
function doPost(e){try{
 var q=JSON.parse(e.postData.contents),props=PropertiesService.getScriptProperties();
 if(!props.getProperty('ROLL_MOVE_TOKEN')||q.token!==props.getProperty('ROLL_MOVE_TOKEN'))throw Error('Доступ не подтверждён.');
 var book=SpreadsheetApp.openById(props.getProperty('ROLL_MOVE_SOURCE'));
 if(q.action==='health')return rollMoveJson_({ok:true,status:'ready',capabilities:['move-group-v1']});
 var sh=book.getSheetById(Number(q.sheetId));if(!sh||!r2IsTargetSheet_(sh))throw Error('Не подтверждён лист поставки.');
 return rollMoveJson_(Array.isArray(q.positions)?rollMoveGroup_(sh,q,props):rollMoveApply_(sh,q,props));
 }catch(e){return rollMoveJson_({ok:false,message:String(e.message||e)});}}
function rollMoveJson_(v){return ContentService.createTextOutput(JSON.stringify(v)).setMimeType(ContentService.MimeType.JSON);}

function rollMoveGroup_(sh,q,props){
 return departmentMoveGroup_(sh,q,props,{
  prefix:'ROLL_MOVE_RECEIPT_',markerKey:'RITM_ROLL_MOVE',columns:[5,6,16,25,30],marker:rollMoveMarker_,
  lock:function(fn){var lock=LockService.getScriptLock();if(!lock.tryLock(10000))throw Error('Рулоны заняты другой записью. Повторите тот же запрос.');try{return fn();}finally{lock.releaseLock();}},
  clearMarker:function(sheet,row){rollMoveClear_(sheet,row);},
  unstarted:function(sheet,entries){
   if(!entries.length)return;
   var book=sheet.getParent(),tables=Object.create(null);
   ['ROLLS_V2','ROLLS_V2_PROGRESS','_SYSTEM_ROLLS','Журнал выпуска','_KPI_LOG'].forEach(function(name){var log=book.getSheetByName(name);tables[name]=log&&log.getLastRow()>1?log.getDataRange().getValues():[];});
   entries.forEach(function(e){rollMoveUnstarted_(sheet,e.p.row,e.p.uid,Object.assign({},e.p,{operationId:q.operationId}),props,tables);});
  },
  completed:function(positions,request,properties){positions.forEach(function(p){var key='ROLL_MOVE_HISTORY_APPROVAL_'+p.uid,raw=properties.getProperty(key);if(!raw)return;var approval=JSON.parse(raw);if(approval.operationId===request.operationId){approval.completed=true;approval.completedAt=new Date().toISOString();properties.setProperty(key,JSON.stringify(approval));}});}
 });
}

// Owner-created approvals are scoped to one exact current position and frozen
// historical rows. Ordinary requests cannot create or widen this permission.
function rollMoveHistorySnapshot_(book,uid){
 var rows=[];
 ['ROLLS_V2','ROLLS_V2_PROGRESS','_SYSTEM_ROLLS','Журнал выпуска','_KPI_LOG'].forEach(function(name){
  var sh=book.getSheetByName(name);if(!sh||sh.getLastRow()<2)return;
  var seen={};sh.getDataRange().createTextFinder(uid).matchEntireCell(true).useRegularExpression(false).findAll().forEach(function(cell){
   var row=cell.getRow();if(row<2||seen[row])return;seen[row]=true;
   rows.push({sheet:name,row:row,values:sh.getRange(row,1,1,sh.getLastColumn()).getValues()[0]});
  });
 });
 return JSON.stringify(rows);
}
function rollMoveHistoryApproved_(sh,uid,q,props){
 if(!q||!props)return false;
 var key='ROLL_MOVE_HISTORY_APPROVAL_'+uid,raw=props.getProperty(key);if(!raw)return false;
 var a=JSON.parse(raw);
 if(String(sh.getRange(q.row,1,1,sh.getLastColumn()).getValues()[0][28]||'')!==a.legacyUid)throw Error('Старый идентификатор строки изменился.');
 if(a.completed||a.uid!==uid||a.sheetId!==sh.getSheetId()||a.row!==q.row||a.article!==q.article||a.quantity!==q.quantity||a.expiresAt<Date.now()||a.operationId&&a.operationId!==q.operationId)throw Error('Разовое разрешение на перенос истории не подтверждено.');
 if(rollMoveHistorySnapshot_(sh.getParent(),uid)!==a.history)throw Error('История старого рулона изменилась. Перенос остановлен без удаления истории.');
 if(!a.operationId){a.operationId=q.operationId;props.setProperty(key,JSON.stringify(a));}
 return true;
}
