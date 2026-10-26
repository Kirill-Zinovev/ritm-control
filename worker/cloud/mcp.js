import { CloudError, json, readJson, requireOwner } from './access.js';
import { CloudStore } from './store.js';
import { maintenance } from './runtime.js';
export async function mcp(request, env) {
  let input;
  try {
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    input=await readJson(request);
    const result=value=>json({jsonrpc:'2.0',id:input.id??null,result:value});
    if(input.method==='server/discover')return result({supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
    if(input.method==='initialize')return result({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ritm-maintenance',version:'1.0.0'}});
    if(input.method==='notifications/initialized')return new Response(null,{status:202});
    if(input.method==='tools/list')return result({tools:[{name:'ritm_refresh',description:'Обновить сводки RITM из настроенных источников и проверить доставку подтверждённых поставок в существующий Assembly. Не создаёт поставки и не меняет нормы.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});
    requireOwner(request,env);
    if(input.method!=='tools/call'||input.params?.name!=='ritm_refresh'||Object.keys(input.params?.arguments||{}).length)throw new CloudError('unknown_tool','Неизвестная служебная операция.',400);
    const value=await maintenance(env,new CloudStore(env.DB));
    return result({content:[{type:'text',text:JSON.stringify(value)}],isError:!value.ok});
  }catch(error){return json({jsonrpc:'2.0',id:input?.id??null,error:{code:-32000,message:error instanceof CloudError?error.message:'Обновление не подтверждено.'}},error.status||503);}
}
