import type { Resource } from "../shared/productionPlanning";
import type { ForecastSegment } from "./productionForecastModel";
const DAY = 86400000,
  OFFSET = 10800000;
export type CalendarPeriod = ForecastSegment & { batches: number };
export type CalendarWorkWindow = {
  start: number;
  end: number;
  pieces: number;
  batches: number;
  hasGaps: boolean;
};
export type PackingPlanWindow = {
  status: "ready" | "schedule-missing" | "no-work" | "invalid" | "too-long";
  start: number;
  end: number;
  endsAt: "packing" | "shipping";
  hours: number;
  shifts: { start: number; end: number }[];
};

/** A planning envelope, not a forecast or a persisted packing deadline. */
export function packingPlanWindow(readyAt: string | null | undefined, packingAt: string | null | undefined, shipAt: string | null | undefined, resource: Resource | undefined): PackingPlanWindow | null {
  if (!readyAt || !shipAt) return null;
  const start = Date.parse(readyAt), shipping = Date.parse(shipAt), end = packingAt ? Date.parse(packingAt) : shipping;
  const result: PackingPlanWindow = { status: "invalid", start, end, endsAt: packingAt ? "packing" : "shipping", hours: 0, shifts: [] };
  if (!Number.isFinite(start) || !Number.isFinite(shipping) || !Number.isFinite(end) || end < start || end > shipping) return result;
  if (!resource || !Array.isArray(resource.days) || !resource.days.length || resource.days.some(day => !Number.isInteger(day) || day < 0 || day > 6) ||
      !Number.isInteger(resource.start) || !Number.isInteger(resource.end) || resource.start < 0 || resource.end > 1440 || resource.end <= resource.start) {
    result.status = "schedule-missing"; return result;
  }
  const firstDay = Math.floor((start + OFFSET) / DAY), lastDay = Math.floor((end + OFFSET) / DAY);
  if (lastDay - firstDay > 366) { result.status = "too-long"; return result; }
  for (let day = firstDay; day <= lastDay; day++) {
    const midnight = day * DAY - OFFSET;
    if (!resource.days.includes(new Date(midnight + OFFSET).getUTCDay())) continue;
    const from = Math.max(start, midnight + resource.start * 60000);
    const to = Math.min(end, midnight + resource.end * 60000);
    if (from < to) result.shifts.push({ start: from, end: to });
  }
  result.hours = result.shifts.reduce((sum, shift) => sum + (shift.end - shift.start) / 3600000, 0);
  result.status = result.shifts.length ? "ready" : "no-work";
  return result;
}

/** Keep the current view if possible; expand it to show a nearby shipping date. */
export function calendarShippingView(now: number, at: number, range: number, offset: number) {
  if (!Number.isFinite(now) || !Number.isFinite(at) || !Number.isInteger(range) || range < 1 || !Number.isInteger(offset))
    return { range, offset };
  const today = Math.floor((now + OFFSET) / DAY), startDay = today + offset;
  const start = startDay * DAY - OFFSET;
  if (at >= start && at < start + range * DAY) return { range, offset };
  const targetDay = Math.floor((at + OFFSET) / DAY), fromToday = targetDay - today;
  if (range < 14 && targetDay >= startDay && targetDay < startDay + 14)
    return { range: 14, offset };
  if (range < 14 && Math.abs(fromToday) < 14)
    return { range: 14, offset: Math.min(0, fromToday) };
  return { range, offset: fromToday };
}

/** Summarize a stage for display without changing its scheduled batches. */
export function calendarWorkWindow(input: ForecastSegment[]): CalendarWorkWindow | null {
  if (!input.length || input.some((part) => !Number.isFinite(part.start) ||
      !Number.isFinite(part.end) || part.end <= part.start ||
      !Number.isFinite(part.pieces) || part.pieces < 0)) return null;
  const sorted = [...input].sort((a, b) => a.start - b.start || a.end - b.end);
  let end = sorted[0].end, hasGaps = false, pieces = 0;
  for (const part of sorted) {
    if (part.start > end) hasGaps = true;
    end = Math.max(end, part.end);
    pieces += part.pieces;
  }
  return { start: sorted[0].start, end, pieces, batches: sorted.length, hasGaps };
}

/** Group nearby batches for display only; the scheduling data stays unchanged. */
export function groupCalendarPeriods(input: ForecastSegment[]): CalendarPeriod[] {
  const grouped: CalendarPeriod[] = [];
  for (const part of [...input].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = grouped[grouped.length - 1];
    const sameDay = last && Math.floor((last.start + OFFSET) / DAY) === Math.floor((part.start + OFFSET) / DAY);
    if (last && sameDay && part.start <= last.end + 15 * 60000) {
      last.end = Math.max(last.end, part.end);
      last.pieces += part.pieces;
      last.article = "Несколько партий";
      last.batches++;
    } else grouped.push({ ...part, batches: 1 });
  }
  return grouped;
}
/** Compress nights and days without shifts while retaining each configured work window. */
export function supplyCalendarAxis(
  start: number,
  range: number,
  resources: Resource[],
) {
  const columns = Array.from({ length: range }, (_, i) => {
    const day = start + i * DAY,
      weekday = new Date(day + OFFSET).getUTCDay();
    const windows = resources.filter(
      (r) =>
        r.days.includes(weekday) &&
        Number.isFinite(r.start) &&
        Number.isFinite(r.end) &&
        r.start >= 0 &&
        r.end <= 1440 &&
        r.end > r.start,
    );
    return {
      day,
      active: windows.length > 0,
      from: windows.length ? Math.min(...windows.map((r) => r.start)) : 0,
      to: windows.length ? Math.max(...windows.map((r) => r.end)) : 1440,
      weight: windows.length ? 1 : 0.7,
      left: 0,
      width: 0,
    };
  });
  const total = columns.reduce((n, c) => n + c.weight, 0);
  let cursor = 0;
  for (const c of columns) {
    c.left = (cursor / total) * 100;
    c.width = (c.weight / total) * 100;
    cursor += c.weight;
  }
  const position = (at: number) => {
    if (at <= start) return 0;
    if (at >= start + range * DAY) return 100;
    const i = Math.floor((at - start) / DAY),
      c = columns[i],
      minutes = (at - c.day) / 60000;
    return (
      c.left +
      Math.max(0, Math.min(1, (minutes - c.from) / (c.to - c.from))) * c.width
    );
  };
  return { columns, position };
}
