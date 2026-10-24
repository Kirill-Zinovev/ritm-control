import { useCallback, useEffect, useRef, useState } from "react";
import type { Dataset, Roll } from "./model";
export const PRINTING_URL = import.meta.env.VITE_PRINTING_SOURCE_URL || "";
export const ROLL_PRINTING_URL =
  import.meta.env.VITE_ROLL_PRINTING_SOURCE_URL || "";
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
  sourceId?: string;
  sourceName?: string;
  site?: string;
  spreadsheetId?: string;
  sourceUrl?: string;
};
export type LiveOrder = {
  assemblyShipmentId?: string | null;
  areaKnown?: boolean;
  areaIssue?: string | null;
  rawUid?: string | null;
  uid: string;
  sheetId: number;
  sheetName: string;
  row: number;
  article: string;
  quantity: number;
  plannedArea: number;
  printProgress?: number | null;
  cutProgress?: number | null;
  remainingPrint?: number | null;
  packed?: number | null;
  packingRecords?: number | null;
  sourceId?: string;
  sourceName?: string;
  site?: string;
  spreadsheetId?: string;
  sourceUrl?: string;
};
export type LivePrinting = {
  ok: true;
  schemaVersion: 2;
  updatedAt: string;
  stale?: boolean;
  sourceStatus?: string;
  refreshFailed?: boolean;
  staleReason?: string | null;
  sourceUpdatedAt?: string | null;
  quality?: { status: string; invalidRecords: number };
  packing?: {
    status: "available" | "partial" | "unavailable";
    source: string;
    sourceUrl?: string;
    checkedAt: string;
    sourceUpdatedAt?: string | null;
    eventCount: number;
    invalidRecords: number;
    reason?: string | null;
  };
  events: LiveEvent[];
  cutEvents?: LiveEvent[];
  supplies: LiveOrder[];
  issues: { source: string; row: number; message: string }[];
  sheets: {
    sheetId: number;
    name: string;
    sourceId?: string;
    sourceName?: string;
    spreadsheetId?: string;
    spreadsheetUrl?: string;
  }[];
  sources?: {
    id: string;
    name: string;
    spreadsheetId: string;
    spreadsheetUrl: string;
    journalName: string;
    journalUrl: string;
  }[];
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
    site: e.site || "Красное здание",
    source: e.sheetName,
    sourceId: e.sourceId,
    sheetId: e.sheetId,
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
export function useLivePrinting(enabled = true, refreshSource = false) {
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
      const r = await fetch(
        refreshSource ? "/api/printing?refresh=1" : "/api/printing",
        {
        cache: "no-store",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(45000),
        ]),
        },
      );
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
        (j.packing !== undefined &&
          (![
            "available",
            "partial",
            "unavailable",
          ].includes(j.packing.status) ||
            typeof j.packing.source !== "string" ||
            !Number.isFinite(Date.parse(j.packing.checkedAt)) ||
            !Number.isSafeInteger(j.packing.eventCount) ||
            j.packing.eventCount < 0 ||
            !Number.isSafeInteger(j.packing.invalidRecords) ||
            j.packing.invalidRecords < 0 ||
            (j.packing.sourceUpdatedAt !== null &&
              j.packing.sourceUpdatedAt !== undefined &&
              !Number.isFinite(Date.parse(j.packing.sourceUpdatedAt))))) ||
        j.events.some(
          (e: LiveEvent) =>
            !PRINTERS.some((p) => p.name === e.employee) ||
            !Number.isFinite(e.area) ||
            !Number.isFinite(e.quantity),
        )
      )
        throw new Error(j.message || "Таблица временно недоступна.");
      if (
        j.supplies.some(
          (order: LiveOrder) =>
            order.packed !== undefined &&
            order.packed !== null &&
            (!Number.isSafeInteger(order.packed) || order.packed < 0),
        )
      )
        throw new Error("Некорректные данные упаковки в источнике WorkLog.");
      const cutEvents = Array.isArray(j.cutEvents) ? j.cutEvents : [];
      if (
        cutEvents.some(
          (e: LiveEvent) =>
            !e?.id ||
            !e.uid ||
            !Number.isSafeInteger(e.quantity) ||
            e.quantity <= 0 ||
            !Number.isFinite(e.area),
        )
      )
        throw new Error("source");
      if (!controller.signal.aborted) setValue({ ...j, cutEvents });
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Таблица временно недоступна. Нажмите «Обновить».",
        );
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  }, [refreshSource]);
  useEffect(() => {
    if (!enabled) return;
    void reload();
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
