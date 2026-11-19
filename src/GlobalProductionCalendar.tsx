import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, PackageCheck, Printer, Scissors, Truck } from "lucide-react";
import { Button } from "./ui";
import { num } from "./model";
import { processFact, processPercent } from "./productionProcessFacts";
import { globalCalendarEvents, monthDays, monthDistance, moscowDay, moscowMonth, type GlobalCalendarEvent } from "./globalCalendar";
import { dailyForecastIssues, forecastIssueSource, suppliesOnDay } from "./dailySupplyIndex";
import { packingPlanWindow } from "./supplyCalendarAxis";
import type { Planning } from "../shared/productionPlanning";
import type { ForecastRow, ForecastTask } from "./productionForecastModel";
import "./GlobalProductionCalendar.css";

const DAY = 86_400_000;
const OFFSET = 10_800_000;
const weekday = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const monthTitle = (at: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", month: "long", year: "numeric" }).format(at).replace(/ г\.$/, "");
const dayTitle = (at: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(at);
const time = (at: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }).format(at);
const deadline = (value: string | null | undefined) => {
  if (!value) return "Не задан";
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at) : "Не подтверждён";
};
const capitalise = (text: string) => text.charAt(0).toLocaleUpperCase("ru-RU") + text.slice(1);
const eventInfo: Record<GlobalCalendarEvent["kind"], { title: string; tone: string; Icon: typeof Printer }> = {
  "production-deadline": { title: "Срок печати и порезки", tone: "production", Icon: CalendarDays },
  "packing-deadline": { title: "Срок упаковки", tone: "packing", Icon: PackageCheck },
  "shipping-deadline": { title: "План отгрузки", tone: "shipping", Icon: Truck },
  "print-work": { title: "Печать", tone: "print", Icon: Printer },
  "cut-work": { title: "Порезка", tone: "cut", Icon: Scissors },
  "packing-work": { title: "Упаковка", tone: "packing", Icon: PackageCheck },
  "packing-window": { title: "Окно упаковки по графику", tone: "packing", Icon: PackageCheck },
};

function CurrentFact({ tasks, phase }: { tasks: ForecastTask[]; phase: "print" | "cut" | "packing" }) {
  const fact = processFact(tasks, phase);
  if (!fact.positions) return null;
  const label = phase === "print" ? "Печать" : phase === "cut" ? "Порезка" : "Упаковка";
  if (fact.unknownCount === fact.positions) return <span>{label}: факт не подтверждён</span>;
  return <span>{label}: {fact.unknownCount ? "≥ " : ""}{num(fact.ready)} / {num(fact.plan)} шт. · {processPercent(fact)}%{fact.unknownCount ? ` · нет данных по ${fact.unknownCount} поз.` : ""}</span>;
}

function SupplyDayCard({ row, events, tasks, planning, onSelect }: {
  row: ForecastRow; events: GlobalCalendarEvent[]; tasks: ForecastTask[];
  planning: Planning; onSelect: (key: string) => void;
}) {
  const phases = new Set<"print" | "cut" | "packing">();
  for (const event of events) {
    if (event.kind === "print-work" || event.kind === "production-deadline") phases.add("print");
    if (event.kind === "cut-work" || event.kind === "production-deadline") phases.add("cut");
    if (event.kind === "packing-work" || event.kind === "packing-deadline") phases.add("packing");
  }
  const packingPlan = !row.stock && !row.packingExcluded
    ? packingPlanWindow(row.readyAt, row.packingAt, row.shipAt, planning.resources.find((resource) => resource.id === "packing")) : null;
  return <article className="global-calendar-supply-card" aria-label={row.name}>
    <div className="global-calendar-card-heading">
      <button type="button" className="global-calendar-supply" onClick={() => onSelect(row.key)}>{row.name}</button>
      {events.some((event) => event.partial) && <span className="global-calendar-provisional">Есть предварительные окна</span>}
    </div>
    <div className="global-calendar-event-lines">{events.map((event) => {
      const info = eventInfo[event.kind];
      const isDeadline = event.kind.endsWith("-deadline");
      const isWindow = event.kind === "packing-window";
      return <div className={`global-calendar-event-line ${info.tone}`} key={event.id}>
        <info.Icon size={16} aria-hidden="true" />
        <span><strong>{info.title}</strong><small>{isDeadline ? "План" : isWindow ? "По графику · не прогноз" : event.partial ? "Предварительный расчёт" : "Расчётное окно"}</small></span>
        <time>{time(event.start)}{!isDeadline && event.end !== null ? `–${time(event.end)}` : ""}</time>
      </div>;
    })}</div>
    {phases.size > 0 && <div className="global-calendar-facts"><strong>Текущий факт:</strong>{(["print", "cut", "packing"] as const).filter((phase) => phases.has(phase)).map((phase) => <CurrentFact key={phase} tasks={tasks} phase={phase} />)}</div>}
    <details className="global-calendar-more">
      <summary>Все сроки и детали</summary>
      <dl>
        <div><dt>Печать и порезка</dt><dd>{deadline(row.readyAt)}</dd></div>
        <div><dt>Упаковка</dt><dd>{row.packingExcluded ? "Нет задания Assembly" : deadline(row.packingAt)}</dd></div>
        <div><dt>Отгрузка</dt><dd>{row.stock ? "Не применяется" : deadline(row.shipAt)}</dd></div>
      </dl>
      {packingPlan?.status === "ready" && <small>Окно упаковки по графику: {num(packingPlan.hours, 1)} ч · не прогноз</small>}
      <button type="button" className="global-calendar-open" onClick={() => onSelect(row.key)}>Открыть детали →</button>
    </details>
  </article>;
}

