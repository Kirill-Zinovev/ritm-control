import { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  CheckCircle,
  Cylinder,
  FileText,
  Package,
  Printer,
  Sliders,
} from "./icons";
import type { LivePrinting } from "./livePrinting";
import { num } from "./model";
import { productionFact, type Fact } from "./productionData";
import { rollPrinted } from "./liveSupplyProgress";
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
} from "./machineWorkloadData";
import { Badge, Button, Empty, Notice, Search } from "./ui";
import "./machineWorkload.css";

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
      title="Фото не передано источником"
    >
      <Package size={21} aria-hidden="true" />
    </span>
  );
}
function ArticleTable({
  rows,
  showSupply,
}: {
  rows: WorkloadArticle[];
  showSupply: boolean;
}) {
  const [page, setPage] = useState(0),
    [size, setSize] = useState(10);
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / size) - 1),
  );
  return (
    <div className="mw-articles">
      <div className="mw-article-table-scroll">
        <table>
          <caption className="sr-only">Артикулы, назначенные на станок</caption>
          <thead>
            <tr>
              <th>Товар / артикул</th>
              {showSupply && <th>Поставка</th>}
              <th>Магазин</th>
              <th>План</th>
              <th>Напечатано</th>
              <th>Порезано</th>
              <th>Осталось печати</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(current * size, (current + 1) * size).map((row) => (
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
                {showSupply && <td>{row.supplyName}</td>}
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
                  {!row.cut.complete && row.cut.known > 0 && (
                    <small className="mw-cell-note">
                      Данные {row.cut.known}/{row.cut.expected}
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
          {num(rows.length)}{" "}
          {countWord(rows.length, "артикул", "артикула", "артикулов")}
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
            {current + 1} / {Math.max(1, Math.ceil(rows.length / size))}
          </span>
          <Button
            disabled={(current + 1) * size >= rows.length}
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

export function MachineWorkload({
  live,
  loading,
  error,
  onRefresh,
  demo = false,
}: {
  live: LivePrinting | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  demo?: boolean;
}) {
  const [view, setView] = useState(() =>
    parameter("view", "supplies") === "machines" ? "machines" : "supplies",
  );
  const [market, setMarket] = useState(() => parameter("market", "all"));
  const [supply, setSupply] = useState(() => parameter("supply", "all"));
  const [department, setDepartment] = useState(() =>
    parameter("department", "all"),
  );
  const [machineId, setMachineId] = useState(() => parameter("machine", "all"));
  const [state, setState] = useState(() => parameter("state", "all"));
  const [search, setSearch] = useState(() => parameter("q", ""));
  const [filtersOpen, setFiltersOpen] = useState(
    () =>
      ["department", "machine", "state"].some(
        (key) => parameter(key, "all") !== "all",
      ) || !!parameter("q", ""),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const all = useMemo(() => buildMachineWorkload(live), [live]);
  useEffect(() => {
    if (live && supply !== "all" && !all.some((item) => item.key === supply))
      setSupply("all");
  }, [all, live, supply]);
  useEffect(() => {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({
      view,
      market,
      supply,
      department,
      machine: machineId,
      state,
      q: search,
    })) {
      if (
        value === "all" ||
        value === "" ||
        (key === "view" && value === "supplies")
      )
        url.searchParams.delete(`mw_${key}`);
      else url.searchParams.set(`mw_${key}`, value);
    }
    history.replaceState(null, "", url);
  }, [view, market, supply, department, machineId, state, search]);
  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("ru-RU");
    return all
      .filter(
        (item) =>
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
              m.rows.length && (state === "all" || workloadState(m) === state),
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
  }, [all, market, supply, department, machineId, state, search]);
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
  const unknown = filtered
    .flatMap((item) => item.machines)
    .filter((m) => m.id === "unknown")
    .reduce((n, m) => n + m.rows.length, 0);
  const selectedFilters =
    market !== "all" ||
    supply !== "all" ||
    department !== "all" ||
    machineId !== "all" ||
    state !== "all" ||
    !!search;
  const clear = () => {
    setMarket("all");
    setSupply("all");
    setDepartment("all");
    setMachineId("all");
    setState("all");
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
        <div
          className="mw-view-switch"
          role="group"
          aria-label="Вид загруженности"
        >
          <button
            type="button"
            aria-pressed={view === "supplies"}
            onClick={() => setView("supplies")}
          >
            По поставкам
          </button>
          <button
            type="button"
            aria-pressed={view === "machines"}
            onClick={() => setView("machines")}
          >
            По станкам
          </button>
        </div>
        <label>
          <span>Маркетплейс</span>
          <select
            aria-label="Маркетплейс загрузки станков"
            value={market}
            onChange={(e) => setMarket(e.target.value)}
          >
            <option value="all">Все маркетплейсы</option>
            <option value="Ozon">Ozon</option>
            <option value="WB">Wildberries</option>
          </select>
        </label>
        <label className="mw-supply-filter">
          <span>Поставка</span>
          <select
            aria-label="Поставка загрузки станков"
            value={supply}
            onChange={(e) => setSupply(e.target.value)}
          >
            <option value="all">Все поставки</option>
            {all.map((item) => (
              <option value={item.key} key={item.key}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          className="mw-filter-toggle"
          onClick={() => setFiltersOpen(!filtersOpen)}
          aria-expanded={filtersOpen}
          aria-controls="mw-extra-filters"
        >
          <Sliders size={18} aria-hidden="true" />
          Фильтры{selectedFilters && <span className="mw-filter-indicator" />}
        </Button>
        <Button onClick={onRefresh} disabled={loading}>
          <ArrowsClockwise
            size={18}
            className={loading ? "spin" : ""}
            aria-hidden="true"
          />
          {loading ? "Обновляем…" : "Обновить"}
        </Button>
      </div>
      {filtersOpen && (
        <div className="mw-filter-row" id="mw-extra-filters">
          <Search
            value={search}
            onChange={setSearch}
            label="Найти артикул, товар или станок…"
          />
          <label className="sr-only" htmlFor="mw-department">
            Участок
          </label>
          <select
            id="mw-department"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
          >
            <option value="all">Все участки</option>
            <option value="roll">Рулонная печать</option>
            <option value="box">Бокс</option>
          </select>
          <label className="sr-only" htmlFor="mw-machine">
            Станок
          </label>
          <select
            id="mw-machine"
            value={machineId}
            onChange={(e) => setMachineId(e.target.value)}
          >
            <option value="all">Все станки</option>
            {MACHINES.map((m) => (
              <option value={m.id} key={m.id}>
                {m.label}
              </option>
            ))}
            <option value="unknown">Станок не определён</option>
          </select>
          <label className="sr-only" htmlFor="mw-state">
            Готовность
          </label>
          <select
            id="mw-state"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="all">Любая готовность</option>
            <option value="pending">Нет отметок печати</option>
            <option value="remaining">Есть остаток печати</option>
            <option value="done">Печать выполнена</option>
            <option value="unknown">Данные неполные</option>
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
          Автообновление 5 мин · {num(filtered.length)}{" "}
          {countWord(filtered.length, "поставка", "поставки", "поставок")} ·{" "}
          {num(filtered.reduce((n, s) => n + s.articleCount, 0))}{" "}
          {countWord(
            filtered.reduce((n, s) => n + s.articleCount, 0),
            "позиция",
            "позиции",
            "позиций",
          )}
        </span>
      </div>
      {(error || live?.stale) && (
        <Notice tone="warning">
          {error ||
            "Показан предыдущий снимок. Источник пока не подтвердил обновление."}
          {live && " Состав и готовность могут быть неактуальны."}
        </Notice>
      )}
      {unknown > 0 && (
        <Notice tone="warning">
          Станок не определён: {num(unknown)}{" "}
          {countWord(unknown, "позиция", "позиции", "позиций")}. Эти товары
          показаны отдельно внутри своего участка.
        </Notice>
      )}
      <div className="mw-layout">
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
            ? filtered.map((item) => (
                <article className="mw-supply" key={item.key}>
                  <header className="mw-supply-header">
                    <span
                      className={`mw-market is-${item.market === "WB" ? "wb" : item.market === "Ozon" ? "ozon" : "neutral"}`}
                      translate="no"
                    >
                      {item.market === "Ozon" ? "OZON" : item.market || "RITM"}
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
                      href={`/?page=supplies&supplySheet=${encodeURIComponent(`${item.sourceId}:${item.sheetId}`)}`}
                    >
                      Открыть поставку{" "}
                      <ArrowSquareOut size={15} aria-hidden="true" />
                    </a>
                    <button
                      className="mw-collapse"
                      type="button"
                      onClick={() =>
                        setCollapsed((old) => {
                          const next = new Set(old);
                          next.has(item.key)
                            ? next.delete(item.key)
                            : next.add(item.key);
                          return next;
                        })
                      }
                      aria-expanded={!collapsed.has(item.key)}
                      aria-label={`${collapsed.has(item.key) ? "Развернуть" : "Свернуть"} ${item.name}`}
                    >
                      {collapsed.has(item.key) ? (
                        <CaretRight size={20} />
                      ) : (
                        <CaretDown size={20} />
                      )}
                    </button>
                  </header>
                  {!collapsed.has(item.key) && (
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
              ))
            : machines.map((m) => (
                <article className="mw-station-panel" key={m.key}>
                  <header>
                    <span className={`mw-lane-icon is-${m.department}`}>
                      <DepartmentIcon department={m.department} />
                    </span>
                    <div>
                      <h2>{m.label}</h2>
                      <p>
                        {departmentName(m.department)} ·{" "}
                        {new Set(m.rows.map((r) => r.supplyKey)).size}{" "}
                        {countWord(
                          new Set(m.rows.map((r) => r.supplyKey)).size,
                          "поставка",
                          "поставки",
                          "поставок",
                        )}
                      </p>
                    </div>
                    <span className={`mw-status is-${workloadState(m)}`}>
                      {workloadStateLabel(m)}
                    </span>
                  </header>
                  <MachineBlock machine={m} showSupply expandedInitially />
                </article>
              ))}
        </div>
        <aside className="mw-machine-overview" aria-label="Сводка по станкам">
          <header>
            <h2>Загрузка станков</h2>
            <p>Незавершённые задания в выборке</p>
          </header>
          {(["roll", "box"] as const).map((d) => (
            <section key={d}>
              <h3>
                <DepartmentIcon department={d} size={21} />
                {departmentName(d)}
              </h3>
              {MACHINES.filter((m) => m.department === d).map((def) => {
                const m = machines.find((item) => item.id === def.id),
                  left = m ? remaining(m) : null;
                return (
                  <button
                    className={`mw-overview-machine${machineId === def.id ? " is-selected" : ""}`}
                    key={def.id}
                    onClick={() => {
                      setMachineId(machineId === def.id ? "all" : def.id);
                      setView("machines");
                    }}
                    type="button"
                    aria-pressed={machineId === def.id}
                  >
                    <span
                      className={`mw-state-dot${m ? (left === null ? " is-unknown" : left <= 0 ? " is-done" : " is-remaining") : ""}`}
                    />
                    <span>
                      <strong>{def.label}</strong>
                      <small>
                        {!live
                          ? "Данные не загружены"
                          : !m
                            ? "Нет заданий в выборке"
                            : left === null
                              ? "Остаток не подтверждён"
                              : left <= 0
                                ? "Печать выполнена"
                                : `Осталось ${num(left)} шт.`}
                      </small>
                      {m && (
                        <span className="mw-overview-supplies">
                          {[
                            ...new Set(m.rows.map((row) => row.supplyName)),
                          ].join(", ")}
                        </span>
                      )}
                    </span>
                    <CaretRight size={17} aria-hidden="true" />
                  </button>
                );
              })}
            </section>
          ))}
          <p className="mw-overview-note">
            <FileText size={16} aria-hidden="true" />
            Поставки и станки берутся из рабочих листов. Здесь показана
            готовность печати.
          </p>
        </aside>
      </div>
    </div>
  );
}
