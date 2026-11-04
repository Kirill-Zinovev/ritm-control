import { Fragment, useMemo, useState } from "react";
import { Package, CaretRight } from "./icons";
import { inPeriod, num, type Period } from "./model";
import type { BoxPrintingEvent, LivePrinting } from "./livePrinting";

const goodsNumber = (value: number) => num(value);
const boxDate = (value: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));

type DailyBoxRow = {
  key: string;
  date: string;
  employee: string;
  print: BoxPrintingEvent[];
  cut: BoxPrintingEvent[];
};

function groupByDayAndEmployee(
  events: BoxPrintingEvent[],
  cuts: BoxPrintingEvent[],
) {
  const grouped = new Map<string, DailyBoxRow>();
  for (const [operation, records] of [
    ["print", events],
    ["cut", cuts],
  ] as const) {
    for (const event of records) {
      const key = `${event.date}|${event.employee}`;
      const row = grouped.get(key) || {
        key,
        date: event.date,
        employee: event.employee,
        print: [],
        cut: [],
      };
      row[operation].push(event);
      grouped.set(key, row);
    }
  }
  return [...grouped.values()].sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      a.employee.localeCompare(b.employee, "ru"),
  );
}

function dailyTotals(rows: BoxPrintingEvent[]) {
  return {
    quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
    area: rows.reduce((sum, row) => sum + (row.area ?? 0), 0),
    missing: rows.filter((row) => row.area === null).length,
    sheets: rows.reduce((sum, row) => sum + (row.sheets ?? 0), 0),
    xeroxQuantity: rows
      .filter((row) => row.sheets !== null)
      .reduce((sum, row) => sum + row.quantity, 0),
  };
}

