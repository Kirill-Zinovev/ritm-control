import { useEffect, useState } from "react";
import { Button } from "./ui";
import { processFact, processPercent } from "./productionProcessFacts";
import { num } from "./model";
import { MACHINES } from "./machineWorkloadData";
import { supplyCalendarAxis, calendarWorkWindow, calendarShippingView, packingPlanWindow, type PackingPlanWindow } from "./supplyCalendarAxis";
import { overallForecastStatus } from "./productionForecastModel";
import type { Planning } from "../shared/productionPlanning";
import type {
  ForecastRow,
  ForecastTask,
  ForecastSegment,
} from "./productionForecastModel";

const DAY = 86400000,
  OFFSET = 10800000;
const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const instant = (n: number) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(n);
const calendarDate = (n: number) => new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow", day: "numeric", month: "short", year: "numeric",
}).format(n);
const deadlineText = (value: string | null | undefined) => {
  if (!value) return "Не задано";
  const at = Date.parse(value);
  return Number.isFinite(at) ? instant(at) : "Не подтверждено";
};
const packingPlanText = (plan: PackingPlanWindow) => {
  if (plan.status === "schedule-missing") return "Плановое окно: задайте график упаковки";
  if (plan.status === "no-work") return "Плановое окно: нет рабочих часов до срока";
  if (plan.status === "too-long") return "Плановое окно: период больше года";
  if (plan.status === "invalid") return "Плановое окно: проверьте сроки";
  return `Плановое окно: ${instant(plan.start)} — ${instant(plan.end)} · ${num(plan.hours, 1)} ч по графику`;
};
const PHASES = [
  { id: "print", label: "Печать" },
  { id: "cut", label: "Порезка" },
  { id: "packing", label: "Упаковка" },
] as const;
export function SupplyForecastCalendar({
  rows,
  tasks,
  now,
  onSelect,
  focus,
  planning,
  fresh,
}: {
  rows: ForecastRow[];
  tasks: ForecastTask[];
  now: number;
  onSelect: (key: string) => void;
  focus: { key: string; at: number } | null;
  planning: Planning;
  fresh: boolean;
}) {
  const [offset, setOffset] = useState(-1),
    [range, setRange] = useState(7),
    [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (focus && Number.isFinite(focus.at)) {
      setOffset(
        Math.floor((focus.at + OFFSET) / DAY) -
          Math.floor((now + OFFSET) / DAY),
      );
      setSelected(focus.key);
    }
  }, [focus]);
  const start = (Math.floor((now + OFFSET) / DAY) + offset) * DAY - OFFSET,
    end = start + range * DAY;
  const axis = supplyCalendarAxis(start, range, planning.resources);
  const left = axis.position;
  const showDate = (key: string, at: number) => {
    setSelected(key);
    setOffset(Math.floor((at + OFFSET) / DAY) - Math.floor((now + OFFSET) / DAY));
  };
  const showShipping = (key: string, at: number) => {
    setSelected(key);
    const next = calendarShippingView(now, at, range, offset);
    setRange(next.range);
    setOffset(next.offset);
  };
  const allSegments = rows.flatMap((r) => [
    ...r.segments,
    ...r.packingSegments,
  ]);
  const first = allSegments.length
    ? Math.min(...allSegments.map((s) => s.start))
    : null;
  const current = rows.find((r) => r.key === selected) || rows[0] || null;
  const currentTasks = current ? tasks.filter((task) => task.supplyKey === current.key) : [];
  const resourceName = (id: string) =>
    MACHINES.find((machine) => machine.id === id)?.label ||
    (id === "cut-roll" ? "Порезка · рулонная печать" : id === "cut-box" ? "Порезка · бокс" : id);
  const resourceLoad = new Map<string, number>();
  for (const segment of current?.segments || [])
    resourceLoad.set(segment.resource, (resourceLoad.get(segment.resource) || 0) + segment.end - segment.start);
  const largestPartial = [...resourceLoad.entries()].sort((a, b) => b[1] - a[1])[0];
  const limitingResource = planning.resources.find((resource) => resource.id === (current?.bottleneck || largestPartial?.[0]));
  const packingResource = planning.resources.find((resource) => resource.id === "packing");
  const currentPackingPlan = current && !current.stock && !current.packingExcluded
    ? packingPlanWindow(current.readyAt, current.packingAt, current.shipAt, packingResource) : null;
  const resourceRate = (resource: NonNullable<typeof packingResource>) =>
    `${num(resource.rate, 2)} ${resource.unit === "area" ? "м²" : resource.unit === "sheets" ? "листов" : "шт."}/ч · ${resource.rateMode === "auto" ? "по журналу" : "вручную"}`;
  const ahead = tasks.find((task) => task.supplyKey === current?.key &&
    !task.packingExcluded && task.packed != null && task.cut != null &&
    Math.min(task.packed, task.plan) > Math.min(task.cut, task.plan) + (task.stockPacked || 0));
  return (
    <section className="card supply-calendar" aria-label="Календарь поставок">
      <header className="forecast-calendar-heading">
        <div>
          <h3>Календарь поставок</h3>
          <small>Печать → порезка → упаковка · московское время · {calendarDate(start)} — {calendarDate(end - 1)}</small>
        </div>
        <div className="forecast-actions">
          {first !== null && (
            <Button
              onClick={() => {
                setOffset(
                  Math.floor((first + OFFSET) / DAY) -
                    Math.floor((now + OFFSET) / DAY),
                );
                setRange(7);
              }}
            >
              Показать работу
            </Button>
          )}
          <select
            aria-label="Масштаб календаря поставок"
            value={range}
            onChange={(e) => setRange(Number(e.target.value))}
          >
            <option value={3}>3 дня</option>
            <option value={7}>Неделя</option>
            <option value={14}>2 недели</option>
          </select>
          <Button
            aria-label="Предыдущий период"
            onClick={() => setOffset((n) => n - range)}
          >
            ←
          </Button>
          <Button onClick={() => setOffset(range === 7 ? -1 : 0)}>Сегодня</Button>
          <Button
            aria-label="Следующий период"
            onClick={() => setOffset((n) => n + range)}
          >
            →
          </Button>
        </div>
      </header>
      {!fresh && <div className="supply-calendar-stale" role="status">Рабочие данные устарели или ещё загружаются. Обновите данные, чтобы пересчитать календарь.</div>}
      {current && <section className="supply-calendar-overview" aria-label={`Сводка: ${current.name}`}>
        <div className="supply-calendar-overview-heading">
          <div>
            <span>Выбрана поставка</span>
            <h4>{current.name}</h4>
            <small>Факт по этапам и состояние прогноза</small>
          </div>
          <button type="button" onClick={() => onSelect(current.key)}>
            Причины и сроки <span aria-hidden="true">→</span>
          </button>
        </div>
        <div className="supply-calendar-overview-stages">
          {PHASES.map(({ id, label }) => {
            const fact = processFact(currentTasks, id);
            const excluded = id === "packing" && current.packingExcluded;
            const allUnknown = fact.positions > 0 && fact.unknownCount === fact.positions;
            const complete = fact.positions > 0 && !fact.unknownCount && fact.remaining === 0;
            const percentage = processPercent(fact);
            const reasons = id === "packing" ? current.packingReasons : current.reasons;
            const segments = id === "packing" ? current.packingSegments : current.segments.filter((segment) => segment.phase === id);
            const finish = id === "packing" ? current.packingFinishAt : id === "cut" ? current.finishAt : current.printAt;
            const forecastReady = !reasons.length && finish != null && Number.isFinite(finish);
            return <article className={`supply-calendar-overview-stage ${id}`} key={id}>
              <div className="supply-calendar-overview-stage-heading">
                <strong><span aria-hidden="true">{complete ? "✓" : "●"}</span> {label}</strong>
                {!excluded && fact.positions > 0 && <b>{allUnknown ? "Нет данных" : `${fact.unknownCount ? "≥ " : ""}${percentage}%`}</b>}
              </div>
              {!excluded && fact.positions > 0 && <>
                {!allUnknown && <div className="supply-calendar-overview-progress" aria-hidden="true"><span style={{ width: `${percentage}%` }} /></div>}
                <p>{allUnknown ? <strong>Факт не подтверждён</strong> : <strong>{fact.unknownCount ? "≥ " : ""}{num(fact.ready)} / {num(fact.plan)} шт.</strong>}
                  {allUnknown ? <span>Нет данных по {fact.unknownCount} поз.</span> : fact.unknownCount
                    ? <span>Известно осталось {num(fact.remaining)} · нет данных по {fact.unknownCount} поз.</span>
                    : <span>{complete ? "Выполнено" : `Осталось ${num(fact.remaining)} шт.`}</span>}
                </p>
              </>}
              {id === "packing" && currentPackingPlan && <div className="supply-calendar-overview-packing-plan">{packingPlanText(currentPackingPlan)} <span>· не прогноз</span></div>}
              <div className={`supply-calendar-overview-forecast ${!complete && !excluded && !forecastReady ? "needs-data" : ""}`}>
                <strong>{excluded ? "Нет задания Assembly" : !fact.positions ? "Нет данных по позициям" : complete ? "Этап выполнен" : forecastReady ? `Прогноз: ${instant(finish)}` : segments.length ? "Расчёт частичный" : "Прогноз не рассчитан"}</strong>
                {!complete && !excluded && !forecastReady && <small>{reasons[0] || "Не хватает данных для расчёта"}{reasons.length > 1 ? ` · ещё ${reasons.length - 1}` : ""}</small>}
              </div>
            </article>;
          })}
        </div>
        {!current.stock && <div className="supply-calendar-overview-deadlines" aria-label="Плановые сроки выбранной поставки">
          {([
            ["Печать и порезка", current.readyAt],
            ["Упаковка", current.packingAt],
            ["Отгрузка", current.shipAt],
          ] as const).map(([label, value]) => {
            const at = value ? Date.parse(value) : NaN;
            return <div key={label}><span>{label}</span><button type="button"
              onClick={() => Number.isFinite(at) ? label === "Отгрузка" ? showShipping(current.key, at) : showDate(current.key, at) : onSelect(current.key)}
              aria-label={`${label}: ${deadlineText(value)}. ${Number.isFinite(at) ? "Показать на календаре" : "Открыть сроки"}`}>
              {deadlineText(value)}
            </button></div>;
          })}
        </div>}
      </section>}
      <small className={`supply-calendar-scroll-hint ${range === 14 ? "wide-range" : ""}`}>{range === 14 ? "Если даты не помещаются, прокрутите календарь вправо →" : "Прокрутите календарь вправо, чтобы увидеть дни →"}</small>
      <div className={`supply-calendar-layout ${range === 14 ? "wide-range" : ""}`}>
        <div className="supply-calendar-scroll" role="region" tabIndex={0} aria-label="Сетка календаря поставок">
          <div
            className="supply-calendar-grid"
            style={{ minWidth: range === 14 ? 1360 : range === 7 ? 920 : 760 }}
          >
            <div className="supply-calendar-head">
              <strong>Поставка и этапы</strong>
              <strong className="supply-calendar-fact-heading">Факт</strong>
              <div className="supply-calendar-days">
                {axis.columns.map((column) => (
                  <div
                    key={column.day}
                    className={column.active ? "" : "off"}
                    style={{ width: `${column.width}%` }}
                  >
                    {new Intl.DateTimeFormat("ru-RU", {
                      timeZone: "Europe/Moscow",
                      weekday: "short",
                      day: "2-digit",
                      ...(column.active && range !== 14 ? { month: "short" as const } : {}),
                    }).format(column.day)}
                    {column.active ? (
                      <small>
                        {clock(column.from)}–{clock(column.to)}
                      </small>
                    ) : (
                      <small>Нет смены</small>
                    )}
                  </div>
                ))}
                {now >= start && now < end && (
                  <span className="supply-calendar-now-label" style={{ left: `${left(now)}%` }}>Сейчас</span>
                )}
              </div>
            </div>
            {!rows.length && (
              <p className="supply-calendar-empty">
                По выбранным фильтрам поставок нет.
              </p>
            )}
            {rows.map((row) => {
              const owned = tasks.filter((t) => t.supplyKey === row.key);
              const state = overallForecastStatus(row);
              const stateLabel = {done: "Готово", "on-time": "Успеваем", risk: "Под риском", late: "Позже срока", unknown: "Нужны данные", "no-deadline": "Срок не задан"}[state];
              const deadlines = [
                { kind: "production", label: "Печать и порезка", value: row.readyAt },
                { kind: "packing", label: "Упаковка", value: row.packingAt },
                { kind: "shipping", label: "Отгрузка", value: row.shipAt },
              ] as const;
              const shipAt = row.shipAt ? Date.parse(row.shipAt) : NaN;
              const packingPlan = !row.stock && !row.packingExcluded
                ? packingPlanWindow(row.readyAt, row.packingAt, row.shipAt, packingResource) : null;
              return (
                <article
                  className={`supply-calendar-row ${current?.key === row.key ? "selected" : ""}`}
                  key={row.key}
                >
                  <div className="supply-calendar-name">
                    <button
                      onClick={() => setSelected(row.key)}
                      aria-pressed={current?.key === row.key}
                    >
                      {row.name}
                    </button>
                    <small>{num(row.plan)} шт. в плане</small>
                    <span className={`supply-calendar-state ${state}`}>{stateLabel}</span>
                    {!row.stock && <dl className="supply-calendar-deadlines" aria-label={`Плановые сроки: ${row.name}`}>
                      {deadlines.every(({ value }) => !value) ? <div className="supply-calendar-deadline missing">
                        <dt>Плановые сроки</dt><dd>Не заданы</dd>
                      </div> : deadlines.map(({ kind, label, value }) => {
                        const at = value ? Date.parse(value) : NaN;
                        const valid = Number.isFinite(at);
                        return <div className={`supply-calendar-deadline ${kind}${valid ? "" : " missing"}`} key={kind}>
                          <dt>{label}</dt>
                          <dd>{valid ? <button type="button" className="supply-calendar-deadline-value"
                            onClick={() => kind === "shipping" ? showShipping(row.key, at) : showDate(row.key, at)}
                            aria-label={`${label}: ${instant(at)}. Показать дату в календаре для ${row.name}`}>
                            {instant(at)}{at < start ? <span> ← до периода</span> : at >= end ? <span> → после периода</span> : null}
                          </button> : <span>{value ? "Не подтверждён" : "Не задан"}</span>}</dd>
                        </div>;
                      })}
                    </dl>}
                    {!row.stock && (
                      <button className="supply-calendar-edit-dates" onClick={() => onSelect(row.key)}>
                        {!row.readyAt || !row.packingAt || !row.shipAt ? "Указать сроки" : "Изменить сроки"}
                      </button>
                    )}
                  </div>
                  <div className={`supply-calendar-stages ${!row.stock && Number.isFinite(shipAt) ? "has-shipping" : ""}`}>
                    {!row.stock && Number.isFinite(shipAt) && <div className="supply-calendar-stage shipping">
                      <div className="supply-calendar-stage-label"><strong>Срок отгрузки</strong><small>План: {instant(shipAt)}</small></div>
                      <div className="supply-calendar-fact" aria-label="Факт отгрузки здесь не указан">—</div>
                      <div className="supply-calendar-track">
                        {axis.columns.map((c) => <span key={c.day} className={`supply-calendar-day ${c.active ? "" : "off"}`} style={{ left: `${c.left}%`, width: `${c.width}%` }} />)}
                        {now >= start && now < end && <span className="supply-calendar-now-line" style={{ left: `${left(now)}%` }} aria-hidden="true" />}
                        {shipAt >= start && shipAt < end ? <span className={`supply-calendar-marker shipping-marker ${left(shipAt) > 70 ? "near-end" : ""}`} style={{ left: `${left(shipAt)}%` }} aria-label={`План отгрузки: ${instant(shipAt)}`}>
                          <span>Отгрузка · {instant(shipAt)}</span>
                        </span> : <button type="button" className="supply-calendar-message shipping-date" onClick={() => showShipping(row.key, shipAt)}>
                          Отгрузка {instant(shipAt)} · {shipAt < start ? "← показать" : "показать →"}
                        </button>}
                      </div>
                    </div>}
                    {(["print", "cut", "packing"] as const).map((phase) => {
                      const fact = processFact(owned, phase),
                        label =
                          phase === "print"
                            ? "Печать"
                            : phase === "cut"
                              ? "Порезка"
                              : "Упаковка";
                      const segments: ForecastSegment[] =
                        phase === "packing"
                          ? row.packingSegments
                          : row.segments.filter((s) => s.phase === phase);
                      const visibleWork = segments.some((s) => s.start < end && s.end > start);
                      const window = calendarWorkWindow(segments);
                      const reasons =
                        phase === "packing" ? row.packingReasons : row.reasons;
                      const deadline =
                        phase === "packing" ? row.packingAt : row.readyAt;
                      const finish = phase === "packing" ? row.packingFinishAt : phase === "cut" ? row.finishAt : row.printAt;
                      const confirmed = phase === "packing" ? !row.packingReasons.length : !row.reasons.length;
                      const completed = fact.positions > 0 && !fact.unknownCount && fact.remaining === 0;
                      const allUnknown = fact.positions > 0 && fact.unknownCount === fact.positions;
                      const percentage = processPercent(fact);
                      const deadlineAt = deadline ? Date.parse(deadline) : NaN;
                      const showDeadline = Number.isFinite(deadlineAt) && deadlineAt >= start && deadlineAt < end;
                      const issueStyle = showDeadline
                        ? left(deadlineAt) < 48
                          ? { left: `calc(${left(deadlineAt)}% + 10px)`, maxWidth: `calc(${100 - left(deadlineAt)}% - 20px)` }
                          : { maxWidth: `calc(${left(deadlineAt)}% - 20px)` }
                        : undefined;
                      const windowWidth = window && visibleWork
                        ? left(Math.min(end, window.end)) - left(Math.max(start, window.start)) : 0;
                      return (
                        <div
                          className={`supply-calendar-stage ${phase}`}
                          key={phase}
                        >
                          <div className="supply-calendar-stage-label">
                            <strong><span className={`supply-calendar-phase-icon ${completed ? "complete" : ""}`} aria-hidden="true">{completed ? "✓" : "◔"}</span>{label} {completed ? "" : allUnknown ? "· нет данных" : fact.positions ? `${fact.unknownCount ? "≥" : ""}${percentage}%` : ""}</strong>
                            <small>
                              {phase === "packing" && row.packingExcluded ? (
                                "Не в Assembly"
                              ) : allUnknown ? (
                                "Факт не подтверждён"
                              ) : (
                                <>
                                  {fact.unknownCount ? "≥ " : ""}
                                  {num(fact.ready)} / {num(fact.plan)} шт.
                                </>
                              )}
                            </small>
                            {phase === "cut" && owned.some((item) => item.cutConfirmation) && <small>
                              Руководитель подтвердил {num(owned.reduce((total, item) => total + (item.cutConfirmation ? item.cutConfirmation.quantity - item.cutConfirmation.sourceCut : 0), 0))} шт. для прогноза
                            </small>}
                            {!(phase === "packing" && row.packingExcluded) && (
                              <>
                                <small className="supply-calendar-stage-deadline">
                                  {phase === "packing" ? "Срок" : "План"}: {Number.isFinite(deadlineAt) ? instant(deadlineAt) : deadline ? "не подтверждён" : "не задан"}
                                </small>
                                <small className="supply-calendar-stage-forecast">
                                  {fact.positions && !fact.unknownCount && fact.remaining === 0
                                    ? "Выполнено"
                                    : finish && confirmed ? `Прогноз: ${instant(finish)}` : "Прогноз уточняется"}
                                </small>
                              </>
                            )}
                            {phase === "packing" && packingPlan && <small className="supply-calendar-packing-plan-caption" title={packingPlanText(packingPlan)}>
                              {packingPlan.status === "ready" ? `Окно по графику: ${num(packingPlan.hours, 1)} ч` : packingPlanText(packingPlan)}
                            </small>}
                          </div>
                          <div className="supply-calendar-fact" aria-label={phase === "packing" && row.packingExcluded ? `${label}: нет задания Assembly` : allUnknown || !fact.positions ? `${label}: данные не подтверждены` : `${label}: подтверждено ${num(fact.ready)} из ${num(fact.plan)} штук${fact.unknownCount ? ", данные неполные" : ""}`}>
                            {phase === "packing" && row.packingExcluded ? <span>Нет задания</span> : allUnknown ? <span>Нет данных</span> : fact.positions ? <>
                              <div className="supply-calendar-fact-track"><span style={{ width: `${percentage}%` }} /></div>
                              <strong>{fact.unknownCount ? "≥ " : ""}{num(fact.ready)} / {num(fact.plan)}</strong>
                            </> : <span>Нет данных</span>}
                          </div>
                          <div className="supply-calendar-track">
                            {axis.columns.map((c) => (
                              <span
                                key={c.day}
                                className={`supply-calendar-day ${c.active ? "" : "off"}`}
                                style={{
                                  left: `${c.left}%`,
                                  width: `${c.width}%`,
                                }}
                              />
                            ))}
                            {now >= start && now < end && <span className="supply-calendar-now-line" style={{ left: `${left(now)}%` }} aria-hidden="true" />}
                            {!row.stock && Number.isFinite(shipAt) && shipAt >= start && shipAt < end && <span className="supply-calendar-shipping-guide" style={{ left: `${left(shipAt)}%` }} aria-hidden="true" />}
                            {phase === "packing" && packingPlan?.status === "ready" && packingPlan.shifts.filter(shift => shift.start < end && shift.end > start).map(shift => <span
                              className="supply-calendar-packing-plan-band" key={shift.start}
                              style={{ left: `${left(Math.max(start, shift.start))}%`, width: `${Math.max(0, left(Math.min(end, shift.end)) - left(Math.max(start, shift.start)))}%` }}
                              title={`Плановое окно упаковки: ${instant(shift.start)} — ${instant(shift.end)}. Это не прогноз и не факт.`}
                              aria-hidden="true" />)}
                            {window && visibleWork && (
                              <button
                                type="button"
                                className={`supply-calendar-bar ${window.hasGaps ? "with-gaps" : ""} ${windowWidth < 3 ? "short-window" : ""} ${reasons.length ? "provisional" : ""}`}
                                style={{
                                  left: `${left(Math.max(start, window.start))}%`,
                                  width: `${Math.max(0.3, windowWidth)}%`,
                                }}
                                onClick={() => setSelected(row.key)}
                                title={`${label}: окно расчёта ${instant(window.start)} — ${instant(window.end)} · всего ${num(window.pieces)} шт.${window.hasGaps ? " · с перерывами и другими заданиями" : ""}${reasons.length ? " · предварительно" : ""}`}
                                aria-label={`${label}: окно расчёта ${instant(window.start)} — ${instant(window.end)}, всего ${num(window.pieces)} шт.${window.hasGaps ? ", с перерывами" : ""}${reasons.length ? ", предварительно" : ""}`}
                              >
                                {windowWidth > 16 ? window.hasGaps ? "Окно с перерывами" : "Окно работы" : ""}
                              </button>
                            )}
                            {showDeadline && <span className={`supply-calendar-marker ${phase === "packing" ? "packing-marker" : "production-marker"} ${left(deadlineAt) > 70 ? "near-end" : ""}`} style={{ left: `${left(deadlineAt)}%` }} title={`${phase === "packing" ? "Срок упаковки" : "Срок печати и порезки"}: ${instant(deadlineAt)}`} aria-label={`${phase === "packing" ? "Срок упаковки" : "Срок печати и порезки"}: ${instant(deadlineAt)}`}>
                              <span>{phase === "packing" ? "Упаковка" : "Печать и порезка"} · {instant(deadlineAt)}</span>
                            </span>}
                            {window && <button type="button" className={`supply-calendar-window-summary ${reasons.length ? "partial" : ""}`}
                              onClick={() => reasons.length ? onSelect(row.key) : setSelected(row.key)}
                              title={`${instant(window.start)} — ${instant(window.end)}${window.hasGaps ? "; между партиями возможны перерывы и другие задания" : ""}${reasons.length ? `; ${reasons.join(" · ")}` : ""}`}>
                              <span>{reasons.length ? "Частичный расчёт" : "В расчёте"}: {num(window.pieces)} шт.
                                {window.hasGaps ? " · с перерывами" : ""}{reasons.length ? " · Подробнее" : ""}</span>
                              <span className="supply-calendar-window-period">{instant(window.start)} — {instant(window.end)}{confirmed && finish ? ` · готово по прогнозу ${instant(finish)}` : ""}</span>
                            </button>}
                            {!segments.length &&
                              (phase === "packing" && row.packingExcluded ? (
                                <small className="supply-calendar-message">
                                  Нет задания Assembly
                                </small>
                              ) : fact.positions &&
                                !fact.unknownCount &&
                                fact.remaining === 0 ? (
                                <small className="supply-calendar-message success">
                                  Готово
                                </small>
                              ) : (
                                <button
                                  type="button"
                                  className="supply-calendar-message issue unavailable"
                                  style={issueStyle}
                                  onClick={() => onSelect(row.key)}
                                  title={
                                    reasons.join(" · ") ||
                                    "Расписание пока не рассчитано"
                                  }
                                  aria-label={`${label}: прогноз не рассчитан. ${reasons[0] || "Не хватает данных для расчёта"}. Открыть причины для ${row.name}`}
                                >
                                  <strong>Прогноз не рассчитан</strong>
                                  <span className="supply-calendar-message-reason">{reasons[0] || "Не хватает данных для расчёта"}</span>
                                  <span className="supply-calendar-message-action">Что проверить →</span>
                                </button>
                              ))}
                            {!!segments.length && !window && <button type="button" className="supply-calendar-message issue" onClick={() => onSelect(row.key)}>
                              Не удалось отобразить расчёт · Подробнее
                            </button>}
                            {!!segments.length && !visibleWork && window && (
                              <button type="button" className="supply-calendar-message issue" onClick={() => showDate(row.key, window.start)}>
                                Работа в другом периоде · Показать
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
        {current && (
          <aside
            className="supply-calendar-detail"
            aria-label="Сроки и прогноз выбранной поставки"
          >
            <h4>Сроки и прогноз</h4>
            <strong>{current.name}</strong>
            <dl>
              <div>
                <dt>Печать и порезка к</dt>
                <dd>
                  {deadlineText(current.readyAt)}
                </dd>
              </div>
              <div>
                <dt>Упаковка к</dt>
                <dd>
                  {deadlineText(current.packingAt)}
                </dd>
              </div>
              <div>
                <dt>Отгрузка</dt>
                <dd>
                  {deadlineText(current.shipAt)}
                </dd>
              </div>
            </dl>
            <div className="supply-calendar-detail-forecast">
              <small>Прогноз печати и порезки</small>
              <strong>
                {current.status === "done" ? "Готово" : current.finishAt
                  ? instant(current.finishAt) : "Не рассчитан"}
              </strong>
              {current.printAt && <small>Печать: {instant(current.printAt)}</small>}
              {current.margin !== null && <span className={current.margin < 0 ? "late" : ""}>
                {current.margin < 0 ? `Позже срока на ${num(-current.margin, 1)} ч` : `Запас до срока ${num(current.margin, 1)} ч`}
              </span>}
              {current.reasons[0] && <small>{current.reasons[0]}</small>}
            </div>
            <div className="supply-calendar-detail-forecast">
              <small>Прогноз упаковки</small>
              <strong>
                {current.packingExcluded
                  ? "Нет задания Assembly"
                  : current.packingStatus === "done"
                    ? "Готово"
                    : current.packingFinishAt
                      ? instant(current.packingFinishAt)
                      : "Не рассчитан"}
              </strong>
              {current.packingMargin !== null && (
                <span className={current.packingMargin < 0 ? "late" : ""}>
                  {current.packingMargin < 0
                    ? `Позже срока на ${num(-current.packingMargin, 1)} ч`
                    : `Запас до срока ${num(current.packingMargin, 1)} ч`}
                </span>
              )}
              {current.packingReasons[0] && (
                <small>{current.packingReasons[0]}</small>
              )}
            </div>
            {ahead && <p className="production-process-warning">
              {ahead.article}: упаковано {num(ahead.packed!)} шт., порезка отмечена на {num(ahead.cut!)} шт. Проверьте источник товара.
            </p>}
            {current.bottleneck && (
              <p>
                Последним по прогнозу завершит работу:{" "}
                <strong>
                  {resourceName(current.bottleneck)}
                </strong>
              </p>
            )}
            {!current.bottleneck && current.reasons.length > 0 && largestPartial && (
              <p>
                В рассчитанной части больше всего работы у <strong>{resourceName(largestPartial[0])}</strong>: {num(largestPartial[1] / 3600000, 1)} рабочих ч. Общий срок пока не подтверждён.
              </p>
            )}
            {limitingResource && limitingResource.rate > 0 && <p>Скорость участка: <strong>{resourceRate(limitingResource)}</strong></p>}
            {!current.packingExcluded && packingResource && packingResource.rate > 0 && <p>Упаковка Assembly: <strong>{resourceRate(packingResource)}</strong></p>}
            <Button onClick={() => onSelect(current.key)}>
              Изменить сроки и открыть детали
            </Button>
          </aside>
        )}
      </div>
      <div className="forecast-legend">
        <span>● Печать</span>
        <span>● Порезка</span>
        <span className="supply-calendar-packing-key">● Упаковка</span>
        <span>Насыщенный цвет · факт</span>
        <span>Светлый цвет · прогноз</span>
        <span>Подписанные линии · плановые сроки</span>
        <span>Зелёный пунктир · план отгрузки</span>
        <span>Фиолетовые полоски · плановое окно упаковки по рабочему графику</span>
        <span>Пунктирная рамка · частичный расчёт</span>
      </div>
      <small className="supply-calendar-note">
        Факт показан отдельно от дат: время выполнения прошлых работ может быть неизвестно. Печать и порезка имеют общий плановый срок;
        упаковка и отгрузка — отдельные. Окно упаковки начинается от планового срока производства и учитывает график упаковки; это не прогноз и не запись работы. План отгрузки не означает, что короб уже отправлен. Полосы показывают расчётную
        очередь; пунктир означает неполный расчёт. Окно объединяет партии этапа: внутри могут быть перерывы и другие задания. Количество указано за весь расчёт этапа. Этапы могут идти партиями одновременно.
      </small>
    </section>
  );
}
