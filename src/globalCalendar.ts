import type { Planning } from "../shared/productionPlanning";
import type { ForecastRow, ForecastSegment } from "./productionForecastModel";
import { packingPlanWindow } from "./supplyCalendarAxis";

const DAY = 86_400_000;
const OFFSET = 10_800_000;

export type GlobalCalendarKind =
  | "production-deadline" | "packing-deadline" | "shipping-deadline"
  | "print-work" | "cut-work" | "packing-work" | "packing-window";
export type GlobalCalendarEvent = {
  id: string;
  day: number;
  kind: GlobalCalendarKind;
  rowKey: string;
  name: string;
  start: number;
  end: number | null;
  partial: boolean;
  reasons: string[];
};

/** Moscow calendar boundaries, independent of the browser's local time zone. */
export function moscowDay(at: number) {
  return Math.floor((at + OFFSET) / DAY) * DAY - OFFSET;
}
export function moscowMonth(at: number, offset = 0) {
  const date = new Date(at + OFFSET);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1) - OFFSET;
}
export function monthDistance(from: number, to: number) {
  const a = new Date(from + OFFSET), b = new Date(to + OFFSET);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
}
export function monthDays(month: number): Array<number | null> {
  const first = moscowMonth(month), next = moscowMonth(month, 1);
  const weekday = new Date(first + OFFSET).getUTCDay();
  const padding = (weekday + 6) % 7;
  const days = Math.round((next - first) / DAY);
  return Array.from({ length: 42 }, (_, index) => {
    const day = index - padding;
    return day >= 0 && day < days ? first + day * DAY : null;
  });
}

/** Calendar is a read-only projection of saved deadlines and existing forecast segments. */
export function globalCalendarEvents(rows: ForecastRow[], planning: Planning, start: number, end: number, fresh: boolean) {
  const days = new Map<number, GlobalCalendarEvent[]>();
  const grouped = new Map<string, GlobalCalendarEvent>();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return days;
  const addDeadline = (row: ForecastRow, kind: GlobalCalendarKind, raw: string | null | undefined) => {
    if (!raw) return;
    const at = Date.parse(raw);
    if (!Number.isFinite(at) || at < start || at >= end) return;
    const day = moscowDay(at);
    const event: GlobalCalendarEvent = { id: `${row.key}:${kind}`, day, kind, rowKey: row.key, name: row.name, start: at, end: null, partial: false, reasons: [] };
    const list = days.get(day) || [];
    list.push(event);
    days.set(day, list);
  };
  const addWindow = (row: ForecastRow, kind: GlobalCalendarKind, from: number, to: number, partial: boolean, reasons: string[]) => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || from >= end || to <= start) return;
    const first = Math.max(moscowDay(from), moscowDay(start));
    const last = Math.min(moscowDay(to - 1), moscowDay(end - 1));
    for (let day = first; day <= last; day += DAY) {
      const key = JSON.stringify([day, row.key, kind]);
      const previous = grouped.get(key);
      const windowStart = Math.max(from, day), windowEnd = Math.min(to, day + DAY);
      if (previous) {
        previous.start = Math.min(previous.start, windowStart);
        previous.end = Math.max(previous.end || windowEnd, windowEnd);
        previous.partial ||= partial;
      } else grouped.set(key, { id: key, day, kind, rowKey: row.key, name: row.name, start: windowStart, end: windowEnd, partial, reasons });
    }
  };
  const packing = planning.resources.find((resource) => resource.id === "packing");
  for (const row of rows) {
    addDeadline(row, "production-deadline", row.readyAt);
    addDeadline(row, "packing-deadline", row.packingAt);
    addDeadline(row, "shipping-deadline", row.shipAt);
    for (const segment of [...row.segments, ...row.packingSegments] as ForecastSegment[]) {
      const packingPhase = segment.phase === "packing";
      const reasons = packingPhase ? row.packingReasons : row.reasons;
      const kind = segment.phase === "print" ? "print-work" : segment.phase === "cut" ? "cut-work" : "packing-work";
      addWindow(row, kind, segment.start, segment.end, !fresh || reasons.length > 0, reasons);
    }
    if (!row.stock && !row.packingExcluded) {
      const window = packingPlanWindow(row.readyAt, row.packingAt, row.shipAt, packing);
      if (window?.status === "ready") for (const shift of window.shifts)
        addWindow(row, "packing-window", shift.start, shift.end, false, []);
    }
  }
  for (const event of grouped.values()) {
    const list = days.get(event.day) || [];
    list.push(event);
    days.set(event.day, list);
  }
  for (const list of days.values()) list.sort((a, b) => a.start - b.start || Number(!a.kind.endsWith("-deadline")) - Number(!b.kind.endsWith("-deadline")) || a.name.localeCompare(b.name, "ru") || a.kind.localeCompare(b.kind));
  return days;
}
