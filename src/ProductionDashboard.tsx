import { Fragment, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  ChartBar,
  CheckCircle,
  MagnifyingGlass,
  Package,
  Printer,
  Scissors,
  Truck,
  Warning,
} from "./icons";
import type { LivePrinting } from "./livePrinting";
import { rollCut, rollPrinted } from "./liveSupplyProgress";
import { num } from "./model";
import {
  buildProductionGroups as buildGroups,
  productionFact as fact,
  productionStoreCoverage,
  productionStoreIssue,
  type Fact,
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
  const label = market === "WB" ? "WB" : market === "Ozon" ? "Ozon" : "?";
  const cls = market === "WB" ? "wb" : market === "Ozon" ? "ozon" : "unknown";
  return <span className={`production-market-mark ${cls}`}>{label}</span>;
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
          `${group.name} ${row.article} ${row.store}`
            .toLocaleLowerCase("ru-RU")
            .includes(search.trim().toLocaleLowerCase("ru-RU")),
      );
      const filteredOrders = rows.flatMap((row) => row.orders);
      return {
        ...group,
        rows,
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
            <ChartBar size={21} />
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
            <Package size={21} />
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
            <CheckCircle size={21} />
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
      </section>

      <section className="production-table-panel">
        <div className="production-table-heading">
          <div>
            <h2>Работа по поставкам</h2>
            <p>Текущее состояние по подтверждённым данным</p>
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
        <div className="production-table-wrap">
          <table className="production-table">
            <thead>
              <tr>
                <th>Поставка</th>
                <th>Магазин</th>
                <th>Артикул</th>
                <th>План</th>
                <th>
                  <Printer size={14} /> Напечатано
                </th>
                <th>
                  <Scissors size={14} /> Порезано
                </th>
                <th>
                  <Package size={14} /> Упаковано
                </th>
                <th>Короба</th>
                <th>Осталось</th>
              </tr>
            </thead>
            <tbody>
              {visibleGroups.map((group) => {
                const isCollapsed = collapsed.has(group.key);
                const rest =
                  group.packed.complete && group.packed.value !== null
                    ? group.plan - group.packed.value
                    : null;
                return (
                  <Fragment key={group.key}>
                    <tr
                      className="production-group-row"
                      key={`${group.key}:group`}
                    >
                      <td>
                        <div className="production-supply-title">
                          <button
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
                              <CaretRight size={16} />
                            ) : (
                              <CaretDown size={16} />
                            )}
                          </button>
                          <MarketplaceMark market={group.market} />
                          <strong>{group.name}</strong>
                          <small>{num(group.rows.length)} арт.</small>
                          {group.sourceUrl && (
                            <a
                              href={group.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Открыть лист ${group.name}`}
                              title="Открыть исходный лист"
                            >
                              <ArrowSquareOut size={14} />
                            </a>
                          )}
                        </div>
                      </td>
                      <td>
                        {group.stores.length === 1
                          ? group.stores[0]
                          : group.stores.length
                            ? "Разные"
                            : "—"}
                      </td>
                      <td className="production-muted">Итого</td>
                      <td>
                        <strong>{num(group.plan)}</strong>
                      </td>
                      <td>
                        <FactCell metric={group.printed} plan={group.plan} />
                      </td>
                      <td>
                        <FactCell metric={group.cut} plan={group.plan} />
                      </td>
                      <td>
                        <ProgressCell metric={group.packed} plan={group.plan} />
                      </td>
                      <td
                        className="production-no-fact"
                        title="Данные о физических коробах не входят в подключённую сводку"
                      >
                        —
                      </td>
                      <td
                        className={
                          rest !== null && rest < 0
                            ? "production-over-value"
                            : ""
                        }
                      >
                        {rest === null ? "—" : num(rest)}
                      </td>
                    </tr>
                    {!isCollapsed &&
                      group.rows.map((row) => {
                        const rowRest =
                          row.packed.complete && row.packed.value !== null
                            ? row.plan - row.packed.value
                            : null;
                        return (
                          <tr className="production-article-row" key={row.key}>
                            <td>
                              <span className="production-article-indent">
                                {group.name}
                              </span>
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
                                {row.store}
                              </span>
                            </td>
                            <td>
                              <strong>{row.article}</strong>
                            </td>
                            <td>{num(row.plan)}</td>
                            <td>
                              <FactCell metric={row.printed} plan={row.plan} />
                            </td>
                            <td>
                              <FactCell metric={row.cut} plan={row.plan} />
                            </td>
                            <td>
                              <ProgressCell
                                metric={row.packed}
                                plan={row.plan}
                              />
                            </td>
                            <td
                              className="production-no-fact"
                              title="Данные о физических коробах не входят в подключённую сводку"
                            >
                              —
                            </td>
                            <td
                              className={
                                rowRest !== null && rowRest < 0
                                  ? "production-over-value"
                                  : ""
                              }
                            >
                              {rowRest === null ? "—" : num(rowRest)}
                            </td>
                          </tr>
                        );
                      })}
                  </Fragment>
                );
              })}
              {!visibleGroups.length && (
                <tr>
                  <td colSpan={9} className="production-empty">
                    {loading
                      ? "Загружаю поставки…"
                      : live
                        ? "По выбранным фильтрам данных нет."
                        : "Проверенные рабочие данные не загружены."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="production-table-foot">
          <span>
            {num(visibleGroups.length)} поставки · {num(selectedOrders.length)}{" "}
            позиций
          </span>
          <span>
            <Truck size={14} /> Количество физических коробов не подключено к
            сводке; здесь не подставляется число коробных позиций.
          </span>
        </div>
      </section>
    </div>
  );
}
