import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarBlank,
  ChartBar,
  Package,
  Printer,
  Scissors,
  X,
} from "./icons";
import type { AssemblyDaily } from "./liveAssembly";
import type { Employee } from "./model";
import { fullDate, num, shortDate } from "./model";

type ProfilePeriod = "week" | "month" | "quarter" | "year";
const PERIODS: { id: ProfilePeriod; label: string }[] = [
  { id: "week", label: "7 дней" },
  { id: "month", label: "Месяц" },
  { id: "quarter", label: "3 месяца" },
  { id: "year", label: "Год" },
];

function utcDate(value: string) {
  return new Date(value + "T12:00:00Z");
}
function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}
function periodStart(value: string, period: ProfilePeriod) {
  const date = utcDate(value);
  if (period === "year")
    return dateKey(new Date(Date.UTC(date.getUTCFullYear(), 0, 1, 12)));
  if (period === "month")
    return dateKey(
      new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 12)),
    );
  if (period === "quarter")
    return dateKey(
      new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 2, 1, 12)),
    );
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayOffset);
  return dateKey(date);
}
function shiftMonth(value: string, delta: number) {
  const date = utcDate(value);
  const targetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1, 12),
  );
  const lastDay = new Date(
    Date.UTC(
      targetMonth.getUTCFullYear(),
      targetMonth.getUTCMonth() + 1,
      0,
      12,
    ),
  ).getUTCDate();
  targetMonth.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return dateKey(targetMonth);
}
function monthTitle(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(utcDate(value));
}
function monthCells(value: string) {
  const date = utcDate(value);
  const first = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 12),
  );
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(first);
    day.setUTCDate(first.getUTCDate() + index);
    return dateKey(day);
  });
}
function sumTypes(rows: { name: string; quantity: number }[][]) {
  const totals = new Map<string, { name: string; quantity: number }>();
  rows.flat().forEach((item) => {
    const key = item.name.toLocaleLowerCase("ru-RU");
    const existing = totals.get(key) || { name: item.name, quantity: 0 };
    existing.quantity += item.quantity;
    totals.set(key, existing);
  });
  return [...totals.values()].sort((a, b) => b.quantity - a.quantity);
}
function RangeButtons({
  value,
  onChange,
  label,
}: {
  value: ProfilePeriod;
  onChange: (next: ProfilePeriod) => void;
  label: string;
}) {
  return (
    <div className="employee-period-tabs" role="group" aria-label={label}>
      {PERIODS.map((period) => (
        <button
          key={period.id}
          type="button"
          aria-pressed={value === period.id}
          className={value === period.id ? "is-selected" : ""}
          onClick={() => onChange(period.id)}
        >
          {period.label}
        </button>
      ))}
    </div>
  );
}
function ProfileCalendar({
  selectedDate,
  month,
  values,
  unit,
  label,
  onSelect,
  onMonthChange,
}: {
  selectedDate: string;
  month: string;
  values: Map<string, number>;
  unit: string;
  label: string;
  onSelect: (date: string) => void;
  onMonthChange: (month: string) => void;
}) {
  const cells = monthCells(month);
  const monthPrefix = month.slice(0, 7);
  const maximum = Math.max(0, ...values.values());
  return (
    <section className="employee-calendar-card" aria-label={label}>
      <div className="employee-calendar-heading">
        <div>
          <span className="employee-section-kicker">КАЛЕНДАРЬ ВЫПУСКА</span>
          <h3>{monthTitle(month)}</h3>
        </div>
        <div className="employee-month-controls">
          <button
            type="button"
            aria-label="Предыдущий месяц"
            onClick={() => onMonthChange(shiftMonth(month, -1))}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            type="button"
            aria-label="Следующий месяц"
            onClick={() => onMonthChange(shiftMonth(month, 1))}
          >
            <ArrowRight size={17} />
          </button>
        </div>
      </div>
      <div className="employee-calendar-grid">
        {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => (
          <span className="employee-weekday" key={day}>
            {day}
          </span>
        ))}
        {cells.map((day) => {
          const value = values.get(day) || 0;
          const hasOutput = values.has(day);
          const formattedValue = unit === "шт." ? num(value) : num(value, 2);
          const intensity =
            hasOutput && maximum
              ? Math.min(4, Math.ceil((value / maximum) * 4))
              : 0;
          const inMonth = day.slice(0, 7) === monthPrefix;
          return (
            <button
              key={day}
              type="button"
              className={[
                "employee-calendar-day",
                inMonth ? "" : "is-outside",
                hasOutput ? "has-output intensity-" + intensity : "",
                selectedDate === day ? "is-selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label={
                fullDate(day) +
                (hasOutput
                  ? ", " + num(value, 2) + " " + unit
                  : ", нет записи в журнале")
              }
              aria-pressed={selectedDate === day}
              onClick={() => onSelect(day)}
            >
              <span>{utcDate(day).getUTCDate()}</span>
              {hasOutput && <small>{formattedValue}</small>}
            </button>
          );
        })}
      </div>
      <p className="employee-calendar-legend">
        Цветом отмечены даты с записью выпуска. Пустая дата не подтверждает
        отсутствие работы.
      </p>
    </section>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "",
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof ChartBar;
  tone?: string;
}) {
  return (
    <div className={"employee-metric " + tone}>
      <span className="employee-metric-icon">
        <Icon size={18} />
      </span>
      <span className="employee-metric-label">{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

export function AssemblyProfileDrawer({
  employee,
  selectedDate,
  history,
  loading,
  error,
  onClose,
}: {
  employee: string | null;
  selectedDate: string;
  history: AssemblyDaily[];
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  const [date, setDate] = useState(selectedDate);
  const [month, setMonth] = useState(selectedDate);
  const [period, setPeriod] = useState<ProfilePeriod>("month");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setDate(selectedDate);
    setMonth(selectedDate);
  }, [selectedDate]);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const ownHistory = useMemo(
    () => history.filter((row) => row.employee === employee),
    [history, employee],
  );
  const selectedRows = ownHistory.filter((row) => row.date === date);
  const periodRows = ownHistory.filter(
    (row) => row.date >= periodStart(date, period) && row.date <= date,
  );
  const activeDays = new Set(periodRows.map((row) => row.date)).size;
  const coefficient = periodRows.reduce((sum, row) => sum + row.coefficient, 0);
  const cut = periodRows.reduce((sum, row) => sum + row.cut, 0);
  const packed = periodRows.reduce((sum, row) => sum + row.packed, 0);
  const total = periodRows.reduce((sum, row) => sum + row.total, 0);
  const calendarValues = new Map<string, number>();
  ownHistory.forEach((row) => {
    calendarValues.set(
      row.date,
      (calendarValues.get(row.date) || 0) + row.total,
    );
  });
  const selectedCutTypes = sumTypes(selectedRows.map((row) => row.cutTypes));
  const selectedPackTypes = sumTypes(selectedRows.map((row) => row.packTypes));
  const hasSelectedOutput = selectedRows.length > 0;

  if (!employee) return null;
  return (
    <div
      className="employee-profile-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="employee-profile-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assembly-profile-title"
      >
        <header className="employee-profile-hero assembly-profile-hero">
          <button
            ref={closeRef}
            className="employee-profile-close"
            type="button"
            aria-label="Закрыть карточку"
            onClick={onClose}
          >
            <X size={20} />
          </button>
          <span className="employee-section-kicker">
            ПРОИЗВОДСТВЕННЫЙ ПРОФИЛЬ · FBO
          </span>
          <h2 id="assembly-profile-title">{employee}</h2>
          <p>Личная эффективность сборщика по журналу «Выпуск по дням»</p>
          <span className="employee-source-pill">
            <CalendarBlank size={15} /> Рабочая таблица подключена
          </span>
        </header>
        <div className="employee-profile-content">
          <div className="employee-profile-toolbar">
            <div>
              <span className="employee-section-kicker">ПЕРИОД ИТОГОВ</span>
              <p>По {fullDate(date)}</p>
            </div>
            <RangeButtons
              value={period}
              onChange={setPeriod}
              label="Период эффективности сборщика"
            />
          </div>
          <div className="employee-profile-metrics">
            <MetricCard
              label="Сумма кэфов"
              value={num(coefficient, 3)}
              detail={activeDays + " дн. с записями"}
              icon={ChartBar}
              tone="metric-primary"
            />
            <MetricCard
              label="Порезано"
              value={num(cut)}
              detail="штук за период"
              icon={Scissors}
            />
            <MetricCard
              label="Упаковано"
              value={num(packed)}
              detail="штук за период"
              icon={Package}
            />
            <MetricCard
              label="Всего"
              value={num(total)}
              detail="штук за период"
              icon={Package}
            />
          </div>
          <ProfileCalendar
            selectedDate={date}
            month={month}
            values={calendarValues}
            unit="шт."
            label="Календарь выпуска сборщика"
            onSelect={(next) => {
              setDate(next);
              setMonth(next);
            }}
            onMonthChange={setMonth}
          />
          <section className="employee-day-card">
            <div className="employee-calendar-heading">
              <div>
                <span className="employee-section-kicker">ВЫПУСК ЗА ДЕНЬ</span>
                <h3>{fullDate(date)}</h3>
              </div>
              {hasSelectedOutput && (
                <span className="employee-source-pill">Есть запись</span>
              )}
            </div>
            {loading && !history.length ? (
              <p className="employee-empty">Читаю журнал FBO…</p>
            ) : error && !history.length ? (
              <p className="employee-empty">
                Не удалось загрузить журнал. {error}
              </p>
            ) : !hasSelectedOutput ? (
              <p className="employee-empty">
                За эту дату в источнике нет записи. Это не означает, что
                сотрудник не работал.
              </p>
            ) : (
              <>
                <div className="employee-day-totals">
                  <div>
                    <span>Коэффициент за день</span>
                    <strong>
                      {num(
                        selectedRows.reduce(
                          (sum, row) => sum + row.coefficient,
                          0,
                        ),
                        3,
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Порезано</span>
                    <strong>
                      {num(selectedRows.reduce((sum, row) => sum + row.cut, 0))}{" "}
                      шт.
                    </strong>
                  </div>
                  <div>
                    <span>Упаковано</span>
                    <strong>
                      {num(
                        selectedRows.reduce((sum, row) => sum + row.packed, 0),
                      )}{" "}
                      шт.
                    </strong>
                  </div>
                </div>
                <div className="employee-work-types">
                  <div>
                    <h4>
                      <Scissors size={16} /> Порезка
                    </h4>
                    {selectedCutTypes.length ? (
                      selectedCutTypes.map((item) => (
                        <div className="employee-work-type" key={item.name}>
                          <span>{item.name}</span>
                          <strong>{num(item.quantity)} шт.</strong>
                        </div>
                      ))
                    ) : (
                      <p>Нет детализации по порезке</p>
                    )}
                  </div>
                  <div>
                    <h4>
                      <Package size={16} /> Упаковка
                    </h4>
                    {selectedPackTypes.length ? (
                      selectedPackTypes.map((item) => (
                        <div className="employee-work-type" key={item.name}>
                          <span>{item.name}</span>
                          <strong>{num(item.quantity)} шт.</strong>
                        </div>
                      ))
                    ) : (
                      <p>Нет детализации по упаковке</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
          <p className="employee-data-caption">
            Показаны исходные дневные записи FBO. Коэффициенты суммируются по
            выбранному периоду.
          </p>
        </div>
      </section>
    </div>
  );
}

export type PrinterRecord = {
  id: string;
  roll: string;
  date: string;
  article: string;
  quantity: number;
  area: number;
  supply: string;
};

export function PrinterProfilePage({
  employee,
  records,
  selectedDate,
  demo = false,
  onBack,
}: {
  employee: Employee;
  records: PrinterRecord[];
  selectedDate: string;
  demo?: boolean;
  onBack: () => void;
}) {
  const [date, setDate] = useState(selectedDate);
  const [month, setMonth] = useState(selectedDate);
  const [period, setPeriod] = useState<ProfilePeriod>("month");
  useEffect(() => setDate(selectedDate), [selectedDate]);

  const periodRecords = useMemo(() => {
    const start = periodStart(date, period);
    return records.filter((row) => row.date >= start && row.date <= date);
  }, [records, date, period]);
  const area = periodRecords.reduce((sum, row) => sum + row.area, 0);
  const activeDays = new Set(periodRecords.map((row) => row.date)).size;
  const dayAreas = new Map<string, number>();
  records.forEach((row) => {
    dayAreas.set(row.date, (dayAreas.get(row.date) || 0) + row.area);
  });
  const calendarValues = dayAreas;
  const selectedRecords = records
    .filter((row) => row.date === date)
    .sort((a, b) => a.article.localeCompare(b.article, "ru-RU"));
  const trend = Array.from({ length: 14 }, (_, index) => {
    const day = utcDate(date);
    day.setUTCDate(day.getUTCDate() - (13 - index));
    const key = dateKey(day);
    return { date: key, area: dayAreas.get(key) || 0 };
  });
  const maximumTrend = Math.max(0, ...trend.map((item) => item.area));
  const averagePerActiveDay = activeDays ? area / activeDays : 0;

  return (
    <section className="printer-profile-page">
      <div className="printer-profile-topline">
        <button
          type="button"
          className="button secondary printer-profile-back"
          onClick={onBack}
        >
          <ArrowLeft size={17} /> К списку печатников
        </button>
        <span className="employee-source-pill">
          {demo ? "Демонстрационные данные" : "Источник: журнал выпуска"}
        </span>
      </div>
      <div className="printer-profile-title">
        <div className="printer-profile-avatar">
          {employee.name.slice(0, 1)}
        </div>
        <div>
          <span className="employee-section-kicker">
            ЛИЧНАЯ ЭФФЕКТИВНОСТЬ · ПЕЧАТЬ
          </span>
          <h2>{employee.name}</h2>
          <p>
            {demo
              ? "Пример показателей"
              : "Фактическая площадь и выпуск по датам журнала"}
          </p>
        </div>
      </div>
      <div className="printer-profile-toolbar">
        <div>
          <span className="employee-section-kicker">ИТОГИ ЗА ПЕРИОД</span>
          <p>По {fullDate(date)}</p>
        </div>
        <RangeButtons
          value={period}
          onChange={setPeriod}
          label="Период эффективности печатника"
        />
      </div>
      <div className="employee-profile-metrics printer-profile-metrics">
        <MetricCard
          label="Напечатано"
          value={num(area, 2) + " м²"}
          detail="по площади из журнала"
          icon={Printer}
          tone="metric-primary"
        />
        <MetricCard
          label="Записей"
          value={num(periodRecords.length)}
          detail="строк выпуска за период"
          icon={Package}
        />
        <MetricCard
          label="Дней с выпуском"
          value={num(activeDays)}
          detail="есть запись в источнике"
          icon={CalendarBlank}
        />
        <MetricCard
          label="Среднее за день с записью"
          value={num(averagePerActiveDay, 2) + " м²"}
          detail="фактическая площадь"
          icon={ChartBar}
        />
      </div>
      <div className="printer-profile-grid">
        <ProfileCalendar
          selectedDate={date}
          month={month}
          values={calendarValues}
          unit="м²"
          label="Календарь печати"
          onSelect={(next) => {
            setDate(next);
            setMonth(next);
          }}
          onMonthChange={setMonth}
        />
        <section className="employee-calendar-card printer-trend-card">
          <div className="employee-calendar-heading">
            <div>
              <span className="employee-section-kicker">ПО ДНЯМ</span>
              <h3>Последние 14 дней</h3>
            </div>
            <span className="employee-source-pill">м²</span>
          </div>
          <div
            className="printer-trend-chart"
            role="img"
            aria-label="Площадь печати по каждому из последних 14 дней"
          >
            {trend.map((item) => (
              <div
                className="printer-trend-column"
                key={item.date}
                title={fullDate(item.date) + ": " + num(item.area, 2) + " м²"}
              >
                <div className="printer-trend-bar-wrap">
                  <span
                    className={
                      item.area
                        ? "printer-trend-bar has-area"
                        : "printer-trend-bar"
                    }
                    style={{
                      height:
                        (item.area && maximumTrend
                          ? Math.max(5, (item.area / maximumTrend) * 100)
                          : 3) + "%",
                    }}
                  />
                </div>
                <small>{utcDate(item.date).getUTCDate()}</small>
              </div>
            ))}
          </div>
          <p className="employee-calendar-legend">
            Высота столбца отражает сумму площадей уникальных записей журнала за
            день.
          </p>
        </section>
      </div>
      <section className="employee-journal-card">
        <div className="employee-calendar-heading">
          <div>
            <span className="employee-section-kicker">ЖУРНАЛ ВЫПУСКА</span>
            <h3>{fullDate(date)}</h3>
          </div>
          <strong className="employee-journal-total">
            {num(
              selectedRecords.reduce((sum, row) => sum + row.area, 0),
              2,
            )}{" "}
            м²
          </strong>
        </div>
        {selectedRecords.length ? (
          <div className="employee-journal-table-wrap">
            <table className="employee-journal-table">
              <thead>
                <tr>
                  <th>Поставка</th>
                  <th>Артикул</th>
                  <th>Рулон</th>
                  <th>Штук</th>
                  <th>Площадь</th>
                </tr>
              </thead>
              <tbody>
                {selectedRecords.map((row) => (
                  <tr key={row.id}>
                    <td>{row.supply || "—"}</td>
                    <td>
                      <strong>{row.article || "—"}</strong>
                    </td>
                    <td>{row.roll || "—"}</td>
                    <td>{num(row.quantity)}</td>
                    <td>
                      <strong>{num(row.area, 2)} м²</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="employee-empty">
            За эту дату в журнале нет записи о печати. Это не подтверждает
            отсутствие работы.
          </p>
        )}
        <p className="employee-data-caption">
          Используются дата производства и площадь из журнала выпуска. Пустые
          даты не трактуются как простой.
        </p>
      </section>
    </section>
  );
}
