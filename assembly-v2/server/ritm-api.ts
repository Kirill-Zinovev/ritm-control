import { json, type Database } from "./api";
import type { SqlStore, Statement } from "./database";
import { digest } from "../shared/catalog";
import {
  ritmShipmentId,
  signRitmFeed,
  type RitmFeed,
  type RitmStatus,
  type RitmIssue,
} from "../shared/ritm";
import { requireCatalog as check } from "./catalog-store";
import { hmac } from "./access";
import { syncSourcePhotos } from "./source-photos";
import {
  drainWorkOutbox,
  enqueueWork,
  enqueueCancellation,
  workDeliveryStatus,
} from "./ritm-outbox";
export interface RitmEnv {
  RITM_ASSEMBLY_V2_FEED_SECRET?: string;
  RITM_ASSEMBLY_V2_FEED_URL?: string;
}
const endpoint =
  "https://ritm-erp.zinovevkirill234.chatgpt.site/api/assembly-v2/feed";
const q = (sql: string, ...args: (string | number | null)[]): Statement => ({
  sql,
  args,
});
interface SyncRow {
  checkedAt: number;
  sourceRevision: number;
  sourceAt: string | null;
  status: RitmStatus["status"];
  report: string;
  leaseId: string | null;
  leaseUntil: number;
}
export const ritmConfigured = (env: RitmEnv): boolean =>
  env.RITM_ASSEMBLY_V2_FEED_URL === endpoint &&
  /^[a-f0-9]{64}$/.test(env.RITM_ASSEMBLY_V2_FEED_SECRET || "");