export function GlobalProductionCalendar({ rows, tasks, now, onSelect, focus, planning, fresh }: {
  rows: ForecastRow[];
  tasks: ForecastTask[];
  now: number;
  onSelect: (key: string) => void;
  focus: { key: string; at: number } | null;
  planning: Planning;
  fresh: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState(() => moscowDay(now));
  const [showAllSupplies, setShowAllSupplies] = useState(false);
  const dayDetail = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focus || !Number.isFinite(focus.at)) return;
    setOffset(monthDistance(now, focus.at));
    setSelectedDay(moscowDay(focus.at));
    setShowAllSupplies(false);
  }, [focus]);
  const start = moscowMonth(now, offset);
  const end = moscowMonth(start, 6);
  const months = Array.from({ length: 6 }, (_, index) => moscowMonth(start, index));
  const events = useMemo(() => globalCalendarEvents(rows, planning, start, end, fresh), [rows, planning, start, end, fresh]);
  const selectedEvents = events.get(selectedDay) || [];
  const daySupplies = useMemo(() => suppliesOnDay(rows, selectedEvents).sort((a, b) => a.events[0].start - b.events[0].start), [rows, selectedEvents]);
  const issues = useMemo(() => dailyForecastIssues(selectedEvents), [selectedEvents]);
  const visibleSupplies = showAllSupplies ? daySupplies : daySupplies.slice(0, 3);
  const rowTasks = useMemo(() => {
    const grouped = new Map<string, ForecastTask[]>();
    for (const task of tasks) {
      const list = grouped.get(task.supplyKey) || [];
      list.push(task);
      grouped.set(task.supplyKey, list);
    }
    return grouped;
  }, [tasks]);
  const configured = planning.resources.filter((resource) => resource.days.length && resource.start >= 0 && resource.end <= 1440 && resource.end > resource.start);
  const shiftMonth = (delta: number) => {
    const next = offset + delta;
    setOffset(next);
    setSelectedDay(moscowMonth(now, next));
    setShowAllSupplies(false);
  };
  const openDay = (day: number) => {
    setSelectedDay(day);
    setShowAllSupplies(false);
    if (window.matchMedia("(max-width: 850px)").matches)
      window.requestAnimationFrame(() => dayDetail.current?.scrollIntoView({ block: "start", behavior: "auto" }));
  };
  return <section className="card global-calendar" aria-label="Обзор календаря на полгода">
    <header className="global-calendar-heading">
      <div><h3>Календарь поставок</h3><small>Сроки и работа на несколько месяцев вперёд · МСК</small></div>
      <div className="global-calendar-actions">
        <span className="global-calendar-range">Полгода</span>
        <Button aria-label="Предыдущие 6 месяцев" onClick={() => shiftMonth(-6)}><ChevronLeft size={17} /></Button>
        <Button aria-label="Следующие 6 месяцев" onClick={() => shiftMonth(6)}><ChevronRight size={17} /></Button>
        <Button onClick={() => { setOffset(0); setSelectedDay(moscowDay(now)); setShowAllSupplies(false); }}>Сегодня</Button>
      </div>
    </header>
    {!fresh && <div className="global-calendar-stale" role="status">Рабочие данные устарели или ещё загружаются. Обновите данные, чтобы пересчитать календарь.</div>}
    <div className="global-calendar-layout">
      <div className="global-calendar-months" aria-label="Шесть месяцев">
        {months.map((month) => <section className="global-calendar-month" key={month} aria-label={capitalise(monthTitle(month))}>
          <h4>{capitalise(monthTitle(month))}</h4>
          <div className="global-calendar-weekdays" aria-hidden="true">{weekday.map((day) => <span key={day}>{day}</span>)}</div>
          <div className="global-calendar-days">
            {monthDays(month).map((day, index) => {
              if (day === null) return <span className="global-calendar-blank" key={`empty-${index}`} />;
              const list = events.get(day) || [];
              const dow = new Date(day + OFFSET).getUTCDay();
              const off = configured.length > 0 && !configured.some((resource) => resource.days.includes(dow));
              const deadlineCount = list.filter((event) => event.kind.endsWith("-deadline")).length;
              const supplyCount = new Set(list.map((event) => event.rowKey)).size;
              const tones = [...new Set(list.map((event) => eventInfo[event.kind].tone))];
              const tone = tones.length === 1 ? tones[0] : "mixed";
              return <button type="button" key={day} className={`global-calendar-date ${off ? "off" : ""} ${selectedDay === day ? "selected" : ""} ${moscowDay(now) === day ? "today" : ""}`}
                aria-pressed={selectedDay === day} aria-label={`${capitalise(dayTitle(day))}, поставок и заданий: ${supplyCount}${off ? ", нет смен по заданным графикам" : ""}`}
                onClick={() => openDay(day)}>
                <span>{new Date(day + OFFSET).getUTCDate()}</span>
                {supplyCount > 0 && <small className={`event-count ${tone}`} title={`Поставок и заданий: ${supplyCount}; плановых сроков: ${deadlineCount}`}>{supplyCount}</small>}
              </button>;
            })}
          </div>
        </section>)}
      </div>
      <aside ref={dayDetail} className="global-calendar-day" aria-label={`События: ${dayTitle(selectedDay)}`}>
        <header><span>Выбранный день · МСК</span><h4>{capitalise(dayTitle(selectedDay))}</h4><small>Поставок и заданий: {daySupplies.length} · плановых сроков: {selectedEvents.filter((event) => event.kind.endsWith("-deadline")).length}</small></header>
        {issues.affected > 0 && <div className="global-calendar-issues" role="status">
          <strong>Часть прогноза предварительная</strong>
          <p>Неподтверждённые данные влияют на расчёт для {issues.affected} поставок и заданий.</p>
          {issues.reasons.length > 0 ? <details><summary>Что проверить · причин: {issues.reasons.length}</summary>
            <p>Одна причина может влиять на несколько поставок в общей очереди.</p>
            <ul>{issues.reasons.map((issue) => {
              const source = forecastIssueSource(issue.message, tasks);
              return <li key={issue.message}>{issue.message}{issue.affected > 1 && <small> Затронуто поставок и заданий: {issue.affected}.</small>}
                {source && <button type="button" className="global-calendar-open global-calendar-issue-open" onClick={() => onSelect(source)}>Открыть источник →</button>}
              </li>;
            })}</ul>
          </details> : <small>Обновите данные или откройте детали поставки, чтобы увидеть причину.</small>}
        </div>}
        {!selectedEvents.length ? <div className="global-calendar-empty">Нет сроков или рассчитанной работы на этот день{rows.length ? "." : " для выбранного фильтра."}</div> :
          <div className="global-calendar-events">{visibleSupplies.map(({ row, events: supplyEvents }) => <SupplyDayCard key={row.key} row={row} events={supplyEvents} tasks={rowTasks.get(row.key) || []} planning={planning} onSelect={onSelect} />)}
            {daySupplies.length > 3 && <Button onClick={() => setShowAllSupplies(!showAllSupplies)}>{showAllSupplies ? "Показать первые три" : `Показать все · ${daySupplies.length}`}</Button>}
          </div>}
      </aside>
    </div>
    <div className="global-calendar-legend" aria-label="Обозначения этапов"><span><Printer size={15} /> Печать</span><span><Scissors size={15} /> Порезка</span><span><PackageCheck size={15} /> Упаковка</span><span><Truck size={15} /> Отгрузка</span></div>
    <p className="global-calendar-note">Число в дне — количество поставок и заданий с событиями. Расчётные окна могут содержать перерывы; текущий факт относится к моменту обновления, а не к выбранному дню. Выходные — по графикам участков; отдельные праздничные дни не учтены.</p>
  </section>;
}
