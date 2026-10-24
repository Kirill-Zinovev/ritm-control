import http from "node:http";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { publicConfig } from "./config.js";
import { isTailscaleReadOrigin } from "./productionRepair.js";
import { summarizeAssembly, selectAssemblyPeriod } from "../worker/assembly.js";
import { todayMoscow } from "./adapters.js";
import { verifyTelegramInitData } from "./telegramMiniApp.js";
import { digest } from "./diagnosticGrid.js";
const sessionCookie = "ritm_owner";
function hash(s) {
  return createHash("sha256").update(s).digest("hex");
}
function equal(a, b) {
  const aa = Buffer.from(a || ""),
    bb = Buffer.from(b || "");
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}
function bounded(value, fallback, max) {
  const n = value === null ? fallback : Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= max ? n : fallback;
}
export function createAgentServer(
  store,
  config,
  {
    now = () => Date.now(),
    doctor = null,
    repair = null,
    sourceRecovery = null,
    rollSupplyService = null,
    productionSupplyService = null,
    assemblySync = null,
    assemblyTransfer = null,
    refreshPrinting = null,
    refreshAssembly = null,
    assistant = null,
    secretStore = null,
    telegramAssistant = null,
    signal,
  } = {},
) {
  if (config.ownerToken.length < 32)
    throw new Error(
      "RITM_OWNER_TOKEN must contain at least 32 characters; configure the owner before starting the API",
    );
  const sessions = new Map(),
    miniSessions = new Map(),
    miniInitDataSessions = new Map(),
    miniRepairConfirmations = new Map(),
    attempts = new Map(),
    requests = new Map();
  const hosts = new Set(config.allowedOrigins.map((o) => new URL(o).host));
  function send(res, status, payload, extra = {}) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...extra,
    });
    res.end(JSON.stringify(payload));
  }
  function miniIdentity(req) {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("ritm_mini="))
      ?.slice("ritm_mini=".length);
    if (!cookie) return null;
    const key = hash(cookie),
      session = miniSessions.get(key);
    if (!session || session.expiresAt <= now()) {
      miniSessions.delete(key);
      return null;
    }
    const owner = store.db
      .prepare("SELECT user_id,chat_id FROM assistant_owner WHERE id=1")
      .get();
    if (
      !owner ||
      owner.user_id !== session.userId ||
      owner.chat_id !== session.chatId
    ) {
      miniSessions.delete(key);
      return null;
    }
    return session;
  }
  function authenticated(req) {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer && equal(bearer, config.ownerToken)) return true;
    if (miniIdentity(req)) return true;
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(sessionCookie + "="))
      ?.slice(sessionCookie.length + 1);
    if (!cookie) return false;
    const key = hash(cookie),
      expiry = sessions.get(key);
    if (!expiry || expiry < now()) {
      sessions.delete(key);
      return false;
    }
    return true;
  }
  async function body(req, maxBytes = 8192) {
    let text = "";
    for await (const chunk of req) {
      text += chunk.toString();
      if (Buffer.byteLength(text) > maxBytes) {
        const error = new Error("Request body too large");
        error.status = 413;
        throw error;
      }
    }
    return JSON.parse(text);
  }
  const handler = async (req, res) => {
    try {
      const requestKey = req.socket.remoteAddress;
      const currentWindow = Math.floor(now() / 60000);
      const entry = requests.get(requestKey);
      const budget =
        entry?.window === currentWindow
          ? entry
          : { window: currentWindow, count: 0 };
      budget.count++;
      if (requests.size > 1000) requests.clear();
      requests.set(requestKey, budget);
      if (budget.count > (config.apiRateLimit || 180)) {
        send(
          res,
          429,
          { ok: false, error: "rate_limited" },
          { "retry-after": "60" },
        );
        return;
      }
      const origin = req.headers.origin,
        pathOnly = new URL(req.url, "http://127.0.0.1:" + config.port).pathname,
        mobileApprovalPage =
          req.method === "GET" &&
          pathOnly === "/telegram-approval" &&
          !!config.publicOrigin &&
          isTailscaleReadOrigin(config.publicOrigin) &&
          req.headers.host === new URL(config.publicOrigin).host &&
          ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
            req.socket.remoteAddress,
          ) &&
          !Object.keys(req.headers).some(
            (h) => h.startsWith("x-forwarded-") || h === "forwarded",
          );
      const localHost = [
        "127.0.0.1:" + req.socket.localPort,
        "localhost:" + req.socket.localPort,
      ].includes(req.headers.host);
      if (
        (!hosts.has(req.headers.host) && !localHost) ||
        (origin && !config.allowedOrigins.includes(origin)) ||
        (req.headers["sec-fetch-site"] === "cross-site" && !mobileApprovalPage)
      ) {
        send(res, 403, {
          ok: false,
          error: "origin_forbidden",
          message: "Доступ разрешён только с настроенного адреса.",
        });
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1:" + config.port),
        pathname = url.pathname;
      const trustedMiniRequest = () =>
        !!config.publicOrigin &&
        new URL(config.publicOrigin).protocol === "https:" &&
        req.headers.host === new URL(config.publicOrigin).host &&
        origin === config.publicOrigin &&
        ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress,
        ) &&
        !Object.keys(req.headers).some(
          (header) =>
            header.startsWith("x-forwarded-") || header === "forwarded",
        );
      const miniPostAllowed = () =>
        !!miniIdentity(req) &&
        trustedMiniRequest() &&
        req.headers["x-ritm-miniapp"] === "1";
      if (pathname === "/api/mini/session") {
        if (req.method === "GET") {
          const session = miniIdentity(req);
          send(
            res,
            session ? 200 : 401,
            session
              ? { ok: true, user: { firstName: session.firstName } }
              : { ok: false, error: "mini_session_required" },
          );
          return;
        }
        if (req.method !== "POST" || !trustedMiniRequest()) {
          send(res, 403, {
            ok: false,
            error: "mini_origin_forbidden",
            message:
              "Mini App доступен только с настроенного защищённого HTTPS-адреса.",
          });
          return;
        }
        if (
          !String(req.headers["content-type"] || "").startsWith(
            "application/json",
          )
        ) {
          send(res, 415, { ok: false, error: "json_required" });
          return;
        }
        let payload;
        try {
          payload = await body(req, 10_000);
        } catch {
          send(res, 400, { ok: false, error: "invalid_init_data" });
          return;
        }
        const verified =
          payload &&
          Object.keys(payload).length === 1 &&
          typeof payload.initData === "string"
            ? verifyTelegramInitData(payload.initData, config.telegram.token, {
                now: now(),
              })
            : null;
        const owner = store.db
          .prepare("SELECT user_id,chat_id FROM assistant_owner WHERE id=1")
          .get();
        if (
          !verified ||
          !owner ||
          verified.userId !== owner.user_id ||
          owner.chat_id !== verified.userId ||
          (verified.chatType && verified.chatType !== "private")
        ) {
          assistant?.audit(
            "telegram-mini-app",
            verified?.userId || "unknown",
            "mini_auth_rejected",
            null,
            "rejected",
          );
          send(res, 401, {
            ok: false,
            error: "owner_authentication_failed",
            message:
              "Подтверждённый Telegram-владелец не найден. Доступ запрещён.",
          });
          return;
        }
        for (const [key, value] of miniInitDataSessions)
          if (value.expiresAt <= now()) miniInitDataSessions.delete(key);
        const tokenKey = verified.initDataHash;
        let sessionToken = miniInitDataSessions.get(tokenKey)?.token;
        if (!sessionToken) {
          while (miniInitDataSessions.size >= 100) {
            const oldestKey = miniInitDataSessions.keys().next().value;
            const oldest = miniInitDataSessions.get(oldestKey);
            if (oldest?.token) miniSessions.delete(hash(oldest.token));
            miniInitDataSessions.delete(oldestKey);
          }
          sessionToken = randomBytes(32).toString("hex");
          miniInitDataSessions.set(tokenKey, {
            token: sessionToken,
            expiresAt: now() + 8 * 60 * 60_000,
            userId: owner.user_id,
            chatId: owner.chat_id,
            firstName: String(verified.user.first_name || "").slice(0, 80),
          });
        }
        const session = miniInitDataSessions.get(tokenKey);
        miniSessions.set(hash(sessionToken), session);
        assistant?.audit(
          "telegram-mini-app",
          verified.userId,
          "mini_owner_authenticated",
        );
        send(
          res,
          200,
          { ok: true, user: { firstName: session.firstName } },
          {
            "set-cookie":
              "ritm_mini=" +
              sessionToken +
              "; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800; Secure",
          },
        );
        return;
      }
      if (mobileApprovalPage) {
        const token = url.searchParams.get("token") || "";
        if (!/^[a-f0-9]{48}$/.test(token)) {
          res.writeHead(404, {
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          });
          res.end("Ссылка подтверждения недействительна или устарела.");
          return;
        }
        const nonce = randomBytes(18).toString("base64url");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
        });
        res.end(
          `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подтверждение RITM</title><style>body{font:16px system-ui,sans-serif;background:#f4f7fa;color:#14283c;margin:0;padding:20px}.card{max-width:620px;margin:6vh auto;background:white;border:1px solid #d6e0e9;border-radius:14px;padding:24px;box-shadow:0 10px 35px #13283c18}h1{font-size:24px;margin:0 0 8px}p{color:#526a80;line-height:1.5}.row{padding:12px 0;border-bottom:1px solid #e2e9ef}.label{color:#657d92;font-size:13px}.value{font-weight:650;overflow-wrap:anywhere}input,button{font:inherit;width:100%;box-sizing:border-box;border:1px solid #ccd8e2;border-radius:8px;padding:12px;margin-top:10px}button{background:#008b68;color:white;border:0;font-weight:700}button.secondary{background:#edf2f6;color:#173047}button:disabled{opacity:.55}#status{margin-top:14px;white-space:pre-wrap}</style><main class="card"><h1>Подтверждение исправления RITM</h1><p>Сначала войдите как владелец. Проверьте адрес и значение. Подтверждение одноразовое и истекает через 10 минут.</p><form id="login"><label>Ключ владельца RITM<input id="ownerKey" type="password" autocomplete="current-password" required></label><button>Войти и проверить</button></form><section id="details" hidden></section><p id="status" role="status"></p></main><script nonce="${nonce}">(()=>{const token=${JSON.stringify(token)},login=document.querySelector('#login'),details=document.querySelector('#details'),status=document.querySelector('#status');let action=null;const show=(label,value)=>{const row=document.createElement('div');row.className='row';const a=document.createElement('div');a.className='label';a.textContent=label;const b=document.createElement('div');b.className='value';b.textContent=value;row.append(a,b);details.append(row)};function exclusiveCheck(){if(!action?.requiresExclusiveEditing)return;const label=document.createElement('label');label.style.display='block';const input=document.createElement('input');input.type='checkbox';input.id='exclusiveEditing';input.style.width='auto';label.append(input,document.createTextNode(' Подтверждаю отсутствие параллельного редактирования этой ячейки.'));details.append(label)}async function load(){const r=await fetch('/api/intelligence/telegram-approval?token='+encodeURIComponent(token),{credentials:'same-origin',cache:'no-store'});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||'Не удалось проверить заявку.');action=d;login.hidden=true;details.hidden=false;details.replaceChildren();show('Документ',d.document);show('Лист и ячейка',d.sheet+'!'+d.cell);show('Артикул',d.article);show('Текущее значение',d.current);show('Будет записано',d.proposed);show('Источник значения',d.evidence);exclusiveCheck();const button=document.createElement('button');button.textContent='Подтвердить эту запись';button.onclick=confirm;details.append(button);const cancel=document.createElement('button');cancel.className='secondary';cancel.textContent='Отмена';cancel.onclick=()=>{status.textContent='Запись не выполнялась. Можно закрыть страницу.';details.replaceChildren()};details.append(cancel);status.textContent='Проверьте каждое поле перед подтверждением.'}async function confirm(){const button=details.querySelector('button');if(action?.requiresExclusiveEditing&&!document.querySelector('#exclusiveEditing')?.checked){status.textContent='Подтвердите отсутствие параллельного редактирования.';return}button.disabled=true;button.textContent='Проверяю и запускаю…';try{const r=await fetch('/api/intelligence/telegram-approval',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({token,exclusiveEditingAcknowledged:!!document.querySelector('#exclusiveEditing')?.checked})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||'Подтверждение отклонено.');details.replaceChildren();status.textContent='Подтверждение принято. '+(d.cell||'')+'. RITM повторно проверяет текущее значение и эталон перед записью.'}catch(e){button.disabled=false;button.textContent='Подтвердить эту запись';status.textContent=e.message}}login.addEventListener('submit',async e=>{e.preventDefault();const key=document.querySelector('#ownerKey');status.textContent='Проверяю доступ…';try{const r=await fetch('/api/intelligence/session',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({token:key.value})});const d=await r.json().catch(()=>({}));key.value='';if(!r.ok)throw new Error(d.message||'Не удалось войти.');await load()}catch(err){status.textContent=err.message}});fetch('/api/intelligence/telegram-approval?token='+encodeURIComponent(token),{credentials:'same-origin',cache:'no-store'}).then(async r=>{if(r.status===401){status.textContent='Войдите ключом владельца RITM, чтобы увидеть точное действие.';return}const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||'Ссылка недействительна или устарела.');action=d;login.hidden=true;details.hidden=false;details.replaceChildren();show('Документ',d.document);show('Лист и ячейка',d.sheet+'!'+d.cell);show('Артикул',d.article);show('Текущее значение',d.current);show('Будет записано',d.proposed);show('Источник значения',d.evidence);exclusiveCheck();const b=document.createElement('button');b.textContent='Подтвердить эту запись';b.onclick=confirm;details.append(b);const c=document.createElement('button');c.className='secondary';c.textContent='Отмена';c.onclick=()=>{status.textContent='Запись не выполнялась.';details.replaceChildren()};details.append(c);status.textContent='Проверьте адрес и значение.'}).catch(e=>status.textContent=e.message)})();</script></html>`,
        );
        return;
      }
      if (pathname === "/api/intelligence/session" && req.method === "POST") {
        if (
          !String(req.headers["content-type"] || "").startsWith(
            "application/json",
          )
        ) {
          send(res, 415, { ok: false, error: "json_required" });
          return;
        }
        const key = req.socket.remoteAddress;
        const state = attempts.get(key);
        if (state && state.until > now() && state.count >= 5) {
          send(res, 429, {
            ok: false,
            error: "login_rate_limited",
            message: "Слишком много попыток. Повторите через 15 минут.",
          });
          return;
        }
        let payload;
        try {
          payload = await body(req);
        } catch {
          send(res, 400, { ok: false, error: "invalid_request" });
          return;
        }
        if (
          typeof payload.token !== "string" ||
          !equal(payload.token, config.ownerToken)
        ) {
          const entry =
            !state || state.until <= now()
              ? { count: 0, until: now() + 900000 }
              : state;
          entry.count++;
          attempts.set(key, entry);
          send(res, 401, {
            ok: false,
            error: "unauthorized",
            message: "Неверный ключ владельца.",
          });
          return;
        }
        attempts.delete(key);
        for (const [k, expiry] of sessions)
          if (expiry <= now()) sessions.delete(k);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const cookie = randomBytes(32).toString("hex");
        sessions.set(hash(cookie), now() + 8 * 3600000);
        store.log(
          "owner_login",
          repair
            ? "Владелец вошёл в AI Center; каждая запись требует отдельного подтверждения"
            : "Владелец вошёл в локальный AI Center; Google Sheets доступны только для чтения",
        );
        send(
          res,
          200,
          { ok: true },
          {
            "set-cookie":
              sessionCookie +
              "=" +
              cookie +
              "; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800" +
              (config.publicOrigin ? "; Secure" : ""),
          },
        );
        return;
      }
      if (pathname.startsWith("/api/")) {
        if (!authenticated(req)) {
          send(res, 401, {
            ok: false,
            error: "unauthorized",
            message: "Войдите с ключом владельца.",
          });
          return;
        }
        const miniSession = miniIdentity(req);
        if (
          miniSession &&
          !pathname.startsWith("/api/mini/") &&
          pathname !== "/api/intelligence/assistant/chat"
        ) {
          send(res, 403, {
            ok: false,
            error: "mini_scope_forbidden",
            message: "Mini App имеет доступ только к своим производственным функциям.",
          });
          return;
        }
        if (
          pathname.startsWith("/api/mini/") &&
          pathname !== "/api/mini/session"
        ) {
          const mini = miniIdentity(req);
          if (!mini || (req.method !== "GET" && !miniPostAllowed())) {
            send(res, 403, {
              ok: false,
              error: "mini_owner_session_required",
              message:
                "Нужна действующая сессия привязанного владельца Mini App.",
            });
            return;
          }
          if (pathname === "/api/mini/dashboard" && req.method === "GET") {
            if (!assistant) {
              send(res, 503, { ok: false, error: "assistant_unavailable" });
              return;
            }
            try {
              const period = "day";
              const [
                production,
                assembly,
                remaining,
                supplies,
                printBaseline,
                cuttingBaseline,
              ] = await Promise.all([
                  assistant.callTool("telegram-mini-app", mini.userId, "get_production_summary", { period }),
                  assistant.callTool("telegram-mini-app", mini.userId, "get_employee_kpi", { period }),
                  assistant.callTool("telegram-mini-app", mini.userId, "get_remaining_production", {}),
                  assistant.callTool("telegram-mini-app", mini.userId, "get_supplies_status", {}),
                  assistant.callTool("telegram-mini-app", mini.userId, "get_print_statistics", { period: "yesterday" }),
                  assistant.callTool("telegram-mini-app", mini.userId, "get_cutting_statistics", { period: "yesterday" }),
              ]);
              const overview = store.overview();
              const incidentPage = store.listIncidents({
                status: "active",
                page: 0,
                limit: 20,
                includeDemonstrations: false,
              });
              const assemblySource = config.sources.find(
                (source) => source.enabled && source.adapter === "assembly",
              );
              const assemblySnapshot = assemblySource
                ? store.getSnapshot(assemblySource.id)
                : null;
              const assemblyCheck = overview.checks.find(
                (check) => check.id === assemblySource?.id,
              );
              const coefficientRecords = (
                assemblySnapshot?.value?.history || []
              )
                .map((row) => ({
                  employee: row.employee,
                  date: row.date,
                  coefficient: row.coefficient,
                  cut: row.cut,
                  packed: row.packed,
                  total: row.total,
                  source: assemblySource?.name || "История производства",
                  article: null,
                  norm: null,
                  deviation: null,
                  status:
                    "Фактическое значение; норма по артикулу не настроена",
                }))
                .filter(
                  (row) =>
                    typeof row.coefficient === "number" &&
                    Number.isFinite(row.coefficient),
                );
              const doctorState = doctor?.state() || null;
              assistant.audit(
                "telegram-mini-app",
                mini.userId,
                "mini_dashboard_viewed",
              );
              const sourceById = new Map(
                config.doctorDocuments.map((doc) => [doc.id, doc]),
              );
              const incidentRows = [...incidentPage.rows]
                .sort((a, b) => {
                  const rank = (value) =>
                    ({ critical: 0, high: 1, warning: 2, medium: 3, low: 4 })[
                      String(value || "").toLowerCase()
                    ] ?? 5;
                  return (
                    rank(a.severity || a.priority) -
                      rank(b.severity || b.priority) ||
                    String(b.lastSeen || "").localeCompare(
                      String(a.lastSeen || ""),
                    )
                  );
                })
                .map((item) => {
                  const doc = sourceById.get(item.sourceId);
                  const gid = item.gid ?? doc?.sheets?.find((sheet) => sheet.name === item.sheet)?.gid;
                  return {
                    ...item,
                    sourceUrl:
                      doc?.documentId && Number.isInteger(gid)
                        ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(doc.documentId)}/edit?gid=${encodeURIComponent(gid)}#gid=${encodeURIComponent(gid)}&range=${encodeURIComponent(`${item.sheet}!${item.cell}`)}`
                        : null,
                  };
                });
              send(res, 200, {
                ok: true,
                fetchedAt: new Date(now()).toISOString(),
                production,
                assembly,
                remaining,
                supplies,
                baselines: {
                  printing: printBaseline,
                  cutting: cuttingBaseline,
                },
                activeCount: overview.active,
                incidents: incidentRows,
                coefficientRecords: coefficientRecords.slice(-1000),
                coefficientSource: {
                  name: assemblySource?.name || null,
                  updatedAt: assemblySnapshot?.at || null,
                  stale:
                    !assemblySnapshot ||
                    !assemblyCheck ||
                    ["error", "stale", "unavailable"].includes(
                      assemblyCheck.status,
                    ) ||
                    now() - Date.parse(assemblySnapshot.at) >
                      config.snapshotMaxAgeMs,
                  articleDimensionAvailable: false,
                  normConfigured: false,
                },
                checks: {
                  fast: doctor?.getRunStatus("fast", "fast") || null,
                  deep: doctor?.getRunStatus("deep", "all") || null,
                  lastDeep: doctorState?.lastCheck || null,
                  fastCheck:
                    doctorState?.formulaIntelligence?.fastCheck || null,
                },
              });
            } catch (error) {
              send(res, 503, {
                ok: false,
                error: "mini_dashboard_unavailable",
                message: String(
                  error?.message || "Нет проверенного снимка производства.",
                ).slice(0, 240),
              });
            }
            return;
          }
          if (pathname === "/api/mini/check" && req.method === "POST") {
            let payload;
            try {
              payload = await body(req, 2048);
            } catch {
              send(res, 400, { ok: false, error: "invalid_request" });
              return;
            }
            if (
              !assistant ||
              !payload ||
              Object.keys(payload).some(
                (key) => !["mode", "document", "sheet"].includes(key),
              ) ||
              !["fast", "deep"].includes(payload.mode) ||
              (payload.document !== undefined &&
                (typeof payload.document !== "string" ||
                  payload.document.length > 120)) ||
              (payload.sheet !== undefined &&
                (typeof payload.sheet !== "string" ||
                  payload.sheet.length > 160))
            ) {
              send(res, 400, { ok: false, error: "invalid_check" });
              return;
            }
            const tool =
              payload.mode === "fast" ? "run_fast_check" : "run_deep_check";
            try {
              const result = await assistant.callTool(
                "telegram",
                mini.userId,
                tool,
                {
                  ...(payload.document ? { document: payload.document } : {}),
                  ...(payload.sheet ? { sheet: payload.sheet } : {}),
                },
              );
              if (result?.status === "clarify") {
                send(res, 409, { ok: false, error: "check_scope_ambiguous", message: result.message || "Уточните документ или лист." });
                return;
              }
              send(res, 202, { ok: true, ...result });
            } catch (error) {
              send(res, error.status || 400, {
                ok: false,
                error: error.code || "check_rejected",
                message: String(error.message || "Проверка не запущена.").slice(
                  0,
                  240,
                ),
              });
            }
            return;
          }
          if (pathname === "/api/mini/checkstatus" && req.method === "GET") {
            const mode = url.searchParams.get("mode");
            if (mode && !["fast", "deep"].includes(mode)) {
              send(res, 400, { ok: false, error: "invalid_mode" });
              return;
            }
            send(res, 200, {
              ok: true,
              run:
                doctor?.getRunStatus(
                  mode || null,
                  mode === "fast" ? "fast" : mode === "deep" ? "all" : null,
                ) || null,
            });
            return;
          }
          if (
            pathname === "/api/mini/repair/prepare" &&
            req.method === "POST"
          ) {
            let payload;
            try {
              payload = await body(req, 2048);
            } catch {
              send(res, 400, { ok: false, error: "invalid_request" });
              return;
            }
            const incidentId = payload?.incidentId;
            if (
              !payload ||
              Object.keys(payload).length !== 1 ||
              !/^[a-f0-9]{64}$/.test(incidentId || "")
            ) {
              send(res, 400, { ok: false, error: "invalid_incident" });
              return;
            }
            if (!config.productionRepairEnabled || !repair?.production) {
              send(res, 503, {
                ok: false,
                error: "repair_unavailable",
                message:
                  "Производственное восстановление не настроено; запись заблокирована.",
              });
              return;
            }
            try {
              const row = store.db
                .prepare("SELECT * FROM incidents WHERE id=?")
                .get(incidentId);
              const incident = row && store.incident(row);
              if (
                !row ||
                row.status !== "open" ||
                ["ignored", "excepted", "fixed", "resolved"].includes(
                  incident.status,
                ) ||
                incident.demonstration ||
                incident.sourceRecoveryOperation ||
                incident.repairRequested
              ) {
                throw Object.assign(
                  new Error(
                    "Инцидент уже изменился или для него выполняется операция. Обновите список; запись не поставлена в очередь.",
                  ),
                  { status: 409, code: "incident_unavailable" },
                );
              }
              let proposal;
              if (incident.recoveryCandidate && sourceRecovery) {
                const context = sourceRecovery.context(incidentId, {
                  allowNewRequest: true,
                });
                const live = await sourceRecovery.readLive(context);
                const validated = sourceRecovery.validateBefore(context, live);
                if (validated.alreadyRestored)
                  throw Object.assign(
                    new Error(
                      "Ячейка уже восстановлена. Обновите проверку; повторная запись не нужна.",
                    ),
                    { status: 409, code: "already_restored" },
                  );
                const version = digest({
                  incidentId,
                  generation: context.incidentRow.generation,
                  candidate: context.candidate,
                });
                proposal = {
                  kind: "source",
                  incidentId,
                  generation: context.incidentRow.generation,
                  candidateVersion: context.candidate.version,
                  candidateFingerprint: version,
                  document: context.doc.name,
                  sheet: context.target.sheet,
                  cell: context.target.cell,
                  article: context.productKey || "Не указан",
                  current: "Пусто",
                  proposed: context.candidate.value.stringValue,
                  evidence:
                    context.candidate.evidence ||
                    "Подтверждённый кандидат Source Recovery",
                  target: context.target,
                  requiresHistoryApproval: false,
                };
              } else {
                if (
                  !incident.repairAvailability ||
                  incident.repairAvailability.status !== "candidate"
                ) {
                  throw Object.assign(
                    new Error(
                      "Для инцидента нет актуального утверждённого эталона; безопасное исправление не предлагается.",
                    ),
                    { status: 409, code: "baseline_unavailable" },
                  );
                }
                const state = await repair.prepare(incidentId, "repair");
                const pending = state.proposals?.find(
                  (item) => item.status === "pending",
                );
                if (!pending)
                  throw Object.assign(
                    new Error(
                      "RITM не подготовил актуальное предложение. Запись не выполнялась.",
                    ),
                    { status: 409, code: "proposal_unavailable" },
                  );
                const showValue = (value) =>
                  value?.formulaValue ??
                  value?.stringValue ??
                  value?.numberValue ??
                  value?.boolValue ??
                  "Пусто";
                proposal = {
                  kind: "formula",
                  incidentId,
                  proposalId: pending.id,
                  version: pending.version,
                  confirmation: pending.confirmation,
                  document:
                    incident.sourceName ||
                    incident.document ||
                    "Производственный документ",
                  sheet: pending.target.sheet,
                  cell: pending.target.cell,
                  article:
                    incident.productKey || incident.article || "Не указан",
                  current: String(showValue(pending.from)),
                  proposed: String(showValue(pending.to)),
                  evidence: pending.historyApprovalRequired
                    ? "Кандидат истории требует отдельного подтверждения владельца"
                    : "Утверждённый эталон Formula Intelligence",
                  target: pending.target,
                  requiresHistoryApproval:
                    pending.historyApprovalRequired === true,
                };
              }
              for (const [key, value] of miniRepairConfirmations)
                if (value.expiresAt <= now())
                  miniRepairConfirmations.delete(key);
              if (miniRepairConfirmations.size >= 100)
                throw Object.assign(
                  new Error("Слишком много ожидающих подтверждений. Повторите позже."),
                  { status: 429, code: "confirmation_limit" },
                );
              const token = randomBytes(32).toString("hex");
              miniRepairConfirmations.set(hash(token), {
                ...proposal,
                userId: mini.userId,
                expiresAt: now() + 10 * 60_000,
              });
              assistant?.audit(
                "telegram-mini-app",
                mini.userId,
                "mini_repair_prepared",
                incidentId,
                "pending_confirmation",
              );
              send(res, 200, {
                ok: true,
                proposal: {
                  kind: proposal.kind,
                  incidentId: proposal.incidentId,
                  document: proposal.document,
                  sheet: proposal.sheet,
                  cell: proposal.cell,
                  article: proposal.article,
                  current: proposal.current,
                  proposed: proposal.proposed,
                  evidence: proposal.evidence,
                  requiresHistoryApproval: proposal.requiresHistoryApproval,
                  token,
                  expiresAt: new Date(now() + 10 * 60_000).toISOString(),
                },
              });
            } catch (error) {
              assistant?.audit(
                "telegram-mini-app",
                mini.userId,
                "mini_repair_prepare_blocked",
                incidentId,
                error.code || "blocked",
              );
              send(res, error.status || 409, {
                ok: false,
                error: error.code || "repair_prepare_failed",
                message: String(
                  error.message || "Предложение не подготовлено.",
                ).slice(0, 300),
              });
            }
            return;
          }
          if (
            pathname === "/api/mini/repair/confirm" &&
            req.method === "POST"
          ) {
            let payload;
            try {
              payload = await body(req, 2048);
            } catch {
              send(res, 400, { ok: false, error: "invalid_request" });
              return;
            }
            if (
              !payload ||
              Object.keys(payload).some(
                (key) =>
                  ![
                    "token",
                    "exclusiveEditingAcknowledged",
                    "historyCandidateApproved",
                  ].includes(key),
              ) ||
              typeof payload.token !== "string" ||
              !/^[a-f0-9]{64}$/.test(payload.token) ||
              payload.exclusiveEditingAcknowledged !== true ||
              (payload.historyCandidateApproved !== undefined &&
                typeof payload.historyCandidateApproved !== "boolean")
            ) {
              send(res, 400, {
                ok: false,
                error: "exact_confirmation_required",
                message:
                  "Подтвердите точное изменение и отсутствие параллельного редактирования.",
              });
              return;
            }
            const key = hash(payload.token),
              confirmation = miniRepairConfirmations.get(key);
            if (
              !confirmation ||
              confirmation.userId !== mini.userId ||
              confirmation.expiresAt <= now()
            ) {
              miniRepairConfirmations.delete(key);
              send(res, 409, {
                ok: false,
                error: "confirmation_expired",
                message:
                  "Подтверждение истекло или уже использовано. Запись не выполнена.",
              });
              return;
            }
            if (
              confirmation.requiresHistoryApproval &&
              payload.historyCandidateApproved !== true
            ) {
              send(res, 403, {
                ok: false,
                error: "history_approval_required",
                message:
                  "Для этого кандидата отдельно подтвердите правильность значения из истории.",
              });
              return;
            }
            // Consume before invoking either queue to prevent concurrent double-clicks.
            miniRepairConfirmations.delete(key);
            try {
              let operation;
              if (confirmation.kind === "source") {
                operation = sourceRecovery.startForIncident(
                  confirmation.incidentId,
                  {
                    explicitWriteApproval: true,
                    incidentId: confirmation.incidentId,
                    candidateVersion: confirmation.candidateVersion,
                  },
                  {
                    source: "telegram_mini_app",
                    actor: mini.userId,
                    expectedCandidateFingerprint:
                      confirmation.candidateFingerprint,
                  },
                );
              } else {
                operation = await repair.confirm(confirmation.proposalId, {
                  version: confirmation.version,
                  confirmation: confirmation.confirmation,
                  exclusiveEditingAcknowledged: true,
                  historyCandidateApproved:
                    payload.historyCandidateApproved === true,
                });
              }
              assistant?.audit(
                "telegram-mini-app",
                mini.userId,
                "mini_repair_confirmed",
                confirmation.incidentId,
                "queued",
              );
              send(res, 202, {
                ok: true,
                incidentId: confirmation.incidentId,
                operation,
              });
            } catch (error) {
              assistant?.audit(
                "telegram-mini-app",
                mini.userId,
                "mini_repair_confirmation_blocked",
                confirmation.incidentId,
                error.code || "blocked",
              );
              send(res, error.status || 409, {
                ok: false,
                error: error.code || "repair_confirmation_failed",
                message: String(error.message || "Запись заблокирована.").slice(
                  0,
                  300,
                ),
              });
            }
            return;
          }
          if (pathname === "/api/mini/repair/status" && req.method === "GET") {
            const incidentId = url.searchParams.get("incidentId") || "";
            if (!/^[a-f0-9]{64}$/.test(incidentId)) {
              send(res, 400, { ok: false, error: "invalid_incident" });
              return;
            }
            const source = sourceRecovery?.state(incidentId)?.operation || null;
            const formula = store.db
              .prepare(
                "SELECT id,status,result FROM test_repair_proposals WHERE incident_id=? ORDER BY rowid DESC LIMIT 5",
              )
              .all(incidentId)
              .map((row) => ({
                id: row.id,
                status: row.status,
                result: row.result ? JSON.parse(row.result) : null,
              }));
            send(res, 200, {
              ok: true,
              source: source
                ? {
                    id: source.id,
                    status: source.status,
                    createdAt: source.createdAt,
                    updatedAt: source.updatedAt,
                    result: source.result
                      ? {
                          phase: source.result.phase,
                          verifiedAt: source.result.verifiedAt,
                          message: source.result.message,
                          resolutionCause: source.result.resolutionCause,
                          writeSucceeded: source.result.writeSucceeded,
                          retryAllowed: source.result.retryAllowed,
                        }
                      : null,
                  }
                : null,
              repair: formula,
            });
            return;
          }
        }
        if (
          pathname === "/api/intelligence/session" &&
          req.method === "DELETE"
        ) {
          const cookie = req.headers.cookie?.match(/ritm_owner=([^;]+)/)?.[1];
          if (cookie) sessions.delete(hash(cookie));
          send(
            res,
            200,
            { ok: true },
            {
              "set-cookie":
                sessionCookie +
                "=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0" +
                (config.publicOrigin ? "; Secure" : ""),
            },
          );
          return;
        }
        if (
          pathname === "/api/intelligence/telegram-approval" &&
          (req.method === "GET" || req.method === "POST")
        ) {
          const trustedPhoneRequest =
            !!telegramAssistant &&
            !!config.publicOrigin &&
            isTailscaleReadOrigin(config.publicOrigin) &&
            config.port === 4318 &&
            req.headers.host === new URL(config.publicOrigin).host &&
            origin === config.publicOrigin &&
            ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
              req.socket.remoteAddress,
            ) &&
            !!req.headers.cookie?.includes("ritm_owner=") &&
            !req.headers.authorization &&
            !Object.keys(req.headers).some(
              (h) => h.startsWith("x-forwarded-") || h === "forwarded",
            );
          if (!trustedPhoneRequest) {
            send(res, 403, {
              ok: false,
              error: "telegram_approval_forbidden",
              message:
                "Нужны защищённый Tailscale HTTPS и вход владельца. Запись заблокирована.",
            });
            return;
          }
          if (req.method === "GET") {
            const approval = telegramAssistant.webApprovalDetails(
              url.searchParams.get("token") || "",
            );
            send(
              res,
              approval ? 200 : 409,
              approval
                ? { ok: true, ...approval }
                : {
                    ok: false,
                    error: "telegram_approval_stale",
                    message:
                      "Ссылка истекла, уже использована или заявка изменилась.",
                  },
            );
            return;
          }
          try {
            const payload = await body(req, 1024);
            if (
              !payload ||
              Object.keys(payload).some(
                (key) =>
                  !["token", "exclusiveEditingAcknowledged"].includes(key),
              ) ||
              typeof payload.token !== "string" ||
              !/^[a-f0-9]{48}$/.test(payload.token) ||
              (payload.exclusiveEditingAcknowledged !== undefined &&
                typeof payload.exclusiveEditingAcknowledged !== "boolean")
            )
              throw new Error("Некорректное подтверждение.");
            const result = await telegramAssistant.confirmWebApproval(
              payload.token,
              payload.exclusiveEditingAcknowledged === true,
            );
            send(res, 202, { ok: true, ...result });
          } catch (error) {
            send(res, error.status || 409, {
              ok: false,
              error: error.code || "telegram_approval_failed",
              message: error.message || "Подтверждение не выполнено.",
            });
          }
          return;
        }
        if (
          pathname === "/api/intelligence/assistant" &&
          req.method === "GET"
        ) {
          send(
            res,
            assistant ? 200 : 503,
            assistant
              ? { ok: true, ...assistant.configView() }
              : { ok: false, message: "RITM Assistant не настроен" },
          );
          return;
        }
        if (
          pathname.startsWith("/api/intelligence/assistant/") &&
          req.method === "POST"
        ) {
          if (
            !String(req.headers["content-type"] || "").startsWith(
              "application/json",
            )
          ) {
            send(res, 415, { ok: false, error: "json_required" });
            return;
          }
          let payload;
          try {
            payload = await body(req, 16000);
          } catch {
            send(res, 400, {
              ok: false,
              error: "invalid_request",
              message: "Некорректный запрос.",
            });
            return;
          }
          if (pathname === "/api/intelligence/assistant/chat") {
            if (
              !assistant ||
              typeof payload.message !== "string" ||
              !payload.message.trim() ||
              payload.message.length > 1000
            ) {
              send(res, 400, {
                ok: false,
                message: "Введите вопрос до 1000 символов.",
              });
              return;
            }
            const mini = miniSession;
            if (
              mini &&
              (!miniPostAllowed() ||
                !payload ||
                Object.keys(payload).some((key) => key !== "message"))
            ) {
              send(res, 403, {
                ok: false,
                error: "mini_csrf_rejected",
                message: "Запрос Mini App не прошёл проверку источника.",
              });
              return;
            }
            assistant.audit(
              mini ? "telegram-mini-app" : "web",
              mini?.userId || "owner",
              "message_received",
            );
            const result = await assistant.respond(
              payload.message,
              mini
                ? { channel: "telegram-mini-app", actor: mini.userId }
                : { channel: "web", actor: "owner" },
            );
            send(res, 200, { ok: true, ...result });
            return;
          }
          const localOnly =
            localHost &&
            ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
              req.socket.remoteAddress,
            ) &&
            req.headers.cookie?.includes("ritm_owner=") &&
            !req.headers.authorization &&
            config.allowedOrigins.includes(origin) &&
            (() => {
              try {
                const parsed = new URL(origin);
                return (
                  parsed.protocol === "http:" &&
                  ["localhost", "127.0.0.1"].includes(parsed.hostname)
                );
              } catch {
                return false;
              }
            })();
          if (!localOnly) {
            send(res, 403, {
              ok: false,
              error: "local_owner_session_required",
              message:
                "Эта настройка доступна владельцу в локальном AI Center.",
            });
            return;
          }
          if (pathname === "/api/intelligence/assistant/pair") {
            if (!assistant) {
              send(res, 503, { ok: false });
              return;
            }
            send(res, 200, { ok: true, ...assistant.createPairing() });
            return;
          }
          if (pathname === "/api/intelligence/assistant/test-telegram") {
            try {
              await telegramAssistant?.sendTest();
              send(res, 200, {
                ok: true,
                message: "Тестовое сообщение отправлено.",
              });
            } catch (error) {
              send(res, 409, { ok: false, message: error.message });
            }
            return;
          }
          if (pathname === "/api/intelligence/assistant/configure") {
            if (!assistant || !secretStore) {
              send(res, 503, { ok: false });
              return;
            }
            const provider =
              payload.provider ?? config.assistant?.provider ?? "openai";
            const model =
              payload.model ?? config.assistant?.model ?? "gpt-4o-mini";
            const spendLimitUsd =
              payload.spendLimitUsd ?? config.assistant?.spendLimitUsd ?? 5;
            const dailyRequestLimit =
              payload.dailyRequestLimit ??
              config.assistant?.dailyRequestLimit ??
              50;
            const allowedModels =
              provider === "openai"
                ? ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5-mini"]
                : provider === "anthropic"
                  ? ["claude-sonnet-4-6"]
                  : [];
            if (
              !allowedModels.includes(model) ||
              typeof model !== "string" ||
              !/^[A-Za-z0-9._-]{1,64}$/.test(model) ||
              !Number.isFinite(spendLimitUsd) ||
              spendLimitUsd < 0.1 ||
              spendLimitUsd > 1000 ||
              !Number.isInteger(dailyRequestLimit) ||
              dailyRequestLimit < 1 ||
              dailyRequestLimit > 500 ||
              (payload.apiKey !== undefined &&
                (typeof payload.apiKey !== "string" ||
                  payload.apiKey.length > 300)) ||
              (payload.telegramToken !== undefined &&
                (typeof payload.telegramToken !== "string" ||
                  payload.telegramToken.length > 200))
            ) {
              send(res, 400, {
                ok: false,
                message: "Проверьте модель, лимиты и секреты.",
              });
              return;
            }
            try {
              const saved = await secretStore.read();
              const next = {
                ...saved,
                provider,
                model,
                spendLimitUsd,
                dailyRequestLimit,
                llmApiKeys: { ...(saved.llmApiKeys || {}) },
              };
              if (saved.llmApiKey && !next.llmApiKeys.openai)
                next.llmApiKeys.openai = saved.llmApiKey;
              delete next.llmApiKey;
              if (payload.apiKey !== undefined && payload.apiKey.trim())
                next.llmApiKeys[provider] = payload.apiKey.trim();
              if (payload.clearApiKey === true)
                delete next.llmApiKeys[provider];
              if (
                payload.telegramToken !== undefined &&
                payload.telegramToken.trim()
              )
                next.telegramToken = payload.telegramToken.trim();
              if (payload.clearTelegramToken === true)
                delete next.telegramToken;
              await secretStore.write(next);
              config.assistant = {
                provider,
                model,
                apiKey: next.llmApiKeys[provider] || "",
                spendLimitUsd,
                dailyRequestLimit,
              };
              config.telegram.token = next.telegramToken || "";
              await telegramAssistant?.setToken(config.telegram.token);
              assistant.audit("web", "owner", "assistant_settings_saved");
              send(res, 200, { ok: true, ...assistant.configView() });
            } catch (error) {
              send(res, 503, {
                ok: false,
                message:
                  error.message || "Не удалось сохранить защищённые настройки.",
              });
            }
            return;
          }
          send(res, 404, { ok: false, error: "not_found" });
          return;
        }
        if (pathname.startsWith("/api/assembly-transfers") && req.method === "GET") {
          try {
            if (!assemblyTransfer) throw Object.assign(new Error("Передача в Assembly пока не подключена к этому агенту."), { status: 503 });
            if (pathname === "/api/assembly-transfers/sources") send(res, 200, { ok: true, sources: await assemblyTransfer.sources() });
            else if (pathname === "/api/assembly-transfers/links") send(res, 200, { ok: true, links: assemblyTransfer.links() });
            else if (pathname === "/api/assembly-transfers/source") send(res, 200, { ok: true, source: await assemblyTransfer.source(url.searchParams.get("department"), Number(url.searchParams.get("sheetId"))) });
            else if (pathname === "/api/assembly-transfers/operation") {
              const operation = assemblyTransfer.operation(url.searchParams.get("id"));
              send(res, operation ? 200 : 404, { ok: !!operation, operation, message: operation ? undefined : "Передача не найдена. Повторите подтверждение с тем же номером операции." });
            } else send(res, 404, { ok: false, message: "Действие передачи не найдено." });
          } catch (error) { send(res, error.status || 503, { ok: false, message: error.message || "Не удалось прочитать источники передачи." }); }
          return;
        }
        if (["/api/assembly-transfers/preview", "/api/assembly-transfers"].includes(pathname) && req.method === "POST") {
          if (!assemblyTransfer || config.port !== 4318 || !localHost ||
              !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) ||
              !req.headers.cookie?.includes("ritm_owner=") || req.headers.authorization ||
              !["http://127.0.0.1:4318", "http://localhost:4318"].includes(origin) ||
              Object.keys(req.headers).some(header => header.startsWith("x-forwarded-") || header === "forwarded") ||
              !String(req.headers["content-type"] || "").startsWith("application/json")) {
            send(res, 403, { ok: false, message: "Передача в сборку доступна владельцу в локальном RITM." }); return;
          }
          try {
            const input = await body(req, 220000);
            if (pathname.endsWith("/preview")) send(res, 200, { ok: true, preview: await assemblyTransfer.preview(input) });
            else send(res, 202, { ok: true, operation: await assemblyTransfer.execute(input) });
          } catch (error) { send(res, error.status || 409, { ok: false, message: error.message || "Передача в сборку не выполнена." }); }
          return;
        }
        if (pathname === "/api/roll-supplies/status" && req.method === "GET") {
          assemblySync?.recoverConfirmed();
          const sheetSync = await rollSupplyService?.syncRegisteredSheets({
            refreshOnChange: true,
          });
          send(
            res,
            rollSupplyService ? 200 : 503,
            rollSupplyService
              ? { ...rollSupplyService.state(), sheetSync, production: productionSupplyService?.state() || null, assemblySync: assemblySync?.state() || null }
              : {
                  ok: false,
                  available: false,
                  reason: "Создание поставок не настроено на основном агенте.",
                },
          );
          return;
        }
        if (
          pathname === "/api/roll-supplies/operations" &&
          req.method === "GET"
        ) {
          send(
            res,
            200,
            rollSupplyService
              ? { ok: true, ...rollSupplyService.state() }
              : { ok: false, available: false, operations: [] },
          );
          return;
        }
        if (["/api/roll-supplies", "/api/roll-supplies/preview"].includes(pathname) && req.method === "POST") {
          const hasOwnerCookie = req.headers.cookie?.includes("ritm_owner=");
          if (
            !rollSupplyService ||
            config.port !== 4318 ||
            !localHost ||
            !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
              req.socket.remoteAddress,
            ) ||
            !hasOwnerCookie ||
            req.headers.authorization ||
            !origin ||
            !["http://127.0.0.1:4318", "http://localhost:4318"].includes(
              origin,
            ) ||
            Object.keys(req.headers).some(
              (header) =>
                header.startsWith("x-forwarded-") || header === "forwarded",
            ) ||
            !String(req.headers["content-type"] || "").startsWith(
              "application/json",
            )
          ) {
            send(res, 403, {
              ok: false,
              error: "roll_supply_write_forbidden",
              message:
                "Управление листами поставок доступно только владельцу в локальном AI Center.",
            });
            return;
          }
          let payload;
          try {
            payload = await body(req, 180000);
          } catch {
            send(res, 400, {
              ok: false,
              error: "invalid_request",
              message: "Не удалось прочитать состав поставки.",
            });
            return;
          }
          try {
            if (pathname.endsWith("/preview")) {
              if (!productionSupplyService) throw Object.assign(new Error("Распределение по отделам не настроено."), { status: 503 });
              send(res, 200, { ok: true, preview: await productionSupplyService.preview(payload) });
              return;
            }
            const routed = ["create", "append", "resume", "deletePart"].includes(payload?.action);
            if (routed && !productionSupplyService) throw Object.assign(new Error("Распределение по отделам не настроено. Запись остановлена."), { status: 503 });
            if (!routed && productionSupplyService?.operations().some(op => op.status !== "verified"))
              throw Object.assign(new Error("Сначала завершите загрузку общей поставки."), { status: 409 });
            if (payload?.action === "delete" && productionSupplyService?.state().supplies.some(s => s.parts.some(p => p.department === "roll" && p.sheetId === payload.sheetId)))
              throw Object.assign(new Error("Это часть общей поставки двух отделов. Отдельное удаление производственного задания запрещено."), { status: 409 });
            const operation = routed ? await productionSupplyService.execute(payload) : await rollSupplyService.execute(payload);
            try { assemblySync?.enqueue(operation); }
            catch { store.log("assembly_sync_enqueue_pending", "Уведомление будет восстановлено из подтверждённой операции", null); }
            send(res, operation.status === "uncertain" ? 202 : 200, {
              ok: true,
              operation,
            });
          } catch (error) {
            store.log(
              "roll_supply_operation_blocked",
              error.code || "roll_supply_failed",
              null,
            );
            send(res, error.status || 409, {
              ok: false,
              error: error.code || "roll_supply_failed",
              message: error.message || "Операция с поставкой не выполнена.",
            });
          }
          return;
        }
        if (
          pathname.startsWith("/api/intelligence/test-repair") ||
          pathname.startsWith("/api/intelligence/formula-repair")
        ) {
          const production = pathname.startsWith(
            "/api/intelligence/formula-repair",
          );
          const base = production
            ? "/api/intelligence/formula-repair"
            : "/api/intelligence/test-repair";
          const port = production ? 4318 : 4319;
          // Owner cookie login AND exact loopback Origin are required. Bearer-only
          // clients, proxies, cross-site requests and public origins cannot repair.
          const hasSession = req.headers.cookie?.includes("ritm_owner=");
          if (
            !repair ||
            config.port !== port ||
            !!repair.production !== production ||
            (config.publicOrigin &&
              (!production || !isTailscaleReadOrigin(config.publicOrigin))) ||
            !localHost ||
            !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
              req.socket.remoteAddress,
            ) ||
            Object.keys(req.headers).some(
              (h) => h.startsWith("x-forwarded-") || h === "forwarded",
            ) ||
            (!origin && req.method !== "GET") ||
            (origin &&
              ![
                "http://127.0.0.1:" + port,
                "http://localhost:" + port,
              ].includes(origin)) ||
            !hasSession ||
            req.headers.authorization
          ) {
            send(res, 403, {
              ok: false,
              error: "test_repair_forbidden",
              message:
                "Исправление доступно только владельцу в локальном AI Center",
            });
            return;
          }
          if (req.method === "GET" && pathname === base) {
            const incidentId = url.searchParams.get("incidentId") || "";
            if (!/^[a-f0-9]{64}$/.test(incidentId)) {
              send(res, 400, { ok: false });
              return;
            }
            send(res, 200, { ok: true, ...repair.state(incidentId) });
            return;
          }
          if (
            production &&
            repair.queueState &&
            req.method === "GET" &&
            pathname === base + "/queue"
          ) {
            send(res, 200, { ok: true, ...repair.queueState() });
            return;
          }
          if (
            production &&
            req.method === "POST" &&
            pathname === base + "/source-candidate"
          ) {
            try {
              if (!sourceRecovery)
                throw Object.assign(new Error("Восстановление не настроено."), {
                  status: 503,
                });
              if (
                !String(req.headers["content-type"] || "").startsWith(
                  "application/json",
                )
              )
                throw Object.assign(new Error("Требуется JSON."), {
                  status: 415,
                });
              const payload = await body(req, 4096);
              if (
                !payload ||
                Object.keys(payload).sort().join(",") !== "incidentId,value" ||
                !/^[a-f0-9]{64}$/.test(payload.incidentId || "")
              )
                throw Object.assign(
                  new Error("Некорректное предложение исходного значения."),
                  { status: 400 },
                );
              send(res, 200, {
                ok: true,
                ...(await sourceRecovery.proposeValue(
                  payload.incidentId,
                  payload.value,
                )),
              });
            } catch (error) {
              send(res, error.status || 409, {
                ok: false,
                error: error.code || "source_candidate_rejected",
                message: error.message,
              });
            }
            return;
          }
          if (
            production &&
            req.method === "GET" &&
            pathname === base + "/source-recovery"
          ) {
            const incidentId = url.searchParams.get("incidentId") || "";
            if (!sourceRecovery || !/^[a-f0-9]{64}$/.test(incidentId)) {
              send(res, sourceRecovery ? 400 : 503, {
                ok: false,
                error: sourceRecovery
                  ? "invalid_incident_id"
                  : "source_recovery_unavailable",
              });
              return;
            }
            send(res, 200, {
              ok: true,
              ...sourceRecovery.state(incidentId),
            });
            return;
          }
          if (
            production &&
            req.method === "POST" &&
            pathname === base + "/source-recovery"
          ) {
            if (!sourceRecovery) {
              send(res, 503, {
                ok: false,
                error: "source_recovery_unavailable",
                message: "Восстановление исходных данных не настроено.",
              });
              return;
            }
            if (
              !String(req.headers["content-type"] || "").startsWith(
                "application/json",
              )
            ) {
              send(res, 415, { ok: false, error: "json_required" });
              return;
            }
            let payload;
            try {
              payload = await body(req, 4096);
            } catch {
              send(res, 400, {
                ok: false,
                error: "invalid_request",
                message: "Некорректное подтверждение точечной записи.",
              });
              return;
            }
            if (
              !payload ||
              Object.keys(payload).some(
                (key) =>
                  ![
                    "explicitWriteApproval",
                    "incidentId",
                    "candidateVersion",
                  ].includes(key),
              ) ||
              (payload.candidateVersion !== undefined &&
                !/^[a-f0-9]{64}$/.test(payload.candidateVersion)) ||
              !/^[a-f0-9]{64}$/.test(payload.incidentId || "") ||
              payload.explicitWriteApproval !== true
            ) {
              send(res, 400, {
                ok: false,
                error: "source_write_confirmation_required",
                message:
                  "Подтвердите только точный адрес и значение из карточки инцидента.",
              });
              return;
            }
            try {
              const operation = sourceRecovery.startForIncident(
                payload.incidentId,
                payload,
              );
              send(res, 202, { ok: true, operation });
            } catch (error) {
              store.log(
                "source_recovery_blocked",
                error.code || "source_recovery_failed",
                payload.incidentId,
              );
              send(res, error.status || 409, {
                ok: false,
                error: error.code || "source_recovery_failed",
                message: error.message || "Восстановление не запущено.",
              });
            }
            return;
          }
          const confirm = pathname.match(
            new RegExp("^" + base + "/([a-f0-9-]{36})/confirm$"),
          );
          if (
            req.method === "POST" &&
            (pathname === base + "/propose" || confirm)
          ) {
            if (
              !String(req.headers["content-type"] || "").startsWith(
                "application/json",
              )
            ) {
              send(res, 415, { ok: false, error: "json_required" });
              return;
            }
            let payload;
            try {
              payload = await body(req);
            } catch {
              send(res, 400, { ok: false, message: "Некорректный запрос" });
              return;
            }
            try {
              let result;
              if (confirm) result = await repair.confirm(confirm[1], payload);
              else {
                if (
                  !payload ||
                  Object.keys(payload).some(
                    (k) =>
                      !["incidentId", "direction", "previousId"].includes(k),
                  ) ||
                  !/^[a-f0-9]{64}$/.test(payload.incidentId || "") ||
                  (payload.direction !== undefined &&
                    !["repair", "rollback"].includes(payload.direction))
                ) {
                  send(res, 400, {
                    ok: false,
                    message:
                      "Подмена адреса или неизвестные параметры запрещены",
                  });
                  return;
                }
                result = await repair.prepare(
                  payload.incidentId,
                  payload.direction || "repair",
                  payload.previousId || null,
                );
              }
              send(res, 200, result);
            } catch (e) {
              const incidentId =
                payload?.incidentId ||
                (confirm
                  ? store.db
                      .prepare(
                        "SELECT incident_id FROM test_repair_proposals WHERE id=?",
                      )
                      .get(confirm[1])?.incident_id
                  : null);
              store.log(
                "repair_blocked",
                e.code || "repair_unavailable",
                incidentId || null,
              );
              send(res, e.status || 503, {
                ok: false,
                error: e.code || "repair_unavailable",
                message: e.code
                  ? e.message
                  : "Действие не выполнено; проверьте журнал",
              });
            }
            return;
          }
          send(res, 405, { ok: false, message: "Действие не разрешено" });
          return;
        }
        if (pathname.startsWith("/api/intelligence/doctor/formulas")) {
          if (!doctor?.formulas) {
            send(res, 503, {
              ok: false,
              message: "Formula Intelligence не настроен",
            });
            return;
          }
          try {
            const region = pathname.match(
              /^\/api\/intelligence\/doctor\/formulas\/regions\/([a-f0-9]{64})$/,
            );
            if (req.method === "GET" && region) {
              const version = url.searchParams.get("version") || "";
              if (!/^[a-f0-9]{64}$/.test(version)) {
                send(res, 400, { ok: false });
                return;
              }
              send(res, 200, {
                ok: true,
                ...doctor.formulas.region(region[1], version, {
                  page: bounded(url.searchParams.get("p"), 0, 100000),
                  size: [10, 20, 50].includes(
                    Number(url.searchParams.get("limit")),
                  )
                    ? Number(url.searchParams.get("limit"))
                    : 20,
                  search: (url.searchParams.get("search") || "").slice(0, 200),
                }),
              });
              return;
            }
            if (
              req.method !== "POST" ||
              !origin ||
              !config.allowedOrigins.includes(origin) ||
              !req.headers.cookie?.includes("ritm_owner=") ||
              req.headers.authorization
            ) {
              send(res, 403, {
                ok: false,
                message:
                  "Решение доступно только владельцу в защищённом AI Center",
              });
              return;
            }
            if (
              !String(req.headers["content-type"] || "").startsWith(
                "application/json",
              )
            ) {
              send(res, 415, { ok: false });
              return;
            }
            const action = pathname.slice(
              "/api/intelligence/doctor/formulas/".length,
            );
            const payload = await body(req, 256 * 1024);
            if (doctor.current) {
              send(res, 409, {
                ok: false,
                message: "Дождитесь завершения проверки",
              });
              return;
            }
            const keys =
              action === "approve"
                ? ["regions", "acknowledged"]
                : action === "prepare"
                  ? []
                  : action === "bulk-approve"
                    ? ["previewId", "acknowledged"]
                    : action === "revoke"
                      ? ["id", "reason"]
                      : action === "exceptions"
                        ? ["incidentId", "reason", "expiresAt"]
                        : action === "exceptions/revoke"
                          ? ["id"]
                          : [];
            if (
              !payload ||
              typeof payload !== "object" ||
              Array.isArray(payload) ||
              Object.keys(payload).some((k) => !keys.includes(k))
            ) {
              send(res, 400, {
                ok: false,
                message: "Подмена адреса запрещена",
              });
              return;
            }
            let result;
            if (action === "prepare") {
              if (doctor.run) await doctor.run(signal);
              result = doctor.formulas.prepareProtection();
            } else if (action === "bulk-approve") {
              if (doctor.run) await doctor.run(signal);
              result = doctor.formulas.approveProtectionPreview(payload);
            } else if (action === "approve") {
              result = doctor.formulas.approve(payload);
            } else if (action === "revoke") {
              result = doctor.formulas.revoke(payload);
            } else if (action === "exceptions") {
              result = doctor.formulas.addException(payload);
            } else if (action === "exceptions/revoke") {
              result = doctor.formulas.revokeException(payload.id);
            }
            if (!result) {
              send(res, 404, { ok: false });
              return;
            }
            send(res, 200, result);
          } catch (e) {
            send(res, e.status || 503, {
              ok: false,
              message: e.status
                ? e.message
                : "Действие не выполнено; проверьте журнал",
            });
          }
          return;
        }
        if (
          req.method === "POST" &&
          (pathname.startsWith("/api/intelligence/doctor/rules/") ||
            pathname.startsWith("/api/intelligence/doctor/exceptions"))
        ) {
          // A cookie owner session and exact configured Origin are mandatory for decisions.
          // Approval only changes local diagnostic policy; it grants no Google write permission.
          if (
            !doctor?.governance ||
            !origin ||
            !config.allowedOrigins.includes(origin) ||
            !req.headers.cookie?.includes("ritm_owner=") ||
            req.headers.authorization
          ) {
            send(res, 403, {
              ok: false,
              message:
                "Решение доступно владельцу в защищённом AI Center после завершения проверки.",
            });
            return;
          }
          if (
            !String(req.headers["content-type"] || "").startsWith(
              "application/json",
            )
          ) {
            send(res, 415, { ok: false, message: "Требуется JSON" });
            return;
          }
          let payload;
          try {
            payload = await body(req);
          } catch {
            send(res, 400, { ok: false, message: "Некорректный запрос" });
            return;
          }
          if (doctor.current) {
            send(res, 409, {
              ok: false,
              message: "Проверка ещё выполняется; дождитесь полного снимка.",
            });
            return;
          }
          const rule = pathname.match(
            /^\/api\/intelligence\/doctor\/rules\/(fbo-sum|supply-area|catalog-sum|daily-journal)\/(approve|revoke)$/,
          );
          const revoke = pathname.match(
            /^\/api\/intelligence\/doctor\/exceptions\/([a-f0-9]{64})\/revoke$/,
          );
          const keys = rule
            ? ["version", "acknowledged"]
            : revoke
              ? []
              : ["observationId", "evidenceVersion", "reason", "expiresAt"];
          if (
            !payload ||
            typeof payload !== "object" ||
            Array.isArray(payload) ||
            Object.keys(payload).some((k) => !keys.includes(k))
          ) {
            send(res, 400, {
              ok: false,
              message: "Подмена области или неизвестные параметры запрещены.",
            });
            return;
          }
          try {
            let result;
            if (rule)
              result = doctor.governance.decide({
                ruleId: rule[1],
                decision: rule[2],
                ...payload,
              });
            else if (revoke)
              result = doctor.governance.revokeException(revoke[1]);
            else if (pathname === "/api/intelligence/doctor/exceptions")
              result = doctor.governance.addException(payload);
            else {
              send(res, 404, { ok: false, message: "Действие не найдено" });
              return;
            }
            send(res, 200, result);
          } catch (e) {
            send(res, e.status || 503, {
              ok: false,
              message: e.status
                ? e.message
                : "Решение не сохранено; проверьте журнал.",
            });
          }
          return;
        }
        if (req.method === "POST") {
          if (pathname === "/api/intelligence/incidents/bulk-action") {
            let payload;
            try {
              payload = await body(req, 16 * 1024);
            } catch {
              send(res, 400, {
                ok: false,
                message: "Некорректный список проблем.",
              });
              return;
            }
            const ids = payload?.incidentIds,
              action = payload?.action;
            if (
              !payload ||
              Object.keys(payload).sort().join(",") !== "action,incidentIds" ||
              !["ignore", "recheck"].includes(action) ||
              !Array.isArray(ids) ||
              !ids.length ||
              ids.length > 50 ||
              ids.some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
              new Set(ids).size !== ids.length
            ) {
              send(res, 400, {
                ok: false,
                message: "Выберите от 1 до 50 уникальных проблем.",
              });
              return;
            }
            const selectedIncidents = ids.map((id) => store.getIncident(id)),
              documents = new Map();
            if (
              selectedIncidents.some(
                (incident) =>
                  !incident ||
                  incident.monitorStatus !== "open" ||
                  incident.demonstration ||
                  (action === "ignore" &&
                    incident.type === "data_quality_root_cause"),
              )
            ) {
              send(res, 409, {
                ok: false,
                message:
                  action === "ignore"
                    ? "Все выбранные проблемы должны быть открытыми; первопричины качества исходных данных игнорировать нельзя."
                    : "Все выбранные проблемы должны быть открытыми реальными инцидентами.",
              });
              return;
            }
            if (action === "recheck") {
              for (const incident of selectedIncidents) {
                const document = config.doctorDocuments.find(
                  (item) =>
                    item.id === incident.sourceId &&
                    item.enabled &&
                    item.adapter === "google",
                );
                if (!doctor || !document) {
                  send(res, 409, {
                    ok: false,
                    message:
                      "Для одной из выбранных проблем нет доступной read-only проверки.",
                  });
                  return;
                }
                documents.set(document.id, document);
              }
              if (doctor.current) {
                send(res, 409, {
                  ok: false,
                  message:
                    "Проверка уже выполняется. Дождитесь её завершения и повторите массовую проверку.",
                });
                return;
              }
              const queuedSources = [...documents.keys()];
              void (async () => {
                for (const documentId of queuedSources) {
                  try {
                    const result = await doctor.runDocument(documentId, signal);
                    if (!result?.complete)
                      store.log(
                        "doctor_error",
                        "Массовая перепроверка не получила полного результата",
                      );
                  } catch {
                    store.log("doctor_error", "Ошибка массовой перепроверки");
                  }
                }
              })();
              send(res, 202, {
                ok: true,
                queued: ids.length,
                sources: queuedSources.length,
              });
              return;
            }
            const changed = store.bulkIgnoreIncidents(
              ids,
              new Date(now()).toISOString(),
            );
            if (changed === null) {
              send(res, 409, {
                ok: false,
                message:
                  "Список изменился во время операции. Обновите проблемы и повторите действие.",
              });
              return;
            }
            send(res, 200, { ok: true, changed });
            return;
          }
          const recheck = pathname.match(
            /^\/api\/intelligence\/incidents\/([a-f0-9]{64})\/recheck$/,
          );
          if (recheck) {
            const incident = store.getIncident(recheck[1]),
              document = config.doctorDocuments.find(
                (item) =>
                  item.id === incident?.sourceId &&
                  item.enabled &&
                  item.adapter === "google",
              );
            if (
              !doctor ||
              !incident ||
              incident.monitorStatus !== "open" ||
              incident.demonstration ||
              !document
            ) {
              send(res, 409, {
                ok: false,
                message:
                  "Проблему нельзя повторно проверить в текущем состоянии.",
              });
              return;
            }
            if (doctor.current) {
              send(res, 409, {
                ok: false,
                message:
                  "Проверка уже выполняется. Повторите после её завершения.",
              });
              return;
            }
            void doctor
              .runDocument(document.id, signal)
              .catch(() =>
                store.log("doctor_error", "Ошибка повторной проверки проблемы"),
              );
            send(res, 202, {
              ok: true,
              running: true,
              sourceId: document.id,
            });
            return;
          }
          const action = pathname.match(
            /^\/api\/intelligence\/incidents\/([a-f0-9]{64})\/(request-repair|ignore)$/,
          );
          if (action) {
            let requestDetails = null;
            if (
              action[2] === "request-repair" &&
              req.headers["content-type"] &&
              (Number(req.headers["content-length"] || 0) > 0 ||
                req.headers["transfer-encoding"])
            ) {
              if (
                !String(req.headers["content-type"]).startsWith(
                  "application/json",
                )
              ) {
                send(res, 415, { ok: false, message: "Ожидался JSON-запрос" });
                return;
              }
              try {
                requestDetails = await body(req, 16 * 1024);
              } catch {
                send(res, 400, {
                  ok: false,
                  message: "Некорректное подтверждение",
                });
                return;
              }
            }
            const incident = store.incidentAction(
              action[1],
              action[2],
              new Date(now()).toISOString(),
              requestDetails,
            );
            send(
              res,
              incident ? 200 : 409,
              incident
                ? { ok: true, incident }
                : {
                    ok: false,
                    message: "Инцидент недоступен для этого действия",
                  },
            );
            return;
          }
          if (pathname === "/api/intelligence/doctor/run") {
            if (!doctor) {
              send(res, 503, {
                ok: false,
                message: "Table Doctor не настроен",
              });
              return;
            }
            void doctor
              .run(signal)
              .catch(() => store.log("doctor_error", "Ошибка ручной проверки"));
            send(res, 202, { ok: true, running: true });
            return;
          }
          if (pathname === "/api/intelligence/doctor/fast") {
            if (!doctor) {
              send(res, 503, {
                ok: false,
                message: "Table Doctor не настроен",
              });
              return;
            }
            void doctor
              .runFast(signal)
              .catch(() =>
                store.log("doctor_fast_error", "Ошибка быстрой проверки"),
              );
            send(res, 202, {
              ok: true,
              running: true,
              mode: "protected_formulas",
            });
            return;
          }
          if (
            pathname === "/api/intelligence/doctor/demo" &&
            doctor &&
            config.doctorDemoEnabled
          ) {
            if (
              !String(req.headers["content-type"] || "").startsWith(
                "application/json",
              )
            ) {
              send(res, 415, { ok: false });
              return;
            }
            let payload;
            try {
              payload = await body(req);
            } catch {
              send(res, 400, { ok: false, message: "Некорректный запрос" });
              return;
            }
            if (
              ![
                "healthy",
                "missing",
                "number",
                "mismatch",
                "ref",
                "div_zero",
                "schema",
              ].includes(payload?.scenario)
            ) {
              send(res, 400, {
                ok: false,
                message: "Неизвестный демонстрационный сценарий",
              });
              return;
            }
            if (doctor.current) {
              send(res, 409, {
                ok: false,
                message: "Дождитесь завершения проверки",
              });
              return;
            }
            send(res, 200, await doctor.setDemo(payload.scenario, signal));
            return;
          }
        }
        if (req.method !== "GET") {
          send(res, 403, {
            ok: false,
            error: "read_only",
            message:
              "Изменения Google Sheets, исправления и произвольные команды отключены.",
          });
          return;
        }
        if (pathname === "/api/intelligence/doctor") {
          send(
            res,
            doctor ? 200 : 503,
            doctor
              ? {
                  ...doctor.state(),
                  testRepairEnabled: !!repair && !repair.production,
                  productionRepairEnabled: !!repair?.production,
                  repairQueue: repair?.production ? repair.queueState() : null,
                }
              : { ok: false, message: "Table Doctor не настроен" },
          );
          return;
        }
        if (pathname === "/api/intelligence/status") {
          const state = store.overview();
          const running =
            state.agent?.status === "running" &&
            now() - Date.parse(state.agent.heartbeatAt) < 90000;
          const checks = state.checks.map((c) => ({
            ...c,
            stale: now() - Date.parse(c.at) > config.snapshotMaxAgeMs,
          }));
          send(res, 200, {
            ok: true,
            schemaVersion: 1,
            fetchedAt: new Date(now()).toISOString(),
            ...state,
            agent: state.agent
              ? { ...state.agent, status: running ? "running" : "stopped" }
              : null,
            checks,
            controlledSources: config.sources.filter((s) => s.enabled).length,
            config: {
              ...publicConfig(config),
              formulaAccess:
                doctor?.state().connection ||
                publicConfig(config).formulaAccess,
            },
            notifications: store.meta("notifications") || {
              status: "not_configured",
            },
          });
          return;
        }
        if (pathname === "/api/intelligence/settings") {
          send(res, 200, {
            ok: true,
            ...publicConfig(config),
            formulaAccess:
              doctor?.state().connection || publicConfig(config).formulaAccess,
          });
          return;
        }
        if (pathname === "/api/intelligence/assistant") {
          send(
            res,
            assistant ? 200 : 503,
            assistant
              ? { ok: true, ...assistant.configView() }
              : { ok: false, message: "RITM Assistant не настроен" },
          );
          return;
        }
        const pagination = {
          page: bounded(url.searchParams.get("p"), 0, 1000000),
          limit: [10, 20, 50].includes(Number(url.searchParams.get("limit")))
            ? Number(url.searchParams.get("limit"))
            : 20,
        };
        if (pathname === "/api/intelligence/incidents/summary") {
          send(res, 200, {
            ok: true,
            ...store.incidentSummary({
              department: (url.searchParams.get("department") || "").slice(
                0,
                80,
              ),
              source: (url.searchParams.get("source") || "").slice(0, 80),
              sheet: (url.searchParams.get("sheet") || "").slice(0, 200),
              severity: (url.searchParams.get("severity") || "").slice(0, 20),
              type: (url.searchParams.get("type") || "").slice(0, 60),
              search: (url.searchParams.get("q") || "").slice(0, 120),
            }),
          });
          return;
        }
        if (pathname === "/api/intelligence/incidents") {
          send(res, 200, {
            ok: true,
            ...store.listIncidents({
              ...pagination,
              department: (url.searchParams.get("department") || "").slice(
                0,
                80,
              ),
              source: (url.searchParams.get("source") || "").slice(0, 80),
              sheet: (url.searchParams.get("sheet") || "").slice(0, 200),
              severity: (url.searchParams.get("severity") || "").slice(0, 20),
              status: (url.searchParams.get("status") || "").slice(0, 20),
              kind: (url.searchParams.get("kind") || "").slice(0, 40),
              type: (url.searchParams.get("type") || "").slice(0, 60),
              group: (url.searchParams.get("group") || "").slice(0, 40),
              includeDemonstrations: false,
              search: (url.searchParams.get("q") || "").slice(0, 120),
            }),
          });
          return;
        }
        const match = pathname.match(
          /^\/api\/intelligence\/incidents\/([a-f0-9]{64})$/,
        );
        if (match) {
          const incident = store.getIncident(match[1]);
          send(
            res,
            incident ? 200 : 404,
            incident
              ? { ok: true, incident }
              : { ok: false, error: "not_found" },
          );
          return;
        }
        if (pathname === "/api/intelligence/history") {
          send(res, 200, {
            ok: true,
            ...store.history(pagination.page, pagination.limit),
          });
          return;
        }
        if (["/api/assembly", "/api/printing"].includes(pathname)) {
          const kind = pathname.slice(5),
            source = config.sources.find(
              (s) => s.adapter === kind && s.enabled,
            );
          let refreshResult = null;
          const beforeRefresh = source ? store.getSnapshot(source.id) : null;
          if (
            kind === "assembly" && refreshAssembly &&
            (url.searchParams.get("refresh") === "1" || beforeRefresh?.value.schemaVersion !== 2)
          )
            refreshResult = await refreshAssembly();
          if (
            kind === "printing" &&
            url.searchParams.get("refresh") === "1" &&
            refreshPrinting
          )
            refreshResult = await refreshPrinting();
          const snapshot = source ? store.getSnapshot(source.id) : null;
          if (!snapshot) {
            send(res, 503, {
              ok: false,
              error: "no_verified_snapshot",
              message:
                "Нет проверенного снимка источника. Нулевой KPI не сформирован.",
            });
            return;
          }
          if (kind === "assembly" && snapshot.value.schemaVersion !== 2) {
            send(res, 503, {
              ok: false,
              error: "assembly_snapshot_upgrade_required",
              message: "Сервер RITM ещё не обновил данные сборщиков. Требуется обновление серверной версии и синхронизация источников.",
            });
            return;
          }
          const sourceCheck = store
            .overview()
            .checks.find((c) => c.id === source.id);
          const stale =
            snapshot.value.stale === true ||
            !sourceCheck ||
            ["error", "stale", "unavailable"].includes(sourceCheck.status) ||
            now() - Date.parse(snapshot.at) > config.snapshotMaxAgeMs;
          let payload = {
            ...snapshot.value,
            stale,
            snapshotAt: snapshot.at,
            sourceStatus: sourceCheck?.status || "unavailable",
            refreshFailed: refreshResult?.ok === false,
            staleReason: stale
              ? "Показан предыдущий снимок: последняя проверка источника не завершилась успешно."
              : null,
          };
          if (kind === "assembly") {
            const date =
              url.searchParams.get("date") || todayMoscow(new Date(now()));
            const period = url.searchParams.get("period") || "day";
            try {
              payload = selectAssemblyPeriod(payload, date, period);
            } catch {
              send(res, 400, { ok: false, error: "invalid_period" });
              return;
            }
          }
          send(res, 200, payload);
          return;
        }
        send(res, 404, { ok: false, error: "not_found" });
        return;
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        send(res, 405, { ok: false, error: "method_not_allowed" });
        return;
      }
      const decoded = decodeURIComponent(pathname);
      const asset = path.resolve(config.staticDir, "." + decoded);
      if (
        !asset.startsWith(config.staticDir + path.sep) &&
        asset !== config.staticDir
      ) {
        send(res, 403, { ok: false });
        return;
      }
      let file = asset,
        content;
      try {
        content = await fs.readFile(file);
      } catch {
        if (pathname.startsWith("/assets/") || path.extname(pathname)) {
          send(res, 404, { ok: false });
          return;
        }
        file = path.join(config.staticDir, "index.html");
        try {
          content = await fs.readFile(file);
        } catch {
          send(res, 503, {
            ok: false,
            error: "build_required",
            message: "Сначала выполните npm run build.",
          });
          return;
        }
      }
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      res.writeHead(200, {
        "content-type": mime[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      if (!res.headersSent)
        send(res, 500, {
          ok: false,
          error: "internal_error",
          message: "Ошибка локального сервиса. Проверьте журнал.",
        });
      else res.end();
    }
  };
  return http.createServer(handler);
}
