import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDownUp, Box, Printer, RefreshCw } from "lucide-react";
import { number, type Position } from "../shared/model";
import { isFinished, positionStatus, readiness } from "../shared/assembly";
import { Button, Empty, Status } from "./ui";
import { useDraftNavigation } from "./DraftGuard";
import { useAccess } from "./Access";
import type { Workspace } from "./useWorkspace";
import { WorkDialog } from "./WorkDialog";
import { BoxDrawer } from "./BoxDrawer";
import { AssemblyProduct } from "./AssemblyProduct";
import { LabelDialog } from "./LabelDialog";
import { labelBatchLimit } from "../shared/labels";
import { isSearchablePosition, matchesPositionQuery } from "../shared/position-search";
import { AssemblySearch, type SearchDestination } from "./AssemblySearch";
import { ProductionTasks } from "./ProductionTasks";
import { compareDeadlines, compareShippingDates, deadlineCaption, supplyDeadlines } from "../shared/supply-deadlines";
import { deadlineTone, shipmentDate, ShipmentSchedule, UpcomingDeadlines } from "./AssemblyDeadlines";
import "./legacy.css";
import "./legacy-adapter.css";

const tabs = [
  ["active", "В работе"],
  ["ready", "Готовые"],
  ["all", "Все"],
] as const;
const noActivePositions: Position[] = [];
type CollectorShellProps = { workspace: Workspace; sidebarNavigation: ReactNode };

