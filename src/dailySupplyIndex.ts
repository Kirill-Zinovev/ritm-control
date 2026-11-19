import type { ForecastRow, ForecastTask } from "./productionForecastModel";
import type { GlobalCalendarEvent } from "./globalCalendar";

export type DailySupply = { row: ForecastRow; events: GlobalCalendarEvent[] };
export type DailySummary = { supplies: number; deadlines: number; shipments: number; forecast: number; windows: number };

/** Keep identities separate even when supply names happen to match. */
export function suppliesOnDay(rows: ForecastRow[], events: GlobalCalendarEvent[]): DailySupply[] {
  const byKey = new Map<string, GlobalCalendarEvent[]>();
  for (const event of events) {
    const list = byKey.get(event.rowKey) || [];
    list.push(event);
    byKey.set(event.rowKey, list);
  }
  return rows.flatMap((row) => {
    const matched = byKey.get(row.key);
    return matched?.length ? [{ row, events: matched }] : [];
  });
}

/** A forecast window and a planned deadline are not facts or dispatch events. */
export function summarizeDailyEvents(events: GlobalCalendarEvent[]): DailySummary {
  const supplies = new Set<string>();
  let deadlines = 0, shipments = 0, forecast = 0, windows = 0;
  for (const event of events) {
    supplies.add(event.rowKey);
    if (event.kind === "shipping-deadline") shipments++;
    else if (event.kind.endsWith("-deadline")) deadlines++;
    else if (event.kind === "packing-window") windows++;
    else forecast++;
  }
  return { supplies: supplies.size, deadlines, shipments, forecast, windows };
}

/** Explain a shared queue problem once, while counting distinct affected supplies. */
export function dailyForecastIssues(events: GlobalCalendarEvent[]) {
  const affected = new Set<string>();
  const reasons = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.partial) continue;
    affected.add(event.rowKey);
    for (const raw of event.reasons) {
      const message = raw.replace(/^Очередь (?:рассчитана частично|не рассчитана):\s*/u, "").trim();
      if (!message) continue;
      const supplies = reasons.get(message) || new Set<string>();
      supplies.add(event.rowKey);
      reasons.set(message, supplies);
    }
  }
  return {
    affected: affected.size,
    reasons: [...reasons].map(([message, supplies]) => ({ message, affected: supplies.size })),
  };
}

/** Link a diagnosis to a supply only when the source identity is unambiguous. */
export function forecastIssueSource(message: string, tasks: ForecastTask[]): string | null {
  const containsArticle = (article: string) => {
    if (!article) return false;
    let at = message.indexOf(article);
    while (at >= 0) {
      const before = message[at - 1] || "", after = message[at + article.length] || "";
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
      at = message.indexOf(article, at + 1);
    }
    return false;
  };
  const candidates = tasks.filter((task) => containsArticle(task.article));
  const named = candidates.filter((task) => message.includes(`${task.name} · ${task.article}`));
  const keys = new Set((named.length ? named : candidates).map((task) => task.supplyKey));
  return keys.size === 1 ? [...keys][0] : null;
}
