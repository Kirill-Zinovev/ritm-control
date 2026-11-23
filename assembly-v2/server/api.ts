import type { Command, PreparedDispatch } from "../shared/model";
import type { PositionSearchPage } from "../shared/position-search";
import type { DispatchHistoryDetail, DispatchHistoryPage } from "../shared/dispatch-history";
import type { OzonBatch, OzonBatchSummary, OzonPreview } from "../shared/ozon-shipment";
import { collectorActions, managerActions } from "./access";
export interface Database {
  ozon?: {
    preview(input: string): Promise<OzonPreview>;
    list(): Promise<OzonBatchSummary[]>;
    batch(id: string): Promise<OzonBatch | null>;
  };
  warehouse?(url: URL): Promise<unknown>;
  preparedDispatches?(): Promise<PreparedDispatch[]>;
  dispatchHistory?: {
    page(index: number, query?: string): Promise<DispatchHistoryPage>;
    detail(id: string): Promise<DispatchHistoryDetail | null>;
  };
  workHistory?(url: URL): Promise<unknown>;
  searchPositions?(url: URL): Promise<PositionSearchPage>;
  snapshot(
    supplyId: string | null,
    scopeOnly?: boolean,
    directions?: boolean,
    directory?: boolean,
  ): Promise<unknown>;
  revision(): Promise<number>;
  command(
    action: string,
    payload: Record<string, unknown>,
    key: string,
    actor: string,
  ): Promise<Record<string, unknown>>;
  export(id: string): Promise<unknown>;
}
export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export async function api(
  request: Request,
  db: Database,
  actor: string,
  role: "owner" | "manager" | "collector" = "owner",
): Promise<Response> {
  if (!actor)
    return json(
      { error: "Войдите, чтобы работать в RITM Сборка.", code: "UNAUTHORIZED" },
      401,
    );
  const url = new URL(request.url);
  if (
    request.method === "POST" &&
    request.headers.get("origin") &&
    request.headers.get("origin") !== url.origin
  )
    return json({ error: "Недопустимый источник запроса." }, 403);
  try {
    if (request.method === "GET" && url.pathname === "/api/dispatches/prepared" && db.preparedDispatches) {
      if (role === "collector") return json({ error: "Подготовленные отгрузки доступны руководителю." }, 403);
      return json(await db.preparedDispatches());
    }
    if (request.method === "GET" && url.pathname === "/api/dispatch-history" && db.dispatchHistory) {
      if (role === "collector") return json({ error: "История отгрузок доступна руководителю." }, 403);
      const id = url.searchParams.get("id");
      if (id !== null) {
        if (!id.length || id.length > 160) return json({ error: "Проверьте номер отгрузки." }, 400);
        const detail = await db.dispatchHistory.detail(id);
        return detail ? json(detail) : json({ error: "Отгрузка не найдена в истории." }, 404);
      }
      const page = Number(url.searchParams.get("page") ?? 0);
      if (!Number.isSafeInteger(page) || page < 0 || page > 1_000_000)
        return json({ error: "Проверьте номер страницы." }, 400);
      const query = url.searchParams.get("q")?.trim();
      if (query && query.length > 160)
        return json({ error: "Проверьте номер короба, ШК Ozon или артикул." }, 400);
      return json(await db.dispatchHistory.page(page, query));
    }
    if (db.ozon && url.pathname.startsWith("/api/ozon/")) {
      if (role === "collector")
        return json({ error: "Отгрузки Ozon доступны руководителю." }, 403);
      if (request.method === "GET" && url.pathname === "/api/ozon/shipments") {
        const id = url.searchParams.get("id");
        if (!id) return json({ batches: await db.ozon.list() });
        const batch = await db.ozon.batch(id);
        return batch ? json(batch) : json({ error: "Подготовка не найдена." }, 404);
      }
      if (request.method === "POST" && url.pathname === "/api/ozon/preview") {
        if (!request.headers.get("content-type")?.startsWith("application/json"))
          return json({ error: "Ожидается JSON." }, 415);
        const body = await request.text();
        if (body.length > 45_000) return json({ error: "Вставьте более короткий список коробов." }, 413);
        const input = JSON.parse(body);
        if (typeof input?.numbers !== "string") return json({ error: "Проверьте список коробов." }, 400);
        return json(await db.ozon.preview(input.numbers));
      }
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      const state = await db.snapshot(
        url.searchParams.get("supply"),
        role === "collector" || url.searchParams.get("cartons") === "supply",
        url.searchParams.get("directions") === "1",
        role !== "collector" && url.searchParams.get("cartons") === "directory",
      );
      return json(
        role === "collector"
          ? { ...(state as object), dispatches: [], exports: [] }
          : state,
      );
    }
    if (request.method === "GET" && url.pathname === "/api/positions/search" && db.searchPositions)
      return json(await db.searchPositions(url));
    if (
      request.method === "GET" &&
      url.pathname === "/api/warehouse" &&
      db.warehouse
    ) {
      if (role === "collector") {
        if (url.searchParams.has("export")) return json({ error: "Выгрузки доступны руководителю." }, 403);
        url.searchParams.delete("summary");
      }
      return json(await db.warehouse(url));
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/work-history" &&
      db.workHistory
    ) {
      if (role !== "owner") url.searchParams.delete("includeDemo");
      return json(await db.workHistory(url));
    }
    if (request.method === "GET" && url.pathname === "/api/revision")
      return json({ revision: await db.revision() });
    if (request.method === "GET" && url.pathname.startsWith("/api/exports/")) {
      if (role !== "owner" && role !== "manager")
        return json({ error: "Выгрузки доступны руководителю." }, 403);
      const item = await db.export(url.pathname.split("/").at(-1) ?? "");
      return item ? json(item) : json({ error: "Выгрузка не найдена." }, 404);
    }
    if (request.method === "POST" && url.pathname === "/api/command") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return json({ error: "Ожидается JSON." }, 415);
      const body = await request.text();
      if (body.length > 2_000_000)
        return json({ error: "Файл больше 2 МБ." }, 413);
      const command = JSON.parse(body) as Command;
      if (
        typeof command.action !== "string" ||
        typeof command.key !== "string" ||
        !command.payload ||
        typeof command.payload !== "object" ||
        Array.isArray(command.payload)
      )
        return json({ error: "Неверный формат операции." }, 400);
      if (role === "collector" && !collectorActions.has(command.action))
        return json({ error: "Эта операция доступна руководителю." }, 403);
      if(role==='manager'&&!managerActions.has(command.action))return json({error:'Эта операция доступна только владельцу.'},403);
      const result = await db.command(
        command.action,
        command.payload,
        command.key,
        actor,
      );
      if (["legacy.restore", "legacy.adoptCarton", "catalog.attachLabels"].includes(command.action))
        return json({ result, state: null, refreshRequired: true });
      const selected =
        typeof result.supplyId === "string"
          ? result.supplyId
          : command.supplyId;
      // A committed operation must never be reported as a failed save merely
      // because the subsequent view refresh is temporarily unavailable.
      try {
        return json({
          result,
          state: await db
            .snapshot(
              selected ?? null,
              role === "collector" || command.cartonScope === "supply",
              command.directions === true,
              role !== "collector" && command.cartonScope === "directory",
            )
            .then((state) =>
              role === "collector"
                ? { ...(state as object), dispatches: [], exports: [] }
                : state,
            ),
        });
      } catch {
        return json({ result, state: null, refreshRequired: true });
      }
    }
    return json({ error: "Страница не найдена." }, 404);
  } catch (error) {
    const raw = error instanceof Error ? error.message : "";
    const message = /[А-Яа-яЁё]/.test(raw)
      ? raw
      : "Не удалось сохранить. Проверьте данные и повторите операцию.";
    return json({ error: message, code: "VALIDATION" }, 409);
  }
}
