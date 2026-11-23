import { lazy, Suspense, useEffect, useId, useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  CheckCircle,
  Cylinder,
  Package,
  Printer,
  Sliders,
} from "./icons";
import type { LivePrinting } from "./livePrinting";
import type { ForecastRow } from "./productionForecastModel";
import { num } from "./model";
import { productionFact, type Fact } from "./productionData";
import { rollCut, rollPrinted } from "./liveSupplyProgress";
import {
  MACHINES,
  buildMachineWorkload,
  countWord,
  remaining,
  summarizeMachines,
  workloadState,
  workloadStateLabel,
  type Department,
  type WorkloadArticle,
  type WorkloadMachine,
  type WorkloadSupply,
} from "./machineWorkloadData";
import { Badge, Button, Empty, Notice, Search } from "./ui";
import "./machineWorkload.css";

const ProductionForecast = lazy(() =>
  import("./ProductionForecast").then((module) => ({
    default: module.ProductionForecast,
  })),
);

const departmentName = (department: Department) =>
  department === "roll" ? "Рулонная печать" : "Бокс";
function DepartmentIcon({
  department,
  size = 24,
}: {
  department: Department;
  size?: number;
}) {
  const Icon = department === "roll" ? Cylinder : Package;
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />;
}
function Meter({
  metric,
  plan,
  label = "Напечатано",
}: {
  metric: Fact;
  plan: number;
  label?: string;
}) {
  const percent =
    metric.value !== null && plan > 0 ? (metric.value / plan) * 100 : null;
  const over = percent !== null && percent > 100;
  return (
    <span
      className={`mw-meter${over ? " is-over" : ""}${!metric.complete ? " is-partial" : ""}`}
    >
      <span className="mw-meter-line">
        <strong>
          {percent !== null && metric.complete
            ? `${num(Math.round(percent))}%`
            : "—"}
        </strong>
        <span
          className="mw-meter-track"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={Math.max(plan, metric.value || 0)}
          aria-valuenow={metric.value ?? undefined}
          aria-valuetext={
            metric.value === null
              ? "Нет данных"
              : `${num(metric.value)} из ${num(plan)}${!metric.complete ? ", данные неполные" : ""}`
          }
        >
          <i
            style={{ width: `${Math.min(100, Math.max(0, percent || 0))}%` }}
          />
        </span>
      </span>
      {!metric.complete && (
        <small>
          {metric.known
            ? `Данные ${metric.known}/${metric.expected}`
            : "Нет данных"}
        </small>
      )}
      {over && <small>+{num(metric.value! - plan)} сверх плана</small>}
    </span>
  );
}
function Photo({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? (
    <img
      className="mw-photo"
      src={src}
      alt=""
      width={48}
      height={48}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      className="mw-photo mw-photo-empty"
      title={
        src
          ? "Не удалось загрузить фото из источника"
          : "Фото не найдено по артикулу в базе"
      }
    >
      <Package size={21} aria-hidden="true" />
    </span>
  );
}
function ArticleTable({
  rows,
  showSupply,
  onlyUnconfirmed = false,
}: {
  rows: WorkloadArticle[];
  showSupply: boolean;
  onlyUnconfirmed?: boolean;
}) {
  const [page, setPage] = useState(0),
    [size, setSize] = useState(10),
    [missingOnly, setMissingOnly] = useState(false);
  const missing = rows.filter(
      (row) => !row.printed.complete || !row.cut.complete,
    ),
    visible = missingOnly ? missing : rows;
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(visible.length / size) - 1),
  );
  return (
    <div className="mw-articles">
      {!onlyUnconfirmed && (missing.length > 0 || missingOnly) && (
        <div className="mw-article-filter">
          <Button
            onClick={() => {
              setMissingOnly(!missingOnly);
              setPage(0);
            }}
            aria-pressed={missingOnly}
          >
            {missingOnly
              ? "Показать все артикулы"
              : `С неполными отметками · ${num(missing.length)}`}
          </Button>
          {!missingOnly && (
            <small>Проверьте отметки печати и порезки по этим артикулам.</small>
          )}
        </div>
      )}
      <div className="mw-article-table-scroll">
        <table>
          <caption className="sr-only">Артикулы, назначенные на станок</caption>
          <thead>
            <tr>
              <th>Товар / артикул</th>
              {showSupply && <th>Задание</th>}
              <th>Магазин</th>
              <th>План</th>
              <th>Напечатано</th>
              <th>Порезано</th>
              <th>Осталось печати</th>
            </tr>
          </thead>
          <tbody>
            {visible.slice(current * size, (current + 1) * size).map((row) => (
              <tr key={row.key}>
                <td>
                  <div className="mw-product">
                    <Photo src={row.photoUrl} />
                    <div>
                      <strong translate="no">{row.article}</strong>
                      <span>
                        {row.productName || "Название не передано источником"}
                      </span>
                      {row.issue && (
                        <small className="mw-issue">{row.issue}</small>
                      )}
                    </div>
                  </div>
                </td>
                {showSupply && (
                  <td>
                    {row.supplyName}
                    {onlyUnconfirmed &&
                      row.orders
                        .filter(
                          (order) =>
                            rollPrinted(order) === null ||
                            rollCut(order) === null,
                        )
                        .map((order) => {
                          const phases = [
                            rollPrinted(order) === null ? "печать" : "",
                            rollCut(order) === null ? "порезка" : "",
                          ].filter(Boolean);
                          return (
                            <small
                              className="mw-cell-note"
                              key={order.uid + ":" + order.row}
                            >
                              {order.sourceUrl ? (
                                <a
                                  href={
                                    order.sourceUrl + "&range=E" + order.row
                                  }
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Строка {order.row}
                                </a>
                              ) : (
                                `Строка ${order.row}`
                              )}
                              {" · "}
                              {phases.join(" и ")}
                            </small>
                          );
                        })}
                  </td>
                )}
                <td>
                  <span className="mw-store">{row.store}</span>
                </td>
                <td>{num(row.plan)}</td>
                <td>
                  <strong>
                    {row.printed.value === null ? "—" : num(row.printed.value)}
                  </strong>
                  <Meter metric={row.printed} plan={row.plan} />
                </td>
                <td>
                  {row.cut.value === null ? "—" : num(row.cut.value)}
                  {!row.cut.complete && (
                    <small className="mw-cell-note">
                      {row.cut.known
                        ? `Данные ${row.cut.known}/${row.cut.expected}`
                        : "Нет отметки порезки"}
                    </small>
                  )}
                </td>
                <td>
                  {remaining(row) === null ? (
                    "—"
                  ) : remaining(row)! < 0 ? (
                    <span className="mw-over">
                      +{num(-remaining(row)!)} сверх плана
                    </span>
                  ) : (
                    num(remaining(row)!)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mw-pagination">
        <span>
          {num(visible.length)}{" "}
          {countWord(visible.length, "артикул", "артикула", "артикулов")}
        </span>
        <div>
          <label>
            Строк{" "}
            <select
              aria-label="Артикулов на странице"
              value={size}
              onChange={(e) => {
                setSize(Number(e.target.value));
                setPage(0);
              }}
            >
              {[10, 20, 50].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <Button
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
            aria-label="Предыдущая страница"
          >
            <ArrowLeft size={14} />
          </Button>
          <span>
            {current + 1} / {Math.max(1, Math.ceil(visible.length / size))}
          </span>
          <Button
            disabled={(current + 1) * size >= visible.length}
            onClick={() => setPage(current + 1)}
            aria-label="Следующая страница"
          >
            <ArrowRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}
function MachineBlock({
  machine,
  showSupply = false,
  expandedInitially = false,
}: {
  machine: WorkloadMachine;
  showSupply?: boolean;
  expandedInitially?: boolean;
}) {
  const [expanded, setExpanded] = useState(expandedInitially);
  const id = useId();
  const left = remaining(machine);
  return (
    <div
      className={`mw-machine-block${machine.id === "unknown" ? " is-unknown" : ""}`}
    >
      <button
        className="mw-machine-row"
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={id}
      >
        <span className="mw-machine-name">
          {expanded ? <CaretDown size={16} /> : <CaretRight size={16} />}
          <span>
            <strong>{machine.label}</strong>
            <small>
              {num(machine.rows.length)}{" "}
              {countWord(
                machine.rows.length,
                "артикул",
                "артикула",
                "артикулов",
              )}
            </small>
          </span>
        </span>
        <span className="mw-row-plan">
          {num(machine.plan)}
          <small>план, шт.</small>
        </span>
        <span className="mw-row-done">
          {machine.printed.value === null ? "—" : num(machine.printed.value)}
          <small>напечатано</small>
        </span>
        <Meter metric={machine.printed} plan={machine.plan} />
      </button>
      {expanded && (
        <div id={id} className="mw-machine-detail">
          <div className="mw-detail-status">
            <span>{workloadStateLabel(machine)}</span>
            <span>
              {left === null
                ? "Остаток не подтверждён"
                : left < 0
                  ? `+${num(-left)} сверх плана`
                  : `Осталось напечатать: ${num(left)} шт.`}
            </span>
          </div>
          <ArticleTable rows={machine.rows} showSupply={showSupply} />
        </div>
      )}
    </div>
  );
}
function DepartmentLane({
  department,
  machines,
}: {
  department: Department;
  machines: WorkloadMachine[];
}) {
  return (
    <section
      className={`mw-lane is-${department}`}
      aria-label={departmentName(department)}
    >
      <header>
        <span className="mw-lane-icon">
          <DepartmentIcon department={department} />
        </span>
        <h3>{departmentName(department)}</h3>
        <span>
          {machines.length}{" "}
          {countWord(machines.length, "станок", "станка", "станков")}
        </span>
      </header>
      {machines.length ? (
        machines.map((machine) => (
          <MachineBlock key={machine.key} machine={machine} />
        ))
      ) : (
        <p className="mw-lane-empty">
          В этом участке нет заданий по выбранным фильтрам.
        </p>
      )}
    </section>
  );
}
const parameter = (name: string, fallback: string) =>
  new URLSearchParams(location.search).get(`mw_${name}`) || fallback;

type MachineWorkloadProps = {
  live: LivePrinting | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  demo?: boolean;
};

export function MachineWorkload(props: MachineWorkloadProps) {
  const [tab, setTab] = useState(() =>
    parameter("tab", "current") === "forecast" ? "forecast" : "current",
  );
  useEffect(() => {
    const url = new URL(location.href);
    if (tab === "forecast") url.searchParams.set("mw_tab", tab);
    else url.searchParams.delete("mw_tab");
    history.replaceState(null, "", url);
  }, [tab]);
  const calendar = tab === "forecast";
  const [forecasts, setForecasts] = useState<ForecastRow[]>([]);
  const forecastBySupply = useMemo(
    () => new Map(forecasts.map((row) => [row.key, row])),
    [forecasts],
  );
  return (
    <>
      <div
        className="mw-primary-tabs"
        role="group"
        aria-label="Загрузка и календарь"
      >
        <Button
          kind={calendar ? "secondary" : "primary"}
          aria-pressed={!calendar}
          onClick={() => setTab("current")}
        >
          Загрузка
        </Button>
        <Button
          kind={calendar ? "primary" : "secondary"}
          aria-pressed={calendar}
          onClick={() => setTab("forecast")}
        >
          <CalendarDays size={17} /> Календарь
        </Button>
      </div>
      <div className={calendar ? "mw-page-grid is-calendar" : "mw-page-grid"}>
        <div hidden={calendar}>
          <CurrentMachineWorkload
            {...props}
            forecastBySupply={forecastBySupply}
          />
        </div>
        <Suspense fallback={<Notice>Открываем календарь…</Notice>}>
          <ProductionForecast
            live={props.live}
            loading={props.loading}
            onRefresh={props.onRefresh}
            compact={!calendar}
            onForecastChange={setForecasts}
            onOpenCalendar={() => setTab("forecast")}
          />
        </Suspense>
      </div>
    </>
  );
}

function workloadFinished(machine: WorkloadMachine) {
  return machine.rows.every((row) =>
    row.orders.every(
      (order) =>
        (rollPrinted(order) ?? -1) >= order.quantity &&
        (rollCut(order) ?? -1) >= order.quantity,
    ),
  );
}

function StationFact({
  metric,
  plan,
  label,
}: {
  metric: Fact;
  plan: number;
  label: string;
}) {
  return (
    <div className="mw-station-fact">
      <span>
        <strong>
          {metric.value === null
            ? "—"
            : `${metric.complete ? "" : "≥ "}${num(metric.value)}`}
        </strong>{" "}
        / {num(plan)}
      </span>
      <Meter metric={metric} plan={plan} label={label} />
    </div>
  );
}

const stationDeadline = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const stationTiming = {
  done: { label: "Готово", tone: "success" },
  "on-time": { label: "К сроку", tone: "success" },
  risk: { label: "Под риском", tone: "warning" },
  late: { label: "Позже срока", tone: "danger" },
  unknown: { label: "Нужны данные", tone: "warning" },
  "no-deadline": { label: "Срок не задан", tone: "neutral" },
} as const;

function StationOverview({
  machines,
  supplies,
  selected,
  forecastBySupply,
  onSelect,
}: {
  machines: WorkloadMachine[];
  supplies: WorkloadSupply[];
  selected: WorkloadMachine;
  forecastBySupply: ReadonlyMap<string, ForecastRow>;
  onSelect: (key: string) => void;
}) {
  const detailId = useId();
  const [openSupply, setOpenSupply] = useState<string | null>(null);
  const matches = supplies.flatMap((supply) => {
    const machine = supply.machines.find(
      (item) =>
        item.id === selected.id && item.department === selected.department,
    );
    return machine ? [{ supply, machine }] : [];
  });
  const unconfirmed = selected.rows.filter(
    (row) => !row.printed.complete || !row.cut.complete,
  );
  return (
    <>
      <section className="card mw-station-overview">
        <h2>По станкам</h2>
        <table className="mw-station-table">
          <thead>
            <tr>
              <th>Станок</th>
              <th>Напечатано, шт.</th>
              <th>Порезано, шт.</th>
              <th>Осталось печатать, шт.</th>
            </tr>
          </thead>
          <tbody>
            {machines.map((machine) => {
              const left = machine.printed.complete
                ? machine.rows.reduce(
                    (sum, row) =>
                      sum +
                      row.orders.reduce(
                        (total, order) =>
                          total +
                          Math.max(
                            0,
                            order.quantity - (rollPrinted(order) ?? 0),
                          ),
                        0,
                      ),
                    0,
                  )
                : null;
              return (
                <tr
                  className={machine.key === selected.key ? "is-selected" : ""}
                  key={machine.key}
                  onClick={() => onSelect(machine.key)}
                >
                  <th scope="row">
                    <button
                      type="button"
                      aria-pressed={machine.key === selected.key}
                      aria-controls={detailId}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(machine.key);
                      }}
                    >
                      <strong>{machine.label}</strong>
                      <small>{departmentName(machine.department)}</small>
                    </button>
                  </th>
                  <td>
                    <StationFact
                      metric={machine.printed}
                      plan={machine.plan}
                      label={`Напечатано · ${machine.label}`}
                    />
                  </td>
                  <td>
                    <StationFact
                      metric={machine.cut}
                      plan={machine.plan}
                      label={`Порезано · ${machine.label}`}
                    />
                  </td>
                  <td className="mw-station-left">
                    {left === null ? (
                      <small>Нет точных данных</small>
                    ) : (
                      <strong>{num(left)}</strong>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section className="card mw-station-supplies" id={detailId}>
        <header>
          <h2>Задания на {selected.label}</h2>
          <small>
            {num(matches.length)}{" "}
            {countWord(matches.length, "задание", "задания", "заданий")}
          </small>
        </header>
        {unconfirmed.length > 0 && (
          <details className="mw-missing-data">
            <summary>
              Что проверить · {num(unconfirmed.length)}{" "}
              {countWord(unconfirmed.length, "позиция", "позиции", "позиций")}
            </summary>
            <p>
              Источник не подтвердил количество по этим строкам. Знак ≥
              показывает подтверждённый минимум.
            </p>
            <ArticleTable
              key={selected.key}
              rows={unconfirmed}
              showSupply
              onlyUnconfirmed
            />
          </details>
        )}
        <div className="mw-station-supply-columns">
          <span>Поставка или запасы</span>
          <span>К сроку</span>
        </div>
        {matches.map(({ supply, machine }) => {
          const open = openSupply === supply.key;
          const forecast = forecastBySupply.get(supply.key);
          const status = forecast ? stationTiming[forecast.status] : null;
          const due = forecast?.readyAt ? Date.parse(forecast.readyAt) : NaN;
          const timing =
            status ||
            (workloadFinished(machine)
              ? stationTiming.done
              : { label: "Прогноз в загрузке", tone: "neutral" });
          return (
            <div key={supply.key} className="mw-station-supply">
              <button
                type="button"
                className="mw-station-supply-trigger"
                aria-expanded={open}
                onClick={() => setOpenSupply(open ? null : supply.key)}
              >
                <span>
                  <strong>{supply.name}</strong>
                  <small>
                    {num(machine.plan)} шт. · {num(machine.rows.length)} поз.
                  </small>
                </span>
                <span>
                  <Badge tone={timing.tone}>{timing.label}</Badge>
                  {Number.isFinite(due) && (
                    <small>до {stationDeadline.format(due)}</small>
                  )}
                </span>
                {open ? <CaretDown size={17} /> : <CaretRight size={17} />}
              </button>
              {open && (
                <div className="mw-station-supply-detail">
                  <a
                    className="mw-open-supply"
                    href={
                      supply.stock
                        ? "/?page=reserves"
                        : `/?page=supplies&supplySheet=${encodeURIComponent(`${supply.sourceId}:${supply.sheetId}`)}`
                    }
                  >
                    {supply.stock ? "Открыть запасы" : "Открыть поставку"}{" "}
                    <ArrowSquareOut size={15} aria-hidden="true" />
                  </a>
                  <ArticleTable rows={machine.rows} showSupply={false} />
                </div>
              )}
            </div>
          );
        })}
      </section>
    </>
  );
}

function CurrentMachineWorkload({
  live,
  loading,
  error,
  onRefresh,
  demo = false,
  forecastBySupply,
}: {
  live: LivePrinting | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  demo?: boolean;
  forecastBySupply: ReadonlyMap<string, ForecastRow>;
}) {
  const [view, setView] = useState(() =>
    parameter("view", "machines") === "supplies" ? "supplies" : "machines",
  );
  const [scope, setScope] = useState(() => parameter("scope", "all"));
  const [market, setMarket] = useState(() => parameter("market", "all"));
  const [supply, setSupply] = useState(() => parameter("supply", "all"));
  const [department, setDepartment] = useState(() =>
    parameter("department", "all"),
  );
  const [machineId, setMachineId] = useState(() => parameter("machine", "all"));
  const [state, setState] = useState(() => parameter("state", "active"));
  const [selectedStation, setSelectedStation] = useState("");
  const [search, setSearch] = useState(() => parameter("q", ""));
  const [filtersOpen, setFiltersOpen] = useState(() =>
    ["scope", "market", "supply", "machine"].some(
      (key) => parameter(key, "all") !== "all",
    ),
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const all = useMemo(
    () => buildMachineWorkload(live, { includeStock: true }),
    [live],
  );
  useEffect(() => {
    if (live && supply !== "all" && !all.some((item) => item.key === supply))
      setSupply("all");
  }, [all, live, supply]);
  useEffect(() => {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({
      view,
      scope,
      market,
      supply,
      department,
      machine: machineId,
      state,
      q: search,
    })) {
      if (
        value === "" ||
        (key === "view"
          ? value === "machines"
          : key === "state"
            ? value === "active"
            : value === "all")
      )
        url.searchParams.delete(`mw_${key}`);
      else url.searchParams.set(`mw_${key}`, value);
    }
    history.replaceState(null, "", url);
  }, [view, scope, market, supply, department, machineId, state, search]);
  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("ru-RU");
    return all
      .filter(
        (item) =>
          (scope === "all" || (scope === "stock" ? item.stock : !item.stock)) &&
          (market === "all" || item.market === market) &&
          (supply === "all" || item.key === supply),
      )
      .map((item) => {
        const machines = item.machines
          .filter(
            (m) =>
              (department === "all" || department === m.department) &&
              (machineId === "all" || machineId === m.id),
          )
          .map((m) => {
            const rows = m.rows.filter(
              (row) =>
                !q ||
                `${item.name} ${row.article} ${row.productName} ${m.label} ${row.store}`
                  .toLocaleLowerCase("ru-RU")
                  .includes(q),
            );
            return {
              ...summarizeMachines(rows, m.id, m.label, m.department),
              key: m.key,
            };
          })
          .filter(
            (m) =>
              m.rows.length &&
              (state === "all" ||
                (state === "active"
                  ? !workloadFinished(m)
                  : state === "unknown"
                    ? !m.printed.complete || !m.cut.complete
                    : workloadState(m) === state)),
          );
        const rows = machines.flatMap((m) => m.rows),
          orders = rows.flatMap((row) => row.orders);
        return {
          ...item,
          machines,
          plan: orders.reduce((sum, order) => sum + order.quantity, 0),
          printed: productionFact(orders.map(rollPrinted)),
          articleCount: rows.length,
        };
      })
      .filter((item) => item.machines.length);
  }, [all, scope, market, supply, department, machineId, state, search]);
  const machines = useMemo(() => {
    const groups = new Map<string, WorkloadMachine[]>();
    for (const m of filtered.flatMap((item) => item.machines))
      groups.set(`${m.department}:${m.id}`, [
        ...(groups.get(`${m.department}:${m.id}`) || []),
        m,
      ]);
    return [...groups.values()].map((items) =>
      summarizeMachines(
        items.flatMap((item) => item.rows),
        items[0].id,
        items[0].label,
        items[0].department,
      ),
    );
  }, [filtered]);
  const selectedMachine =
    machines.find((machine) => machine.key === selectedStation) || machines[0];
  const unknown = filtered
    .flatMap((item) => item.machines)
    .filter((m) => m.id === "unknown")
    .reduce((n, m) => n + m.rows.length, 0);
  const stockCount = filtered.filter((item) => item.stock).length;
  const supplyCount = filtered.length - stockCount;
  const positionCount = filtered.reduce(
    (total, item) => total + item.articleCount,
    0,
  );
  const unavailableStock =
    live && scope !== "supplies" && market === "all"
      ? ([
          [live.stockRoll, "рулонная печать"],
          [live.stockBox, "бокс"],
        ] as const)
      : [];
  const missingStock = unavailableStock
    .filter(([source]) => source?.status !== "available")
    .map(([, label]) => label);
  const selectedFilters =
    scope !== "all" ||
    market !== "all" ||
    supply !== "all" ||
    department !== "all" ||
    machineId !== "all" ||
    state !== "active" ||
    !!search;
  const clear = () => {
    setScope("all");
    setMarket("all");
    setSupply("all");
    setDepartment("all");
    setMachineId("all");
    setState("active");
    setSearch("");
  };
  const updated =
    live?.updatedAt && Number.isFinite(Date.parse(live.updatedAt))
      ? new Intl.DateTimeFormat("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Moscow",
        }).format(new Date(live.updatedAt))
      : null;
  return (
    <div className="mw-dashboard">
      {demo && (
        <div className="mw-demo-label">
          <Badge tone="warning">
            Демо-просмотр · поставки и числа синтетические
          </Badge>
        </div>
      )}
      <div className="mw-toolbar">
        <select
          aria-label="Участок"
          value={department}
          onChange={(event) => setDepartment(event.target.value)}
        >
          <option value="all">Все участки</option>
          <option value="roll">Рулонная печать</option>
          <option value="box">Бокс</option>
        </select>
        <select
          aria-label="Готовность"
          value={state}
          onChange={(event) => setState(event.target.value)}
        >
          <option value="active">Только незавершённые</option>
          <option value="all">Все задания</option>
          <option value="pending">Нет отметок печати</option>
          <option value="remaining">Есть остаток печати</option>
          <option value="done">Печать выполнена</option>
          <option value="unknown">Данные неполные</option>
        </select>
        <Search
          value={search}
          onChange={setSearch}
          label="Найти поставку или артикул"
        />
        <Button
          className="mw-filter-toggle"
          title="Фильтры"
          aria-label="Фильтры"
          onClick={() => setFiltersOpen(!filtersOpen)}
          aria-expanded={filtersOpen}
          aria-controls="mw-extra-filters"
        >
          <Sliders size={18} aria-hidden="true" />
          {selectedFilters && <span className="mw-filter-indicator" />}
        </Button>
        <Button
          onClick={onRefresh}
          disabled={loading}
          aria-label="Обновить загрузку"
          title="Обновить загрузку"
        >
          <ArrowsClockwise
            size={18}
            className={loading ? "spin" : ""}
            aria-hidden="true"
          />
        </Button>
      </div>
      {filtersOpen && (
        <div className="mw-filter-row" id="mw-extra-filters">
          <div
            className="mw-view-switch"
            role="group"
            aria-label="Вид загруженности"
          >
            <button
              type="button"
              aria-pressed={view === "machines"}
              onClick={() => setView("machines")}
            >
              По станкам
            </button>
            <button
              type="button"
              aria-pressed={view === "supplies"}
              onClick={() => setView("supplies")}
            >
              По поставкам
            </button>
          </div>
          <select
            aria-label="Тип заданий"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value);
              setSupply("all");
              if (event.target.value === "stock") setMarket("all");
            }}
          >
            <option value="all">Поставки и запасы</option>
            <option value="supplies">Только поставки</option>
            <option value="stock">Только запасы</option>
          </select>
          <select
            aria-label="Маркетплейс загрузки станков"
            value={market}
            onChange={(event) => setMarket(event.target.value)}
          >
            <option value="all">Все маркетплейсы</option>
            <option value="Ozon">Ozon</option>
            <option value="WB">Wildberries</option>
          </select>
          <select
            aria-label="Задание загрузки станков"
            value={supply}
            onChange={(event) => setSupply(event.target.value)}
          >
            <option value="all">Все поставки и запасы</option>
            {all
              .filter(
                (item) =>
                  scope === "all" ||
                  (scope === "stock" ? item.stock : !item.stock),
              )
              .map((item) => (
                <option value={item.key} key={item.key}>
                  {item.name}
                </option>
              ))}
          </select>
          <select
            aria-label="Станок"
            value={machineId}
            onChange={(event) => setMachineId(event.target.value)}
          >
            <option value="all">Все станки</option>
            {MACHINES.map((machine) => (
              <option value={machine.id} key={machine.id}>
                {machine.label}
              </option>
            ))}
            <option value="unknown">Станок не определён</option>
          </select>
          {selectedFilters && (
            <Button kind="ghost" onClick={clear}>
              Сбросить
            </Button>
          )}
        </div>
      )}
      <div className="mw-sync-line" aria-live="polite">
        <span>
          <i className={live && !live.stale && !error ? "is-fresh" : ""} />
          {loading
            ? "Обновляем поставки…"
            : updated
              ? `Обновлено ${updated} МСК`
              : "Рабочие данные не загружены"}
        </span>
        <span>
          {num(supplyCount)}{" "}
          {countWord(supplyCount, "поставка", "поставки", "поставок")} ·{" "}
          {num(stockCount)} {countWord(stockCount, "лист", "листа", "листов")}{" "}
          запасов · {num(positionCount)} поз.
        </span>
      </div>
      {(error || live?.stale) && (
        <Notice tone="warning">
          {error ||
            "Показан предыдущий снимок. Источник пока не подтвердил обновление."}
          {live && " Состав и готовность могут быть неактуальны."}
        </Notice>
      )}
      {missingStock.length > 0 && !demo && (
        <Notice tone="warning">
          Загрузка запасов подтверждена частично. Нет данных участка:{" "}
          {missingStock.join(", ")}.
        </Notice>
      )}
      {unknown > 0 && (
        <Notice tone="warning">
          Станок не определён: {num(unknown)}{" "}
          {countWord(unknown, "позиция", "позиции", "позиций")}. Эти товары
          показаны отдельно внутри своего участка.
        </Notice>
      )}
      <div className="mw-main-list">
        {!filtered.length && (
          <section className="mw-empty-panel">
            <Empty
              title={
                loading && !live
                  ? "Загружаем поставки…"
                  : live
                    ? "По этим фильтрам нет заданий"
                    : "Поставки пока не загружены"
              }
            >
              {loading && !live
                ? "Читаем состав поставок, станки и готовность печати."
                : live
                  ? "Измените фильтры или поиск. Новые поставки появятся после обновления."
                  : "Нажмите «Обновить», чтобы прочитать поставки и распределение по станкам."}
            </Empty>
            {selectedFilters && (
              <Button onClick={clear}>Сбросить фильтры</Button>
            )}
          </section>
        )}
        {view === "supplies"
          ? filtered.map((item) => {
              const isExpanded = expanded.has(item.key);
              return (
                <article className="mw-supply" key={item.key}>
                  <header className="mw-supply-header">
                    <span
                      className={`mw-market is-${item.market === "WB" ? "wb" : item.market === "Ozon" ? "ozon" : "neutral"}`}
                      translate="no"
                    >
                      {item.stock
                        ? "Запасы"
                        : item.market === "Ozon"
                          ? "OZON"
                          : item.market || "RITM"}
                    </span>
                    <div className="mw-supply-title">
                      <h2>{item.name}</h2>
                      <p>
                        {num(item.articleCount)}{" "}
                        {countWord(
                          item.articleCount,
                          "позиция",
                          "позиции",
                          "позиций",
                        )}{" "}
                        / {num(item.plan)} шт.
                      </p>
                    </div>
                    <span className={`mw-status is-${workloadState(item)}`}>
                      {workloadState(item) === "done" && (
                        <CheckCircle size={14} aria-hidden="true" />
                      )}
                      {workloadState(item) === "done"
                        ? "Печать выполнена"
                        : workloadState(item) === "unknown"
                          ? "Неполные данные"
                          : "Печать не завершена"}
                    </span>
                    <a
                      className="mw-open-supply"
                      href={
                        item.stock
                          ? "/?page=reserves"
                          : `/?page=supplies&supplySheet=${encodeURIComponent(`${item.sourceId}:${item.sheetId}`)}`
                      }
                    >
                      {item.stock ? "Открыть запасы" : "Открыть поставку"}{" "}
                      <ArrowSquareOut size={15} aria-hidden="true" />
                    </a>
                    <button
                      className="mw-collapse"
                      type="button"
                      onClick={() =>
                        setExpanded((old) => {
                          const next = new Set(old);
                          next.has(item.key)
                            ? next.delete(item.key)
                            : next.add(item.key);
                          return next;
                        })
                      }
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? "Свернуть" : "Развернуть"} ${item.name}`}
                    >
                      {isExpanded ? (
                        <CaretDown size={20} />
                      ) : (
                        <CaretRight size={20} />
                      )}
                    </button>
                  </header>
                  {isExpanded && (
                    <>
                      <div className="mw-lanes">
                        {(["roll", "box"] as const)
                          .filter((d) =>
                            item.machines.some((m) => m.department === d),
                          )
                          .map((d) => (
                            <DepartmentLane
                              key={d}
                              department={d}
                              machines={item.machines.filter(
                                (m) => m.department === d,
                              )}
                            />
                          ))}
                      </div>
                      <footer className="mw-supply-total">
                        <span>
                          <Printer size={18} aria-hidden="true" />
                          Напечатано по поставке
                        </span>
                        <strong>
                          {item.printed.value === null
                            ? "—"
                            : num(item.printed.value)}{" "}
                          <small>/ {num(item.plan)} шт.</small>
                        </strong>
                        <Meter metric={item.printed} plan={item.plan} />
                      </footer>
                    </>
                  )}
                </article>
              );
            })
          : selectedMachine && (
              <StationOverview
                key={selectedMachine.key}
                machines={machines}
                supplies={filtered}
                selected={selectedMachine}
                forecastBySupply={forecastBySupply}
                onSelect={setSelectedStation}
              />
            )}
      </div>
    </div>
  );
}
