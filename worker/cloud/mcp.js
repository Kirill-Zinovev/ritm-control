import { CloudError, json, readJson, requireOwner } from './access.js';
import { CloudStore } from './store.js';
import { maintenance, runArkadyStockWatch } from './runtime.js';
import { drainBitrixNotifications } from './bitrixNotifications.js';
import { pendingStockDetails } from './stockDiagnostics.js';
export async function mcp(request, env) {
  let input;
  try {
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    input=await readJson(request);
    const result=value=>json({jsonrpc:'2.0',id:input.id??null,result:value});
    if(input.method==='server/discover')return result({supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
    if(input.method==='initialize')return result({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ritm-maintenance',version:'1.0.0'}});
    if(input.method==='notifications/initialized')return new Response(null,{status:202});
    if(input.method==='tools/list')return result({tools:[{name:'ritm_refresh',description:'Обновить сводки RITM из настроенных источников и проверить доставку подтверждённых поставок в существующий Assembly. Не создаёт поставки и не меняет нормы.',inputSchema:{type:'object',properties:{},additionalProperties:false}},{name:'ritm_stock_watch',description:'Проверить завершение печати и порезки запасов и отправить только подтверждённые уведомления Аркадия. Не изменяет таблицы.',inputSchema:{type:'object',properties:{},additionalProperties:false}},{name:'ritm_stock_pending_status',description:'Только чтение: показать сохранённый состав и этапы незавершённого запроса запасов по артикулу. Данные, таблицы и сообщения не изменяются.',inputSchema:{type:'object',properties:{article:{type:'string',description:'Артикул из незавершённого запроса.'}},required:['article'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}}]});
    requireOwner(request,env);
    if(input.method!=='tools/call'||!['ritm_refresh','ritm_stock_watch','ritm_stock_pending_status'].includes(input.params?.name))throw new CloudError('unknown_tool','Неизвестная служебная операция.',400);
    const args=input.params?.arguments||{};
    if(input.params.name==='ritm_stock_pending_status'){
      if(Object.keys(args).some(key=>key!=='article'))throw new CloudError('unknown_tool','Неверные параметры сверки.',400);
      const scope=await new CloudStore(env.DB).scope();
      const operations=pendingStockDetails(scope.operations.values(),args.article);
      return result({content:[{type:'text',text:JSON.stringify({ok:true,operations})}],isError:false});
    }
    if(Object.keys(args).length)throw new CloudError('unknown_tool','Неизвестная служебная операция.',400);
    const store=new CloudStore(env.DB);
    const value=input.params.name==='ritm_stock_watch'?await runArkadyStockWatch(env,store):await maintenance(env,store);
    if(input.params.name==='ritm_stock_watch' && value.queued)await drainBitrixNotifications(env,store);
    return result({content:[{type:'text',text:JSON.stringify(value)}],isError:!value.ok});
  }catch(error){return json({jsonrpc:'2.0',id:input?.id??null,error:{code:-32000,message:error instanceof CloudError?error.message:'Обновление не подтверждено.'}},error.status||503);}
}
