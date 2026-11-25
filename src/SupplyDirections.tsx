import { useMemo, useState } from "react";
import "./supplyDirections.css";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LockKeyhole,
  Package,
  Printer,
  Scissors,
  Search,
  Settings2,
} from "lucide-react";
import { Button, Empty } from "./ui";
import { num } from "./model";
import { formatPrintQuantity } from "./liveSupplyProgress";
import {
  buildSupplyDirections,
  directionProgress,
  directionJobReady,
  orderStore,
  type DirectionJob,
  type DirectionProgressField,
} from "./supplyDirectionData";
import type { LiveOrder } from "./livePrinting";
type Props = {
  jobs: DirectionJob[];
  selectedJobId: string;
  onOpenJob: (id: string) => void;
  onShowJobs: () => void;
};
const directionStages = [
  { field: "printed", label: "Печать", Icon: Printer },
  { field: "assemblyMachineCut", label: "Резка на станке", Icon: Scissors },
  { field: "assemblyManualCut", label: "Ручная резка", Icon: Scissors },
  { field: "packed", label: "Упаковка", Icon: Package },
] as const;
function Market({ name }: { name: string | null }) {
  return (
    <span className={`direction-market ${name === "WB" ? "wb" : ""}`}>
      {name === "Ozon" ? "ozon" : name || "R"}
    </span>
  );
}
function Progress({
  orders,
  field,
  missing = false,
}: {
  orders: LiveOrder[];
  field: DirectionProgressField;
  missing?: boolean;
}) {
  const p = directionProgress(orders, field);
  const stage = directionStages.find((item) => item.field === field);
  const shownDone = field === "printed" ? formatPrintQuantity(p.done) : num(p.done);
  return (
    <div
      className={`direction-progress ${field}`}
      title={field === "printed" ? "Годные листы Xerox пересчитаны в штуки по данным позиции." : undefined}
    >
      <small className="direction-progress-label">{stage?.label}</small>
      <span>
        <strong>
          {p.known || p.done > 0
            ? `${p.complete && !missing ? "" : "≥ "}${shownDone}`
            : "—"}
        </strong>{" "}
        / {num(p.plan)} шт.
        <b>
          {p.percent !== null && !missing
            ? `${p.percent}%`
            : (field === "printed" || field === "packed") && p.lowerPercent !== null && !missing
              ? `≥ ${p.lowerPercent}%`
              : "Нет полных данных"}
        </b>
      </span>
      <div className="direction-progress-track">
        <i
          style={{
            width: `${p.plan ? Math.min(100, (p.done / p.plan) * 100) : 0}%`,
          }}
        />
      </div>
    </div>
  );
}
export function SupplyDirections({
  jobs,
  selectedJobId,
  onOpenJob,
  onShowJobs,
}: Props) {
  const groups = useMemo(() => buildSupplyDirections(jobs), [jobs]);
  const [directionId, setDirectionId] = useState("");
  const [citySearch, setCitySearch] = useState("");
  const [query, setQuery] = useState("");
  const [store, setStore] = useState("");
  const [tab, setTab] = useState<"work" | "done" | "all">("all");
  const [expanded, setExpanded] = useState("");
  const group =
    groups.find((g) => g.id === directionId) ||
    groups.find((g) => g.jobs.some((j) => j.id === selectedJobId)) ||
    groups[0];
  if (!group)
    return (
      <Empty title="Направлений пока нет">
        Создайте поставку или обновите источники.
      </Empty>
    );
  const stores = [
    ...new Set(group.jobs.flatMap((job) => job.orders.map(orderStore))),
  ].sort((a, b) => Number(a) - Number(b));
  const activeStore = stores.includes(store) ? store : "";
  const scoped = group.jobs
    .map((job) => ({
      ...job,
      orders: job.orders.filter(
        (order) => !activeStore || orderStore(order) === activeStore,
      ),
    }))
    .filter((job) => !activeStore || job.orders.length > 0);
  const done = scoped.filter(directionJobReady).length;
  const orders = scoped.flatMap((job) => job.orders);
  const shown = scoped.filter(
    (job) =>
      (tab === "all" || directionJobReady(job) === (tab === "done")) &&
      (!query.trim() ||
        `${job.name} ${job.orders.map((o) => o.article).join(" ")}`
          .toLocaleLowerCase("ru-RU")
          .includes(query.trim().toLocaleLowerCase("ru-RU"))),
  );
  const missing = scoped.some((job) => job.missingPositions > 0);
  const assemblyUrl = import.meta.env.VITE_ASSEMBLY_WEB_APP_URL || "";
  return (
    <div className="supply-directions-layout">
      <aside className="panel directions-nav" aria-label="Направления сборки">
        <div className="directions-nav-heading">
          <h2>Направления</h2>
          <span>{groups.length}</span>
        </div>
        <label className="directions-search">
          <Search size={17} />
          <input
            type="search"
            aria-label="Найти город или поставку"
            placeholder="Найти город или поставку"
            value={citySearch}
            onChange={(e) => setCitySearch(e.target.value)}
          />
        </label>
        <div className="directions-nav-list">
          {groups
            .filter((g) =>
              `${g.city} ${g.marketplace} ${g.jobs.map((j) => j.name).join(" ")}`
                .toLocaleLowerCase("ru-RU")
                .includes(citySearch.toLocaleLowerCase("ru-RU").trim()),
            )
            .map((g) => {
              const p = directionProgress(
                g.jobs.flatMap((j) => j.orders),
                "packed",
              );
              const missingPositions = g.jobs.some((job) => job.missingPositions > 0);
              const percent = missingPositions ? null : p.percent;
              const lowerPercent = missingPositions ? null : p.lowerPercent;
              const progressLabel = percent !== null ? `${percent}%`
                : lowerPercent !== null ? `≥ ${lowerPercent}%` : "—";
              const progressTitle = percent === null
                ? `Подтверждено ${num(p.done)} из ${num(p.plan)} шт. Данные об упаковке неполные.`
                : `Упаковано ${num(p.done)} из ${num(p.plan)} шт.`;
              return (
                <button
                  key={g.id}
                  className={`directions-nav-item ${g.id === group.id ? "selected" : ""}`}
                  aria-current={g.id === group.id ? "true" : undefined}
                  onClick={() => {
                    setDirectionId(g.id);
                    setStore("");
                    setQuery("");
                    setExpanded("");
                  }}
                >
                  <Market name={g.marketplace} />
                  <span>
                    <strong>{g.city}</strong>
                    <small>
                      {g.jobs.length} заданий ·{" "}
                      {
                        new Set(
                          g.jobs
                            .flatMap((j) => j.orders.map(orderStore))
                            .filter(Boolean),
                        ).size
                      }{" "}
                      магазина
                    </small>
                    <i className="direction-progress-track">
                      <i style={{ width: `${percent ?? lowerPercent ?? 0}%` }} />
                    </i>
                  </span>
                  <b title={progressTitle}>{progressLabel}</b>
                </button>
              );
            })}
        </div>
        <Button className="directions-manage" onClick={onShowJobs}>
          <Settings2 size={16} /> Управление заданиями
        </Button>
      </aside>
      <div className="directions-main">
        <section className="panel direction-summary">
          <div className="direction-summary-title">
            <Market name={group.marketplace} />
            <div>
              <span>СБОРКА ПО НАПРАВЛЕНИЯМ</span>
              <h2>{group.city}</h2>
            </div>
          </div>
          <div className="direction-stores" aria-label="Магазин направления">
            {[
              { id: "", name: "Все магазины" },
              ...stores
                .filter(Boolean)
                .map((id) => ({ id, name: `Магазин ${id}` })),
              ...(stores.includes("")
                ? [{ id: "unknown", name: "Не подтверждён" }]
                : []),
            ]
              .filter((s) => s.id !== "unknown")
              .map((s) => (
                <button
                  key={s.id}
                  className={activeStore === s.id ? "active" : ""}
                  aria-pressed={activeStore === s.id}
                  onClick={() => {
                    setStore(s.id);
                    setExpanded("");
                  }}
                >
                  {s.name}
                </button>
              ))}
            <strong>
              {scoped.length} заданий ·{" "}
              {num(orders.reduce((sum, o) => sum + o.quantity, 0))} шт.
            </strong>
          </div>
          <div className="direction-stage-summary">
            {directionStages.map(({ field, label, Icon }) => (
              <div key={field} className={field}>
                <h3>
                  <Icon size={18} /> {label}
                </h3>
                <Progress orders={orders} field={field} missing={missing} />
              </div>
            ))}
          </div>
          {missing && (
            <p className="directions-data-note">
              Часть исходных позиций не подтверждена. Показаны доступные данные;
              готовность не считается полной.
            </p>
          )}
        </section>
        <section className="panel direction-job-panel">
          <h2>Задания для сборки</h2>
          <div className="direction-job-tools">
            <div className="direction-job-tabs" aria-label="Готовность заданий">
              {(["work", "done", "all"] as const).map((value, i) => (
                <button
                  key={value}
                  className={tab === value ? "active" : ""}
                  aria-pressed={tab === value}
                  onClick={() => setTab(value)}
                >
                  {["В работе", "Готовые", "Все"][i]}{" "}
                  <b>
                    {value === "all"
                      ? scoped.length
                      : value === "done"
                        ? done
                        : scoped.length - done}
                  </b>
                </button>
              ))}
            </div>
            <label className="directions-search">
              <Search size={17} />
              <input
                type="search"
                placeholder="Найти задание или артикул"
                aria-label="Найти задание или артикул"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <div className="direction-job-table">
            <div className="direction-job-heading">
              <span>Задание</span>
              <span>План</span>
              <span>Печать</span>
              <span>Резка на станке</span>
              <span>Упаковка</span>
              <span>Статус</span>
            </div>
            {shown.map((job) => {
              const ready = directionJobReady(job);
              const opened = expanded === job.id;
              return (
                <article
                  key={job.id}
                  className={`direction-job-row ${opened ? "expanded" : ""}`}
                >
                  <button
                    className="direction-job-select"
                    aria-expanded={opened}
                    onClick={() => setExpanded(opened ? "" : job.id)}
                  >
                    <span className="direction-job-name">
                      {opened ? (
                        <ChevronDown size={17} />
                      ) : (
                        <ChevronRight size={17} />
                      )}
                      <span>
                        <strong>{job.name}</strong>
                        <small>
                          {job.orders.length} позиций ·{" "}
                          {job.orders.some(
                            (o) => o.sourceId === "roll-printing",
                          )
                            ? "Рулонная печать"
                            : ""}
                          {job.orders.some(
                            (o) => o.sourceId === "roll-printing",
                          ) &&
                          job.orders.some((o) => o.sourceId === "box-printing")
                            ? " + "
                            : ""}
                          {job.orders.some((o) => o.sourceId === "box-printing")
                            ? "Бокс"
                            : ""}
                        </small>
                      </span>
                    </span>
                    <strong>
                      {num(job.orders.reduce((sum, o) => sum + o.quantity, 0))}{" "}
                      шт.
                    </strong>
                    <Progress
                      orders={job.orders}
                      field="printed"
                      missing={job.missingPositions > 0}
                    />
                    <Progress
                      orders={job.orders}
                      field="assemblyMachineCut"
                      missing={job.missingPositions > 0}
                    />
                    <Progress
                      orders={job.orders}
                      field="packed"
                      missing={job.missingPositions > 0}
                    />
                    <span
                      className={`direction-job-status ${ready ? "ready" : job.lock === "closed" ? "closed" : ""}`}
                    >
                      {job.lock === "closed"
                        ? "Закрыто для сборки"
                        : ready
                          ? "Упаковка готова"
                          : "В работе"}
                    </span>
                  </button>
                  {opened && (
                    <div className="direction-job-actions">
                      <span className={`direction-job-lock ${job.lock}`}>
                        <LockKeyhole size={14} />
                        {job.lock === "closed"
                          ? "Закрыта для сборки"
                          : job.lock === "open"
                            ? "Открыта для сборки"
                            : job.lock === "partial"
                              ? "Частично закрыта"
                              : "Статус сборки проверяется"}
                      </span>
                      <Button onClick={() => onOpenJob(job.id)}>
                        Открыть состав и управление
                      </Button>
                      {assemblyUrl && (
                        <a href={assemblyUrl} target="_blank" rel="noreferrer">
                          Открыть сборку <ExternalLink size={15} />
                        </a>
                      )}
                      <small>
                        Ручная резка:{" "}
                        <b>
                          {directionProgress(job.orders, "assemblyManualCut")
                            .known
                            ? num(
                                directionProgress(
                                  job.orders,
                                  "assemblyManualCut",
                                ).done,
                              ) + " шт."
                            : "нет подтверждённых данных"}
                        </b>
                      </small>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          {!shown.length && (
            <Empty title="Задания не найдены">
              Измените поиск или выбранный статус.
            </Empty>
          )}
          <p className="directions-data-note">
            Новые задания появляются в своём направлении автоматически. Исходные
            задания, история и выработка сохраняются.
          </p>
        </section>
      </div>
    </div>
  );
}