export function CollectorLoading({ workspace: w, sidebarNavigation }: CollectorShellProps) {
  return (
    <div className="legacy-assembly">
      <div className="app-shell">
        <aside className="sidebar" aria-label="Поставки">
          <div className="brand">
            <span className="brand-mark">R</span>
            <span className="brand-word">
              RITM <span>Сборка</span>
            </span>
          </div>
          <p className="readonly-note">
            {w.loading ? "Загрузка поставок…" : "Поставки не загружены"}
          </p>
          <div className="sidebar-bottom">{sidebarNavigation}</div>
        </aside>
        <main className="legacy-main">
          <h1>
            {w.loading
              ? "Загружаем поставки…"
              : "Не удалось загрузить RITM Сборка"}
          </h1>
          <Status error={w.error} notice="" retry={() => void w.refresh()} />
        </main>
      </div>
    </div>
  );
}
export function Collector({
  workspace: w,
  navigate,
  sidebarNavigation,
}: CollectorShellProps & {
  navigate(view: string): void;
}) {
  const role = useAccess();
  const state = w.state!;
  const safely = useDraftNavigation();
  const params = new URLSearchParams(location.search);
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [filter, setFilter] = useState(params.get("filter") ?? "active");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [department, setDepartment] = useState(params.get("department") ?? "");
  const [kind, setKind] = useState(params.get("kind") ?? "");
  const [limit, setLimit] = useState(60);
  const [supplyQuery, setSupplyQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [workId, setWorkId] = useState<string | null>(null);
  const [boxesFor, setBoxesFor] = useState<string | null | false>(false);
  const [labelSelection, setLabelSelection] = useState<Set<string>>(new Set());
  const [labelIds, setLabelIds] = useState<string[] | null>(null);
  const [searchTarget, setSearchTarget] = useState<SearchDestination | null>(null);
  const [jumpUnavailable, setJumpUnavailable] = useState(false);
  const [now, setNow] = useState(Date.now);
  const previousJump = useRef<SearchDestination | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    const check = () => setNow(Date.now());
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);
  useEffect(() => {
    const available = new Set(state.positions.map(p => p.id));
    setLabelSelection(old => [...old].every(id => available.has(id)) ? old : new Set([...old].filter(id => available.has(id))));
  }, [state.positions]);
  const supply = state.supplies.find((s) => s.id === state.selectedSupplyId);
  const selectedSource = supply?.sources?.find(source => source.id === state.selectedSupplyId) ?? supply;
  const directions = useMemo(() => state.supplies.filter(s => s.sourceActive !== false).map(direction => {
    const sources = (direction.sources ?? [direction])
      .filter(s => s.sourceActive !== false)
      .map(supply => ({ supply, deadlines: supplyDeadlines(supply, now), title: direction.title }));
    sources.sort((first, second) => compareDeadlines(first.deadlines, second.deadlines));
    return { direction, sources, priority: sources[0] ?? { supply: direction, deadlines: supplyDeadlines(direction, now), title: direction.title } };
  }).sort((first, second) => compareDeadlines(first.priority.deadlines, second.priority.deadlines)), [state.supplies, now]);
  const upcoming = useMemo(() => directions.flatMap(d => d.sources)
    .filter(({deadlines}) => deadlines.next || deadlines.urgent)
    .sort((first, second) => compareShippingDates(first.deadlines, second.deadlines))
    .slice(0, 3), [directions]);
  const completed = state.positions.filter(isFinished).length;
  const counts = {
    active: state.positions.length - completed,
    ready: completed,
    all: state.positions.length,
  };
  const percent = readiness(state.positions);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ru");
    return state.positions.filter(
      (p) =>
        (filter === "all" ||
          (filter === "ready" ? isFinished(p) : !isFinished(p))) &&
        (!status || positionStatus(p) === status) &&
        (!department || p.department === department) &&
        (!kind || p.catalog?.kind === kind) &&
        matchesPositionQuery(p, needle),
    );
  }, [state.positions, filter, status, department, query, kind]);
  const targetIndex = searchTarget && searchTarget.supplyId === state.selectedSupplyId
    ? matches.findIndex(p => p.id === searchTarget.id && isSearchablePosition(p)) : -1;
  const visibleLimit = Math.max(limit, targetIndex + 1);
  useEffect(() => {
    if (!searchTarget || w.loading || w.selectionPending || previousJump.current === searchTarget) return;
    previousJump.current = searchTarget;
    const row = targetIndex < 0 || supply?.sourceActive === false ? null : document.getElementById(`position-${searchTarget.id}`);
    if (!row) {
      setJumpUnavailable(true);
      return;
    }
    row.scrollIntoView({ block: "center", inline: "nearest" });
    row.querySelector<HTMLButtonElement>(".article-main")?.focus({ preventScroll: true });
  }, [searchTarget, supply?.sourceActive, targetIndex, w.loading, w.selectionPending]);
  const directionQuery = supplyQuery.toLocaleLowerCase("ru");
  const supplies = directions.filter(({ direction, sources }) =>
    [direction, ...sources.map(({ supply }) => supply)].some(supply =>
      `${supply.title} ${supply.destination} ${supply.store}`.toLocaleLowerCase("ru").includes(directionQuery),
    ),
  );
  const activeWork = state.positions.find((p) => p.id === workId);
  const labelVersion = labelIds?.map(id => state.positions.find(p => p.id === id)?.catalog?.labelSha ?? "").join(":");
  function changeFilters(
    q: string,
    f: string,
    st = status,
    dep = department,
    productKind = kind,
  ) {
    setSearchTarget(null);
    setJumpUnavailable(false);
    setQuery(q);
    setFilter(f);
    setStatus(st);
    setDepartment(dep);
    setKind(productKind);
    setLimit(60);
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({
      q,
      filter: f,
      status: st,
      department: dep,
      kind: productKind,
    })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    history.replaceState(null, "", url);
  }
  function resetPositionActions() {
    setWorkId(null);
    setBoxesFor(false);
    setLabelIds(null);
    setLabelSelection(new Set());
    setExpanded(new Set());
  }
  function selectSupply(id: string) {
    if (w.busy || w.selectionPending || id === state.selectedSupplyId) return;
    safely(() => {
      resetPositionActions();
      changeFilters("", "active", "", "", "");
      w.selectSupply(id);
    });
  }
  function selectSearchResult(hit: SearchDestination) {
    if (w.busy || w.selectionPending) return;
    safely(() => {
      resetPositionActions();
      changeFilters(hit.sku, "all", "", "", "");
      setSearchTarget(hit);
      if (hit.supplyId !== state.selectedSupplyId) {
        setSupplyQuery("");
        w.selectSupply(hit.supplyId);
      }
    });
  }
  function arrowTab(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? 2
          : (index + (e.key === "ArrowRight" ? 1 : 2)) % 3;
    changeFilters(query, tabs[next][0]);
    document.getElementById(`completion-${tabs[next][0]}`)?.focus();
  }
  return (
    <div className="legacy-assembly">
      <div className="app-shell">
        <aside className="sidebar" aria-label="Поставки">
          <a
            className="brand"
            href="?view=assembly"
            aria-label="RITM Сборка"
            onClick={(e) => {
              e.preventDefault();
              navigate("assembly");
            }}
          >
            <span className="brand-mark">R</span>
            <span className="brand-word">
              RITM <span>Сборка</span>
            </span>
          </a>
          <nav className="shipments-navigation" aria-label="Выбор поставки">
            <div className="nav-heading">
              Направления{" "}
              <span>
                {directions.length}
              </span>
            </div>
            <input
              className="shipment-search"
              type="search"
              value={supplyQuery}
              onChange={(e) => setSupplyQuery(e.target.value)}
              placeholder="Найти город или магазин"
              aria-label="Поиск направления"
            />
            <div className="assembly-deadline-order"><ArrowDownUp size={13} aria-hidden="true" />Сначала срочные</div>
            <div className="shipment-list">
              {supplies.map(({direction: s, priority}) => (
                <button
                  className="shipment-button direction-button assembly-deadline-direction"
                  data-tone={deadlineTone(priority.deadlines)}
                  type="button"
                  key={s.id}
                  aria-current={
                    s.id === state.selectedSupplyId ? "true" : undefined
                  }
                  disabled={w.busy || w.loading || w.selectionPending}
                  onClick={() => selectSupply(priority.supply.id)}
                >
                  <span
                    className={`shipment-icon supplier-logo supplier-logo-${s.market.toLowerCase()}`}
                  >
                    {s.market}
                  </span>
                  <span className="shipment-copy">
                    <strong className="shipment-name">{s.title.replace(/^(?:OZON|ОЗОН|WB|ВБ|WILDBERRIES)\s+/iu, "")}</strong>
                    {s.sourceLocked ? (
                      <span className="shipment-meta">Закрыта в РИТМ</span>
                    ) : null}
                    {s.sourceActive === false ? (
                      <span className="shipment-meta">
                        Источник РИТМ приостановлен
                      </span>
                    ) : null}
                    {priority.deadlines.rank < 2 && <span className="assembly-deadline-badge" data-tone={deadlineTone(priority.deadlines)}>
                      {deadlineCaption(priority.deadlines)}
                    </span>}
                    <span className="shipment-meta">{shipmentDate(priority.deadlines)}</span>
                    {s.id === state.selectedSupplyId ? (
                      <><span className="shipment-meta">{counts.active} в работе · {counts.ready} готово</span><span className="shipment-readiness-track">
                        <span
                          className="shipment-readiness-fill"
                          style={{ width: `${Math.min(100, percent)}%` }}
                        />
                      </span></>
                    ) : null}
                  </span>
                </button>
              ))}
              {!supplies.length ? (
                <p className="shipment-search-empty">Направления не найдены</p>
              ) : null}
            </div>
          </nav>
          <div className="sidebar-bottom">
            {sidebarNavigation}
            <div className="sidebar-foot">
              <span className="test-dot" />
              RITM Сборка · рабочая версия
            </div>
          </div>
        </aside>
        <main className="legacy-main" aria-busy={w.loading}>
          <UpcomingDeadlines now={now} items={upcoming} selected={state.selectedSupplyId}
            disabled={w.busy || w.loading || w.selectionPending} onSelect={selectSupply} />
          <div className="page-head">
            <div className="shipment-title-block">
              <div className="eyebrow">Сборка по направлениям</div>
              <div className="shipment-heading">
                {supply ? (
                  <span
                    className={`shipment-market ${supply.market === "WB" ? "is-wb" : ""}`}
                  >
                    {supply.market}
                  </span>
                ) : null}
                <h1>{supply?.title ?? "Нет активных поставок"}</h1>
              </div>
              <div className="shipment-overview" aria-label="Сводка поставки">
                <span>
                  <strong>{number(state.positions.length)}</strong> артикулов
                </span>
                <span>
                  План: <strong>{number(state.progress.plan)} шт.</strong>
                </span>
                <span className="shipment-overview-progress">
                  Готовность: <strong>{percent}%</strong>
                  <span className="shipment-overview-track">
                    <span
                      className="shipment-overview-fill"
                      style={{ width: `${Math.min(100, percent)}%` }}
                    />
                  </span>
                </span>
                {supply ? (
                  <ProductionTasks supply={supply} selectedId={state.selectedSupplyId}
                    departments={[...new Set(state.positions.map(p => p.department).filter(Boolean))]}
                    disabled={w.busy || w.loading || w.selectionPending} onSelect={selectSupply} />
                ) : null}
              </div>
            </div>
            <div className="head-tools">
              {labelSelection.size ? <Button className="button-quiet" disabled={w.loading || w.selectionPending}
                onClick={() => setLabelIds([...labelSelection])}>
                <Printer size={16} aria-hidden="true" />Этикетки для выбранных · {labelSelection.size}
              </Button> : null}
              <AssemblySearch
                query={query}
                currentId={state.selectedSupplyId}
                positions={supply?.sourceActive === false ? noActivePositions : state.positions}
                disabled={w.busy || w.selectionPending}
                onQuery={q => changeFilters(q, filter)}
                onSelect={selectSearchResult}
              />
              <Button
                className="button-quiet"
                aria-label="Обновить данные"
                title="Обновить данные"
                disabled={w.busy || w.loading}
                onClick={() => void w.refresh()}
              >
                <RefreshCw size={18} aria-hidden="true" />
              </Button>
              <Button
                className="open-boxes-button"
                disabled={
                  !state.positions.length ||
                  w.busy ||
                  w.loading ||
                  w.selectionPending
                }
                onClick={() => setBoxesFor(null)}
              >
                <Box size={17} aria-hidden="true" />
                Короба
              </Button>
            </div>
          </div>
          {selectedSource && <ShipmentSchedule deadlines={supplyDeadlines(selectedSource, now)}
            title={(supply?.sources?.length ?? 0) > 1 ? selectedSource.title : undefined} />}
          {jumpUnavailable && <p className="direction-read-status" role="status">Позиция больше недоступна. Повторите поиск по артикулу.</p>}
          {supply ? (
            <>
              <div className="list-toolbar">
                <div className="list-toolbar-main">
                  <div
                    className="completion-tabs"
                    role="tablist"
                    aria-label="Готовность товаров"
                  >
                    {tabs.map(([key, label], i) => (
                      <button
                        type="button"
                        id={`completion-${key}`}
                        key={key}
                        role="tab"
                        aria-controls="assembly-products"
                        aria-selected={filter === key}
                        tabIndex={filter === key ? 0 : -1}
                        className={filter === key ? "is-active" : ""}
                        onKeyDown={(e) => arrowTab(e, i)}
                        onClick={() => changeFilters(query, key)}
                      >
                        {label} · {counts[key]}
                      </button>
                    ))}
                  </div>
                  <label className="type-filter">
                    <span>Вид товара</span>
                    <select
                      aria-label="Фильтр по виду товара"
                      value={kind}
                      onChange={(e) =>
                        changeFilters(
                          query,
                          filter,
                          status,
                          department,
                          e.target.value,
                        )
                      }
                      disabled={!state.positions.some((p) => p.catalog?.kind)}
                    >
                      <option value="">Все виды</option>
                      {[
                        ...new Set(
                          state.positions
                            .map((p) => p.catalog?.kind)
                            .filter(Boolean),
                        ),
                      ].map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </label>
                  <details className="advanced-filters">
                    <summary>Ещё фильтры</summary>
                    <div>
                      <label>
                        Участок
                        <select
                          value={department}
                          onChange={(e) =>
                            changeFilters(query, filter, status, e.target.value)
                          }
                        >
                          <option value="">Все участки</option>
                          {[
                            ...new Set(
                              state.positions.map((p) => p.department),
                            ),
                          ].map((d) => (
                            <option key={d}>{d}</option>
                          ))}
                        </select>
                      </label>
                      <p className="readonly-note">Магазин: {supply.store}</p>
                    </div>
                  </details>
                  <label className="status-toolbar-filter">
                    <span>Статус</span>
                    <select
                      aria-label="Фильтр по статусу"
                      value={status}
                      onChange={(e) =>
                        changeFilters(query, filter, e.target.value)
                      }
                    >
                      <option value="">Все статусы</option>
                      {[...new Set(state.positions.map(positionStatus))].map(
                        (s) => (
                          <option key={s}>{s}</option>
                        ),
                      )}
                    </select>
                  </label>
                </div>
                <span className="shipment-sync">
                  {w.loading ? "Обновляем данные…" : "Автообновление"}
                </span>
              </div>
              <p className="direction-read-status">
                {supply?.sourceLocked
                  ? "Поставка закрыта для сборки в РИТМ. Откройте её замок в РИТМ, чтобы записывать работу. История доступна."
                  : "Готовые товары и вся история остаются доступны"}
              </p>
              <section className="list-shell" aria-label="Позиции поставки">
                <div className="list-scroll">
                  <div className="column-head" aria-hidden="true">
                    <div>Товар</div>
                    <div>Вид товара</div>
                    <div>Тип короба</div>
                    <div>План</div>
                    <div className="cut-label">Резка на станке</div>
                    <div className="assembly-label">Ручная резка</div>
                    <div className="packing-label">Упаковка</div>
                    <div>Остаток</div>
                    <div>Короба</div>
                    <div>Статус</div>
                    <div />
                  </div>
                  <div
                    id="assembly-products"
                    role="tabpanel"
                    aria-labelledby={`completion-${filter}`}
                  >
                    {matches.slice(0, visibleLimit).map((p) => (
                      <AssemblyProduct
                        key={p.id}
                        product={p}
                        supply={
                          state.sourceSupplies?.find(
                            (s) => s.id === p.supplyId,
                          ) || supply
                        }
                        workspace={w}
                        highlighted={targetIndex >= 0 && searchTarget?.id === p.id}
                        expanded={expanded.has(p.id)}
                        onExpand={() =>
                          setExpanded((old) => {
                            const next = new Set(old);
                            if (!next.delete(p.id)) next.add(p.id);
                            return next;
                          })
                        }
                        onWork={() => setWorkId(p.id)}
                        onBox={() => setBoxesFor(p.id)}
                        onLabel={() => setLabelIds([p.id])}
                        labelSelected={labelSelection.has(p.id)}
                        labelSelectionDisabled={!labelSelection.has(p.id) && labelSelection.size >= labelBatchLimit}
                        onSelectLabel={selected => setLabelSelection(old => {
                          const next = new Set(old);
                          if (selected && next.size < labelBatchLimit) next.add(p.id);
                          else if (!selected) next.delete(p.id);
                          return next;
                        })}
                      />
                    ))}
                    {!matches.length ? (
                      <Empty title="По выбранным фильтрам ничего не найдено">
                        <Button
                          onClick={() => changeFilters("", "all", "", "", "")}
                        >
                          Показать все товары
                        </Button>
                      </Empty>
                    ) : null}
                    {matches.length > visibleLimit ? (
                      <Button
                        className="load-more button-ghost"
                          onClick={() => setLimit(visibleLimit + 60)}
                      >
                          Показать ещё · осталось {matches.length - visibleLimit}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="list-foot">
                  <span>
                    Показано {Math.min(visibleLimit, matches.length)} из{" "}
                    {matches.length}. Факты — из журналов этого направления.
                  </span>
                  <span title={w.ritm?.message}>
                    {w.ritm?.configured
                      ? w.ritm.status === "synced"
                        ? "Поставки из РИТМ"
                        : w.ritm.status === "syncing"
                          ? "Обновляем поставки…"
                          : w.ritm.status === "partial"
                            ? "Поставки из РИТМ · есть замечания"
                            : w.ritm.sourceAt && w.ritm.status === "waiting"
                              ? "Ожидаем обновления РИТМ"
                              : "Связь с РИТМ · проверьте подключение"
                      : "Отдельный учёт"}
                  </span>
                </div>
              </section>
            </>
          ) : (
            <Empty title="Поставок пока нет">
              {role === "owner" && (
                <Button primary onClick={() => navigate("setup")}>
                  Добавить сотрудников и поставку
                </Button>
              )}
            </Empty>
          )}
          <div className="legacy-status">
            <Status
              error={w.error}
              notice={w.notice}
              retry={() => void w.refresh()}
            />
          </div>
        </main>
      </div>
      {labelIds ? <LabelDialog positionIds={labelIds} labelVersion={labelVersion} onClose={() => setLabelIds(null)} /> : null}
      {activeWork && supply ? (
        <WorkDialog
          key={activeWork.id}
          product={activeWork}
          supply={
            state.sourceSupplies?.find((s) => s.id === activeWork.supplyId) ||
            supply
          }
          workspace={w}
          onClose={() => setWorkId(null)}
          onSavedPacking={(positionId) => {
            setWorkId(null);
            setBoxesFor(positionId);
          }}
        />
      ) : null}
      {boxesFor !== false && supply ? (
        <BoxDrawer
          key={state.selectedSupplyId}
          initialPositionId={boxesFor}
          supply={supply}
          workspace={w}
          onClose={() => setBoxesFor(false)}
          onWork={(positionId) => {
            setBoxesFor(false);
            setWorkId(positionId);
          }}
        />
      ) : null}
    </div>
  );
}
