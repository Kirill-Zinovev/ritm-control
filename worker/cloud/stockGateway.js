import {CloudError} from './access.js';

const dryRunEndpoints={
  box:'https://script.google.com/macros/s/AKfycbxBEbaad2mnuTuv1Ldd3oAM0blx05XYQPOa7EQ4JKv7CdyzYY4Wqxq580Xw6P26g-2a9w/exec',
  roll:'https://script.google.com/macros/s/AKfycbyR9BY0_SUzNiGPsK-E-Y7tF7bX3z1JSzp1lnaV1sOycmUtj8Cmf25Ak9ERO6msmCni/exec',
};
export const stockGatewaySupportsDryRun=(department,url)=>!!dryRunEndpoints[department]&&url===dryRunEndpoints[department];

// A gateway executes inside the same Apps Script lock as employees' actions.
// A lost response is deliberately treated as an uncertain write by the caller.
export function createStockGateway({url,token,fetcher=fetch,beforeWrite,dryRunSupported=false}) {
  if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,100}\/exec$/.test(String(url||''))||typeof token!=='string'||token.length<32||typeof beforeWrite!=='function')
    throw new CloudError('stock_gateway_unconfigured','Безопасное подключение таблицы запасов не настроено.',503);
  async function send(plan,expectedStatus='verified',allowUncertain=false){
    await beforeWrite();
    const response=await fetcher(url,{method:'POST',headers:{'content-type':'text/plain;charset=UTF-8'},body:JSON.stringify({...plan,token}),redirect:'manual',signal:AbortSignal.timeout(90000)});
    let result=response;
    if([301,302,303].includes(response.status)){
      const target=new URL(response.headers.get('location')||'',url);
      if(target.protocol!=='https:'||!(target.hostname==='googleusercontent.com'||target.hostname.endsWith('.googleusercontent.com'))||target.username||target.password)throw new Error('Не подтверждён ответ Google.');
      // Workers supports only manual/follow. Keep the second hop manual so a
      // further redirect is rejected below without forwarding credentials.
      result=await fetcher(target.href,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(25000)});
    }
    if(!result.ok)throw new Error('Google не подтвердил запись запасов.');
    const body=await result.json();
    if(allowUncertain && body?.ok===false && body.status==='uncertain')return {status:'uncertain'};
    const accepted=Array.isArray(expectedStatus)?expectedStatus:[expectedStatus];
    if(body?.ok!==true||!accepted.includes(body.status))throw new Error(body?.message||'Результат записи требует сверки.');
    return body;
  }
  return {
    applyStockPlan:plan=>send(plan),
    // Both deployed gateways check the immutable operation receipt first. If
    // it does not exist, dryRun performs only preflight and makes no writes.
    inspectStockPlan:({operationId,sheetId,entries})=>{
      if(!dryRunSupported)throw new Error('Безопасная сверка подключения не подтверждена.');
      return send({operationId,sheetId,entries,dryRun:true},['verified','validated'],true);
    },
    closeStockTask:plan=>send({...plan,action:'close'}),
    closeStockBatch:tasks=>send({tasks,action:'closeBatch'},'close_batch'),
    health:()=>send({action:'health'},'ready'),
  };
}
