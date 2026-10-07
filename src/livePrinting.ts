import { useCallback, useEffect, useRef, useState } from "react";
import type { Dataset, Roll } from "./model";
export const PRINTING_URL =
  "https://docs.google.com/spreadsheets/d/1eNdUuk-2l83Pgv95LyqYKuOOfhAsEMm5tKLbhWBJiC4/edit";
export const PRINTERS = [
  { id: "printer-dmitry", name: "Дмитрий" },
  { id: "printer-pavel", name: "Павел" },
  { id: "printer-andrey", name: "Андрей" },
];
export type LiveEvent = {
  id: string;
  uid: string;
  roll: string;
  employee: string;
  date: string;
  article: string;
  quantity: number;
  area: number;
  sheetName: string;
  sheetId: number;
  source: string;
};
export type LiveOrder = {
  uid: string;
  sheetId: number;
  sheetName: string;
  row: number;
  article: string;
  quantity: number;
  plannedArea: number;
};
export type LivePrinting = {
  ok: true;
  schemaVersion: 2;
  updatedAt: string;
  events: LiveEvent[];
  supplies: LiveOrder[];
  issues: { source: string; row: number; message: string }[];
  sheets: { sheetId: number; name: string }[];
};
export function printingDataset(
  base: Dataset,
  live: LivePrinting | null,
): Dataset {
  const rolls: Roll[] = (live?.events || []).map((e) => ({
    id: e.id,
    roll: e.roll,
    employee: PRINTERS.find((p) => p.name === e.employee)!.id,
    date: e.date,
    time: "",
    article: e.article,
    quantity: e.quantity,
    area: e.area,
    site: "Красное здание",
    source: e.sheetName,
  }));
  return {
    ...base,
    employees: [
      ...base.employees.filter((e) => !PRINTERS.some((p) => p.id === e.id)),
      ...PRINTERS,
    ],
    rolls,
  };
}
export function useLivePrinting() {
  const [value, setValue] = useState<LivePrinting | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/printing", {
        cache: "no-store",
        signal: controller.signal,
      });
      const j = await r.json();
      if (
        !r.ok ||
        !j.ok ||
        j.schemaVersion !== 2 ||
        !Array.isArray(j.events) ||
        !Array.isArray(j.supplies) ||
        !Array.isArray(j.issues) ||
        !Array.isArray(j.sheets) ||
        !Number.isFinite(Date.parse(j.updatedAt)) ||
        j.events.some(
          (e: LiveEvent) =>
            !PRINTERS.some((p) => p.name === e.employee) ||
            !Number.isFinite(e.area) ||
            !Number.isFinite(e.quantity),
        )
      )
        throw new Error("source");
      if (!controller.signal.aborted) setValue(j);
    } catch {
      if (!controller.signal.aborted)
        setError("Таблица временно недоступна. Нажмите «Обновить».");
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  }, []);
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
