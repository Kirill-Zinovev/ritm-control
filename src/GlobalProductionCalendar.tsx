import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  PackageCheck,
  Printer,
  Scissors,
  Truck,
} from "lucide-react";
import { Button } from "./ui";
import { num } from "./model";
import { MACHINES } from "./machineWorkloadData";
import {
  globalCalendarEvents,
  monthDays,
  monthDistance,
  moscowDay,
  moscowMonth,
  type GlobalCalendarEvent,
} from "./globalCalendar";
import { dailyForecastIssues, forecastIssueSource } from "./dailySupplyIndex";
import type { Planning } from "../shared/productionPlanning";
import type { ForecastRow, ForecastTask } from "./productionForecastModel";
import "./GlobalProductionCalendar.css";

const DAY = 86_400_000;
const OFFSET = 10_800_000;
const zone = { timeZone: "Europe/Moscow" } as const;
const weekday = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const monthTitle = new Intl.DateTimeFormat("ru-RU", {
  ...zone,
  month: "long",
  year: "numeric",
});
const dayTitle = new Intl.DateTimeFormat("ru-RU", {
  ...zone,
  weekday: "short",
  day: "numeric",
  month: "long",
});
const fullDayTitle = new Intl.DateTimeFormat("ru-RU", {
  ...zone,
  day: "numeric",
  month: "long",
  year: "numeric",
});
const time = new Intl.DateTimeFormat("ru-RU", {
  ...zone,
  hour: "2-digit",
  minute: "2-digit",
});
const shortDate = new Intl.DateTimeFormat("ru-RU", {
  ...zone,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const capitalise = (text: string) =>
  text.charAt(0).toLocaleUpperCase("ru-RU") + text.slice(1);
const eventInfo: Record<
  GlobalCalendarEvent["kind"],
  { title: string; tone: string; Icon: typeof Printer }
> = {
  "production-deadline": {
    title: "Печать и порезка",
    tone: "production",
    Icon: Printer,
  },
  "packing-deadline": {
    title: "Упаковка",
    tone: "packing",
    Icon: PackageCheck,
  },
  "shipping-deadline": { title: "Отгрузка", tone: "shipping", Icon: Truck },
  "print-work": { title: "Печать", tone: "production", Icon: Printer },
  "cut-work": { title: "Порезка", tone: "production", Icon: Scissors },
  "packing-work": { title: "Упаковка", tone: "packing", Icon: PackageCheck },
  "packing-window": {
    title: "Окно упаковки по графику",
    tone: "packing",
    Icon: PackageCheck,
  },
};
const deadlineKinds = [
  "production-deadline",
  "packing-deadline",
  "shipping-deadline",
] as const;
const isDeadline = (event: GlobalCalendarEvent) =>
  event.kind.endsWith("-deadline");
const showForecast = (
  event: GlobalCalendarEvent,
  row: ForecastRow | undefined,
  fresh: boolean,
) => {
  if (!fresh || !row) return null;
  if (event.kind === "production-deadline" && row.reasons.length === 0)
    return row.finishAt;
  if (event.kind === "packing-deadline" && row.packingReasons.length === 0)
    return row.packingFinishAt;
  return null;
};

function AgendaEvent({
  event,
  row,
  fresh,
  onSelect,
}: {
  event: GlobalCalendarEvent;
  row: ForecastRow | undefined;
  fresh: boolean;
  onSelect: (key: string) => void;
}) {
  const { Icon, title, tone } = eventInfo[event.kind];
  const forecast = showForecast(event, row, fresh);
  return (
    <button
      className={`global-calendar-event ${tone}`}
      type="button"
      onClick={() => onSelect(event.rowKey)}
    >
      <time dateTime={new Date(event.start).toISOString()}>
        {time.format(event.start)}
      </time>
      <span>
        <strong>
          <Icon size={16} aria-hidden="true" />
          {title}
        </strong>
        <span>{event.name}</span>
        {forecast !== null && (
          <small>
            Прогноз{" "}
            {moscowDay(forecast) === event.day
              ? time.format(forecast)
              : shortDate.format(forecast)}
          </small>
        )}
        {event.end !== null && (
          <small>
            {event.kind === "packing-window"
              ? "По графику"
              : event.partial
                ? "Частичный расчёт"
                : "Расчётное окно"}
            {" до "}
            {event.end === event.day + DAY ? "24:00" : time.format(event.end)}
            {" · возможны перерывы"}
          </small>
        )}
      </span>
      <ChevronRight size={15} aria-hidden="true" />
    </button>
  );
}

function DailyMachineLoad({
  rows,
  day,
  fresh,
  onOpenResources,
}: {
  rows: ForecastRow[];
  day: number;
  fresh: boolean;
  onOpenResources: () => void;
}) {
  const loads = useMemo(() => {
    const byResource = new Map<
      string,
      { pieces: number; minutes: number; partial: boolean }
    >();
    for (const row of rows) {
      for (const segment of row.segments) {
        if (segment.phase !== "print") continue;
        const overlap =
          Math.min(day + DAY, segment.end) - Math.max(day, segment.start);
        if (overlap <= 0) continue;
        const load = byResource.get(segment.resource) || {
          pieces: 0,
          minutes: 0,
          partial: false,
        };
        load.pieces +=
          (segment.pieces * overlap) / (segment.end - segment.start);
        load.minutes += overlap / 60_000;
        load.partial ||= !fresh || row.reasons.length > 0;
        byResource.set(segment.resource, load);
      }
    }
    return MACHINES.flatMap((machine) => {
      const load = byResource.get(machine.id);
      return load ? [{ ...load, ...machine }] : [];
    })
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 3);
  }, [rows, day, fresh]);
  return (
    <section className="card global-calendar-load">
      <header>
        <h3>Загрузка на выбранный день</h3>
        <Button kind="ghost" onClick={onOpenResources}>
          Все станки <ChevronRight size={16} />
        </Button>
      </header>
      {loads.length ? (
        <div className="global-calendar-load-grid">
          {loads.map((machine) => (
            <div key={machine.id}>
              <Printer size={19} aria-hidden="true" />
              <span>
                <strong>{machine.label}</strong> ·{" "}
                {machine.pieces < 1
                  ? "менее 1"
                  : `≈ ${num(Math.round(machine.pieces))}`}{" "}
                шт.
                <small>
                  {machine.partial ? "Частичный расчёт" : "Печать по прогнозу"}
                </small>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p>На этот день нет рассчитанной загрузки печати.</p>
      )}
    </section>
  );
}

export function GlobalProductionCalendar({
  rows,
  tasks,
  now,
  onSelect,
  planning,
  fresh,
  selectedDay,
  onDayChange,
  compact,
  toolbar,
  onOpenCalendar,
  onOpenResources,
}: {
  rows: ForecastRow[];
  tasks: ForecastTask[];
  now: number;
  onSelect: (key: string) => void;
  planning: Planning;
  fresh: boolean;
  selectedDay: number;
  onDayChange: (day: number) => void;
  compact: boolean;
  toolbar?: ReactNode;
  onOpenCalendar: () => void;
  onOpenResources: () => void;
}) {
  const [period, setPeriod] = useState(3);
  const [offset, setOffset] = useState(0);
  const dayDetail = useRef<HTMLElement>(null);
  const count = compact ? 2 : period;
  const selectedMonth = monthDistance(now, selectedDay);
  const activeOffset =
    selectedMonth < offset || selectedMonth >= offset + count
      ? selectedMonth
      : offset;
  const start = moscowMonth(now, activeOffset);
  const end = moscowMonth(start, count);
  const months = Array.from({ length: count }, (_, index) =>
    moscowMonth(start, index),
  );
  const events = useMemo(
    () => globalCalendarEvents(rows, planning, start, end, fresh),
    [rows, planning, start, end, fresh],
  );
  const byKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row])),
    [rows],
  );
  const selectedEvents = events.get(selectedDay) || [];
  const shipping = selectedEvents.filter(
    (event) => event.kind === "shipping-deadline",
  );
  const deadlines = selectedEvents.filter(
    (event) => isDeadline(event) && event.kind !== "shipping-deadline",
  );
  const windows = selectedEvents.filter((event) => !isDeadline(event));
  const visibleWindows = deadlines.length ? 0 : 4;
  const moreWindows = windows.slice(visibleWindows);
  const issues = useMemo(
    () =>
      compact
        ? { affected: 0, reasons: [] }
        : dailyForecastIssues(
            selectedEvents.map((event) => {
              const row = byKey.get(event.rowKey);
              const reasons =
                event.kind === "production-deadline"
                  ? row?.reasons
                  : event.kind === "packing-deadline"
                    ? row?.packingReasons
                    : undefined;
              return reasons?.length
                ? { ...event, partial: true, reasons }
                : event;
            }),
          ),
    [compact, selectedEvents, byKey],
  );
  const configured = planning.resources.filter(
    (resource) =>
      resource.days.length &&
      resource.start >= 0 &&
      resource.end <= 1440 &&
      resource.end > resource.start,
  );
  const today = moscowDay(now);
  const jump = (delta: number) => {
    const next = activeOffset + delta;
    setOffset(next);
    onDayChange(moscowMonth(now, next));
  };
  const openDay = (day: number) => {
    onDayChange(day);
    window.requestAnimationFrame(() => {
      const panel = dayDetail.current;
      if (panel && panel.getBoundingClientRect().top > window.innerHeight - 110)
        panel.scrollIntoView({ block: "start" });
    });
  };
  const renderEvent = (event: GlobalCalendarEvent) => (
    <AgendaEvent
      key={event.id}
      event={event}
      row={byKey.get(event.rowKey)}
      fresh={fresh}
      onSelect={onSelect}
    />
  );
  const upcomingShipping = compact
    ? rows.reduce<number>((soonest, row) => {
        const at = row.shipAt ? Date.parse(row.shipAt) : NaN;
        return at >= Math.max(now, selectedDay)
          ? Math.min(soonest, at)
          : soonest;
      }, Infinity)
    : Infinity;

  return (
    <section
      className={
        compact
          ? "card global-calendar global-calendar-compact"
          : "global-calendar"
      }
      aria-label={compact ? "Ближайшие сроки" : "Календарь поставок"}
    >
      {compact ? (
        <header className="global-calendar-heading">
          <h3>Календарь</h3>
          <Button onClick={onOpenCalendar}>Обзор месяцев</Button>
        </header>
      ) : (
        <div className="global-calendar-actions">
          <select
            aria-label="Период календаря"
            value={period}
            onChange={(event) => setPeriod(Number(event.target.value))}
          >
            <option value={3}>3 месяца</option>
            <option value={6}>6 месяцев</option>
          </select>
          <Button aria-label="Предыдущий период" onClick={() => jump(-count)}>
            <ChevronLeft size={17} />
          </Button>
          <Button aria-label="Следующий период" onClick={() => jump(count)}>
            <ChevronRight size={17} />
          </Button>
          <Button
            onClick={() => {
              setOffset(0);
              onDayChange(today);
            }}
          >
            Сегодня
          </Button>
          {toolbar}
          {!fresh && (
            <span className="global-calendar-stale" role="status">
              Прогноз ожидает свежих данных
            </span>
          )}
        </div>
      )}
      <div className="global-calendar-layout">
        <div className="global-calendar-main">
          <section className="card global-calendar-month-panel">
            {!compact && <h3>Календарь сроков</h3>}
            <div className="global-calendar-months">
              {months.map((month) => {
                const title = capitalise(
                  monthTitle.format(month).replace(/ г\.$/, ""),
                );
                return (
                  <section
                    className="global-calendar-month"
                    key={month}
                    aria-label={title}
                  >
                    <h4>{title}</h4>
                    <div
                      className="global-calendar-weekdays"
                      aria-hidden="true"
                    >
                      {weekday.map((label) => (
                        <span key={label}>{label}</span>
                      ))}
                    </div>
                    <div className="global-calendar-days">
                      {monthDays(month).map((day, index) => {
                        if (day === null)
                          return (
                            <span
                              className="global-calendar-blank"
                              key={`empty-${index}`}
                            />
                          );
                        const list = events.get(day) || [];
                        const dayDate = new Date(day + OFFSET);
                        const off =
                          configured.length > 0 &&
                          !configured.some((resource) =>
                            resource.days.includes(dayDate.getUTCDay()),
                          );
                        const counts = deadlineKinds.map(
                          (kind) =>
                            list.filter((event) => event.kind === kind).length,
                        );
                        const total = counts.reduce((sum, n) => sum + n, 0);
                        const hasWork = list.some(
                          (event) => !isDeadline(event),
                        );
                        return (
                          <button
                            type="button"
                            key={day}
                            className={`global-calendar-date${off ? " off" : ""}${selectedDay === day ? " selected" : ""}${today === day ? " today" : ""}`}
                            aria-current={today === day ? "date" : undefined}
                            aria-pressed={selectedDay === day}
                            aria-label={`${fullDayTitle.format(day)}${counts.map((n, i) => (n ? `, ${eventInfo[deadlineKinds[i]].title}: ${n}` : "")).join("")}${hasWork ? ", есть задачи" : ""}${off ? ", нет смен по графику" : ""}`}
                            onClick={() => openDay(day)}
                          >
                            <span>{dayDate.getUTCDate()}</span>
                            <small
                              className="global-calendar-indicators"
                              aria-hidden="true"
                            >
                              {deadlineKinds.map(
                                (kind, i) =>
                                  counts[i] > 0 && (
                                    <i
                                      key={kind}
                                      className={eventInfo[kind].tone}
                                    />
                                  ),
                              )}
                              {total > 1 && <b>{total}</b>}
                              {!total && hasWork && <i className="work" />}
                            </small>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
            {!compact && (
              <div
                className="global-calendar-legend"
                aria-label="Обозначения календаря"
              >
                {deadlineKinds.map((kind) => (
                  <span key={kind}>
                    <i className={eventInfo[kind].tone} />
                    {eventInfo[kind].title}
                  </span>
                ))}
                <span>
                  <i className="work" />
                  Расчётная работа
                </span>
              </div>
            )}
          </section>
          {!compact && (
            <DailyMachineLoad
              rows={rows}
              day={selectedDay}
              fresh={fresh}
              onOpenResources={onOpenResources}
            />
          )}
        </div>
        <aside
          ref={dayDetail}
          className="card global-calendar-day"
          aria-label="Задачи и сроки на выбранный день"
        >
          <header>
            <h4>{capitalise(dayTitle.format(selectedDay))}</h4>
            <small>МСК</small>
          </header>
          {!selectedEvents.length && (
            <p className="global-calendar-empty">
              На этот день нет задач и сроков
              {rows.length ? "." : " по выбранному фильтру."}
            </p>
          )}
          {shipping.length > 0 && (
            <section className="global-calendar-agenda">
              {!compact && <h5>Отгрузка</h5>}
              {(compact ? shipping.slice(0, 2) : shipping).map(renderEvent)}
            </section>
          )}
          {(deadlines.length > 0 || windows.length > 0) && (
            <section className="global-calendar-agenda">
              {!compact && <h5>Работа на день</h5>}
              {(compact
                ? [...deadlines, ...windows].slice(0, 2)
                : deadlines
              ).map(renderEvent)}
              {!compact && windows.slice(0, visibleWindows).map(renderEvent)}
              {!compact && moreWindows.length > 0 && (
                <details className="global-calendar-extra" key={selectedDay}>
                  <summary>
                    Расчётные окна и работа по графику · {moreWindows.length}
                  </summary>
                  <div>{moreWindows.map(renderEvent)}</div>
                </details>
              )}
            </section>
          )}
          {compact &&
            (shipping.length > 2 || deadlines.length + windows.length > 2) && (
              <Button kind="ghost" onClick={onOpenCalendar}>
                Все задачи дня <ChevronRight size={16} />
              </Button>
            )}
          {Number.isFinite(upcomingShipping) && (
            <div className="global-calendar-next">
              <Truck size={18} aria-hidden="true" />
              <span>
                Ближайшая отгрузка{" "}
                <strong>{shortDate.format(upcomingShipping)}</strong>
              </span>
            </div>
          )}
          {issues.affected > 0 && (
            <details className="global-calendar-issues" key={selectedDay}>
              <summary>
                <AlertTriangle size={17} aria-hidden="true" /> Что проверить
                {issues.reasons.length ? ` · ${issues.reasons.length}` : ""}
              </summary>
              <p>
                Прогноз требует уточнения для {issues.affected} поставок и
                заданий.
              </p>
              {issues.reasons.length ? (
                <ul>
                  {issues.reasons.map((issue) => {
                    const source = forecastIssueSource(issue.message, tasks);
                    return (
                      <li key={issue.message}>
                        {issue.message}
                        {source && (
                          <button
                            type="button"
                            className="global-calendar-open"
                            onClick={() => onSelect(source)}
                          >
                            Открыть источник <ChevronRight size={14} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p>Дождитесь свежих данных или откройте задачу для проверки.</p>
              )}
            </details>
          )}
        </aside>
      </div>
    </section>
  );
}
