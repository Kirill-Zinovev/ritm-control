import { useMemo, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  Clock3,
  Cube,
  Cylinder,
  FileText,
  MagnifyingGlass,
  Package,
  Printer,
  Scan,
  Scissors,
  Truck,
  Warning,
} from "./icons";
import type { LivePrinting } from "./livePrinting";
import { plannedAreaTotal, rollCut, rollPrinted } from "./liveSupplyProgress";
import { num } from "./model";
import {
  buildProductionGroups as buildGroups,
  productionFact as fact,
  productionStoreCoverage,
  productionStoreIssue,
  type Fact,
  type ProductionDepartment,
  type SupplyGroup,
} from "./productionData";

function factText(metric: Fact, plan: number) {
  if (metric.value === null) return "—";
  if (!metric.complete)
    return `${num(metric.value)} / ${num(plan)} · данные ${metric.known}/${metric.expected}`;
  return `${num(metric.value)} / ${num(plan)}`;
}

function ProgressCell({ metric, plan }: { metric: Fact; plan: number }) {
  if (metric.value === null)
    return (
      <span className="production-no-fact" title="Нет подтверждённых данных">
        —
      </span>
    );
  const percent = plan > 0 ? (metric.value / plan) * 100 : 0;
  const over = metric.complete && metric.value > plan;
  return (
    <div className={`production-progress ${over ? "is-over" : ""}`}>
      <div className="production-progress-values">
        <strong>{num(metric.value)}</strong>
        <span>/ {num(plan)}</span>
        {metric.complete && <b>{num(percent)}%</b>}
      </div>
      <div
        className="production-progress-track"
        role="progressbar"
        aria-label="Выполнение плана"
        aria-valuemin={0}
        aria-valuemax={Math.max(plan, metric.value)}
        aria-valuenow={metric.value}
      >
        <i
          style={{ width: `${Math.min(130, Math.max(0, percent))}%` }}
          className={over ? "is-over" : ""}
        />
      </div>
      {!metric.complete && (
        <small>
          Подтверждено по {metric.known} из {metric.expected}
        </small>
      )}
      {over && (
        <small className="production-over-note">
          +{num(metric.value - plan)} сверх плана
        </small>
      )}
    </div>
  );
}

function FactCell({ metric, plan }: { metric: Fact; plan: number }) {
  if (metric.value === null)
    return <span className="production-no-fact">—</span>;
  return (
    <span className={metric.complete ? "" : "production-partial-fact"}>
      {num(metric.value)}
      {!metric.complete && (
        <small>
          {" "}
          из {num(plan)} · {metric.known}/{metric.expected}
        </small>
      )}
    </span>
  );
}

function MarketplaceMark({ market }: { market: SupplyGroup["market"] }) {
  const label = market === "WB" ? "WB" : market === "Ozon" ? "OZON" : "?";
  const cls = market === "WB" ? "wb" : market === "Ozon" ? "ozon" : "unknown";
  return <span className={`production-market-mark ${cls}`}>{label}</span>;
}

function DepartmentGlyph({
  department,
  size = 21,
}: {
  department: "roll" | "box";
  size?: number;
}) {
  const Icon = department === "roll" ? Cylinder : Package;
  return <Icon size={size} strokeWidth={1.9} aria-hidden="true" />;
}

function DepartmentMetric({
  label,
  metric,
  plan,
}: {
  label: string;
  metric: Fact;
  plan: number;
}) {
  const percent =
    metric.value !== null && plan > 0 ? (metric.value / plan) * 100 : null;
  const complete = metric.complete && percent !== null;
  const over = complete && percent > 100;
  return (
    <div className="production-department-metric">
      <div className="production-department-metric-top">
        <strong>{label}</strong>
        <b className={over ? "is-over" : ""}>
          {complete
            ? `${num(Math.round(percent))}%`
            : metric.value === null
              ? "—"
              : "Частично"}
        </b>
      </div>
      <div className="production-department-metric-value">
        {metric.value === null
          ? "Нет подтверждённых данных"
          : factText(metric, plan)}
      </div>
      <div className="production-department-track" aria-hidden="true">
        <i
          className={over ? "is-over" : ""}
          style={{
            width: `${percent === null ? 0 : Math.min(130, Math.max(0, percent))}%`,
          }}
        />
      </div>
      {metric.value !== null && !metric.complete && (
        <small>
          Подтверждено по {metric.known} из {metric.expected} позиций
        </small>
      )}
      {over && (
        <small className="production-over-note">
          +{num(metric.value! - plan)} сверх плана
        </small>
      )}
    </div>
  );
}

