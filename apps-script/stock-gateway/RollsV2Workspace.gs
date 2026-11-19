/** Focused and bulk roll work. Existing storage, journals, corrections and writers stay authoritative. */
function r2WorkspaceDigest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value))
    .map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('').slice(0, 24);
}

function r2WorkspaceProgressValues_(event) {
  return [event.id, event.rollId, event.uid, event.sheetName, event.sourceRow, event.article,
    event.operation, event.employee, event.date, event.quantity, event.areaPerPiece, event.area,
    event.enteredAt, event.comment];
}

// A separate append-only receipt keeps previous names and quantities without
// rewriting the print/cut journal. It is created only on the first real edit.
var R2_EDIT_HISTORY = 'ROLLS_V2_EDIT_HISTORY';
var R2_EDIT_HEADERS = ['REQUEST_ID','FINGERPRINT','ROLL_ID','ORDER_UID','SHEET_SOURCE','ARTICLE',
  'OLD_NAME','NEW_NAME','OLD_QUANTITY','NEW_QUANTITY','PRINT_ACTUAL','CUT_ACTUAL','SAVED_AT','STATUS'];
function r2WorkspaceEditAudit_(item, fingerprint, create) {
  var book=SpreadsheetApp.getActiveSpreadsheet(), sheet=book.getSheetByName(R2_EDIT_HISTORY);
  if(!sheet && !create)return null;
  if(!sheet)sheet=book.insertSheet(R2_EDIT_HISTORY);
  if(sheet.getLastRow()===0){if(!create)return null;sheet.getRange(1,1,1,R2_EDIT_HEADERS.length).setValues([R2_EDIT_HEADERS]);}
  var last=sheet.getLastRow(), rows=sheet.getRange(1,1,last,R2_EDIT_HEADERS.length).getValues();
  if(R2_EDIT_HEADERS.some(function(h,i){return String(rows[0][i]||'').trim()!==h;}))
    throw new Error('Заголовки истории изменений рулонов отличаются. Изменение остановлено.');
  var matches=[];
  rows.slice(1).forEach(function(row,i){if(String(row[0]||'')===item.requestId)matches.push({row:i+2,values:row});});
  if(matches.length>1)throw new Error('В истории повторяется ID изменения. Нужна сверка.');
  if(matches.length){
    if(String(matches[0].values[1]||'')!==fingerprint)throw new Error('Этот запрос уже использован с другими данными.');
    return {sheet:sheet,row:matches[0].row,status:String(matches[0].values[13]||'')};
  }
  if(!create)return null;
  var row=last+1;
  sheet.getRange(row,1,1,R2_EDIT_HEADERS.length).setValues([[item.requestId,fingerprint,item.rollId,item.uid,
    item.sheetName,item.article,item.expectedName,item.name,item.expectedQuantity,item.quantity,
    item.expectedPrintActual,item.expectedCutActual,new Date(),'pending']]);
  return {sheet:sheet,row:row,status:'pending'};
}
function r2WorkspaceEditFinishAudit_(audit) {
  audit.sheet.getRange(audit.row,14).setValue('confirmed');
}

