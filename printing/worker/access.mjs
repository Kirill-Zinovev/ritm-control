import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isPrintingDepartment, printingPinDigits } from '../src/printing-departments.mjs';
import { json, readJson, sameOriginJson } from './http.mjs';

const stretch=promisify(scrypt);
const cookieName='__Host-ritm-print-d1';
const life=8*60*60*1000;
const minute=60_000;
const pinPattern=new RegExp(`^${printingPinDigits}$`);
const sha = value => createHash('sha256').update(value).digest('hex');
const signOut={department:null,expiresAt:null};
const cookie = (value='',age=0) => `${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
const validRecord = record => /^[a-f0-9]{32}$/.test(record?.salt??'') && /^[a-f0-9]{64}$/.test(record?.hash??'');

function pinRecords(env) {
  try {
    const value=JSON.parse(env.PRINTING_PINS);
    if (value.version===1 && ['box','roll'].every(key=>validRecord(value.pins?.[key]))) return value.pins;
  } catch { /* Invalid configuration denies access. */ }
  return null;
}

export function cutterPinRecord(env) {
  try {
    const record=JSON.parse(env.PRINTING_CUTTER_PIN);
    if (validRecord(record)) return {salt:record.salt,hash:record.hash,
      employee:typeof record.employee==='string' ? record.employee.trim().slice(0,100) || 'Лукман' : 'Лукман'};
  } catch { /* Cutter access requires a configured PIN. */ }
  return null;
}

function sessionToken(request) {
  const entry=request.headers.get('Cookie')?.split(';').map(value=>value.trim())
    .find(value=>value.startsWith(cookieName+'='));
  const token=entry?.slice(cookieName.length+1)??'';
  return /^[a-f0-9]{64}$/.test(token) ? sha(token) : null;
}

export async function activeSession(db, request) {
  const hash=sessionToken(request);
  return hash ? db.prepare('SELECT department,expires_at AS expiresAt FROM printing_sessions WHERE token_hash=? AND expires_at>?')
    .bind(hash,Date.now()).first() : null;
}

async function revoke(db, request) {
  const hash=sessionToken(request);
  if (hash) await db.prepare('DELETE FROM printing_sessions WHERE token_hash=?').bind(hash).run();
}

export async function printingAccess(db, request, env) {
  const records=pinRecords(env);
  if (!records) return json({message:'Вход ещё не подключён.'},503);
  const cutter=cutterPinRecord(env);
  const configured={configured:true,cloud:true,cutterConfigured:!!cutter};
  if (request.method==='GET') return json({...configured,...(await activeSession(db,request)??signOut)});
  if (request.method!=='POST') return json({message:'Метод недоступен.'},405);
  if (!sameOriginJson(request)) return json({message:'Откройте форму входа РИТМ.'},403);
  const input=await readJson(request,1024);
  if (input?.action==='logout') {
    await revoke(db,request);
    return json(signOut,200,{'Set-Cookie':cookie()});
  }
  if (input?.action!=='login' || !isPrintingDepartment(input.department) ||
      typeof input.pin!=='string' || !pinPattern.test(input.pin)) {
    return json({message:'Выберите участок и введите четыре цифры.'},400);
  }
  const record=input.department==='cutter' ? cutter : records[input.department];
  if (!record) return json({message:'PIN резчика ещё не настроен.'},503);
  const ready=await db.prepare('SELECT ready FROM printing_import WHERE singleton=1').first();
  if (ready?.ready!==1) return json({message:'Поставки ещё переносятся в облако.'},503);

  const now=Date.now(),id=randomUUID(),department=input.department;
  const client=sha(request.headers.get('CF-Connecting-IP')??'unknown');
  const [reserved]=await db.batch([
    db.prepare(`INSERT INTO printing_login_attempts(id,department,client,at)
      SELECT ?,?,?,? FROM (SELECT count(*) AS daily,count(CASE WHEN at>? THEN 1 END) AS recent,
        count(CASE WHEN client=? AND at>? THEN 1 END) AS from_client
        FROM printing_login_attempts WHERE department=? AND at>?)
      WHERE daily<30 AND recent<8 AND from_client<5`)
      .bind(id,department,client,now,now-10*minute,client,now-15*minute,department,now-1440*minute),
    db.prepare('DELETE FROM printing_login_attempts WHERE department=? AND at<=?').bind(department,now-1440*minute),
  ]);
  if (!reserved.meta.changes) return json({message:'Слишком много попыток. Попробуйте позже.'},429,{'Retry-After':'900'});

  const hash=await stretch(input.pin,record.salt,32);
  if (!timingSafeEqual(hash,Buffer.from(record.hash,'hex'))) return json({message:'Неверный PIN.'},401);
  const previous=sessionToken(request);
  const token=randomBytes(32).toString('hex'), expiresAt=now+life;
  const statements=[
    db.prepare('DELETE FROM printing_login_attempts WHERE id=?').bind(id),
    db.prepare('DELETE FROM printing_sessions WHERE expires_at<=?').bind(now),
    db.prepare('INSERT INTO printing_sessions(token_hash,department,expires_at) VALUES(?,?,?)').bind(sha(token),department,expiresAt),
  ];
  if (previous) statements.push(db.prepare('DELETE FROM printing_sessions WHERE token_hash=?').bind(previous));
  await db.batch(statements);
  return json({...configured,department,expiresAt},200,{'Set-Cookie':cookie(token,life/1000)});
}

export async function checkPinRuntime(env) {
  if (!pinRecords(env)) return false;
  const result=await stretch('RITM host check','health',32);
  return result.length===32;
}
