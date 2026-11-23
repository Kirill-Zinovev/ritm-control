import "./ProductionForecast.css";
import { ProductionProcess, ProcessStage } from "./ProductionProcess";
import { processFact } from "./productionProcessFacts";
import { ProductionDeadlineFields } from "./ProductionDeadlineFields";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Clock3,
  Settings2,
  ArrowRight,
  AlertTriangle,
  Printer,
  Scissors,
  PackageCheck,
  ChevronRight,
} from "lucide-react";
import {
  Badge,
  Button,
  DataTable,
  Field,
  Modal,
  Notice,
  Progress,
  Search,
} from "./ui";
import { useCloudAuth } from "./CloudAuth";
import type { LivePrinting } from "./livePrinting";
import { useLiveAssembly } from "./liveAssembly";
import { SupplyForecastCalendar } from "./SupplyForecastCalendar";
import { GlobalProductionCalendar } from "./GlobalProductionCalendar";
import { moscowDay } from "./globalCalendar";
import { DailySupplyCalendar } from "./DailySupplyCalendar";
import { MACHINES } from "./machineWorkloadData";
import {
  forecastInput,
  applyConfirmedPackingStock,
  applyConfirmedProductionCuts,
  type AssemblyOnlyForecastItem,
  type AssemblyStockSnapshot,
} from "./productionForecastData";
import {
  buildForecast,
  overallForecastStatus,
  inputInstant,
  moscowInput,
  type ForecastRow,
  type ForecastTask,
} from "./productionForecastModel";
import {
  emptyPlanning,
  validateDeadlines,
  validateResources,
  type Planning,
  type Resource,
  type PackingStockSource,
  type ProductionCutConfirmation,
} from "../shared/productionPlanning";
import { num } from "./model";
import {
  productionRateHistory,
  RATE_WINDOW_DAYS,
  estimateProductionRate,
  planningWithAutomaticRates,
  type ProductionRateHistory,
} from "./productionRateEstimate";

export const PLANNING_RESOURCES = [
  ...MACHINES.map((m) => ({ id: m.id, label: `Печать · ${m.label}` })),
  { id: "cut-roll", label: "Порезка · рулонная печать" },
  { id: "cut-box", label: "Порезка · бокс" },
  { id: "packing", label: "Упаковка · «RITM Сборка»" },
];
const resourceName = (id: string | null) =>
  PLANNING_RESOURCES.find((r) => r.id === id)?.label || id || "—";
const date = (value: number | string | null) =>
  value === null
    ? "—"
    : new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value));