function DepartmentPanel({ department }: { department: ProductionDepartment }) {
  const printLabel = department.id === "box" ? "Печать · R" : "Печать · Т/Х";
  const cutLabel = department.id === "box" ? "Резка · S" : "Резка · U";
  return (
    <section className={`production-department-card is-${department.id}`}>
      <div className="production-department-heading">
        <span className="production-department-icon">
          <DepartmentGlyph department={department.id} size={23} />
        </span>
        <div>
          <strong>{department.label}</strong>
          <small>
            {num(department.rows.length)} артикулов · {num(department.plan)} шт.
          </small>
        </div>
        {department.sourceUrl && (
          <a
            href={department.sourceUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Открыть исходный лист: ${department.label}`}
            title="Открыть исходный лист"
          >
            Лист <ArrowSquareOut size={13} />
          </a>
        )}
      </div>
      <div className="production-department-metrics">
        <DepartmentMetric
          label={printLabel}
          metric={department.printed}
          plan={department.plan}
        />
        <DepartmentMetric
          label={cutLabel}
          metric={department.cut}
          plan={department.plan}
        />
      </div>
    </section>
  );
}

function PackingSummary({ group }: { group: SupplyGroup }) {
  const percent =
    group.packed.value !== null && group.plan > 0
      ? (group.packed.value / group.plan) * 100
      : null;
  const complete = group.packed.complete && percent !== null;
  const over = complete && percent > 100;
  return (
    <div className="production-packing-summary">
      <span className="production-packing-icon">
        <Cube size={21} strokeWidth={1.9} />
      </span>
      <div className="production-packing-title">
        <strong>Упаковка · Assembly</strong>
        <small>
          {num(group.rows.length)} артикулов · {num(group.plan)} шт.
        </small>
      </div>
      <strong className={`production-packing-percent${over ? " is-over" : ""}`}>
        {complete
          ? `${num(Math.round(percent))}%`
          : group.packed.value === null
            ? "—"
            : "Частично"}
      </strong>
      <div className="production-packing-progress">
        <div className="production-packing-values">
          <strong>
            {group.packed.value === null
              ? "Нет подтверждённых данных"
              : `${num(group.packed.value)} из ${num(group.plan)} шт.`}
          </strong>
          {group.packed.value !== null && !group.packed.complete && (
            <small>
              {group.packed.known}/{group.packed.expected} позиций подтверждено
            </small>
          )}
        </div>
        <div className="production-packing-track" aria-hidden="true">
          <i
            className={over ? "is-over" : ""}
            style={{
              width: `${percent === null ? 0 : Math.min(130, Math.max(0, percent))}%`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function storeNumber(store: string) {
  return store.startsWith("Магазин ") ? store.slice("Магазин ".length) : store;
}

export function ProductionDashboard({
  live,
  loading,
  error,
}: {
  live: LivePrinting | null;
  loading: boolean;
  error: string;
}) {
  const [market, setMarket] = useState("all");
  const [store, setStore] = useState("all");
  const [supply, setSupply] = useState("all");
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => buildGroups(live), [live]);
  const stores = useMemo(
    () =>
      [...new Set(groups.flatMap((group) => group.stores))].sort((a, b) =>
        a.localeCompare(b, "ru-RU", { numeric: true }),
      ),
    [groups],
  );
  const visibleGroups = groups
    .filter(
      (group) =>
        market === "all" ||
        (market === "unknown" ? !group.market : group.market === market),
    )
    .filter((group) => supply === "all" || group.key === supply)
    .map((group) => {
      const rows = group.rows.filter(
        (row) =>
          (store === "all" || row.store === store) &&
          `${group.name} ${row.article} ${row.store} ${row.department === "roll" ? "рулон рулонная печать" : "бокс"}`
            .toLocaleLowerCase("ru-RU")
            .includes(search.trim().toLocaleLowerCase("ru-RU")),
      );
      const filteredOrders = rows.flatMap((row) => row.orders);
      const departments = group.departments
        .map((department) => {
          const departmentRows = rows.filter(
            (row) => row.department === department.id,
          );
          const departmentOrders = departmentRows.flatMap((row) => row.orders);
          return {
            ...department,
            rows: departmentRows,
            orders: departmentOrders,
            plan: departmentOrders.reduce(
              (sum, order) => sum + order.quantity,
              0,
            ),
            printed: fact(departmentOrders.map(rollPrinted)),
            cut: fact(departmentOrders.map(rollCut)),
          };
        })
        .filter((department) => department.rows.length > 0);
      return {
        ...group,
        rows,
        departments,
        orders: filteredOrders,
        plan: filteredOrders.reduce((sum, order) => sum + order.quantity, 0),
        printed: fact(filteredOrders.map(rollPrinted)),
        cut: fact(filteredOrders.map(rollCut)),
        packed: fact(filteredOrders.map((order) => order.packed)),
        stores: [...new Set(rows.map((row) => row.store))],
      };
    })
    .filter((group) => group.rows.length > 0);
  const selectedOrders = visibleGroups.flatMap((group) => group.orders);
  const storeCoverage = productionStoreCoverage(selectedOrders);
  const plan = selectedOrders.reduce((sum, order) => sum + order.quantity, 0);
  const packed = fact(selectedOrders.map((order) => order.packed));
  const area = plannedAreaTotal(selectedOrders);
  const remaining =
    packed.complete && packed.value !== null ? plan - packed.value : null;
  const updated = live?.updatedAt
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Moscow",
      }).format(new Date(live.updatedAt))
    : null;

  return (
    <div className="production-dashboard">
      <div className="production-overview-line">
        <span>
          <i className={live && !live.stale ? "is-fresh" : ""} />
          {live
            ? `Данные листов · обновлено ${updated}`
            : loading
              ? "Загружаю рабочие данные…"
              : "Нет проверенных данных"}
        </span>
        <span>
          {num(visibleGroups.length)} поставки · {num(selectedOrders.length)}{" "}
          позиций
        </span>
      </div>

      <section className="production-filters" aria-label="Фильтры производства">
        <label>
          <span>Маркетплейс</span>
          <select
            aria-label="Маркетплейс"
            value={market}
            onChange={(event) => setMarket(event.target.value)}
          >
            <option value="all">Все маркетплейсы</option>
            <option value="Ozon">Ozon</option>
            <option value="WB">Wildberries</option>
            <option value="unknown">Не определён</option>
          </select>
        </label>
        <label>
          <span>Магазин</span>
          <select
            aria-label="Магазин"
            value={store}
            onChange={(event) => setStore(event.target.value)}
          >
            <option value="all">Все магазины</option>
            {stores.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Поставка</span>
          <select
            aria-label="Поставка"
            value={supply}
            onChange={(event) => setSupply(event.target.value)}
          >
            <option value="all">Все поставки</option>
            {groups.map((group) => (
              <option key={group.key} value={group.key}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {live?.stale && (
        <div className="production-alert">
          <Warning size={17} />
          Показан предыдущий проверенный снимок. Последнее обновление источника
          не завершилось.
        </div>
      )}
      {error && (
        <div className="production-alert">
          <Warning size={17} />
          {error}
          {live && " Показаны последние полученные данные."}
        </div>
      )}
      {live?.quality?.status === "partial" && (
        <div className="production-alert">
          <Warning size={17} />В источнике есть некорректные строки; связанные
          показатели отмечены как неполные.
        </div>
      )}
      {storeCoverage.unavailable > 0 && (
        <div className="production-alert">
          <Warning size={17} />
          Не удалось сверить магазин для {num(storeCoverage.unavailable)}{" "}
          позиций выбранных поставок.
        </div>
      )}
      {(storeCoverage.missing > 0 || storeCoverage.ambiguous > 0) && (
        <div className="production-alert">
          <Warning size={17} />В выбранных поставках магазин подтверждён для{" "}
          {num(storeCoverage.matched)} позиций; не подтверждён для{" "}
          {num(storeCoverage.missing)} позиций
          {storeCoverage.ambiguous
            ? `, ещё у ${num(storeCoverage.ambiguous)} позиций разные номера в каталоге.`
            : "."}
        </div>
      )}
      {storeCoverage.unknown_marketplace > 0 && (
        <div className="production-alert">
          <Warning size={17} />У {num(storeCoverage.unknown_marketplace)}{" "}
          позиций не определён маркетплейс. Укажите OZON или WB в названии
          поставки.
        </div>
      )}

      <section
        className="production-kpis"
        aria-label="Итоги по выбранным поставкам"
      >
        <article className="production-kpi">
          <span className="production-kpi-icon plan">
            <FileText size={25} strokeWidth={1.9} />
          </span>
          <div>
            <small>План</small>
            <strong>
              {num(plan)} <em>шт.</em>
            </strong>
            <span>
              {num(visibleGroups.length)} поставки ·{" "}
              {num(selectedOrders.length)} позиций
            </span>
          </div>
        </article>
        <article className="production-kpi">
          <span className="production-kpi-icon packed">
            <Cube size={25} strokeWidth={1.9} />
          </span>
          <div>
            <small>Упаковано</small>
            <strong>
              {packed.value === null ? (
                "—"
              ) : (
                <>
                  {num(packed.value)} <em>шт.</em>
                </>
              )}
            </strong>
            <span>
              {packed.expected === 0
                ? "Нет позиций в фильтре"
                : packed.complete
                  ? "Подтверждено по всем позициям"
                  : `Подтверждено по ${packed.known} из ${packed.expected} позиций`}
            </span>
          </div>
        </article>
        <article className="production-kpi">
          <span className="production-kpi-icon remaining">
            <Clock3 size={25} strokeWidth={1.9} />
          </span>
          <div>
            <small>
              {remaining !== null && remaining < 0
                ? "Сверх плана"
                : "Осталось упаковать"}
            </small>
            <strong>
              {remaining === null ? (
                "—"
              ) : (
                <>
                  {num(remaining)} <em>шт.</em>
                </>
              )}
            </strong>
            <span>
              {remaining !== null && remaining < 0
                ? `Упаковано на ${num(Math.round(((packed.value || 0) / Math.max(1, plan)) * 100))}%`
                : "План минус подтверждённая упаковка"}
            </span>
          </div>
        </article>
        <article className="production-kpi">
          <span className="production-kpi-icon area">
            <Scan size={25} strokeWidth={1.9} />
          </span>
          <div>
            <small>Площадь</small>
            <strong>
              {area.total === null ? (
                "Не определена"
              ) : (
                <>
                  {num(area.total, 2)} <em>м²</em>
                </>
              )}
            </strong>
            <span>
              {area.total === null
                ? "Нет подтверждённых размеров"
                : area.missing
                  ? `Подтверждено по ${num(area.observed)} из ${num(selectedOrders.length)} позиций`
                  : "По всем позициям выбранных поставок"}
            </span>
          </div>
        </article>
      </section>

      <section className="production-table-panel">
        <div className="production-table-heading">
          <div>
            <h2>Работа по поставкам</h2>
            <p>Одна поставка · отдельные направления производства</p>
          </div>
          <label className="production-search">
            <MagnifyingGlass size={17} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Найти артикул или поставку"
              aria-label="Найти артикул или поставку"
            />
          </label>
        </div>
        <div className="production-supply-list">
          {visibleGroups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const remainingForGroup =
              group.packed.complete && group.packed.value !== null
                ? group.plan - group.packed.value
                : null;
            const storeLabel =
              group.stores.length === 1
                ? storeNumber(group.stores[0])
                : group.stores.length
                  ? "Разные"
                  : "Не указан";
            return (
              <article className="production-supply-card" key={group.key}>
                <div className="production-supply-card-header">
                  <button
                    className="production-supply-toggle"
                    aria-label={`${isCollapsed ? "Развернуть" : "Свернуть"} ${group.name}`}
                    aria-expanded={!isCollapsed}
                    onClick={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                  >
                    {isCollapsed ? (
                      <CaretRight size={17} />
                    ) : (
                      <CaretDown size={17} />
                    )}
                  </button>
                  <MarketplaceMark market={group.market} />
                  <div className="production-supply-card-name">
                    <strong>{group.name}</strong>
                    <small>
                      {num(group.departments.length)}{" "}
                      {group.departments.length === 1
                        ? "направление"
                        : "направления"}{" "}
                      · {num(group.rows.length)} артикулов
                    </small>
                  </div>
                  <div className="production-supply-head-stat production-supply-head-store">
                    <small>Магазин</small>
                    <strong>{storeLabel}</strong>
                  </div>
                  <div className="production-supply-head-stat production-supply-head-total">
                    <small>Всего по поставке</small>
                    <strong>{num(group.plan)} шт.</strong>
                  </div>
                  <div className="production-supply-head-packed">
                    <small>Упаковано · Assembly</small>
                    <strong>
                      {group.packed.value === null
                        ? "Нет данных"
                        : `${num(group.packed.value)} / ${num(group.plan)} шт.`}
                    </strong>
                  </div>
                  {remainingForGroup !== null && (
                    <span
                      className={`production-supply-status${remainingForGroup < 0 ? " is-over" : ""}`}
                    >
                      {remainingForGroup < 0
                        ? `+${num(Math.abs(remainingForGroup))} сверх плана`
                        : remainingForGroup === 0
                          ? "План выполнен"
                          : "В работе"}
                    </span>
                  )}
                </div>
                {!isCollapsed && (
                  <div className="production-supply-card-body">
                    <div className="production-department-grid">
                      {group.departments.map((department) => (
                        <DepartmentPanel
                          key={department.id}
                          department={department}
                        />
                      ))}
                    </div>
                    <PackingSummary group={group} />
                    <div className="production-articles-section">
                      <div className="production-articles-heading">
                        <h3>Состав поставки</h3>
                        <span>{num(group.rows.length)} артикулов</span>
                      </div>
                      <div className="production-table-wrap">
                        <table className="production-table">
                          <thead>
                            <tr>
                              <th>Направление</th>
                              <th>Артикул</th>
                              <th>Магазин</th>
                              <th>План</th>
                              <th>
                                <Printer size={14} /> Напечатано
                              </th>
                              <th>
                                <Scissors size={14} /> Порезано
                              </th>
                              <th>
                                <Cube size={14} /> Упаковано
                              </th>
                              <th>Короба</th>
                              <th>Осталось</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.rows.map((row) => {
                              const rowRemaining =
                                row.packed.complete && row.packed.value !== null
                                  ? row.plan - row.packed.value
                                  : null;
                              return (
                                <tr
                                  className="production-article-row"
                                  key={row.key}
                                >
                                  <td>
                                    <span
                                      className={`production-direction-label is-${row.department}`}
                                    >
                                      <DepartmentGlyph
                                        department={row.department}
                                        size={17}
                                      />
                                      {row.department === "roll"
                                        ? "Рулонная печать"
                                        : "Бокс"}
                                    </span>
                                  </td>
                                  <td>
                                    <strong>{row.article}</strong>
                                  </td>
                                  <td>
                                    <span
                                      title={[
                                        ...new Set(
                                          row.orders
                                            .map(productionStoreIssue)
                                            .filter(Boolean),
                                        ),
                                      ].join("; ")}
                                      className={
                                        row.store === "Не указан"
                                          ? "production-missing-store"
                                          : "production-store-tag"
                                      }
                                    >
                                      {storeNumber(row.store)}
                                    </span>
                                  </td>
                                  <td>
                                    <strong>{num(row.plan)}</strong>
                                  </td>
                                  <td>
                                    <FactCell
                                      metric={row.printed}
                                      plan={row.plan}
                                    />
                                  </td>
                                  <td>
                                    <FactCell
                                      metric={row.cut}
                                      plan={row.plan}
                                    />
                                  </td>
                                  <td>
                                    <ProgressCell
                                      metric={row.packed}
                                      plan={row.plan}
                                    />
                                  </td>
                                  <td
                                    className="production-no-fact"
                                    title="Физические короба пока не подключены к этой сводке"
                                  >
                                    —
                                  </td>
                                  <td
                                    className={
                                      rowRemaining !== null && rowRemaining < 0
                                        ? "production-over-value"
                                        : ""
                                    }
                                  >
                                    {rowRemaining === null
                                      ? "—"
                                      : num(rowRemaining)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
          {!visibleGroups.length && (
            <div className="production-empty">
              {loading
                ? "Загружаю поставки…"
                : live
                  ? "По выбранным фильтрам данных нет."
                  : (
                    <>
                      <span className="production-empty-icon" aria-hidden="true">
                        <MagnifyingGlass size={24} strokeWidth={1.8} />
                      </span>
                      <strong>Проверенные данные не загружены</strong>
                      <span>
                        После успешного чтения рабочей таблицы здесь появятся
                        поставки, направления и прогресс.
                      </span>
                    </>
                  )}
            </div>
          )}
        </div>
        <div className="production-table-foot">
          <span>
            {num(visibleGroups.length)} поставки · {num(selectedOrders.length)}{" "}
            позиций
          </span>
          <span>
            <Truck size={14} /> Количество физических коробов не подключено к
            сводке.
          </span>
        </div>
      </section>
    </div>
  );
}
