import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { sourceCoefficientSum, groupWorkEvents } from "./assemblyCoefficient";
import { AssemblyNormIssues, assemblyNormReason, missingAssemblyCoefficient } from "./AssemblyNormIssues";
import {
  Activity,
  ArrowDown,
  ArrowDownUp,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  CalendarDays,
  Clock3,
  ChevronDown,
  ChevronRight,
  Download,
  Hand,
  Package,
  RefreshCw,
  Scissors,
  Search,
  Users,
  X,
} from "lucide-react";
import type {
  AssemblyDaily,
  AssemblyDateRange,
  AssemblyEvent,
  AssemblySourceContribution,
  LiveAssembly,
} from "./liveAssembly";

type RangePreset = "today" | "week" | "month" | "custom";
type SortKey =
  | "employee"
  | "machineCut"
  | "manualCut"
  | "packed"
  | "coefficient"
  | "date";
type DetailTab = "summary" | "history" | "chart" | "norms";
type OperationFilter = "all" | "machine" | "manual" | "packing";

const teamColumns: {
  key: SortKey;
  label: string;
  Icon?: typeof Users;
  tone?: string;
}[] = [
  { key: "employee", label: "Сотрудник" },
  { key: "machineCut", label: "Резка на станке", Icon: Scissors, tone: "is-green" },
  { key: "manualCut", label: "Ручная резка", Icon: Hand, tone: "is-violet" },
  { key: "packed", label: "Упаковка", Icon: Package, tone: "is-indigo" },
  { key: "coefficient", label: "Общий кэф" },
  { key: "date", label: "Последняя работа" },
];

type Props = {
  value: LiveAssembly | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  assemblyOnly?: boolean;
  onRangeChange?: (range: AssemblyDateRange) => void;
};

type EmployeeStats = {
  employee: string;
  employeeId: string | null;
  identityKey: string;
  sourceKind: "fbo" | "assembly" | "both";
  sourceKinds: Array<"fbo" | "assembly">;
  mappingStatus: "confirmed" | "unmapped";
  reconciliationStatus: "clear" | "needs_review" | "unknown";
  coefficient: number | null;
  machineCut: number | null;
  manualCut: number | null;
  cut: number;
  packed: number;
  total: number | null;
  activeDays: number;
  date: string;
  lastUpdatedAt: string | null;
  days: AssemblyDaily[];
  events: AssemblyEvent[];
  cutTypes: { name: string; quantity: number }[];
  packTypes: { name: string; quantity: number }[];
  sourceContributions: AssemblySourceContribution[];
};

const integer = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});
const dayFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "UTC",
});
const fullDayFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function moscowToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function utcDate(value: string) {
  return new Date(`${value}T12:00:00Z`);
}
function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}
function ranges(preset: RangePreset, today: string, from: string, to: string) {
  if (preset === "custom") return { start: from, end: to };
  const end = utcDate(today);
  const start = new Date(end);
  if (preset === "week") {
    start.setUTCDate(start.getUTCDate() - 6);
  } else if (preset === "month") {
    start.setUTCDate(1);
  }
  return { start: dateKey(start), end: dateKey(end) };
}
function dayLabel(value: string) {
  return dayFormat.format(utcDate(value));
}
function moscowDateTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}
function dateTitle(value: string) {
  return fullDayFormat.format(utcDate(value));
}
function fmt(value: number | null, coefficientValue = false) {
  if (value === null || !Number.isFinite(value)) return "—";
  return coefficientValue ? decimal.format(value) : integer.format(value);
}
function countWithNoun(
  value: number,
  forms: [singular: string, few: string, many: string],
) {
  const lastTwo = Math.abs(value) % 100;
  const last = Math.abs(value) % 10;
  const form =
    lastTwo >= 11 && lastTwo <= 14
      ? forms[2]
      : last === 1
        ? forms[0]
        : last >= 2 && last <= 4
          ? forms[1]
          : forms[2];
  return `${fmt(value)} ${form}`;
}
function normalize(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU");
}
function productWords(value: string) {
  return normalize(value)
    .replace(/\s+л$/i, "")
    .split(/\s+/)
    .map((word) => word.replace(/[ыиа]$/, ""))
    .filter(Boolean);
}
function normMatchesProduct(normType: string, selectedType: string) {
  const normWords = productWords(normType);
  const selectedWords = productWords(selectedType);
  return (
    normWords.length > 0 &&
    normWords.length <= selectedWords.length &&
    normWords.every((word, index) => word === selectedWords[index])
  );
}
function addTypes(
  target: Map<string, { name: string; quantity: number }>,
  rows: AssemblyDaily["cutTypes"],
) {
  for (const row of rows) {
    const key = normalize(row.name);
    const existing = target.get(key) || { name: row.name, quantity: 0 };
    existing.quantity += row.quantity;
    target.set(key, existing);
  }
}
function hasType(row: AssemblyDaily, type: string) {
  if (!type) return true;
  const key = normalize(type);
  return [...row.cutTypes, ...row.packTypes].some(
    (item) => normalize(item.name) === key,
  );
}

function filterAssemblyDay(row: AssemblyDaily, productType: string): AssemblyDaily | null {
  const events = (row.events || []).filter(event => normalize(event.productType) === normalize(productType));
  const source = row.sourceContributions?.find(item => item.sourceKind === "assembly");
  if (!events.length || !source) return null;
  const machineCut = events.filter(event => event.operationId === "cut").reduce((sum, event) => sum + event.quantity, 0);
  const manualCut = events.filter(event => event.operationId === "assembly").reduce((sum, event) => sum + event.quantity, 0);
  const packed = events.filter(event => event.operationId === "packing").reduce((sum, event) => sum + event.quantity, 0);
  const cut = machineCut + manualCut;
  const totals = {
    machineCut, manualCut, packed, cut, total: cut + packed,
    coefficient: sourceCoefficientSum(events),
    cutTypes: cut ? [{ name: productType, quantity: cut }] : [],
    packTypes: packed ? [{ name: productType, quantity: packed }] : [],
  };
  return { ...row, ...totals, events, sourceContributions: [{ ...source, ...totals, recordCount: events.length }] };
}
function sumType(
  rows: AssemblyDaily[],
  type: string,
  key: "cutTypes" | "packTypes",
) {
  return rows.reduce(
    (sum, row) =>
      sum +
      row[key].reduce(
        (value, item) =>
          value +
          (!type || normalize(item.name) === normalize(type)
            ? item.quantity
            : 0),
        0,
      ),
    0,
  );
}
function rowHasWork(row: AssemblyDaily) {
  return (
    row.machineCut > 0 ||
    row.manualCut > 0 ||
    row.packed > 0 ||
    (row.coefficient ?? 0) > 0
  );
}
function identityOf(row: AssemblyDaily) {
  return (
    row.identityKey ||
    (row.employeeId ? `assembly:${row.employeeId}` : `fbo:${row.employee}`)
  );
}

function rowsForSource(rows: AssemblyDaily[], sourceKind: "fbo" | "assembly") {
  return rows.flatMap((row) => {
    const source = row.sourceContributions?.find(
      (item) => item.sourceKind === sourceKind,
    );
    if (!source) return [];
    return [
      {
        ...row,
        employee: source.employeeLabel,
        employeeId: source.employeeId,
        sourceKind,
        sourceKinds: [sourceKind],
        reconciliationStatus: source.reconciliationStatus,
        coefficient: source.coefficient,
        machineCut: source.machineCut,
        manualCut: source.manualCut,
        cut: source.cut,
        packed: source.packed,
        total: source.total,
        cutTypes: source.cutTypes,
        packTypes: source.packTypes,
        sourceContributions: [source],
        events: sourceKind === "assembly" ? row.events : [],
      },
    ];
  });
}

function sourceBadgeLabel(sourceKinds: Array<"fbo" | "assembly">) {
  if (sourceKinds.includes("fbo") && sourceKinds.includes("assembly"))
    return "FBO + RITM Сборка";
  return sourceKinds.includes("fbo") ? "FBO" : "RITM Сборка";
}

