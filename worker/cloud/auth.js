import { CloudError, readJson } from "./access.js";

const COOKIE = "__Host-ritm_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
// Cloudflare Workers Web Crypto rejects PBKDF2 iteration counts above 100,000.
const PBKDF2_ITERATIONS = 100_000;
const textEncoder = new TextEncoder();
const schemaByDb = new WeakMap();

const AUTH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ritm_manager_users (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    pin_salt TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    must_change_pin INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    created_by TEXT,
    last_login_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS ritm_manager_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES ritm_manager_users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ritm_manager_sessions_user ON ritm_manager_sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS ritm_manager_sessions_expiry ON ritm_manager_sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS ritm_manager_login_limits (
    username TEXT PRIMARY KEY NOT NULL,
    window_started_at INTEGER NOT NULL,
    failure_count INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  )`,
];

export async function ensureAuthSchema(db) {
  if (!db?.prepare || !db?.batch) throw new CloudError("cloud_database_missing", "Облачное хранилище ещё не подключено.");
  let ready = schemaByDb.get(db);
  if (!ready) {
    ready = db.batch(AUTH_SCHEMA.map((statement) => db.prepare(statement))).catch((error) => {
      schemaByDb.delete(db);
      throw error;
    });
    schemaByDb.set(db, ready);
  }
  await ready;
}

function encode64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value) {
  return encode64url(new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value))));
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function parseCookie(request) {
  const value = request.headers.get("cookie") || "";
  for (const part of value.split(";")) {
    const split = part.trim().indexOf("=");
    if (split < 0 || part.slice(0, split).trim() !== COOKIE) continue;
    const token = part.slice(split + 1).trim();
    return /^[A-Za-z0-9_-]{40,50}$/.test(token) ? token : null;
  }
  return null;
}

function parseSessionToken(request) {
  const bearer = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{40,50})$/i)?.[1];
  return bearer || parseCookie(request);
}

function sessionCookie(token, maxAge = SESSION_MS / 1000) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return sessionCookie("", 0);
}

export function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site")
    throw new CloudError("origin_forbidden", "Откройте действие на странице RITM.", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new CloudError("json_required", "Не удалось прочитать запрос.", 415);
}

export function normalizeUsername(value) {
  if (typeof value !== "string") throw new CloudError("login_invalid", "Укажите логин длиной от 3 до 40 символов.", 400);
  const username = value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
  if (username.length < 3 || username.length > 40 || !/^[\p{L}\p{N}._-]+$/u.test(username))
    throw new CloudError("login_invalid", "Логин: от 3 до 40 букв, цифр, точки, дефиса или подчёркивания.", 400);
  return username;
}

function cleanDisplayName(value) {
  if (typeof value !== "string") throw new CloudError("name_invalid", "Укажите имя менеджера.", 400);
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!name || name.length > 80) throw new CloudError("name_invalid", "Имя должно быть длиной до 80 символов.", 400);
  return name;
}

export function isValidPin(value) {
  return typeof value === "string" && /^\d{8}$/.test(value);
}

function requirePin(value) {
  if (!isValidPin(value)) throw new CloudError("pin_invalid", "PIN должен содержать ровно 8 цифр.", 400);
  return value;
}

export function createTemporaryPin() {
  const digits = [];
  while (digits.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte < 250) digits.push(String(byte % 10));
      if (digits.length === 8) break;
    }
  }
  return digits.join("");
}

async function hashPin(pin, salt = randomBytes(16)) {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(requirePin(pin)), "PBKDF2", false, ["deriveBits"]);
  const result = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  ));
  return { salt: encode64url(salt), hash: encode64url(result) };
}

async function verifyPin(pin, saltValue, hashValue) {
  const salt = decode64url(saltValue);
  const expected = decode64url(hashValue);
  const actual = decode64url((await hashPin(pin, salt)).hash);
  if (actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++) mismatch |= actual[i] ^ expected[i];
  return mismatch === 0;
}

function setCookie(response, value) {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function getManagerSession(request, db, now = Date.now()) {
  const token = parseSessionToken(request);
  if (!token) return null;
  await ensureAuthSchema(db);
  const tokenHash = await sha256(token);
  const row = await db.prepare(`SELECT s.expires_at,u.id,u.username,u.display_name,u.must_change_pin,u.status
    FROM ritm_manager_sessions s JOIN ritm_manager_users u ON u.id=s.user_id
    WHERE s.token_hash=?`).bind(tokenHash).first();
  if (!row || row.status !== "active" || row.expires_at <= now) {
    await db.prepare("DELETE FROM ritm_manager_sessions WHERE token_hash=?").bind(tokenHash).run();
    return null;
  }
  const expiresAt = now + SESSION_MS;
  await db.prepare("UPDATE ritm_manager_sessions SET last_seen_at=?,expires_at=? WHERE token_hash=?").bind(now, expiresAt, tokenHash).run();
  return { role: "manager", id: row.id, username: row.username, displayName: row.display_name, mustChangePin: row.must_change_pin === 1 };
}

export async function resolvePrincipal(request, bindings, now = Date.now()) {
  const id = request.headers.get("oai-authenticated-user-id");
  const owners = String(bindings.RITM_OWNER_USER_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (id && owners.includes(id)) return { role: "owner", id, displayName: "Кирилл", username: null, mustChangePin: false };
  if (request.headers.has("cookie") || request.headers.has("authorization")) {
    const manager = await getManagerSession(request, bindings.DB, now);
    if (manager) return manager;
  }
  return id ? { role: "unrecognized", id, displayName: null, username: null, mustChangePin: false } : null;
}

export async function loginWithPin(request, db, now = Date.now()) {
  assertSameOrigin(request);
  await ensureAuthSchema(db);
  const input = await readJson(request, 2048).catch((error) => {
    if (error instanceof CloudError) throw error;
    return null;
  });
  if (!input || typeof input !== "object") throw new CloudError("invalid_json", "Не удалось прочитать запрос.", 400);
  const username = normalizeUsername(input.username);
  const pin = requirePin(input.pin);
  const limit = await db.prepare("SELECT window_started_at,failure_count,locked_until FROM ritm_manager_login_limits WHERE username=?").bind(username).first();
  if (limit?.locked_until > now) throw new CloudError("login_rate_limited", "Слишком много попыток. Попробуйте ещё раз через 15 минут.", 429);
  const user = await db.prepare("SELECT id,username,display_name,pin_salt,pin_hash,must_change_pin,status FROM ritm_manager_users WHERE username=?").bind(username).first();
  const salt = user?.pin_salt || "cml0bS1waW4tc2FsdC0xMjM0NTY3OA";
  const hash = user?.pin_hash || "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const valid = await verifyPin(pin, salt, hash);
  if (!user || user.status !== "active" || !valid) {
    const failure = await db.prepare(`INSERT INTO ritm_manager_login_limits(username,window_started_at,failure_count,locked_until)
      VALUES(?,?,1,0)
      ON CONFLICT(username) DO UPDATE SET
        failure_count=CASE WHEN ritm_manager_login_limits.window_started_at<=excluded.window_started_at-? THEN 1 ELSE ritm_manager_login_limits.failure_count+1 END,
        window_started_at=CASE WHEN ritm_manager_login_limits.window_started_at<=excluded.window_started_at-? THEN excluded.window_started_at ELSE ritm_manager_login_limits.window_started_at END,
        locked_until=CASE WHEN (CASE WHEN ritm_manager_login_limits.window_started_at<=excluded.window_started_at-? THEN 1 ELSE ritm_manager_login_limits.failure_count+1 END)>=? THEN excluded.window_started_at+? ELSE CASE WHEN ritm_manager_login_limits.window_started_at<=excluded.window_started_at-? THEN 0 ELSE ritm_manager_login_limits.locked_until END END
      RETURNING failure_count,locked_until`).bind(username, now, ATTEMPT_WINDOW_MS, ATTEMPT_WINDOW_MS, ATTEMPT_WINDOW_MS, MAX_FAILURES, LOCK_MS, ATTEMPT_WINDOW_MS).first();
    if (failure?.locked_until > now) throw new CloudError("login_rate_limited", "Слишком много попыток. Попробуйте ещё раз через 15 минут.", 429);
    throw new CloudError("login_invalid", "Неверный логин или PIN.", 401);
  }
  const token = encode64url(randomBytes(32));
  const tokenHash = await sha256(token);
  await db.batch([
    db.prepare("INSERT INTO ritm_manager_sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)").bind(tokenHash, user.id, now, now + SESSION_MS, now),
    db.prepare("UPDATE ritm_manager_users SET last_login_at=?,updated_at=? WHERE id=?").bind(now, now, user.id),
    db.prepare("DELETE FROM ritm_manager_login_limits WHERE username=?").bind(username),
  ]);
  const response = Response.json({ ok: true, role: "manager", username: user.username, displayName: user.display_name, mustChangePin: user.must_change_pin === 1, sessionToken: token }, { headers: { "cache-control": "no-store" } });
  return setCookie(response, sessionCookie(token));
}

export async function logoutManager(request, db) {
  assertSameOrigin(request);
  const token = parseSessionToken(request);
  if (token) {
    await ensureAuthSchema(db);
    await db.prepare("DELETE FROM ritm_manager_sessions WHERE token_hash=?").bind(await sha256(token)).run();
  }
  return setCookie(Response.json({ ok: true }, { headers: { "cache-control": "no-store" } }), clearSessionCookie());
}

export async function changeManagerPin(request, db, principal, now = Date.now()) {
  assertSameOrigin(request);
  if (principal?.role !== "manager") throw new CloudError("manager_session_required", "Войдите в RITM как менеджер.", 401);
  const input = await readJson(request, 2048).catch((error) => {
    if (error instanceof CloudError) throw error;
    return null;
  });
  if (!input || typeof input !== "object") throw new CloudError("invalid_json", "Не удалось прочитать запрос.", 400);
  const newPin = requirePin(input.newPin);
  if (!principal.mustChangePin) {
    const currentPin = requirePin(input.currentPin);
    const user = await db.prepare("SELECT pin_salt,pin_hash,status FROM ritm_manager_users WHERE id=?").bind(principal.id).first();
    if (!user || user.status !== "active" || !(await verifyPin(currentPin, user.pin_salt, user.pin_hash)))
      throw new CloudError("current_pin_invalid", "Текущий PIN не подошёл.", 401);
    if (currentPin === newPin) throw new CloudError("pin_unchanged", "Новый PIN должен отличаться от текущего.", 400);
  }
  const encoded = await hashPin(newPin);
  const result = await db.prepare("UPDATE ritm_manager_users SET pin_salt=?,pin_hash=?,must_change_pin=0,updated_at=? WHERE id=? AND status='active'").bind(encoded.salt, encoded.hash, now, principal.id).run();
  if (result.meta?.changes !== 1) throw new CloudError("manager_missing", "Учётная запись не найдена.", 404);
  return Response.json({ ok: true, mustChangePin: false }, { headers: { "cache-control": "no-store" } });
}

export async function listManagerUsers(db) {
  await ensureAuthSchema(db);
  const result = await db.prepare(`SELECT id,username,display_name,status,created_at,last_login_at
    FROM ritm_manager_users ORDER BY display_name COLLATE NOCASE,username`).all();
  return (result.results || []).map((row) => ({ id: row.id, username: row.username, displayName: row.display_name, status: row.status, createdAt: row.created_at, lastLoginAt: row.last_login_at }));
}

export async function createManagerUser(db, input, ownerId, now = Date.now()) {
  await ensureAuthSchema(db);
  const username = normalizeUsername(input?.username);
  const displayName = cleanDisplayName(input?.displayName);
  const pin = createTemporaryPin();
  const encoded = await hashPin(pin);
  const id = crypto.randomUUID();
  const result = await db.batch([
    db.prepare(`INSERT INTO ritm_manager_users(id,username,display_name,pin_salt,pin_hash,must_change_pin,status,created_at,updated_at,created_by)
      VALUES(?,?,?,?,?,1,'active',?,?,?) ON CONFLICT(username) DO NOTHING`).bind(id, username, displayName, encoded.salt, encoded.hash, now, now, ownerId),
    db.prepare(`INSERT INTO cloud_audit(id,at,type,message,incident_id)
      SELECT ?,?,'manager_access',?,NULL WHERE EXISTS(SELECT 1 FROM ritm_manager_users WHERE id=?)`).bind(crypto.randomUUID(), now, `created:${id}`, id),
  ]);
  if (result[0]?.meta?.changes !== 1) throw new CloudError("username_exists", "Такой логин уже существует.", 409);
  return { id, username, displayName, temporaryPin: pin, mustChangePin: true };
}

export async function resetManagerPin(db, id, ownerId, now = Date.now()) {
  await ensureAuthSchema(db);
  const pin = createTemporaryPin();
  const encoded = await hashPin(pin);
  const result = await db.batch([
    db.prepare("UPDATE ritm_manager_users SET pin_salt=?,pin_hash=?,must_change_pin=1,updated_at=? WHERE id=? AND status='active'").bind(encoded.salt, encoded.hash, now, id),
    db.prepare("DELETE FROM ritm_manager_sessions WHERE user_id=?").bind(id),
    db.prepare(`INSERT INTO cloud_audit(id,at,type,message,incident_id)
      SELECT ?,?,'manager_access',?,NULL WHERE EXISTS(SELECT 1 FROM ritm_manager_users WHERE id=? AND status='active')`).bind(crypto.randomUUID(), now, `pin_reset:${ownerId}:${id}`, id),
  ]);
  if (result[0]?.meta?.changes !== 1) throw new CloudError("manager_missing", "Активный менеджер не найден.", 404);
  return { temporaryPin: pin, mustChangePin: true };
}

export async function setManagerStatus(db, id, status, ownerId, now = Date.now()) {
  await ensureAuthSchema(db);
  const statements = [
    db.prepare("UPDATE ritm_manager_users SET status=?,updated_at=? WHERE id=?").bind(status, now, id),
    ...(status === "disabled" ? [db.prepare("DELETE FROM ritm_manager_sessions WHERE user_id=?").bind(id)] : []),
    db.prepare(`INSERT INTO cloud_audit(id,at,type,message,incident_id)
      SELECT ?,?,'manager_access',?,NULL WHERE EXISTS(SELECT 1 FROM ritm_manager_users WHERE id=?)`).bind(crypto.randomUUID(), now, `${status}:${ownerId}:${id}`, id),
  ];
  const result = await db.batch(statements);
  if (result[0]?.meta?.changes !== 1) throw new CloudError("manager_missing", "Менеджер не найден.", 404);
}
