import { useEffect, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  ChartBar,
  CheckCircle,
  Cube,
  Database,
  House,
  Package,
  Printer,
  Scissors,
  Truck,
  Users,
  Warning,
} from "./icons";
import type { LivePrinting } from "./livePrinting";
import { supplyMarketplace } from "./liveSupplyMarketplace";
import { ShipmentHero } from "./ShipmentHero";
import { rollPrinted } from "./liveSupplyProgress";
import { num } from "./model";
import "./designPreview.css";

type Screen = "overview" | "ozon" | "wb";
type SupplySummary = {
  sheetId: number;
  name: string;
  sourceId?: string;
  orders: number;
  plan: number;
  plannedArea: number;
  quantity: number;
  area: number;
  areaKnown: boolean;
  areaObservedOrders?: number;
  areaMissingOrders?: number;
  printed: number | null;
  cut: number | null;
  packed: number | null;
};

const NAV = [
  ["Обзор", House],
  ["Сборщики", Users],
  ["Печать", Printer],
  ["Производство", ChartBar],
  ["Склад", Cube],
  ["Поставки", Truck],
  ["Источники данных", Database],
] as const;

export function DesignPreview({
  live,
  loading,
  error,
  supplies,
  printingArea,
  assemblyPeople,
  onRefresh,
}: {
  live: LivePrinting | null;
  loading: boolean;
  error: string;
  supplies: SupplySummary[];
  printingArea: number | null;
  assemblyPeople: number | null;
  onRefresh: () => void;
}) {
  const [screen, setScreen] = useState<Screen>(() => {
    const view = new URLSearchParams(location.search).get("view");
    return view === "ozon" || view === "wb" ? view : "overview";
  });
  const [selectedKey, setSelectedKey] = useState("");
  const marketplace =
    screen === "ozon" ? "Ozon" : screen === "wb" ? "WB" : null;
  const choices = useMemo(
    () => supplies.filter((s) => supplyMarketplace(s.name) === marketplace),
    [supplies, marketplace],
  );
  const selected =
    choices.find((s) => `${s.sourceId || ""}:${s.sheetId}` === selectedKey) ||
    choices[0];
  const actualOrders = selected
    ? live?.supplies.filter(
        (o) =>
          o.sheetId === selected.sheetId &&
          (!o.sourceId ||
            !selected.sourceId ||
            o.sourceId === selected.sourceId),
      ) || []
    : [];
  const selectedPrintEvents = selected
    ? live?.events.filter(
        (event) =>
          event.sheetId === selected.sheetId &&
          (!event.sourceId ||
            !selected.sourceId ||
            event.sourceId === selected.sourceId),
      ) || []
    : [];
  const actualPlan = supplies.reduce((sum, s) => sum + s.plan, 0);
  const actualArticles = supplies.reduce((sum, s) => sum + s.orders, 0);

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("designPreview", "1");
    url.searchParams.set("view", screen);
    history.replaceState(null, "", url);
    document.title = `${screen === "overview" ? "Обзор" : `Поставка ${marketplace}`} · RITM · предпросмотр`;
  }, [screen, marketplace]);

  const chooseScreen = (next: Screen) => {
    setScreen(next);
    setSelectedKey("");
  };
  const exitPreview = () => {
    location.href = "?page=overview";
  };

  return (
    <div className="design-preview">
      <div className="dp-previewbar">
        <span className="dp-local-dot" />
        <strong>Локальный предпросмотр</strong>
        <span>·</span>
        <span>Рабочие разделы и данные не изменены</span>
        <button onClick={exitPreview}>Вернуться в RITM</button>
      </div>
      <div className="dp-app">
        <aside className="dp-sidebar">
          <a
            className="dp-brand"
            href="?page=overview"
            onClick={(e) => {
              e.preventDefault();
              exitPreview();
            }}
          >
            <span className="dp-brand-mark">
              <i />
              <i />
              <i />
            </span>
            <span>
              RITM<small>CONTROL</small>
            </span>
          </a>
          <span className="dp-nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</span>
          <nav aria-label="Основное меню">
            {NAV.map(([label, Icon], index) => (
              <button
                key={label}
                className={
                  index === (screen === "overview" ? 0 : 5) ? "active" : ""
                }
                onClick={() =>
                  index === 0
                    ? chooseScreen("overview")
                    : index === 5
                      ? chooseScreen("ozon")
                      : exitPreview()
                }
                title={
                  index !== 0 && index !== 5
                    ? "Открыть рабочий раздел"
                    : undefined
                }
              >
                <Icon size={19} />
                <span>{label}</span>
                {index === 0 && screen === "overview" && (
                  <b className="dp-nav-pin" />
                )}
              </button>
            ))}
          </nav>
          <div className="dp-side-foot">
            <span className="dp-avatar">К</span>
            <div>
              <b>Кирилл</b>
              <small>Управление</small>
            </div>
            <span className="dp-online" title="Локальный просмотр" />
          </div>
        </aside>

        <main className="dp-main">
          <header className="dp-header">
            <div>
              <span className="dp-eyebrow">
                RITM CONTROL <span>/</span>{" "}
                {screen === "overview" ? "ОБЗОР" : "ПОСТАВКИ"}
              </span>
              <h1>
                {screen === "overview" ? "Обзор производства" : "Поставки"}
              </h1>
              <p>
                {screen === "overview"
                  ? "Состояние производства и поставок на одном экране"
                  : "Состав, выпуск и готовность к отгрузке"}
              </p>
            </div>
            <div className="dp-header-actions">
              <span
                className={`dp-source-state ${loading ? "loading" : error && !live ? "error" : live ? "ready" : "waiting"}`}
              >
                <i />
                {loading
                  ? "Обновляю данные"
                  : error && !live
                    ? "Источник недоступен"
                    : live
                      ? "Рабочие данные"
                      : "Ожидаю данные"}
              </span>
              <button
                className="dp-refresh"
                onClick={onRefresh}
                disabled={loading}
                aria-label="Обновить данные"
              >
                <ArrowsClockwise size={17} /> Обновить
              </button>
            </div>
          </header>

          <div
            className="dp-screen-switch"
            role="group"
            aria-label="Экраны предпросмотра"
          >
            <span>КОНЦЕПЦИЯ</span>
            <button
              className={screen === "overview" ? "selected" : ""}
              onClick={() => chooseScreen("overview")}
            >
              RITM · Обзор
            </button>
            <button
              className={screen === "ozon" ? "selected ozon" : ""}
              onClick={() => chooseScreen("ozon")}
            >
              Ozon · Поставка
            </button>
            <button
              className={screen === "wb" ? "selected wb" : ""}
              onClick={() => chooseScreen("wb")}
            >
              WB · Поставка
            </button>
          </div>

          {screen === "overview" ? (
            <>
              <section className="dp-overview-hero">
                <div className="dp-hero-copy">
                  <span className="dp-hero-kicker">
                    <span /> ПРОИЗВОДСТВЕННЫЙ ЦЕНТР
                  </span>
                  <h2>
                    Работа движется,
                    <br />
                    данные на виду.
                  </h2>
                  <p>
                    План, выпуск и состояние источников собраны в одном
                    спокойном рабочем пространстве.
                  </p>
                  <button onClick={() => chooseScreen("ozon")}>
                    Открыть поставки <span>↗</span>
                  </button>
                </div>
                <div className="dp-orbit-art" aria-hidden="true">
                  <div className="dp-orbit-ring ring-one" />
                  <div className="dp-orbit-ring ring-two" />
                  <div className="dp-art-core">
                    <span>R</span>
                    <i />
                    <b />
                  </div>
                  <div className="dp-art-node node-a">
                    <Printer size={18} />
                  </div>
                  <div className="dp-art-node node-b">
                    <Package size={18} />
                  </div>
                  <div className="dp-art-node node-c">
                    <Scissors size={18} />
                  </div>
                  <div className="dp-orbit-label">FLOW · LIVE</div>
                </div>
                <div className="dp-hero-bottom">
                  <span>Единая картина смены</span>
                  <span>
                    <i /> Источники без задержки обновления
                  </span>
                </div>
              </section>

              <section
                className="dp-stat-grid"
                aria-label="Показатели по доступным данным"
              >
                <Stat
                  icon={Truck}
                  label="Листы поставок"
                  value={live ? num(live.sheets.length) : "—"}
                  detail={
                    live ? "подключённые рабочие листы" : "ожидание источника"
                  }
                  accent="blue"
                />
                <Stat
                  icon={Package}
                  label="Позиций в плане"
                  value={live ? num(actualArticles) : "—"}
                  detail={
                    live ? "по загруженным листам" : "нет подтверждённых данных"
                  }
                  accent="teal"
                />
                <Stat
                  icon={ChartBar}
                  label="План, шт."
                  value={live ? num(actualPlan) : "—"}
                  detail={
                    live
                      ? "сумма по активным позициям"
                      : "нет подтверждённых данных"
                  }
                  accent="violet"
                />
                <Stat
                  icon={Printer}
                  label="Площадь выпуска"
                  value={
                    printingArea === null ? "—" : `${num(printingArea, 1)} м²`
                  }
                  detail={
                    printingArea === null
                      ? "нет подтверждённого выпуска"
                      : "за выбранный период"
                  }
                  accent="amber"
                />
              </section>

              <section className="dp-workflow panelish">
                <div className="dp-section-heading">
                  <div>
                    <span className="dp-eyebrow">ПО ЭТАПАМ</span>
                    <h2>Готовность производства</h2>
                  </div>
                  <small>Показатели из подключённых источников</small>
                </div>
                <div className="dp-stage-row">
                  <Stage
                    icon={Printer}
                    title="Печать"
                    value={
                      printingArea === null
                        ? "Нет данных"
                        : `${num(printingArea, 1)} м²`
                    }
                    state={printingArea === null ? "unknown" : "known"}
                  />
                  <Stage
                    icon={Scissors}
                    title="Резка"
                    value={live ? "Данные в таблице поставки" : "Нет данных"}
                    state={live ? "known" : "unknown"}
                  />
                  <Stage
                    icon={Package}
                    title="Упаковка"
                    value={
                      live?.packing?.status === "available"
                        ? num(live.packing.eventCount) + " записей"
                        : "Нет подтверждённых данных"
                    }
                    state={
                      live?.packing?.status === "available"
                        ? "known"
                        : "unknown"
                    }
                  />
                  <Stage
                    icon={Truck}
                    title="Отправка"
                    value="Нет данных"
                    state="unknown"
                  />
                </div>
                <div className="dp-footnote">
                  <Users size={16} /> Сборщики с данными за период:{" "}
                  <b>{assemblyPeople === null ? "—" : num(assemblyPeople)}</b>
                </div>
              </section>

              <section className="dp-table-card panelish">
                <div className="dp-section-heading">
                  <div>
                    <span className="dp-eyebrow">ТЕКУЩИЙ СОСТАВ</span>
                    <h2>Поставки и выпуск</h2>
                  </div>
                  <button
                    className="dp-text-button"
                    onClick={() => chooseScreen("ozon")}
                  >
                    Смотреть поставку <span>→</span>
                  </button>
                </div>
                {live && supplies.length ? (
                  <SupplyTable rows={supplies.slice(0, 5)} />
                ) : (
                  <DataState loading={loading} error={error} hasData={!!live} />
                )}
              </section>
            </>
          ) : (
            <>
              <div className="dp-supply-layout">
                <aside className="dp-supply-rail panelish">
                  <div className="dp-rail-heading">
                    <div>
                      <span className="dp-eyebrow">ПОСТАВКИ</span>
                      <h2>Вкладки</h2>
                    </div>
                    <b>{choices.length}</b>
                  </div>
                  {choices.length ? (
                    choices.map((choice) => {
                      const key = `${choice.sourceId || ""}:${choice.sheetId}`;
                      return (
                        <button
                          key={key}
                          onClick={() => setSelectedKey(key)}
                          className={`dp-supply-choice ${selected && key === `${selected.sourceId || ""}:${selected.sheetId}` ? "active" : ""}`}
                        >
                          <span className={`dp-market-chip ${screen}`}>
                            {marketplace}
                          </span>
                          <strong>{choice.name}</strong>
                          <small>
                            {num(choice.orders)} позиций · {num(choice.plan)}{" "}
                            шт.
                          </small>
                        </button>
                      );
                    })
                  ) : loading ? (
                    <DataState loading error={error} hasData={!!live} />
                  ) : (
                    <div className="dp-data-state">
                      <Database size={17} />В подключённых листах нет поставки{" "}
                      {marketplace}
                    </div>
                  )}
                  <div className="dp-rail-note">
                    <CheckCircle size={15} /> Переключение не меняет данные
                  </div>
                </aside>

                <div className="dp-supply-content">
                  <ShipmentHero
                    marketplace={marketplace!}
                    title={selected?.name || `${marketplace} · поставка`}
                    department={
                      selected?.sourceId === "box-printing"
                        ? "Бокс"
                        : "Рулонная печать"
                    }
                    sourceHref={
                      selected
                        ? live?.sheets.find(
                            (s) =>
                              s.sheetId === selected.sheetId &&
                              (!selected.sourceId ||
                                s.sourceId === selected.sourceId),
                          )?.spreadsheetUrl
                        : undefined
                    }
                  >
                    <section className="dp-supply-stats panelish">
                      <Stat
                        label="Артикулов"
                        value={selected ? num(selected.orders) : "—"}
                        detail=""
                        accent="blue"
                      />
                      <Stat
                        label="План, шт."
                        value={selected ? num(selected.plan) : "—"}
                        detail=""
                        accent="teal"
                      />
                      <Stat
                        label="Площадь по плану"
                        value={
                          selected
                            ? selected.areaKnown ||
                              (selected.areaObservedOrders ?? 0) > 0
                              ? `${num(selected.plannedArea, 2)} м²`
                              : "Не определена"
                            : "—"
                        }
                        detail={
                          selected && (selected.areaMissingOrders ?? 0) > 0
                            ? `По ${num(selected.areaObservedOrders ?? 0)} из ${num(selected.orders)} · без площади: ${num(selected.areaMissingOrders ?? 0)}`
                            : selected && !selected.areaKnown
                              ? "нет подтверждённой площади"
                              : ""
                        }
                        accent="violet"
                      />
                      <Stat
                        label="Напечатано · Т/Х"
                        value={
                          selected
                            ? selected.quantity > 0
                              ? `${num(selected.quantity)} шт.`
                              : selected.printed == null
                                ? "Нет данных"
                                : `${num(selected.printed)} шт.`
                            : "—"
                        }
                        detail={
                          selected
                            ? selected.quantity > 0
                              ? `${num(selected.area, 1)} м² факт.`
                              : ""
                            : ""
                        }
                        accent="amber"
                      />
                      <Stat
                        label="Порезано · U"
                        value={
                          selected?.cut == null
                            ? "Нет данных"
                            : `${num(selected.cut)} шт.`
                        }
                        detail=""
                        accent="blue"
                      />
                    </section>
                  </ShipmentHero>

                  <section className="dp-workflow dp-supply-workflow panelish">
                    <div className="dp-section-heading">
                      <div>
                        <span className="dp-eyebrow">ТЕКУЩИЙ ЛИСТ</span>
                        <h2>Готовность производства</h2>
                      </div>
                      <span className="dp-neutral-note">
                        Состояние по подтверждённым фактам
                      </span>
                    </div>
                    <div className="dp-stage-row">
                      <Stage
                        icon={Printer}
                        title="Печать"
                        value={
                          !selected
                            ? "Нет данных"
                            : selected.quantity > 0
                              ? `${num(selected.quantity)} шт.`
                              : selected.printed == null
                                ? "Нет данных"
                                : `${num(selected.printed)} шт.`
                        }
                        state={
                          !selected ||
                          (selected.quantity === 0 && selected.printed == null)
                            ? "unknown"
                            : "known"
                        }
                        progress={
                          selected && selected.plan
                            ? (selected.quantity > 0
                                ? selected.quantity
                                : (selected.printed ?? 0)) / selected.plan
                            : null
                        }
                      />
                      <Stage
                        icon={Scissors}
                        title="Резка"
                        value={
                          selected?.cut == null
                            ? "Нет данных"
                            : `${num(selected.cut)} шт.`
                        }
                        state={selected?.cut == null ? "unknown" : "known"}
                      />
                      <Stage
                        icon={Package}
                        title="Упаковка"
                        value={
                          selected?.packed == null
                            ? "Нет данных"
                            : `${num(selected.packed)} шт.`
                        }
                        state={selected?.packed == null ? "unknown" : "known"}
                      />
                      <Stage
                        icon={Truck}
                        title="Отправка"
                        value="Нет данных"
                        state="unknown"
                      />
                    </div>
                  </section>

                  <section className="dp-table-card panelish">
                    <div className="dp-section-heading">
                      <div>
                        <span className="dp-eyebrow">АРТИКУЛЫ</span>
                        <h2>Состав поставки</h2>
                      </div>
                      <small>
                        {selected
                          ? `${num(actualOrders.length)} строк`
                          : "Нет доступных строк"}
                      </small>
                    </div>
                    {selected ? (
                      <ArticleTable
                        orders={actualOrders}
                        events={selectedPrintEvents}
                      />
                    ) : (
                      <DataState
                        loading={loading}
                        error={error}
                        hasData={!!live}
                      />
                    )}
                  </section>
                </div>
              </div>
            </>
          )}
          <footer className="dp-footer">
            <span>RITM CONTROL</span>
            <span>Данные показываются из текущего рабочего снимка</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  detail,
  accent,
}: {
  icon?: typeof Truck;
  label: string;
  value: string;
  detail: string;
  accent: string;
}) {
  return (
    <article className={`dp-stat ${accent}`}>
      <div className="dp-stat-top">
        {Icon && (
          <span>
            <Icon size={17} />
          </span>
        )}
        <small>{label}</small>
      </div>
      <strong>{value}</strong>
      <p>{detail || " "}</p>
    </article>
  );
}