/** Edit metadata under the same document lock, retaining all production events. */
function r2WorkspaceEdit(payload) {
  var writeState={started:!!(payload&&payload.resume)};
  try{return r2WorkspaceEdit_(payload,writeState);}
  catch(error){if(!writeState.started)return {requestId:payload&&payload.requestId,rejected:true,message:String(error&&error.message||error)};throw error;}
}
function r2WorkspaceEdit_(payload,writeState) {
  if(!payload||!/^[A-Za-z0-9_-]{8,100}$/.test(String(payload.requestId||''))||!payload.rollId||!payload.uid||!payload.sheetName||!payload.article||!Number.isInteger(Number(payload.row)))
    throw new Error('Не подтверждён выбранный рулон. Обновите выделение.');
  var item={requestId:String(payload.requestId),rollId:String(payload.rollId),uid:String(payload.uid),sheetName:String(payload.sheetName),
    row:Number(payload.row),article:String(payload.article),expectedName:String(payload.expectedName||'').trim(),name:String(payload.name||'').trim(),
    expectedQuantity:Number(payload.expectedQuantity),quantity:Number(payload.quantity),
    expectedPrintActual:Number(payload.expectedPrintActual),expectedCutActual:Number(payload.expectedCutActual),
    expectedPrint:payload.expectedPrint===true,expectedCut:payload.expectedCut===true};
  if(!item.expectedName||!r2Employee_(item.name))throw new Error('Название должно начинаться с д, а или п.');
  if(item.name.length>120||!Number.isInteger(item.quantity)||item.quantity<1||!Number.isInteger(item.expectedQuantity)||item.expectedQuantity<1||
    !Number.isFinite(item.expectedPrintActual)||item.expectedPrintActual<0||!Number.isFinite(item.expectedCutActual)||item.expectedCutActual<0)
    throw new Error('Укажите целое количество больше нуля и проверьте данные рулона.');
  var fingerprint=r2WorkspaceDigest_(item);
  r2EnsureInitialized_();
  return withDocumentLock_(function(){
    var snapshot={rolls:r2ReadStore_(true),journal:r2JournalRows_(true),progress:r2ProgressRows_(true)};
    var order=r2GetOrder_(item.uid,item.sheetName,item.row);
    if(order.article!==item.article)throw new Error('Артикул в строке изменился. Обновите выделение.');
    var matches=snapshot.rolls.filter(function(r){return r.rollId===item.rollId;});
    if(matches.length!==1)throw new Error('Рулон не найден однозначно. Обновите выделение.');
    var roll=matches[0];
    if(roll.uid!==order.uid||roll.sheetName!==order.sheetName||roll.article!==order.article)
      throw new Error('Рулон относится к другому заказу. Обновите выделение.');
    var audit=r2WorkspaceEditAudit_(item,fingerprint,false);
    if(audit){writeState.started=true;if(audit.status==='confirmed')return r2PanelSerializable_({requestId:item.requestId,confirmed:true,order:r2DecorateOrder_(order,snapshot),message:'Изменение уже сохранено.'});
      if(audit.status!=='pending')throw new Error('Неизвестное состояние изменения. Нужна сверка.');}
    var before=roll.name===item.expectedName&&Number(roll.quantity)===item.expectedQuantity;
    var after=roll.name===item.name&&Number(roll.quantity)===item.quantity;
    if(!before&&!(audit&&after))throw new Error('Название или количество уже изменилось. Обновите выделение.');
    var related=r2RollsForOrder_(order,snapshot.rolls);
    var print=r2OperationTotals_(order,'Печать',related,snapshot),cut=r2OperationTotals_(order,'Резка',related,snapshot);
    var printActual=r2ProgressActualForRoll_(roll,print,roll.print),cutActual=r2ProgressActualForRoll_(roll,cut,roll.cut);
    if(before){
      if(Math.abs(printActual-item.expectedPrintActual)>1e-9||Math.abs(cutActual-item.expectedCutActual)>1e-9||!!roll.print!==item.expectedPrint||!!roll.cut!==item.expectedCut)
        throw new Error('Выработка рулона изменилась. Обновите выделение.');
      if(item.quantity!==item.expectedQuantity&&(roll.print||roll.cut))
        throw new Error('Этап рулона уже завершён. Его количество менять нельзя; для дополнительного количества создайте новый рулон.');
      if(item.quantity<Math.max(printActual,cutActual))
        throw new Error('Количество не может быть меньше уже записанной печати или порезки.');
      var hasPrintHistory=!!roll.print||printActual>0||snapshot.progress.some(function(e){return e.rollId===roll.rollId&&e.operation==='Печать';})||snapshot.journal.some(function(e){return e.rollId===roll.rollId&&e.operation==='Печать';});
      if(hasPrintHistory&&r2Employee_(item.expectedName)!==r2Employee_(item.name))
        throw new Error('У рулона уже есть печать. Сменить сотрудника через название нельзя; создайте другой рулон.');
      if(related.some(function(r){return r.rollId!==roll.rollId&&r.name===item.name&&Number(r.number)===Number(roll.number);}))
        throw new Error('В этом заказе уже есть рулон с таким названием и номером.');
    }
    if(!audit){writeState.started=true;audit=r2WorkspaceEditAudit_(item,fingerprint,true);}
    if(before&&!after){
      roll.name=item.name;roll.quantity=item.quantity;roll.updated=new Date();roll.orderRow=order.row;
      r2PanelWriteRecordBlocks_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(R2_CFG.STORE),[roll],R2_CFG.STORE_HEADERS.length,r2PanelRollValues_);
    }
    r2UpdateOrderProgress_(order,false,snapshot);r2PanelTouch_();SpreadsheetApp.flush();
    r2WorkspaceEditFinishAudit_(audit);
    return r2PanelSerializable_({requestId:item.requestId,confirmed:true,order:r2DecorateOrder_(order,snapshot),
      revision:PropertiesService.getDocumentProperties().getProperty('R2_PANEL_REVISION')||'',message:'Рулон изменён. История печати и порезки сохранена.'});
  });
}

