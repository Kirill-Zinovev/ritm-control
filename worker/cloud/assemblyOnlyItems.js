import { CloudError } from './access.js';
const KIND='assembly-only-item';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const SHIPMENT=/^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i;
const clean=(v,n)=>typeof v==='string'?v.trim().slice(0,n):'';
const fail=(code,message,status=400)=>{throw new CloudError(code,message,status)};
export function listAssemblyOnlyItems(scope,shipmentId){
  if(!SHIPMENT.test(shipmentId||''))fail('assembly_item_shipment_invalid','Не удалось проверить поставку.');
  return [...scope.operations.values()].filter(r=>r.kind===KIND&&r.value?.shipmentId===shipmentId).map(r=>structuredClone(r.value)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
}
export function createAssemblyOnlyItem(scope,input,{owner='',orders=[],now=Date.now}={}){
  if(!scope?.lease)fail('assembly_item_lease_required','Операция сохранения занята. Повторите.',409);
  const id=clean(input?.requestId,36),shipmentId=clean(input?.shipmentId,120),article=clean(input?.article,80).toLocaleUpperCase('ru-RU'),comment=clean(input?.comment,500),quantity=Number(input?.quantity);
  if(!UUID.test(id)||!SHIPMENT.test(shipmentId))fail('assembly_item_invalid','Не удалось проверить запрос или поставку.');
  if(!/^[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9._-]{0,79}$/iu.test(article))fail('assembly_item_article_invalid','Укажите артикул.');
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000)fail('assembly_item_quantity_invalid','Укажите целое количество больше нуля.');
  const existing=scope.operations.get(`${KIND}:${id}`)?.value;
  if(existing){if(existing.shipmentId!==shipmentId||existing.article!==article||existing.quantity!==quantity||existing.comment!==comment)fail('assembly_item_request_conflict','Запрос уже использован для другого товара.',409);return {item:structuredClone(existing),duplicate:true};}
  const additions=listAssemblyOnlyItems(scope,shipmentId);
  if(additions.length>=500)fail('assembly_item_limit','Достигнут предел дополнительных товаров в поставке.',409);
  if(additions.some(x=>x.article===article)||orders.some(o=>String(o.article||'').trim().toLocaleUpperCase('ru-RU')===article))fail('assembly_item_duplicate','Этот артикул уже есть в поставке.',409);
  const item={id,shipmentId,article,quantity,comment,createdAt:new Date(now()).toISOString(),createdBy:clean(owner,120)||'RITM',positionId:`${shipmentId}|manual:${id}|${article}`};
  scope.putOperation(KIND,item);return {item:structuredClone(item),duplicate:false};
}
