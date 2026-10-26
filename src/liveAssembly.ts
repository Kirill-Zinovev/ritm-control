import { useCallback, useEffect, useRef, useState } from "react";

export const FBO_URL = import.meta.env.VITE_FBO_SOURCE_URL || "";

export type AssemblyTypeCount = { name: string; quantity: number };
export type AssemblyEvent = {
  eventId: string;
  idempotencyKey: string;
  shipmentId: string;
  shipmentName: string;
  directionId: string;
  positionId: string;
  article: string;
  employeeId: string;
  employee: string;
  operationId: string;
  operation: string;
  quantity: number;
  norm: number | null;
  coefficient: number | null;
  createdAt: string;
  date: string;
  source: string;
  productType: string;
};
export type AssemblySummary = {
  employee: string;
  employeeId?: string | null;
  identityKey?: string;
  sourceKind?: "fbo" | "assembly" | "both";
  sourceKinds?: Array<"fbo" | "assembly">;
  mappingStatus?: "confirmed" | "unmapped";
  reconciliationStatus?: "clear" | "needs_review" | "unknown";
  reconciliationReason?: string;
  sourceContributions?: AssemblySourceContribution[];
  lastUpdatedAt?: string | null;
  coefficient: number | null;
  machineCut: number;
  manualCut: number;
  cut: number;
  packed: number;
  total: number;
  days: number;
  cutTypes: AssemblyTypeCount[];
  packTypes: AssemblyTypeCount[];
};
export type AssemblySourceContribution = {
  sourceKind: "fbo" | "assembly";
  employeeLabel: string;
  employeeId: string | null;
  coefficient: number | null;
  machineCut: number;
  manualCut: number;
  cut: number;
  packed: number;
  total: number;
  recordCount: number;
  cutTypes: AssemblyTypeCount[];
  packTypes: AssemblyTypeCount[];
  reconciliationStatus: "clear" | "needs_review" | "unknown";
};
export type AssemblyDaily = AssemblySummary & {
  date: string;
  sourceIds?: string[];
  events?: AssemblyEvent[];
};
export type AssemblyNorm = {
  productType: string;
  operation: string;
  norm: number;
  unit: string;
  sourceLabel: string;
};

export type LiveAssembly = {
  ok: true;
  schemaVersion: 2;
  source: string;
  date: string;
  period: "day" | "week" | "month";
  updatedAt: string;
  stale?: boolean;
  staleSnapshot?: boolean;
  sourceUpdatedAt?: string | null;
  quality?: { status: string; invalidRecords: number };
  sources?: {
    fbo: {
      status: "available" | "unavailable" | "partial";
      checkedAt: string;
      lastSuccessAt?: string | null;
      sourceUpdatedAt?: string | null;
      currentSheetUpdatedAt?: string | null;
      currentSheetUpdateTime?: string | null;
      historyStatus?: "available" | "unavailable" | "partial";
      currentStatus?: "available" | "unavailable" | "partial";
      recordCount: number;
      source: string;
      sheet: string;
      message?: string;
      invalidRecords?: number;
    };
    assembly: {
      status: "available" | "unavailable" | "partial";
      checkedAt: string;
      lastSuccessAt?: string | null;
      sourceUpdatedAt?: string | null;
      eventCount: number;
      invalidRecords: number;
      message: string;
      source: string;
      supportsCorrections: boolean;
      correctionsApplied: number;
      cancellationsApplied: number;
    };
    catalog: {
      status: "available" | "unavailable" | "partial";
      missingRecords: number;
      message: string;
    };
  };
  sourcePolicy?: {
    mode: "simultaneous";
    cutover: null;
    overlap: boolean;
  };
  reconciliation?: {
    status: "clear" | "needs_review" | "unknown";
    message: string;
    pendingMappings: {
      fboNames: string[];
      assemblyEmployeeIds: string[];
    };
    conflicts: Array<{
      date: string;
      employeeId: string;
      fboName: string;
      employee: string;
      fboQuantity: number;
      assemblyQuantity: number;
      reason: string;
    }>;
    sourceTotals: {
      fbo: AssemblySourceTotals;
      assembly: AssemblySourceTotals;
    };
    approvedTotals: AssemblySourceTotals | null;
    approvedRecordCount: number;
    startDate: string;
    endDate: string;
  };
  norms?: {
    status: "available" | "unavailable";
    rows: AssemblyNorm[];
    message?: string;
  };
  rows: AssemblySummary[];
  history: AssemblyDaily[];
  events?: AssemblyEvent[];
};

export type AssemblySourceTotals = {
  machineCut: number;
  manualCut: number;
  cut: number;
  packed: number;
  total: number;
  coefficient: number | null;
  recordCount: number;
};

function validSummary(row: AssemblySummary) {
  return (
    typeof row.employee === "string" &&
    (row.coefficient === null || Number.isFinite(row.coefficient)) &&
    ["machineCut", "manualCut", "cut", "packed", "total", "days"].every((key) =>
      Number.isFinite(row[key as keyof AssemblySummary]),
    ) &&
    Array.isArray(row.cutTypes) &&
    Array.isArray(row.packTypes) &&
    [...row.cutTypes, ...row.packTypes].every(
      (item) => typeof item.name === "string" && Number.isFinite(item.quantity),
    )
  );
}

function snapshotKey(date: string, period: string) {
  return `ritm-assembly-analytics:v2:${date}:${period}`;
}

