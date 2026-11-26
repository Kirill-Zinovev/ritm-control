import { useMemo, useState } from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  Clock3,
  Cube,
  DownloadSimple,
  MagnifyingGlass,
  Printer,
  Scissors,
  Truck,
  Warning,
} from "./icons";
import type { LivePrinting } from "./livePrinting";
import { num } from "./model";
import type { DispatchControlRow, DispatchStage } from "./dispatchControlData";
import { useDispatchControl } from "./useDispatchControl";
import "./dispatchControl.css";

const all = "";
const pageSize = 40;
const stages = {
  planned: {
    label: "Ожидает печати",
    detail: "Ожидает печати",
    Icon: Clock3,
    order: 0,
  },
  print: { label: "Печать", detail: "На печати", Icon: Printer, order: 1 },
  cut: { label: "Порезка", detail: "На порезке", Icon: Scissors, order: 2 },
  pack: { label: "Упаковка", detail: "На упаковке", Icon: Cube, order: 3 },
  ready: {
    label: "Отправка",
    detail: "К отправке",
    Icon: Truck,
    order: 4,
  },
} satisfies Record<
  DispatchStage,
  { label: string; detail: string; Icon: typeof Printer; order: number }
>;
const stageKeys = Object.keys(stages) as DispatchStage[];

const moscowTime = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});
const normalize = (value: string) =>
  value.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
const compare = (left: string, right: string) =>
  left.localeCompare(right, "ru-RU", { numeric: true });
const count = (value: number, forms: [string, string, string]) =>
  `${num(value)} ${forms[value % 100 >= 11 && value % 100 <= 14 ? 2 : value % 10 === 1 ? 0 : value % 10 >= 2 && value % 10 <= 4 ? 1 : 2]}`;
const quantityLabel = (value: number) => `${num(value)} шт.`;
const storeLabel = (store: string) =>
  /^\d+$/.test(store) ? `Магазин ${store}` : store || "Магазин не подтверждён";

function options(values: Iterable<readonly [string, string]>, current: string) {
  const available = new Map(values);
  if (current !== all && !available.has(current))
    available.set(current, current);
  return [...available]
    .filter(([value]) => value !== all)
    .sort((a, b) => compare(a[1], b[1]));
}

function initialSupplyFilter(selection: string) {
  if (selection === "all") return all;
  const sheet = /^sheet:(roll|box)-printing:(\d+)$/.exec(selection);
  return sheet
    ? `RITM-${sheet[1].toUpperCase()}-${sheet[2]}`
    : selection.replace(/^shipment:/, "");
}

function stageAmounts(row: DispatchControlRow) {
  return {
    planned: row.plannedQty,
    print: row.printQty,
    cut: row.cutQty,
    pack: row.packQty,
    ready: row.readyQty,
  };
}

function stageMatches(row: DispatchControlRow, stage: DispatchStage | "") {
  return stage === all || row.stage === stage || stageAmounts(row)[stage] > 0;
}

function StageCell({ row }: { row: DispatchControlRow }) {
  if (!row.stage) return <span aria-label="Нет данных об этапе">—</span>;
  const { Icon, label } = stages[row.stage];
  const quantities = stageAmounts(row);
  const parts = stageKeys.filter((stage) => quantities[stage] > 0);
  return (
    <div className="dispatch-control-stage-cell">
      <span className={`dispatch-control-stage is-${row.stage}`}>
        <Icon size={15} aria-hidden="true" />
        {label}
      </span>
      {parts.length > 1 ? (
        <small>
          {parts
            .map(
              (stage) =>
                `${stages[stage].detail} ${quantityLabel(quantities[stage])}`,
            )
            .join(" · ")}
        </small>
      ) : (
        row.stage === "ready" && <small>Готово к отправке</small>
      )}
    </div>
  );
}

function DispatchMetric({ label, amount }: { label: string; amount: string }) {
  return (
    <div className="dispatch-control-metric">
      <dt>{label}</dt>
      <dd>{amount}</dd>
    </div>
  );
}

