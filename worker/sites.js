import { cloudApi } from "./cloud/runtime.js";
import { mcp } from "./cloud/mcp.js";
import { ritmOwnerAccount } from "./cloud/auth.js";
import { databaseBackup, databaseBackupPath } from "./database-backup.mjs";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === databaseBackupPath) {
      return databaseBackup(request, env.DB, "ritm", Boolean(ritmOwnerAccount(request, env)));
    }
    // This bot only sends production notices. Incoming events have no
    // commands or side effects; acknowledge without retaining their payload.
    if (url.pathname === "/api/bitrix-bot/events") {
      if (request.method === "POST") return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
      if (request.method === "GET") return new Response("RITM Bitrix bot event receiver", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      return new Response(null, { status: 405, headers: { allow: "GET, POST", "cache-control": "no-store" } });
    }
    if (url.pathname === "/mcp") return mcp(request,env);
    if (url.pathname.startsWith("/api/")) return cloudApi(request, env, ctx);
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || !request.headers.get("accept")?.includes("text/html") || !["GET", "HEAD"].includes(request.method)) return response;
    url.pathname = "/index.html"; url.search = "";
    return env.ASSETS.fetch(new Request(url, request));
  },
};
