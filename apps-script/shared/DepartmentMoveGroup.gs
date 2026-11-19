// Shared by the BOX and roll gateways. One ScriptLock covers every member of
// the immutable group. A durable receipt precedes any destructive input clear.
function departmentMoveGroup_(sh,q,props,adapter){
  return adapter.lock(function(){
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(q.operationId||'')||!Array.isArray(q.positions)||q.positions.length<2||q.positions.length>10)throw Error('Не подтверждён пакет переноса.');
    var rows=Object.create(null),uids=Object.create(null),articles=Object.create(null),positions=q.positions.map(function(p){
      if(!p||!Number.isSafeInteger(p.row)||p.row<5||typeof p.uid!=='string'||!p.uid||typeof p.article!=='string'||!p.article||!Number.isSafeInteger(p.quantity)||p.quantity<=0||rows[p.row]||uids[p.uid]||articles[p.article.trim().toUpperCase()])throw Error('Повтор или неверная позиция пакета.');
      rows[p.row]=uids[p.uid]=articles[p.article.trim().toUpperCase()]=true;
      return {row:p.row,uid:p.uid,article:p.article,quantity:p.quantity};
    });
    var first=positions[0];if(first.row!==q.row||first.uid!==q.uid||first.article!==q.article||first.quantity!==q.quantity)throw Error('Изменился состав пакета.');
    var key=adapter.prefix+q.operationId,raw=props.getProperty(key),receipt=raw?JSON.parse(raw):null;
    if(receipt&&(receipt.sheetId!==sh.getSheetId()||JSON.stringify(receipt.positions)!==JSON.stringify(positions)))throw Error('Конфликт операции пакета.');
    if(receipt&&receipt.status==='removed'){
      positions.forEach(function(p){if(adapter.marker(sh,p.row)===q.operationId)adapter.clearMarker(sh,p.row,false);});
      return {ok:true,status:'removed',repeated:true};
    }
    var entries=positions.map(function(p){return {p:p,marker:adapter.marker(sh,p.row),values:sh.getRange(p.row,1,1,sh.getLastColumn()).getValues()[0]};});
    if(entries.some(function(e){return e.marker&&e.marker!==q.operationId;}))throw Error('Позиция занята другим переносом.');
    if(q.action==='abort'){
      if(receipt&&receipt.status==='removing')throw Error('Удаление уже начато. Отмена недоступна.');
      entries.forEach(function(e){adapter.clearMarker(sh,e.p.row,false);});
      // Keep the receipt bound to this exact group even after cancellation.
      props.setProperty(key,JSON.stringify({sheetId:sh.getSheetId(),positions:positions,status:'aborted'}));
      return {ok:true,status:'aborted'};
    }
    if(receipt&&receipt.status==='aborted')throw Error('Этот пакет отменён.');
    function blank(e){return [4,15,29].every(function(i){return e.values[i]==='';});}
    function finish(){receipt.status='removed';props.setProperty(key,JSON.stringify(receipt));entries.forEach(function(e){adapter.clearMarker(sh,e.p.row,true);});return {ok:true,status:'removed'};}
    if(receipt&&receipt.status==='removing'&&entries.every(blank))return finish();
    if(q.action==='status'){
      if(entries.every(function(e){return !e.marker;})&&!receipt)return {ok:true,status:'absent'};
      if(entries.some(function(e){return e.marker!==q.operationId;}))throw Error('Не подтверждены все блокировки пакета.');
      return {ok:true,status:'locked'};
    }
    var recovering=receipt&&receipt.status==='removing';
    entries.forEach(function(e){var p=e.p,v=e.values;
      if(recovering?!((v[4]===''||String(v[4])===p.article)&&(v[29]===''||String(v[29])===p.uid)&&(v[15]===''||v[15]===p.quantity)):String(v[4])!==p.article||String(v[29])!==p.uid||v[15]!==p.quantity)throw Error('Исходная позиция '+p.article+' изменилась.');
      [5,16,30].forEach(function(c){if(sh.getRange(p.row,c).getFormula())throw Error('Исходные данные позиции изменились на формулу.');});
    });
    if(q.action==='lock'){
      if(recovering)throw Error('Удаление пакета уже началось.');
      adapter.unstarted(sh,entries.filter(function(e){return !e.marker;}),q,props);
      receipt={sheetId:sh.getSheetId(),positions:positions,status:'locking'};
      var encoded=JSON.stringify(receipt);if(encodeURIComponent(encoded).replace(/%[A-F\d]{2}/gi,'x').length>8500)throw Error('Слишком длинные идентификаторы пакета.');
      props.setProperty(key,encoded);
      entries.forEach(function(e){if(!e.marker)sh.getRange(e.p.row+':'+e.p.row).addDeveloperMetadata(adapter.markerKey,q.operationId);});
      SpreadsheetApp.flush();
      if(entries.some(function(e){return adapter.marker(sh,e.p.row)!==q.operationId;}))throw Error('Блокировки пакета требуют сверки.');
      receipt.status='locked';props.setProperty(key,JSON.stringify(receipt));return {ok:true,status:'locked'};
    }
    if(q.action!=='remove'||entries.some(function(e){return e.marker!==q.operationId;}))throw Error('Нет подтверждённой блокировки пакета.');
    adapter.unstarted(sh,entries,q,props);
    receipt={sheetId:sh.getSheetId(),positions:positions,status:'removing'};props.setProperty(key,JSON.stringify(receipt));
    entries.forEach(function(e){adapter.columns.forEach(function(c){var cell=sh.getRange(e.p.row,c);if(!cell.getFormula())cell.clearContent();});});
    SpreadsheetApp.flush();
    if(entries.some(function(e){return [5,16,30].some(function(c){return sh.getRange(e.p.row,c).getValue()!=='';});}))throw Error('Удаление пакета требует сверки.');
    if(adapter.completed)adapter.completed(positions,q,props);
    return finish();
  });
}
