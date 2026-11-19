import {CloudError} from './access.js';
import {cloudFetch} from './fetch.js';
export function createDepartmentMoveGateway({url,token,fetcher=fetch,beforeWrite}){
 if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,100}\/exec$/.test(String(url||''))||typeof token!=='string'||token.length<32||typeof beforeWrite!=='function')throw new CloudError('move_gateway_unconfigured','Безопасный перенос ещё не подключён.',503);
 return async function send(action,position){
  if(!['health','lock','remove','status','abort'].includes(action))throw new Error('Неизвестное действие переноса.');
  await beforeWrite(action);
  let response=await cloudFetch(fetcher,url,{method:'POST',headers:{'content-type':'text/plain;charset=UTF-8'},body:JSON.stringify({...position,action,token}),redirect:'manual',signal:AbortSignal.timeout(90000)});
  if([302,303].includes(response.status)){const target=new URL(response.headers.get('location')||'',url);if(target.protocol!=='https:'||target.hostname!=='script.googleusercontent.com'||target.username||target.password)throw new Error('Не подтверждён ответ скрипта.');response=await cloudFetch(fetcher,target.href,{method:'GET',redirect:'error',signal:AbortSignal.timeout(25000)});}
  if(!response.ok)throw new Error('Скрипт не подтвердил перенос.');
  const result=await response.json();if(result.ok!==true||!(action==='health'?result.status==='ready':result.locked===true||['locked','removed','aborted','absent'].includes(result.status)))throw new Error(result.message||'Результат переноса требует сверки.');return result;
 };
}
