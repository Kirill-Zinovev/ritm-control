import { useEffect, useRef, useState } from "react";
import type { BoxSheetReport } from "./livePrinting";

type LiveBoxSheetReport = {
  state: "ready" | "syncing" | "stale";
  checkedAt: string | null;
  report: BoxSheetReport | null;
};

export function useBoxSheetReport(enabled: boolean) {
  const [value, setValue] = useState<LiveBoxSheetReport | null>(null);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let pending = false;
    const check = async () => {
      if (pending || controller.signal.aborted) return;
      window.clearTimeout(timer);
      pending = true;
      let delay = 10000;
      try {
        const response = await fetch("/api/printing?view=box-sheets", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        const next: LiveBoxSheetReport & { ok?: boolean } = await response.json();
        if (!response.ok || next.ok !== true ||
            !["ready", "syncing", "stale"].includes(next.state) ||
            (next.report && !Array.isArray(next.report.rows)))
          throw new Error("Box sheet report unavailable");

        if (!controller.signal.aborted) setValue(previous => next.report ? next : {
          ...next,
          report: previous?.report ?? null,
          checkedAt: previous?.checkedAt ?? null,
        });
        if (next.state === "syncing") delay = 1500;
        if (next.state === "stale") delay = 30000;
      } catch {
        delay = 30000;
        if (!controller.signal.aborted) setValue(previous => ({
          state: "stale",
          report: previous?.report ?? null,
          checkedAt: previous?.checkedAt ?? null,
        }));
      } finally {
        pending = false;
        if (!controller.signal.aborted) timer = window.setTimeout(checkWhenVisible, delay);
      }
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    refresh.current = () => void check();
    void check();
    document.addEventListener("visibilitychange", checkWhenVisible);
    window.addEventListener("focus", checkWhenVisible);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", checkWhenVisible);
      window.removeEventListener("focus", checkWhenVisible);
    };
  }, [enabled]);
  return { value: enabled ? value : null, refresh: () => refresh.current() };
}
