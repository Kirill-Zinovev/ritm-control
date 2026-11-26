import type { Planning } from "../shared/productionPlanning";
import type { AssemblyOnlyForecastItem } from "./productionForecastData";

export type ArkadyPlanningSnapshot = Pick<
  Planning,
  "revision" | "deadlines" | "cutConfirmations"
> & {
  extraItems?: AssemblyOnlyForecastItem[];
  extraItemsConfirmed: boolean;
};

export async function requestArkadyPlanning(
  signal?: AbortSignal,
  change?: Record<string, unknown>,
): Promise<ArkadyPlanningSnapshot> {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch("/api/production-planning", {
    method: change ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: change ? { "content-type": "application/json" } : undefined,
    body: change ? JSON.stringify(change) : undefined,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const result: {
    ok?: unknown;
    message?: unknown;
    planning?: Partial<Planning>;
    extraItems?: unknown;
    extraItemsConfirmed?: unknown;
  } | null = await response.json().catch(() => null);
  const planning = result?.planning;
  if (
    !response.ok ||
    result?.ok !== true ||
    typeof planning?.revision !== "number" ||
    !Number.isSafeInteger(planning.revision) ||
    planning.revision < 0 ||
    !planning.deadlines ||
    typeof planning.deadlines !== "object" ||
    Array.isArray(planning.deadlines)
  ) {
    throw new Error(
      typeof result?.message === "string" && result.message
        ? result.message
        : "Не удалось прочитать настройки сроков РИТМ.",
    );
  }
  return {
    revision: planning.revision,
    deadlines: planning.deadlines,
    cutConfirmations: Array.isArray(planning.cutConfirmations)
      ? planning.cutConfirmations
      : undefined,
    extraItems: Array.isArray(result.extraItems)
      ? result.extraItems
      : undefined,
    extraItemsConfirmed:
      result.extraItemsConfirmed === true && Array.isArray(result.extraItems),
  };
}
