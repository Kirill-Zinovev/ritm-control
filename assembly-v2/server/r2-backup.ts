export const r2BackupPath = "/owner/r2-backup";

export interface R2BackupEntry {
  key: string;
  size: number;
  etag: string;
  version: string;
  uploaded: Date;
  storageClass?: string;
}

interface R2BackupObject extends Partial<R2BackupEntry> {
  body: ReadableStream<Uint8Array>;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  checksums?: { md5?: ArrayBuffer; sha256?: ArrayBuffer };
}

export interface R2BackupBucket {
  list?(options: { limit: number; cursor?: string }): Promise<{
    objects: R2BackupEntry[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<R2BackupObject | null>;
}

const encoder = new TextEncoder();
const pageSize = 850;
const readsInFlight = 6;
const privateHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function page(message: string, actions = "", status = 200, script = "") {
  return new Response(
    '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Резервная копия R2</title><style>body{font:16px system-ui,sans-serif;max-width:680px;margin:10vh auto;padding:0 22px;color:#132742}nav{display:flex;gap:16px;flex-wrap:wrap}a{color:#174b9b}button{font:inherit;padding:8px 12px;margin-top:22px}</style>' +
    script + '</head>' +
    '<body><main><h1>Резервная копия R2</h1><p>' + message + "</p>" + actions + "</main></body></html>",
    { status, headers: { ...privateHeaders, "content-type": "text/html; charset=utf-8" } },
  );
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function identity(row: R2BackupEntry) {
  if (!row.key || !Number.isSafeInteger(row.size) || row.size < 0 || !row.etag ||
      !row.version || !(row.uploaded instanceof Date) || !Number.isFinite(row.uploaded.getTime())) {
    throw new Error("Invalid R2 object metadata");
  }
  return { key: row.key, size: row.size, etag: row.etag, version: row.version, uploaded: row.uploaded.toISOString() };
}

function continuation(result: { truncated: boolean; cursor?: string }, prior?: string) {
  if (!result.truncated) return undefined;
  if (!result.cursor || result.cursor === prior) throw new Error("R2 pagination stopped");
  return result.cursor;
}

async function digest(rows: ReturnType<typeof identity>[]) {
  const record = encoder.encode(JSON.stringify(rows));
  return hex(await crypto.subtle.digest("SHA-256", record));
}

function tarHeader(name: string, size: number, updated: string) {
  const output = new Uint8Array(512);
  const write = (text: string, start: number) => output.set(encoder.encode(text), start);
  const octal = (value: number, start: number, width: number) => {
    const chars = value.toString(8);
    if (chars.length < width) {
      write(chars.padStart(width - 1, "0") + "\0", start);
      return;
    }
    // POSIX header extension used by GNU tar and libarchive for large members.
    let number = BigInt(value);
    for (let i = start + width - 1; i >= start; i--) {
      output[i] = Number(number & 255n);
      number >>= 8n;
    }
    output[start] |= 128;
  };
  write(name, 0);
  octal(0o600, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(Math.max(0, Math.floor(Date.parse(updated) / 1000)), 136, 12);
  output.fill(32, 148, 156);
  write("0", 156);
  write("ustar\0", 257);
  write("00", 263);
  const sum = output.reduce((total, byte) => total + byte, 0);
  write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return output;
}

function padding(size: number) {
  return (512 - (size % 512)) % 512;
}

type PendingObject = { object: R2BackupObject | null; failed: boolean };

async function* getObjects(bucket: R2BackupBucket, rows: ReturnType<typeof identity>[]) {
  const pending = new Map<number, Promise<PendingObject>>();
  const enqueue = (index: number) => {
    if (index < rows.length) {
      pending.set(index, bucket.get(rows[index].key).then(
        (object) => ({ object, failed: false }),
        () => ({ object: null, failed: true }),
      ));
    }
  };
  for (let index = 0; index < readsInFlight; index++) enqueue(index);
  try {
    for (const [index, saved] of rows.entries()) {
      const { object, failed } = await pending.get(index)!;
      pending.delete(index);
      enqueue(index + readsInFlight);
      if (failed) throw new Error("R2 object could not be read");
      yield { index, saved, object };
    }
  } finally {
    await Promise.allSettled([...pending.values()].map(async (result) => {
      const { object } = await result;
      await object?.body.cancel();
    }));
  }
}

async function* tarArchive(bucket: R2BackupBucket, rows: ReturnType<typeof identity>[], part: number, now: string, pageDigest: string, more: boolean) {
  const objects = [];
  for await (const { index, saved, object } of getObjects(bucket, rows)) {
    if (!object?.body || object.key !== saved.key || object.size !== saved.size ||
        object.etag !== saved.etag || object.version !== saved.version) {
      await object?.body?.cancel().catch(() => {});
      throw new Error("R2 object changed during download");
    }
    const path = "objects/" + String(index + 1).padStart(6, "0");
    let bytes = 0;
    const reader = object.body.getReader();
    try {
      yield tarHeader(path, saved.size, saved.uploaded);
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > saved.size) throw new Error("R2 object is larger than listed");
        yield chunk.value;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (bytes !== saved.size) throw new Error("R2 object is truncated");
    if (padding(bytes)) yield new Uint8Array(padding(bytes));
    objects.push({
      ...saved, path, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata,
      storageClass: object.storageClass,
      md5: object.checksums?.md5 ? hex(object.checksums.md5) : undefined,
      sha256: object.checksums?.sha256 ? hex(object.checksums.sha256) : undefined,
    });
  }
  const manifest = encoder.encode(JSON.stringify({ format: "RITM-R2-TAR-1", capturedAt: now, part, pageDigest, more, objects }) + "\n");
  yield tarHeader("r2-manifest.json", manifest.length, now);
  yield manifest;
  yield new Uint8Array(padding(manifest.length) + 1024);
}

async function* inventory(list: NonNullable<R2BackupBucket["list"]>, now: string) {
  yield encoder.encode(JSON.stringify({ format: "RITM-R2-INVENTORY-1", capturedAt: now }) + "\n");
  const seen = new Set<string>();
  let cursor: string | undefined;
  let count = 0;
  let bytes = 0;
  do {
    const result = await list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of result.objects) {
      const entry = identity(object);
      count++;
      bytes += entry.size;
      yield encoder.encode(JSON.stringify(entry) + "\n");
    }
    cursor = continuation(result, cursor);
    if (cursor) {
      if (seen.has(cursor)) throw new Error("R2 pagination repeated a cursor");
      seen.add(cursor);
    }
  } while (cursor);
  yield encoder.encode(JSON.stringify({ complete: true, count, bytes }) + "\n");
}

function download(data: AsyncGenerator<Uint8Array>, type: string, name: string) {
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await data.next();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        console.error("R2 backup download failed", error instanceof Error ? error.name : "error");
        controller.error(new Error("Выгрузка R2 не завершена."));
      }
    },
    async cancel() { await data.return(undefined); },
  }), {
    headers: { ...privateHeaders, "content-type": type, "content-disposition": 'attachment; filename="' + name + '"' },
  });
}

