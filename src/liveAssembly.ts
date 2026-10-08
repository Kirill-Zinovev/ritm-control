import { useCallback, useEffect, useRef, useState } from "react";

export const FBO_URL =
  "https://docs.google.com/spreadsheets/d/1AuPraufSNHwEQHsVEwKR3dtiuEAqUgRrtZJDIQ9I5uo/edit";

export type AssemblyTypeCount = { name: string; quantity: number };
export type AssemblySummary = {
  employee: string;
  coefficient: number;
  machineCut: number;
  manualCut: number;
  cut: number;
  packed: number;
  total: number;
  days: number;
  cutTypes: AssemblyTypeCount[];
  packTypes: AssemblyTypeCount[];
};
export type LiveAssembly = {
  ok: true;
  schemaVersion: 1;
  source: string;
  date: string;
  period: "day" | "week" | "month";
  updatedAt: string;
  rows: AssemblySummary[];
};

function validSummary(row: AssemblySummary) {
  return (
    typeof row.employee === "string" &&
    ["coefficient", "machineCut", "manualCut", "cut", "packed", "total", "days"].every(
      (key) => Number.isFinite(row[key as keyof AssemblySummary]),
    ) &&
    Array.isArray(row.cutTypes) &&
    Array.isArray(row.packTypes) &&
    [...row.cutTypes, ...row.packTypes].every(
      (item) =>
        typeof item.name === "string" && Number.isFinite(item.quantity),
    )
  );
}

export function useLiveAssembly(
  date: string,
  period: "day" | "week" | "month",
) {
  const [value, setValue] = useState<LiveAssembly | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError("");
    try {
      const query =
        "?date=" +
        encodeURIComponent(date) +
        "&period=" +
        encodeURIComponent(period);
      const response = await fetch("/api/assembly" + query, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json();
      if (
        !response.ok ||
        !data.ok ||
        data.schemaVersion !== 1 ||
        !Array.isArray(data.rows) ||
        data.rows.some((row: AssemblySummary) => !validSummary(row)) ||
        !Number.isFinite(Date.parse(data.updatedAt))
      )
        throw new Error("source");
      if (!controller.signal.aborted) setValue(data);
    } catch {
      if (!controller.signal.aborted)
        setError("Не удалось обновить FBO «Итого». Показаны последние полученные данные.");
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  }, [date, period]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 300000);
    return () => {
      clearInterval(timer);
      active.current?.abort();
    };
  }, [reload]);

  return { value, loading, error, reload };
}