function sumSourceContributions(
  rows: AssemblyDaily[],
  sourceKind: "fbo" | "assembly" | "all",
  productType = "",
  approvedOnly = false,
) {
  const result = {
    machineCut: 0,
    manualCut: 0,
    packed: 0,
    total: 0,
    coefficient: 0,
    coefficientComplete: true,
    recordCount: 0,
  };
  rows.forEach((row) => {
    const contributions = row.sourceContributions || [];
    contributions.forEach((source) => {
      if (sourceKind !== "all" && source.sourceKind !== sourceKind) return;
      if (approvedOnly && source.reconciliationStatus !== "clear") return;
      const selectedType = productType ? normalize(productType) : "";
      const cut = selectedType
        ? source.cutTypes
            .filter((item) => normalize(item.name) === selectedType)
            .reduce((sum, item) => sum + item.quantity, 0)
        : source.cut;
      const packed = selectedType
        ? source.packTypes
            .filter((item) => normalize(item.name) === selectedType)
            .reduce((sum, item) => sum + item.quantity, 0)
        : source.packed;
      if (selectedType && cut + packed === 0) return;
      result.machineCut += selectedType ? 0 : source.machineCut;
      result.manualCut += selectedType ? 0 : source.manualCut;
      result.packed += packed;
      result.total += selectedType ? cut + packed : source.total;
      result.recordCount += source.recordCount;
      if (selectedType || source.coefficient === null)
        result.coefficientComplete = false;
      else result.coefficient += source.coefficient;
    });
  });
  return {
    machineCut: result.machineCut,
    manualCut: result.manualCut,
    packed: result.packed,
    total: result.total,
    coefficient: result.coefficientComplete ? result.coefficient : null,
    recordCount: result.recordCount,
  };
}

function aggregateEmployee(
  rows: AssemblyDaily[],
  identityKey: string,
  type: string,
): EmployeeStats {
  const days = rows
    .filter((row) => identityOf(row) === identityKey && hasType(row, type))
    .map((row) => ({
      ...row,
      coefficient: sourceCoefficientSum(
        row.sourceContributions,
        row.coefficient,
      ),
    }));
  const first = days[0];
  const cutTypes = new Map<string, { name: string; quantity: number }>();
  const packTypes = new Map<string, { name: string; quantity: number }>();
  days.forEach((row) => {
    addTypes(
      cutTypes,
      type
        ? row.cutTypes.filter(
            (item) => normalize(item.name) === normalize(type),
          )
        : row.cutTypes,
    );
    addTypes(
      packTypes,
      type
        ? row.packTypes.filter(
            (item) => normalize(item.name) === normalize(type),
          )
        : row.packTypes,
    );
  });
  const last = [...days].sort((a, b) => b.date.localeCompare(a.date))[0];
  const events = days
    .flatMap((row) => row.events || [])
    .filter(
      (event) => !type || normalize(event.productType) === normalize(type),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const sourceKinds = [
    ...new Set(
      days.flatMap(
        (day) =>
          day.sourceContributions?.map((source) => source.sourceKind) ||
          (day.sourceKind ? [day.sourceKind] : []),
      ),
    ),
  ] as Array<"fbo" | "assembly">;
  const sources = new Map<string, AssemblySourceContribution>();
  days.forEach((day) => {
    (day.sourceContributions || []).forEach((source) => {
      const key = source.sourceKind;
      const current = sources.get(key) || {
        ...source,
        coefficient: 0,
        machineCut: 0,
        manualCut: 0,
        cut: 0,
        packed: 0,
        total: 0,
        recordCount: 0,
        cutTypes: [],
        packTypes: [],
        reconciliationStatus: "clear" as const,
      };
      const isTypeSelected = !!type;
      const cutRows = isTypeSelected
        ? source.cutTypes.filter(
            (item) => normalize(item.name) === normalize(type),
          )
        : source.cutTypes;
      const packRows = isTypeSelected
        ? source.packTypes.filter(
            (item) => normalize(item.name) === normalize(type),
          )
        : source.packTypes;
      const addList = (
        target: { name: string; quantity: number }[],
        incoming: { name: string; quantity: number }[],
      ) => {
        const map = new Map(
          target.map((item) => [normalize(item.name), { ...item }]),
        );
        incoming.forEach((item) => {
          const found = map.get(normalize(item.name)) || {
            name: item.name,
            quantity: 0,
          };
          found.quantity += item.quantity;
          map.set(normalize(item.name), found);
        });
        return [...map.values()];
      };
      current.machineCut += isTypeSelected ? 0 : source.machineCut;
      current.manualCut += isTypeSelected ? 0 : source.manualCut;
      current.cut += isTypeSelected
        ? cutRows.reduce((sum, item) => sum + item.quantity, 0)
        : source.cut;
      current.packed += isTypeSelected
        ? packRows.reduce((sum, item) => sum + item.quantity, 0)
        : source.packed;
      current.total += isTypeSelected
        ? cutRows.reduce((sum, item) => sum + item.quantity, 0) +
          packRows.reduce((sum, item) => sum + item.quantity, 0)
        : source.total;
      current.recordCount += source.recordCount;
      current.cutTypes = addList(current.cutTypes, cutRows);
      current.packTypes = addList(current.packTypes, packRows);
      if (isTypeSelected || source.coefficient === null)
        current.coefficient = null;
      else if (current.coefficient !== null)
        current.coefficient += source.coefficient;
      if (source.reconciliationStatus !== "clear")
        current.reconciliationStatus = source.reconciliationStatus;
      sources.set(key, current);
    });
  });
  return {
    employee: first?.employee || "",
    employeeId: first?.employeeId || null,
    identityKey,
    sourceKind:
      sourceKinds.length > 1
        ? "both"
        : sourceKinds[0] || first?.sourceKind || "fbo",
    sourceKinds,
    mappingStatus:
      first?.mappingStatus || (first?.employeeId ? "confirmed" : "unmapped"),
    reconciliationStatus: days.some(
      (day) => day.reconciliationStatus !== "clear",
    )
      ? days.some((day) => day.reconciliationStatus === "unknown")
        ? "unknown"
        : "needs_review"
      : "clear",
    coefficient: type
      ? null
      : days.some((row) => row.coefficient === null)
        ? null
        : days.reduce((sum, row) => sum + (row.coefficient ?? 0), 0),
    machineCut: type
      ? null
      : days.reduce((sum, row) => sum + row.machineCut, 0),
    manualCut: type ? null : days.reduce((sum, row) => sum + row.manualCut, 0),
    cut: type
      ? sumType(days, type, "cutTypes")
      : days.reduce((sum, row) => sum + row.cut, 0),
    packed: type
      ? sumType(days, type, "packTypes")
      : days.reduce((sum, row) => sum + row.packed, 0),
    total: type ? null : days.reduce((sum, row) => sum + row.total, 0),
    activeDays: new Set(days.map((row) => row.date)).size,
    date: last?.date || "",
    lastUpdatedAt: last?.lastUpdatedAt || null,
    days,
    events,
    cutTypes: [...cutTypes.values()].sort((a, b) => b.quantity - a.quantity),
    packTypes: [...packTypes.values()].sort((a, b) => b.quantity - a.quantity),
    sourceContributions: [...sources.values()],
  };
}
function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}
function downloadCsv(
  rows: EmployeeStats[],
  range: { start: string; end: string },
) {
  const header = [
    "Сотрудник",
    "employeeId / источник",
    "Станочная резка, шт.",
    "Ручная резка, шт.",
    "Упаковка, шт.",
    "Сумма коэффициентов",
    "Активных дней",
    "Последняя дата",
  ];
  const lines = rows.map((row) =>
    [
      row.employee,
      row.employeeId || row.sourceKind,
      row.machineCut ?? "",
      row.manualCut ?? "",
      row.packed,
      row.coefficient ?? "",
      row.activeDays,
      row.date,
    ]
      .map(csvCell)
      .join(";"),
  );
  const blob = new Blob(
    ["\ufeff" + [header.map(csvCell).join(";"), ...lines].join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ritm-sborshchiki-${range.start}-${range.end}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
function operationValue(row: AssemblyDaily, operation: OperationFilter) {
  if (operation === "machine") return row.machineCut;
  if (operation === "manual") return row.manualCut;
  if (operation === "packing") return row.packed;
  return row.machineCut + row.manualCut + row.packed;
}
function eventMatchesOperation(event: AssemblyEvent, filter: OperationFilter) {
  if (filter === "all") return true;
  if (filter === "machine") return event.operationId === "cut";
  if (filter === "manual") return event.operationId === "assembly";
  return event.operationId === "packing";
}

function employeeInitials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/, 2)
      .map((part) => part[0])
      .join("")
      .toLocaleUpperCase("ru-RU") || "?"
  );
}

