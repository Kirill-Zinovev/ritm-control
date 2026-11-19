import type {
  Deadlines,
  Resource,
  Planning,
} from "../shared/productionPlanning";

export type ForecastTask = {
  id: string;
  supplyKey: string;
  name: string;
  article: string;
  machine: string;
  department: "roll" | "box";
  plan: number;
  printed: number | null;
  cut: number | null;
  // Owner-confirmed completion for forecasting only, never a work-log event.
  cutConfirmation?: { quantity: number; sourceCut: number; recordedAt: string; recordedBy: string };
  unconfirmedPrintExcess?: boolean;
  unconfirmedCutExcess?: boolean;
  packed?: number | null;
  // Confirmed packed goods from stock, including any quantity above plan.
  stockPacked?: number;
  packingEventIds?: string[] | null;
  assemblyOnly?: boolean;
  packingExcluded?: boolean;
  stockPositionId?: string;
  areaPerPiece: number | null;
  sheetsPerPiece: number | null;
  stock: boolean;
  urgent: boolean;
};
export type ForecastSupply = {
  key: string;
  name: string;
  plan: number;
  printed: number | null;
  cut: number | null;
  stock: boolean;
  urgent: boolean;
  market?: string | null;
};
export type ForecastInput = {
  tasks: ForecastTask[];
  supplies: ForecastSupply[];
  issues: string[];
  fresh: boolean;
  packingFresh?: boolean;
  packingIssues?: string[];
};
export function confirmedStockPacked(task: ForecastTask): number | null {
  if (task.stockPacked === undefined) return 0;
  return Number.isSafeInteger(task.stockPacked) && task.stockPacked >= 0 &&
    task.packed != null && Number.isFinite(task.packed) && task.stockPacked <= task.packed &&
    Number.isFinite(task.plan) && task.plan >= 0
    ? Math.min(task.stockPacked, task.plan)
    : null;
}
export type ForecastSegment = {
  resource: string;
  taskId: string;
  supplyKey: string;
  article: string;
  phase: "print" | "cut" | "packing";
  start: number;
  end: number;
  pieces: number;
};
export type ForecastRow = ForecastSupply &
  Deadlines & {
    printAt: number | null;
    finishAt: number | null;
    margin: number | null;
    status: "done" | "on-time" | "risk" | "late" | "unknown" | "no-deadline";
    reasons: string[];
    bottleneck: string | null;
    segments: ForecastSegment[];
    packingFinishAt: number | null;
    packingMargin: number | null;
    packingStatus:
      | "done"
      | "on-time"
      | "risk"
      | "late"
      | "unknown"
      | "no-deadline";
    packingReasons: string[];
    packingSegments: ForecastSegment[];
    packingExcluded?: boolean;
  };
export function overallForecastStatus(row: ForecastRow): ForecastRow["status"] {
  const production = row.status,
    packing = row.packingStatus;
  if (row.packingExcluded) return production;
  if (production === "late" || packing === "late") return "late";
  if (production === "unknown" || packing === "unknown") return "unknown";
  if (production === "no-deadline" || packing === "no-deadline")
    return "no-deadline";
  if (production === "risk" || packing === "risk") return "risk";
  if (production === "done" && packing === "done") return "done";
  return "on-time";
}
const DAY = 86400000,
  OFFSET = 10800000;
export function moscowInput(value: string | null | undefined) {
  return value
    ? new Date(Date.parse(value) + OFFSET).toISOString().slice(0, 16)
    : "";
}
export const inputInstant = (value: string) =>
  value ? new Date(value + ":00+03:00").toISOString() : null;

/** Consume minutes in Moscow shifts. Overnight windows are deliberately not guessed. */
export function workSegments(
  after: number,
  minutes: number,
  resource: Resource,
): { start: number; end: number }[] | null {
  if (
    !Number.isFinite(after) ||
    !Number.isFinite(minutes) ||
    minutes < 0 ||
    !resource.days.length ||
    resource.end <= resource.start
  )
    return null;
  if (minutes < 1e-9) return [];
  const result: { start: number; end: number }[] = [];
  let cursor = after,
    remaining = minutes * 60000;
  // A bounded one-year horizon avoids a frozen browser for invalid capacity.
  for (let i = 0; i < 367 && remaining > 0.001; i++) {
    const localDay = Math.floor((cursor + OFFSET) / DAY) * DAY - OFFSET;
    const day = new Date(localDay + OFFSET).getUTCDay();
    if (resource.days.includes(day)) {
      const start = Math.max(cursor, localDay + resource.start * 60000),
        close = localDay + resource.end * 60000;
      if (start < close) {
        const end = Math.min(close, start + remaining);
        result.push({ start, end });
        remaining -= end - start;
        if (remaining <= 0.001) return result;
      }
    }
    cursor = localDay + DAY;
  }
  return null;
}

