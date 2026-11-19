import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer as createViteServer } from "vite";
import { openDatabase } from "./local-db";
import { api } from "./api";
import { catalogApi } from "./catalog-api";
import { localFiles } from "./local-files";
import { ritmApi, ritmConfigured } from "./ritm-api";
import { labelsApi } from "./labels-api";
import { accessApi } from "./access";
await mkdir(".local", { recursive: true });
const db = await openDatabase(".local/assembly-preview.sqlite");
const files = localFiles(".local/files");
const localAccessEnv={AV2_OWNER_USER_ID:'local-preview-owner',AV2_SESSION_SECRET:crypto.randomUUID()};
const ritmEnv = {
  RITM_ASSEMBLY_V2_FEED_SECRET: process.env.RITM_ASSEMBLY_V2_FEED_SECRET,
  RITM_ASSEMBLY_V2_FEED_URL: process.env.RITM_ASSEMBLY_V2_FEED_URL,
};
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "spa",
});
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/api/")) return vite.middlewares(req, res);
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
    if (
      chunks.reduce((n, x) => n + x.length, 0) >
      (req.url.startsWith("/api/catalog/media") ? 8 * 1024 * 1024 : req.url.startsWith("/api/catalog/source") ? 12_000_000 : req.url.startsWith("/api/labels/file") ? 2 * 1024 * 1024 : 2_000_000)
    ) {
      res.writeHead(413);
      res.end();
      return;
    }
  }
  const request = new Request(`http://127.0.0.1:5178${req.url}`, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: req.method === "GET" ? undefined : Buffer.concat(chunks),
  });
  const response =
    req.url.startsWith('/api/access/manager/')
      ? await accessApi(new Request(request,{headers:{...Object.fromEntries(request.headers),'oai-authenticated-user-id':'local-preview-owner'}}),localAccessEnv,db.store)
      : req.url === "/api/access"
      ? new Response(JSON.stringify({role:"owner"}),{headers:{"content-type":"application/json"}})
      : req.url === "/api/config"
      ? new Response(
          JSON.stringify({
            environment: "local",
            database: "SQLite — локальная отдельная база",
            integration: ritmConfigured(ritmEnv),
          }),
        )
      : req.url.startsWith("/api/ritm/")
        ? await ritmApi(request, db.store, db, "local-owner", ritmEnv)
        : req.url.startsWith("/api/labels")
          ? await labelsApi(request, db.store, files, "owner", "local-owner")
        : req.url.startsWith("/api/catalog")
          ? await catalogApi(request, db.store, db, "local-owner", files)
          : await api(request, db, "local-owner");
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(new Uint8Array(await response.arrayBuffer()));
});
server.listen(5178, "127.0.0.1", () =>
  process.stdout.write(
    "Assembly v2: http://127.0.0.1:5178 — отдельная локальная база\n",
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await vite.close();
    db.sqlite.close();
    server.close();
    process.exit(0);
  });