/** Create independent rolls for the selected articles in one locked, resumable request. */
function r2WorkspaceCreate(payload) {
  var writeState = {started: !!(payload && payload.resume)};
  try { return r2WorkspaceCreate_(payload, writeState); }
  catch (error) {
    if (!writeState.started) return {requestId: payload && payload.requestId, rejected: true,
      message: String(error && error.message || error)};
    throw error;
  }
}

function r2WorkspaceCreate_(payload, writeState) {
  if (!payload || !/^[A-Za-z0-9_-]{8,100}$/.test(String(payload.requestId || '')))
    throw new Error('Не удалось проверить запрос создания рулонов.');
  if (!Array.isArray(payload.items) || !payload.items.length) throw new Error('Выберите артикулы.');
  var seen = {}, total = 0;
  var items = payload.items.map(function(item) {
    if (!item || !item.uid || !item.sheetName || !item.article || !Number.isInteger(Number(item.row)))
      throw new Error('Не подтверждена строка артикула. Обновите выделение.');
    var key = item.sheetName + '|' + item.uid;
    if (seen[key]) throw new Error('Один артикул выбран дважды.');
    seen[key] = true;
    var name = String(item.name || '').trim(), count = Number(item.count);
    var quantity = item.quantity == null || item.quantity === '' ? null : Number(item.quantity);
    var plan = Number(item.expectedPlan), allocated = Number(item.expectedAllocated);
    if (!name || !r2Employee_(name)) throw new Error('Название рулона должно начинаться с д, а или п: ' + item.article + '.');
    if (!Number.isInteger(count) || count < 1 || count > 500 ||
        (quantity !== null && (!Number.isInteger(quantity) || quantity < 1)) ||
        !Number.isInteger(plan) || plan < 1 || !Number.isFinite(allocated) || allocated < 0)
      throw new Error('Укажите целые положительные количества: ' + item.article + '.');
    total += count;
    return {uid: String(item.uid), sheetName: String(item.sheetName), row: Number(item.row),
      article: String(item.article), name: name, count: count, quantity: quantity,
      expectedPlan: plan, expectedAllocated: allocated};
  });
  if (total > 500) throw new Error('За один запрос можно создать до 500 рулонов.');
  var fingerprint = r2WorkspaceDigest_(items), prefix = 'UI_R2A_' + payload.requestId + '_';
  r2EnsureInitialized_();
  return withDocumentLock_(function() {
    var snapshot = {rolls: r2ReadStore_(true), journal: r2JournalRows_(true), progress: r2ProgressRows_(true)};
    var prior = snapshot.rolls.filter(function(r) { return r.rollId.indexOf(prefix) === 0; });
    if (prior.length) writeState.started = true;
    if (prior.some(function(r) { return r.rollId.indexOf(prefix + fingerprint + '_') !== 0; }))
      throw new Error('Этот запрос создания уже записан с другими данными.');
    var orders = [], fresh = [], expectedIds = {}, index = 0, now = new Date();
    items.forEach(function(item) {
      var order = r2GetOrder_(item.uid, item.sheetName, item.row);
      if (order.article !== item.article) throw new Error('Артикул в строке изменился. Обновите выделение.');
      r2OrderArea_(order);
      var belongs = function(r) { return r.uid === order.uid && r.sheetName === order.sheetName && r.article === order.article; };
      var existing = snapshot.rolls.filter(belongs);
      var other = existing.filter(function(r) { return r.rollId.indexOf(prefix) !== 0; });
      var allocated = other.reduce(function(sum, r) { return sum + Number(r.quantity); }, 0);
      var quantity = item.quantity === null ? Number(order.orderQty) : item.quantity;
      // A fully persisted item only needs acknowledgement. Later allocations/plans must not trap its retry.
      var complete = true;
      for (var n = 0; n < item.count; n++) {
        if (!prior.some(function(r) { return r.rollId === prefix + fingerprint + '_' + (index + n); })) complete = false;
      }
      if (!complete && (Number(order.orderQty) !== item.expectedPlan || Math.abs(allocated - item.expectedAllocated) > 1e-9))
        throw new Error('План или распределение артикула ' + item.article + ' изменилось. Обновите выделение.');
      if (item.quantity === null) quantity = item.expectedPlan;
      var number = other.filter(function(r) { return r.name === item.name; })
        .reduce(function(max, r) { return Math.max(max, r.number); }, 0);
      for (var i = 1; i <= item.count; i++) {
        var id = prefix + fingerprint + '_' + index++; expectedIds[id] = true;
        var matches = prior.filter(function(r) { return r.rollId === id; });
        if (matches.length > 1) throw new Error('В хранилище повторяется ID рулона. Нужна сверка.');
        var saved = matches[0];
        if (saved && (!belongs(saved) || saved.name !== item.name || Number(saved.quantity) !== quantity))
          throw new Error('Сохранённый рулон не соответствует запросу. Повторное создание остановлено.');
        if (!saved) fresh.push({rollId: id, uid: order.uid, sheetName: order.sheetName, orderRow: order.row,
          article: order.article, name: item.name, number: number + i, quantity: quantity,
          print: false, cut: false, created: now, updated: now, printDoneAt: null,
          cutDoneAt: null, printEmployee: '', cutEmployee: '', legacy: false});
      }
      orders.push(order);
    });
    if (prior.some(function(r) { return !expectedIds[r.rollId]; })) throw new Error('Состав запроса создания изменился.');
    // Stable roll IDs are the creation receipts. A lost response resumes these rows instead of appending copies.
    writeState.started = true;
    if (fresh.length) {
      r2PanelWriteRecordBlocks_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(R2_CFG.STORE), fresh,
        R2_CFG.STORE_HEADERS.length, r2PanelRollValues_);
      snapshot.rolls = snapshot.rolls.concat(fresh);
    }
    orders.forEach(function(order) { r2UpdateOrderProgress_(order, false, snapshot); });
    r2PanelTouch_(); SpreadsheetApp.flush();
    return r2PanelSerializable_({requestId: payload.requestId,
      orders: orders.map(function(order) { return r2DecorateOrder_(order, snapshot); }),
      created: fresh.length, confirmed: total,
      message: 'Рулоны созданы: ' + total + '. Артикулов: ' + orders.length + '. Печать и порезка ещё не отмечены.'});
  });
}

