// Isolated UI verification: memory-only SQLite, synthetic source reader, no Google requests.
import { createServer } from "vite";
import { createHmac } from "node:crypto";
import { IncidentStore } from "../agent/store.js";
import { AssemblySyncQueue } from "../agent/assemblySync.js";
import {
  AssemblyTransferService,
  ASSEMBLY_TRANSFER_SOURCES,
} from "../agent/assemblyTransfer.js";

const store = new IncidentStore(":memory:"),
  secret = "ab".repeat(32);
const books = Object.fromEntries(
  Object.values(ASSEMBLY_TRANSFER_SOURCES).map((source) => [source.id, []]),
);
const add = (department, sheetId, title, rows, manifest = null) =>
  books[ASSEMBLY_TRANSFER_SOURCES[department].id].push({
    properties: {
      sheetId,
      title,
      gridProperties: { rowCount: 1000, columnCount: 29 },
    },
    rows,
    manifest,
  });
add("roll", 50, "ТЕСТ · OZON существующая", [
  ["TEST-001", 120, "one"],
  ["TEST-002", 60, "two"],
  ["TEST-003", null, "three"],
]);
add("box", 70, "ТЕСТ · Бокс существующая", [
  ["BOX-001", 80, "box-one"],
  ["BOX-002", 40, "box-two"],
]);
const manifest = {
  version: 1,
  id: "RITM-SUPPLY-11111111-1111-4111-8111-111111111111",
  name: "ТЕСТ · WB общая",
  revision: "test",
  ready: true,
  parts: [
    {
      department: "roll",
      documentId: ASSEMBLY_TRANSFER_SOURCES.roll.id,
      sheetId: 51,
    },
    {
      department: "box",
      documentId: ASSEMBLY_TRANSFER_SOURCES.box.id,
      sheetId: 71,
    },
  ],
};
add("roll", 51, manifest.name, [["COMMON-ROLL", 20, "common-roll"]], manifest);
add("box", 71, manifest.name, [["COMMON-BOX", 30, "common-box"]], manifest);
let offline = false;
const reader = {
  configured: true,
  async get(id, params) {
    if (offline)
      throw new Error(
        "Тестовый источник временно недоступен. Повторите загрузку.",
      );
    if (!books[id]) throw new Error("Only synthetic books are available");
    if (!params.ranges)
      return {
        spreadsheetId: id,
        sheets: books[id].map((sheet) => ({ properties: sheet.properties })),
      };
    const effectiveValue = (value) =>
      typeof value === "number"
        ? { numberValue: value }
        : { stringValue: value ?? "" };
    const bySheet = new Map();
    for (const range of params.ranges) {
      const title = range
        .slice(1, range.lastIndexOf("'!"))
        .replaceAll("''", "'");
      const sheet = books[id].find((item) => item.properties.title === title);
      if (!sheet) throw new Error("Test sheet missing");
      if (!bySheet.has(title))
        bySheet.set(title, {
          properties: sheet.properties,
          developerMetadata: sheet.manifest
            ? [
                {
                  metadataKey: "RITM_SUPPLY",
                  metadataValue: JSON.stringify(sheet.manifest),
                },
              ]
            : [],
          data: [],
        });
      let grid;
      if (range.endsWith("E4:O4"))
        grid = {
          startRow: 3,
          startColumn: 4,
          rowData: [
            {
              values: Array.from({ length: 11 }, (_, index) => ({
                effectiveValue: effectiveValue(
                  index === 0 ? "Артикул" : index === 10 ? "Кол-во" : "",
                ),
              })),
            },
          ],
        };
      else {
        const column = range.includes("!AC")
          ? 28
          : range.includes("!O")
            ? 14
            : 4;
        grid = {
          startRow: 3,
          startColumn: column,
          rowData: [
            column === 4 ? "Артикул" : column === 14 ? "Кол-во" : "UID",
            ...sheet.rows.map(
              (row) => row[column === 4 ? 0 : column === 14 ? 1 : 2],
            ),
          ].map((value) => ({
            values: [{ effectiveValue: effectiveValue(value) }],
          })),
        };
      }
      bySheet.get(title).data.push(grid);
    }
    return { spreadsheetId: id, sheets: [...bySheet.values()] };
  },
};
const received = new Map();
const queue = new AssemblySyncQueue(store, {
  secret,
  fetchImpl: async (_, init) => {
    const { event, signature } = JSON.parse(init.body);
    if (
      signature !==
      createHmac("sha256", secret).update(JSON.stringify(event)).digest("hex")
    )
      throw new Error("Invalid test signature");
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const source = await service.readSource(
      event.transfer.department,
      event.transfer.sheetId,
    );
    if (source.fingerprint !== event.transfer.fingerprint)
      return new Response(
        JSON.stringify({
          ok: false,
          status: "conflict",
          eventId: event.eventId,
        }),
      );
    const key = source.manifest?.id || source.department + ":" + source.sheetId,
      old = received.get(key) || new Set();
    const selected = source.manifest
      ? event.transfer.parts.flatMap((part) =>
          books[ASSEMBLY_TRANSFER_SOURCES[part.department].id]
            .find((sheet) => sheet.properties.sheetId === part.sheetId)
            .rows.map((row) => part.department + ":" + row[2]),
        )
      : event.transfer.keys;
    const added = selected.filter((item) => !old.has(item)).length;
    received.set(key, new Set([...old, ...selected]));
    return new Response(
      JSON.stringify({
        ok: true,
        status: "synced",
        eventId: event.eventId,
        name: source.manifest?.name || source.name,
        added,
        existing: selected.length - added,
      }),
    );
  },
});
const service = new AssemblyTransferService(store, { reader, queue });
const fixturePlugin = {
  name: "assembly-transfer-fixture",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/__transfer-preview") {
        res.setHeader("content-type", "text/html;charset=utf-8");
        const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Передача в сборку · локальная проверка</title><body><main style="max-width:1100px;margin:60px auto;padding:24px"><h1>Передача в сборку</h1><p>Локальный предпросмотр · только тестовые товары. Рабочие таблицы не подключены.</p><div id="root"></div><div style="display:flex;gap:12px;margin-top:40px;flex-wrap:wrap"><button class="button secondary" id="change">Изменить тестовый источник</button><button class="button secondary" id="offline">Переключить доступность источника</button><span id="fixture-status" role="status"></span></div></main><script type="module">import {createElement} from 'react';import {createRoot} from 'react-dom/client';import {AssemblyTransfer} from '/src/AssemblyTransfer.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(createElement(AssemblyTransfer));for(const action of ['change','offline'])document.getElementById(action).onclick=async()=>{const r=await fetch('/__fixture/'+action,{method:'POST'});document.getElementById('fixture-status').textContent=(await r.json()).message;};</script></body></html>`;
        res.end(await server.transformIndexHtml(url.pathname, html));
        return;
      }
      if (url.pathname.startsWith("/__fixture/")) {
        if (url.pathname.endsWith("change"))
          books[ASSEMBLY_TRANSFER_SOURCES.roll.id][0].rows[0][1]++;
        else offline = !offline;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            message: offline
              ? "Тестовый источник недоступен"
              : "Тестовый источник обновлён и доступен",
          }),
        );
        return;
      }
      if (!url.pathname.startsWith("/api/assembly-transfers")) return next();
      try {
        let value;
        if (url.pathname.endsWith("/sources"))
          value = { sources: await service.sources() };
        else if (url.pathname.endsWith("/source"))
          value = {
            source: await service.source(
              url.searchParams.get("department"),
              Number(url.searchParams.get("sheetId")),
            ),
          };
        else if (url.pathname.endsWith("/operation")) {
          const operation = service.operation(url.searchParams.get("id"));
          if (!operation)
            throw Object.assign(new Error("Передача не найдена"), {
              status: 404,
            });
          value = { operation };
        } else {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          value = url.pathname.endsWith("/preview")
            ? { preview: await service.preview(body) }
            : { operation: await service.execute(body) };
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, ...value }));
      } catch (error) {
        res.statusCode = error.status || 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: false, message: error.message }));
      }
    });
  },
};
const server = await createServer({
  plugins: [fixturePlugin],
  server: { port: 5187, strictPort: true, host: "127.0.0.1" },
});
await server.listen();
console.log(
  "Synthetic transfer preview: http://127.0.0.1:5187/__transfer-preview",
);
const stop = async () => {
  await queue.stop();
  await server.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
