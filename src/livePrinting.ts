import { useCallback, useEffect, useRef, useState } from "react";
import type { Dataset, Roll } from "./model";
export const PRINTING_URL = import.meta.env.VITE_PRINTING_SOURCE_URL || "";
export const ROLL_PRINTING_URL =
  import.meta.env.VITE_ROLL_PRINTING_SOURCE_URL || "";
export const PRINTERS = [
  { id: "printer-dmitry", name: "Дмитрий" },
  { id: "printer-pavel", name: "Павел" },
  { id: "printer-pasha", name: "Паша" },
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
  extension?: string | null;
  quantity: number;
  plannedArea: number;
  machine?: string | null;
  machineSource?: "supply" | "catalog" | null;
  machineIssue?: string | null;
  productName?: string | null;
  photoUrl?: string | null;
  printProgress?: number | null;
  cutProgress?: number | null;
  remainingPrint?: number | null;
  packed?: number | null;
  packingRecords?: number | null;
  shop?: string | null;
  shopCatalogStatus?: "matched" | "missing" | "ambiguous" | "unavailable" | "unknown_marketplace";
  shopCatalogReason?: string | null;
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
  snapshotAt?: string;
  stale?: boolean;
  sourceStatus?: string;
  refreshFailed?: boolean;
  refreshInProgress?: boolean;
  refreshRetryAfterMs?: number;
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
  shopCatalog?: {
    status: "available" | "partial" | "unavailable";
    matched: number;
    missing: number;
    ambiguous: number;
  };
  boxPrinting?: {status: "available" | "unavailable"; reason: string | null; exceptions?: {id: string; date: string; timestamp: string; shipment: string; sheetId: number; article: string; employee: string; kind: "defect" | "surplus"; quantity: number; unit: "sheets" | "pieces" | "unknown"; stage: string; comment: string}[]; events: {id: string; employee: string; date: string; shipment: string; sheetId: number; article: string; comment?: string; quantity: number; sheets: number | null; area: number | null}[]};
  events: LiveEvent[];
  cutEvents?: LiveEvent[];
  supplies: LiveOrder[];
  issues: { source: string; row: number; message: string }[];
  sheets: {
    assemblyShipmentId?: string | null;
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
export function useLivePrinting(enabled = true) {
  const [value, setValue] = useState<LivePrinting | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const retryTimer = useRef<number | null>(null);
  const pending = useRef(false);
  const pendingForce = useRef(false);
  const reloadRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const scheduleRetry = useCallback((delayMs: number) => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null;
      if (document.visibilityState === "visible") void reloadRef.current(false);
    }, delayMs + Math.floor(Math.random() * 5000));
  }, []);
  const reload = useCallback(async (force = false) => {
    if (active.current) {
      pending.current = true;
      pendingForce.current ||= force;
      return;
    }
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError("");
    try {
      const r = await fetch(
        force ? "/api/printing?refresh=1" : "/api/printing",
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
        (j.shopCatalog !== undefined &&
          (!j.shopCatalog ||
            !["available", "partial", "unavailable"].includes(
              j.shopCatalog.status,
            ) ||
            !["matched", "missing", "ambiguous"].every(
              (key) =>
                Number.isSafeInteger(j.shopCatalog[key]) &&
                j.shopCatalog[key] >= 0,
            ))) ||
        !Number.isFinite(Date.parse(j.updatedAt)) ||
        (j.packing !== undefined &&
          (!["available", "partial", "unavailable"].includes(
            j.packing.status,
          ) ||
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
      if (!controller.signal.aborted) {
        setValue({ ...j, cutEvents });
        if (j.stale === true) {
          setError(j.staleReason || "Данные устарели. Повторяю обновление.");
          scheduleRetry(
            Number.isFinite(j.refreshRetryAfterMs)
              ? Math.max(5000, Math.min(120000, j.refreshRetryAfterMs))
              : j.refreshInProgress
                ? 15000
                : 60000,
          );
        } else {
          setError("");
          if (j.refreshInProgress === true) {
            scheduleRetry(
              Number.isFinite(j.refreshRetryAfterMs)
                ? Math.max(5000, Math.min(120000, j.refreshRetryAfterMs))
                : 15000,
            );
          }
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error
          ? cause.message
          : "Таблица временно недоступна. Повторяю проверку.";
        setError(message);
        if (!/войдите|доступ не подтверждён/i.test(message)) scheduleRetry(60000);
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
        if (pending.current) {
          const nextForce = pendingForce.current;
          pending.current = false;
          pendingForce.current = false;
          window.setTimeout(() => void reloadRef.current(nextForce), 0);
        }
      }
    }
  }, [scheduleRetry]);
  reloadRef.current = reload;
  useEffect(() => {
    if (!enabled) return;
    const updateIfVisible = () => {
      if (document.visibilityState === "visible") void reload(false);
    };
    void reload(false);
    const timer = window.setInterval(updateIfVisible, 300000);
    document.addEventListener("visibilitychange", updateIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", updateIfVisible);
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [reload, enabled]);
  useEffect(() => () => active.current?.abort(), []);
  return { value, loading, error, reload };
}
