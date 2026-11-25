/** Manual receipts of finished goods. No production task, packing fact or KPI is created. */
function manualWarehouseDb_() {
  return SpreadsheetApp.openById(typeof DB_ID === 'string' ? DB_ID : requiredSpreadsheetId_(ASSEMBLY_DB_PROPERTY));
}

function manualWarehouseIdentity_(payload) {
  const article = normalizeBoxSku_(payload && payload.article), marketplace = String(payload && payload.marketplace || '').toUpperCase();
  if (!/^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9._-]{0,79}$/i.test(article)) throw new Error('Введите артикул: буквы, цифры, точка, дефис или подчёркивание.');
  if (!['OZON','WB'].includes(marketplace)) throw new Error('Выберите маркетплейс.');
  return {article,marketplace};
}

function manualWarehouseProduct_(article, marketplace, fresh) {
  const key = 'ritm.assembly.manualStock.product.v1.' + marketplace + '.' + stockDigest_(article);
  const cache = CacheService.getScriptCache();
  if (!fresh) { try { const cached=parseSyncJson_(cache.get(key),null); if (cached) return cached; } catch (_) {} }
  const result = {article,marketplace,found:false,status:'not_found',productName:'',productType:'',photoUrl:'',boxType:'',unitsPerBox:null,stores:[]};
  try {
    const product = readRitmCatalog_().get(marketplace + '|' + article);
    if (product) {
      result.found=true;result.status='found';result.productName=String(product.name||'');result.productType=String(product.type||'');result.photoUrl=safeRitmPhotoUrl_(product.photoUrl);
      const stores=storeNumbersForItems_([{sku:article,source:marketplace}],fresh===true)[storeNumberSkuKey_(article,marketplace)];
      if (Array.isArray(stores)) result.stores=Array.from(new Set(stores.map(value=>String(value).trim()).filter(value=>/^\d+$/.test(value)).map(value=>String(Number(value)))));
      const norm=getBoxPackNorm_(article,fresh===true,marketplace);
      if (norm) { result.boxType=String(norm.boxType||'');result.unitsPerBox=norm.confirmed?norm.unitsPerBox:null; }
    }
    try { cache.put(key,JSON.stringify(result),result.found?60:15); } catch (_) {}
  } catch (_) { result.status='unavailable'; }
  return result;
}

function getManualWarehouseProduct(payload) {
  const identity=manualWarehouseIdentity_(payload);
  return Object.assign({ok:true},manualWarehouseProduct_(identity.article,identity.marketplace,payload.fresh===true));
}

function manualWarehouseRequest_(payload) {
  const identity=manualWarehouseIdentity_(payload),quantity=Number(payload.quantity);
  if (!Number.isSafeInteger(quantity)||quantity<1) throw new Error('Количество должно быть целым числом больше нуля.');
  const store=confirmedStoreNumber_([payload.storeNumber]);
  if (Number(store)<1) throw new Error('Укажите номер магазина больше нуля.');
  const comment=String(payload.comment||'').trim();
  if (comment.length>500) throw new Error('Сократите комментарий до 500 символов.');
  if (!String(payload.employeeId||'').trim()) throw new Error('Выберите своё имя.');
  return {kind:'manual_warehouse',article:identity.article,marketplace:identity.marketplace,storeNumber:store,quantity,
    employeeId:String(payload.employeeId),comment};
}

function manualWarehouseReceipt_(db,key) {
  const sheet=db.getSheetByName('StockPlacementOperations');
  return sheet?findBoxRecordByHeaderValue_(sheet,'operationId','manual-'+key):null;
}

function manualWarehouseResult_(receipt,duplicate) {
  const saved=parseSyncJson_(receipt.request,null);
  return {ok:true,duplicate:!!duplicate,cancelled:!!saved.cancelledAt,article:saved.input.article,quantity:saved.cancelledAt?0:saved.input.quantity,employee:saved.employee,
    createdAt:saved.createdAt,cartonId:saved.cartonId,number:saved.number,dataVersion:getDataVersion(),
    message:saved.cancelledAt?'Повторное поступление отменено с сохранением истории. Новое количество не добавлено.':''};
}

