import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { digest, photoAllowed } from "../shared/catalog";
import type {
  CatalogBundle,
  CatalogDetail,
  CatalogPage,
} from "../shared/catalog";
import type { Snapshot } from "../shared/model";
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
process.stdout.write(
  "Ready for catalog transfer JSON on stdin (input hidden).\n",
);
let config:
  | { url: string; token?: string; bundle: string; sourceDirectory: string }
  | undefined;
for await (const line of input) {
  if (line.trim()) {
    config = JSON.parse(line);
    break;
  }
}
input.close();
if (process.stdin.isTTY) process.stdin.setRawMode(false);
process.stdin.pause();
if (
  !config ||
  ![
    "http://127.0.0.1:5178",
    "https://assembly-v2.zinovevkirill234.chatgpt.site",
  ].includes(config.url)
)
  throw new Error("Refusing unexpected destination.");
const cfg = config;
const bundle = JSON.parse(await readFile(cfg.bundle, "utf8")) as CatalogBundle;
assert.equal(await digest(JSON.stringify(bundle.manifest)), bundle.id);
const headers = cfg.token
  ? { "OAI-Sites-Authorization": `Bearer ${cfg.token}` }
  : {};
async function request(
  path: string,
  body?: string | Uint8Array,
  binary = false,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(cfg.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...headers,
          ...(body !== undefined
            ? {
                "Content-Type": binary
                  ? "application/octet-stream"
                  : "application/json",
              }
            : {}),
        },
        body:
          typeof body === "string"
            ? body
            : body
              ? new Uint8Array(body)
              : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(45000),
      });
      if (!r.ok) {
        const value = await r.json();
        throw new Error(
          `HTTP ${r.status}: ${value.error ?? "Request rejected"}`,
        );
      }
      return r;
    } catch (e) {
      if (attempt >= 2 || String(e).includes("HTTP 4")) throw e;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}
const json = async <T>(path: string, body?: unknown) =>
  (await (
    await request(path, body === undefined ? undefined : JSON.stringify(body))
  ).json()) as T;
const before = await json<Snapshot>("/api/state");
const started = await json<{ received: string[] }>(
  "/api/catalog/import/start",
  { id: bundle.id, manifest: bundle.manifest },
);
const received = new Set(started.received);
for (const source of bundle.manifest.sources) {
  const bytes = await readFile(join(cfg.sourceDirectory, source.name));
  assert.equal(await digest(bytes), source.sha256);
  await request(
    `/api/catalog/source?import=${bundle.id}&role=${source.role}`,
    bytes,
    true,
  );
  process.stdout.write(
    JSON.stringify({
      phase: "source-saved",
      role: source.role,
      bytes: bytes.length,
    }) + "\n",
  );
}
let next = 0,
  done = 0;
const start = performance.now();
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (;;) {
      const index = next++;
      if (index >= bundle.chunks.length) return;
      const c = bundle.chunks[index];
      if (!received.has(`${c.meta.kind}:${c.meta.part}`))
        await json("/api/catalog/import/chunk", {
          id: bundle.id,
          kind: c.meta.kind,
          part: c.meta.part,
          data: c.data,
        });
      done++;
      if (done % 25 === 0 || done === bundle.chunks.length)
        process.stdout.write(
          JSON.stringify({
            phase: "chunks",
            done,
            total: bundle.chunks.length,
          }) + "\n",
        );
    }
  }),
);
await json("/api/catalog/import/activate", { id: bundle.id });
const page = await json<CatalogPage>("/api/catalog");
assert.equal(page.active?.id, bundle.id);
assert.equal(page.total, bundle.manifest.entries);
const wb = await json<CatalogPage>("/api/catalog?market=WB"),
  ozon = await json<CatalogPage>("/api/catalog?market=OZON");
const query = await json<CatalogPage>(
  "/api/catalog?market=OZON&store=1&q=SS0031.A7484(OZ)",
);
assert.equal(query.items.length, 1);
assert.equal(query.items[0].unitsPerBox, 700);
assert.equal(query.items[0].capacitySource, "user");
const detail = await json<CatalogDetail>(
  `/api/catalog/entry?import=${bundle.id}&id=${encodeURIComponent(query.items[0].id)}`,
);
assert.equal(detail.rows[0].raw.unitsPerBoxText, "550 М");
const conflicts = await json<CatalogPage>(
  "/api/catalog?market=WB&q=JB0021.A7456",
);
assert.equal(conflicts.items[0].unitsPerBox, null);
for (const source of bundle.manifest.sources) {
  const response = await request(
    `/api/catalog/source?import=${bundle.id}&role=${source.role}`,
  );
  assert.equal(
    await digest(new Uint8Array(await response.arrayBuffer())),
    source.sha256,
  );
}
const after = await json<Snapshot>("/api/state");
for (const key of [
  "supplies",
  "positions",
  "works",
  "cartons",
  "dispatches",
  "exports",
  "employees",
] as const)
  assert.deepEqual(after[key], before[key], `Catalog import altered ${key}`);
const photoEntry = page.items.find((e) => e.photoId);
let photoStatus: number | null = null;
if (photoEntry?.photoId) {
  const r = await fetch(
    cfg.url +
      `/api/catalog/photo?import=${bundle.id}&id=${encodeURIComponent(photoEntry.photoId)}`,
    { headers, redirect: "manual", signal: AbortSignal.timeout(20000) },
  );
  photoStatus = r.status;
  await r.arrayBuffer();
  if (r.status === 302) {
    const location = r.headers.get("location");
    assert.ok(location && photoAllowed(location));
    const direct = await fetch(location, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    photoStatus = direct.status;
    await direct.arrayBuffer();
  }
  assert.equal(
    photoStatus,
    200,
    "Neither cached nor approved-source photo is available",
  );
}
process.stdout.write(
  JSON.stringify({
    phase: "verified",
    id: bundle.id,
    WB: wb.total,
    OZON: ozon.total,
    sourceRows: bundle.manifest.sourceRows,
    photos: bundle.manifest.photos,
    capacityConflicts: bundle.manifest.capacityConflicts,
    userCorrections: bundle.manifest.userCorrections,
    photoStatus,
    operationalHistoryUnchanged: true,
    sourceArchivesHashVerified: true,
    milliseconds: Math.round(performance.now() - start),
  }) + "\n",
);