/** One deterministic shared queue for the list, details and calendar. No source writes. */
export function buildForecast(
  input: ForecastInput,
  planning: Planning,
  now: number,
  rateProblems: Record<string, { label: string; reason: string }> = {},
): ForecastRow[] {
  const resources = new Map(planning.resources.map((r) => [r.id, r]));
  const rows = new Map<string, ForecastRow>(
    input.supplies.map((s) => [
      s.key,
      {
        ...s,
        ...(planning.deadlines[s.key] || { readyAt: null, shipAt: null }),
        printAt: null,
        finishAt: null,
        margin: null,
        status: "unknown",
        reasons: [],
        bottleneck: null,
        segments: [],
        packingFinishAt: null,
        packingMargin: null,
        packingStatus: "unknown",
        packingReasons: [],
        packingSegments: [],
      },
    ]),
  );
  const reason = (key: string, message: string) => {
    const r = rows.get(key);
    if (r && !r.reasons.includes(message)) r.reasons.push(message);
  };
  const ranks = new Map(
    [...rows.values()]
      .sort(
        (a, b) =>
          Number(b.urgent) - Number(a.urgent) ||
          (Date.parse(a.readyAt || "") || Infinity) -
            (Date.parse(b.readyAt || "") || Infinity) ||
          a.key.localeCompare(b.key),
      )
      .map((r, i) => [r.key, i]),
  );
  const tasks = [...input.tasks].sort(
    (a, b) =>
      ranks.get(a.supplyKey)! - ranks.get(b.supplyKey)! ||
      a.id.localeCompare(b.id),
  );
  const cursor = new Map<string, number>(),
    blocked = new Map<string, string>(),
    seen = new Set<string>();
  const cuts: {
    task: ForecastTask;
    ready: number;
    pieces: number;
    rank: number;
  }[] = [];
  const unitCount = (t: ForecastTask, pieces: number, r: Resource) =>
    r.unit === "pieces"
      ? pieces
      : r.unit === "area"
        ? t.areaPerPiece === null
          ? null
          : pieces * t.areaPerPiece
        : t.sheetsPerPiece === null
          ? null
          : pieces * t.sheetsPerPiece;
  const schedule = (
    t: ForecastTask,
    resourceId: string,
    phase: "print" | "cut",
    pieces: number,
    ready: number,
  ): number | null => {
    if (pieces <= 1e-8) return ready;
    const r = resources.get(resourceId),
      prior = blocked.get(resourceId);
    const display = rateProblems[resourceId]?.label || resourceId;
    // Unknown earlier work makes the shared finish uncertain, but later
    // validated work can still be shown as a provisional queue.
    // Propagate the reason to every affected supply so none receives a
    // definitive production or packing deadline from these partial segments.
    const partialQueue = !!prior && !!r &&
      Number.isFinite(r.rate) && r.rate > 0;
    if (partialQueue) reason(t.supplyKey, `Очередь рассчитана частично: ${prior}`);
    let message = prior && !partialQueue
      ? `Очередь не рассчитана: ${prior}`
      : !r
        ? `Настройте скорость и график: ${display}`
        : !Number.isFinite(r.rate) || r.rate <= 0
          ? `${display}: ${rateProblems[resourceId]?.reason || (r.rateMode === "auto" ? "недостаточно данных для автоматической скорости." : "укажите скорость участка.")}`
          : "";
    const units = r ? unitCount(t, pieces, r) : null;
    if (!message && units === null)
      message =
        r?.unit === "sheets"
          ? `${t.article}: нет кратности или числа листов Xerox`
          : `${t.article}: площадь не подтверждена`;
    if (message) {
      reason(t.supplyKey, message);
      if (!prior) blocked.set(resourceId, message);
      return null;
    }
    const spans = workSegments(
      Math.max(ready, cursor.get(resourceId) || now),
      (units! / r!.rate) * 60,
      r!,
    );
    if (!spans?.length) {
      const m = `${resourceId}: расчёт выходит за горизонт одного года`;
      reason(t.supplyKey, m);
      blocked.set(resourceId, m);
      return null;
    }
    for (const s of spans)
      rows.get(t.supplyKey)?.segments.push({
        ...s,
        resource: resourceId,
        phase,
        taskId: t.id,
        supplyKey: t.supplyKey,
        article: t.article,
        pieces: (pieces * (s.end - s.start)) / ((units! / r!.rate) * 3600000),
      });
    const end = spans[spans.length - 1].end;
    cursor.set(resourceId, end);
    return end;
  };
  let unassigned = false;
  for (const t of tasks) {
    const cutId = `cut-${t.department}`;
    if (seen.has(t.id)) {
      reason(t.supplyKey, `${t.article}: повторяется ID позиции`);
      unassigned = true;
      continue;
    }
    seen.add(t.id);
    if (!Number.isFinite(t.plan) || t.plan < 0) {
      reason(t.supplyKey, `${t.article}: не подтверждён план`);
      unassigned = true;
      continue;
    }
    if (
      t.printed !== null &&
      t.cut !== null &&
      t.printed >= t.plan &&
      t.cut >= t.plan
    )
      continue;
    if (
      t.printed === null ||
      t.cut === null ||
      !Number.isFinite(t.printed) ||
      !Number.isFinite(t.cut) ||
      t.printed < 0 ||
      t.cut < 0 ||
      Math.min(t.cut, t.plan) > Math.min(t.printed, t.plan)
    ) {
      const missing = [
        t.printed === null ? "печати" : "",
        t.cut === null ? "порезки" : "",
      ].filter(Boolean);
      const m = missing.length
        ? `${t.article}: не подтверждено количество ${missing.join(" и ")}`
        : t.printed !== null && t.cut !== null &&
            Number.isFinite(t.printed) && Number.isFinite(t.cut) &&
            t.printed >= 0 && t.cut >= 0 &&
            Math.min(t.cut, t.plan) > Math.min(t.printed, t.plan)
          ? `${t.article}: порезано ${t.cut} шт., а печать отмечена на ${t.printed} шт. Сверьте отметку печати.`
        : `${t.article}: некорректные количества печати и порезки`;
      reason(t.supplyKey, m);
      if (
        t.printed === null ||
        !Number.isFinite(t.printed) ||
        t.printed < 0 ||
        t.printed < t.plan
      ) {
        if (t.machine) blocked.set(t.machine, m);
        else unassigned = true;
      }
      // A confirmed fully cut plan needs no further cutting capacity, even
      // if its printing mark is inconsistent. Keep the print discrepancy
      // visible and block its machine, but do not invent more cutting work.
      if (
        t.cut === null ||
        !Number.isFinite(t.cut) ||
        t.cut < 0 ||
        t.cut < t.plan
      )
        blocked.set(cutId, m);
      continue;
    }
    if (!resources.has(t.machine)) {
      if (!t.machine) {
        reason(t.supplyKey, `${t.article}: станок не определён`);
        unassigned = true;
        blocked.set(cutId, `${t.article}: неизвестен станок`);
        continue;
      }
    }
    const printed = Math.min(t.plan, t.printed),
      cut = Math.min(t.plan, t.cut),
      pending = t.plan - printed;
    if (printed > cut)
      cuts.push({
        task: t,
        ready: now,
        pieces: printed - cut,
        rank: ranks.get(t.supplyKey)!,
      });
    if (pending > 0) {
      const n = Math.min(10, Math.max(1, Math.ceil(pending))),
        size = pending / n;
      for (let i = 0; i < n; i++) {
        const end = schedule(t, t.machine, "print", size, now);
        if (end === null) {
          const printCause = blocked.get(t.machine);
          blocked.set(cutId, `${t.article}: срок печати не определён${printCause ? ` · ${printCause}` : ""}`);
          break;
        }
        // A provisional print batch cannot make the shared cutter's queue
        // definitive: omitted earlier print work may reach it at any time.
        if (blocked.has(t.machine) && !blocked.has(cutId))
          blocked.set(cutId, `${t.article}: очередь печати рассчитана частично`);
        cuts.push({
          task: t,
          ready: end,
          pieces: size,
          rank: ranks.get(t.supplyKey)!,
        });
      }
    }
  }
  // Separate cutting resources; available batches overlap with continuing printing.
  for (const department of ["roll", "box"]) {
    const resource = `cut-${department}`;
    const queue = cuts
      .filter((c) => c.task.department === department)
      .sort((a, b) => a.ready - b.ready || a.rank - b.rank);
    type Batch = (typeof queue)[number];
    const heap: Batch[] = [],
      compare = (a: Batch, b: Batch) =>
        a.rank - b.rank ||
        a.ready - b.ready ||
        a.task.id.localeCompare(b.task.id);
    const push = (v: Batch) => {
      heap.push(v);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (compare(heap[p], heap[i]) <= 0) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const v = heap[0],
        last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          let n = i,
            l = i * 2 + 1,
            r = l + 1;
          if (l < heap.length && compare(heap[l], heap[n]) < 0) n = l;
          if (r < heap.length && compare(heap[r], heap[n]) < 0) n = r;
          if (n === i) break;
          [heap[n], heap[i]] = [heap[i], heap[n]];
          i = n;
        }
      }
      return v;
    };
    let time = now,
      index = 0;
    while (index < queue.length || heap.length) {
      if (!heap.length && index < queue.length)
        time = Math.max(time, queue[index].ready);
      while (index < queue.length && queue[index].ready <= time + 0.01)
        push(queue[index++]);
      const next = pop();
      const end = schedule(next.task, resource, "cut", next.pieces, time);
      if (end !== null) time = end;
    }
  }
  for (const row of rows.values()) {
    const owned = tasks.filter((t) => t.supplyKey === row.key);
    const complete =
      owned.length > 0 &&
      owned.every(
        (t) =>
          t.printed !== null &&
          t.cut !== null &&
          t.printed >= t.plan &&
          t.cut >= t.plan,
      ) &&
      !row.reasons.length;
    if (complete) {
      row.status = "done";
      continue;
    }
    if (!input.fresh)
      reason(row.key, "Рабочие данные устарели или ещё не загружены");
    for (const issue of input.issues) reason(row.key, issue);
    if (unassigned)
      reason(
        row.key,
        "В общей очереди есть позиции с неподтверждённым станком или ID",
      );
    if (row.reasons.length) continue;
    const print = row.segments.filter((s) => s.phase === "print");
    row.printAt = print.length ? Math.max(...print.map((s) => s.end)) : now;
    row.finishAt = row.segments.length
      ? Math.max(...row.segments.map((s) => s.end))
      : now;
    row.bottleneck =
      row.segments.find((s) => s.end === row.finishAt)?.resource || null;
    if (!row.readyAt) {
      row.status = "no-deadline";
      continue;
    }
    row.margin = (Date.parse(row.readyAt) - row.finishAt) / 3600000;
    row.status = row.margin < 0 ? "late" : row.margin < 2 ? "risk" : "on-time";
  }
  schedulePacking(
    [...rows.values()].sort((a, b) => ranks.get(a.key)! - ranks.get(b.key)!),
    tasks,
    planning,
    now,
    !!input.packingFresh && input.fresh && !input.issues.length,
    (input.packingIssues || []).join(" "),
    rateProblems.packing?.reason || "",
  );
  return [...rows.values()].sort(
    (a, b) => ranks.get(a.key)! - ranks.get(b.key)!,
  );
}