function Stage({
  icon: Icon,
  title,
  value,
  state,
  progress,
}: {
  icon: typeof Truck;
  title: string;
  value: string;
  state: "known" | "unknown";
  progress?: number | null;
}) {
  return (
    <article className={`dp-stage ${state}`}>
      <span className="dp-stage-icon">
        <Icon size={18} />
      </span>
      <div>
        <b>{title}</b>
        <span className="dp-stage-value">{value}</span>
        {progress !== undefined && progress !== null && (
          <div className="dp-progress">
            <i
              style={{
                width: `${Math.min(100, Math.max(0, progress * 100))}%`,
              }}
            />
          </div>
        )}
      </div>
      {state === "unknown" && (
        <Warning size={14} className="dp-stage-warning" />
      )}
    </article>
  );
}

function DataState({
  loading,
  error,
  hasData,
}: {
  loading: boolean;
  error: string;
  hasData: boolean;
}) {
  return (
    <div className="dp-data-state">
      {loading ? (
        <>
          <span className="dp-loader" />
          Загружаю рабочие данные…
        </>
      ) : error && !hasData ? (
        <>
          <Warning size={17} />
          Источник временно недоступен
        </>
      ) : (
        <>
          <Database size={17} />
          Нет подходящих позиций в текущем снимке
        </>
      )}
    </div>
  );
}

