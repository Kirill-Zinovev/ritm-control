import { createHash, createHmac } from "node:crypto";
import { CloudError, readBytes } from "./access.js";

const reads = new Set(["/api/printing", "/api/assembly", "/api/roll-supplies/status", "/api/roll-supplies/operations", "/api/assembly-transfers/sources", "/api/assembly-transfers/links", "/api/assembly-transfers/source", "/api/assembly-transfers/operation", "/api/cloud/registry", "/api/cloud/bridge-lease", "/api/cloud/export"]);
const writes = new Set(["/api/roll-supplies", "/api/roll-supplies/preview", "/api/assembly-transfers", "/api/assembly-transfers/preview", "/api/cloud/bridge-lease"]);
export const isOperationalRoute = (method, pathname) => (method === "GET" ? reads : method === "POST" ? writes : new Set()).has(pathname);
export function bridgeSignature(secret, { method, path, timestamp, nonce, body = "" }) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(JSON.stringify([1, method, path, timestamp, nonce, bodyHash])).digest("hex");
}
// The Assembly Apps Script uses its existing event key for this narrowly
// scoped reverse channel. It cannot call supply writers or any other API.
export async function verifyAssemblyControlApp(request, bindings, now = Date.now()) {
  const url = new URL(request.url), at = request.headers.get("x-ritm-assembly-at"), nonce = request.headers.get("x-ritm-assembly-nonce"), signature = request.headers.get("x-ritm-assembly-signature");
  const allowed = request.method === "GET" && ["/api/assembly-controls", "/api/assembly-only-items"].includes(url.pathname) || request.method === "POST" && url.pathname === "/api/assembly-controls/complete";
  const secret = bindings.RITM_ASSEMBLY_SYNC_SECRET;
  const fail = () => { throw new CloudError("assembly_control_forbidden", "Связь с RITM Assembly не подтверждена.", 403); };
  if (!allowed || !/^[a-f0-9]{64}$/i.test(secret || "") || !/^\d{13}$/.test(at || "") || Math.abs(now - Number(at)) > 120000 || !/^[a-f0-9-]{36}$/i.test(nonce || "") || !/^[a-f0-9]{64}$/i.test(signature || "") || !bindings.DB) fail();
  const body = request.method === "GET" ? "" : new TextDecoder().decode(await readBytes(request.clone()));
  const expected = bridgeSignature(secret, { method: request.method, path: url.pathname + url.search, timestamp: at, nonce, body });
  let mismatch = 0;
  for (let index = 0; index < expected.length; index++) mismatch |= expected.charCodeAt(index) ^ signature.toLowerCase().charCodeAt(index);
  if (mismatch) fail();
  const result = await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM cloud_bridge_nonces WHERE seen_at<?").bind(now - 300000),
    bindings.DB.prepare("INSERT INTO cloud_bridge_nonces(id,bridge_id,seen_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING").bind(nonce, "assembly-control-app", now),
  ]);
  if (result[1].meta?.changes !== 1) throw new CloudError("assembly_control_replay", "Этот запрос уже обработан. Обновите состояние задачи.", 409);
  return "assembly-control-app";
}

export async function verifyBridge(request, bindings, now = Date.now()) {
  const url = new URL(request.url), id = request.headers.get("x-ritm-bridge-id"), timestamp = request.headers.get("x-ritm-bridge-at"), nonce = request.headers.get("x-ritm-bridge-nonce"), signature = request.headers.get("x-ritm-bridge-signature");
  const secret = bindings.RITM_LOCAL_BRIDGE_SECRET;
  const fail = () => { throw new CloudError("bridge_forbidden", "Связь с локальным RITM не подтверждена.", 403); };
  if (!id || id !== bindings.RITM_LOCAL_BRIDGE_ID || !/^[a-f0-9]{64}$/i.test(secret || "") || !/^\d{13}$/.test(timestamp || "") || Math.abs(now - Number(timestamp)) > 120000 || !/^[a-f0-9-]{36}$/i.test(nonce || "") || !/^[a-f0-9]{64}$/i.test(signature || "") || !isOperationalRoute(request.method, url.pathname) || !bindings.DB) fail();
  const body = request.method === "GET" ? "" : new TextDecoder().decode(await readBytes(request.clone()));
  const expected = bridgeSignature(secret, { method: request.method, path: url.pathname + url.search, timestamp, nonce, body });
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (mismatch) fail();
  const result = await bindings.DB.batch([
    bindings.DB.prepare("DELETE FROM cloud_bridge_nonces WHERE seen_at<?").bind(now - 300000),
    bindings.DB.prepare("INSERT INTO cloud_bridge_nonces(id,bridge_id,seen_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING").bind(nonce, id, now),
  ]);
  if (result[1].meta?.changes !== 1) throw new CloudError("bridge_replay", "Этот служебный запрос уже обработан.", 409);
  return id;
}