async function exportExcel(
  rows: DispatchControlRow[],
  snapshot: { direction: string; checked: string; stale: boolean },
) {
  const [{ default: ExcelJS }, { downloadWorkbook }] = await Promise.all([
    import("exceljs"),
    import("./warehouseExcel"),
  ]);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "РИТМ";
  const sheet = workbook.addWorksheet("Неотправленные артикулы", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: "Артикул", key: "article", width: 21 },
    { header: "Направление", key: "direction", width: 22 },
    { header: "Поставка", key: "supply", width: 38 },
    { header: "Магазин", key: "store", width: 22 },
    { header: "План, шт.", key: "plan", width: 15 },
    { header: "Отправлено, шт.", key: "sent", width: 21 },
    { header: "Осталось, шт.", key: "remaining", width: 18 },
    { header: "Этап", key: "stage", width: 24 },
    { header: "Где сейчас", key: "location", width: 40 },
    { header: "Короба и количество", key: "cartons", width: 43 },
    { header: "В работе, шт.", key: "work", width: 18 },
    { header: "Ожидает печати, шт.", key: "planned", width: 24 },
    { header: "На печати, шт.", key: "print", width: 18 },
    { header: "На порезке, шт.", key: "cut", width: 18 },
    { header: "На упаковке, шт.", key: "pack", width: 18 },
    { header: "К отправке, шт.", key: "ready", width: 22 },
    { header: "Примечание", key: "note", width: 45 },
    { header: "Обновлено (МСК)", key: "checked", width: 22 },
  ];
  for (const row of rows) {
    sheet.addRow({
      article: row.article,
      direction: row.direction,
      supply: row.supplyName,
      store: storeLabel(row.store),
      plan: row.plan,
      sent: row.sent,
      remaining: row.remaining,
      stage: row.stage ? stages[row.stage].label : null,
      location: row.location || "Место не подтверждено",
      cartons: row.cartons
        .map((carton) => `${carton.label} — ${quantityLabel(carton.quantity)}`)
        .join("; "),
      work: row.remaining === null ? null : row.workQty,
      planned: row.remaining === null ? null : row.plannedQty,
      print: row.remaining === null ? null : row.printQty,
      cut: row.remaining === null ? null : row.cutQty,
      pack: row.remaining === null ? null : row.packQty,
      ready: row.remaining === null ? null : row.readyQty,
      note: [
        row.issue || (row.remaining === null ? "Нет данных об остатке." : ""),
        snapshot.stale ? "Данные могли измениться после обновления." : "",
      ]
        .filter(Boolean)
        .join(" "),
      checked: snapshot.checked,
    });
  }
  sheet.getColumn("article").numFmt = "@";
  sheet.getRow(1).height = 26;
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF173252" },
    };
    cell.alignment = { vertical: "middle" };
  });
  for (const key of ["supply", "location", "cartons", "note"]) {
    sheet.getColumn(key).alignment = { vertical: "top", wrapText: true };
  }
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: sheet.rowCount, column: sheet.columnCount },
  };
  const direction = snapshot.direction.replace(/[<>:"/\\|?*]/g, "").trim();
  await downloadWorkbook(
    workbook,
    `РИТМ-неотправленные-${direction || "все-направления"}.xlsx`,
  );
}

export function DispatchControl({
  live,
  productionLoading,
  productionError,
  initialSupply,
}: {
  live: LivePrinting | null;
  productionLoading: boolean;
  productionError: string;
  initialSupply: string;
}) {
  const { rows, loading, error, updatedAt, stale, reload, historyUrl } =
    useDispatchControl(live);
  const [direction, setDirection] = useState(all);
  const [supply, setSupply] = useState(() =>
    initialSupplyFilter(initialSupply),
  );
  const [store, setStore] = useState(all);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<DispatchStage | "">(all);
  const [limit, setLimit] = useState(pageSize);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const forDirection = useMemo(
    () => rows.filter((row) => !direction || row.direction === direction),
    [rows, direction],
  );
  const forSupply = useMemo(
    () => forDirection.filter((row) => !supply || row.supplyId === supply),
    [forDirection, supply],
  );
  const visible = useMemo(() => {
    const search = normalize(query);
    return forSupply
      .filter(
        (row) =>
          row.remaining !== 0 &&
          (!store || row.store === store) &&
          stageMatches(row, stage) &&
          (!search ||
            normalize(
              `${row.article} ${row.cartons.map((carton) => carton.label).join(" ")}`,
            ).includes(search)),
      )
      .sort(
        (left, right) =>
          (left.stage ? stages[left.stage].order : stageKeys.length) -
            (right.stage ? stages[right.stage].order : stageKeys.length) ||
          (right.remaining ?? 0) - (left.remaining ?? 0) ||
          compare(left.article, right.article) ||
          compare(left.supplyName, right.supplyName),
      );
  }, [forSupply, query, stage, store]);
  const totals = visible.reduce(
    (values, row) => {
      if (row.remaining === null) {
        values.incomplete = true;
      } else {
        values.remaining += row.remaining;
        values.work += row.workQty;
        values.ready += row.readyQty;
        values.stageIncomplete ||= row.workQty + row.readyQty < row.remaining;
      }
      return values;
    },
    {
      remaining: 0,
      work: 0,
      ready: 0,
      incomplete: false,
      stageIncomplete: false,
    },
  );
  const checked =
    updatedAt && Number.isFinite(Date.parse(updatedAt))
      ? moscowTime.format(new Date(updatedAt))
      : "";
  const incomplete = totals.incomplete || !checked;
  const pending = productionLoading || loading;
  const warning = error || productionError;
  const hasPrevious = !!checked && (!!stale || !!warning || !!live?.stale);
  const label = (value: number, partial = incomplete) =>
    partial
      ? value
        ? `≥ ${quantityLabel(value)}`
        : "—"
      : quantityLabel(value);

  async function download() {
    if (!visible.length || !checked || exporting) return;
    setExporting(true);
    setExportError("");
    try {
      await exportExcel(visible, { direction, checked, stale: hasPrevious });
    } catch {
      setExportError("Не удалось скачать Excel. Попробуйте ещё раз.");
    } finally {
      setExporting(false);
    }
  }

  function resetFilters() {
    setDirection(all);
    setSupply(all);
    setStore(all);
    setQuery("");
    setStage(all);
    setLimit(pageSize);
  }

  return (
    <section className="dispatch-control" aria-label="Контроль отгрузки">
      <div
        className="dispatch-control-filters"
        role="group"
        aria-label="Фильтры по поставкам"
      >
        <select
          aria-label="Направление"
          value={direction}
          onChange={(event) => {
            setDirection(event.target.value);
            setSupply(all);
            setStore(all);
            setLimit(pageSize);
          }}
        >
          <option value={all}>Все направления</option>
          {options(
            rows.map((row) => [row.direction, row.direction]),
            direction,
          ).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Поставка"
          value={supply}
          onChange={(event) => {
            setSupply(event.target.value);
            setStore(all);
            setLimit(pageSize);
          }}
        >
          <option value={all}>Все поставки</option>
          {options(
            forDirection.map((row) => [row.supplyId, row.supplyName]),
            supply,
          ).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Магазин"
          value={store}
          onChange={(event) => {
            setStore(event.target.value);
            setLimit(pageSize);
          }}
        >
          <option value={all}>Все магазины</option>
          {options(
            forSupply.map((row) => [row.store, storeLabel(row.store)]),
            store,
          ).map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
        <div className="dispatch-control-export">
          <button
            type="button"
            className="button primary dispatch-control-download"
            disabled={!visible.length || !checked || exporting}
            onClick={() => void download()}
          >
            <DownloadSimple size={19} aria-hidden="true" />
            <span>
              {exporting ? "Готовим файл…" : "Скачать Excel"}
              <small>По текущим фильтрам</small>
            </span>
          </button>
        </div>
      </div>
      {(warning || hasPrevious) && (
        <div className="production-alert" role="status">
          <Warning size={17} aria-hidden="true" />
          <span>{warning || "Показаны данные последнего обновления."}</span>
          {error && (
            <button
              type="button"
              className="button secondary"
              disabled={loading}
              onClick={reload}
            >
              Обновить
            </button>
          )}
        </div>
      )}
      {exportError && (
        <p className="production-alert" role="alert">
          {exportError}
        </p>
      )}
      <dl
        className="dispatch-control-summary"
        aria-label="Итоги отгрузки по текущим фильтрам"
      >
        <DispatchMetric
          label="Осталось отправить"
          amount={label(totals.remaining)}
        />
        <DispatchMetric
          label="В работе"
          amount={label(totals.work, incomplete || totals.stageIncomplete)}
        />
        <DispatchMetric
          label="Готово к отправке"
          amount={label(totals.ready, incomplete || totals.stageIncomplete)}
        />
        <div className="dispatch-control-source">
          <span>
            {pending
              ? "Загружаем данные РИТМ Сборки…"
              : checked
                ? `РИТМ Сборка · обновлено ${checked}`
                : "Отгрузка не подтверждена"}
            <button
              type="button"
              className="dispatch-control-refresh"
              aria-label="Обновить данные об отгрузке"
              title="Обновить данные об отгрузке"
              disabled={!live || loading}
              onClick={reload}
            >
              <ArrowsClockwise size={15} aria-hidden="true" />
            </button>
          </span>
        </div>
      </dl>
      <div className="dispatch-control-panel">
        <div className="dispatch-control-heading">
          <div className="dispatch-control-title">
            <h2>Не отправлено</h2>
            <span>
              {count(visible.length, ["позиция", "позиции", "позиций"])}
            </span>
          </div>
          <div
            className="dispatch-control-table-filters"
            role="group"
            aria-label="Фильтры по артикулам"
          >
            <label className="dispatch-control-search">
              <MagnifyingGlass size={17} aria-hidden="true" />
              <input
                type="search"
                aria-label="Найти артикул или короб"
                placeholder="Найти артикул или короб"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(pageSize);
                }}
              />
            </label>
            <select
              aria-label="Этап"
              value={stage}
              onChange={(event) => {
                setStage(event.target.value as DispatchStage | "");
                setLimit(pageSize);
              }}
            >
              <option value={all}>Все этапы</option>
              {Object.entries(stages).map(([value, item]) => (
                <option key={value} value={value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {visible.length ? (
          <div
            className="dispatch-control-scroll"
            role="region"
            aria-label="Таблица остатков к отгрузке"
            tabIndex={0}
          >
            <table className="dispatch-control-table">
              <thead>
                <tr>
                  <th scope="col">Артикул</th>
                  <th scope="col">Поставка</th>
                  <th scope="col">Отправлено / план</th>
                  <th scope="col">Осталось</th>
                  <th scope="col">Этап</th>
                  <th scope="col">Где сейчас</th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, limit).map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.article}</th>
                    <td>
                      {row.supplyName}
                      <small>{storeLabel(row.store)}</small>
                    </td>
                    <td className="dispatch-control-sent">
                      {row.sent === null ? "—" : num(row.sent)} /{" "}
                      {num(row.plan)}
                    </td>
                    <td className="dispatch-control-remaining">
                      {row.remaining === null ? (
                        <small>Нет данных</small>
                      ) : (
                        <strong>{quantityLabel(row.remaining)}</strong>
                      )}
                    </td>
                    <td>
                      <StageCell row={row} />
                    </td>
                    <td className="dispatch-control-location">
                      {row.location || "Место не подтверждено"}
                      {row.cartons.length > 0 && (
                        <small>
                          {row.cartons
                            .map(
                              (carton) =>
                                `${carton.label} · ${quantityLabel(carton.quantity)}`,
                            )
                            .join(", ")}
                        </small>
                      )}
                      {row.issue && row.issue !== row.location && (
                        <small>{row.issue}</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="dispatch-control-empty" role="status">
            <strong>
              {pending
                ? "Загружаем отгрузки…"
                : !checked
                  ? "Данные об отгрузке пока недоступны"
                  : "По этим фильтрам неотправленных позиций нет"}
            </strong>
            {checked && (direction || supply || store || query || stage) && (
              <button
                type="button"
                className="button secondary"
                onClick={resetFilters}
              >
                Сбросить фильтры
              </button>
            )}
          </div>
        )}
        <div className="dispatch-control-footer">
          <span>Данные об отгрузке · РИТМ Сборка</span>
          {visible.length > limit && (
            <button
              type="button"
              className="button secondary"
              onClick={() => setLimit((previous) => previous + pageSize)}
            >
              Показать ещё · {num(visible.length - limit)}
            </button>
          )}
          {historyUrl && (
            <a href={historyUrl} target="_blank" rel="noreferrer">
              История отгрузок <ArrowSquareOut size={15} aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