function readSnapshot(date: string, period: string): LiveAssembly | null {
  try {
    const raw = localStorage.getItem(snapshotKey(date, period));
    if (!raw) return null;
    const cached = JSON.parse(raw) as LiveAssembly;
    if (
      cached?.schemaVersion !== 2 ||
      cached?.date !== date ||
      cached?.period !== period ||
      !Array.isArray(cached.rows) ||
      !Array.isArray(cached.history) ||
      cached.rows.some((row) => !validSummary(row)) ||
      cached.history.some((row) => !validSummary(row)) ||
      !Array.isArray(cached.events) ||
      !Number.isFinite(Date.parse(cached.updatedAt))
    )
      return null;
    return { ...cached, stale: true, staleSnapshot: true };
  } catch {
    return null;
  }
}

function hasBothSources(snapshot: LiveAssembly | null | undefined) {
  return (
    snapshot?.sources?.fbo.status === "available" &&
    snapshot?.sources?.assembly.status === "available"
  );
}

function markSummaryForReview<T extends AssemblySummary>(row: T): T {
  return {
    ...row,
    reconciliationStatus: "unknown",
    coefficient: null,
    sourceContributions: (row.sourceContributions || []).map((source) => ({
      ...source,
      reconciliationStatus: "unknown",
    })),
  };
}

function keepLastGoodSnapshot(
  fresh: LiveAssembly,
  cached: LiveAssembly,
): LiveAssembly {
  const mergeSource = <
    T extends {
      status: "available" | "unavailable" | "partial";
      checkedAt: string;
      lastSuccessAt?: string | null;
      message?: string;
    },
  >(
    freshSource: T,
    cachedSource: T,
  ): T => ({
    ...cachedSource,
    status: freshSource.status,
    checkedAt: freshSource.checkedAt,
    lastSuccessAt:
      cachedSource.lastSuccessAt || cachedSource.checkedAt || cached.updatedAt,
    message: freshSource.status === "available" ? "" : freshSource.message,
  });
  const freshSources = fresh.sources;
  const cachedSources = cached.sources;
  return {
    ...cached,
    stale: true,
    staleSnapshot: true,
    sources:
      freshSources && cachedSources
        ? {
            ...cachedSources,
            fbo: mergeSource(freshSources.fbo, cachedSources.fbo),
            assembly: mergeSource(
              freshSources.assembly,
              cachedSources.assembly,
            ),
            catalog: freshSources.catalog || cachedSources.catalog,
          }
        : cachedSources,
    reconciliation: cached.reconciliation
      ? {
          ...cached.reconciliation,
          status: "unknown",
          approvedTotals: null,
          message:
            "Один из источников временно недоступен. Показан последний сохранённый снимок; общий итог требует повторной сверки.",
        }
      : fresh.reconciliation,
    rows: cached.rows.map(markSummaryForReview),
    history: cached.history.map(markSummaryForReview),
  };
}

export function useLiveAssembly(
  date: string,
  period: "day" | "week" | "month",
  enabled = true,
) {
  const [value, setValue] = useState<LiveAssembly | null>(() =>
    readSnapshot(date, period),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);

  const reload = useCallback(async (refreshSources = true) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    try {
      const query =
        "?date=" +
        encodeURIComponent(date) +
        "&period=" +
        encodeURIComponent(period) +
        (refreshSources ? "&refresh=1" : "");
      const response = await fetch("/api/assembly" + query, {
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(45000),
        ]),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? "Войдите как владелец через AI Center на этом адресе RITM, затем обновите данные сборщиков."
            : data.message || "Сервер не смог обновить данные сборщиков.",
        );
      }
      if (data.ok && data.schemaVersion !== 2) {
        throw new Error("На этом адресе работает старая серверная версия RITM. Обновите сервер, чтобы подключить FBO и Assembly.");
      }
      if (
        !response.ok ||
        !data.ok ||
        data.schemaVersion !== 2 ||
        !Array.isArray(data.rows) ||
        !Array.isArray(data.history) ||
        data.rows.some((row: AssemblySummary) => !validSummary(row)) ||
        data.history.some(
          (row: AssemblyDaily) =>
            !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !validSummary(row),
        ) ||
        !Number.isFinite(Date.parse(data.updatedAt))
      )
        throw new Error("source");
      if (!controller.signal.aborted) {
        const unavailableMessages = [
          data.sources?.fbo?.status !== "available"
            ? data.sources.fbo.message || "FBO недоступен."
            : "",
          data.sources?.assembly?.status !== "available"
            ? data.sources.assembly.message || "WorkLog недоступен."
            : "",
        ].filter(Boolean);
        setError(unavailableMessages.join(" "));
        if (hasBothSources(data)) {
          setValue(data);
          try {
            localStorage.setItem(
              snapshotKey(date, period),
              JSON.stringify(data),
            );
          } catch {
            // A full browser cache must not block fresh source data.
          }
        } else {
          const cached = readSnapshot(date, period);
          setValue((previous) => {
            const lastGood =
              previous?.date === date &&
              previous.period === period &&
              hasBothSources(previous)
                ? previous
                : cached;
            return lastGood ? keepLastGoodSnapshot(data, lastGood) : data;
          });
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error && !["source", "TimeoutError", "AbortError", "TypeError"].includes(cause.message) && cause.name === "Error"
            ? cause.message
            : "Не удалось обновить источники. Показаны последние полученные данные.",
        );
        const cached = readSnapshot(date, period);
        setValue((previous) => {
          const lastGood =
            previous?.date === date && previous.period === period
              ? previous
              : cached;
          return lastGood ? { ...lastGood, stale: true } : null;
        });
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  }, [date, period]);

  useEffect(() => {
    if (!enabled) return;
    void reload(false);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 300000);
    return () => {
      clearInterval(timer);
      active.current?.abort();
    };
  }, [reload, enabled]);

  return { value, loading, error, reload };
}
