import { CloudError } from './access.js';
import {createStockGateway,stockGatewaySupportsDryRun} from './stockGateway.js';

// Owner-only support view over the existing operation journal. No gateway is
// called and no cloud or Google data is changed by this function.
export function pendingStockDetails(operations, article) {
  const key=String(article||'').trim().toUpperCase();
  if(!/^[A-Z0-9][A-Z0-9._() -]{0,119}$/.test(key))
    throw new CloudError('stock_diagnostic_invalid','Укажите артикул для сверки.',400);
  const matches=[...operations].filter(row=>row.kind==='stock' && !['verified','not_saved'].includes(row.value?.status)
    && row.value?.steps?.some(step=>step.plan?.entries?.some(entry=>String(entry.article||'').trim().toUpperCase()===key)));
  if(matches.length>10)throw new CloudError('stock_diagnostic_multiple','Найдено больше десяти незавершённых операций. Уточните сверку.',409);
  return matches.map(({value:op})=>({
    id:op.id,createdAt:op.createdAt,destination:op.destination,status:op.status,
    steps:(op.steps||[]).map(step=>({department:step.department,status:step.status,plan:{
      destination:step.plan?.destination,spreadsheetId:step.plan?.spreadsheetId,sheetId:step.plan?.sheetId,
      entries:(step.plan?.entries||[]).map(entry=>({...entry})),
    }})),
  }));
}

// A requested receipt probe uses only the deployed gateways whose immutable
// versions were inspected for dryRun. It never calls an unknown writer.
export async function inspectStockReceipts(operations,bindings,{fetcher=fetch}={}) {
  return Promise.all(operations.map(async operation=>({...operation,steps:await Promise.all(operation.steps.map(async step=>{
    const url=bindings[`RITM_STOCK_${step.department.toUpperCase()}_GATEWAY_URL`];
    const endpointKnown=stockGatewaySupportsDryRun(step.department,url);
    const connection={endpointKnown,deploymentId:String(url||'').match(/^https:\/\/script\.google\.com\/macros\/s\/([A-Za-z0-9_-]+)\/exec$/)?.[1]||null};
    if(step.status==='prepared'||step.status==='verified')return {...step,connection};
    if(!endpointKnown)return {...step,connection,receipt:{status:'unsupported'}};
    try{
      const gateway=createStockGateway({url,token:bindings[`RITM_STOCK_${step.department.toUpperCase()}_GATEWAY_TOKEN`],fetcher,beforeWrite:async()=>{},dryRunSupported:true});
      const receipt=await gateway.inspectStockPlan({operationId:operation.id,sheetId:step.plan.sheetId,entries:step.plan.entries});
      return {...step,connection,receipt:{status:receipt.status}};
    }catch(error){return {...step,connection,receipt:{status:'unavailable',code:error.code||'stock_receipt_unavailable',message:String(error.message||'Сверка недоступна.').slice(0,300)}};}
  }))})));
}