export function BoxPrintingStats({
  value,
  date,
  period,
  supplyFilter,
}: {
  value: LivePrinting | null;
  date: string;
  period: Period;
  supplyFilter: string;
}) {
  const [employee, setEmployee] = useState("");
  const [view, setView] = useState<"employees" | "days">("employees");
  const [expandedDaily, setExpandedDaily] = useState("");
  const [exceptionType, setExceptionType] = useState<
    "all" | "defect" | "surplus"
  >("all");
  const [query, setQuery] = useState("");
  const source = value?.boxPrinting;
  const inScope = (e: {
    date: string;
    sheetId: number;
    shipment: string;
    employee: string;
  }) =>
    !["евгений", "алексей"].includes(e.employee.trim().toLocaleLowerCase("ru-RU")) &&
    inPeriod(e.date, date, period) &&
    (supplyFilter === "all" ||
      supplyFilter === `box-printing::${e.sheetId}` ||
      supplyFilter === e.shipment);
  const events = useMemo(
    () => (source?.events || []).filter(inScope),
    [source?.events, date, period, supplyFilter],
  );
  const cutEvents = useMemo(
    () => (source?.cutEvents || []).filter(inScope),
    [source?.cutEvents, date, period, supplyFilter],
  );
  const people = [
    ...new Set([...events, ...cutEvents].map((e) => e.employee)),
  ].sort((a, b) => a.localeCompare(b, "ru"));
  const totals = (rows: BoxPrintingEvent[]) => ({
    area: rows.reduce((n, e) => n + (e.area ?? 0), 0),
    missing: rows.filter((e) => e.area === null).length,
    quantity: rows.reduce((n, e) => n + e.quantity, 0),
    xeroxQuantity: rows
      .filter((e) => e.sheets !== null)
      .reduce((n, e) => n + e.quantity, 0),
    sheets: rows.reduce((n, e) => n + (e.sheets ?? 0), 0),
  });
  const total = totals(events);
  const totalCut = totals(cutEvents);
  const dailyRows = useMemo(
    () => groupByDayAndEmployee(events, cutEvents),
    [events, cutEvents],
  );
  const exceptions = useMemo(
    () => (source?.exceptions || []).filter(inScope),
    [source?.exceptions, date, period, supplyFilter],
  );
  const filteredExceptions = exceptions
    .filter(
      (e) =>
        (exceptionType === "all" || exceptionType === e.kind) &&
        [e.article, e.shipment, e.employee, e.comment].some((v) =>
          v
            .toLocaleLowerCase("ru-RU")
            .includes(query.trim().toLocaleLowerCase("ru-RU")),
        ),
    )
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  return (
    <>
      <section
        className="panel printing-department printing-department--box"
        aria-label="Печать бокса"
      >
        <div className="printing-department-heading">
          <div className="printing-department-title">
            <span className="printing-department-icon">
              <Package size={30} />
            </span>
            <div>
              <h2>Бокс</h2>
              <p>
                Итоги по отображённым сотрудникам · отменённые записи исключены
              </p>
            </div>
          </div>
          {source?.status === "available" && (
            <div className="printing-kpis">
              {[
                ["Площадь печати", num(total.area, 2) + " м²"],
                ["Площадь порезки", num(totalCut.area, 2) + " м²"],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
        {source?.status !== "available" ? (
          <p role="status">
            {source?.reason || "Журнал бокса ещё не подключён к этому снимку."}
          </p>
        ) : (
          <>
            {(total.missing > 0 || totalCut.missing > 0) && (
              <p className="printing-area-warning">
                Площадь не подтверждена: печать — {total.missing} записей,
                порезка — {totalCut.missing}. Показаны подтверждённые значения.
              </p>
            )}
            <div
              className="box-view-tabs"
              role="tablist"
              aria-label="Отчёт бокса"
            >
              <button
                type="button"
                role="tab"
                aria-selected={view === "employees"}
                className={view === "employees" ? "is-active" : ""}
                onClick={() => setView("employees")}
              >
                По сотрудникам
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "days"}
                className={view === "days" ? "is-active" : ""}
                onClick={() => setView("days")}
              >
                По дням
              </button>
            </div>
            {view === "employees" ? (
              <>
                <p className="box-stat-explainer">
                  По каждому сотруднику за выбранный период. Нажмите на имя,
                  чтобы увидеть артикулы и комментарии.
                </p>
                <div className="table-wrap printing-employee-table box-summary-table">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Сотрудник</th>
                        <th scope="col">Печать</th>
                        <th scope="col">Порезка</th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map((name) => {
                        const rows = events.filter((e) => e.employee === name),
                          cuts = cutEvents.filter((e) => e.employee === name),
                          t = totals(rows),
                          cut = totals(cuts),
                          open = employee === name;
                        const operation = (
                          label: string,
                          records: BoxPrintingEvent[],
                          result: ReturnType<typeof totals>,
                        ) =>
                          records.length ? (
                            <div className="box-operation-summary">
                              <strong>
                                {result.missing === records.length
                                  ? "Площадь не определена"
                                  : `${num(result.area, 2)} м²`}
                              </strong>
                              <span>
                                {label}:{" "}
                                <b>{goodsNumber(result.quantity)} шт.</b>
                              </span>
                              {result.sheets > 0 && (
                                <span>
                                  Листов Xerox:{" "}
                                  <b>{num(result.sheets)} лист.</b>
                                </span>
                              )}
                              {result.missing > 0 &&
                                result.missing < records.length && (
                                  <small>
                                    Без площади: {result.missing} записей
                                  </small>
                                )}
                            </div>
                          ) : (
                            <span className="box-no-work">Нет записей</span>
                          );
                        return (
                          <Fragment key={name}>
                            <tr className={open ? "selected" : ""}>
                              <th scope="row">
                                <button
                                  className="printing-employee-toggle"
                                  aria-expanded={open}
                                  onClick={() => setEmployee(open ? "" : name)}
                                >
                                  <CaretRight
                                    size={18}
                                    style={{
                                      transform: open
                                        ? "rotate(90deg)"
                                        : undefined,
                                    }}
                                  />
                                  {name}
                                </button>
                              </th>
                              <td>{operation("Напечатано", rows, t)}</td>
                              <td>{operation("Порезано", cuts, cut)}</td>
                            </tr>
                            {open && (
                              <tr>
                                <td colSpan={3}>
                                  <div className="printing-work-detail">
                                    <h3>Работа сотрудника: {name}</h3>
                                    {rows.length > 0 && (
                                      <div className="table-wrap">
                                        <table>
                                          <thead>
                                            <tr>
                                              <th>Дата</th>
                                              <th>Поставка</th>
                                              <th>Артикул</th>
                                              <th>Напечатано, шт.</th>
                                              <th>Листы Xerox</th>
                                              <th>м²</th>
                                              <th>Комментарий</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {rows.map((e) => (
                                              <tr key={e.id}>
                                                <td>{e.date}</td>
                                                <td>{e.shipment}</td>
                                                <td>{e.article}</td>
                                                <td>
                                                  {goodsNumber(e.quantity)}
                                                </td>
                                                <td>
                                                  {e.sheets === null
                                                    ? "—"
                                                    : num(e.sheets)}
                                                </td>
                                                <td>
                                                  {e.area === null
                                                    ? "Не определена"
                                                    : num(e.area, 2)}
                                                </td>
                                                <td className="box-exception-comment">
                                                  {e.comment?.trim() || "—"}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                    {cuts.length > 0 && (
                                      <div className="printing-cut-detail">
                                        <h3>Порезка</h3>
                                        <div className="table-wrap">
                                          <table>
                                            <thead>
                                              <tr>
                                                <th>Дата</th>
                                                <th>Поставка</th>
                                                <th>Артикул</th>
                                                <th>Порезано, шт.</th>
                                                <th>Листы Xerox</th>
                                                <th>Комментарий</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {cuts.map((e) => (
                                                <tr key={e.id}>
                                                  <td>{e.date}</td>
                                                  <td>{e.shipment}</td>
                                                  <td>{e.article}</td>
                                                  <td>
                                                    {goodsNumber(e.quantity)}
                                                  </td>
                                                  <td>
                                                    {e.sheets === null
                                                      ? "—"
                                                      : num(e.sheets)}
                                                  </td>
                                                  <td className="box-exception-comment">
                                                    {e.comment?.trim() || "—"}
                                                  </td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {[...events, ...cutEvents].some(
                  (e) => !Number.isInteger(e.quantity),
                ) && (
                  <p className="box-stat-footnote">
                    Количество товаров округлено до целых. Площадь рассчитана по
                    точным данным.
                  </p>
                )}
                {!events.length && !cutEvents.length && (
                  <p>
                    Нет подтверждённых записей печати или порезки бокса за
                    выбранный период.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="box-stat-explainer">
                  Итоги каждого сотрудника за день. Выберите период вверху
                  страницы; раскройте день, чтобы увидеть артикулы и
                  комментарии.
                </p>
                {dailyRows.length ? (
                  <div className="table-wrap box-daily-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Дата</th>
                          <th>Сотрудник</th>
                          <th>Напечатано</th>
                          <th>Площадь печати</th>
                          <th>Листы Xerox · печать</th>
                          <th>Порезано</th>
                          <th>Площадь порезки</th>
                          <th>Листы Xerox · порезка</th>
                          <th>Детали</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dailyRows.map((row) => {
                          const printed = dailyTotals(row.print),
                            cut = dailyTotals(row.cut),
                            open = expandedDaily === row.key;
                          const areaText = (value: number, missing: number) =>
                            missing && value === 0
                              ? "Нет данных"
                              : `${num(value, 2)} м²`;
                          return (
                            <Fragment key={row.key}>
                              <tr>
                        <td>{boxDate(row.date)}</td>
                                <th scope="row">{row.employee}</th>
                                <td>
                                  {row.print.length
                                    ? `${goodsNumber(printed.quantity)} шт.`
                                    : "—"}
                                </td>
                                <td>
                                  {row.print.length
                                    ? areaText(printed.area, printed.missing)
                                    : "—"}
                                  {printed.missing > 0 && printed.area > 0 && (
                                    <small className="box-daily-missing">
                                      {" "}
                                      · без площади: {printed.missing}
                                    </small>
                                  )}
                                </td>
                                <td>
                                  {printed.sheets
                                    ? `${num(printed.sheets)} лист.`
                                    : "—"}
                                </td>
                                <td>
                                  {row.cut.length
                                    ? `${goodsNumber(cut.quantity)} шт.`
                                    : "—"}
                                </td>
                                <td>
                                  {row.cut.length
                                    ? areaText(cut.area, cut.missing)
                                    : "—"}
                                  {cut.missing > 0 && cut.area > 0 && (
                                    <small className="box-daily-missing">
                                      {" "}
                                      · без площади: {cut.missing}
                                    </small>
                                  )}
                                </td>
                                <td>
                                  {cut.sheets
                                    ? `${num(cut.sheets)} лист.`
                                    : "—"}
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    className="box-daily-expand"
                                    aria-expanded={open}
                                    onClick={() =>
                                      setExpandedDaily(open ? "" : row.key)
                                    }
                                  >
                                    <CaretRight
                                      size={15}
                                      style={{
                                        transform: open
                                          ? "rotate(90deg)"
                                          : undefined,
                                      }}
                                    />{" "}
                                    {row.print.length + row.cut.length} записей
                                  </button>
                                </td>
                              </tr>
                              {open && (
                                <tr className="box-daily-details">
                                  <td colSpan={9}>
                                    <div className="printing-work-detail">
                                      {row.print.length > 0 && (
                                        <>
                                          <h3>
                                            Печать · {row.employee} · {row.date}
                                          </h3>
                                          <div className="table-wrap">
                                            <table>
                                              <thead>
                                                <tr>
                                                  <th>Поставка</th>
                                                  <th>Артикул</th>
                                                  <th>Напечатано, шт.</th>
                                                  <th>Листы Xerox</th>
                                                  <th>м²</th>
                                                  <th>Комментарий</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {row.print.map((e) => (
                                                  <tr key={e.id}>
                                                    <td>{e.shipment}</td>
                                                    <td>{e.article}</td>
                                                    <td>
                                                      {goodsNumber(e.quantity)}
                                                    </td>
                                                    <td>
                                                      {e.sheets === null
                                                        ? "—"
                                                        : num(e.sheets)}
                                                    </td>
                                                    <td>
                                                      {e.area === null
                                                        ? "Не определена"
                                                        : num(e.area, 2)}
                                                    </td>
                                                    <td className="box-exception-comment">
                                                      {e.comment?.trim() || "—"}
                                                    </td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
                                        </>
                                      )}
                                      {row.cut.length > 0 && (
                                        <>
                                          <h3>
                                            Порезка · {row.employee} ·{" "}
                                            {row.date}
                                          </h3>
                                          <div className="table-wrap">
                                            <table>
                                              <thead>
                                                <tr>
                                                  <th>Поставка</th>
                                                  <th>Артикул</th>
                                                  <th>Порезано, шт.</th>
                                                  <th>Листы Xerox</th>
                                                  <th>м²</th>
                                                  <th>Комментарий</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {row.cut.map((e) => (
                                                  <tr key={e.id}>
                                                    <td>{e.shipment}</td>
                                                    <td>{e.article}</td>
                                                    <td>
                                                      {goodsNumber(e.quantity)}
                                                    </td>
                                                    <td>
                                                      {e.sheets === null
                                                        ? "—"
                                                        : num(e.sheets)}
                                                    </td>
                                                    <td>
                                                      {e.area === null
                                                        ? "Не определена"
                                                        : num(e.area, 2)}
                                                    </td>
                                                    <td className="box-exception-comment">
                                                      {e.comment?.trim() || "—"}
                                                    </td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>
                    Нет подтверждённых записей печати или порезки бокса за
                    выбранный период.
                  </p>
                )}
                {[...events, ...cutEvents].some(
                  (e) => !Number.isInteger(e.quantity),
                ) && (
                  <p className="box-stat-footnote">
                    Количество товаров округлено до целых. Площадь рассчитана по
                    точным данным.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </section>
      <section
        className="panel box-exceptions"
        aria-label="Брак и излишки по артикулам"
      >
        <div className="box-exceptions-heading">
          <h2>Брак и излишки по артикулам</h2>
          <p>Записи сотрудников · отменённые записи исключены</p>
        </div>
        {source?.status !== "available" ? (
          <p role="status">
            {source?.reason || "Журнал бокса ещё не подключён."}
          </p>
        ) : source.exceptions === undefined ? (
          <p role="status">
            Данные о браке и излишках пока недоступны. Обновите источник данных.
          </p>
        ) : (
          <>
            <div className="box-exceptions-controls">
              <div className="box-exceptions-filters" aria-label="Тип записи">
                {(
                  [
                    ["all", "Все"],
                    ["defect", "Брак"],
                    ["surplus", "Излишки"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={exceptionType === id}
                    onClick={() => setExceptionType(id)}
                  >
                    {label} (
                    {id === "all"
                      ? exceptions.length
                      : exceptions.filter((e) => e.kind === id).length}
                    )
                  </button>
                ))}
              </div>
              <label className="box-exceptions-search">
                <span className="sr-only">Поиск по журналу</span>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Поиск по артикулу, поставке или сотруднику"
                />
              </label>
            </div>
            {filteredExceptions.length ? (
              <div className="table-wrap box-exceptions-table">
                <table>
                  <thead>
                    <tr>
                      <th>Дата и время</th>
                      <th>Артикул</th>
                      <th>Поставка</th>
                      <th>Сотрудник</th>
                      <th>Тип</th>
                      <th>Количество</th>
                      <th>Комментарий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredExceptions.map((e) => (
                      <tr key={e.id}>
                        <td>
                          {new Intl.DateTimeFormat("ru-RU", {
                            timeZone: "Europe/Moscow",
                            day: "2-digit",
                            month: "2-digit",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          }).format(new Date(e.timestamp))}
                        </td>
                        <td>
                          <strong>{e.article || "—"}</strong>
                        </td>
                        <td>{e.shipment || "—"}</td>
                        <td>{e.employee || "—"}</td>
                        <td>
                          <span className={"box-exception-badge is-" + e.kind}>
                            {e.kind === "defect" ? "Брак" : "Излишек"}
                          </span>
                          {e.stage && (
                            <small className="box-exception-stage">
                              {e.stage}
                            </small>
                          )}
                        </td>
                        <td>
                          {num(e.quantity)}{" "}
                          {e.unit === "sheets"
                            ? "лист."
                            : e.unit === "pieces"
                              ? "шт."
                              : "(ед. не указана)"}
                        </td>
                        <td className="box-exception-comment">
                          {e.comment || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="box-exceptions-empty">
                {exceptions.length
                  ? "По выбранному фильтру записей нет."
                  : "За выбранный период записей о браке и излишках нет."}
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}
