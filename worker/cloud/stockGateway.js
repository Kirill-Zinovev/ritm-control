import {createHash} from 'node:crypto';
import {CloudError} from './access.js';

// Compare configured deployment URLs without exposing them in the public repository.
const dryRunEndpointHashes={
  box:'70f0f6636209043196b63b2f70f9056434952ea805fc711e7868994e06f65a35',
  roll:'c3d240d0cd2cadb6d14e347f90dfe64e3732e320e1aea09b0c0cda972fc28fbd',
};
export const stockGatewaySupportsDryRun=(department,url)=>typeof url==='string'&&!!dryRunEndpointHashes[department]&&createHash('sha256').update(url).digest('hex')===dryRunEndpointHashes[department];

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
    health:()=>send({action:'health'},'ready'),
  };
}