function r2WorkspaceSave(payload) {
  var writeState = {started: !!(payload && payload.resume)};
  try { return r2WorkspaceSave_(payload, writeState); }
  catch (error) {
    if (!writeState.started) return {requestId: payload && payload.requestId, rejected: true,
      message: String(error && error.message || error)};
    throw error;
  }
}

function r2WorkspaceSave_(payload, writeState) {
  if (!payload || !/^[A-Za-z0-9_-]{8,100}$/.test(String(payload.requestId || '')))
    throw new Error('Не удалось проверить сохранение. Откройте панель заново.');
  if (payload.operation !== 'Печать' && payload.operation !== 'Резка') throw new Error('Выберите печать или порезку.');
  if (!Array.isArray(payload.items) || !payload.items.length) throw new Error('Выберите рулоны.');
  var comment = String(payload.comment || '').trim();
  if (comment.length > 2000) throw new Error('Сократите комментарий до 2000 символов.');
  var operation = payload.operation, isPrint = operation === 'Печать', seen = {};
  var items = payload.items.map(function(item) {
    if (!item || !item.rollId || !item.uid || !item.sheetName || !Number.isInteger(Number(item.row)))
      throw new Error('Не подтверждена строка рулона. Обновите выделение.');
    if (seen[item.rollId]) throw new Error('Один рулон выбран дважды. Обновите выделение.');
    seen[item.rollId] = true;
    var expected = Number(item.expectedActual), planned = Number(item.expectedQuantity);
    var amount = item.quantity == null || item.quantity === '' ? null : Number(item.quantity);
    if (!Number.isFinite(expected) || expected < 0 || !Number.isInteger(planned) || planned <= 0 ||
        (amount !== null && (!Number.isInteger(amount) || amount <= 0)))
      throw new Error('Укажите целое положительное количество или оставьте поле пустым.');
    return {rollId: String(item.rollId), uid: String(item.uid), sheetName: String(item.sheetName),
      row: Number(item.row), expectedActual: expected, expectedQuantity: planned, quantity: amount};
  });
  var fingerprint = r2WorkspaceDigest_({operation: operation, comment: comment, items: items});
  var prefix = 'UI_R2W_' + payload.requestId + '_';
  r2EnsureInitialized_();
  return withDocumentLock_(function() {
    var snapshot = {rolls: r2ReadStore_(true), journal: r2JournalRows_(true), progress: r2ProgressRows_(true)};
    if (snapshot.progress.some(function(e) { return e.id.indexOf(prefix) === 0; })) writeState.started = true;
    if (snapshot.progress.some(function(e) { return e.id.indexOf(prefix) === 0 && e.id.indexOf(prefix + fingerprint + '_') !== 0; }))
      throw new Error('Этот запрос уже сохранён с другими данными. Проверьте результат предыдущей записи.');
    var orders = {}, plans = [], skipped = 0;
    // Validate every selected position before the first write. Scope is UID + sheet + article, never article alone.
    items.forEach(function(item, index) {
      var key = item.sheetName + '|' + item.uid;
      var order = orders[key];
      if (!order) {
        order = r2GetOrder_(item.uid, item.sheetName, item.row);
        r2OrderArea_(order); orders[key] = order;
      }
      var matches = snapshot.rolls.filter(function(r) { return r.rollId === item.rollId; });
      if (matches.length !== 1) throw new Error('Рулон не найден однозначно. Обновите выделение.');
      var roll = matches[0];
      if (roll.uid !== order.uid || roll.sheetName !== order.sheetName || roll.article !== order.article)
        throw new Error('Рулон не относится к выбранному заказу. Обновите выделение.');
      var id = prefix + fingerprint + '_' + index;
      var receipts = snapshot.progress.filter(function(e) { return e.id === id; });
      if (receipts.length > 1) throw new Error('В истории повторяется ID записи. Нужна сверка.');
      var receipt = receipts[0], ready = isPrint ? roll.print : roll.cut;
      if (!receipt && ready) { skipped++; return; }
      if (Number(roll.quantity) !== item.expectedQuantity) throw new Error('Количество рулона «' + roll.name + '» изменилось. Обновите выделение.');
      var current = snapshot.progress.filter(function(e) { return e.rollId === roll.rollId && e.operation === operation; })
        .reduce(function(sum, e) { return sum + e.quantity; }, 0);
      var quantity = item.quantity == null ? item.expectedQuantity - item.expectedActual : item.quantity;
      if (!Number.isInteger(quantity) || quantity < 0 || quantity + item.expectedActual > item.expectedQuantity)
        throw new Error('Количество превышает остаток рулона «' + roll.name + '». Обновите выделение.');
      var employee = r2EmployeeForOperation_(roll, order, operation, isPrint ? roll.printEmployee : roll.cutEmployee);
      if (!employee) throw new Error('Название рулона «' + roll.name + '» должно начинаться с д, а или п.');
      if (receipt) {
        if (receipt.rollId !== roll.rollId || receipt.uid !== order.uid || receipt.sheetName !== order.sheetName ||
            receipt.article !== order.article || receipt.operation !== operation || receipt.quantity !== quantity ||
            receipt.employee !== employee || receipt.comment !== comment)
          throw new Error('Сохранённая запись не соответствует запросу. Нужна сверка.');
      } else if (Math.abs(current - item.expectedActual) > 1e-9) {
        throw new Error('По рулону «' + roll.name + '» уже записана другая работа. Обновите выделение.');
      }
      var now = new Date();
      var event = receipt || {id: id, rollId: roll.rollId, uid: order.uid, sheetName: order.sheetName,
        sourceRow: order.row, article: order.article, operation: operation, employee: employee,
        date: r2MoscowDay_(now), quantity: quantity, areaPerPiece: order.areaPerPiece,
        area: quantity * order.areaPerPiece, enteredAt: now, comment: comment};
      var autoId = 'AUTO_' + (isPrint ? 'PRINT_' : 'CUT_') + roll.rollId;
      if (snapshot.journal.filter(function(e) { return e.id === autoId; }).length > 1)
        throw new Error('В журнале повторяется запись рулона. Нужна сверка.');
      plans.push({order: order, roll: roll, event: event, received: !!receipt, employee: employee});
    });
    var book = SpreadsheetApp.getActiveSpreadsheet();
    var progressSheet = book.getSheetByName(R2_CFG.PROGRESS_STORE), store = book.getSheetByName(R2_CFG.STORE);
    var journalSheet = book.getSheetByName(R2_CFG.JOURNAL);
    var fresh = plans.filter(function(p) { return !p.received; }).map(function(p) { return p.event; });
    // Durable receipt first. A resumed request repairs subsequent derived writes without adding the fact twice.
    if (plans.length) writeState.started = true;
    if (fresh.length) {
      r2PanelWriteRecordBlocks_(progressSheet, fresh, R2_CFG.PROGRESS_HEADERS.length, r2WorkspaceProgressValues_);
      fresh.forEach(function(event) { snapshot.progress.push(event); });
    }
    var rolls = [], releases = [], completed = 0, partial = 0;
    plans.forEach(function(plan) {
      var roll = plan.roll, order = plan.order;
      var facts = snapshot.progress.filter(function(e) { return e.rollId === roll.rollId && e.operation === operation; });
      var actual = Math.max(0, facts.reduce(function(sum, e) { return sum + e.quantity; }, 0));
      if (actual >= Number(roll.quantity)) {
        var eventId = 'AUTO_' + (isPrint ? 'PRINT_' : 'CUT_') + roll.rollId;
        var existing = snapshot.journal.filter(function(e) { return e.id === eventId; });
        if (existing.length > 1) throw new Error('В журнале повторяется запись рулона. Повторная выработка не добавлялась.');
        var enteredAt = (isPrint ? roll.printDoneAt : roll.cutDoneAt) || plan.event.enteredAt;
        var area = facts.reduce(function(sum, e) { return sum + e.area; }, 0);
        var release = {id: eventId, row: existing.length ? existing[0].row : 0, date: r2MoscowDay_(enteredAt),
          employee: plan.employee, operation: operation, sheetName: order.sheetName, sourceRow: order.row,
          article: order.article, uid: order.uid, rollName: roll.name, quantity: actual,
          areaPerPiece: actual > 0 ? area / actual : plan.event.areaPerPiece, area: area,
          enteredAt: enteredAt, comment: comment || 'Рулон завершён через панель «Рулоны».', rollId: roll.rollId};
        if (existing.length) snapshot.journal[snapshot.journal.indexOf(existing[0])] = release;
        else snapshot.journal.push(release);
        releases.push(release);
        if (isPrint) { roll.print = true; roll.printDoneAt = enteredAt; roll.printEmployee = plan.employee; }
        else { roll.cut = true; roll.cutDoneAt = enteredAt; roll.cutEmployee = plan.employee; }
        completed++;
      } else partial++;
      roll.updated = plan.event.enteredAt; roll.orderRow = order.row;
      rolls.push(roll);
    });
    if (rolls.length) r2PanelWriteRecordBlocks_(store, rolls, R2_CFG.STORE_HEADERS.length, r2PanelRollValues_);
    if (releases.length) r2PanelWriteRecordBlocks_(journalSheet, releases, R2_CFG.JOURNAL_HEADERS.length, r2PanelJournalValues_);
    Object.keys(orders).forEach(function(key) {
      var order = orders[key];
      if (!isPrint && plans.some(function(p) { return p.order === order; })) r2PersistCutterCode_(order, R2_CFG.CUTTER_DEFAULT);
      if (plans.some(function(p) { return p.order === order; })) r2UpdateOrderProgress_(order, false, snapshot);
    });
    if (plans.length) {
      r2RefreshDaily_(snapshot.journal); r2PanelTouch_(); SpreadsheetApp.flush();
    }
    var updated = Object.keys(orders).map(function(key) { return r2DecorateOrder_(orders[key], snapshot); });
    return r2PanelSerializable_({requestId: payload.requestId, orders: updated,
      revision: PropertiesService.getDocumentProperties().getProperty('R2_PANEL_REVISION') || '',
      completed: completed, partial: partial, skipped: skipped,
      message: 'Сохранено. Завершено рулонов: ' + completed + (partial ? '; частичная работа: ' + partial : '') +
        (skipped ? '; уже готовы: ' + skipped : '') + '.' + (partial ? ' Частичная работа сохранена в истории; выпуск попадёт в журнал при завершении рулона.' : '')});
  });
}
