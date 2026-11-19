import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Clock3, PackageCheck, Printer, Scissors, Truck } from "lucide-react";
import { Button } from "./ui";
import { num } from "./model";
import { processFact, processPercent } from "./productionProcessFacts";
import { globalCalendarEvents, moscowDay, type GlobalCalendarEvent } from "./globalCalendar";
import { suppliesOnDay, summarizeDailyEvents } from "./dailySupplyIndex";
import { overallForecastStatus, type ForecastRow, type ForecastTask } from "./productionForecastModel";
import { packingPlanWindow } from "./supplyCalendarAxis";
import type { Planning } from "../shared/productionPlanning";
import "./DailySupplyCalendar.css";

const DAY = 86_400_000;
const OFFSET = 10_800_000;
const dayName = (at: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", weekday: "short" }).format(at).replace(/\.$/, "");
const dayLong = (at: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(at);
const shortDate = (at: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long" }).format(at);
const time = (at: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }).format(at);
const capitalise = (value: string) => value.charAt(0).toLocaleUpperCase("ru-RU") + value.slice(1);
const deadline = (value: string | null | undefined) => {
  if (!value) return "Срок не задан";
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at) : "Не подтверждён";
};
const statusLabel: Record<ForecastRow["status"], string> = {
  done: "Этапы завершены", "on-time": "Успеваем", risk: "Под риском", late: "Позже срока", unknown: "Нужны данные", "no-deadline": "Срок не задан",
};

function eventLabel(event: GlobalCalendarEvent) {
  switch (event.kind) {
    case "production-deadline": return `Срок печати и порезки · ${time(event.start)}`;
    case "packing-deadline": return `Срок упаковки · ${time(event.start)}`;
    case "shipping-deadline": return `План отгрузки · ${time(event.start)}`;
    case "packing-window": return `Окно упаковки по графику · ${time(event.start)}–${time(event.end!)} · не прогноз`;
    case "print-work": return `Печать · расчётное окно${event.partial ? " · частично" : ""}`;
    case "cut-work": return `Порезка · расчётное окно${event.partial ? " · частично" : ""}`;
    case "packing-work": return `Упаковка · расчётное окно${event.partial ? " · частично" : ""}`;
  }
}

function FactBar({ tasks, phase, excluded }: { tasks: ForecastTask[]; phase: "print" | "cut" | "packing"; excluded?: boolean }) {
  const fact = processFact(tasks, phase);
  const label = phase === "print" ? "Печать" : phase === "cut" ? "Порезка" : "Упаковка";
  const Icon = phase === "print" ? Printer : phase === "cut" ? Scissors : PackageCheck;
  if (excluded) return <div className={`daily-supply-fact ${phase}`}><div className="daily-supply-fact-label"><Icon size={17} /><strong>{label}</strong></div><span>Нет задания Assembly</span></div>;
  if (!fact.positions || fact.unknownCount === fact.positions) return <div className={`daily-supply-fact ${phase}`}><div className="daily-supply-fact-label"><Icon size={17} /><strong>{label}</strong></div><span>Факт не подтверждён</span></div>;
  const percent = processPercent(fact);
  const value = `${fact.unknownCount ? "≥ " : ""}${num(fact.ready)} / ${num(fact.plan)} шт.`;
  return <div className={`daily-supply-fact ${phase}`}>
    <div className="daily-supply-fact-label"><Icon size={17} /><strong>{label}</strong></div>
    <div className="daily-supply-fact-value"><span>{value}</span><strong>{fact.unknownCount ? "≥ " : ""}{percent}%</strong>
      <div className="daily-supply-progress" role="progressbar" aria-label={`${label}: ${value}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${fact.unknownCount ? "не менее " : ""}${percent}%${fact.unknownCount ? `, нет данных по ${fact.unknownCount} позициям` : ""}`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      {fact.unknownCount > 0 && <small>Нет данных по {fact.unknownCount} поз.</small>}
    </div>
  </div>;
}

function SupplyCard({ row, events, tasks, planning, fresh, onSelect }: { row: ForecastRow; events: GlobalCalendarEvent[]; tasks: ForecastTask[]; planning: Planning; fresh: boolean; onSelect: (key: string) => void }) {
  const reasons = [...new Set([...row.reasons, ...(row.packingExcluded ? [] : row.packingReasons)])];
  const hasPartial = row.segments.length > 0 || row.packingSegments.length > 0;
  const overall = overallForecastStatus(row);
  const status = !fresh ? "Данные устарели" : reasons.length ? "Нужны данные" : statusLabel[overall];
  const showWarning = !fresh || reasons.length > 0 || overall === "unknown";
  const warning = !fresh ? "Данные устарели · прогноз не подтверждён" : reasons.length && hasPartial ? "Частичный расчёт · нужны данные" : "Прогноз не рассчитан · нужны данные";
  const window = !row.stock && !row.packingExcluded ? packingPlanWindow(row.readyAt, row.packingAt, row.shipAt, planning.resources.find((resource) => resource.id === "packing")) : null;
  return <article className="daily-supply-card" aria-label={row.name}>
    <header className="daily-supply-card-heading"><div><h4>{row.name}</h4><small>{row.stock ? "Запасы" : "План производства"}: {num(row.plan)} шт.</small></div><span className={`daily-supply-status ${fresh && !reasons.length ? overall : "unknown"}`}>{status}</span></header>
    <div className="daily-supply-events"><span>На выбранный день:</span>{events.map((event) => <small key={event.id}>{eventLabel(event)}</small>)}</div>
    <div className="daily-supply-facts"><strong>Факт · {fresh ? "данные учёта" : "последний снимок"}</strong>
      <FactBar tasks={tasks} phase="print" /><FactBar tasks={tasks} phase="cut" /><FactBar tasks={tasks} phase="packing" excluded={row.packingExcluded} />
    </div>
    <div className="daily-supply-deadlines">
      <div className="production"><Clock3 size={17} /><span>Печать и порезка<strong>{deadline(row.readyAt)}</strong></span></div>
      <div className="packing"><PackageCheck size={17} /><span>Упаковка<strong>{row.packingExcluded ? "Нет задания Assembly" : deadline(row.packingAt)}</strong></span></div>
      <div className="shipping"><Truck size={17} /><span>Отгрузка<strong>{row.stock ? "Не применяется" : deadline(row.shipAt)}</strong></span></div>
    </div>
    {window?.status === "ready" && <p className="daily-supply-window">Окно упаковки по графику: {num(window.hours, 1)} ч · не прогноз</p>}
    {window?.status === "schedule-missing" && <p className="daily-supply-window">Окно упаковки: задайте график участка</p>}
    {window?.status === "no-work" && <p className="daily-supply-window">До срока нет рабочих часов по графику упаковки</p>}
    {(window?.status === "invalid" || window?.status === "too-long") && <p className="daily-supply-window">Окно упаковки: проверьте сроки</p>}
    {showWarning && <div className="daily-supply-warning"><AlertTriangle size={18} /><span><strong>{warning}</strong>{fresh && reasons[0] && <small>{reasons[0]}</small>}<button type="button" onClick={() => onSelect(row.key)}>Что проверить →</button></span></div>}
    {!showWarning && row.finishAt !== null && Number.isFinite(new Date(row.finishAt).getTime()) && row.status !== "done" && <p className="daily-supply-forecast">Прогноз печати и порезки: {deadline(new Date(row.finishAt).toISOString())}</p>}
    {!showWarning && !row.packingExcluded && row.packingFinishAt !== null && Number.isFinite(new Date(row.packingFinishAt).getTime()) && row.packingStatus !== "done" && <p className="daily-supply-forecast">Прогноз упаковки: {deadline(new Date(row.packingFinishAt).toISOString())}</p>}
    <Button kind="primary" onClick={() => onSelect(row.key)}>Открыть детали</Button>
  </article>;
}

export function DailySupplyCalendar({ rows, tasks, now, onSelect, focus, planning, fresh, onTimeline }: {
  rows: ForecastRow[]; tasks: ForecastTask[]; now: number; onSelect: (key: string) => void;
  focus: { key: string; at: number } | null; planning: Planning; fresh: boolean; onTimeline: () => void;
}) {
  const [start, setStart] = useState(() => moscowDay(now));
  const [selectedDay, setSelectedDay] = useState(() => moscowDay(now));
  useEffect(() => { if (focus && Number.isFinite(focus.at)) { const day = moscowDay(focus.at); setStart(day); setSelectedDay(day); } }, [focus]);
  const end = start + 8 * DAY;
  const eventIndex = useMemo(() => globalCalendarEvents(rows, planning, start, end, fresh), [rows, planning, start, end, fresh]);
  const selected = useMemo(() => suppliesOnDay(rows, eventIndex.get(selectedDay) || []), [rows, eventIndex, selectedDay]);
  const taskMap = useMemo(() => {
    const map = new Map<string, ForecastTask[]>();
    for (const task of tasks) { const list = map.get(task.supplyKey) || []; list.push(task); map.set(task.supplyKey, list); }
    return map;
  }, [tasks]);
  const shifts = planning.resources.filter((resource) => resource.days.length && resource.start >= 0 && resource.end <= 1440 && resource.end > resource.start);
  const days = Array.from({ length: 8 }, (_, index) => start + index * DAY);
  const nearest = days.find((day) => day > selectedDay && (eventIndex.get(day) || []).length > 0);
  const move = (delta: number) => { const next = start + delta * DAY; setStart(next); setSelectedDay(next); };
  return <section className="card daily-supply-calendar" aria-label="Поставки по дням">
    <header className="daily-supply-header"><div><h3>Календарь поставок</h3><small>Выберите день, чтобы увидеть связанные сроки и работу · МСК</small></div>
      <div className="daily-supply-header-actions"><Button onClick={onTimeline}>Показать шкалу</Button><Button aria-label="Предыдущие 8 дней" onClick={() => move(-8)}><ChevronLeft size={16} /></Button><Button onClick={() => { const today = moscowDay(now); setStart(today); setSelectedDay(today); }}>Сегодня</Button><Button aria-label="Следующие 8 дней" onClick={() => move(8)}><ChevronRight size={16} /></Button></div>
    </header>
    {!fresh && <div className="daily-supply-stale" role="status">Данные устарели или ещё загружаются. Сроки показаны по сохранённому плану; обновите данные для прогноза.</div>}
    <div className="daily-supply-days" aria-label="Выбор дня">
      {days.map((day) => {
        const events = eventIndex.get(day) || [], summary = summarizeDailyEvents(events);
        const dow = new Date(day + OFFSET).getUTCDay();
        const off = shifts.length > 0 && !shifts.some((resource) => resource.days.includes(dow));
        const caption = summary.shipments ? `Отгрузок: ${summary.shipments}` : summary.deadlines ? `Сроков: ${summary.deadlines}` : summary.forecast ? `Расчёт: ${summary.supplies}` : summary.windows ? `Окно: ${summary.supplies}` : off ? "Нет смен" : "Нет событий";
        return <button type="button" key={day} className={`daily-supply-day ${selectedDay === day ? "selected" : ""} ${moscowDay(now) === day ? "today" : ""} ${off ? "off" : ""}`}
          aria-pressed={selectedDay === day} aria-label={`${capitalise(dayLong(day))}: ${caption}`} onClick={() => setSelectedDay(day)}>
          <strong>{capitalise(dayName(day))} {new Date(day + OFFSET).getUTCDate()}</strong><small>{caption}</small>
        </button>;
      })}
    </div>
    <div className="daily-supply-heading"><div><h3>{capitalise(dayLong(selectedDay))}</h3><small>{selected.length ? `Поставок с событиями: ${selected.length}` : "Плановых событий на этот день нет"}</small></div><CalendarDays size={21} /></div>
    {selected.length > 0 ? <div className="daily-supply-grid">{selected.map(({ row, events }) => <SupplyCard key={row.key} row={row} events={events} tasks={taskMap.get(row.key) || []} planning={planning} fresh={fresh} onSelect={onSelect} />)}</div> :
      <div className="daily-supply-empty"><strong>Нет сохранённых сроков или расчётных окон на этот день</strong><p>Это не означает, что работа на участках не ведётся.</p>{nearest !== undefined && <Button onClick={() => setSelectedDay(nearest)}>Показать {shortDate(nearest)}</Button>}</div>}
    <p className="daily-supply-note">Факт — общий прогресс на момент чтения, а не выработка за выбранный день. Плановые сроки, расчёт и окно по графику не являются подтверждением отгрузки. Выходные — по графикам участков; отдельные праздничные дни не учтены.</p>
  </section>;
}