/** A single shared packing queue receives already cut pieces and future cut batches. */
export function schedulePacking(
  rows: ForecastRow[],
  tasks: ForecastTask[],
  planning: Planning,
  now: number,
  fresh: boolean,
  extraIssue = "",
  packingRateReason = "",
) {
  const active = tasks.filter((t) => !t.packingExcluded);
  const idCounts = new Map<string, number>();
  for (const t of active) idCounts.set(t.id, (idCounts.get(t.id) || 0) + 1);
  const byId = new Set<string>();
  const invalid = active.find((t) => {
    if (byId.has(t.id)) return true;
    byId.add(t.id);
    if (
      !Number.isFinite(t.plan) ||
      t.plan < 0 ||
      t.packed == null ||
      !Number.isFinite(t.packed) ||
      t.packed < 0 ||
      confirmedStockPacked(t) === null
    ) return true;
    // Already packed goods leave no future work in the packing queue. They
    // may have come from stock before this production task was completed.
    if (t.packed >= t.plan) return false;
    return (
      t.cut == null ||
      !Number.isFinite(t.cut) ||
      t.cut < 0 ||
      Math.min(t.packed, t.plan) > Math.min(t.cut, t.plan) + confirmedStockPacked(t)!
    );
  });
  const config = planning.resources.find((r) => r.id === "packing");
  const upstreamUncertain = rows.some(
    (r) =>
      r.reasons.length &&
      active.some(
        (t) =>
          t.supplyKey === r.key &&
          (t.packed == null || t.packed < t.plan) &&
          // Packing only needs already cut pieces. An unresolved printing
          // mark cannot delay packing when the whole plan is confirmed cut.
          (t.cut == null || t.cut < t.plan),
      ),
  );
  const globalIssue =
    extraIssue ||
    (!fresh
      ? "Нет свежих подтверждённых данных упаковки и очереди."
      : invalid
        ? invalid.packed != null && invalid.cut != null &&
          Number.isFinite(invalid.packed) && Number.isFinite(invalid.cut) &&
          Math.min(invalid.packed, invalid.plan) > Math.min(invalid.cut, invalid.plan) + (confirmedStockPacked(invalid) ?? 0)
          ? `${invalid.name} · ${invalid.article}: в учёте упаковано ${invalid.packed} шт., порезано ${invalid.cut} шт. Сверьте отметки.`
          : `${invalid.name} · ${invalid.article}: не подтверждены данные упаковки или порезки.`
        : upstreamUncertain
          ? "Не подтверждена общая очередь печати и порезки."
          : !config ||
              config.unit !== "pieces" ||
              !Number.isFinite(config.rate) ||
              config.rate <= 0
            ? packingRateReason || "Укажите рабочий график и скорость упаковки."
            : "");
  // Uncertain work elsewhere can make the final shared finish unknown, but
  // it must not erase useful intervals for independently confirmed pieces.
  // Those intervals remain provisional until the entire queue is confirmed.
  const canSchedulePartial =
    fresh && !extraIssue && !!config && config.unit === "pieces" &&
    Number.isFinite(config.rate) && config.rate > 0;
  const canUsePackingTask = (t: ForecastTask) =>
    idCounts.get(t.id) === 1 && Number.isFinite(t.plan) && t.plan >= 0 &&
    t.packed != null && Number.isFinite(t.packed) && t.packed >= 0 && confirmedStockPacked(t) !== null &&
    (t.packed >= t.plan || (
      t.cut != null && Number.isFinite(t.cut) && t.cut >= 0 &&
      Math.min(t.packed, t.plan) <= Math.min(t.cut, t.plan) + confirmedStockPacked(t)!
    ));
  const candidates: {
    task: ForecastTask;
    ready: number;
    pieces: number;
    rank: number;
  }[] = [];
  const priority = new Map(
    [...rows]
      .sort(
        (a, b) =>
          Number(b.urgent) - Number(a.urgent) ||
          (Date.parse(a.packingAt || "") || Infinity) -
            (Date.parse(b.packingAt || "") || Infinity) ||
          (Date.parse(a.readyAt || "") || Infinity) -
            (Date.parse(b.readyAt || "") || Infinity) ||
          a.key.localeCompare(b.key),
      )
      .map((row, index) => [row.key, index]),
  );
  rows.forEach((row) => {
    const rank = priority.get(row.key)!;
    const owned = active.filter((t) => t.supplyKey === row.key);
    if (!owned.length) {
      const allOwned = tasks.filter((t) => t.supplyKey === row.key);
      row.packingExcluded =
        allOwned.length > 0 && allOwned.every((t) => t.packingExcluded);
      if (!row.packingExcluded)
        row.packingReasons.push("Нет подтверждённых позиций для упаковки.");
      return;
    }
    if (owned.every((t) => t.packed != null && t.packed >= t.plan)) {
      row.packingStatus = "done";
      return;
    }
    if (globalIssue) {
      row.packingReasons.push(globalIssue);
      if (!canSchedulePartial) return;
    }
    for (const task of owned) {
      if (!canUsePackingTask(task)) continue;
      const pending = Math.max(0, task.plan - task.packed!);
      if (!pending) continue;
      const stockPacked = confirmedStockPacked(task)!;
      const available = Math.max(
        0,
        Math.min(pending, Math.min(task.plan, task.cut!) + stockPacked - Math.min(task.plan, task.packed!)),
      );
      if (available)
        candidates.push({ task, ready: now, pieces: available, rank });
      const cut = Math.min(task.plan, task.cut!);
      if (cut < task.plan) {
        if (row.reasons.length) {
          row.packingReasons.push(
            `${task.article}: срок порезки не подтверждён.`,
          );
          continue;
        }
        const parts = row.segments.filter(
          (s) => s.phase === "cut" && s.taskId === task.id,
        );
        const pieces = parts.reduce((n, s) => n + s.pieces, 0);
        let needed = Math.min(task.plan - cut, pending - available);
        if (pieces + 0.001 < needed) {
          row.packingReasons.push(
            `${task.article}: не подтверждена очередь порезки.`,
          );
          continue;
        }
        for (const part of parts) {
          const count = Math.min(needed, part.pieces);
          if (count > 0) candidates.push({ task, ready: part.end, pieces: count, rank });
          needed -= count;
        }
      }
    }
  });
  // A missing earlier batch makes the shared queue uncertain for every unfinished supply.
  if (
    rows.some(
      (r) =>
        r.packingReasons.length && active.some((t) => t.supplyKey === r.key),
    )
  ) {
    for (const row of rows)
      if (!row.packingExcluded && row.packingStatus !== "done" && !row.packingReasons.length)
        row.packingReasons.push(
          "В общей очереди упаковки есть неподтверждённые задания.",
        );
  }
  if (!config || !canSchedulePartial) return;
  const queue = candidates.sort(
    (a, b) =>
      a.ready - b.ready ||
      a.rank - b.rank ||
      a.task.id.localeCompare(b.task.id),
  );
  const waiting: typeof candidates = [];
  const compare = (
    a: (typeof candidates)[number],
    b: (typeof candidates)[number],
  ) =>
    a.rank - b.rank || a.ready - b.ready || a.task.id.localeCompare(b.task.id);
  const push = (item: (typeof candidates)[number]) => {
    waiting.push(item);
    let i = waiting.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compare(waiting[p], waiting[i]) <= 0) break;
      [waiting[p], waiting[i]] = [waiting[i], waiting[p]];
      i = p;
    }
  };
  const pop = () => {
    const item = waiting[0],
      last = waiting.pop()!;
    if (waiting.length) {
      waiting[0] = last;
      let i = 0;
      for (;;) {
        let n = i;
        const l = i * 2 + 1,
          r = l + 1;
        if (l < waiting.length && compare(waiting[l], waiting[n]) < 0) n = l;
        if (r < waiting.length && compare(waiting[r], waiting[n]) < 0) n = r;
        if (n === i) break;
        [waiting[n], waiting[i]] = [waiting[i], waiting[n]];
        i = n;
      }
    }
    return item;
  };
  let at = now,
    index = 0;
  while (index < queue.length || waiting.length) {
    if (!waiting.length) at = Math.max(at, queue[index].ready);
    while (index < queue.length && queue[index].ready <= at + 0.01)
      push(queue[index++]);
    const next = pop();
    const spans = workSegments(at, (next.pieces / config.rate) * 60, config);
    const row = rows.find((r) => r.key === next.task.supplyKey)!;
    if (!spans?.length) {
      row.packingReasons.push("Очередь упаковки выходит за горизонт расчёта.");
      for (const r of rows)
        if (!r.packingExcluded && r.packingStatus !== "done" && !r.packingReasons.length)
          r.packingReasons.push("Общая очередь упаковки не подтверждена.");
      return;
    }
    for (const span of spans)
      row.packingSegments.push({
        ...span,
        resource: "packing",
        phase: "packing",
        taskId: next.task.id,
        supplyKey: next.task.supplyKey,
        article: next.task.article,
        pieces:
          (next.pieces * (span.end - span.start)) /
          ((next.pieces / config.rate) * 3600000),
      });
    at = spans[spans.length - 1].end;
  }
  for (const row of rows) {
    if (row.packingStatus === "done" || row.packingReasons.length) continue;
    if (!row.packingSegments.length) {
      row.packingReasons.push("Нет подтверждённых партий для упаковки.");
      continue;
    }
    row.packingFinishAt = Math.max(...row.packingSegments.map((s) => s.end));
    if (!row.packingAt) {
      row.packingStatus = "no-deadline";
      continue;
    }
    row.packingMargin =
      (Date.parse(row.packingAt) - row.packingFinishAt) / 3600000;
    row.packingStatus =
      row.packingMargin < 0
        ? "late"
        : row.packingMargin < 2
          ? "risk"
          : "on-time";
  }
}