/** Status checks are read-only. Only a confirmed receipt is a successful result. */
function getManualWarehouseEntryStatus(key) {
  key=validateBoxIdempotencyKey_(key);
  const receipt=manualWarehouseReceipt_(manualWarehouseDb_(),key);
  return receipt&&receipt.completedAt?manualWarehouseResult_(receipt,true):{ok:false,status:'pending'};
}

function saveManualWarehouseEntry(payload) {
  let started=!!(payload&&payload.resume);
  try {
    const key=validateBoxIdempotencyKey_(payload&&payload.idempotencyKey),input=manualWarehouseRequest_(payload),db=manualWarehouseDb_();
    // Product data is optional and resolved outside the shared mutation lock.
    const reference=manualWarehouseProduct_(input.article,input.marketplace,false);
    const lock=LockService.getScriptLock();
    if (!lock.tryLock(5000)) return {ok:false,status:'pending',message:'Склад обновляется другим сотрудником. Продолжите этот запрос.'};
    try {
      let receipt=manualWarehouseReceipt_(db,key),saved=receipt?parseSyncJson_(receipt.request,null):null;
      if (receipt) {
        started=true;
        if (!saved||JSON.stringify(saved.input)!==JSON.stringify(input)) throw new Error('Этот запрос уже связан с другим поступлением. Данные не перезаписаны.');
        if (receipt.completedAt) return manualWarehouseResult_(receipt,true);
      }
      if (!receipt) {
        const existingSheet=db.getSheetByName('StockPlacementOperations');
        const pending=existingSheet&&readTable_(db,'StockPlacementOperations').find(row=>String(row.operationId||'').startsWith('manual-')&&!row.completedAt&&
          JSON.stringify(parseSyncJson_(row.request,null)?.input)===JSON.stringify(input));
        if(pending)return {ok:false,status:'pending_existing',resumeKey:String(pending.operationId).slice(7),message:'Это поступление уже записывается. Продолжите существующий запрос — повторное количество не добавится.'};
        const employee=readTable_(db,TABLES.employees).find(row=>String(row.employeeId)===input.employeeId&&(row.Активен===true||String(row.Активен).toLowerCase()==='true'));
        if (!employee||!String(employee['Имя']||'').trim()) throw new Error('Выбранный сотрудник не найден среди активных.');
        if (reference.stores.length&&!reference.stores.includes(input.storeNumber)) throw new Error('В базе для артикула указан другой магазин: '+reference.stores.join(', ')+'. Обновите карточку.');
        getBoxTableSheets_(db);ensureStockAuditColumns_(db);
        const journal=stockOperationSheet_(db);
        saved={input,employee:String(employee['Имя']),createdAt:new Date().toISOString(),cartonId:'',number:''};
        started=true;
        appendRecordByHeaders_(journal.sheet,journal.headers,{operationId:'manual-'+key,request:JSON.stringify(saved),shipmentQuantity:0,stockQuantity:input.quantity,completedAt:''});
        receipt=manualWarehouseReceipt_(db,key);
      }
      const tables=getBoxTableSheets_(db),props=PropertiesService.getScriptProperties();
      tables.contents.headers=boxPlacementTableHeaders_(tables.contents.sheet,['allocationId','cartonId','shipmentId','directionId','positionId','Артикул','Количество, шт','createdAt','eventId','action','employeeId','Сотрудник']);
      tables.cartons.headers=boxPlacementTableHeaders_(tables.cartons.sheet,['cartonId','Занято, шт']);
      const allocationId='stock-manual-'+stockDigest_(key);
      let allocation=findBoxRecordByHeaderValue_(tables.contents.sheet,'allocationId',allocationId);
      const shipmentId='RITM-WAREHOUSE-MANUAL-'+input.marketplace+'-'+input.storeNumber;
      const positionId=shipmentId+'|'+input.article;
      let carton=allocation?findBoxRecordByHeaderValue_(tables.cartons.sheet,'cartonId',String(allocation.cartonId)):null;
      if (allocation&&(String(allocation.shipmentId)!==shipmentId||String(allocation.positionId)!==positionId||
          normalizeBoxSku_(allocation['Артикул'])!==input.article||Number(allocation['Количество, шт'])!==input.quantity||String(allocation.employeeId)!==input.employeeId))
        throw new Error('Сохранённое поступление не соответствует запросу. Новая запись не добавлялась.');
      if (!allocation) {
        // Unlike readTable_, this reader retains the physical row required for derived-field updates.
        const cartons=readBoxRecords_(tables.cartons.sheet,['cartonId','Номер','Занято, шт']).records.filter(row=>isWarehouseCartonId_(row.cartonId));
        carton=chooseWarehouseCarton_(cartons,input.storeNumber,input.marketplace,saved.cartonId||props.getProperty(warehouseCartonKey_(input.storeNumber,input.marketplace)));
        if (!carton) {
          // A carton may have been closed after creation but before the allocation was saved.
          // Reuse stable candidate IDs; only the future receipt goes to the next container.
          const byId=new Map(cartons.map(row=>[String(row.cartonId),row]));let createKey='manual-entry-'+key;
          for(let attempt=0;attempt<=cartons.length;attempt++){
            createKey='manual-entry-'+key+(attempt?'-'+attempt:'');
            const existing=byId.get('carton-stock-'+stockDigest_(createKey));
            if(!existing||warehouseCartonCompatible_(existing,input.storeNumber,input.marketplace))break;
          }
          carton=createWarehouseCartonRecord_(db,{shipmentId,directionId:'WAREHOUSE','Направление':input.marketplace+' · Поступление на склад · Магазин '+input.storeNumber},input.storeNumber,input.marketplace,createKey,props);
        }
      }
      if (!carton||!isWarehouseCartonId_(carton.cartonId)||cartonStoreNumberFromNumber_(carton['Номер'])!==input.storeNumber||shipmentMarketplace_(carton)!==input.marketplace)
        throw new Error('Не удалось подтвердить складской короб этого магазина.');
      if(!Number.isSafeInteger(carton._rowNumber)||carton._rowNumber<2||!Number.isSafeInteger(receipt._rowNumber)||receipt._rowNumber<2)
        throw new Error('Не удалось определить строку складской операции. Количество повторно не добавлено.');
      saved.cartonId=String(carton.cartonId);saved.number=String(carton['Номер']);
      const journal=stockOperationSheet_(db);
      journal.sheet.getRange(receipt._rowNumber,journal.headers.indexOf('request')+1).setValue(JSON.stringify(saved));
      if (!allocation) appendRecordByHeaders_(tables.contents.sheet,tables.contents.headers,{allocationId,cartonId:saved.cartonId,shipmentId,directionId:'WAREHOUSE',positionId,
        'Артикул':input.article,'Количество, шт':input.quantity,createdAt:saved.createdAt,eventId:'MANUAL_STOCK_'+stockDigest_(key),action:'ADD',
        employeeId:input.employeeId,'Сотрудник':saved.employee,reason:input.comment});
      const rows=normalizeCartonContents_(readRowsByKey_(tables.contents.sheet,'cartonId',new Set([saved.cartonId])));
      updateCartonField_(tables.cartons.sheet,tables.cartons.headers,carton._rowNumber,'Занято, шт',sumBoxQuantities_(rows));
      ensureWarehouseBoxViewSheet_(db);bumpDataVersion_();
      journal.sheet.getRange(receipt._rowNumber,journal.headers.indexOf('completedAt')+1).setValue(new Date().toISOString());
      SpreadsheetApp.flush();
      return manualWarehouseResult_(manualWarehouseReceipt_(db,key),!!allocation);
    } finally {lock.releaseLock();}
  } catch(error) {
    return {ok:false,status:started?'pending':'not_written',message:String(error&&error.message||error)};
  }
}
