import { useCallback, useEffect, useRef, useState } from "react";
import type { Dataset, Period, Roll } from "./model";
import { printingRefreshDelay } from "./printingSnapshotRefresh";
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
  machine?: string | null;
  id: string;
  nativeReceiptId?: string;
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
  sheetsInProduct?: number | null;
  multiplicity?: number | null;
  archived?: boolean;
  boxPositionId?: string | null;
  planningMachine?: string|null;
  planningPrinted?: number|null;
  planningCut?: number|null;
  planningPhysicalUnits?: boolean;
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
  sourceMachine?: string | null;
  machineSource?: "supply" | "catalog" | null;
  machineIssue?: string | null;
  productName?: string | null;
  photoUrl?: string | null;
  printProgress?: number | null;
  cutProgress?: number | null;
  remainingPrint?: number | null;
  packed?: number | null;
  assemblyMachineCut?: number | null;
  assemblyManualCut?: number | null;
  packingRecords?: number | null;
  packedConfirmed?: number | null;
  packingEventIds?: string[] | null;
  shop?: string | null;
  shopCatalogStatus?: "matched" | "missing" | "ambiguous" | "unavailable" | "unknown_marketplace";
  shopCatalogReason?: string | null;
  sourceId?: string;
  sourceName?: string;
  site?: string;
  spreadsheetId?: string;
  sourceUrl?: string;
};
export type BoxSheetReport = {
  status: "available" | "unavailable";
  entered: number;
  total: number | null;
  rows: {
    sheetId: number;
    name: string;
    url: string;
    archived: boolean;
    status: "entered" | "empty" | "missing" | "invalid";
    count: number | null;
  }[];
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
  boxPrinting?: {stockStatus?: string; status: "available" | "unavailable"; reason: string | null; exceptions?: {id: string; date: string; timestamp: string; shipment: string; sheetId: number; article: string; employee: string; kind: "defect" | "surplus"; quantity: number; unit: "sheets" | "pieces" | "unknown"; stage: string; comment: string}[]; events: BoxPrintingEvent[]; cutEvents?: BoxPrintingEvent[]};
  boxSheetReport?: BoxSheetReport;
  events: LiveEvent[];
  cutEvents?: LiveEvent[];
  stockRoll?: {status:string;orders:LiveOrder[];reason?:string|null};
  stockBox?: {status:string;orders:LiveOrder[];reason?:string|null};
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

export type BoxPrintingEvent = {
  machine?: string | null;
  spreadsheetId?: string;
  positionId?: string;
  id: string;
  nativeReceiptId?: string;
  employee: string;
  date: string;
  shipment: string;
  sheetId: number;
  article: string;
  comment?: string;
  quantity: number;
  sheets: number | null;
  area: number | null;
  areaOrigin?: "historical" | "journal";
  journalUrl?: string;
};

type D1PrintingWork = {
  state: "disabled" | "ready" | "syncing" | "stale";
  checkedAt: string | null;
  rollPrint: LiveEvent[];
  rollCut: LiveEvent[];
  boxPrint: BoxPrintingEvent[];
  boxCut: BoxPrintingEvent[];
  corrections: number;
};

export function useD1PrintingWork(enabled: boolean, date: string, period: Period) {
  const month = date.slice(0, 7);
  const weekStart = new Date(date + "T12:00:00Z");
  weekStart.setUTCDate(weekStart.getUTCDate() - (weekStart.getUTCDay() + 6) % 7);
  const previousMonth = period === "week" && Number.isFinite(weekStart.getTime())
    ? weekStart.toISOString().slice(0, 7) : month;
  const [work, setWork] = useState<{ key: string; value: D1PrintingWork } | null>(null);
  const key = previousMonth + "/" + month;
  useEffect(() => {
    if (!enabled) return;
    const months = [...new Set([previousMonth, month])];
    const abort = new AbortController();
    let timer: number | undefined;
    let checking = false;
    const empty = { checkedAt: null, rollPrint: [], rollCut: [], boxPrint: [], boxCut: [], corrections: 0 };
    const pages = new Map<string, D1PrintingWork>();
    const read = async (month: string) => {
      try {
        const params = new URLSearchParams({ view: "work", month });
        const response = await fetch("/api/printing?" + params, {
          cache: "no-store",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(16000)]),
        });
        if (!response.ok) throw new Error("Printing work unavailable");
        const value: D1PrintingWork = await response.json();
        if (!["disabled", "ready", "syncing", "stale"].includes(value?.state) ||
          ![value.rollPrint, value.rollCut, value.boxPrint, value.boxCut].every(Array.isArray))
          throw new Error("Invalid printing work");
        pages.set(month, value);
      } catch {
        pages.set(month, { ...(pages.get(month) ?? empty), state: "stale" });
      }
    };
    const check = async () => {
      if (checking || abort.signal.aborted || document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      checking = true;
      let poll = true;
      try {
        await Promise.all(months.map(read));
        if (abort.signal.aborted) return;
        const values = [...pages.values()];
        const state = values.every(value => value.state === "disabled") ? "disabled"
          : values.some(value => value.state === "stale") ? "stale"
          : values.some(value => value.state === "syncing") ? "syncing" : "ready";
        poll = state !== "disabled";
        setWork({
          key, value: {
            state, checkedAt: values.map(value => value.checkedAt).filter(Boolean).sort().at(0) ?? null,
            rollPrint: values.flatMap(value => value.rollPrint), rollCut: values.flatMap(value => value.rollCut),
            boxPrint: values.flatMap(value => value.boxPrint), boxCut: values.flatMap(value => value.boxCut),
            corrections: values.reduce((sum, value) => sum + value.corrections, 0),
          },
        });
      } finally {
        checking = false;
        if (poll && !abort.signal.aborted) timer = window.setTimeout(check, 10000);
      }
    };
    void check();
    document.addEventListener("visibilitychange", check);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [enabled, key, month, previousMonth]);
  return enabled && work?.key === key ? work.value : null;
}

function mergeWork<T extends LiveEvent | BoxPrintingEvent>(legacy: T[], additions: T[]) {
  const identity = (event: T, receipt: string) => JSON.stringify([
    event.spreadsheetId, event.sheetId, receipt, event.date, event.article,
    event.employee, event.quantity, event.area,
    "roll" in event ? event.roll : null,
  ]);
  const ids = new Set(legacy.map(event => event.id));
  const mirrored = new Set(legacy.flatMap(event => {
    const receipt = event.id.replace(/^journal:(?:(?:roll-printing|stock-roll):)?(?:cut:)?/, "");
    return event.spreadsheetId ? [identity(event, receipt)] : [];
  }));
  const work = [...legacy];
  for (const event of additions) {
    if (ids.has(event.id)) continue;
    ids.add(event.id);
    if (!event.nativeReceiptId || !mirrored.delete(identity(event, event.nativeReceiptId))) work.push(event);
  }
  return work;
}

export function printingWorkView(live: LivePrinting | null, work: D1PrintingWork | null): LivePrinting | null {
  if (!work || work.state === "disabled" || (!live && !work.checkedAt)) return live;
  const box = live?.boxPrinting;
  return {
    ...(live ?? { ok: true, schemaVersion: 2, updatedAt: work.checkedAt ?? "", supplies: [], sheets: [], issues: [] }),
    events: mergeWork(live?.events || [], work.rollPrint),
    cutEvents: mergeWork(live?.cutEvents || [], work.rollCut),
    boxPrinting: box || work.boxPrint.length || work.boxCut.length ? {
      ...box,
      status: box?.status === "available" || work.boxPrint.length || work.boxCut.length ? "available" : "unavailable",
      reason: box?.reason ?? null,
      events: mergeWork(box?.events || [], work.boxPrint),
      cutEvents: mergeWork(box?.cutEvents || [], work.boxCut),
    } : undefined,
  };
}

export function printingPeople(live: LivePrinting | null) {
  const people = new Map(PRINTERS.map(person => [person.name, person]));
  for (const event of live?.events || [])
    if (!people.has(event.employee)) people.set(event.employee, {
      id: `printer-d1-${encodeURIComponent(event.employee)}`,
      name: event.employee,
    });
  return [...people.values()];
}

export function printingDataset(
  base: Dataset,
  live: LivePrinting | null,
): Dataset {
  const people = new Map(printingPeople(live).map(person => [person.name, person]));
  const printerIds = new Set([...people.values()].map(person => person.id));
  const rolls: Roll[] = (live?.events || []).map((e) => ({
    id: e.id,
    roll: e.roll,
    employee: people.get(e.employee)!.id,
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
      ...base.employees.filter((e) => !printerIds.has(e.id)),
      ...people.values(),
    ],
    rolls,
  };
}
export function useLivePrinting(enabled = true, { refreshOnOpen = false } = {}) {
  const [value, setValue] = useState<LivePrinting | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const retryTimer = useRef<number | null>(null);
  const pending = useRef(false);
  const pendingForce = useRef(false);
  const displayed = useRef(false);
  const queuedResolvers = useRef<(() => void)[]>([]);
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
      // A mutation caller must await the queued fresh read, rather than return
      // immediately while an older periodic request is still in flight.
      return new Promise<void>(resolve => queuedResolvers.current.push(resolve));
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
        force ? "/api/printing?refresh=1" : displayed.current ? "/api/printing" : "/api/printing?view=last-confirmed",
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
        displayed.current = true;
        setValue({ ...j, cutEvents });
        if (j.refreshOnOpen === true) pending.current = true;
        if (j.stale === true) {
          // A valid stale response has its own notice. Only failed requests
          // use the error channel; duplicating staleReason shows two banners.
          setError("");
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
          const resolvers=queuedResolvers.current.splice(0);
          window.setTimeout(() => void reloadRef.current(nextForce).finally(() => resolvers.forEach(resolve=>resolve())), 0);
        }
      }
    }
  }, [scheduleRetry]);
  reloadRef.current = reload;
  useEffect(() => {
    if (!enabled || !value || value.stale || value.refreshInProgress) return;
    const delay = printingRefreshDelay(value.snapshotAt || value.updatedAt);
    if (delay === null) return;
    // Refresh just before the write guard expires, even if the snapshot was
    // already several minutes old when this tab first received it.
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible") void reload(true);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [enabled, reload, value?.snapshotAt, value?.updatedAt, value?.stale, value?.refreshInProgress]);
  useEffect(() => {
    if (!enabled) return;
    const updateIfVisible = () => {
      if (document.visibilityState === "visible") void reload(false);
    };
    const revalidate = () => {
      // Show the saved snapshot during the first source read. The same reload
      // queue starts the fresh request as soon as that snapshot is displayed.
      if (refreshOnOpen && !displayed.current && !active.current) void reload(false);
      void reload(refreshOnOpen);
    };
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    revalidate();
    const timer = window.setInterval(updateIfVisible, 300000);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOnReturn);
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [reload, enabled, refreshOnOpen]);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    let checking = false, observed: string | null = null, delay = 5000;
    let timer: number | undefined;
    const check = async () => {
      if (checking || abort.signal.aborted || document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      checking = true;
      try {
        const response = await fetch("/api/printing/revision", {cache:"no-store",signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
        if (!response.ok) return;
        const data = await response.json();
        if (typeof data.revision !== "string") return;
        const changed = observed !== null && observed !== data.revision;
        delay = refreshOnOpen || changed || data.refreshNeeded || observed === null ? 5000 : Math.min(delay + 5000, 20000);
        if (changed || data.refreshNeeded === true) {
          if (!active.current) { observed = data.revision; void reload(false); }
        } else observed = data.revision;
      } catch { /* Preserve the loaded snapshot; the next visible poll retries. */ }
      finally {
        checking = false;
        if (!abort.signal.aborted) timer = window.setTimeout(() => void check(), delay);
      }
    };
    void check();
    const visible = () => {if(document.visibilityState === "visible") void check();};
    document.addEventListener("visibilitychange",visible);
    window.addEventListener("online",visible);
    return () => {abort.abort();window.clearTimeout(timer);document.removeEventListener("visibilitychange",visible);window.removeEventListener("online",visible);};
  },[enabled,reload,refreshOnOpen]);
  return { value, loading, error, reload };
}
