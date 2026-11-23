import { validSupplyId } from '../src/workspace-write.mjs';
import { activeSession, printingAccess } from './access.mjs';
import { refreshCatalog } from './catalog.mjs';
import { printingFeed, printingWrite, searchPrintingPositions } from './database.mjs';
import { importPrinting } from './import-data.mjs';
import { printingWorkReport } from './work-report.mjs';
import { json, readJson, sameOriginJson } from './http.mjs';
import { databaseBackup, databaseBackupPath } from './database-backup.mjs';

async function printingOwnerAccount(request, expectedHash) {
  const email = request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  if (!request.headers.get('oai-authenticated-user-id') || !email || !/^[a-f0-9]{64}$/.test(expectedHash || '')) {
    return false;
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return hash === expectedHash;
}

async function serveAsset(env, request, url) {
  if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405});
  if (['/','/box','/roll','/box/','/roll/'].includes(url.pathname)) {
    return env.ASSETS.fetch(new Request(new URL('/',url),request));
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url);
    if (url.pathname === databaseBackupPath) {
      const owner = await printingOwnerAccount(request, env.PRINTING_DB_BACKUP_OWNER_EMAIL_SHA256);
      return databaseBackup(request, env.DB, 'printing', owner);
    }
    if (!url.pathname.startsWith('/api/')) return serveAsset(env,request,url);
    if (!env.DB) return json({message:'База печати подключается.'},503);
    const db=env.DB.withSession?.('first-primary')??env.DB;
    try {
      if (url.pathname==='/api/printing-access') return await printingAccess(db,request,env);
      if (url.pathname==='/api/printing-import') return await importPrinting(db,request,env);
      if (url.pathname==='/api/reporting/printing-work') return await printingWorkReport(db,request,env.PRINTING_KPI_READ_KEY);
      if (!['/api/printing-workspace','/api/printing-write'].includes(url.pathname)) return json({message:'Маршрут недоступен.'},404);
      const session=await activeSession(db,request);
      if (!session) return json({message:'Войдите в свой участок по PIN.'},401);
      if (url.pathname==='/api/printing-workspace') {
        if (request.method!=='GET') return json({message:'Метод недоступен.'},405);
        if (session.department!==url.searchParams.get('department')) return json({message:'Войдите в свой участок по PIN.'},401);
        const id=url.searchParams.get('supply');
        if (id!=null && !validSupplyId(id)) return json({message:'Некорректная поставка.'},400);
        const search=url.searchParams.get('search');
        if (search!=null) {
          const result=await searchPrintingPositions(db,session.department,id,search);
          return json(result.value,result.status);
        }
        const preview=url.searchParams.get('preview')==='1';
        const result=await printingFeed(db,session.department,{id,preview,journal:!id&&url.searchParams.get('journal')==='1'});
        if (id && !preview && result.status===200) {
          result.value.catalog=await refreshCatalog(db,env.PRINTING_CATALOG_READ_TOKEN,url.searchParams.get('fresh')==='1',ctx)
            .catch(()=>({refreshing:false}));
        }
        return json(result.value,result.status);
      }
      if (request.method!=='POST') return json({message:'Метод недоступен.'},405);
      if (!sameOriginJson(request)) return json({rejected:true,message:'Откройте форму печати РИТМ.'},403);
      const input=await readJson(request,260_000);
      if (!input) return json({rejected:true,message:'Проверьте параметры записи.'},400);
      if (session.department!==input.department) return json({rejected:true,message:'Войдите в свой участок по PIN.'},401);
      const result=await printingWrite(db,input);
      return json(result.value,result.status);
    } catch (error) {
      console.error('Printing request failed',url.pathname,error.name);
      if (url.pathname==='/api/printing-write') return json({uncertain:true,message:'Журнал не подтвердил запись. Повторите тот же запрос.'},503);
      return json({message:'Не удалось прочитать базу печати. Повторите попытку.'},503);
    }
  },
};
