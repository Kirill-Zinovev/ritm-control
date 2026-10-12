import http from "node:http";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { publicConfig } from "./config.js";
import { isTailscaleReadOrigin } from "./productionRepair.js";
import { summarizeAssembly } from "../worker/assembly.js";
import { todayMoscow } from "./adapters.js";
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
    signal,
  } = {},
) {
  if (config.ownerToken.length < 32)
    throw new Error(
      "RITM_OWNER_TOKEN must contain at least 32 characters; configure the owner before starting the API",
    );
  const sessions = new Map(),
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
  function authenticated(req) {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer && equal(bearer, config.ownerToken)) return true;
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
      const origin = req.headers.origin;
      const localHost = [
        "127.0.0.1:" + req.socket.localPort,
        "localhost:" + req.socket.localPort,
      ].includes(req.headers.host);
      if (
        (!hosts.has(req.headers.host) && !localHost) ||
        (origin && !config.allowedOrigins.includes(origin)) ||
        req.headers["sec-fetch-site"] === "cross-site"
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
              Object.keys(payload).sort().join(",") !==
                "explicitWriteApproval,incidentId" ||
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
                message: "Проблему нельзя повторно проверить в текущем состоянии.",
              });
              return;
            }
            if (doctor.current) {
              send(res, 409, {
                ok: false,
                message: "Проверка уже выполняется. Повторите после её завершения.",
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
        const pagination = {
          page: bounded(url.searchParams.get("p"), 0, 1000000),
          limit: [10, 20, 50].includes(Number(url.searchParams.get("limit")))
            ? Number(url.searchParams.get("limit"))
            : 20,
        };
        if (pathname === "/api/intelligence/incidents/summary") {
          send(res, 200, { ok: true, ...store.incidentSummary() });
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
          const sourceCheck = store
            .overview()
            .checks.find((c) => c.id === source.id);
          const stale =
            !sourceCheck ||
            sourceCheck.status !== "ok" ||
            now() - Date.parse(snapshot.at) > config.snapshotMaxAgeMs;
          const payload = {
            ...snapshot.value,
            stale,
            snapshotAt: snapshot.at,
            staleReason: stale
              ? "Показан предыдущий проверенный снимок; источник или свежесть требуют проверки."
              : null,
          };
          if (kind === "assembly") {
            const date =
              url.searchParams.get("date") || todayMoscow(new Date(now()));
            const period = url.searchParams.get("period") || "day";
            try {
              payload.rows = summarizeAssembly(payload.history, date, period);
              payload.date = date;
              payload.period = period;
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
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
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
