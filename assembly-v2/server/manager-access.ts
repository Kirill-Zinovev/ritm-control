import type { SqlStore } from './database';
import { authenticate, hmac, sameOrigin, type AccessEnv, type Principal } from './access';
import { json } from './api';

const cookieName='__Host-av2-manager';
const sessionSeconds=30*24*60*60;
const iterations=100000;
const encoder=new TextEncoder();
type Settings={salt:string;passwordHash:string;version:string;updatedAt:string};
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
function equal(a:string,b:string){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
async function settings(store:SqlStore){return (await store.all<Settings>('select salt,password_hash,version,updated_at from av2_manager_access where id=1'))[0];}
async function passwordHash(password:string,salt:string){
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations,hash:'SHA-256'},key,256));
}
export async function authenticateManager(request:Request,env:AccessEnv,store:SqlStore,now=Date.now()):Promise<Principal|null>{
  if(!env.AV2_SESSION_SECRET)return null;
  const cookie=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
  const [v,expires,device,mac,...rest]=cookie.split('.');
  if(rest.length||v!=='1'||!/^\d{10}$/.test(expires||'')||Number(expires)<=Math.floor(now/1000)||Number(expires)>Math.floor(now/1000)+sessionSeconds+60||!/^[a-f0-9-]{36}$/i.test(device||'')||!/^[a-f0-9]{64}$/.test(mac||''))return null;
  const config=await settings(store);if(!config?.passwordHash)return null;
  const expected=await hmac(env.AV2_SESSION_SECRET,[v,expires,device,config.version,'manager'].join('.'));
  return equal(mac,expected)?{role:'manager',actor:'manager:'+device}:null;
}
export async function managerAccessApi(request:Request,env:AccessEnv,store:SqlStore):Promise<Response>{
  const path=new URL(request.url).pathname;
  if(request.method!=='GET'&&!sameOrigin(request))return json({error:'Недопустимый источник запроса.'},403);
  if(path==='/api/access/manager/logout'&&request.method==='POST'){
    const response=json({ok:true});response.headers.set('set-cookie',`${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);return response;
  }
  if(path==='/api/access/manager/settings'){
    if((await authenticate(request,env))?.role!=='owner')return json({error:'Настройки доступа доступны только владельцу.'},403);
    if(request.method==='GET'){const config=await settings(store);return json({enabled:!!config?.passwordHash,updatedAt:config?.updatedAt||null});}
    if(request.method!=='POST')return json({error:'Недопустимый метод.'},405);
    const raw=await request.text();if(raw.length>1200)return json({error:'Слишком большой запрос.'},413);
    let data:{password?:unknown;disabled?:unknown};try{data=JSON.parse(raw)}catch{return json({error:'Неверный формат запроса.'},400)}
    if(data.disabled!==true&&(typeof data.password!=='string'||!/^\d{4}$/.test(data.password)))return json({error:'PIN должен состоять ровно из 4 цифр.'},400);
    const salt=crypto.randomUUID(),hash=data.disabled===true?'':await passwordHash(data.password as string,salt),version=crypto.randomUUID(),now=new Date().toISOString();
    const owner=await authenticate(request,env);
    await store.batch([{sql:'insert into av2_manager_access(id,salt,password_hash,version,updated_at,updated_by) values(1,?,?,?,?,?) on conflict(id) do update set salt=excluded.salt,password_hash=excluded.password_hash,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by',args:[salt,hash,version,now,owner!.actor]}]);
    return json({enabled:!!hash,updatedAt:now});
  }
  if(path!=='/api/access/manager/login'||request.method!=='POST')return json({error:'Страница не найдена.'},404);
  if(!env.AV2_SESSION_SECRET)return json({error:'Вход менеджера пока не настроен.'},503);
  const raw=await request.text();if(raw.length>1200)return json({error:'Слишком большой запрос.'},413);
  let password:unknown;try{password=JSON.parse(raw).password}catch{/* Invalid input grants no session. */}
  if(typeof password!=='string'||password.length>128)return json({error:'Проверьте PIN.'},403);
  const config=await settings(store);if(!config?.passwordHash)return json({error:'Владелец ещё не включил вход менеджеров.'},403);
  const window=Math.floor(Date.now()/900000),ip=request.headers.get('cf-connecting-ip')||'shared';
  const key=await hmac(env.AV2_SESSION_SECRET,'manager-login:'+ip);
  // Reserve attempts atomically before expensive password verification. Retain only the current time window.
  const attempts=await store.readBatch([
    {sql:'delete from av2_manager_attempts where window<?',args:[window-1]},
    {sql:'insert into av2_manager_attempts(id,window,attempts) values(?,?,1) on conflict(id) do update set attempts=case when window=excluded.window then attempts+1 else 1 end,window=excluded.window',args:[key,window]},
    {sql:'select attempts from av2_manager_attempts where id=?',args:[key]},
  ]);
  if(Number(attempts[2][0].attempts)>10){const r=json({error:'Слишком много попыток. Повторите через 15 минут.'},429);r.headers.set('retry-after','900');return r;}
  if(!equal(await passwordHash(password,config.salt),config.passwordHash))return json({error:'Неверный PIN.'},403);
  await store.batch([{sql:'update av2_manager_attempts set attempts=max(0,attempts-1) where id=? and window=?',args:[key,window]}]);
  const device=crypto.randomUUID(),expires=String(Math.floor(Date.now()/1000)+sessionSeconds),prefix=`1.${expires}.${device}`;
  const mac=await hmac(env.AV2_SESSION_SECRET,[prefix,config.version,'manager'].join('.'));
  const response=json({role:'manager'});response.headers.set('set-cookie',`${cookieName}=${prefix}.${mac}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionSeconds}`);return response;
}