const statusLabel = {
  done: "Печать и порезка готовы",
  "on-time": "Успеваем",
  risk: "Под риском",
  late: "Позже срока",
  unknown: "Недостаточно данных",
  "no-deadline": "Срок не задан",
};
const statusTone = {
  done: "success",
  "on-time": "success",
  risk: "warning",
  late: "danger",
  unknown: "neutral",
  "no-deadline": "neutral",
};
function margin(row: ForecastRow) {
  if (row.margin === null)
    return row.status === "done"
      ? "По подтверждённым отметкам"
      : "Срок пока не рассчитан";
  const n = Math.abs(row.margin);
  return `${row.margin < 0 ? "Задержка" : "Запас"} ${n < 1 ? `${Math.round(n * 60)} мин` : `${n.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ч`}`;
}
async function planningRequest(body?: Record<string, unknown>): Promise<{
  planning: Planning;
  extraItems?: AssemblyOnlyForecastItem[];
  extraItemsConfirmed?: boolean;
}> {
  const response = await fetch("/api/production-planning", {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json().catch(() => null);
  if (
    !response.ok ||
    !result?.ok ||
    !Number.isSafeInteger(result.planning?.revision) ||
    !Array.isArray(result.planning?.resources) ||
    !result.planning?.deadlines
  )
    throw new Error(
      result?.message || "Не удалось загрузить настройки прогноза.",
    );
  return result;
}
export function ProductionForecast({
  live,
  onRefresh,
  loading,
  compact,
  onForecastChange,
  onOpenCalendar,
}: {
  live: LivePrinting | null;
  onRefresh: () => void;
  loading: boolean;
  compact: boolean;
  onForecastChange: (rows: ForecastRow[]) => void;
  onOpenCalendar: () => void;
}) {
  const auth = useCloudAuth();
  const [planning, setPlanning] = useState<Planning>(emptyPlanning),
    [extras, setExtras] = useState<{
      items: AssemblyOnlyForecastItem[];
      at: number;
    } | null>(null),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [reading, setReading] = useState(false);
  const [view, setView] = useState<"supplies" | "calendar">("calendar"),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [selected, setSelected] = useState<string | null>(null),
    [settings, setSettings] = useState(false);
  const [settingsResource, setSettingsResource] = useState("2-go");
  const [calendarFocus, setCalendarFocus] = useState<{
    key: string;
    at: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now);
  const [selectedDay, setSelectedDay] = useState(() => moscowDay(Date.now()));
  const moscowDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const assemblyDate = moscowDate.format(now);
  const historyStart = (extras?.items || []).reduce((start, item) => {
    const createdAt = Date.parse(item.createdAt);
    return Number.isFinite(createdAt) ? Math.min(start, createdAt) : start;
  }, now - RATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const assembly = useLiveAssembly(assemblyDate, "month", true, {
    assemblyOnly: auth.mode === "cloud",
    range: auth.mode === "cloud" ? { start: moscowDate.format(historyStart), end: assemblyDate } : undefined,
  });
  const [stockSnapshot, setStockSnapshot] =
    useState<AssemblyStockSnapshot | null>(null);
  const [stockReason, setStockReason] = useState(
    "Загружаем задания «Запасы склад» для прогноза упаковки.",
  );
  const [stockRevision, setStockRevision] = useState(0);
  const [extraRetryStep, setExtraRetryStep] = useState(0);
  const [calendarMode, setCalendarMode] = useState<"months" | "supplies" | "resources">(
    "months",
  );
  const [supplyCalendarLayout, setSupplyCalendarLayout] = useState<"cards" | "timeline">("cards");
  const editing = useRef(false);
  editing.current = !!selected || settings;
  const read = useCallback(async (background = false) => {
    if (background && editing.current) return;
    setReading(true);
    setError("");
    try {
      const result = await planningRequest();
      if (background && editing.current) return;
      setPlanning((previous) =>
        result.planning.revision >= previous.revision
          ? result.planning
          : previous,
      );
      setExtras(
        result.extraItemsConfirmed === true && Array.isArray(result.extraItems)
          ? { items: result.extraItems, at: Date.now() }
          : null,
      );
      setLoaded(true);
    } catch (e) {
      if (!background || !editing.current) setExtras(null);
      setError(e instanceof Error ? e.message : "Настройки недоступны.");
    } finally {
      setReading(false);
    }
  }, []);
  useEffect(() => {
    void read();
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    const refreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void read(true);
    }, 5 * 60000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(refreshTimer);
    };
  }, [read]);
  // A production write can briefly overlap the consistent read of extra
  // Assembly items. Retry the read without waiting five minutes, but never
  // display its intermediate data as confirmed or interrupt an editor.
  useEffect(() => {
    if (!loaded || extras !== null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const next = () => { if (!cancelled) setExtraRetryStep((value) => value + 1); };
      if (document.visibilityState === "visible" && !editing.current)
        void read(true).finally(next);
      else next();
    }, extraRetryStep < 6 ? 5000 : 60000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [loaded, extras, extraRetryStep, read]);
  useEffect(() => {
    let active = true,
      pending = false,
      retryTimer: number | null = null;
    const controller = new AbortController();
    let forceStockRead = stockRevision > 0;
    const load = async () => {
      if (pending) return;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      pending = true;
      try {
        const response = await fetch(forceStockRead ? "/api/assembly-stocks?view=forecast&refresh=1" : "/api/assembly-stocks?view=forecast", {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(45000),
          ]),
        });
        if (response.status === 401 || response.status === 403)
          throw new Error("Нет доступа к заданиям «Запасы склад» в «RITM Сборка». Войдите повторно.");
        const data = await response.json();
        if (!response.ok && data?.error === "assembly_stock_unavailable" &&
            typeof data.message === "string" && data.message.startsWith("Запасы для сборки: "))
          throw new Error(data.message.replace(/[\r\n\t]/g, " ").slice(0, 200));
        if (!response.ok)
          throw new Error("Не удалось получить задания «Запасы склад» из «RITM Сборка». Повторяем запрос.");
        if (
          data?.ok !== true ||
          data.shipmentId !== "RITM-STOCK-WAREHOUSE" ||
          data.destination !== "warehouse" ||
          !Array.isArray(data.items) ||
          data.items.length > 1500 ||
          !Number.isFinite(Date.parse(data.updatedAt))
        )
          throw new Error("Данные заданий «Запасы склад» неполные. Повторяем запрос.");
        if (active) {
          forceStockRead = false;
          setStockSnapshot({ updatedAt: data.updatedAt, items: data.items });
          setStockReason("");
        }
      } catch (e) {
        if (active) {
          setStockSnapshot(null);
          setStockReason(e instanceof Error && (e.message.startsWith("Нет доступа") || e.message.startsWith("Запасы для сборки: "))
            ? e.message
            : e instanceof Error && e.message.startsWith("Данные заданий")
              ? e.message
              : "Не удалось получить задания «Запасы склад» из «RITM Сборка». Повторяем запрос.");
          retryTimer = window.setTimeout(() => {
            if (document.visibilityState === "visible") void load();
          }, 60000);
        }
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5 * 60000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [stockRevision]);
  const input = useMemo(
    () =>
      applyConfirmedProductionCuts(applyConfirmedPackingStock(forecastInput(
        live,
        now,
        extras && now - extras.at <= 6 * 60000 ? extras.items : null,
        assembly.value,
        stockSnapshot,
        stockReason,
      ), planning.stockSources), planning.cutConfirmations),
    [live, now, extras, assembly.value, stockSnapshot, stockReason, planning.stockSources, planning.cutConfirmations],
  );
  const rateHistory = useMemo(
    () => productionRateHistory(live, assembly.value),
    [live, assembly.value],
  );
  const effectivePlanning = useMemo(
    () => planningWithAutomaticRates(planning, rateHistory, now),
    [planning, rateHistory, now],
  );
  const rateProblems = useMemo(
    () =>
      Object.fromEntries(
        PLANNING_RESOURCES.map(({ id, label }) => {
          const resource = planning.resources.find((r) => r.id === id);
          return [
            id,
            {
              label,
              reason:
                resource?.rateMode === "auto"
                  ? estimateProductionRate(rateHistory, resource, now).reason
                  : "Укажите скорость участка.",
            },
          ];
        }),
      ),
    [planning, rateHistory, now],
  );
  const rows = useMemo(
    () => buildForecast(input, effectivePlanning, now, rateProblems),
    [input, effectivePlanning, now, rateProblems],
  );
  useEffect(() => {
    if (loaded) onForecastChange(rows);
  }, [loaded, rows, onForecastChange]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru-RU");
    const articleMatches = new Set<string>();
    if (query) {
      for (const task of input.tasks) {
        if (task.article.toLocaleLowerCase("ru-RU").includes(query))
          articleMatches.add(task.supplyKey);
      }
    }
    return rows.filter((row) =>
      (filter === "all" ||
        (filter === "stock" && row.stock) ||
        overallForecastStatus(row) === filter) &&
      (!query || row.name.toLocaleLowerCase("ru-RU").includes(query) || articleMatches.has(row.key)),
    );
  }, [rows, input.tasks, filter, search]);
  const row = rows.find((r) => r.key === selected) || null;
  const save = async (body: Record<string, unknown>) => {
    const next = (
      await planningRequest({
        ...body,
        revision: planning.revision,
      })
    ).planning;
    setPlanning(next);
    return next;
  };
  const monthOverview = view === "calendar" && calendarMode === "months";
  const refreshForecast = () => {
    void read();
    onRefresh();
    void assembly.reload(true);
    setStockRevision((n) => n + 1);
  };
  const calendarToolbar = (
    <>
        <Search value={search} onChange={setSearch} label="Поставка или артикул" />
        <select aria-label="Вид календаря" value={view === "supplies" ? "process" : calendarMode} onChange={(event) => {
          const mode = event.target.value;
          setFilter("all");
          if (mode === "process") setView("supplies");
          else {
            setView("calendar");
            if (mode === "months" || mode === "supplies" || mode === "resources") setCalendarMode(mode);
          }
        }}>
          <option value="months">Обзор месяцев</option>
          <option value="supplies">По поставкам</option>
          <option value="resources">По станкам</option>
          <option value="process">Процесс и прогноз</option>
        </select>
        {!monthOverview && <select aria-label="Статус прогноза" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">Все задания</option>
          <option value="stock">Запасы</option>
          {Object.entries(statusLabel).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
        </select>}
        <Button onClick={refreshForecast} disabled={reading || loading}>Обновить</Button>
        {auth.role === "owner" && <Button disabled={!loaded || reading} onClick={() => setSettings(true)}><Settings2 size={17} /> Скорость и график</Button>}
    </>
  );
  const monthCalendar = (isCompact: boolean) => (
    <GlobalProductionCalendar
      rows={isCompact ? rows : filtered}
      tasks={input.tasks}
      now={now}
      onSelect={setSelected}
      planning={effectivePlanning}
      fresh={input.fresh}
      selectedDay={selectedDay}
      onDayChange={setSelectedDay}
      compact={isCompact}
      toolbar={!isCompact && calendarToolbar}
      onOpenCalendar={() => {
        setView("calendar");
        setCalendarMode("months");
        setSearch("");
        setFilter("all");
        onOpenCalendar();
      }}
      onOpenResources={() => {
        setCalendarFocus({ key: "", at: selectedDay });
        setCalendarMode("resources");
      }}
    />
  );
  return (
    <section
      className="forecast-workspace"
      aria-label="Прогноз сроков производства"
    >
      {compact ? (
        <>
          {loaded ? monthCalendar(true) : (
            <section className="card global-calendar global-calendar-compact">
              <header className="global-calendar-heading">
                <h3>Календарь</h3>
                <Button onClick={onOpenCalendar}>Обзор месяцев</Button>
              </header>
              <div className="global-calendar-empty" role="status">
                {error ? <Button onClick={() => void read()}>Повторить загрузку сроков</Button> : "Загружаем сроки поставок…"}
              </div>
            </section>
          )}
        </>
      ) : (
        <>
      {error && (
        <Notice tone="warning">
          {error}{" "}
          <Button onClick={() => void read()} disabled={reading}>
            Повторить загрузку
          </Button>
        </Notice>
      )}
      {!loaded && !error ? (
        <Notice>Загружаем настройки прогноза…</Notice>
      ) : null}
      {loaded && !planning.resources.length && !monthOverview && (
        <div className="forecast-setup">
          <CalendarDays size={30} />
          <div>
            <strong>Настройте рабочие графики участков</strong>
            <p>
              {auth.role === "owner"
                ? "Скорость можно рассчитывать по журналам или задать вручную. Для расчёта нужны рабочие дни и часы смены."
                : "Руководителю нужно задать скорость и рабочий график участков."}{" "}
              Производственные отметки и история сохраняются.
            </p>
          </div>
          {auth.role === "owner" && (
            <Button kind="primary" onClick={() => setSettings(true)}>
              Настроить участки <ArrowRight size={16} />
            </Button>
          )}
        </div>
      )}
      {!monthOverview && <div className="forecast-summary">
        {[
          ["on-time", "Успеваем"],
          ["risk", "Под риском"],
          ["late", "Позже срока"],
          ["unknown", "Нужны данные"],
          ["no-deadline", "Срок не задан"],
        ].map(([state, label]) => (
          <button
            type="button"
            key={state}
            className={`forecast-summary-item ${state} ${filter === state ? "active" : ""}`}
            onClick={() => setFilter(filter === state ? "all" : state)}
          >
            <span>{label}</span>
            <strong>
              {rows.filter((r) => overallForecastStatus(r) === state).length}
            </strong>
          </button>
        ))}
      </div>}
      {(!monthOverview || !loaded) && <div className="forecast-toolbar mw-calendar-toolbar">{calendarToolbar}</div>}
      {loaded && view === "supplies" && (
        <ProductionProcess
          rows={filtered}
          tasks={input.tasks}
          fresh={input.fresh}
          onSelect={setSelected}
        />
      )}
      {loaded && view === "supplies" && (
        <details className="card forecast-table production-forecast-register">
          <summary>Таблица сроков и прогноза · {filtered.length}</summary>
          <DataTable
            label="Сроки поставок и запасов"
            rows={filtered}
            rowKey={(r) => r.key}
            pageSize={20}
            onSelect={(r) => setSelected(r.key)}
            selected={selected || undefined}
            columns={[
              {
                id: "name",
                label: "Поставка / задание",
                render: (r) => (
                  <div className="forecast-supply">
                    <span
                      className={`forecast-market ${r.market === "WB" ? "wb" : ""}`}
                    >
                      {r.market || "R"}
                    </span>
                    <span>
                      <strong>{r.name}</strong>
                      <small>
                        {r.stock
                          ? "Запасы · участвуют в общей очереди"
                          : `${num(r.plan)} шт.`}
                        {r.urgent ? " · 🔥 Срочно" : ""}
                      </small>
                    </span>
                  </div>
                ),
                sort: (r) => r.name,
              },
              {
                id: "deadline",
                label: "Готовность к",
                render: (r) => (
                  <>
                    <strong>{date(r.readyAt)}</strong>
                    <small>
                      {r.shipAt
                        ? `Отгрузка ${date(r.shipAt)}`
                        : "Отгрузка не задана"}
                    </small>
                  </>
                ),
                sort: (r) => r.readyAt || "9999",
              },
              {
                id: "print",
                label: "Печать",
                render: (r) => (
                  <ProcessStage
                    compact
                    fact={processFact(
                      input.tasks.filter((t) => t.supplyKey === r.key),
                      "print",
                    )}
                    phase="print"
                  />
                ),
              },
              {
                id: "cut",
                label: "Порезка",
                render: (r) => (
                  <ProcessStage
                    compact
                    fact={processFact(
                      input.tasks.filter((t) => t.supplyKey === r.key),
                      "cut",
                    )}
                    phase="cut"
                  />
                ),
              },
              {
                id: "packing",
                label: "Упаковка",
                render: (r) => (
                  <ProcessStage
                    compact
                    notApplicable={r.packingExcluded}
                    fact={processFact(
                      input.tasks.filter((t) => t.supplyKey === r.key),
                      "packing",
                    )}
                    phase="packing"
                  />
                ),
              },
              {
                id: "eta",
                label: "Готовность печати и порезки",
                render: (r) => (
                  <>
                    <strong>{date(r.finishAt)}</strong>
                    <small>
                      {r.finishAt
                        ? resourceName(r.bottleneck)
                        : r.reasons[0] ||
                          "Историческое время не восстанавливаем"}
                    </small>
                  </>
                ),
              },
              {
                id: "status",
                label: "Прогноз",
                render: (r) => (
                  <>
                    <Badge tone={statusTone[overallForecastStatus(r)]}>
                      {overallForecastStatus(r) === "done"
                        ? "Все этапы готовы"
                        : statusLabel[overallForecastStatus(r)]}
                    </Badge>
                    <small>
                      {r.packingFinishAt
                        ? `Упаковка: ${date(r.packingFinishAt)}`
                        : r.packingExcluded
                          ? "Не передаётся в «RITM Сборка»"
                          : r.packingReasons[0] || "Срок упаковки не рассчитан"}
                    </small>
                  </>
                ),
              },
              {
                id: "detail",
                label: "Детали",
                render: (r) => (
                  <Button
                    aria-label={`Открыть прогноз ${r.name}`}
                    onClick={() => setSelected(r.key)}
                  >
                    <ChevronRight size={16} />
                  </Button>
                ),
              },
            ]}
          />
        </details>
      )}
      {loaded && monthOverview && monthCalendar(false)}
      {loaded && view === "calendar" && calendarMode === "supplies" && supplyCalendarLayout === "cards" && (
        <DailySupplyCalendar
          rows={filtered}
          tasks={input.tasks}
          now={now}
          onSelect={setSelected}
          focus={calendarFocus}
          planning={effectivePlanning}
          fresh={input.fresh}
          onTimeline={() => setSupplyCalendarLayout("timeline")}
        />
      )}
      {loaded && view === "calendar" && calendarMode === "supplies" && supplyCalendarLayout === "timeline" && (
        <>
        <div className="daily-supply-return"><Button onClick={() => setSupplyCalendarLayout("cards")}>← К карточкам по дням</Button></div>
        <SupplyForecastCalendar
          rows={filtered}
          tasks={input.tasks}
          now={now}
          onSelect={setSelected}
          focus={calendarFocus}
          planning={effectivePlanning}
          fresh={input.fresh}
        />
        </>
      )}
      {loaded && view === "calendar" && calendarMode === "resources" && (
        <ForecastCalendar
          rows={filtered}
          tasks={input.tasks.filter((task) =>
            filtered.some((row) => row.key === task.supplyKey),
          )}
          now={now}
          onSelect={setSelected}
          planning={effectivePlanning}
          focus={calendarFocus}
          onSettings={
            auth.role === "owner"
              ? (id) => {
                  setSettingsResource(id);
                  setSettings(true);
                }
              : undefined
          }
        />
      )}
      {!monthOverview && <div className="forecast-method">
        <Clock3 size={18} />
        <span>
          Оценка по заданной скорости, а не обещание отгрузки. Срочные задания
          идут первыми, затем задания с ближайшим сроком. Порезка начинается
          партиями после печати. Расчёт обновлён {date(now)} МСК. Упаковка
          рассчитывается отдельно с учётом общей очереди «RITM Сборка».
        </span>
      </div>}
        </>
      )}
      <Modal
        open={!!row}
        onClose={() => setSelected(null)}
        title={row?.name || "Прогноз поставки"}
        description="Печать, порезка и упаковка · московское время"
      >
        {row && (
          <ForecastDetail
            key={row.key}
            row={row}
            tasks={input.tasks.filter((task) => task.supplyKey === row.key)}
            canConfirmStock={auth.role === "owner" && loaded}
            stockSources={planning.stockSources || []}
            cutConfirmations={planning.cutConfirmations || []}
            save={save}
            refresh={read}
            calendar={() => {
              setCalendarFocus({
                key: row.key,
                at:
                  row.finishAt ||
                  Date.parse(row.readyAt || row.shipAt || "") ||
                  now,
              });
              setView("calendar");
              setCalendarMode("supplies");
              setFilter("all");
              onOpenCalendar();
              setSearch(row.name);
              setSelected(null);
            }}
            editable={loaded && !row.stock}
          />
        )}
      </Modal>
      <Modal
        open={settings}
        onClose={() => setSettings(false)}
        title="Скорость и график участков"
        description="Эти настройки влияют только на прогноз. Производственные планы и выработка не меняются."
      >
        <ForecastSettings
          key={settings ? `open:${settingsResource}` : "closed"}
          initialId={settingsResource}
          planning={planning}
          history={rateHistory}
          now={now}
          loaded={loaded}
          save={save}
          refresh={read}
        />
      </Modal>
    </section>
  );
}

function ForecastDetail({
  row,
  tasks,
  canConfirmStock,
  stockSources,
  cutConfirmations,
  save,
  refresh,
  calendar,
  editable,
}: {
  row: ForecastRow;
  tasks: ForecastTask[];
  canConfirmStock: boolean;
  stockSources: PackingStockSource[];
  cutConfirmations: ProductionCutConfirmation[];
  save: (v: Record<string, unknown>) => Promise<Planning>;
  refresh: () => Promise<void>;
  calendar: () => void;
  editable: boolean;
}) {
  const [ready, setReady] = useState(moscowInput(row.readyAt)),
    [packing, setPacking] = useState(moscowInput(row.packingAt)),
    [ship, setShip] = useState(moscowInput(row.shipAt)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved("");
    try {
      const deadlines = validateDeadlines({
        readyAt: inputInstant(ready),
        packingAt: inputInstant(packing),
        shipAt: inputInstant(ship),
      });
      setBusy(true);
      await save({ action: "deadlines", key: row.key, deadlines });
      setSaved("Сроки сохранены. Прогноз пересчитан.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить сроки.");
    } finally {
      setBusy(false);
    }
  }
  const resources = [...new Set(row.segments.map((s) => s.resource))];
  return (
    <div className="forecast-detail">
      <div className={`forecast-verdict ${row.status}`}>
        <small>Печать и порезка</small>
        <Badge tone={statusTone[row.status]}>{statusLabel[row.status]}</Badge>
        <h3>
          {row.finishAt
            ? date(row.finishAt)
            : row.status === "done"
              ? "Оба этапа выполнены"
              : "Нужно уточнить данные"}
        </h3>
        <p>{margin(row)}</p>
      </div>
      {row.reasons.length > 0 && (
        <div className="forecast-reasons">
          <strong>
            <AlertTriangle size={16} /> Что мешает расчёту
          </strong>
          <ul>
            {row.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="forecast-stages">
        <div>
          <Printer size={20} />
          <span>
            Печать<strong>{date(row.printAt)}</strong>
          </span>
        </div>
        <div>
          <Scissors size={20} />
          <span>
            Печать и порезка готовы<strong>{date(row.finishAt)}</strong>
          </span>
        </div>
        <div>
          <PackageCheck size={20} />
          <span>
            Упаковка
            <strong>
              {row.packingExcluded
                ? "Не передаётся в «RITM Сборка»"
                : row.packingStatus === "done"
                  ? "Готово"
                  : date(row.packingFinishAt)}
            </strong>
          </span>
        </div>
      </div>
      {row.packingReasons.length > 0 && (
        <Notice tone="warning">Упаковка: {row.packingReasons.join(" ")}</Notice>
      )}
      {tasks.some((task) => task.cutConfirmation) && <Notice>
        Порезка для прогноза подтверждена руководителем: {tasks.filter((task) => task.cutConfirmation).map((task) => `${task.article} · ${num(task.cutConfirmation!.quantity)} шт.`).join(", ")}. Дата и исполнитель не указаны; производственный журнал не изменён.
      </Notice>}
      {canConfirmStock && <ProductionCutConfirmationForm tasks={tasks} confirmations={cutConfirmations} save={save} refresh={refresh} />}
      {canConfirmStock && <PackingStockSourceForm tasks={tasks} sources={stockSources} save={save} refresh={refresh} />}
      {row.packingMargin !== null && (
        <Notice>
          Упаковка:{" "}
          {row.packingMargin < 0
            ? `позже срока на ${num(-row.packingMargin, 1)} ч`
            : `запас до срока ${num(row.packingMargin, 1)} ч`}
          .
        </Notice>
      )}
      {row.bottleneck && (
        <Notice>
          Последним заканчивает {resourceName(row.bottleneck)}. Время включает
          очередь других заданий и нерабочие часы.
        </Notice>
      )}
      {resources.length > 0 && (
        <div className="forecast-resource-details">
          <h3>Участки задания</h3>
          {resources.map((id) => {
            const parts = row.segments.filter((s) => s.resource === id);
            return (
              <div key={id}>
                <strong>{resourceName(id)}</strong>
                <span>{date(Math.max(...parts.map((s) => s.end)))}</span>
                <small>
                  {num(parts.reduce((n, s) => n + s.pieces, 0))} шт. ·{" "}
                  {num(
                    parts.reduce((n, s) => n + (s.end - s.start) / 3600000, 0),
                  )}{" "}
                  рабочих ч
                </small>
              </div>
            );
          })}
        </div>
      )}
      {editable && (
        <form onSubmit={submit}>
          <h3>Сроки поставки</h3>
          <ProductionDeadlineFields
            ready={ready}
            packing={packing}
            ship={ship}
            onReady={setReady}
            onPacking={setPacking}
            onShip={setShip}
            disabled={busy}
          />
          {error && (
            <Notice tone="warning">
              {error}
              <Button disabled={busy} onClick={() => void refresh()}>
                Обновить настройки
              </Button>
            </Notice>
          )}
          {saved && <Notice>{saved}</Notice>}
          <Button type="submit" kind="primary" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить сроки"}
          </Button>
        </form>
      )}
      {row.stock && (
        <p>
          Запасы учитываются в очереди. Сроки поставок редактируются в их
          карточках.
        </p>
      )}
      <Button onClick={calendar}>
        <CalendarDays size={17} /> Посмотреть в календаре
      </Button>
      <small>
        План: {num(row.plan)} шт. Отгрузка {date(row.shipAt)}. Срок отгрузки не
        включает прочие операции после упаковки.
      </small>
    </div>
  );
}

function ProductionCutConfirmationForm({ tasks, confirmations, save, refresh }: {
  tasks: ForecastTask[];
  confirmations: ProductionCutConfirmation[];
  save: (v: Record<string, unknown>) => Promise<Planning>;
  refresh: () => Promise<void>;
}) {
  const candidates = tasks.filter((task) => !task.assemblyOnly && !task.stock &&
    Number.isSafeInteger(task.plan) && task.plan > 0 && task.printed != null && task.printed >= task.plan &&
    (task.cut === 0 || !!task.cutConfirmation || confirmations.some((event) => event.taskId === task.id)));
  const [id, setId] = useState(candidates[0]?.id || "");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const task = candidates.find((item) => item.id === id);
  if (!task) return null;
  async function submit(quantity: number) {
    setNotice(""); setError("");
    try {
      setBusy(true);
      await save({ action: "cut-confirmation", taskId: task!.id, article: task!.article, quantity });
      setNotice(quantity ? "Порезка для прогноза подтверждена. Производственные журналы не изменены." : "Подтверждение снято. История сохранена.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить подтверждение.");
    } finally { setBusy(false); }
  }
  return <details className="forecast-resource-details">
    <summary>Порезка выполнена, но не отмечена</summary>
    <p>Для прогноза можно подтвердить порезку всего плана. Исполнитель и дата выполнения останутся неизвестными; таблицы и выработка не изменятся.</p>
    <Field label="Артикул порезки">
      <select aria-label="Артикул порезки" value={id} disabled={busy} onChange={(e) => { setId(e.target.value); setNotice(""); setError(""); }}>
        {candidates.map((item) => <option key={item.id} value={item.id}>{item.article} · {num(item.plan)} шт.{item.cutConfirmation ? " · подтверждено" : ""}</option>)}
      </select>
    </Field>
    {confirmations.some((event) => event.taskId === task.id) && <details>
      <summary>История подтверждений порезки</summary>
      <ul>{confirmations.filter((event) => event.taskId === task.id).map((event, index) =>
        <li key={`${event.recordedAt}:${index}`}>{date(event.recordedAt)} · {event.recordedBy} · {event.quantity ? `${num(event.quantity)} шт.` : "подтверждение снято"}</li>)}</ul>
    </details>}
    {error && <Notice tone="warning">{error} <Button type="button" onClick={() => void refresh()} disabled={busy}>Обновить данные</Button></Notice>}
    {notice && <Notice>{notice}</Notice>}
    <Button type="button" kind="primary" disabled={busy || !!task.cutConfirmation} onClick={() => void submit(task.plan)}>
      {busy ? "Сохраняем…" : `Подтвердить ${num(task.plan)} шт. для прогноза`}
    </Button>
    {task.cutConfirmation && <Button type="button" disabled={busy} onClick={() => void submit(0)}>Снять подтверждение</Button>}
  </details>;
}

function PackingStockSourceForm({ tasks, sources, save, refresh }: {
  tasks: ForecastTask[];
  sources: PackingStockSource[];
  save: (v: Record<string, unknown>) => Promise<Planning>;
  refresh: () => Promise<void>;
}) {
  const candidates = tasks.filter((task) => !task.assemblyOnly && !task.packingExcluded &&
    task.packed != null && task.cut != null &&
    (task.packed > task.cut || (task.stockPacked || 0) > 0 || sources.some((event) => event.taskId === task.id)));
  const [id, setId] = useState(candidates[0]?.id || "");
  const task = candidates.find((item) => item.id === id);
  const [quantity, setQuantity] = useState(task?.stockPacked !== undefined ? String(task.stockPacked) : "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  if (!candidates.length || !task) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNotice(""); setError("");
    const value = Number(quantity);
    if (!quantity.trim() || !Number.isSafeInteger(value) || value < 0 || value > task!.packed!) {
      setError("Укажите целое количество не больше уже упакованного.");
      return;
    }
    try {
      setBusy(true);
      await save({ action: "packing-stock", taskId: task!.id, article: task!.article, quantity: value });
      setNotice("Источник сохранён. Прогноз пересчитан.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить источник.");
    } finally { setBusy(false); }
  }
  return <details className="forecast-resource-details">
    <summary>Товар взяли из запасов</summary>
    <p>Укажите, сколько уже упакованных штук взяли готовыми со склада. Можно указать всё фактическое количество; прогноз учитывает его в пределах плана. Отметка не списывает остатки и не меняет план, выработку или журнал.</p>
    <form onSubmit={submit}>
      <Field label="Артикул">
        <select value={id} disabled={busy} onChange={(e) => {
          const next = candidates.find((item) => item.id === e.target.value);
          setId(e.target.value); setQuantity(next?.stockPacked !== undefined ? String(next.stockPacked) : ""); setNotice(""); setError("");
        }}>
          {candidates.map((item) => <option key={item.id} value={item.id}>{item.article} · упаковано {num(item.packed!)} · порезано {num(item.cut!)}</option>)}
        </select>
      </Field>
      <Field label="Из упакованного взято со склада, шт.">
        <input type="number" min="0" max={task.packed!} step="1" value={quantity} disabled={busy} onChange={(e) => setQuantity(e.target.value)} />
      </Field>
      {sources.some((event) => event.taskId === task.id) && <details>
        <summary>История подтверждений</summary>
        <ul>{sources.filter((event) => event.taskId === task.id).map((event, index) =>
          <li key={`${event.recordedAt}:${index}`}>{date(event.recordedAt)} · {event.recordedBy} · {num(event.quantity)} шт.</li>)}</ul>
      </details>}
      {error && <Notice tone="warning">{error} <Button type="button" onClick={() => void refresh()} disabled={busy}>Обновить данные</Button></Notice>}
      {notice && <Notice>{notice}</Notice>}
      <Button type="submit" kind="primary" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить источник"}</Button>
    </form>
  </details>;
}

export function ForecastCalendar({
  rows,
  tasks,
  now,
  onSelect,
  planning,
  focus,
  onSettings,
}: {
  rows: ForecastRow[];
  tasks: ForecastTask[];
  now: number;
  onSelect: (key: string) => void;
  planning: Planning;
  focus: { key: string; at: number } | null;
  onSettings?: (id: string) => void;
}) {
  const [offset, setOffset] = useState(0),
    [range, setRange] = useState(3);
  useEffect(() => {
    if (focus && Number.isFinite(focus.at))
      setOffset(
        Math.floor((focus.at + 10800000) / 86400000) -
          Math.floor((now + 10800000) / 86400000),
      );
  }, [focus]);
  const day = 86400000,
    start = Math.floor((now + 10800000) / day) * day - 10800000 + offset * day,
    end = start + range * day;
  const days = Array.from({ length: range }, (_, i) => start + i * day);
  const time = (n: number) =>
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      hour: "2-digit",
      minute: "2-digit",
    }).format(n);
  const resources = [
    ...PLANNING_RESOURCES.filter((r) =>
      MACHINES.some((m) => m.id === r.id && m.department === "roll"),
    ),
    PLANNING_RESOURCES.find((r) => r.id === "cut-roll")!,
    ...PLANNING_RESOURCES.filter((r) =>
      MACHINES.some((m) => m.id === r.id && m.department === "box"),
    ),
    PLANNING_RESOURCES.find((r) => r.id === "cut-box")!,
    PLANNING_RESOURCES.find((r) => r.id === "packing")!,
  ].filter(
    (r) =>
      r.id === "packing" ||
      planning.resources.some((c) => c.id === r.id) ||
      tasks.some(
        (t) =>
          (t.printed === null ||
            t.cut === null ||
            t.printed < t.plan ||
            t.cut < t.plan) &&
          (t.machine === r.id || `cut-${t.department}` === r.id),
      ) ||
      rows.some((s) => s.segments.some((p) => p.resource === r.id)),
  );
  const periods = (id: string) => {
    const segments = rows
      .flatMap((row) =>
        (id === "packing" ? row.packingSegments || [] : row.segments)
          .filter((s) => s.resource === id && s.start < end && s.end > start)
          .map((s) => ({ ...s, row })),
      )
      .sort((a, b) => a.start - b.start);
    const merged: typeof segments = [];
    for (const s of segments) {
      const last = merged[merged.length - 1];
      if (
        last &&
        last.supplyKey === s.supplyKey &&
        Math.abs(last.end - s.start) < 1
      ) {
        last.end = s.end;
        last.pieces += s.pieces;
        last.article = "Несколько партий";
      } else merged.push({ ...s });
    }
    return merged;
  };
  const position = (n: number) => ((n - start) / (end - start)) * 100;
  const markers = rows
    .flatMap((r) => [
      { at: r.readyAt, kind: "production", row: r },
      { at: r.packingAt, kind: "packing", row: r },
      { at: r.shipAt, kind: "shipping", row: r },
    ])
    .filter(
      (m) => m.at && Date.parse(m.at) >= start && Date.parse(m.at) <= end,
    );
  return (
    <div className="card forecast-calendar">
      <div className="forecast-calendar-heading">
        <div>
          <h3>Расписание печати и порезки</h3>
          <small>
            Расчётная очередь · МСК · фактическое выполнение во вкладке
            «Процесс»
          </small>
        </div>
        <div className="forecast-actions">
          {rows.some(
            (r) =>
              r.segments.length > 0 || (r.packingSegments || []).length > 0,
          ) && (
            <Button
              onClick={() => {
                const first = Math.min(
                  ...rows.flatMap((r) =>
                    [...r.segments, ...(r.packingSegments || [])].map(
                      (s) => s.start,
                    ),
                  ),
                );
                setOffset(
                  Math.floor((first + 10800000) / day) -
                    Math.floor((now + 10800000) / day),
                );
                setRange(7);
              }}
            >
              Показать работу
            </Button>
          )}
          <select
            aria-label="Масштаб календаря"
            value={range}
            onChange={(e) => setRange(Number(e.target.value))}
          >
            <option value={1}>День</option>
            <option value={3}>3 дня</option>
            <option value={7}>Неделя</option>
          </select>
          <Button
            aria-label="Предыдущий период календаря"
            onClick={() => setOffset((n) => n - range)}
          >
            ←
          </Button>
          <Button onClick={() => setOffset(0)}>Сегодня</Button>
          <Button
            aria-label="Следующий период календаря"
            onClick={() => setOffset((n) => n + range)}
          >
            →
          </Button>
        </div>
      </div>
      <div className="forecast-calendar-scroll">
        <div
          className="forecast-timeline"
          style={{ minWidth: range === 7 ? 1350 : 1000 }}
        >
          <div className="forecast-timeline-header">
            <div>Участок</div>
            <div className="forecast-time-axis">
              {days.map((d) => (
                <div key={d} style={{ width: `${100 / range}%` }}>
                  <strong>
                    {new Intl.DateTimeFormat("ru-RU", {
                      timeZone: "Europe/Moscow",
                      weekday: "short",
                      day: "2-digit",
                      month: "short",
                    }).format(d)}
                  </strong>
                  <div className="forecast-hour-ticks">
                    {[0, 6, 12, 18].map((h) => (
                      <span key={h}>{String(h).padStart(2, "0")}:00</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="forecast-timeline-body">
            {resources.map((resource) => {
              const config = planning.resources.find(
                  (r) => r.id === resource.id,
                ),
                bars = periods(resource.id);
              const owned = tasks.filter((t) =>
                resource.id === "packing"
                  ? true
                  : resource.id.startsWith("cut-")
                    ? `cut-${t.department}` === resource.id
                    : t.machine === resource.id,
              );
              const fact = processFact(
                owned,
                resource.id === "packing"
                  ? "packing"
                  : resource.id.startsWith("cut-")
                    ? "cut"
                    : "print",
              );
              return (
                <div className="forecast-timeline-row" key={resource.id}>
                  <div className="forecast-timeline-label">
                    <strong>{resource.label}</strong>
                    <small>
                      {config && config.rate > 0
                        ? `${config.rateMode === "auto" ? "Авто · " : ""}${num(config.rate, 2)} ${config.unit === "area" ? "м²" : config.unit === "sheets" ? "лист." : "шт."}/ч`
                        : config
                          ? "Авто · мало данных"
                          : "Не настроен"}
                    </small>
                    {(!config || config.rate <= 0) && onSettings && (
                      <Button onClick={() => onSettings(resource.id)}>
                        Настроить
                      </Button>
                    )}
                  </div>
                  <div className="forecast-timeline-track">
                    {(!config || config.rate <= 0) && (
                      <span className="forecast-unconfigured">
                        Укажите скорость и рабочее время для расчёта
                      </span>
                    )}
                    {config &&
                      config.rate > 0 &&
                      days.map((d) => {
                        const on = config?.days.includes(
                          new Date(d + 10800000).getUTCDay(),
                        );
                        const shade = (
                          from: number,
                          to: number,
                          key: string,
                        ) => (
                          <span
                            key={key}
                            className="forecast-nonworking"
                            style={{
                              left: `${position(d + from * 60000)}%`,
                              width: `${((to - from) / 1440 / range) * 100}%`,
                            }}
                          />
                        );
                        return (
                          <div key={d}>
                            {!on ? (
                              shade(0, 1440, "off")
                            ) : (
                              <>
                                {shade(0, config!.start, "before")}
                                {shade(config!.end, 1440, "after")}
                              </>
                            )}
                          </div>
                        );
                      })}
                    {config && config.rate > 0 && bars.length === 0 && (
                      <div className="forecast-track-status">
                        <strong>
                          {fact.remaining > 0
                            ? `Осталось: ${num(fact.remaining)} шт.`
                            : fact.unknownCount
                              ? "Нужно уточнить объём работы"
                              : "Незавершённых позиций нет"}
                        </strong>
                        <span>
                          {rows.some((r) =>
                            [...r.segments, ...(r.packingSegments || [])].some(
                              (s) => s.resource === resource.id,
                            ),
                          )
                            ? "Расчётная работа находится в другом периоде — нажмите «Показать работу»."
                            : fact.unknownCount
                              ? `Не подтверждено количество по ${fact.unknownCount} позициям.`
                              : fact.remaining > 0
                                ? "Расписание ещё не подтверждено. Фактическое выполнение во вкладке «Процесс»."
                                : ""}
                        </span>
                      </div>
                    )}
                    {bars.map((s) => (
                      <button
                        key={`${s.supplyKey}:${s.start}`}
                        type="button"
                        className={`forecast-gantt-bar ${resource.id === "packing" ? "packing" : resource.id.startsWith("cut-") ? "cut" : "print"} ${(resource.id === "packing" ? s.row.packingStatus : s.row.status) === "late" ? "late" : ""} ${(resource.id === "packing" ? s.row.packingReasons : s.row.reasons)?.length ? "uncertain" : ""}`}
                        style={{
                          left: `${position(Math.max(start, s.start))}%`,
                          width: `${Math.max(0.35, ((Math.min(end, s.end) - Math.max(start, s.start)) / (end - start)) * 100)}%`,
                        }}
                        onClick={() => onSelect(s.row.key)}
                        title={`${(resource.id === "packing" ? s.row.packingReasons : s.row.reasons)?.length ? "Часть расчёта; общий срок не подтверждён · " : ""}${s.row.name} · ${num(s.pieces)} шт. · ${date(s.start)} — ${date(s.end)}`}
                      >
                        <span>{s.row.name}</span>
                        <small>до {time(s.end)}</small>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <div
              className="forecast-timeline-markers"
              aria-label="Сроки готовности и отгрузки"
            >
              {markers.map((m) => (
                <button
                  key={`${m.row.key}:${m.kind}`}
                  type="button"
                  className={`forecast-deadline-marker ${m.kind}`}
                  title={`${m.kind === "shipping" ? "Отгрузка" : m.kind === "packing" ? "Срок упаковки" : "Срок производства"} · ${m.row.name} · ${date(m.at!)}`}
                  style={{ left: `${position(Date.parse(m.at!))}%` }}
                  onClick={() => onSelect(m.row.key)}
                >
                  <span>
                    {m.kind === "shipping"
                      ? "Отгрузка"
                      : m.kind === "packing"
                        ? "Упаковка"
                        : "Производство"}{" "}
                    {time(Date.parse(m.at!))}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="forecast-legend">
        <span>● Печать</span>
        <span>● Порезка</span>
        <span className="supply-calendar-packing-key">● Упаковка</span>
        <span>▧ Нерабочее время</span>
        <span>│ Срок производства</span>
        <span>┆ Отгрузка</span>
        <span>Пунктир · предварительная часть расчёта</span>
      </div>
      {!rows.some((r) => r.finishAt) && (
        <Notice>
          Общий срок ещё не подтверждён. Фактическая печать, порезка и остатки
          показаны во вкладке «Процесс». В «Причины и сроки» доступны конкретные
          ограничения расчёта.
        </Notice>
      )}
    </div>
  );
}

export function ForecastSettings({
  initialId = "2-go",
  history = productionRateHistory(null),
  now = Date.now(),
  planning,
  save,
  refresh,
  loaded,
}: {
  initialId?: string;
  history?: ProductionRateHistory;
  now?: number;
  planning: Planning;
  save: (v: Record<string, unknown>) => Promise<Planning>;
  refresh: () => Promise<void>;
  loaded: boolean;
}) {
  const [id, setId] = useState(initialId),
    [rateMode, setRateMode] = useState<"auto" | "manual">("auto"),
    [rate, setRate] = useState(""),
    [unit, setUnit] = useState<Resource["unit"]>("pieces"),
    [days, setDays] = useState<number[]>([]),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const clock = (n: number) =>
    `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  useEffect(() => {
    const r = planning.resources.find((r) => r.id === id);
    setEnabled(!!r);
    setRateMode(r ? r.rateMode || "manual" : "auto");
    setRate(r && r.rate > 0 ? String(r.rate) : "");
    setUnit(r?.unit || "pieces");
    setDays(r?.days || []);
    setStart(r ? clock(r.start) : "");
    setEnd(r ? clock(r.end) : "");
    setError("");
    setMessage("");
  }, [id]);
  const minutes = (v: string) =>
    /^\d{2}:\d{2}$/.test(v)
      ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3))
      : NaN;
  const estimate = estimateProductionRate(
    history,
    { id, rate: 0, unit, days, start: minutes(start), end: minutes(end) },
    now,
  );
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    try {
      const minutes = (v: string) => {
        if (!/^\d{2}:\d{2}$/.test(v)) return NaN;
        const [h, m] = v.split(":").map(Number);
        return h * 60 + m;
      };
      const resources = validateResources([
        ...planning.resources.filter((r) => r.id !== id),
        ...(enabled
          ? [
              {
                id,
                rate:
                  rateMode === "auto" ? 0 : rate.trim() ? Number(rate) : NaN,
                rateMode,
                unit,
                days,
                start: minutes(start),
                end: minutes(end),
              },
            ]
          : []),
      ]);
      setBusy(true);
      await save({ action: "resources", resources });
      setMessage("Настройки сохранены. Прогноз пересчитан.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить график.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="forecast-settings" onSubmit={submit} noValidate>
      <Field label="Участок">
        <select
          value={id}
          disabled={busy}
          onChange={(e) => setId(e.target.value)}
        >
          {PLANNING_RESOURCES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
              {planning.resources.some((x) => x.id === r.id)
                ? " · настроен"
                : ""}
            </option>
          ))}
        </select>
      </Field>
      <label className="forecast-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => setEnabled(e.target.checked)}
        />{" "}
        Учитывать участок с заданным графиком
      </label>
      <fieldset
        className="forecast-resource-fields"
        disabled={!enabled || busy}
      >
        <Field label="Расчёт скорости">
          <select
            value={rateMode}
            onChange={(e) => {
              const mode = e.target.value as "auto" | "manual";
              setRateMode(mode);
              if (mode === "manual" && !rate.trim() && estimate.rate !== null)
                setRate(String(Number(estimate.rate.toFixed(4))));
            }}
          >
            <option value="auto">Автоматически по журналам</option>
            <option value="manual">Задать вручную</option>
          </select>
        </Field>
        <div className="production-deadlines">
          {rateMode === "manual" ? (
            <Field label="Скорость за рабочий час">
              <input
                aria-label="Скорость за рабочий час"
                type="number"
                min="0.01"
                step="any"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                disabled={busy}
                placeholder="Фактическая рабочая скорость"
              />
            </Field>
          ) : (
            <div
              className={`forecast-rate-card${estimate.rate === null ? " unknown" : ""}`}
              role="status"
            >
              <span>Фактический темп</span>
              <strong>
                {estimate.rate === null
                  ? "Пока не рассчитан"
                  : `${num(estimate.rate, 2)} ${unit === "area" ? "м²" : unit === "sheets" ? "лист." : "шт."}/ч`}
              </strong>
            </div>
          )}
          <Field label="Единица скорости">
            <select
              aria-label="Единица скорости"
              value={unit}
              onChange={(e) => setUnit(e.target.value as Resource["unit"])}
              disabled={busy}
            >
              <option value="pieces">Штук товара в час</option>
              {id !== "packing" && <option value="area">м² в час</option>}
              {id === "xerox" && (
                <option value="sheets">Листов Xerox в час</option>
              )}
            </select>
          </Field>
        </div>
        {rateMode === "auto" && (
          <Notice tone={estimate.rate === null ? "warning" : undefined}>
            {estimate.rate === null
              ? estimate.reason
              : `По ${estimate.days} рабочим дням с выработкой · ${estimate.records} записей. Период: ${estimate.firstDay?.split("-").reverse().join(".")} — ${estimate.lastDay?.split("-").reverse().join(".")}.`}
            {estimate.excludedDays > 0 &&
              ` Исключено дней с неполными данными: ${estimate.excludedDays}.`}
          </Notice>
        )}
        {rateMode === "manual" && estimate.rate !== null && (
          <div className="forecast-auto-reference">
            <span>
              По журналам: {num(estimate.rate, 2)}{" "}
              {unit === "area" ? "м²" : unit === "sheets" ? "лист." : "шт."}/ч ·{" "}
              {estimate.days} рабочих дней
            </span>
            <Button
              onClick={() => setRate(String(Number(estimate.rate!.toFixed(4))))}
            >
              Подставить оценку
            </Button>
          </div>
        )}
        <fieldset disabled={busy}>
          <legend>Рабочие дни</legend>
          <div className="forecast-days">
            {["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"].map((label, d) => (
              <label key={d} className={days.includes(d) ? "active" : ""}>
                <input
                  type="checkbox"
                  checked={days.includes(d)}
                  onChange={(e) =>
                    setDays(
                      e.target.checked
                        ? [...days, d]
                        : days.filter((n) => n !== d),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="production-deadlines">
          <Field label="Начало смены, МСК">
            <input
              aria-label="Начало смены"
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field label="Конец смены, МСК">
            <input
              aria-label="Конец смены"
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              disabled={busy}
            />
          </Field>
        </div>
        <p>
          Автоматический темп — медиана дневной выработки за последние 28 дней,
          делённой на часы заданной смены. Минимум 3 дня с выработкой;
          сегодняшний неполный день исключён. Это темп смены с паузами, а не
          замер времени операции. Ручное значение имеет приоритет. Одно рабочее
          окно в сутки; ночные смены и индивидуальные праздничные исключения
          пока не моделируются. Порог «Под риском» — меньше двух часов запаса.
        </p>
      </fieldset>
      {!enabled && (
        <Notice>
          Включите «Учитывать участок с заданным графиком», затем укажите способ
          расчёта скорости, рабочие дни и часы смены. Пока участок выключен,
          срок его работы не рассчитывается.
        </Notice>
      )}
      {error && (
        <Notice tone="warning">
          {error}
          <Button onClick={() => void refresh()} disabled={busy}>
            Обновить настройки
          </Button>
        </Notice>
      )}
      {message && <Notice>{message}</Notice>}
      <Button
        type="submit"
        kind="primary"
        disabled={
          !loaded ||
          busy ||
          (!enabled && !planning.resources.some((r) => r.id === id))
        }
      >
        {busy ? "Сохраняем…" : "Сохранить участок"}
      </Button>
      <small>Настройки хранятся в RITM и общие для всех сотрудников.</small>
    </form>
  );
}