function Metric({
  label,
  value,
  note,
  tone,
  Icon,
}: {
  label: string;
  value: string;
  note?: string;
  tone: string;
  Icon: typeof Users;
}) {
  return (
    <div className={`assembly-kpi ${tone}`}>
      <span className="assembly-kpi-icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <span className="assembly-kpi-copy">
        <small>{label}</small>
        <strong>{value}</strong>
        {note && <em>{note}</em>}
      </span>
    </div>
  );
}

function DetailChart({
  stats,
  productType,
}: {
  stats: EmployeeStats;
  productType: string;
}) {
  const [metric, setMetric] = useState<"coefficient" | "quantity">(
    "coefficient",
  );
  const [operation, setOperation] = useState<OperationFilter>("packing");
  const labels = [
    ["all", "Все операции"],
    ["machine", "Станочная резка"],
    ["manual", "Ручная резка"],
    ["packing", "Упаковка"],
  ] as const;
  const chartRows = [...stats.days].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const values = chartRows.map((row) => {
    if (metric === "coefficient") return row.coefficient;
    if (!productType) return operationValue(row, operation);
    if (operation === "machine" || operation === "manual") return null;
    const cut = sumType([row], productType, "cutTypes");
    const packed = sumType([row], productType, "packTypes");
    return operation === "packing" ? packed : cut + packed;
  });
  const max = Math.max(
    0,
    ...values.filter((value): value is number => value !== null),
  );
  return (
    <div className="assembly-chart-view">
      <div className="assembly-chart-controls">
        <div
          className="assembly-tabs assembly-tabs-small"
          role="group"
          aria-label="Показатель графика"
        >
          <button
            className={metric === "coefficient" ? "is-active" : ""}
            onClick={() => setMetric("coefficient")}
          >
            Коэффициент
          </button>
          <button
            className={metric === "quantity" ? "is-active" : ""}
            onClick={() => setMetric("quantity")}
          >
            Штуки
          </button>
        </div>
        {metric === "quantity" && (
          <select
            aria-label="Операция графика"
            value={operation}
            onChange={(event) =>
              setOperation(event.target.value as OperationFilter)
            }
          >
            {labels.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        )}
      </div>
      {metric === "coefficient" && stats.coefficient === null ? (
        <div className="assembly-empty-inline">
          После фильтра по виду товара коэффициент нельзя разделить по видам в
          источнике.
        </div>
      ) : metric === "quantity" &&
        productType &&
        (operation === "machine" || operation === "manual") ? (
        <div className="assembly-empty-inline">
          FBO не связывает станочную и ручную резку с выбранным видом товара.
        </div>
      ) : !chartRows.length ? (
        <div className="assembly-empty-inline">
          Нет записей за выбранный период.
        </div>
      ) : (
        <div
          className="assembly-chart"
          role="img"
          aria-label={
            metric === "coefficient"
              ? "Коэффициент по дням"
              : "Количество штук по дням"
          }
        >
          {chartRows.map((row, index) => {
            const value = values[index];
            const height =
              value !== null && max ? Math.max(4, (value / max) * 100) : 4;
            return (
              <div
                className="assembly-chart-day"
                key={row.date}
                title={`${dateTitle(row.date)} · ${metric === "coefficient" ? fmt(value, true) + " кэф" : fmt(value) + " шт."}`}
              >
                <span
                  className={`assembly-chart-bar ${metric === "coefficient" ? "is-coefficient" : "is-quantity"}`}
                  style={{ height: `${height}%` }}
                />
                <small>{dayLabel(row.date)}</small>
              </div>
            );
          })}
        </div>
      )}
      <p className="assembly-detail-note">
        По дням из FBO «История производства». Нулевые и отсутствующие дни не
        добавляются в источник.
      </p>
    </div>
  );
}

function NormsTable({
  norms,
  productType,
}: {
  norms: LiveAssembly["norms"];
  productType: string;
}) {
  const visible = (norms?.rows || []).filter(
    (row) => !productType || normMatchesProduct(row.productType, productType),
  );
  if (!norms || norms.status !== "available") {
    return (
      <div className="assembly-empty-inline">
        {norms?.message || "Нормы из источника не загружены."}
      </div>
    );
  }
  if (!visible.length)
    return (
      <div className="assembly-empty-inline">
        Для выбранного вида подтверждённая норма не найдена.
      </div>
    );
  return (
    <>
      <div className="assembly-detail-table-scroll">
        <table className="assembly-detail-table">
          <thead>
            <tr>
              <th>Вид товара</th>
              <th>Операция</th>
              <th>Норма</th>
              <th>Единица</th>
              <th>Источник</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr key={`${row.sourceLabel}-${index}`}>
                <td>{row.productType}</td>
                <td>{row.operation}</td>
                <td>{fmt(row.norm)}</td>
                <td>{row.unit}</td>
                <td>FBO · «Нормы»</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="assembly-detail-note">
        Это текущие нормы из FBO. При фильтре вида сопоставляется название
        товарной группы; отдельного ID вида в листе нет. История операций не
        хранит применённую к каждому дневному итогу норму, поэтому исторические
        коэффициенты не пересчитываются.
      </p>
    </>
  );
}

export function AssemblyAnalytics({ value, loading, error, onRefresh, assemblyOnly = false, onRangeChange }: Props) {
  const today = moscowToday();
  const [preset, setPreset] = useState<RangePreset>("today");
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);
  const [productType, setProductType] = useState("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("coefficient");
  const [sortDescending, setSortDescending] = useState(true);
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [tab, setTab] = useState<DetailTab>("summary");
  const [operationFilter, setOperationFilter] =
    useState<OperationFilter>("all");
  const [historyLimit, setHistoryLimit] = useState(25);
  const viewHeading = useRef<HTMLHeadingElement>(null);
  const teamTable = useRef<HTMLTableElement>(null);
  const returnToEmployee = useRef("");
  const focusReport = useRef(false);
  const catalogOpened = useRef(false);
  useEffect(() => {
    function refreshOnReturn() {
      if (!catalogOpened.current || document.visibilityState !== "visible") return;
      catalogOpened.current = false;
      onRefresh();
    }
    window.addEventListener("focus", refreshOnReturn);
    return () => window.removeEventListener("focus", refreshOnReturn);
  }, [onRefresh]);
  const range = useMemo(
    () => ranges(preset, today, customStart, customEnd),
    [preset, today, customStart, customEnd],
  );
  useEffect(() => {
    if (assemblyOnly && range.start && range.end && range.start <= range.end) onRangeChange?.(range);
  }, [assemblyOnly, onRangeChange, range]);
  const aggregateType = assemblyOnly ? "" : productType;
  const history = value?.history || [];
  const productOptions = useMemo(() => {
    const items = new Map<string, string>();
    history.forEach((row) =>
      [...row.cutTypes, ...row.packTypes].forEach((type) =>
        items.set(normalize(type.name), type.name),
      ),
    );
    history.forEach((row) =>
      row.events?.forEach((event) => {
        if (event.productType)
          items.set(normalize(event.productType), event.productType);
      }),
    );
    return [...items.values()].sort((a, b) => a.localeCompare(b, "ru-RU"));
  }, [history]);
  const periodRows = useMemo(
    () =>
      history.filter(
        (row) =>
          row.date >= range.start && row.date <= range.end && rowHasWork(row),
      ).flatMap(row => {
        if (!assemblyOnly || !productType) return [row];
        const filtered = filterAssemblyDay(row, productType);
        return filtered ? [filtered] : [];
      }),
    [history, range.start, range.end, assemblyOnly, productType],
  );
  const team = useMemo(() => {
    const identities = new Set(
      periodRows.filter((row) => hasType(row, aggregateType)).map(identityOf),
    );
    return [...identities].map((identityKey) =>
      aggregateEmployee(periodRows, identityKey, aggregateType),
    );
  }, [periodRows, aggregateType]);
  const visibleTeam = useMemo(() => {
    const query = normalize(search);
    const rows = team.filter(
      (row) => !query || normalize(row.employee).includes(query),
    );
    const comparator = (a: EmployeeStats, b: EmployeeStats) => {
      if (sortKey === "employee")
        return a.employee.localeCompare(b.employee, "ru-RU");
      if (sortKey === "date") return a.date.localeCompare(b.date);
      const aValue =
        sortKey === "machineCut"
          ? a.machineCut
          : sortKey === "manualCut"
            ? a.manualCut
            : sortKey === "packed"
              ? a.packed
              : a.coefficient;
      const bValue =
        sortKey === "machineCut"
          ? b.machineCut
          : sortKey === "manualCut"
            ? b.manualCut
            : sortKey === "packed"
              ? b.packed
              : b.coefficient;
      return (aValue ?? -1) - (bValue ?? -1);
    };
    return rows.sort((a, b) => comparator(a, b) * (sortDescending ? -1 : 1));
  }, [team, search, sortKey, sortDescending]);
  const selected =
    team.find((row) => row.identityKey === selectedEmployee) || null;
  const normIssues = useMemo(() => (selected ? selected.events : periodRows.flatMap(row => row.events ?? []))
    .filter(missingAssemblyCoefficient), [selected, periodRows]);
  const showingEmployee = selected !== null;
  useEffect(() => {
    if (!focusReport.current) return;
    focusReport.current = false;
    const returnButton = showingEmployee
      ? null
      : teamTable.current?.querySelector<HTMLButtonElement>(
          `[data-employee="${CSS.escape(returnToEmployee.current)}"]`,
        );
    (returnButton ?? viewHeading.current)?.focus();
  }, [showingEmployee]);
  const activeDays = new Set(
    periodRows
      .filter((row) => hasType(row, aggregateType))
      .map((row) => row.date),
  ).size;
  const sourceMetrics = useMemo(
    () => ({
      fbo: sumSourceContributions(periodRows, "fbo", aggregateType),
      assembly: sumSourceContributions(periodRows, "assembly", aggregateType),
      approved: sumSourceContributions(periodRows, "all", aggregateType, true),
      combined: sumSourceContributions(periodRows, "all", aggregateType),
    }),
    [periodRows, aggregateType],
  );
  const hasApprovedMetrics = sourceMetrics.approved.recordCount > 0;
  const machineTotal =
    aggregateType || !hasApprovedMetrics
      ? null
      : sourceMetrics.approved.machineCut;
  const manualTotal =
    aggregateType || !hasApprovedMetrics
      ? null
      : sourceMetrics.approved.manualCut;
  const packedTotal = hasApprovedMetrics ? sourceMetrics.approved.packed : null;
  const coefficientTotal =
    aggregateType || !sourceMetrics.combined.recordCount
      ? null
      : sourceMetrics.combined.coefficient;
  const reconciliationStatus =
    !value ||
    value.staleSnapshot ||
    (!assemblyOnly && value.sources?.fbo?.status === "unavailable") ||
    value.sources?.assembly.status === "unavailable" ||
    periodRows.some((row) => row.reconciliationStatus === "unknown")
      ? "unknown"
      : periodRows.some((row) => row.reconciliationStatus === "needs_review")
        ? "needs_review"
        : "clear";
  const needsReconciliation = !assemblyOnly && !!value && reconciliationStatus !== "clear";
  const sourceTotalsNote = (
    metric: "packed" | "machineCut" | "manualCut" | "coefficient",
  ) => {
    if (!value) return "Данные ещё не загружены.";
    const fboValue = sourceMetrics.fbo[metric];
    const assemblyValue = sourceMetrics.assembly[metric];
    const caption = metric === "coefficient" ? "кэф" : "шт.";
    const sourceLabel = (
      source: "fbo" | "assembly",
      sourceValue: number | null,
    ) => {
      const status = value?.sources?.[source]?.status;
      const name = source === "fbo" ? "FBO" : "RITM Сборка";
      if (value?.staleSnapshot)
        return `${name} снимок ${sourceValue === null ? "—" : fmt(sourceValue, metric === "coefficient")} ${caption}`;
      if (status === "unavailable") return `${name} недоступен`;
      if (status === "partial")
        return `${name} частично ${sourceValue === null ? "—" : fmt(sourceValue, metric === "coefficient")} ${caption}`;
      return sourceValue === null
        ? `${name} нет полной разбивки`
        : `${name} ${fmt(sourceValue, metric === "coefficient")} ${caption}`;
    };
    if (assemblyOnly) return sourceLabel("assembly", assemblyValue);
    const combined = `${sourceLabel("fbo", fboValue)} · ${sourceLabel("assembly", assemblyValue)}`;
    return needsReconciliation
      ? `${combined} · сумма источников`
      : `${combined} · подтверждено`;
  };
  const sourceMetricValue = (
    metric: "packed" | "machineCut" | "manualCut" | "coefficient",
  ) => {
    const values = [
      {
        stats: sourceMetrics.fbo,
        state: value?.sources?.fbo?.status,
      },
      {
        stats: sourceMetrics.assembly,
        state: value?.sources?.assembly.status,
      },
    ].filter(
      ({ stats, state }) => stats.recordCount > 0 && state !== "unavailable",
    );
    if (!values.length) return "—";
    return fmt(sourceMetrics.combined[metric], metric === "coefficient");
  };
  const averageCoefficient =
    coefficientTotal !== null && new Set(periodRows.map((row) => row.date)).size
      ? coefficientTotal / new Set(periodRows.map((row) => row.date)).size
      : null;
  const maxMachine = Math.max(
    1,
    ...visibleTeam.map((row) => row.machineCut || 0),
  );
  const maxManual = Math.max(
    1,
    ...visibleTeam.map((row) => row.manualCut || 0),
  );
  const maxPacked = Math.max(1, ...visibleTeam.map((row) => row.packed));
  const selectedDays = selected?.days || [];
  const selectedHistory = [...selectedDays]
    .filter((row) => !aggregateType || hasType(row, aggregateType))
    .filter(
      (row) =>
        aggregateType ||
        operationFilter === "all" ||
        operationValue(row, operationFilter) > 0,
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  const selectedFboHistory = rowsForSource(selectedHistory, "fbo");
  const selectedEvents = (selected?.events || []).filter((event) =>
    eventMatchesOperation(event, operationFilter),
  );
  const selectedHasMultipleSources =
    (selected?.sourceContributions.length || 0) > 1;
  const latestRecordAt = value?.sources?.assembly.sourceUpdatedAt || "";
  const fboSyncAt =
    value?.sources?.fbo?.lastSuccessAt || value?.sources?.fbo?.checkedAt || "";
  const assemblySyncAt =
    value?.sources?.assembly.lastSuccessAt ||
    value?.sources?.assembly.checkedAt ||
    "";
  const qualityMessage =
    value?.quality?.status === "partial" && value.quality.invalidRecords > 0
      ? `В источниках есть ${value.quality.invalidRecords} некорректных строк; они исключены, поэтому показатели могут быть неполными.`
      : "";
  const workLogUnavailable = value?.sources?.assembly.status !== "available";
  const showSourceNotes =
    !assemblyOnly || workLogUnavailable || value?.stale || value?.staleSnapshot;
  const fboUnavailable = !assemblyOnly && value?.sources?.fbo?.status !== "available";
  const tabs: { id: DetailTab; label: string }[] = [
    { id: "summary", label: "Сводка" },
    { id: "history", label: "История" },
    { id: "chart", label: "График" },
    ...(assemblyOnly ? [] : [{ id: "norms" as const, label: "Нормы" }]),
  ];
  const setSort = (key: SortKey) => {
    if (sortKey === key) setSortDescending((value) => !value);
    else {
      setSortKey(key);
      setSortDescending(key !== "employee");
    }
  };
  const topCutTypes = selected?.cutTypes.slice(0, 4) || [];
  const topPackTypes = selected?.packTypes.slice(0, 4) || [];
  const openEmployee = (identityKey: string) => {
    returnToEmployee.current = identityKey;
    focusReport.current = true;
    setTab(assemblyOnly ? "history" : "summary");
    setOperationFilter("all");
    setHistoryLimit(25);
    setSelectedEmployee(identityKey);
  };
  const closeEmployee = () => {
    focusReport.current = true;
    setSelectedEmployee("");
  };
  const employeeSearch = (
    <div className="assembly-search">
      <Search size={17} aria-hidden="true" />
      <input
        aria-label="Поиск сотрудника"
        placeholder="Найти сотрудника"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {search && (
        <button
          type="button"
          aria-label="Очистить поиск"
          onClick={() => setSearch("")}
        >
          <X size={15} />
        </button>
      )}
    </div>
  );

  return (
    <section
      className="assembly-analytics"
      aria-label="Производительность сборщиков"
    >
      <div className="assembly-toolbar">
        <div className="assembly-filter-row">
          <div
            className="assembly-tabs"
            role="group"
            aria-label="Период отчёта"
          >
            {(
              [
                ["today", "Сегодня"],
                ["week", "Неделя"],
                ["month", "Месяц"],
                ["custom", "Период"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={preset === id ? "is-active" : ""}
                aria-pressed={preset === id}
                title={id === "week" ? "Последние 7 дней, включая сегодня" : undefined}
                onClick={() => setPreset(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {preset === "custom" && (
            <div className="assembly-date-range">
              <label>
                <span>С</span>
                <input
                  aria-label="Начало периода"
                  type="date"
                  value={customStart}
                  max={customEnd}
                  onChange={(event) => setCustomStart(event.target.value)}
                />
              </label>
              <label>
                <span>По</span>
                <input
                  aria-label="Конец периода"
                  type="date"
                  value={customEnd}
                  min={customStart}
                  onChange={(event) => setCustomEnd(event.target.value)}
                />
              </label>
            </div>
          )}
          {!assemblyOnly && <label className="assembly-select-wrap">
            <span className="sr-only">Поставка</span>
            <select
              aria-label="Поставка"
              value="all"
              disabled
              title="В FBO «История производства» нет разбивки по поставкам"
            >
              <option value="all">Все поставки · нет данных в FBO</option>
            </select>
          </label>}
          <label className="assembly-select-wrap">
            <span className="sr-only">Вид товара</span>
            <select
              aria-label="Вид товара"
              value={productType}
              onChange={(event) => setProductType(event.target.value)}
            >
              <option value="">Все виды товаров</option>
              {productOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          {!showingEmployee && employeeSearch}
          <div className="assembly-toolbar-actions">
            <button
              className="assembly-button assembly-button-secondary"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw size={16} className={loading ? "is-spinning" : ""} />
              <span>{loading ? "Обновляю" : "Обновить"}</span>
            </button>
            <button
              className="assembly-button assembly-button-primary"
              onClick={() => downloadCsv(visibleTeam, range)}
              disabled={!visibleTeam.length}
            >
              <Download size={16} />
              <span>Экспорт</span>
            </button>
          </div>
        </div>
        <div className="assembly-toolbar-meta">
          <span>
            <CalendarDays size={14} />
            {range.start && range.end
              ? `${dateTitle(range.start)}${range.start === range.end ? "" : ` — ${dateTitle(range.end)}`}`
              : "Выберите период"}
          </span>
          {!assemblyOnly && <span>
            <Clock3 size={14} />
            {value?.staleSnapshot
              ? `FBO снимок · последняя успешная ${fboSyncAt ? `${moscowDateTime(fboSyncAt)} МСК` : "время неизвестно"}`
              : value?.sources?.fbo?.status === "unavailable"
                ? `FBO недоступен${fboSyncAt ? ` · последняя успешная ${moscowDateTime(fboSyncAt)} МСК` : ""}`
                : value?.sources?.fbo?.status === "partial"
                  ? `FBO частично · проверено ${fboSyncAt ? `${moscowDateTime(fboSyncAt)} МСК` : "время неизвестно"}`
                  : `FBO синхр. ${fboSyncAt ? `${moscowDateTime(fboSyncAt)} МСК` : "время неизвестно"}${value?.sources?.fbo?.currentSheetUpdateTime ? ` · лист ${value.sources.fbo.currentSheetUpdateTime}` : ""}`}
          </span>}
          <span>
            {value?.staleSnapshot
              ? `RITM Сборка · последняя синхронизация ${assemblySyncAt ? `${moscowDateTime(assemblySyncAt)} МСК` : "время неизвестно"}`
              : value?.sources?.assembly.status === "unavailable"
                ? `«RITM Сборка» недоступна${assemblySyncAt ? ` · последний снимок ${moscowDateTime(assemblySyncAt)} МСК` : ""}`
                : value?.sources?.assembly.status === "partial"
                  ? `RITM Сборка · данные загружены частично · проверено ${assemblySyncAt ? `${moscowDateTime(assemblySyncAt)} МСК` : "время неизвестно"}`
                  : `RITM Сборка · обновлено ${assemblySyncAt ? `${moscowDateTime(assemblySyncAt)} МСК` : "время неизвестно"}`}
            {latestRecordAt
              ? ` · событие ${moscowDateTime(latestRecordAt)} МСК`
              : ""}
          </span>
          {!assemblyOnly && <span className="assembly-source-label">
            FBO «Все коэффициенты» + «История производства» · журнал «RITM Сборка»
          </span>}
        </div>
      </div>

      {error && (
        <div
          className={`assembly-alert ${value ? "is-stale" : "is-error"}`}
          role="status"
        >
          <span>
            {error}
            {assemblyOnly
              ? value?.stale ? " Показан последний полученный отчёт." : ""
              : value?.staleSnapshot
              ? " Показаны последние сохранённые данные обоих источников; общий итог требует повторной сверки."
              : value
                ? value.sources?.fbo?.status === "unavailable" ||
                  value.sources?.assembly.status === "unavailable"
                  ? " Данные доступного источника сохранены отдельно; вклад недоступного источника неизвестен."
                  : " Показаны проверенные записи; общий итог может быть неполным."
                : " Проверьте соединение и нажмите «Повторить»."}
          </span>
          <button onClick={onRefresh} disabled={loading}>
            Повторить
          </button>
        </div>
      )}
      {value?.staleSnapshot && !error && (
        <div className="assembly-alert is-stale" role="status">
          Показан последний сохранённый снимок данных; проверяю источники.
        </div>
      )}
      {qualityMessage && !error && !value?.staleSnapshot && (
        <div className="assembly-alert is-stale" role="status">
          {qualityMessage}
        </div>
      )}
      {needsReconciliation &&
        (reconciliationStatus !== "unknown" ||
          (!error && !qualityMessage && !value?.staleSnapshot)) && (
          <div className="assembly-reconciliation-note" role="status">
            <strong>
              {reconciliationStatus === "unknown"
                ? "Общий результат не подтверждён"
                : "Работа и кэф = FBO + RITM Сборка"}
            </strong>
            <span>
              {reconciliationStatus === "unknown"
                ? "Показатели доступных источников остаются видны. Автоматически объединяются только однозначные совпадения имён; общий итог появится после проверки доступности и возможных повторов."
                : "Показаны количества по операциям и сумма коэффициентов обеих систем. В карточке — вклад каждой системы и работа по артикулам «RITM Сборка». FBO передаёт дневные итоги без артикулов и времени: совпадение работы между системами по ним проверить нельзя. Совпадение сотрудника и дня не доказывает повтор."}
            </span>
          </div>
        )}
      {!assemblyOnly && productType && (
        <div className="assembly-filter-note">
          Для выбранного вида FBO показывает общий объём порезки по виду и
          упаковку по виду. Разделить станочную/ручную резку и коэффициент по
          виду нельзя — эти ячейки показаны как «—».
        </div>
      )}

      <div className={showingEmployee ? "assembly-kpis is-compact" : "assembly-kpis"}>
        <Metric
          label={
            needsReconciliation ? "Профилей источников" : "Сотрудники"
          }
          value={value ? fmt(team.length) : "—"}
          note={
            !value
              ? "Данные ещё не загружены."
              : needsReconciliation
                ? "FBO и «RITM Сборка» · возможны совпадения сотрудников"
                : undefined
          }
          tone="is-blue"
          Icon={Users}
        />
        <Metric
          label="Упаковано"
          value={
            needsReconciliation
              ? sourceMetricValue("packed")
              : packedTotal === null
                ? "—"
                : fmt(packedTotal)
          }
          note={showSourceNotes ? sourceTotalsNote("packed") : undefined}
          tone="is-indigo"
          Icon={Package}
        />
        <Metric
          label="Резка на станке"
          value={
            needsReconciliation
              ? sourceMetricValue("machineCut")
              : machineTotal === null
                ? "—"
                : value
                  ? fmt(machineTotal)
                  : "—"
          }
          note={showSourceNotes ? sourceTotalsNote("machineCut") : undefined}
          tone="is-green"
          Icon={Scissors}
        />
        <Metric
          label="Ручная резка"
          value={
            needsReconciliation
              ? sourceMetricValue("manualCut")
              : manualTotal === null
                ? "—"
                : value
                  ? fmt(manualTotal)
                  : "—"
          }
          note={showSourceNotes ? sourceTotalsNote("manualCut") : undefined}
          tone="is-violet"
          Icon={Hand}
        />
        <Metric
          label="Общий кэф"
          value={
            needsReconciliation
              ? sourceMetricValue("coefficient")
              : coefficientTotal === null
                ? "—"
                : value
                  ? fmt(coefficientTotal, true)
                  : "—"
          }
          note={
            needsReconciliation
              ? sourceTotalsNote("coefficient")
              : averageCoefficient !== null && activeDays > 1
                ? `В среднем за активный день ${fmt(averageCoefficient, true)}`
                : undefined
          }
          tone="is-teal"
          Icon={Activity}
        />
      </div>

      <AssemblyNormIssues events={normIssues} onOpenCatalog={() => { catalogOpened.current = true; }} />
      {!selected && (
          <section
            className="assembly-team-panel"
            aria-labelledby="assembly-team-title"
          >
            <div className="assembly-panel-heading">
              <div>
                <span className="assembly-heading-icon">
                  <Users size={18} />
                </span>
                <div>
                  <h2 id="assembly-team-title" ref={viewHeading} tabIndex={-1}>
                    {needsReconciliation ? "Профили источников" : "Выработка команды"}
                  </h2>
                  <p>
                    {value
                      ? `${countWithNoun(
                          team.length,
                          needsReconciliation
                            ? [
                                "профиль источника",
                                "профиля источников",
                                "профилей источников",
                              ]
                            : ["сотрудник", "сотрудника", "сотрудников"],
                        )} · ${countWithNoun(activeDays, [
                          "рабочий день",
                          "рабочих дня",
                          "рабочих дней",
                        ])}`
                      : "Ожидаем источник"}
                  </p>
                </div>
              </div>
              {loading && (
                <span className="assembly-loading-indicator">
                  <span />
                  Обновление
                </span>
              )}
            </div>
            {!value && loading ? (
              <div className="assembly-panel-state">
                <span className="assembly-spinner" />
                Загружаем данные сотрудников…
              </div>
            ) : !value ? (
              <div className="assembly-panel-state">
                <strong>Данные временно недоступны</strong>
                <span>Проверьте подключение к источнику и обновите отчёт.</span>
                <button
                  className="assembly-button assembly-button-primary"
                  onClick={onRefresh}
                >
                  Повторить загрузку
                </button>
              </div>
            ) : !periodRows.length ? (
              <div className="assembly-panel-state">
                <strong>Нет записей за выбранный период</strong>
                <span>
                  {workLogUnavailable || fboUnavailable
                    ? "Один из источников сейчас не отвечает. Данные за этот период неизвестны, а не равны нулю."
                    : "В выбранных источниках нет подтверждённых записей за указанные даты."}
                </span>
              </div>
            ) : !visibleTeam.length ? (
              <div className="assembly-panel-state">
                <strong>Сотрудники не найдены</strong>
                <span>Измените поисковый запрос.</span>
              </div>
            ) : (
              <div
                className="assembly-team-table-scroll"
                tabIndex={0}
                aria-label="Выработка по сотрудникам"
                role="region"
              >
                <table className="assembly-team-table" ref={teamTable}>
                  <thead>
                    <tr>
                      {teamColumns.map(({ key, label, Icon, tone }) => {
                        const direction =
                          key === sortKey
                            ? sortDescending ? "descending" : "ascending"
                            : undefined;
                        const SortIcon =
                          direction === "descending"
                            ? ArrowDown
                            : direction === "ascending"
                              ? ArrowUp
                              : ArrowDownUp;
                        return (
                          <th key={key} scope="col" aria-sort={direction}>
                            <button type="button" onClick={() => setSort(key)}>
                              {Icon && <Icon className={tone} size={15} aria-hidden="true" />}
                              {key === "coefficient" && needsReconciliation ? "Итоговый кэф" : label}
                              <SortIcon className="assembly-sort-icon" size={13} aria-hidden="true" />
                            </button>
                          </th>
                        );
                      })}
                      <th className="assembly-row-end" aria-hidden="true" />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTeam.map((row) => {
                      const displayMachine = row.machineCut;
                      const displayManual = row.manualCut;
                      const displayPacked = row.packed;
                      const displayCoefficient = row.coefficient;
                      return (
                        <tr
                          key={row.identityKey}
                          onClick={() => openEmployee(row.identityKey)}
                        >
                          <th scope="row">
                            <button
                              className="assembly-person-button"
                              type="button"
                              data-employee={row.identityKey}
                              aria-label={`Открыть отчёт сотрудника ${row.employee}`}
                            >
                              <span className="assembly-avatar" aria-hidden="true">
                                {employeeInitials(row.employee)}
                              </span>
                              <span>
                                <strong>{row.employee}</strong>
                                {!assemblyOnly && <small>
                                  <span
                                    className={`assembly-source-pill is-${row.sourceKind}`}
                                  >
                                    {sourceBadgeLabel(row.sourceKinds)}
                                  </span>
                                  {row.employeeId ? ` · ${row.employeeId}` : ""}
                                  {row.reconciliationStatus !== "clear" &&
                                    row.sourceContributions.length > 1 && (
                                      <span className="assembly-review-pill">
                                        Сумма источников
                                      </span>
                                    )}
                                </small>}
                              </span>
                            </button>
                          </th>
                          <td>
                            <div className="assembly-bar-cell">
                              <b>{fmt(displayMachine)}</b>
                              <span className="assembly-value-bar">
                                <i
                                  className="is-green"
                                  style={{
                                    width: `${displayMachine === null ? 0 : (Math.max(0, displayMachine) / maxMachine) * 100}%`,
                                  }}
                                />
                              </span>
                            </div>
                          </td>
                          <td>
                            <div className="assembly-bar-cell">
                              <b>{fmt(displayManual)}</b>
                              <span className="assembly-value-bar">
                                <i
                                  className="is-violet"
                                  style={{
                                    width: `${displayManual === null ? 0 : (Math.max(0, displayManual) / maxManual) * 100}%`,
                                  }}
                                />
                              </span>
                            </div>
                          </td>
                          <td>
                            <div className="assembly-bar-cell">
                              <b>{fmt(displayPacked)}</b>
                              <span className="assembly-value-bar">
                                <i
                                  className="is-indigo"
                                  style={{
                                    width: `${displayPacked === null ? 0 : (Math.max(0, displayPacked) / maxPacked) * 100}%`,
                                  }}
                                />
                              </span>
                            </div>
                          </td>
                          <td>
                            <strong className="assembly-coef-value">
                              {displayCoefficient === null && row.events.some(missingAssemblyCoefficient)
                                ? <a className="assembly-norm-pending" href="#assembly-norm-issues">Требует проверки</a>
                                : fmt(displayCoefficient, true)}
                            </strong>
                          </td>
                          <td>
                            <span
                              className="assembly-last-date"
                              title={
                                row.sourceKind === "assembly" ||
                                row.sourceKind === "both"
                                  ? "Дата операции по createdAt в WorkLog, время показано в часовом поясе Москвы"
                                  : "FBO сохраняет дату дневного итога, точное время выполнения операции отсутствует"
                              }
                            >
                              {row.date ? dayLabel(row.date) : "—"}
                            </span>
                          </td>
                          <td className="assembly-row-end" aria-hidden="true">
                            <ChevronRight size={18} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="assembly-table-foot">
              <span>
                Полосы показывают объём относительно максимума среди видимых
                сотрудников.
              </span>
              {!assemblyOnly && <span>
                FBO хранит дневные итоги, WorkLog — события. Фактические
                значения видны по каждому источнику. Итоговый кэф складывает FBO
                и «RITM Сборка»; возможные повторы не вычитаются.
              </span>}
            </div>
          </section>
      )}

      {selected && (
        <div className="assembly-master-detail">
            <nav className="assembly-roster" aria-label="Сотрудники отчёта">
              <button
                type="button"
                className="assembly-button assembly-team-back"
                onClick={closeEmployee}
              >
                <ArrowLeft size={16} aria-hidden="true" />
                К команде
              </button>
              <h2>Сотрудники</h2>
              {employeeSearch}
              {visibleTeam.length ? (
                <ul className="assembly-roster-list">
                  {visibleTeam.map((row) => (
                    <li key={row.identityKey}>
                      <button
                        type="button"
                        className="assembly-roster-person"
                        aria-current={row.identityKey === selectedEmployee || undefined}
                        onClick={() => {
                          setSelectedEmployee(row.identityKey);
                          setHistoryLimit(25);
                        }}
                      >
                        <span className="assembly-avatar" aria-hidden="true">
                          {employeeInitials(row.employee)}
                        </span>
                        <span className="assembly-roster-name">
                          <strong>{row.employee}</strong>
                          {!assemblyOnly && <small>{sourceBadgeLabel(row.sourceKinds)}</small>}
                        </span>
                        <b className="assembly-coef-value">{fmt(row.coefficient, true)}</b>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="assembly-roster-empty">Сотрудники не найдены</p>
              )}
            </nav>
            <section
              className="assembly-detail-panel"
              aria-labelledby="assembly-employee-title"
            >
              <div className="assembly-detail-hero">
                <div className="assembly-detail-heading">
                  <div className="assembly-avatar is-large" aria-hidden="true">
                    {employeeInitials(selected.employee)}
                  </div>
                  <div>
                    <h2 id="assembly-employee-title" ref={viewHeading} tabIndex={-1}>
                      {selected.employee}
                    </h2>
                    <p>
                      {sourceBadgeLabel(selected.sourceKinds)}
                      {!assemblyOnly && (selected.employeeId
                        ? ` · employeeId ${selected.employeeId}`
                        : " · FBO employeeId не передаётся")}
                    </p>
                    {selectedHasMultipleSources && selected.reconciliationStatus !== "clear" && (
                      <span className="assembly-review-pill">Сумма FBO + RITM Сборка</span>
                    )}
                  </div>
                </div>
                <div className="assembly-employee-kpis">
                  <Metric
                    label="Резка на станке"
                    value={fmt(selected.machineCut)}
                    tone="is-green"
                    Icon={Scissors}
                  />
                  <Metric
                    label="Ручная резка"
                    value={fmt(selected.manualCut)}
                    tone="is-violet"
                    Icon={Hand}
                  />
                  <Metric
                    label="Упаковка"
                    value={fmt(selected.packed)}
                    tone="is-indigo"
                    Icon={Package}
                  />
                  <Metric
                    label="Общий кэф"
                    value={fmt(selected.coefficient, true)}
                    note={selected.coefficient === null ? "Нет подтверждённого кэфа" : undefined}
                    tone="is-teal"
                    Icon={Activity}
                  />
                </div>
              </div>
              <div
                className="assembly-tabs assembly-detail-tabs"
                role="group"
                aria-label="Разделы сотрудника"
              >
                {tabs.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={tab === item.id}
                    className={tab === item.id ? "is-active" : ""}
                    onClick={() => {
                      setTab(item.id);
                      setHistoryLimit(25);
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {tab === "summary" && (
                <>
                  <p className="assembly-detail-source-note">
                    {selectedHasMultipleSources
                      ? selected.reconciliationStatus === "clear"
                        ? "Общий итог подтверждён. Ниже можно отдельно посмотреть количества и коэффициенты FBO и «RITM Сборка»."
                        : "Выше — суммарная работа и кэф. Ниже — количества, операции и коэффициенты отдельно по FBO и «RITM Сборка»."
                      : `Показаны фактические данные ${selected.sourceContributions[0]?.sourceKind === "fbo" ? "FBO" : selected.sourceContributions[0]?.sourceKind === "assembly" ? "журнала «RITM Сборка»" : "источника"}; они не смешиваются с другой системой.`}
                  </p>
                  <div className="assembly-source-breakdown">
                    <div className="assembly-source-breakdown-heading">
                      <h3>По источникам</h3>
                      <span>
                        {countWithNoun(selected.sourceContributions.length, [
                          "источник",
                          "источника",
                          "источников",
                        ])}
                      </span>
                    </div>
                    {selected.sourceContributions.map((source) => {
                      const types = [...source.cutTypes, ...source.packTypes];
                      const operations = [
                        source.machineCut > 0 &&
                          `Станок ${fmt(source.machineCut)}`,
                        source.manualCut > 0 &&
                          `Ручная ${fmt(source.manualCut)}`,
                        source.packed > 0 && `Упаковка ${fmt(source.packed)}`,
                      ].filter(Boolean);
                      return (
                        <div
                          className="assembly-source-breakdown-row"
                          key={source.sourceKind}
                        >
                          <div>
                            <strong>
                              {source.sourceKind === "fbo" ? "FBO" : "RITM Сборка"}
                            </strong>
                            <small>
                              {source.sourceKind === "fbo"
                                ? source.employeeLabel
                                : `${source.employeeLabel} · ${source.employeeId}`}
                            </small>
                          </div>
                          <div>
                            <b>{operations.join(" · ") || "Нет операций"}</b>
                            <small>
                              {types.length
                                ? types
                                    .map(
                                      (item) =>
                                        `${item.name} · ${fmt(item.quantity)} шт.`,
                                    )
                                    .join("; ")
                                : `${fmt(source.total)} операционных шт.`}
                              {source.coefficient === null
                                ? " · кэф неизвестен"
                                : ` · кэф ${fmt(source.coefficient, true)}`}
                            </small>
                          </div>
                          <span
                            className={`assembly-review-pill ${selectedHasMultipleSources ? (source.reconciliationStatus === "clear" ? "is-clear" : "") : "is-source"}`}
                          >
                            {selectedHasMultipleSources
                              ? source.reconciliationStatus === "clear"
                                ? "Подтверждён"
                                : "Дневной итог / журнал"
                              : "Фактические данные"}
                          </span>
                        </div>
                      );
                    })}
                    <p
                      className={
                        selectedHasMultipleSources &&
                        selected.reconciliationStatus !== "clear"
                          ? ""
                          : "is-source"
                      }
                    >
                      {selectedHasMultipleSources &&
                      selected.reconciliationStatus !== "clear"
                        ? "Количество и кэф складываются по источникам. FBO не передаёт артикулы и время операций, поэтому точную сверку повторов между системами выполнить нельзя; ничего не вычтено."
                        : selected.sourceContributions.length === 1
                          ? `Вклад ${selected.sourceContributions[0].sourceKind === "fbo" ? "FBO" : "RITM Сборка"}: ${fmt(selected.sourceContributions[0].total)} шт. · кэф ${fmt(selected.sourceContributions[0].coefficient, true)}.`
                          : `Подтверждённый итог: ${fmt(selected.total)} шт. · кэф ${fmt(selected.coefficient, true)}`}
                    </p>
                  </div>
                  {selectedFboHistory.length > 0 && (
                    <>
                      <div className="assembly-detail-section-heading">
                        <div>
                          <h3>FBO · дневные итоги</h3>
                          <p>Количество и коэффициент из FBO</p>
                        </div>
                        <span>{fmt(selectedFboHistory.length)} записей</span>
                      </div>
                      <p className="assembly-detail-note">
                        FBO хранит дневной итог без точного времени, поставки и
                        артикула. Он показан отдельно от событий «RITM Сборка».
                      </p>
                      <DetailRows
                        rows={selectedFboHistory.slice(0, 7)}
                        productType={productType}
                      />
                    </>
                  )}
                  {selected.events.length > 0 && (
                    <>
                      <div className="assembly-detail-section-heading">
                        <div>
                          <h3>RITM Сборка · журнал операций</h3>
                          <p>Сохранённые события и время выполнения</p>
                        </div>
                        <span>{fmt(selected.events.length)} записей</span>
                      </div>
                      <p className="assembly-detail-note">
                        Норма и коэффициент взяты из события WorkLog на момент
                        записи; текущие нормы историю не пересчитывают.
                      </p>
                      <AssemblyEventRows events={selected.events} limit={7} />
                    </>
                  )}
                  <div className="assembly-mini-breakdowns">
                    <div>
                      <h3>Объём порезки по видам</h3>
                      {topCutTypes.length ? (
                        topCutTypes.map((item) => (
                          <div
                            className="assembly-breakdown-row"
                            key={item.name}
                          >
                            <span>{item.name}</span>
                            <b>{fmt(item.quantity)} шт.</b>
                          </div>
                        ))
                      ) : (
                        <span className="assembly-muted">Нет данных</span>
                      )}
                    </div>
                    <div>
                      <h3>Упаковка по видам</h3>
                      {topPackTypes.length ? (
                        topPackTypes.map((item) => (
                          <div
                            className="assembly-breakdown-row"
                            key={item.name}
                          >
                            <span>{item.name}</span>
                            <b>{fmt(item.quantity)} шт.</b>
                          </div>
                        ))
                      ) : (
                        <span className="assembly-muted">Нет данных</span>
                      )}
                    </div>
                    {!assemblyOnly && <div className="assembly-supply-breakdown">
                      <h3>По поставкам</h3>
                      <p>В FBO «История производства» поставка не указана.</p>
                    </div>}
                  </div>
                </>
              )}
              {tab === "history" && (
                <div className="assembly-history-view">
                  <div className="assembly-history-toolbar">
                    {assemblyOnly && (
                      <div className="assembly-detail-section-heading">
                        <div>
                          <h3>Журнал операций</h3>
                          <p>
                            {countWithNoun(selectedEvents.length, [
                              "запись",
                              "записи",
                              "записей",
                            ])} · нормы на момент записи
                          </p>
                        </div>
                      </div>
                    )}
                    <div className="assembly-history-filters">
                      <label>
                        <span>Операция</span>
                        <select
                          value={aggregateType ? "all" : operationFilter}
                          disabled={!!aggregateType}
                          onChange={(event) => {
                            setOperationFilter(
                              event.target.value as OperationFilter,
                            );
                            setHistoryLimit(25);
                          }}
                        >
                          <option value="all">Все операции</option>
                          <option value="machine">Резка на станке</option>
                          <option value="manual">Ручная резка</option>
                          <option value="packing">Упаковка</option>
                        </select>
                      </label>
                      {!assemblyOnly && (
                        <label>
                          <span>Поставка</span>
                          <select value="none" disabled>
                            <option value="none">Нет данных в FBO</option>
                          </select>
                        </label>
                      )}
                    </div>
                  </div>
                  {!assemblyOnly && <p className="assembly-detail-note">
                    FBO отображается дневными итогами, «RITM Сборка» — отдельными
                    событиями с временем. Фильтры применены к выбранному
                    периоду.
                  </p>}
                  {selectedFboHistory.length > 0 && (
                    <>
                      <div className="assembly-detail-section-heading">
                        <div>
                          <h3>FBO · дневные итоги</h3>
                          <p>Объём и коэффициент по дням</p>
                        </div>
                      </div>
                      <DetailRows
                        rows={selectedFboHistory.slice(0, historyLimit)}
                        productType={productType}
                      />
                    </>
                  )}
                  {(assemblyOnly || selectedEvents.length > 0) && (
                    <>
                      {!assemblyOnly && (
                        <div className="assembly-detail-section-heading">
                          <div>
                            <h3>RITM Сборка · журнал операций</h3>
                            <p>Время по МСК · нормы на момент записи</p>
                          </div>
                          <span>{countWithNoun(selectedEvents.length, ["запись", "записи", "записей"])}</span>
                        </div>
                      )}
                      <AssemblyEventRows
                        events={selectedEvents}
                        limit={historyLimit}
                      />
                    </>
                  )}
                  {Math.max(selectedFboHistory.length, selectedEvents.length) >
                    historyLimit && (
                    <button
                      className="assembly-show-more"
                      onClick={() => setHistoryLimit((limit) => limit + 25)}
                    >
                      Показать ещё 25 записей
                    </button>
                  )}
                </div>
              )}
              {tab === "chart" && (
                <DetailChart stats={selected} productType={aggregateType} />
              )}
              {!assemblyOnly && tab === "norms" && (
                <div className="assembly-norms-view">
                  <div className="assembly-detail-section-heading">
                    <div>
                      <h3>Действующие нормы</h3>
                      <p>Текущий лист FBO «Нормы»</p>
                    </div>
                    <BookOpen size={18} />
                  </div>
                  <NormsTable norms={value?.norms} productType={productType} />
                </div>
              )}
            </section>
        </div>
      )}
    </section>
  );
}

function AssemblyEventRows({
  events,
  limit = Infinity,
}: {
  events: AssemblyEvent[];
  limit?: number;
}) {
  if (!events.length)
    return (
      <div className="assembly-empty-inline">
        В WorkLog нет подтверждённых событий для этого фильтра.
      </div>
    );
  const timeFormat = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  });
  const groups = groupWorkEvents(events);
  return (
    <div
      className="assembly-detail-table-scroll"
      role="region"
      aria-label="Записи журнала операций"
      tabIndex={0}
    >
      <table className="assembly-detail-table assembly-event-table">
        <thead>
          <tr>
            <th>Время · МСК</th>
            <th>Поставка</th>
            <th>Артикул</th>
            <th>Вид товара</th>
            <th>Операция</th>
            <th>Шт.</th>
            <th>Норма</th>
            <th>Кэф.</th>
            <th>Записи и время</th>
          </tr>
        </thead>
        <tbody>
          {groups.slice(0, limit).map((group) => {
            const event = group.first;
            const start = group.events[0];
            const end = group.events[group.events.length - 1];
            const norms = new Set(group.events.map((item) => item.norm));
            const missing = group.events.find(missingAssemblyCoefficient);
            return (
              <tr key={group.key}>
                <td>
                  <time dateTime={start.createdAt}>
                    {timeFormat.format(new Date(start.createdAt))}
                  </time>
                  {start.createdAt !== end.createdAt && (
                    <>
                      {" — "}
                      <time dateTime={end.createdAt}>
                        {timeFormat.format(new Date(end.createdAt))}
                      </time>
                    </>
                  )}
                </td>
                <td>{event.shipmentName || event.shipmentId}</td>
                <td title={event.positionId}>{event.article}</td>
                <td>{event.productType || "Нет данных"}</td>
                <td>
                  <span className={`assembly-operation is-${event.operationId}`}>
                    {event.operation}
                  </span>
                </td>
                <td>{fmt(group.quantity)}</td>
                <td>
                  {norms.size > 1 ? "Разные нормы — см. записи" : (
                    <span className="assembly-norm-value">
                      {event.norm === null ? "Нет нормы" : `${fmt(event.norm)} шт/чел`}
                    </span>
                  )}
                </td>
                <td>
                  {group.coefficient === null
                    ? (missing ? assemblyNormReason(missing) : "—")
                    : fmt(group.coefficient, true)}
                </td>
                <td>
                  <details>
                    <summary>{countWithNoun(group.events.length, ["запись", "записи", "записей"])}</summary>
                    {group.events.map((item) => (
                      <div key={item.eventId} title={item.eventId}>
                        {timeFormat.format(new Date(item.createdAt))} ·{" "}
                        {fmt(item.quantity)} шт. ·{" "}
                        {item.norm === null
                          ? "нет нормы"
                          : `норма ${fmt(item.norm)}`}{" "}
                        · кэф {fmt(item.coefficient, true)}
                      </div>
                    ))}
                  </details>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DetailRows({
  rows,
  productType = "",
}: {
  rows: AssemblyDaily[];
  productType?: string;
}) {
  if (!rows.length)
    return (
      <div className="assembly-empty-inline">
        В источнике нет дневных записей для этого фильтра.
      </div>
    );
  return (
    <div className="assembly-detail-table-scroll">
      <table className="assembly-detail-table">
        <thead>
          <tr>
            <th>Дата</th>
            <th>Поставка</th>
            <th>Артикул</th>
            <th>Вид товара</th>
            <th>Операции, шт.</th>
            <th>Всего</th>
            <th>Норма</th>
            <th>Кэф.</th>
            <th>Источник</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const types = [
              ...new Set(
                [...row.cutTypes, ...row.packTypes]
                  .filter(
                    (item) =>
                      !productType ||
                      normalize(item.name) === normalize(productType),
                  )
                  .map((item) => item.name),
              ),
            ];
            const filteredCut = sumType([row], productType, "cutTypes");
            const filteredPacked = sumType([row], productType, "packTypes");
            const operations = productType
              ? [
                  filteredCut > 0 ? `Порезка по виду ${fmt(filteredCut)}` : "",
                  filteredPacked > 0
                    ? `Упаковка по виду ${fmt(filteredPacked)}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : [
                  row.machineCut > 0 ? `Станок ${fmt(row.machineCut)}` : "",
                  row.manualCut > 0 ? `Ручная ${fmt(row.manualCut)}` : "",
                  row.packed > 0 ? `Упаковка ${fmt(row.packed)}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ");
            const quantity = productType
              ? filteredCut + filteredPacked
              : row.total;
            return (
              <tr
                key={`${row.date}-${row.employee}-${row.sourceIds?.join("-") || row.lastUpdatedAt || ""}`}
              >
                <td>{dateTitle(row.date)}</td>
                <td className="is-unknown">Нет данных</td>
                <td className="is-unknown">Нет данных</td>
                <td>{types.join(", ") || "—"}</td>
                <td>{operations || "—"}</td>
                <td>{fmt(quantity)}</td>
                <td
                  className="is-unknown"
                  title="Применённая норма в дневной строке FBO не сохраняется"
                >
                  Нет снимка
                </td>
                <td>{fmt(productType ? null : row.coefficient, true)}</td>
                <td>
                  <span className="assembly-source-key">
                    FBO ·{" "}
                    {row.sourceIds?.join(", ") ||
                      row.lastUpdatedAt ||
                      "дневной итог"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
