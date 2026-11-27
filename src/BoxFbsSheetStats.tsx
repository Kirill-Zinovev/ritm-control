import { useId } from "react";
import type { BoxFbsSheetReport } from "./livePrinting";
import { fullDate, inPeriod, num, type Period } from "./model";

export function BoxFbsSheetStats({ report, date, period, loading, stale }: {
  report?: BoxFbsSheetReport;
  date: string;
  period: Period;
  loading: boolean;
  stale: boolean;
}) {
  const titleId = useId();
  const days = new Map<string, { print: number; cut: number }>();
  let printed = 0;
  let cut = 0;
  for (const row of report?.rows ?? []) {
    if (!inPeriod(row.date, date, period)) continue;
    const day = days.get(row.date) ?? { print: 0, cut: 0 };
    day.print += row.print;
    day.cut += row.cut;
    days.set(row.date, day);
    printed += row.print;
    cut += row.cut;
  }
  const entries = [...days].sort(([a], [b]) => b.localeCompare(a));
  const invalidRows = report?.invalidRows ?? [];
  const message = stale || report?.status === "stale" ? "Google Sheets пока не подтвердил обновление FBS."
    : report?.status === "missing" ? "Лист FBS не найден в таблице Бокса."
    : !report ? loading ? "Читаем лист FBS…" : "Данные FBS пока недоступны."
    : entries.length ? "" : "За выбранный период записей FBS нет.";

  return (
    <section className="box-fbs-sheets" aria-labelledby={titleId}>
      <div className="box-fbs-heading">
        <h3 id={titleId}>FBS листы</h3>
        {report?.url && <a href={report.url} target="_blank" rel="noreferrer">Открыть лист FBS</a>}
      </div>
      <dl className="box-fbs-totals" aria-label="Итоги FBS за выбранный период">
        <div><dt>Печать</dt><dd>{entries.length ? `${num(printed)} лист.` : "—"}</dd></div>
        <div><dt>Порезка (лазер)</dt><dd>{entries.length ? `${num(cut)} лист.` : "—"}</dd></div>
      </dl>
      {message && <p role="status">{message}</p>}
      {invalidRows.length > 0 && (
        <p role="status">
          Проверьте строки FBS {invalidRows.slice(0, 8).join(", ")}
          {invalidRows.length > 8 ? ` и ещё ${invalidRows.length - 8}` : ""}. Эти строки не вошли в итог.
        </p>
      )}
      {entries.length > 0 && (
        <div className="table-wrap printing-employee-table box-fbs-days">
          <table aria-label="Листы FBS по дням">
            <thead>
              <tr><th scope="col">Дата</th><th scope="col">Печать, л.</th><th scope="col">Порезка (лазер), л.</th></tr>
            </thead>
            <tbody>
              {entries.map(([day, total]) => (
                <tr key={day}>
                  <th scope="row"><time dateTime={day}>{fullDate(day)}</time></th>
                  <td>{num(total.print)}</td><td>{num(total.cut)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
