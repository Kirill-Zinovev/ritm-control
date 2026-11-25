import { CloudError, json, readBytes } from "./access.js";
import { cloudConfig } from "./config.js";
import { eventSignature } from "./assemblyV2Events.js";

const fail = (code, message, status = 409) => {
  throw new CloudError(code, message, status);
};

export async function verifyAssemblyV2EmptyCommand(request, bindings, store, command) {
  const path = `/api/assembly-v2/${command}`;
  const url = new URL(request.url),
    secret = bindings.RITM_ASSEMBLY_V2_FEED_SECRET;
  if (request.method !== "POST" || url.pathname !== path || url.search)
    fail("method_not_allowed", "Метод запроса не поддерживается.", 405);
  const at = request.headers.get("x-assembly-v2-at") || "",
    nonce = request.headers.get("x-assembly-v2-nonce") || "",
    signature = request.headers.get("x-assembly-v2-signature") || "";
  if (
    !/^[a-f0-9]{64}$/.test(secret || "") ||
    !/^\d{13}$/.test(at) ||
    Math.abs(store.now() - Number(at)) > 120000 ||
    !/^[a-f0-9-]{36}$/i.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    fail(
      "assembly_v2_forbidden",
      "Служебная связь с новым Assembly не подтверждена.",
      403,
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    fail("json_required", "Ожидается JSON.", 415);
  const body = new TextDecoder().decode(await readBytes(request, 1024));
  const expected = eventSignature(secret, { path, at, nonce, body });
  let mismatch = 0;
  for (let i = 0; i < 64; i++)
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (mismatch)
    fail("assembly_v2_forbidden", "Подпись Assembly не подтверждена.", 403);
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    fail("refresh_input_invalid", "Неверный запрос обновления.", 400);
  }
  if (
    !input ||
    Array.isArray(input) ||
    typeof input !== "object" ||
    Object.keys(input).length
  )
    fail(
      "refresh_input_invalid",
      "Запрос не принимает адрес источника или данные поставок.",
      400,
    );
  const seen = await store.db
    .prepare(
      "INSERT INTO cloud_bridge_nonces(id,bridge_id,seen_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(`av2-${command}:${nonce}`, `assembly-v2-${command}`, store.now())
    .run();
  if (seen.meta?.changes !== 1)
    fail("assembly_v2_replay", "Этот запрос уже обработан.", 409);
}

// Separate from the read-only feed. The existing command only refreshes the source cache.
export async function refreshAssemblyV2Source(request, bindings, store, refresh) {
  await verifyAssemblyV2EmptyCommand(request, bindings, store, "refresh");
  const sourceReadAllowed = typeof store.productionSnapshotReadAllowed === "function"
    ? await store.productionSnapshotReadAllowed()
    : !await store.leaseIsActive("production");
  if (!sourceReadAllowed)
    fail(
      "assembly_v2_source_busy",
      "В РИТМ выполняется изменение поставок. Прежние данные сохранены.",
    );
  let lease;
  try {
    lease = await store.acquire("assembly-v2-refresh", 60000);
  } catch (error) {
    if (error.code === "cloud_operation_busy")
      return json({ ok: true, pending: true }, 202);
    throw error;
  }
  try {
    const maxAge = Math.min(cloudConfig(bindings).snapshotMaxAgeMs, 240000);
    const fresh = (s) =>
      s &&
      Number.isSafeInteger(s.at) &&
      s.at <= store.now() + 60000 &&
      store.now() - s.at < maxAge;
    const source = await (store.assemblySourceSnapshot ? store.assemblySourceSnapshot() : store.snapshot("printing")), supplyRevision = await store.readMeta?.("productionSupplyRevision") || null;
    const latestChange = await store.latestProductionUpdate?.() || 0;
    const moveRevision = await store.readMeta?.("printingMoveRevision") || null;
    if (fresh(source) && (source.value?.productionMoveRevision || null) === moveRevision && source.at >= latestChange && (source.value?.productionSupplyRevision || null) === supplyRevision)
      return json({ ok: true, refreshed: false });
    if (await store.leaseIsActive("refresh:printing"))
      return json({ ok: true, pending: true }, 202);
    const updated = await refresh();
    if (
      updated?.stale ||
      updated?.refreshFailed ||
      !fresh(await (store.assemblySourceSnapshot ? store.assemblySourceSnapshot() : store.snapshot("printing")))
    )
      fail(
        "assembly_v2_refresh_unconfirmed",
        "РИТМ пока не подтвердил свежий снимок. Прежние поставки и работа сохранены.",
      );
    return json({ ok: true, refreshed: true });
  } finally {
    await store.release(lease);
  }
}
