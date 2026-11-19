import { api, json } from "./api";
import { createDatabase, camelRows } from "./database";
import { catalogApi, type FileStore } from "./catalog-api";
import { ritmApi, ritmConfigured, type RitmEnv } from "./ritm-api";
import { drainWorkOutbox } from "./ritm-outbox";
import { accessApi, authenticate, sameOrigin, type AccessEnv } from "./access";
import { readRitmWarehousePage } from "./ritm-warehouse";
import { labelsApi } from "./labels-api";
interface Prepared {
  bind(...values: (string | number | null)[]): Prepared;
  all(): Promise<{ results: Record<string, unknown>[] }>;
}
interface D1 {
  prepare(sql: string): Prepared;
  batch(
    statements: Prepared[],
  ): Promise<{ results: Record<string, unknown>[] }[]>;
  withSession?(constraint: string): D1;
}
export interface Env extends RitmEnv, AccessEnv {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  DB?: D1;
  BUCKET?: {
    get(key: string): Promise<{
      body: ReadableStream;
      httpMetadata?: { contentType?: string };
    } | null>;
    put(
      key: string,
      value: Uint8Array,
      options: { httpMetadata: { contentType: string } },
    ): Promise<unknown>;
  };
}
function accessStore(binding:D1) {
      const session = binding.withSession?.("first-primary") ?? binding;
      const store = {
        async readBatch(statements: import("./database").Statement[]) {
          const results = await session.batch(
            statements.map((s) => session.prepare(s.sql).bind(...s.args)),
          );
          return results.map((r) =>
            camelRows<Record<string, unknown>>(r.results),
          );
        },
        async all<T>(sql: string, args: (string | number | null)[] = []) {
          return camelRows<T>(
            (
              await session
                .prepare(sql)
                .bind(...args)
                .all()
            ).results,
          );
        },
        async batch(statements: import("./database").Statement[]) {
          await session.batch(
            statements.map((s) => session.prepare(s.sql).bind(...s.args)),
          );
        },
      };
  return store;
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    const url = new URL(request.url);
    const store=env.DB ? accessStore(env.DB) : undefined;
    if (url.pathname.startsWith("/api/access")) return accessApi(request,env,store);
    if (url.pathname === "/api/config")
      return json({
        environment: "production",
        database: env.DB
          ? "Cloudflare D1 — отдельная база"
          : "База не подключена",
        integration: ritmConfigured(env),
      });
    if (url.pathname.startsWith("/api/")) {
      if (!["GET","HEAD"].includes(request.method) && !sameOrigin(request))
        return json({error:"Недопустимый источник запроса."},403);
      const principal=await authenticate(request,env,Date.now(),store);
      if (!principal) return json({error:"Откройте рабочую ссылку, полученную от руководителя.",code:"ACCESS_REQUIRED"},401);
      if (!store)
        return json(
          {
            error:
              "Отдельная база пока не подключена. Рабочий Assembly продолжает работать по старому адресу.",
          },
          503,
        );
      const actor = principal.actor;
      const db = createDatabase(store);
      if (principal.role==="service") {
        try {
          await store.batch([{sql:"delete from av2_service_nonces where seen_at<?",args:[Date.now()-300000]},{sql:"insert into av2_service_nonces(id,seen_at) values(?,?)",args:[principal.nonce!,Date.now()]}]);
        } catch { return json({error:"Повтор служебного запроса отклонён."},409); }
      }
      if (url.pathname === "/api/legacy/backup") {
        if (principal.role!=="owner") return json({error:"Резервные копии доступны владельцу."},403);
        if (!["GET", "PUT"].includes(request.method) || !env.BUCKET)
          return json(
            { error: "Недоступный метод резервного копирования." },
            405,
          );
        if (
          request.headers.get("origin") &&
          request.headers.get("origin") !== url.origin
        )
          return json({ error: "Недопустимый источник запроса." }, 403);
        const hash = url.searchParams.get("sha256") || "";
        if (!/^[a-f0-9]{64}$/.test(hash))
          return json({ error: "Укажите контрольную сумму." }, 400);
        if (request.method === "GET") {
          const object = await env.BUCKET.get(`legacy-backups/${hash}`);
          return object
            ? new Response(object.body, {
                headers: {
                  "content-type": "application/octet-stream",
                  "cache-control": "no-store",
                },
              })
            : json({ error: "Копия не найдена." }, 404);
        }
        const data = new Uint8Array(await request.arrayBuffer());
        if (data.byteLength > 8_000_000)
          return json({ error: "Слишком большой файл." }, 413);
        const actual = [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
        ]
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
        if (actual !== hash)
          return json({ error: "Контрольная сумма не совпала." }, 409);
        await env.BUCKET.put(`legacy-backups/${hash}`, data, {
          httpMetadata: { contentType: "application/octet-stream" },
        });
        return json({ ok: true, sha256: hash, bytes: data.byteLength });
      }
      if (url.pathname.startsWith("/api/ritm/")) {
        if (["collector","manager"].includes(principal.role) && !["/api/ritm/status","/api/ritm/sync"].includes(url.pathname)) return json({error:"Операция доступна руководителю."},403);
        if (url.pathname==="/api/ritm/warehouse" && request.method==="GET") {
          try { return json(await readRitmWarehousePage(store,url)); }
          catch(e){return json({error:e instanceof Error?e.message:"Не удалось прочитать короба."},409);}
        }
        if (url.pathname==="/api/ritm/warehouse/dispatch" && request.method==="POST") {
          try {
            const raw=await request.text();
            if(raw.length>210000)return json({error:"Слишком большой запрос."},413);
            const {key,...payload}=JSON.parse(raw);
            if(typeof key!=="string")return json({error:"Не указан ключ операции."},400);
            const result=await db.command("ritm.carton.dispatch",payload,key,actor);
            return json({ok:true,dispatch:result});
          } catch(e){return json({error:e instanceof Error?e.message:"Статус не подтверждён."},409);}
        }
        return ritmApi(request, store, db, actor, env);
      }
      if (url.pathname.startsWith("/api/catalog") || url.pathname.startsWith("/api/labels")) {
        const isLabels = url.pathname.startsWith("/api/labels");
        if (!isLabels && !["owner","manager"].includes(principal.role) && !(principal.role==="collector" && request.method==="GET" && ["/api/catalog","/api/catalog/entry","/api/catalog/photo","/api/catalog/media"].includes(url.pathname))) return json({error:"Изменение справочника доступно владельцу."},403);
        const bucket = env.BUCKET;
        const files: FileStore | undefined = bucket
          ? {
              async get(key) {
                const object = await bucket.get(key);
                return object
                  ? {
                      body: object.body,
                      contentType:
                        object.httpMetadata?.contentType ??
                        "application/octet-stream",
                    }
                  : null;
              },
              async put(key, body, contentType) {
                await bucket.put(key, body, { httpMetadata: { contentType } });
              },
            }
          : undefined;
        return isLabels
          ? labelsApi(request, store, files, principal.role, actor)
          : catalogApi(request, store, db, actor, files);
      }
      if (principal.role==="service") return json({error:"Служебный маршрут не разрешён."},403);
      const response = await api(request, db, actor, principal.role);
      if (
        ctx?.waitUntil &&
        (url.pathname === "/api/command" || url.pathname === "/api/revision")
      )
        ctx.waitUntil(drainWorkOutbox(store, env));
      return response;
    }
    return env.ASSETS
      ? env.ASSETS.fetch(request)
      : new Response("Assembly", { status: 404 });
  },
};
