import assert from "node:assert/strict";
import test from "node:test";
import worker from "../server/worker";
import { r2BackupPath, type R2BackupEntry } from "../server/r2-backup";

const origin = "https://assembly.test";
const owner = { "oai-authenticated-user-id": "test-owner" };
const uploaded = new Date("2026-11-26T00:00:00.000Z");
const rows: R2BackupEntry[] = [
  { key: "catalog/фото.webp", size: 3, etag: "one", version: "01", uploaded },
  { key: "labels/этикетка.pdf", size: 0, etag: "two", version: "02", uploaded },
];

function fixture() {
  const calls: string[] = [];
  const env = {
    AV2_OWNER_USER_ID: "test-owner",
    AV2_OWNER_API_TOKEN: "test-admin",
    BUCKET: {
      async list({ cursor }: { cursor?: string }) {
        calls.push("list");
        if (cursor) return { objects: rows.slice(1), truncated: false };
        return { objects: rows.slice(0, 1), truncated: true, cursor: "next-page" };
      },
      async get(key: string) {
        calls.push("get");
        const row = rows.find((item) => item.key === key);
        if (!row) return null;
        const data = new Uint8Array(row.size);
        data.set(new Uint8Array([1, 2, 255]).slice(0, row.size));
        return {
          ...row,
          body: new Response(data).body!,
          httpMetadata: { contentType: key.endsWith(".webp") ? "image/webp" : "application/pdf" },
          customMetadata: { origin: "fixture" },
        };
      },
      async put() { assert.fail("a backup must never write to R2"); },
    },
  };
  function fetch(query = "", init: RequestInit = { headers: owner }) {
    return worker.fetch(new Request(origin + r2BackupPath + query, init), env);
  }
  return { fetch, env, calls };
}

function links(html: string) {
  return [...html.matchAll(/href="(\?[^"]+)"/g)].map((match) => match[1].replaceAll("&amp;", "&"));
}

function files(tar: Buffer) {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (tar[offset]) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, header.indexOf(0)).toString();
    const size = Number.parseInt(header.subarray(124, 136).toString().trim(), 8);
    const checksum = Number.parseInt(header.subarray(148, 156).toString(), 8);
    const bytes = Buffer.from(header);
    bytes.fill(32, 148, 156);
    assert.equal(checksum, bytes.reduce((sum, byte) => sum + byte, 0));
    const body = tar.subarray(offset + 512, offset + 512 + size);
    assert.equal(body.length, size);
    entries.set(name, body);
    offset += (1 + Math.ceil(size / 512)) * 512;
  }
  assert.equal(tar.length - offset, 1024);
  assert.ok(tar.subarray(offset).every((value) => value === 0));
  return entries;
}

test("R2 export is owner-only and read-only", async () => {
  const { fetch, calls } = fixture();
  const nonOwners: HeadersInit[] = [{}, { "oai-authenticated-user-id": "collector" }, { "x-assembly-admin-token": "test-admin" }];
  for (const headers of nonOwners) {
    assert.equal((await fetch("?download=inventory", { headers })).status, 403);
  }
  assert.equal((await fetch("?download=inventory", { headers: { ...owner, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch("", { headers: owner, method: "POST" })).status, 405);
  assert.equal((await fetch("", { headers: owner, method: "HEAD" })).status, 204);
  assert.deepEqual(calls, []);
});

test("R2 inventory traverses every page and records completion and total bytes", async () => {
  const { fetch, calls } = fixture();
  const response = await fetch("?download=inventory");
  assert.match(response.headers.get("content-disposition")!, /^attachment;/);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].format, "RITM-R2-INVENTORY-1");
  assert.deepEqual(lines.slice(1, -1).map((row) => row.key), rows.map((row) => row.key));
  assert.deepEqual(lines.at(-1), { complete: true, bytes: 3, count: 2 });
  assert.deepEqual(calls, ["list", "list"]);
});

test("R2 tar exactly preserves bytes and original keys, including empty objects", async () => {
  const { fetch } = fixture();
  const [part1, next] = links(await (await fetch()).text());
  const [part2] = links(await (await fetch(next)).text());
  for (const [index, query] of [part1, part2].entries()) {
    const response = await fetch(query);
    assert.equal(response.status, 200);
    const entries = files(Buffer.from(await response.arrayBuffer()));
    const object = entries.get("objects/000001")!;
    const manifest = JSON.parse(entries.get("r2-manifest.json")!.toString());
    assert.equal(manifest.part, index + 1);
    assert.equal(manifest.more, index === 0);
    assert.equal(manifest.objects[0].key, rows[index].key);
    assert.equal(manifest.objects[0].size, object.length);
    assert.equal(manifest.objects[0].customMetadata.origin, "fixture");
    assert.deepEqual([...object], index === 0 ? [1, 2, 255] : []);
  }
  assert.equal((await fetch("?part=1&download=tar&check=outdated")).status, 409);
});

test("R2 tar stream fails if a listed object changes before it can be downloaded", async (context) => {
  const { fetch, env } = fixture();
  const get = env.BUCKET.get;
  env.BUCKET.get = async (key) => {
    const object = await get(key);
    return object && { ...object, version: "new-version" };
  };
  context.mock.method(console, "error", () => {});
  const [part] = links(await (await fetch()).text());
  const response = await fetch(part);
  await assert.rejects(response.arrayBuffer(), /Выгрузка R2 не завершена/);
});
