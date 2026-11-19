import type { Command } from "../shared/model";
import type { PositionSearchPage } from "../shared/position-search";
import { collectorActions, managerActions } from "./access";
export interface Database {
  warehouse?(url: URL): Promise<unknown>;
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
      { error: "Войдите, чтобы работать с Assembly.", code: "UNAUTHORIZED" },
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
      if(url.searchParams.has("export") && role==="collector")return json({error:"Выгрузки доступны руководителю."},403);
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
