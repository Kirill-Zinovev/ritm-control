import { cloudConfig } from "./config.js";

export class CloudError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function requireOwner(request, bindings, { write = false } = {}) {
  const id = request.headers.get("oai-authenticated-user-id");
  const owners = cloudConfig(bindings).owners;
  if (!id) throw new CloudError("authentication_required", "Войдите через ChatGPT, чтобы открыть рабочий RITM.", 401);
  if (!owners.length || !owners.includes(id)) throw new CloudError("owner_required", "Доступ к этому рабочему RITM не настроен для вашего аккаунта.", 403);
  if (write) {
    const origin = request.headers.get("origin");
    if (origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site")
      throw new CloudError("origin_forbidden", "Откройте действие на странице RITM.", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new CloudError("json_required", "Не удалось прочитать запрос.", 415);
  }
  return id;
}

export function requireMaintenance(request, bindings, key = "RITM_MAINTENANCE_TOKEN") {
  const expected = bindings[key];
  const actual = request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  if (typeof expected !== "string" || expected.length < 32 || actual.length !== expected.length) throw new CloudError("maintenance_forbidden", "Служебный доступ не подтверждён.", 403);
  let different = 0;
  for (let index = 0; index < expected.length; index++) different |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  if (different || !request.headers.get("content-type")?.startsWith("application/json")) throw new CloudError("maintenance_forbidden", "Служебный доступ не подтверждён.", 403);
}

export async function readBytes(request, maxBytes = 180000) {
  const reader = request.body?.getReader();
  if (!reader) throw new CloudError("body_required", "Пустой запрос.", 400);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new CloudError("body_too_large", "Слишком большой запрос.", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError("invalid_body", "Не удалось прочитать запрос.", 400);
  } finally { reader.releaseLock(); }
}

export async function readJson(request, maxBytes = 180000) {
  const bytes = await readBytes(request, maxBytes);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new CloudError("invalid_json", "Не удалось прочитать запрос.", 400); }
}

export function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "vary": "oai-authenticated-user-id",
  } });
}