function SupplyTable({ rows }: { rows: SupplySummary[] }) {
  return (
    <div className="dp-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Поставка</th>
            <th>Артикулов</th>
            <th>План</th>
            <th>Напечатано</th>
            <th>Площадь</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.sourceId || ""}:${row.sheetId}`}>
              <td>
                <b>{row.name}</b>
                <small>{supplyMarketplace(row.name) || "RITM"}</small>
              </td>
              <td>{num(row.orders)}</td>
              <td>{num(row.plan)} шт.</td>
              <td>
                {row.quantity > 0
                  ? `${num(row.quantity)} шт.`
                  : row.printed == null
                    ? "—"
                    : `${num(row.printed)} шт.`}
              </td>
              <td>
                {row.areaKnown || (row.areaObservedOrders ?? 0) > 0
                  ? `${num(row.plannedArea, 2)} м²`
                  : "Не определена"}
                {(row.areaMissingOrders ?? 0) > 0 && (
                  <small>Без площади: {num(row.areaMissingOrders ?? 0)}</small>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArticleTable({
  orders,
  events,
}: {
  orders: LivePrinting["supplies"];
  events: LivePrinting["events"];
}) {
  return orders.length ? (
    <div className="dp-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Артикул</th>
            <th>План, шт.</th>
            <th>План, м²</th>
            <th>Напечатано</th>
            <th>Порезано</th>
            <th>Упаковано</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((row) => {
            const facts = events.filter(
              (event) => event.article === row.article,
            );
            const printed = facts.length
              ? facts.reduce((sum, event) => sum + event.quantity, 0)
              : rollPrinted(row);
            return (
              <tr key={row.uid}>
                <td>
                  <b>{row.article}</b>
                </td>
                <td>{num(row.quantity)}</td>
                <td>
                  {row.areaKnown === false
                    ? "—"
                    : `${num(row.plannedArea, 2)} м²`}
                </td>
                <td>{printed === null ? "—" : `${num(printed)} шт.`}</td>
                <td>
                  {row.cutProgress == null
                    ? "—"
                    : `${num(row.cutProgress)} шт.`}
                </td>
                <td>{row.packed == null ? "—" : `${num(row.packed)} шт.`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="dp-data-state">
      <Database size={17} />В этом листе нет строк состава
    </div>
  );
}