function href(query: Record<string, string>) {
  return "?" + new URLSearchParams(query).toString().replaceAll("&", "&amp;");
}

export async function r2Backup(request: Request, bucket: R2BackupBucket | undefined, owner: boolean) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { ...privateHeaders, allow: "GET, HEAD" } });
  }
  if (!owner) {
    const login = request.headers.get("oai-authenticated-user-id") ? "" :
      '<a href="/signin-with-chatgpt?return_to=%2Fowner%2Fr2-backup" target="_top">Войти через ChatGPT</a>';
    return page("Выгрузка доступна владельцу сайта.", login, 403);
  }
  if (!bucket?.list) return page("Хранилище R2 недоступно.", "", 503);
  if (request.method === "HEAD") return new Response(null, { status: 204, headers: privateHeaders });

  const query = new URL(request.url).searchParams;
  const format = query.get("download");
  if (format && request.headers.get("sec-fetch-site") === "cross-site") return page("Откройте выгрузку со страницы резервной копии.", "", 403);
  const now = new Date().toISOString();
  const timestamp = now.replace(/[:.]/g, "-");
  if (format === "inventory") return download(inventory(bucket.list.bind(bucket), now), "application/x-ndjson; charset=utf-8", `assembly-r2-inventory-${timestamp}.ndjson`);

  const cursor = query.get("cursor") || undefined;
  const partText = query.get("part") || "1";
  if (!/^[1-9]\d{0,5}$/.test(partText) || (cursor && cursor.length > 8192) || (format && format !== "tar")) {
    return page("Неверные параметры выгрузки.", "", 400);
  }
  const part = Number(partText);
  let rows, next, pageDigest;
  try {
    const result = await bucket.list({ limit: pageSize, ...(cursor ? { cursor } : {}) });
    rows = result.objects.map(identity);
    next = continuation(result, cursor);
    pageDigest = await digest(rows);
  } catch {
    return page("Не удалось прочитать список R2. Повторите запрос.", "", 503);
  }
  const partName = String(part).padStart(4, "0");
  if (format === "tar") {
    if (query.get("check") !== pageDigest) return page("Список объектов изменился. Обновите страницу выгрузки.", "", 409);
    return download(tarArchive(bucket, rows, part, now, pageDigest, Boolean(next)), "application/x-tar", `assembly-r2-part-${partName}-${timestamp}.tar`);
  }
  const args = { part: partText, ...(cursor ? { cursor } : {}) };
  const bytes = rows.reduce((total, item) => total + item.size, 0);
  const actions = "<nav>" +
    `<a data-r2-part href="${href({ ...args, download: "tar", check: pageDigest })}">Скачать часть ${partName}</a>` +
    (next ? `<a data-r2-next href="${href({ part: String(part + 1), cursor: next })}">Следующая часть</a>` : "") +
    '<a href="?download=inventory">Скачать список всех объектов R2</a></nav>' +
    '<button id="r2-prepare" type="button" hidden>Собрать полный архив R2</button>' +
    '<p id="r2-status" role="status"></p><a id="r2-file" hidden>Скачать полный архив R2</a>';
  return page(`Часть ${partName}. Объектов ${rows.length}, размер ${Math.round(bytes / (1024 * 1024))} МБ.`,
    actions, 200, '<script defer src="/ritm-r2-backup.js"></script>');
}
