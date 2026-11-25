import { json } from "./api";
import { digest } from "../shared/catalog";
import type { SqlStore } from "./database";
import { authenticateManager, managerAccessApi } from "./manager-access";
export interface AccessEnv {
  AV2_OWNER_USER_ID?: string;
  AV2_OWNER_API_TOKEN?: string;
  AV2_COLLECTOR_ACCESS_HASH?: string;
  AV2_COLLECTOR_ACCESS_TOKEN?: string;
  AV2_SESSION_SECRET?: string;
  RITM_ASSEMBLY_V2_FEED_SECRET?: string;
}
export type Principal = {
  role: "owner" | "manager" | "collector" | "service";
  actor: string;
  nonce?: string;
};
const cookieName = "__Host-av2-workplace";
const duration = 180 * 24 * 60 * 60;
const encoder = new TextEncoder();
const signedRoutes = new Map([
  ["/api/ritm/sync", "POST"],
  ["/api/ritm/deliver", "POST"],
  ["/api/ritm/remove-manual-item", "POST"],
  ["/api/ritm/retire-shipments", "POST"],
  ["/api/ritm/production-catalog", "POST"],
  ["/api/ritm/production-extensions", "POST"],
  ["/api/ritm/warehouse", "GET"],
  ["/api/ritm/work-report", "GET"],
  ["/api/ritm/warehouse/dispatch", "POST"],
]);
function equal(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [
    ...new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return (
    request.headers.get("sec-fetch-site") !== "cross-site" &&
    (!origin || origin === new URL(request.url).origin)
  );
}
export function assemblyOwnerAccount(request: Request, env: AccessEnv): string | null {
  const user = request.headers.get("oai-authenticated-user-id");
  return env.AV2_OWNER_USER_ID && user === env.AV2_OWNER_USER_ID ? user : null;
}
export async function authenticate(
  request: Request,
  env: AccessEnv,
  now = Date.now(),
  store?: SqlStore,
): Promise<Principal | null> {
  const user = assemblyOwnerAccount(request, env);
  if (user)
    return { role: "owner", actor: user };
  const admin = request.headers.get("x-assembly-admin-token") || "";
  if (env.AV2_OWNER_API_TOKEN && equal(admin, env.AV2_OWNER_API_TOKEN))
    return { role: "owner", actor: "owner-service" };
  const url = new URL(request.url),
    at = request.headers.get("x-assembly-v2-at") || "",
    nonce = request.headers.get("x-assembly-v2-nonce") || "",
    signature = request.headers.get("x-assembly-v2-signature") || "";
  if (
    signedRoutes.get(url.pathname) === request.method &&
    /^[a-f0-9]{64}$/.test(env.RITM_ASSEMBLY_V2_FEED_SECRET || "") &&
    /^\d{13}$/.test(at) &&
    Math.abs(now - Number(at)) <= 120000 &&
    /^[a-f0-9-]{36}$/i.test(nonce) &&
    /^[a-f0-9]{64}$/.test(signature)
  ) {
    const body = request.method === "GET" ? "" : await request.clone().text();
    if (body.length <= 2_000_000) {
      const expected = await hmac(
        env.RITM_ASSEMBLY_V2_FEED_SECRET!,
        JSON.stringify([
          1,
          request.method,
          url.pathname + url.search,
          at,
          nonce,
          await digest(body),
        ]),
      );
      if (equal(signature, expected))
        return { role: "service", actor: "ritm-service", nonce };
    }
  }
  if(store){const manager=await authenticateManager(request,env,store,now);if(manager)return manager;}
  if (!env.AV2_SESSION_SECRET || !env.AV2_COLLECTOR_ACCESS_HASH) return null;
  const cookie =
    (request.headers.get("cookie") || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1) || "";
  const [version, expires, device, mac, ...rest] = cookie.split(".");
  if (
    rest.length ||
    version !== "1" ||
    !/^\d{10}$/.test(expires || "") ||
    Number(expires) <= Math.floor(now / 1000) ||
    Number(expires) > Math.floor(now / 1000) + duration + 60 ||
    !/^[a-f0-9-]{36}$/i.test(device || "") ||
    !/^[a-f0-9]{64}$/.test(mac || "")
  )
    return null;
  const expected = await hmac(
    env.AV2_SESSION_SECRET,
    [version, expires, device, env.AV2_COLLECTOR_ACCESS_HASH].join("."),
  );
  return equal(mac, expected)
    ? { role: "collector", actor: "workplace:" + device }
    : null;
}
export async function accessApi(
  request: Request,
  env: AccessEnv,
  store?: SqlStore,
): Promise<Response> {
  const url = new URL(request.url);
  if(url.pathname.startsWith('/api/access/manager/'))return store ? managerAccessApi(request,env,store) : json({error:'База доступа недоступна.'},503);
  if (request.method === "GET" && url.pathname === "/api/access") {
    const p = await authenticate(request, env, Date.now(), store);
    return json({ role: p?.role || null });
  }
  if (request.method === "GET" && url.pathname === "/api/access/link") {
    const principal = await authenticate(request, env);
    if (principal?.role !== "owner")
      return json({ error: "Рабочая ссылка доступна владельцу." }, 403);
    if (
      !/^[a-f0-9]{64}$/.test(env.AV2_COLLECTOR_ACCESS_TOKEN || "") ||
      (await digest(env.AV2_COLLECTOR_ACCESS_TOKEN!)) !==
        env.AV2_COLLECTOR_ACCESS_HASH
    )
      return json({ error: "Рабочая ссылка ещё не настроена." }, 503);
    return json({
      url: url.origin + "/#access=" + env.AV2_COLLECTOR_ACCESS_TOKEN,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/access/collector") {
    if (!sameOrigin(request))
      return json({ error: "Недопустимый источник запроса." }, 403);
    if (
      !env.AV2_SESSION_SECRET ||
      !/^[a-f0-9]{64}$/.test(env.AV2_COLLECTOR_ACCESS_HASH || "")
    )
      return json({ error: "Рабочая ссылка ещё не настроена." }, 503);
    const raw = await request.text();
    if (raw.length > 300)
      return json({ error: "Неверная рабочая ссылка." }, 400);
    let token = "";
    try {
      token = JSON.parse(raw).token;
    } catch {
      /* Invalid links grant no session. */
    }
    if (
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !equal(await digest(token), env.AV2_COLLECTOR_ACCESS_HASH!)
    )
      return json(
        {
          error:
            "Рабочая ссылка недействительна. Откройте ссылку, полученную от руководителя.",
        },
        403,
      );
    const device = crypto.randomUUID(),
      expires = String(Math.floor(Date.now() / 1000) + duration),
      prefix = `1.${expires}.${device}`;
    const mac = await hmac(
      env.AV2_SESSION_SECRET,
      prefix + "." + env.AV2_COLLECTOR_ACCESS_HASH,
    );
    const response = json({ role: "collector" });
    response.headers.set(
      "set-cookie",
      `${cookieName}=${prefix}.${mac}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${duration}`,
    );
    return response;
  }
  return json({ error: "Страница не найдена." }, 404);
}
export const collectorActions = new Set([
  "work.save",
  "work.cancel",
  "allocation.add",
  "allocation.place",
  "allocation.remove",
  "carton.merge",
  "carton.close",
  "warehouse.receive",
  "warehouse.transfer",
  "warehouse.create",
  "warehouse.close",
  "warehouse.remove",
  "warehouse.reopen",
  "warehouse.move",
]);
export const managerActions=new Set([...collectorActions,'catalog.save','catalog.applyWorkNorms','catalog.activate','photo.assign','carton.create','carton.reopen','dispatch.create','dispatch.cancel','dispatch.send','export.create','ozon.prepare','ozon.assign','wb.prepare','wb.assign','wb.generate']);
