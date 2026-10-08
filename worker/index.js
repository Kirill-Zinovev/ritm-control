import { loadPrinting } from "./printing.js";
import { loadAssembly } from "./assembly.js";
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/assembly") {
      const headers = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      };
      if (request.method !== "GET")
        return new Response(
          JSON.stringify({ ok: false, error: "method_not_allowed" }),
          { status: 405, headers: { ...headers, allow: "GET" } },
        );
      try {
        const date = url.searchParams.get("date") || undefined;
        const period = url.searchParams.get("period") || undefined;
        return new Response(
          JSON.stringify(await loadAssembly(date, period)),
          { headers },
        );
      } catch (error) {
        console.error("assembly_source_error", error.message);
        return new Response(
          JSON.stringify({
            ok: false,
            error: "source_unavailable",
            message: "Таблица FBO недоступна. Проверьте подключение.",
          }),
          { status: 502, headers },
        );
      }
    }    if (url.pathname === "/api/printing") {
      const headers = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      };
      if (request.method !== "GET")
        return new Response(
          JSON.stringify({ ok: false, error: "method_not_allowed" }),
          { status: 405, headers: { ...headers, allow: "GET" } },
        );
      try {
        return new Response(JSON.stringify(await loadPrinting()), { headers });
      } catch (error) {
        console.error("printing_source_error", error.message);
        return new Response(
          JSON.stringify({
            ok: false,
            error: "source_unavailable",
            message:
              "Не удалось прочитать рабочую таблицу. Повторите обновление.",
          }),
          { status: 502, headers },
        );
      }
    }
    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");
    if (
      response.status !== 404 ||
      !acceptsHtml ||
      !["GET", "HEAD"].includes(request.method)
    )
      return response;
    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};
