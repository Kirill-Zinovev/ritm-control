import { cloudApi } from "./cloud/runtime.js";
import { mcp } from "./cloud/mcp.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return mcp(request,env);
    if (url.pathname.startsWith("/api/")) return cloudApi(request, env, ctx);
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || !request.headers.get("accept")?.includes("text/html") || !["GET", "HEAD"].includes(request.method)) return response;
    url.pathname = "/index.html"; url.search = "";
    return env.ASSETS.fetch(new Request(url, request));
  },
};