async function syncRow(store: SqlStore) {
  return (
    await store.all<SyncRow>("select * from av2_ritm_sync where id=1")
  )[0];
}
export async function readRitmStatus(
  store: SqlStore,
  env: RitmEnv,
): Promise<RitmStatus> {
  if (!ritmConfigured(env))
    return {
      configured: false,
      status: "unconfigured",
      checkedAt: null,
      sourceAt: null,
      message: "Автоматическая связь с РИТМ ещё не настроена.",
      supplies: 0,
      groups: 0,
      positions: 0,
      issues: [],
    };
  const row = await syncRow(store),
    report: Partial<RitmStatus> = row ? JSON.parse(row.report) : {};
  const busy = !!row?.leaseId && row.leaseUntil > Date.now();
  return {
    configured: true,
    status: busy ? "syncing" : row?.status || "waiting",
    checkedAt: row?.checkedAt ? new Date(row.checkedAt).toISOString() : null,
    sourceAt: row?.sourceAt || null,
    message: busy
      ? "Получаем поставки из РИТМ…"
      : report.message ||
        "Связь настроена. Ожидаем первое подтверждённое чтение РИТМ.",
    supplies: report.supplies || 0,
    groups: report.groups || 0,
    positions: report.positions || 0,
    issues: report.issues || [],
  };
}
async function readFeedResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  check(reader, "РИТМ вернул пустой ответ.");
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      check(
        size <= 6_000_000,
        "Состав РИТМ больше допустимого пакета. Предыдущие поставки сохранены.",
      );
      parts.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  const body = new TextDecoder().decode(bytes);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    const providerCode = /(?:error code:|Error\s+)(\d{4})/i.exec(
      body.slice(0, 20000),
    )?.[1];
    console.error(
      "ritm_feed_response",
      JSON.stringify({
        status: response.status,
        type: response.headers.get("content-type"),
        providerCode: providerCode || null,
      }),
    );
    throw new Error(
      "Сервер РИТМ временно не передал состав поставок. Повторим чтение автоматически.",
    );
  }
  return JSON.parse(body);
}
function validateFeed(value: unknown): asserts value is RitmFeed {
  const f = value as RitmFeed;
  check(
    f?.format === "ritm-assembly-v2" &&
      f.version === 1 &&
      Number.isSafeInteger(f.sourceRevision) &&
      f.sourceRevision > 0 &&
      Date.parse(f.sourceAt) === f.sourceRevision &&
      Date.now() - f.sourceRevision < 300000 &&
      f.sourceRevision <= Date.now() + 60000,
    "РИТМ не подтвердил свежую версию поставок. Предыдущие данные сохранены.",
  );
  check(
    Array.isArray(f.activeShipmentIds) &&
      f.activeShipmentIds.length <= 1000 &&
      f.activeShipmentIds.every(
        (v) => typeof v === "string" && ritmShipmentId(v),
      ) &&
      new Set(f.activeShipmentIds).size === f.activeShipmentIds.length,
    "Не подтверждён реестр поставок РИТМ.",
  );
  check(
    Array.isArray(f.supplies) &&
      f.supplies.length <= 1000 &&
      new Set(f.supplies.map((s) => s.shipmentId)).size === f.supplies.length &&
      f.supplies.every((s) => f.activeShipmentIds.includes(s.shipmentId)) &&
      Array.isArray(f.issues) &&
      f.issues.every(
        (i) =>
          typeof i.shipmentId === "string" &&
          typeof i.title === "string" &&
          typeof i.message === "string",
      ),
    "Снимок РИТМ неполный или содержит повторяющиеся поставки.",
  );
}
export async function syncRitm(
  store: SqlStore,
  db: Database,
  env: RitmEnv,
  {
    force = false,
    fetcher = fetch,
  }: { force?: boolean; fetcher?: typeof fetch } = {},
): Promise<RitmStatus> {
  if (!ritmConfigured(env)) return readRitmStatus(store, env);
  const now = Date.now(),
    before = await syncRow(store);
  if (!force && before && now - before.checkedAt < 5000)
    return readRitmStatus(store, env);
  const lease = crypto.randomUUID();
  await store.batch([
    q(
      `insert into av2_ritm_sync(id,lease_id,lease_until) values(1,?,?) on conflict(id) do update set lease_id=excluded.lease_id,lease_until=excluded.lease_until where av2_ritm_sync.lease_until<? and (?=1 or av2_ritm_sync.checked_at<?)`,
      lease,
      now + 60000,
      now,
      force ? 1 : 0,
      now - 5000,
    ),
  ]);
  if ((await syncRow(store))?.leaseId !== lease)
    return readRitmStatus(store, env);
  try {
    const readFeed = async () => {
      const at = String(Date.now()),
        nonce = crypto.randomUUID(),
        path = new URL(endpoint).pathname;
      const response = await fetcher(endpoint, {
        method: "GET",
        // Workers supports manual/follow; never forward the signature on redirects.
        redirect: "manual",
        signal: AbortSignal.timeout(18000),
        headers: {
          "x-assembly-v2-at": at,
          "x-assembly-v2-nonce": nonce,
          "x-assembly-v2-signature": await signRitmFeed(
            env.RITM_ASSEMBLY_V2_FEED_SECRET!,
            path,
            at,
            nonce,
          ),
        },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error(
          "РИТМ перенаправил служебный запрос. Прежние поставки сохранены; адрес связи требует проверки.",
        );
      }
      return { response, raw: await readFeedResponse(response) };
    };
    let { response, raw } = await readFeed();
    if (
      !response.ok &&
      ["assembly_v2_source_stale", "assembly_v2_snapshot_pending", "assembly_v2_source_changed"].includes((raw as { error?: string })?.error || "")
    ) {
      // One shared sync lease serves every collector. Refresh via a separate
      // signed route; the original feed remains a cache-only read.
      await store.batch([
        q(
          "update av2_ritm_sync set lease_until=? where id=1 and lease_id=?",
          Date.now() + 90000,
          lease,
        ),
      ]);
      const refreshPath = "/api/assembly-v2/refresh",
        body = "{}",
        at = String(Date.now()),
        nonce = crypto.randomUUID();
      const refreshed = await fetcher(new URL(refreshPath, endpoint), {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(45000),
        body,
        headers: {
          "content-type": "application/json",
          "x-assembly-v2-at": at,
          "x-assembly-v2-nonce": nonce,
          "x-assembly-v2-signature": await hmac(
            env.RITM_ASSEMBLY_V2_FEED_SECRET!,
            JSON.stringify([
              1,
              "POST",
              refreshPath,
              at,
              nonce,
              await digest(body),
            ]),
          ),
        },
      });
      const refreshResult = await readFeedResponse(refreshed);
      check(
        refreshed.ok && (refreshResult as { ok?: boolean })?.ok === true,
        (refreshResult as { message?: string })?.message ||
          "РИТМ пока не подтвердил обновление поставок. Прежние данные сохранены.",
      );
      ({ response, raw } = await readFeed());
    }
    check(
      response.ok,
      (raw as { message?: string; error?: string })?.message ||
        (raw as { error?: string })?.error ||
        "РИТМ временно не подтвердил передачу поставок.",
    );
    validateFeed(raw);
    const feed = raw;
    check(
      !before || feed.sourceRevision >= before.sourceRevision,
      "Получен устаревший ответ РИТМ. Прежние данные сохранены.",
    );
    const feedFingerprint = await digest(JSON.stringify(feed));
    const lastReport = before ? JSON.parse(before.report) as { feedFingerprint?: string } : null;
    // Compare the complete validated payload: manual items and lock changes
    // may arrive independently of the printing snapshot timestamp. Retry
    // partial imports and explicit refreshes even when the source is unchanged.
    if (!force && before?.status === "synced" && lastReport?.feedFingerprint === feedFingerprint) {
      await store.batch([q(
        "update av2_ritm_sync set checked_at=?,lease_id=null,lease_until=0 where id=1 and lease_id=?",
        Date.now(), lease,
      )]);
      return readRitmStatus(store, env);
    }
    const issues: RitmIssue[] = [...feed.issues];
    for (const source of feed.supplies) {
      const ownership = await syncRow(store);
      check(
        ownership?.leaseId === lease && ownership.leaseUntil > Date.now(),
        "Другой запрос уже обновляет связь с РИТМ. Двойной загрузки не будет.",
      );
      const fingerprint = await digest(JSON.stringify(source));
      const previous = (
        await store.all<{
          fingerprint: string;
          sourceRevision: number;
          active: number;
          issues: string;
        }>(
          `select l.fingerprint,l.source_revision,l.issues,(select count(*) from av2_supplies s where s.origin_shipment_id=l.shipment_id and s.source_active=1) active from av2_ritm_links l where shipment_id=?`,
          [source.shipmentId],
        )
      )[0];
      try {
        if (previous?.fingerprint === fingerprint && previous.active && !String(previous.issues).includes('привязка Не подтверждён')) {
          issues.push(...(JSON.parse(previous.issues) as RitmIssue[]));
          check(
            feed.sourceRevision >= previous.sourceRevision,
            "Получен устаревший состав РИТМ.",
          );
          await store.batch([
            q(
              "update av2_ritm_links set source_revision=?,seen_at=? where shipment_id=? and source_revision<=?",
              feed.sourceRevision,
              Date.now(),
              source.shipmentId,
              feed.sourceRevision,
            ),
          ]);
        } else {
          const key = `ritm:store-confirmed-v2:${await digest(JSON.stringify([source.shipmentId, feed.sourceRevision, fingerprint]))}`;
          const result = await db.command(
            "ritm.import",
            { source, sourceRevision: feed.sourceRevision, fingerprint },
            key,
            "ritm-source",
          );
          if (Array.isArray(result.issues))
            issues.push(...(result.issues as RitmIssue[]));
        }
        await syncSourcePhotos(store, source, feed.sourceRevision);
      } catch (e) {
        issues.push({
          shipmentId: source.shipmentId,
          title: source.title,
          message:
            e instanceof Error
              ? e.message
              : "Состав поставки не подтверждён; прежние данные сохранены.",
        });
      }
      await store.batch([
        q(
          "update av2_ritm_sync set lease_until=? where id=1 and lease_id=?",
          Date.now() + 60000,
          lease,
        ),
      ]);
    }
    // Only a complete, fresh roster can retire a previously imported source.
    const missing = await store.all<{ originShipmentId: string }>(
      `select distinct origin_shipment_id from av2_supplies where origin_shipment_id is not null and source_active=1 and origin_shipment_id not in(select value from json_each(?))`,
      [JSON.stringify(feed.activeShipmentIds)],
    );
    if (missing.length)
      await db.command(
        "ritm.retire",
        { ids: missing.map((s) => s.originShipmentId) },
        `ritm:${await digest(JSON.stringify(["retire", feed.sourceRevision, missing]))}`,
        "ritm-source",
      );
    const counts = (
      await store.all<{ supplies: number; groups: number; positions: number }>(
        `select count(distinct s.origin_shipment_id) supplies,count(*) groups,(select count(*) from av2_positions p join av2_supplies x on x.id=p.supply_id where x.origin_shipment_id is not null and x.source_active=1 and p.source_active=1) positions from av2_supplies s where s.origin_shipment_id is not null and s.source_active=1`,
      )
    )[0];
    const report = {
      ...counts,
      feedFingerprint,
      issues,
      message: issues.length
        ? "Связь с РИТМ работает. Часть данных требует проверки; прежние записи сохранены."
        : "Поставки из РИТМ обновлены.",
    };
    await store.batch([
      q(
        "update av2_ritm_sync set checked_at=?,source_revision=?,source_at=?,status=?,report=?,lease_id=null,lease_until=0 where id=1 and lease_id=?",
        Date.now(),
        feed.sourceRevision,
        feed.sourceAt,
        issues.length ? "partial" : "synced",
        JSON.stringify(report),
        lease,
      ),
    ]);
  } catch (error) {
    console.error(
      "ritm_feed_sync",
      JSON.stringify({
        name: error instanceof Error ? error.name : "Unknown",
        detail:
          error instanceof Error
            ? error.message
                .replace(/[A-Za-z0-9._-]{30,}/g, "[redacted]")
                .slice(0, 160)
            : null,
        networkCode:
          error instanceof Error
            ? /(?:error code:|Error\s+)(\d{4})/i.exec(error.message)?.[1] ||
              null
            : null,
      }),
    );
    const message =
      error instanceof Error && /[А-Яа-яЁё]/.test(error.message)
        ? error.message
        : "Связь с РИТМ временно недоступна. Прежние поставки и работа сохранены.";
    const previous: Partial<RitmStatus> = before
      ? JSON.parse(before.report)
      : {};
    await store.batch([
      q(
        "update av2_ritm_sync set checked_at=?,status='waiting',report=?,lease_id=null,lease_until=0 where id=1 and lease_id=?",
        Date.now(),
        JSON.stringify({
          ...previous,
          message,
          issues: [{ shipmentId: "", title: "Связь с РИТМ", message }],
        }),
        lease,
      ),
    ]);
  }
  return readRitmStatus(store, env);
}
export async function ritmApi(
  request: Request,
  store: SqlStore,
  db: Database,
  actor: string,
  env: RitmEnv,
): Promise<Response> {
  if (!actor) return json({ error: "Войдите в Assembly." }, 401);
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/ritm/status")
    return json({
      ...(await readRitmStatus(store, env)),
      workDelivery: await workDeliveryStatus(store),
    });
  if (request.method === "POST" && url.pathname === "/api/ritm/deliver") {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== url.origin
    )
      return json({ error: "Недопустимый источник запроса." }, 403);
    const works = await store.all<{ id: string }>(
      `select w.id from av2_work w join av2_supplies s on s.id=w.supply_id where w.legacy_event_id is null and s.origin_shipment_id is not null and not exists(select 1 from av2_ritm_work_outbox o where o.id='av2:'||w.id) limit 40`,
    );
    const corrections = await store.all<{ id: string; workId: string }>(
      `select c.id,c.work_id from av2_corrections c join av2_work w on w.id=c.work_id join av2_supplies s on s.id=w.supply_id where w.legacy_event_id is null and s.origin_shipment_id is not null and not exists(select 1 from av2_ritm_work_outbox o where o.id='av2:cancel:'||c.id) limit 40`,
    );
    const now = new Date().toISOString();
    if (works.length || corrections.length)
      await store.batch([
        ...works.map((w) => enqueueWork(w.id, now)),
        ...corrections.map((c) => enqueueCancellation(c.workId, c.id, now)),
      ]);
    return json({ ok: true, workDelivery: await drainWorkOutbox(store, env) });
  }
  if (request.method === "POST" && url.pathname === "/api/ritm/sync") {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== url.origin
    )
      return json({ error: "Недопустимый источник запроса." }, 403);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return json({ error: "Ожидается JSON." }, 415);
    const raw = await request.text();
    if (raw.length > 80000)
      return json({ error: "Слишком большой запрос." }, 413);
    try {
      const body = JSON.parse(raw);
      const expected = body.expectedShipmentIds ?? [];
      check(
        Array.isArray(expected) &&
          expected.length <= 1000 &&
          expected.every(
            (s: unknown) => typeof s === "string" && ritmShipmentId(s),
          ),
        "Не подтверждён состав поставок для доставки.",
      );
      const status = await syncRitm(store, db, env, {
        force: body.force === true,
      });
      const sync = await syncRow(store);
      const receipts = expected.length
        ? await store.all(
            `select l.shipment_id,l.source_revision,
        (select count(*) from av2_supplies s where s.origin_shipment_id=l.shipment_id and s.source_active=1) groups,
        (select count(*) from av2_positions p join av2_supplies s on s.id=p.supply_id where s.origin_shipment_id=l.shipment_id and s.source_active=1 and p.source_active=1) positions
        from av2_ritm_links l where l.shipment_id in(select value from json_each(?))`,
            [JSON.stringify(expected)],
          )
        : [];
      const includePositions = actor === "ritm-service" && body.includePositionIds === true;
      // Confirm activity from the persisted Assembly roster, including retired
      // shipments whose positions still exist for history and audit.
      const positionReceipts = includePositions && expected.length
        ? (await store.all<{shipmentId:string; sourceRevision:number; positionIds:string}>(
            `select requested.value shipment_id,
             case when exists(select 1 from av2_supplies s where s.origin_shipment_id=requested.value and s.source_active=1)
               then coalesce(l.source_revision,0) else ? end source_revision,
             coalesce((select json_group_array(p.external_id)
               from av2_positions p join av2_supplies s on s.id=p.supply_id
               where s.origin_shipment_id=requested.value and s.source_active=1 and p.source_active=1),'[]') position_ids
             from json_each(?) requested left join av2_ritm_links l on l.shipment_id=requested.value`,
            [sync?.sourceRevision || 0, JSON.stringify(expected)],
          )).map(row => ({...row, positionIds: JSON.parse(row.positionIds) as string[]}))
        : undefined;
      return json({
        ...status,
        sourceRevision: sync?.sourceRevision || 0,
        receipts,
        positionReceipts,
        workDelivery: await workDeliveryStatus(store),
      });
    } catch {
      return json(
        { error: "Не удалось проверить связь с РИТМ. Повторите запрос." },
        409,
      );
    }
  }
  return json({ error: "Раздел связи с РИТМ не найден." }, 404);
}
