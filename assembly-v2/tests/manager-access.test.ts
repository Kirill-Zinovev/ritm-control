import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/local-db';
import { accessApi, authenticate } from '../server/access';
import worker, { type Env } from '../server/worker';
import { digest } from '../shared/catalog';

const origin='https://assembly.test';
const password='0427';
const base={AV2_OWNER_API_TOKEN:'local-only-owner',AV2_SESSION_SECRET:'12'.repeat(32),AV2_COLLECTOR_ACCESS_HASH:await digest('34'.repeat(32))};
const post=(path:string,body:object,headers:Record<string,string>={})=>new Request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
const settings='/api/access/manager/settings',login='/api/access/manager/login';

test('existing manager credential keeps working until the owner sets a PIN',async t=>{
  const db=await openDatabase();t.after(()=>db.sqlite.close());
  const oldPassword='Previous-local-test-password',salt=crypto.randomUUID();
  const encoder=new TextEncoder(),key=await crypto.subtle.importKey('raw',encoder.encode(oldPassword),'PBKDF2',false,['deriveBits']);
  const hash=Buffer.from(await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'},key,256)).toString('hex');
  db.sqlite.prepare('insert into av2_manager_access(id,salt,password_hash,version,updated_at,updated_by) values(1,?,?,?,?,?)').run(salt,hash,crypto.randomUUID(),new Date().toISOString(),'local-test');
  const response=await accessApi(post(login,{password:oldPassword}),base,db.store);
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie')!.split(';')[0];
  await accessApi(post(settings,{password},{'x-assembly-admin-token':base.AV2_OWNER_API_TOKEN}),base,db.store);
  assert.equal(await authenticate(new Request(origin,{headers:{cookie}}),base,Date.now(),db.store),null);
  assert.equal((await accessApi(post(login,{password:oldPassword}),base,db.store)).status,403);
  assert.equal((await accessApi(post(login,{password}),base,db.store)).status,200);
});

test('manager password is hashed; owner controls setup, cookies expire and password changes revoke sessions',async t=>{
  const db=await openDatabase();t.after(()=>db.sqlite.close());
  const call=(r:Request)=>accessApi(r,base,db.store);
  for(const invalid of ['123','12345','12a4',' 1234','１２３４',1234])assert.equal((await call(post(settings,{password:invalid},{'x-assembly-admin-token':base.AV2_OWNER_API_TOKEN}))).status,400);
  assert.equal((await call(post(settings,{password}))).status,403);
  assert.equal((await call(post(settings,{password},{'x-assembly-admin-token':base.AV2_OWNER_API_TOKEN,origin:'https://foreign.test'}))).status,403);
  assert.equal((await call(post(settings,{password},{'x-assembly-admin-token':base.AV2_OWNER_API_TOKEN}))).status,200);
  const config=db.sqlite.prepare('select * from av2_manager_access').get()!;assert.notEqual(config.password_hash,password);assert(!JSON.stringify(config).includes(password));
  assert.equal((await call(post(login,{password:'wrong'}))).status,403);
  assert.equal((await call(post(login,{password:'427'}))).status,403,'leading zero must be preserved');
  assert.equal((await call(post(login,{password},{origin:'https://foreign.test'}))).status,403);
  const response=await call(post(login,{password}));assert.equal(response.status,200);
  const setCookie=response.headers.get('set-cookie')!;assert.match(setCookie,/HttpOnly; Secure; SameSite=Lax/);
  const cookie=setCookie.split(';')[0],request=new Request(origin+'/api/access',{headers:{cookie}});
  assert.equal((await authenticate(request,base,Date.now(),db.store))?.role,'manager');
  assert.equal(await authenticate(new Request(origin,{headers:{cookie:cookie.slice(0,-1)+'x'}}),base,Date.now(),db.store),null);
  assert.equal(await authenticate(request,base,Date.now()+31*86400000,db.store),null);
  assert.equal((await call(post(settings,{password:'5816'},{'x-assembly-admin-token':base.AV2_OWNER_API_TOKEN}))).status,200);
  assert.equal(await authenticate(request,base,Date.now(),db.store),null);
  assert.equal((await call(post(login,{password}))).status,403);
  const changed=await call(post(login,{password:'5816'}));assert.equal(changed.status,200);
  await call(post(settings,{disabled:true},{'x-assembly-admin-token':base.AV2_OWNER_API_TOKEN}));
  assert.equal(await authenticate(new Request(origin,{headers:{cookie:changed.headers.get('set-cookie')!.split(';')[0]}}),base,Date.now(),db.store),null);
  assert.equal((await call(post(login,{password:'5816'}))).status,403);
});

test('manager login rate limit is persisted and scoped to the caller, not reset by retries',async t=>{
  const db=await openDatabase();t.after(()=>db.sqlite.close());
  await accessApi(post(settings,{password},{'x-assembly-admin-token':base.AV2_OWNER_API_TOKEN}),base,db.store);
  for(let i=0;i<10;i++)assert.equal((await accessApi(post(login,{password:'wrong'},{'cf-connecting-ip':'192.0.2.1'}),base,db.store)).status,403);
  assert.equal((await accessApi(post(login,{password},{'cf-connecting-ip':'192.0.2.1'}),base,db.store)).status,429);
  assert.equal((await accessApi(post(login,{password},{'cf-connecting-ip':'192.0.2.2'}),base,db.store)).status,200);
});

test('worker enforces manager permissions on direct URLs and commands; owner settings, backups and service imports stay private',async t=>{
  const db=await openDatabase();t.after(()=>db.sqlite.close());
  const prepare=(sql:string)=>{
    let values:(string|number|null)[]=[];
    return {bind(...v:(string|number|null)[]){values=v;return this},async all(){return {results:db.sqlite.prepare(sql).all(...values) as Record<string,unknown>[]}}};
  };
  const binding={prepare,async batch(statements:ReturnType<typeof prepare>[]){db.sqlite.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.all());db.sqlite.exec('COMMIT');return result}catch(e){db.sqlite.exec('ROLLBACK');throw e}}};
  const env:Env={...base,DB:binding};
  await worker.fetch(post(settings,{password},{'x-assembly-admin-token':base.AV2_OWNER_API_TOKEN}),env);
  const session=await worker.fetch(post(login,{password}),env);assert.equal(session.status,200);
  const cookie=session.headers.get('set-cookie')!.split(';')[0];
  for(const path of ['/api/catalog','/api/catalog/options','/api/state?cartons=all','/api/work-history','/api/warehouse'])assert.equal((await worker.fetch(new Request(origin+path,{headers:{cookie}}),env)).status,200,path);
  for(const path of [settings,'/api/access/link','/api/legacy/backup','/api/ritm/warehouse'])assert.equal((await worker.fetch(new Request(origin+path,{headers:{cookie}}),env)).status,403,path);
  for(const action of ['employee.create','legacy.restore','legacy.adoptCarton','legacy.references.import','ritm.import','ritm.retire','ritm.carton.dispatch','supply.import'])assert.equal((await worker.fetch(post('/api/command',{action,payload:{},key:crypto.randomUUID()},{cookie}),env)).status,403,action);
  // Allowed actions reach domain validation; no fake production records are created.
  for(const action of ['catalog.save','dispatch.create','dispatch.cancel','dispatch.send','export.create','allocation.remove','work.cancel'])assert.equal((await worker.fetch(post('/api/command',{action,payload:{},key:crypto.randomUUID()},{cookie}),env)).status,409,action);
  assert.equal((await worker.fetch(post('/api/command',{action:'catalog.save',payload:{},key:crypto.randomUUID()},{cookie,origin:'https://foreign.test'}),env)).status,403);
  const logout=await worker.fetch(post('/api/access/manager/logout',{}, {cookie}),env);assert.match(logout.headers.get('set-cookie')!,/Max-Age=0/);
});
