import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CalendarBlank,
  ChartBar,
  CheckCircle,
  Cube,
  Database,
  House,
  List,
  Package,
  Plus,
  Printer,
  Scissors,
  Truck,
  Users,
  Warning,
  X,
  ArrowSquareOut,
  DownloadSimple,
  UploadSimple,
  CaretRight,
} from "./icons";
import Papa from "./csv";
import {
  ANCHOR,
  coefficient,
  emptyDataset,
  employeeResult,
  freeStock,
  fullDate,
  inPeriod,
  lineTotals,
  num,
  reserveSupply,
  shortDate,
  stockByArticle,
  validateSupply,
  type Dataset,
  type Employee,
  type Kind,
  type Page,
  type Period,
  type Source,
  type Supply,
} from "./model";
import { demoDataset, sources as sourceSeed } from "./demo";
import {
  useLivePrinting,
  printingDataset,
  PRINTING_URL,
  PRINTERS,
} from "./livePrinting";
import { importFields, importRows } from "./importer";
import {
  Badge,
  Button,
  Busy,
  DataTable,
  Empty,
  Field,
  Modal,
  Notice,
  Progress,
  Search,
} from "./ui";
const NAV = [
  { id: "overview", label: "Обзор", icon: House },
  { id: "assembly", label: "Сборщики", icon: Users },
  { id: "printing", label: "Печать", icon: Printer },
  { id: "production", label: "Производство", icon: ChartBar },
  { id: "stock", label: "Склад", icon: Cube },
  { id: "supplies", label: "Поставки", icon: Truck },
  { id: "sources", label: "Источники данных", icon: Database },
] as const;
const TITLES: Record<Page, string> = {
  overview: "Обзор производства",
  assembly: "Сборщики",
  printing: "Печать",
  production: "Производство",
  stock: "Склад",
  supplies: "Поставки",
  sources: "Источники данных",
};
const SUBTITLES: Record<Page, string> = {
  overview: "Вся смена на одном экране",
  assembly: "Дневная цель — коэффициент не ниже 1,00",
  printing: "Фактический выпуск печатников · Красное здание",
  production: "План и выполненное по каждому артикулу",
  stock: "Готовый товар, ячейки хранения и свободный остаток",
  supplies: "Состав, сроки и готовность к отгрузке",
  sources: "Подготовка подключения и проверка исходных данных",
};
function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function initialPage(): Page {
  const value = new URLSearchParams(location.search).get("page");
  return NAV.some((n) => n.id === value) ? (value as Page) : "overview";
}
function download(name: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob(["\ufeff" + text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
export function App() {
  const [page, setPage] = useState<Page>(initialPage);
  const [date, setDate] = useState(() =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  );
  const [period, setPeriod] = useState<Period>("day");
  const [query, setQuery] = useState("");
  const [site, setSite] = useState("Все участки");
  const [mode, setMode] = useState<"demo" | "imported">("imported");
  const [demo, setDemo] = useState(demoDataset);
  const [real, setReal] = useState<Dataset>(() =>
    readStorage("ritm-real-v1", emptyDataset()),
  );
  const live = useLivePrinting();
  const data = mode === "demo" ? demo : printingDataset(real, live.value);
  const [supplyFilter, setSupplyFilter] = useState("all");
  const [sources, setSources] = useState<Source[]>(() =>
    readStorage("ritm-sources-v1", sourceSeed),
  );
  const [employee, setEmployee] = useState("e0");
  const [printer, setPrinter] = useState("all");
  const [supplyId, setSupplyId] = useState("П-0124");
  const [market, setMarket] = useState("Все маркетплейсы");
  const [completed, setCompleted] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [create, setCreate] = useState(false);
  const [sourceEdit, setSourceEdit] = useState<Kind | null>(null);
  const [importKind, setImportKind] = useState<Kind | null>(null);
  const [draft, setDraft] = useState({
    name: "",
    market: "Ozon" as "Ozon" | "WB",
    store: "RITM",
    destination: "",
    arrival: "",
    ready: "",
    owner: "Кирилл",
    lines: "",
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [discard, setDiscard] = useState(false);
  const [importRecords, setImportRecords] = useState<Record<string, string>[]>(
    [],
  );
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importError, setImportError] = useState("");
  const [fileName, setFileName] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const draftInitial = useRef("");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    document.title = `${TITLES[page]} · RITM`;
    const url = new URL(location.href);
    url.searchParams.set("page", page);
    history.replaceState(null, "", url);
  }, [page]);
  useEffect(() => {
    const onPop = () => setPage(initialPage());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );
  const dirty = create && JSON.stringify(draft) !== draftInitial.current;
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    addEventListener("beforeunload", guard);
    return () => removeEventListener("beforeunload", guard);
  }, [dirty]);
  const go = (id: Page) => {
    setPage(id);
    setQuery("");
    setSidebar(false);
  };
  const update = (next: Dataset) => {
    if (mode === "demo") setDemo(next);
    else {
      setReal(next);
      if (!writeStorage("ritm-real-v1", next))
        setToast(
          "Изменения доступны в этой сессии. Сохранение в браузере недоступно.",
        );
    }
  };
  const refresh = () => {
    if (mode === "imported") {
      void live.reload();
      return;
    }
    if (busy) return;
    setBusy(true);
    refreshTimer.current = setTimeout(() => {
      setBusy(false);
      setToast(
        mode === "demo"
          ? "Демонстрационные показатели пересчитаны."
          : "Показатели пересчитаны по загруженным файлам. Для свежих данных загрузи новую выгрузку.",
      );
    }, 450);
  };
  const contains = (value: string) =>
    value.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru"));
  const workPeople = data.employees.filter(
    (e) =>
      data.work.some((w) => w.employee === e.id) ||
      data.shifts.some((s) => s.employee === e.id),
  );
  const scoreRows = workPeople.map((e) => ({
    ...e,
    ...employeeResult(data, e.id, date, period),
  }));
  const achieved = scoreRows.filter(
    (e) => e.value !== null && e.value >= 1,
  ).length;
  const activeEmployee =
    data.employees.find((e) => e.id === employee) || workPeople[0];
  const selectedScore = activeEmployee
    ? employeeResult(data, activeEmployee.id, date, period)
    : null;
  const rolls = data.rolls.filter(
    (r) =>
      inPeriod(r.date, date, period) &&
      (site === "Все участки" || r.site === site) &&
      (mode === "demo" || supplyFilter === "all" || r.source === supplyFilter),
  );
  const area = rolls.reduce((s, r) => s + r.area, 0);
  const printerPeople =
    mode === "imported"
      ? PRINTERS
      : data.employees.filter((e) => rolls.some((r) => r.employee === e.id));
  const supplyPrintingRows = (live.value?.sheets || []).map((sheet) => {
    const orders = live.value!.supplies.filter(
      (o) => o.sheetId === sheet.sheetId,
    );
    const facts = live.value!.events.filter((e) => e.sheetId === sheet.sheetId);
    return {
      ...sheet,
      orders: orders.length,
      plan: orders.reduce((n, o) => n + o.quantity, 0),
      plannedArea: orders.reduce((n, o) => n + o.plannedArea, 0),
      quantity: facts.reduce((n, e) => n + e.quantity, 0),
      area: facts.reduce((n, e) => n + e.area, 0),
    };
  });
  const totals = data.supplies.reduce(
    (s, v) => {
      const t = lineTotals(v);
      return { plan: s.plan + t.plan, packed: s.packed + t.packed };
    },
    { plan: 0, packed: 0 },
  );
  const supply =
    data.supplies
      .filter(
        (s) =>
          (market === "Все маркетплейсы" || s.market === market) &&
          (completed
            ? lineTotals(s).shipped >= lineTotals(s).plan
            : lineTotals(s).shipped < lineTotals(s).plan) &&
          contains(s.name + " " + s.id),
      )
      .find((s) => s.id === supplyId) ||
    data.supplies.find(
      (s) =>
        (market === "Все маркетплейсы" || s.market === market) &&
        (completed
          ? lineTotals(s).shipped >= lineTotals(s).plan
          : lineTotals(s).shipped < lineTotals(s).plan) &&
        contains(s.name + " " + s.id),
    );
  const stock = stockByArticle(data);
  const stockRows = [...stock].map(([article, quantity]) => ({
    article,
    quantity,
    free: freeStock(data, article),
    reserved: quantity - freeStock(data, article),
    locations: data.stock.filter((r) => r.article === article),
  }));
  const startCreate = () => {
    const next = {
      name: "",
      market: "Ozon" as "Ozon" | "WB",
      store: "RITM",
      destination: "",
      arrival: "",
      ready: "",
      owner: "Кирилл",
      lines: "",
    };
    setDraft(next);
    draftInitial.current = JSON.stringify(next);
    setFormErrors({});
    setDiscard(false);
    setCreate(true);
  };
  const closeCreate = () => {
    if (dirty) setDiscard(true);
    else setCreate(false);
  };
  const submitSupply = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = validateSupply(
      draft.name,
      draft.arrival,
      draft.ready,
      draft.lines,
    );
    if (!draft.destination.trim())
      parsed.errors.destination = "Укажи склад назначения.";
    setFormErrors(parsed.errors);
    if (Object.keys(parsed.errors).length) {
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    const id = "П-" + crypto.randomUUID().slice(0, 8).toUpperCase();
    const s: Supply = { ...draft, id, lines: parsed.lines };
    update({ ...data, supplies: [...data.supplies, s] });
    setSupplyId(id);
    setCreate(false);
    setQuery("");
    setCompleted(false);
    go("supplies");
    setToast("Поставка добавлена. Задания в рабочие таблицы не отправлялись.");
  };
  const saveSource = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceEdit) return;
    if (urlDraft) {
      try {
        const url = new URL(urlDraft);
        if (
          url.hostname !== "docs.google.com" ||
          !url.pathname.startsWith("/spreadsheets/d/")
        )
          throw new Error();
      } catch {
        setImportError(
          "Нужна ссылка на Google-таблицу: docs.google.com/spreadsheets/d/…",
        );
        return;
      }
    }
    const next = sources.map((s) =>
      s.id === sourceEdit ? { ...s, url: urlDraft } : s,
    );
    setSources(next);
    writeStorage("ritm-sources-v1", next);
    setSourceEdit(null);
    setToast(
      "Ссылка сохранена для подключения. Доступ к таблице ещё не настроен.",
    );
  };
  const openImport = (kind: Kind) => {
    setImportKind(kind);
    setImportRecords([]);
    setImportError("");
    setMapping({});
    setFileName("");
  };
  const readFile = async (file: File) => {
    setImportError("");
    setImportRecords([]);
    if (!/\.csv$/i.test(file.name)) {
      setImportError(
        "Для этой версии нужен CSV UTF-8. В Google Sheets выбери «Файл → Скачать → CSV».",
      );
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setImportError("Файл больше 5 МБ. Раздели выгрузку на отдельные листы.");
      return;
    }
    try {
      const text = await file.text();
      const result = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: "greedy",
        transformHeader: (h: string) => h.trim().replace(/^\ufeff/, ""),
      });
      if (result.errors.length)
        throw new Error(
          "Не удалось разобрать CSV: проверь заголовки и разделители.",
        );
      if (!result.data.length || result.data.length > 10000)
        throw new Error("Нужно от 1 до 10 000 строк.");
      setImportRecords(result.data);
      setFileName(file.name);
      const headers = result.meta.fields || [];
      const initial: Record<string, string> = {};
      for (const f of importFields[importKind!])
        initial[f.key] =
          headers.find((h) => h === f.label || h === f.key) || "";
      setMapping(initial);
    } catch (err) {
      setImportError((err as Error).message);
    }
  };
  const commitImport = () => {
    if (!importKind) return;
    try {
      const next = importRows(real, importKind, importRecords, mapping);
      setReal(next);
      writeStorage("ritm-real-v1", next);
      const updated = sources.map((s) =>
        s.id === importKind
          ? {
              ...s,
              state: "imported" as const,
              rows: importRecords.length,
              importedAt: new Date().toISOString(),
            }
          : s,
      );
      setSources(updated);
      writeStorage("ritm-sources-v1", updated);
      setMode("imported");
      const importedDates =
        importKind === "assembly"
          ? next.work.map((w) => w.date)
          : importKind === "printing"
            ? next.rolls.map((r) => r.date)
            : next.stock.map((r) => r.date);
      const latest = importedDates.sort().at(-1);
      if (latest) setDate(latest);
      setEmployee(next.employees[0]?.id || "");
      setImportKind(null);
      setToast(
        `Загружено ${num(importRecords.length)} строк. Демонстрационные данные исключены.`,
      );
    } catch (err) {
      setImportError((err as Error).message);
    }
  };
  const sourceLink = (kind: Kind) => {
    const url =
      kind === "printing"
        ? PRINTING_URL
        : sources.find((s) => s.id === kind)?.url;
    return url ? (
      <a
        className="button secondary"
        href={url}
        target="_blank"
        rel="noreferrer"
      >
        <ArrowSquareOut size={17} />
        Открыть исходную таблицу
      </a>
    ) : (
      <Button onClick={() => go("sources")}>Настроить источник</Button>
    );
  };
  const liveSupplyPanel = (
    <section className="panel">
      <div className="panel-heading">
        <h2>Печать по поставкам</h2>
        <small>За всё время · план из J и O · факт из записей выпуска</small>
      </div>
      <DataTable
        rows={supplyPrintingRows}
        rowKey={(r) => String(r.sheetId)}
        label="Печать всех поставок"
        pageSize={25}
        columns={[
          {
            id: "name",
            label: "Поставка",
            render: (r) => (
              <a
                href={`${PRINTING_URL}#gid=${r.sheetId}`}
                target="_blank"
                rel="noreferrer"
              >
                {r.name}
              </a>
            ),
          },
          { id: "orders", label: "Заказов", render: (r) => num(r.orders) },
          { id: "plan", label: "План, шт.", render: (r) => num(r.plan) },
          {
            id: "plannedArea",
            label: "План, м²",
            render: (r) => num(r.plannedArea, 2),
          },
          {
            id: "quantity",
            label: "Учтено, шт.",
            render: (r) => num(r.quantity),
          },
          {
            id: "area",
            label: "Учтено, м²",
            render: (r) => <strong>{num(r.area, 2)}</strong>,
          },
        ]}
      />
    </section>
  );
  const metric = (
    label: string,
    value: string,
    Icon: typeof Cube,
    note?: string,
  ) => (
    <div className="metric">
      <div className="metric-icon">
        <Icon size={26} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {note && <small>{note}</small>}
      </div>
    </div>
  );
  const staffColumns = [
    {
      id: "name",
      label: "Сотрудник",
      render: (e: (typeof scoreRows)[number]) => <strong>{e.name}</strong>,
      sort: (e: Employee) => e.name,
    },
    {
      id: "score",
      label: period === "day" ? "Коэффициент" : "Средний за рабочий день",
      render: (e: (typeof scoreRows)[number]) => (
        <strong
          className={
            e.value === null ? "muted" : e.value >= 1 ? "green" : "amber"
          }
        >
          {e.value === null ? "—" : num(e.value, 2)}
        </strong>
      ),
      sort: (e: (typeof scoreRows)[number]) => e.value ?? -1,
    },
    {
      id: "left",
      label: "До цели",
      render: (e: (typeof scoreRows)[number]) =>
        e.value === null ? "—" : e.value >= 1 ? "—" : num(1 - e.value, 2),
    },
    {
      id: "state",
      label: "Состояние",
      render: (e: (typeof scoreRows)[number]) => (
        <Badge
          tone={
            e.value === null ? "neutral" : e.value >= 1 ? "success" : "warning"
          }
        >
          {e.value === null
            ? "Нет данных"
            : e.value >= 1
              ? "Цель достигнута"
              : "Текущий результат"}
        </Badge>
      ),
    },
  ];
  const supplyTable = (
    <DataTable
      rows={data.supplies.filter((s) =>
        contains(`${s.name} ${s.id} ${s.market}`),
      )}
      label="Поставки и этапы"
      rowKey={(s) => s.id}
      onSelect={(s) => {
        setSupplyId(s.id);
        go("supplies");
      }}
      columns={[
        {
          id: "name",
          label: "Поставка",
          render: (s) => (
            <div className="supply-title">
              <Badge tone={s.market === "Ozon" ? "ozon" : "wb"}>
                {s.market}
              </Badge>
              <div>
                <strong>{s.name}</strong>
                <small>{s.id}</small>
              </div>
            </div>
          ),
        },
        {
          id: "arrival",
          label: "Прибытие",
          render: (s) => <strong>{shortDate(s.arrival)}</strong>,
          sort: (s) => s.arrival,
        },
        {
          id: "plan",
          label: "План, шт.",
          render: (s) => num(lineTotals(s).plan),
        },
        ...(["printed", "cut", "packed"] as const).map((key, i) => ({
          id: key,
          label: ["Печать", "Резка", "Упаковка"][i],
          render: (s: Supply) => (
            <Progress value={lineTotals(s)[key]} plan={lineTotals(s).plan} />
          ),
        })),
        {
          id: "remaining",
          label: "Осталось упаковать",
          render: (s) =>
            num(Math.max(0, lineTotals(s).plan - lineTotals(s).packed)),
        },
      ]}
    />
  );
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        К содержимому
      </a>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="Закрыть меню"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? "open" : ""}`}>
        <a
          className="wordmark"
          href="?page=overview"
          onClick={(e) => {
            e.preventDefault();
            go("overview");
          }}
        >
          RITM<span>/</span>
        </a>
        <p className="sidebar-subtitle">
          Управление производством
          <br />
          для WB / Ozon
        </p>
        <nav id="primary-navigation" aria-label="Основное меню">
          {NAV.map((n) => (
            <a
              key={n.id}
              href={`?page=${n.id}`}
              aria-current={page === n.id ? "page" : undefined}
              className={page === n.id ? "nav-link active" : "nav-link"}
              onClick={(e) => {
                e.preventDefault();
                go(n.id);
              }}
            >
              <n.icon size={22} />
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="profile-initial">КЗ</span>
          <div>
            <strong>Кирилл</strong>
            <small>Управление</small>
          </div>
          <Badge tone="nav-version">v0.1</Badge>
        </div>
      </aside>
      <main id="main">
        <header className="page-header">
          <div>
            <div className="title-line">
              <button
                className="button mobile-menu"
                aria-label="Открыть меню"
                aria-expanded={sidebar}
                aria-controls="primary-navigation"
                onClick={() => setSidebar(true)}
              >
                <List size={18} />
                <span>Меню</span>
              </button>
              <h1>{TITLES[page]}</h1>
              <Badge tone={mode === "demo" ? "warning" : "info"}>
                {mode === "demo"
                  ? "Демо-данные"
                  : live.value
                    ? "Рабочие данные"
                    : "Подключение"}
              </Badge>
            </div>
            <p>{SUBTITLES[page]}</p>
          </div>
          <div className="header-controls">
            <div
              className="segments"
              role="group"
              aria-label="Период показателей"
            >
              {(["day", "week", "month"] as Period[]).map((p, i) => (
                <button
                  key={p}
                  aria-pressed={period === p}
                  className={period === p ? "selected" : ""}
                  onClick={() => setPeriod(p)}
                >
                  {["День", "Неделя", "Месяц"][i]}
                </button>
              ))}
            </div>
            <label className="date-control">
              <CalendarBlank size={18} />
              <input
                aria-label="Дата показателей"
                type="date"
                value={date}
                onChange={(e) => {
                  if (e.target.value) setDate(e.target.value);
                }}
              />
            </label>
          </div>
        </header>
        <div className="context-bar">
          {page !== "sources" && (
            <span>
              {mode === "demo" ? (
                <>Показан демонстрационный пример на {shortDate(date)}.</>
              ) : (
                <>
                  {live.loading
                    ? "Читаю рабочую таблицу…"
                    : live.error
                      ? live.value
                        ? "Обновление не удалось · показаны последние полученные данные"
                        : "Таблица недоступна"
                      : live.value
                        ? `Печать подключена · ${live.value.sheets.length} листов · обновлено ${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(live.value.updatedAt))} · автообновление 5 мин`
                        : "Подключаю печать…"}
                </>
              )}
            </span>
          )}
          <div>
            <select
              aria-label="Режим данных"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as "demo" | "imported");
                setEmployee("");
                setSupplyId("");
                setQuery("");
              }}
            >
              <option value="demo">Демонстрация</option>
              <option value="imported">Рабочие данные</option>
            </select>
            <Button disabled={busy || live.loading} onClick={refresh}>
              <ArrowsClockwise size={17} className={busy ? "spin" : ""} />
              {busy || live.loading ? "Обновление" : "Обновить"}
            </Button>
          </div>
        </div>
        {page === "overview" && (
          <>
            <div className="metrics four">
              {metric(
                mode === "imported" ? "Листов поставок" : "Поставки в работе",
                num(
                  mode === "imported"
                    ? live.value?.sheets.length || 0
                    : data.supplies.filter(
                        (s) => lineTotals(s).shipped < lineTotals(s).plan,
                      ).length,
                ),
                Truck,
              )}
              {metric(
                "Готовность к отгрузке",
                totals.plan
                  ? num((totals.packed / totals.plan) * 100) + "%"
                  : "—",
                Package,
                "Упаковано / план поставок",
              )}
              {metric(
                "Сборщики достигли цели",
                `${achieved} из ${scoreRows.length}`,
                Users,
                period === "day"
                  ? "Дневная цель ≥ 1"
                  : "По среднему за рабочий день",
              )}
              {metric("Напечатано за период", num(area, 1) + " м²", Printer)}
            </div>
            <section className="panel">
              <div className="panel-heading">
                <h2>Поставки и этапы</h2>
                <Button kind="ghost" onClick={() => go("supplies")}>
                  Все поставки
                  <CaretRight size={17} />
                </Button>
              </div>
              {supplyTable}
            </section>
            <div className="split overview-bottom">
              <section className="panel">
                <div className="panel-heading">
                  <h2>Результаты сотрудников</h2>
                  <Button kind="ghost" onClick={() => go("assembly")}>
                    Подробнее
                    <CaretRight size={17} />
                  </Button>
                </div>
                <DataTable
                  rows={scoreRows.slice(0, 4)}
                  columns={staffColumns}
                  rowKey={(e) => e.id}
                  label="Результаты сотрудников"
                  onSelect={(e) => {
                    setEmployee(e.id);
                    go("assembly");
                  }}
                />
                <p className="panel-note">
                  Результат за текущий день может измениться до конца смены.
                </p>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <h2>Состояние данных</h2>
                </div>
                <div className="issue-list">
                  {sources
                    .filter((s) => s.id !== "printing")
                    .map((s) => (
                      <button
                        className="issue"
                        key={s.id}
                        onClick={() => go("sources")}
                      >
                        <Database size={23} />
                        <div>
                          <strong>{s.name}</strong>
                          <small>
                            {s.state === "imported"
                              ? `Загружено ${s.rows} строк`
                              : s.url
                                ? "Ссылка подготовлена. Чтение ещё не настроено."
                                : "Нужна свежая выгрузка остатков."}
                          </small>
                        </div>
                        <CaretRight size={19} />
                      </button>
                    ))}
                </div>
                <Notice>
                  Нет обновлений в таблице — повод проверить данные. Это не
                  подтверждение простоя.
                </Notice>
              </section>
            </div>
          </>
        )}
        {page === "assembly" && (
          <>
            <div className="metrics three">
              {metric(
                "Сотрудников с учётом работы",
                num(scoreRows.length),
                Users,
              )}
              {metric(
                "Достигли цели",
                `${achieved} из ${scoreRows.length}`,
                CheckCircle,
              )}
              {metric(
                "Нет результата",
                num(scoreRows.filter((s) => s.value === null).length),
                Database,
              )}
            </div>
            <div className="split staff-split">
              <section className="panel">
                <div className="panel-heading">
                  <h2>Результаты смены</h2>
                  <Search
                    label="Найти сотрудника"
                    value={query}
                    onChange={setQuery}
                  />
                </div>
                <DataTable
                  rows={scoreRows.filter((e) => contains(e.name))}
                  columns={staffColumns}
                  rowKey={(e) => e.id}
                  label="Коэффициенты сборщиков"
                  onSelect={(e) => setEmployee(e.id)}
                  selected={activeEmployee?.id}
                />
                <p className="panel-note">
                  Выходные и отсутствия исключаются из рабочих дней. Неизвестные
                  данные показываем отдельно.
                </p>
              </section>
              <section className="panel employee-panel">
                {activeEmployee && selectedScore ? (
                  <>
                    <div className="employee-heading">
                      <span className="avatar">
                        {activeEmployee.name
                          .split(" ")
                          .map((s) => s[0])
                          .slice(0, 2)
                          .join("")}
                      </span>
                      <div>
                        <h2>{activeEmployee.name}</h2>
                        <p>Сборщик</p>
                      </div>
                    </div>
                    <div className="employee-score">
                      <strong>
                        {selectedScore.value === null
                          ? "—"
                          : num(selectedScore.value, 2)}
                      </strong>
                      <div>
                        <b>
                          {selectedScore.value === null
                            ? "Нет результата"
                            : num(selectedScore.value * 100) + "%"}
                        </b>
                        <span>
                          {period === "day"
                            ? "дневной нормы"
                            : "среднее за рабочий день"}
                        </span>
                      </div>
                    </div>
                    {selectedScore.value !== null && (
                      <div className="goal-progress">
                        <Progress
                          value={selectedScore.value}
                          plan={1}
                          showValue={false}
                        />
                        <small>Цель 1,00</small>
                      </div>
                    )}
                    <h3>Вклад операций {period !== "day" && "за период"}</h3>
                    <div className="operation-list">
                      {(["Резка", "Ручная работа", "Упаковка"] as const).map(
                        (o) => (
                          <div key={o}>
                            <span>{o}</span>
                            <strong>
                              {num(
                                selectedScore.work
                                  .filter((w) => w.operation === o)
                                  .reduce((s, w) => s + coefficient(w), 0),
                                2,
                              )}
                            </strong>
                          </div>
                        ),
                      )}
                      <div className="total">
                        <b>Итого коэффициент</b>
                        <strong>{num(selectedScore.total, 2)}</strong>
                      </div>
                    </div>
                    <div className="section-label">
                      <h3>Выполнение по дням</h3>
                      <small>
                        {new Intl.DateTimeFormat("ru-RU", {
                          month: "long",
                          year: "numeric",
                          timeZone: "Europe/Moscow",
                        }).format(new Date(date + "T12:00:00Z"))}
                      </small>
                    </div>
                    <div className="calendar-days">
                      {Array.from({ length: 7 }, (_, i) => {
                        const day = Math.max(1, Number(date.slice(8)) - 6) + i;
                        const d = `${date.slice(0, 8)}${String(day).padStart(2, "0")}`;
                        const shift = data.shifts.find(
                          (s) =>
                            s.date === d && s.employee === activeEmployee.id,
                        );
                        const result = employeeResult(
                          data,
                          activeEmployee.id,
                          d,
                          "day",
                        );
                        return (
                          <button
                            key={d}
                            className={`day-cell ${d === date ? "current" : ""}`}
                            onClick={() => {
                              setDate(d);
                              setPeriod("day");
                            }}
                          >
                            <small>
                              {day}
                              <span>
                                {new Intl.DateTimeFormat("ru-RU", {
                                  weekday: "short",
                                  timeZone: "Europe/Moscow",
                                }).format(new Date(d + "T12:00:00Z"))}
                              </span>
                            </small>
                            {shift && !shift.working ? (
                              <span className="calendar-value off">
                                Выходной
                              </span>
                            ) : (
                              <span
                                className={`calendar-value ${result.value === null ? "off" : result.value >= 1 ? "success" : "warning"}`}
                              >
                                {result.value === null
                                  ? "—"
                                  : num(result.value, 2)}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mini-summary">
                      <div>
                        <small>Рабочих дней в периоде</small>
                        <b>{selectedScore.working || "Нет учёта выходов"}</b>
                      </div>
                      <div>
                        <small>Цель достигнута</small>
                        <b>
                          {selectedScore.working
                            ? `${selectedScore.complete} из ${selectedScore.working}`
                            : "—"}
                        </b>
                      </div>
                    </div>
                    {!data.shifts.length && (
                      <Notice>
                        Для среднего за рабочий день нужен учёт выходов на
                        смену.
                      </Notice>
                    )}
                  </>
                ) : (
                  <Empty title="Нет записей сборщиков">
                    Загрузи таблицу операций в разделе «Источники данных».
                  </Empty>
                )}
              </section>
            </div>
            <section className="panel">
              <div className="panel-heading">
                <h2>Выполненные операции</h2>
                {sourceLink("assembly")}
              </div>
              <DataTable
                rows={selectedScore?.work || []}
                rowKey={(w) => w.id}
                label="Расшифровка коэффициента"
                columns={[
                  {
                    id: "date",
                    label: "Дата",
                    render: (w) => shortDate(w.date),
                    sort: (w) => w.date,
                  },
                  {
                    id: "article",
                    label: "Артикул",
                    render: (w) => <strong>{w.article}</strong>,
                  },
                  { id: "op", label: "Операция", render: (w) => w.operation },
                  {
                    id: "qty",
                    label: "Количество",
                    render: (w) => num(w.quantity),
                  },
                  { id: "norm", label: "Норма", render: (w) => num(w.norm) },
                  {
                    id: "coef",
                    label: "Коэффициент",
                    render: (w) => (
                      <strong className="green">
                        {num(coefficient(w), 2)}
                      </strong>
                    ),
                  },
                  {
                    id: "source",
                    label: "Источник",
                    render: (w) => <small>{w.source}</small>,
                  },
                ]}
              />
            </section>
          </>
        )}
        {page === "printing" && (
          <>
            {mode === "imported" && live.error && (
              <Notice tone="warning">
                {live.error}{" "}
                {live.value && "Показаны данные последнего успешного чтения."}
              </Notice>
            )}
            {mode === "imported" && !live.value ? (
              <section className="panel">
                <Empty
                  title={
                    live.loading
                      ? "Читаю рабочую таблицу"
                      : "Нет подключения к таблице"
                  }
                >
                  {live.loading
                    ? "Загружаю все поставки и журнал выпуска."
                    : "Повторите обновление. Показатели появятся после успешного чтения."}
                </Empty>
              </section>
            ) : (
              <>
                {mode === "imported" && (
                  <div className="panel-heading">
                    <h2>Все поставки</h2>
                    <select
                      aria-label="Поставка печати"
                      value={supplyFilter}
                      onChange={(e) => setSupplyFilter(e.target.value)}
                    >
                      <option value="all">Все 11 поставок</option>
                      {live.value?.sheets.map((s) => (
                        <option key={s.sheetId} value={s.name}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="metrics three">
                  {metric("Учтено за период", num(area, 2) + " м²", Printer)}
                  {metric("Записей выпуска", num(rolls.length), Package)}
                  {metric("Сотрудников", num(printerPeople.length), Users)}
                </div>
                <div className="split">
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Выработка по сотрудникам</h2>
                      <select
                        aria-label="Участок печати"
                        value={site}
                        onChange={(e) => setSite(e.target.value)}
                      >
                        <option>Все участки</option>
                        {[...new Set(data.rolls.map((r) => r.site))].map(
                          (s) => (
                            <option key={s}>{s}</option>
                          ),
                        )}
                      </select>
                    </div>
                    <div className="printer-rows">
                      {printerPeople.map((e) => {
                        const own = rolls.filter((r) => r.employee === e.id);
                        const value = own.reduce((s, r) => s + r.area, 0);
                        return (
                          <button
                            key={e.id}
                            className={`printer-row ${printer === e.id ? "selected" : ""}`}
                            onClick={() => setPrinter(e.id)}
                          >
                            <span className="avatar">{e.name[0]}</span>
                            <strong>{e.name}</strong>
                            <div>
                              <b>{num(value, 2)} м²</b>
                              <Progress
                                value={value}
                                plan={area}
                                showValue={false}
                              />
                            </div>
                            <small>{own.length} записей</small>
                            <CaretRight size={18} />
                          </button>
                        );
                      })}
                      {!printerPeople.length && (
                        <Empty title="Нет записей выпуска" />
                      )}
                    </div>
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>По участкам</h2>
                    </div>
                    <div className="site-rows">
                      {[...new Set(rolls.map((r) => r.site))].map((s) => {
                        const value = rolls
                          .filter((r) => r.site === s)
                          .reduce((a, r) => a + r.area, 0);
                        return (
                          <div key={s}>
                            <strong>{s}</strong>
                            <b>{num(value, 2)} м²</b>
                            <Progress
                              value={value}
                              plan={area}
                              showValue={false}
                            />
                          </div>
                        );
                      })}
                      {!rolls.length && <Empty />}
                      <div className="site-total">
                        <strong>Итого</strong>
                        <b>{num(area, 2)} м²</b>
                      </div>
                    </div>
                  </section>
                </div>
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Динамика по дням</h2>
                    <small>Последние даты с выполненной печатью</small>
                  </div>
                  <div className="daily-strip">
                    {[
                      ...new Set(
                        data.rolls
                          .filter(
                            (r) =>
                              r.date <= date &&
                              (site === "Все участки" || r.site === site),
                          )
                          .map((r) => r.date),
                      ),
                    ]
                      .sort()
                      .slice(-4)
                      .map((d) => (
                        <button
                          key={d}
                          className={d === date ? "active" : ""}
                          onClick={() => {
                            setDate(d);
                            setPeriod("day");
                          }}
                        >
                          <span>{shortDate(d)}</span>
                          <strong>
                            {num(
                              data.rolls
                                .filter(
                                  (r) =>
                                    r.date === d &&
                                    (site === "Все участки" || r.site === site),
                                )
                                .reduce((s, r) => s + r.area, 0),
                              1,
                            )}{" "}
                            м²
                          </strong>
                        </button>
                      ))}
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Выпуск сотрудника</h2>
                    <div className="table-tools">
                      <select
                        aria-label="Печатник"
                        value={printer}
                        onChange={(e) => setPrinter(e.target.value)}
                      >
                        <option value="all">Все сотрудники</option>
                        {printerPeople.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </select>
                      <Search
                        label="Артикул или номер рулона"
                        value={query}
                        onChange={setQuery}
                      />
                    </div>
                  </div>
                  <DataTable
                    rows={rolls.filter(
                      (r) =>
                        (printer === "all" || r.employee === printer) &&
                        contains(`${r.roll || r.id} ${r.article}`),
                    )}
                    rowKey={(r) => r.id}
                    label="Фактический выпуск"
                    columns={[
                      {
                        id: "id",
                        label: "Рулон",
                        render: (r) => <strong>{r.roll || r.id}</strong>,
                      },
                      {
                        id: "article",
                        label: "Артикул",
                        render: (r) => r.article,
                      },
                      {
                        id: "employee",
                        label: "Сотрудник",
                        render: (r) =>
                          data.employees.find((e) => e.id === r.employee)
                            ?.name || "Не указан",
                      },
                      {
                        id: "qty",
                        label: "Количество, шт.",
                        render: (r) => num(r.quantity),
                      },
                      {
                        id: "area",
                        label: "Площадь, м²",
                        render: (r) => <strong>{num(r.area, 2)}</strong>,
                        sort: (r) => r.area,
                      },
                      {
                        id: "site",
                        label: "Поставка",
                        render: (r) => <small>{r.source}</small>,
                      },
                      {
                        id: "date",
                        label: "Дата выпуска",
                        render: (r) => (
                          <>
                            <span>{shortDate(r.date)}</span>
                            <small>{r.time}</small>
                          </>
                        ),
                        sort: (r) => r.date + r.time,
                      },
                    ]}
                  />
                  <div className="panel-footer">
                    <small>
                      Источник KPI — «Журнал выпуска», операция «Печать».
                    </small>
                    {sourceLink("printing")}
                  </div>
                </section>
                {mode === "imported" && liveSupplyPanel}
                {mode === "imported" && (
                  <Notice>
                    Площадь берётся из столбца L журнала, день выпуска — из
                    столбца B. Лист «Выпуск по дням» суммирует эти же записи.
                    Ноль означает отсутствие записей о печати за выбранный
                    период.
                  </Notice>
                )}
                {mode === "imported" && !!live.value?.issues.length && (
                  <Notice tone="warning">
                    Требуют сверки: {live.value.issues.length} записей.
                    Подробности в «Источниках».
                  </Notice>
                )}
                <Notice tone="warning">
                  Перепечатки: отдельный тип печати пока не учитывается. Для
                  разбивки потребуется соответствующая отметка в источнике.
                </Notice>
              </>
            )}
          </>
        )}
        {page === "production" && (
          <>
            <div className="toolbar">
              <Search
                label="Найти артикул или поставку"
                value={query}
                onChange={setQuery}
              />
              <Notice>
                Печать, резку и упаковку считаем отдельно по количеству.
              </Notice>
            </div>
            <section className="panel">
              <div className="panel-heading">
                <h2>Работа по артикулам</h2>
              </div>
              <DataTable
                rows={data.supplies
                  .flatMap((s) => s.lines.map((l) => ({ ...l, supply: s })))
                  .filter((l) => contains(l.article + " " + l.supply.name))}
                rowKey={(l) => l.supply.id + l.article}
                label="Производство по артикулам"
                onSelect={(l) => {
                  setSupplyId(l.supply.id);
                  go("supplies");
                }}
                columns={[
                  {
                    id: "article",
                    label: "Артикул",
                    render: (l) => <strong>{l.article}</strong>,
                    sort: (l) => l.article,
                  },
                  {
                    id: "supply",
                    label: "Поставка",
                    render: (l) => (
                      <>
                        <span>
                          {l.supply.market} · {l.supply.name}
                        </span>
                        <small>{l.supply.id}</small>
                      </>
                    ),
                  },
                  { id: "plan", label: "План", render: (l) => num(l.plan) },
                  {
                    id: "printed",
                    label: "Напечатано",
                    render: (l) => <Progress value={l.printed} plan={l.plan} />,
                  },
                  {
                    id: "cut",
                    label: "Порезано",
                    render: (l) => <Progress value={l.cut} plan={l.plan} />,
                  },
                  {
                    id: "packed",
                    label: "Упаковано",
                    render: (l) => <Progress value={l.packed} plan={l.plan} />,
                  },
                  {
                    id: "rest",
                    label: "Осталось упаковать",
                    render: (l) => num(Math.max(0, l.plan - l.packed)),
                  },
                ]}
              />
            </section>
            <Notice>
              В первой версии позиции поставок связываются вручную. Одинаковый
              артикул в разных поставках учитывается отдельно.
            </Notice>
          </>
        )}
        {page === "stock" && (
          <>
            <div className="metrics three">
              {metric("Артикулов на складе", num(stockRows.length), Cube)}
              {metric(
                "Готовый товар",
                num(stockRows.reduce((s, r) => s + r.quantity, 0)) + " шт.",
                Package,
              )}
              {metric(
                "Свободный остаток",
                num(stockRows.reduce((s, r) => s + r.free, 0)) + " шт.",
                CheckCircle,
              )}
            </div>
            <section className="panel">
              <div className="panel-heading">
                <h2>Готовые остатки</h2>
                <Search
                  label="Найти артикул или ячейку"
                  value={query}
                  onChange={setQuery}
                />
                <Button
                  onClick={() => {
                    go("sources");
                    openImport("stock");
                  }}
                >
                  <UploadSimple size={17} />
                  Загрузить остатки
                </Button>
              </div>
              <DataTable
                rows={stockRows.filter((r) =>
                  contains(
                    r.article + " " + r.locations.map((l) => l.cell).join(" "),
                  ),
                )}
                rowKey={(r) => r.article}
                label="Складские остатки"
                columns={[
                  {
                    id: "article",
                    label: "Артикул",
                    render: (r) => <strong>{r.article}</strong>,
                    sort: (r) => r.article,
                  },
                  {
                    id: "stock",
                    label: "Общий остаток",
                    render: (r) => num(r.quantity),
                    sort: (r) => r.quantity,
                  },
                  {
                    id: "reserved",
                    label: "Резерв поставок",
                    render: (r) => num(r.reserved),
                  },
                  {
                    id: "free",
                    label: "Свободно",
                    render: (r) => (
                      <strong className="green">{num(r.free)}</strong>
                    ),
                  },
                  {
                    id: "locations",
                    label: "Ячейки",
                    render: (r) => (
                      <div className="locations">
                        {r.locations.map((l, i) => (
                          <span key={l.cell + i}>
                            {l.cell} <b>{num(l.quantity)}</b>
                          </span>
                        ))}
                      </div>
                    ),
                  },
                  {
                    id: "date",
                    label: "Дата выгрузки",
                    render: (r) => shortDate(r.locations[0].date),
                  },
                ]}
              />
            </section>
            <Notice>
              Остатки — готовый товар. Новый файл заменяет предыдущий снимок, а
              количество по разным ячейкам складывается.
            </Notice>
          </>
        )}
        {page === "supplies" && (
          <>
            {mode === "imported" &&
              (live.value ? (
                liveSupplyPanel
              ) : (
                <section className="panel">
                  <Empty
                    title={
                      live.loading
                        ? "Читаю поставки"
                        : "Нет подключения к таблице"
                    }
                  >
                    {live.error || "Загружаю все листы рабочей таблицы."}
                  </Empty>
                </section>
              ))}
            {mode === "imported" && (
              <Notice>
                Каждый рабочий лист — отдельная поставка. Здесь показаны план и
                подтверждённый выпуск печати. Порезку, упаковку и отгрузку
                подключим отдельно.
              </Notice>
            )}
            {(mode === "demo" || data.supplies.length > 0) && (
              <>
                <div className="toolbar">
                  <select
                    aria-label="Маркетплейс поставки"
                    value={market}
                    onChange={(e) => setMarket(e.target.value)}
                  >
                    <option>Все маркетплейсы</option>
                    <option>Ozon</option>
                    <option>WB</option>
                  </select>
                  <Button kind="primary" onClick={startCreate}>
                    <Plus size={18} />
                    Добавить поставку
                  </Button>
                </div>
                <div className="supplies-layout">
                  <section className="panel supplies-list">
                    <div
                      className="segments list-tabs"
                      role="group"
                      aria-label="Состояние поставок"
                    >
                      <button
                        aria-pressed={!completed}
                        className={!completed ? "selected" : ""}
                        onClick={() => setCompleted(false)}
                      >
                        В работе
                      </button>
                      <button
                        aria-pressed={completed}
                        className={completed ? "selected" : ""}
                        onClick={() => setCompleted(true)}
                      >
                        Завершённые
                      </button>
                    </div>
                    <Search
                      label="Найти поставку"
                      value={query}
                      onChange={setQuery}
                    />
                    {data.supplies
                      .filter(
                        (s) =>
                          (market === "Все маркетплейсы" ||
                            s.market === market) &&
                          (completed
                            ? lineTotals(s).shipped >= lineTotals(s).plan
                            : lineTotals(s).shipped < lineTotals(s).plan) &&
                          contains(s.name + " " + s.id),
                      )
                      .map((s) => {
                        const t = lineTotals(s);
                        return (
                          <button
                            className={`supply-list-item ${supply?.id === s.id ? "selected" : ""}`}
                            key={s.id}
                            onClick={() => setSupplyId(s.id)}
                          >
                            <Badge tone={s.market === "Ozon" ? "ozon" : "wb"}>
                              {s.market}
                            </Badge>
                            <div>
                              <strong>
                                {s.market} · {s.name}
                              </strong>
                              <small>{s.id}</small>
                              <span>Прибытие {shortDate(s.arrival)}</span>
                              <small>
                                Упаковано{" "}
                                <b>{num((t.packed / t.plan) * 100)}%</b>
                              </small>
                              <Progress
                                value={t.packed}
                                plan={t.plan}
                                showValue={false}
                              />
                            </div>
                            <CaretRight size={17} />
                          </button>
                        );
                      })}
                    {!data.supplies.some(
                      (s) =>
                        (market === "Все маркетплейсы" ||
                          s.market === market) &&
                        (completed
                          ? lineTotals(s).shipped >= lineTotals(s).plan
                          : lineTotals(s).shipped < lineTotals(s).plan) &&
                        contains(s.name + " " + s.id),
                    ) && (
                      <Empty title="Нет поставок">
                        Добавь поставку или измени фильтры.
                      </Empty>
                    )}
                  </section>
                  <div className="supply-detail">
                    {supply ? (
                      <>
                        <section className="panel">
                          <div className="panel-heading">
                            <div className="supply-detail-title">
                              <Badge
                                tone={supply.market === "Ozon" ? "ozon" : "wb"}
                              >
                                {supply.market}
                              </Badge>
                              <div>
                                <h2>
                                  {supply.market} · {supply.name}
                                </h2>
                                <p>Поставка {supply.id}</p>
                              </div>
                            </div>
                            <Badge tone="success">
                              {lineTotals(supply).shipped >=
                              lineTotals(supply).plan
                                ? "Отправлена"
                                : "В работе"}
                            </Badge>
                          </div>
                          <div className="metadata">
                            {[
                              ["Магазин", supply.store],
                              ["Склад назначения", supply.destination],
                              ["Прибытие", shortDate(supply.arrival)],
                              [
                                "Готовность к отправке",
                                shortDate(supply.ready),
                              ],
                              ["Ответственный", supply.owner],
                            ].map(([label, value]) => (
                              <div key={label}>
                                <small>{label}</small>
                                <strong>{value}</strong>
                              </div>
                            ))}
                          </div>
                        </section>
                        <section className="panel">
                          <div className="panel-heading">
                            <h2>Готовность по этапам</h2>
                          </div>
                          <div className="stage-grid">
                            {(
                              ["printed", "cut", "packed", "shipped"] as const
                            ).map((key, i) => {
                              const t = lineTotals(supply);
                              const Icon = [Printer, Scissors, Package, Truck][
                                i
                              ];
                              return (
                                <div className="stage" key={key}>
                                  <Icon size={25} />
                                  <div>
                                    <strong>
                                      {
                                        [
                                          "Печать",
                                          "Резка",
                                          "Упаковка",
                                          "Отправлено",
                                        ][i]
                                      }
                                    </strong>
                                    <Progress value={t[key]} plan={t.plan} />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <Notice>
                            Срок готовности задан вручную. Прогноз завершения
                            ещё не рассчитывается.
                          </Notice>
                        </section>
                        <section className="panel">
                          <div className="panel-heading">
                            <h2>Состав поставки</h2>
                            <Button
                              onClick={() =>
                                download(
                                  `${supply.id}.csv`,
                                  "Артикул;План;Напечатано;Порезано;Упаковано;Резерв\n" +
                                    supply.lines
                                      .map((l) =>
                                        [
                                          l.article,
                                          l.plan,
                                          l.printed,
                                          l.cut,
                                          l.packed,
                                          l.reserved,
                                        ].join(";"),
                                      )
                                      .join("\n"),
                                )
                              }
                            >
                              <DownloadSimple size={17} />
                              CSV
                            </Button>
                          </div>
                          <DataTable
                            rows={supply.lines}
                            rowKey={(l) => l.article}
                            label="Артикулы поставки"
                            columns={[
                              {
                                id: "article",
                                label: "Артикул",
                                render: (l) => <strong>{l.article}</strong>,
                              },
                              {
                                id: "plan",
                                label: "План, шт.",
                                render: (l) => num(l.plan),
                              },
                              {
                                id: "stock",
                                label: "Свободно на складе",
                                render: (l) => num(freeStock(data, l.article)),
                              },
                              {
                                id: "reserved",
                                label: "Резерв",
                                render: (l) => num(l.reserved),
                              },
                              {
                                id: "print",
                                label: "Напечатано",
                                render: (l) => num(l.printed),
                              },
                              {
                                id: "cut",
                                label: "Порезано",
                                render: (l) => num(l.cut),
                              },
                              {
                                id: "packed",
                                label: "Упаковано",
                                render: (l) => num(l.packed),
                              },
                              {
                                id: "rest",
                                label: "Осталось упаковать",
                                render: (l) =>
                                  num(Math.max(0, l.plan - l.packed)),
                              },
                            ]}
                          />
                          <div className="panel-footer">
                            <small>
                              Резерв не увеличивает упакованное количество до
                              подтверждения комплектования.
                            </small>
                            <Button
                              onClick={() => {
                                update(reserveSupply(data, supply.id));
                                setToast(
                                  "Свободный товар закреплён за поставкой в приложении. Складская таблица не изменялась.",
                                );
                              }}
                            >
                              Зарезервировать свободный товар
                            </Button>
                          </div>
                        </section>
                        <div className="split">
                          <section className="panel">
                            <div className="panel-heading">
                              <h2>Связь с исходными заданиями</h2>
                            </div>
                            <div className="source-detail">
                              <Database size={24} />
                              <p>
                                {mode === "demo"
                                  ? "Связи показаны на примере."
                                  : "Автоматическая связь ещё не настроена."}
                                <small>
                                  Для реальных поставок нужна привязка к
                                  заданиям печати и сборки.
                                </small>
                              </p>
                            </div>
                            <Button kind="ghost" onClick={() => go("sources")}>
                              Открыть источники
                              <CaretRight size={17} />
                            </Button>
                          </section>
                          <section className="panel">
                            <div className="panel-heading">
                              <h2>Отгрузка и приёмка</h2>
                            </div>
                            <div className="shipment-stages">
                              <span>
                                <Package size={19} />
                                Упаковка
                              </span>
                              <span>
                                <Truck size={19} />
                                Отправка
                              </span>
                              <span>
                                <CheckCircle size={19} />
                                Приёмка
                              </span>
                            </div>
                            <Notice>
                              Отправку и приёмку показываем после получения
                              соответствующих данных.
                            </Notice>
                          </section>
                        </div>
                      </>
                    ) : (
                      <section className="panel">
                        <Empty title="Добавь первую поставку">
                          Укажи артикулы, количество и дату прибытия.
                        </Empty>
                        <Button kind="primary" onClick={startCreate}>
                          <Plus size={18} />
                          Добавить поставку
                        </Button>
                      </section>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        )}
        {page === "sources" && (
          <>
            <div className="source-grid">
              {sources.map((s) => (
                <section className="panel source-card" key={s.id}>
                  <div className="source-card-title">
                    <span className="metric-icon">
                      <Database size={26} />
                    </span>
                    <Badge
                      tone={
                        s.id === "printing"
                          ? live.value
                            ? live.error
                              ? "warning"
                              : "success"
                            : live.error
                              ? "warning"
                              : "neutral"
                          : s.state === "imported"
                            ? "success"
                            : "neutral"
                      }
                    >
                      {s.id === "printing"
                        ? live.value
                          ? live.error
                            ? "Ошибка обновления"
                            : "Подключено"
                          : live.loading
                            ? "Подключаю…"
                            : live.error
                              ? "Нет связи"
                              : "Ожидает подключения"
                        : s.state === "imported"
                          ? "CSV загружен"
                          : "Не подключено"}
                    </Badge>
                  </div>
                  <h2>{s.name}</h2>
                  <p>
                    {s.id === "assembly"
                      ? "Операции, количества и нормы по сотрудникам."
                      : s.id === "printing"
                        ? "Журнал выпуска · площадь и сотрудник по каждой записи о печати."
                        : "Готовый товар с разбивкой по ячейкам."}
                  </p>
                  {s.state === "imported" && s.id !== "printing" && (
                    <div className="source-facts">
                      <b>{num(s.rows || 0)} строк</b>
                      <small>
                        Загружено{" "}
                        {new Intl.DateTimeFormat("ru-RU", {
                          dateStyle: "short",
                          timeStyle: "short",
                          timeZone: "Europe/Moscow",
                        }).format(new Date(s.importedAt!))}
                      </small>
                    </div>
                  )}
                  {s.id === "printing" && (
                    <div className="source-facts">
                      <b>
                        {live.value
                          ? `${live.value.sheets.length} листов · ${live.value.supplies.length} заказов · ${live.value.events.length} записей выпуска`
                          : live.loading
                            ? "Читаю таблицу…"
                            : "Ожидаю чтения таблицы"}
                      </b>
                      {live.value && (
                        <small>
                          Последнее успешное чтение:{" "}
                          {new Intl.DateTimeFormat("ru-RU", {
                            dateStyle: "short",
                            timeStyle: "short",
                            timeZone: "Europe/Moscow",
                          }).format(new Date(live.value.updatedAt))}{" "}
                          (Москва)
                        </small>
                      )}
                    </div>
                  )}
                  {s.id === "printing" && live.error && (
                    <Notice tone="warning">{live.error}</Notice>
                  )}{" "}
                  {s.id !== "printing" && (
                    <div className="source-url">
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer">
                          Открыть Google-таблицу
                          <ArrowSquareOut size={15} />
                        </a>
                      ) : (
                        <span>Ссылка не задана</span>
                      )}
                    </div>
                  )}
                  <div className="source-actions">
                    {s.id === "printing" ? (
                      <>
                        {sourceLink("printing")}
                        <Button
                          disabled={live.loading}
                          onClick={() => void live.reload()}
                        >
                          Обновить таблицу
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          onClick={() => {
                            setSourceEdit(s.id);
                            setUrlDraft(s.url);
                            setImportError("");
                          }}
                        >
                          Настроить ссылку
                        </Button>
                        <Button kind="primary" onClick={() => openImport(s.id)}>
                          <UploadSimple size={17} />
                          Загрузить CSV
                        </Button>
                      </>
                    )}
                  </div>
                  {s.id === "printing" && !!live.value?.issues.length && (
                    <DataTable
                      rows={live.value.issues}
                      rowKey={(r) => `${r.source}:${r.row}:${r.message}`}
                      label="Записи для сверки"
                      columns={[
                        {
                          id: "source",
                          label: "Лист",
                          render: (r) => r.source,
                        },
                        { id: "row", label: "Строка", render: (r) => r.row },
                        {
                          id: "message",
                          label: "Причина",
                          render: (r) => r.message,
                        },
                      ]}
                    />
                  )}
                  {s.id !== "printing" && (
                    <button
                      className="text-button"
                      onClick={() => {
                        const fields = importFields[s.id];
                        const examples: Record<Kind, string[]> = {
                          assembly: [
                            "OP-001",
                            "Анна Иванова",
                            ANCHOR,
                            "ST0021.A7447",
                            "Упаковка",
                            "150",
                            "250",
                          ],
                          printing: [
                            "NY-001-Д1",
                            "Дмитрий",
                            ANCHOR,
                            "ST0021.A7447",
                            "200",
                            "18,6",
                            "Красное здание",
                          ],
                          stock: ["ST0021.A7447", "Б-01-03", "200", ANCHOR],
                        };
                        download(
                          `ritm-${s.id}-template.csv`,
                          fields.map((f) => f.label).join(";") +
                            "\n" +
                            examples[s.id].join(";"),
                        );
                      }}
                    >
                      Скачать пример CSV
                    </button>
                  )}
                </section>
              ))}
            </div>
            <section className="panel">
              <div className="panel-heading">
                <h2>Как подключаем реальные данные</h2>
              </div>
              <div className="connection-steps">
                <div>
                  <b>1</b>
                  <h3>Указываем источники</h3>
                  <p>Таблицы, листы и нужные столбцы.</p>
                </div>
                <div>
                  <b>2</b>
                  <h3>Проверяем расчёты</h3>
                  <p>
                    Коэффициент, площадь и количества сверяем с исходными
                    строками.
                  </p>
                </div>
                <div>
                  <b>3</b>
                  <h3>Включаем обновление</h3>
                  <p>Настраиваем чтение на сервере и сохранение истории.</p>
                </div>
              </div>
            </section>
            <Notice tone="warning">
              Сводные KPI из «FBO итого» и подробные операции нельзя складывать
              между собой. В этой версии CSV сборщиков содержит только исходные
              операции.
            </Notice>
          </>
        )}
      </main>
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div className="toast">
            <CheckCircle size={21} />
            <span>{toast}</span>
            <button
              aria-label="Закрыть уведомление"
              onClick={() => setToast("")}
            >
              <X size={18} />
            </button>
          </div>
        )}
      </div>
      <Modal
        open={create}
        onClose={closeCreate}
        title={discard ? "Сохранить изменения?" : "Добавить поставку"}
        description={
          discard
            ? "В карточке есть несохранённые изменения."
            : "Карточка сохраняется в приложении. Задания в таблицы пока не направляются."
        }
      >
        {discard ? (
          <div className="modal-actions">
            <Button onClick={() => setDiscard(false)}>
              Продолжить заполнение
            </Button>
            <Button
              kind="danger"
              onClick={() => {
                setCreate(false);
                setDiscard(false);
              }}
            >
              Закрыть без сохранения
            </Button>
          </div>
        ) : (
          <form noValidate onSubmit={submitSupply}>
            <div className="form-grid">
              {(["name", "store", "destination", "owner"] as const).map(
                (key, i) => (
                  <Field
                    key={key}
                    label={
                      [
                        "Название",
                        "Магазин",
                        "Склад назначения",
                        "Ответственный",
                      ][i]
                    }
                    error={formErrors[key]}
                  >
                    <input
                      value={draft[key]}
                      aria-invalid={!!formErrors[key]}
                      onChange={(e) =>
                        setDraft({ ...draft, [key]: e.target.value })
                      }
                    />
                  </Field>
                ),
              )}
              <Field label="Маркетплейс">
                <select
                  value={draft.market}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      market: e.target.value as "Ozon" | "WB",
                    })
                  }
                >
                  <option>Ozon</option>
                  <option>WB</option>
                </select>
              </Field>
              <Field label="Дата прибытия" error={formErrors.arrival}>
                <input
                  type="date"
                  value={draft.arrival}
                  aria-invalid={!!formErrors.arrival}
                  onChange={(e) =>
                    setDraft({ ...draft, arrival: e.target.value })
                  }
                />
              </Field>
              <Field
                label="Срок готовности к отправке"
                error={formErrors.ready}
              >
                <input
                  type="date"
                  value={draft.ready}
                  aria-invalid={!!formErrors.ready}
                  onChange={(e) =>
                    setDraft({ ...draft, ready: e.target.value })
                  }
                />
              </Field>
            </div>
            <Field
              label="Артикулы и количества — по одной позиции на строку"
              error={formErrors.lines}
            >
              <textarea
                rows={6}
                style={{ resize: "none" }}
                value={draft.lines}
                aria-invalid={!!formErrors.lines}
                placeholder={"ST0021.A7447; 500\nST0043.A2180; 300"}
                onChange={(e) => setDraft({ ...draft, lines: e.target.value })}
              />
            </Field>
            <div className="modal-actions">
              <Button type="button" onClick={closeCreate}>
                Отмена
              </Button>
              <Button type="submit" kind="primary">
                Добавить поставку
              </Button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={sourceEdit !== null}
        onClose={() => setSourceEdit(null)}
        title="Настроить источник"
        description="Сохраняем адрес для следующего этапа. Сама ссылка не предоставляет приложению доступ к таблице."
      >
        <form noValidate onSubmit={saveSource}>
          <Field label="Ссылка на Google-таблицу" error={importError}>
            <input
              type="url"
              value={urlDraft}
              aria-invalid={!!importError}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
            />
          </Field>
          <div className="modal-actions">
            <Button type="button" onClick={() => setSourceEdit(null)}>
              Отмена
            </Button>
            <Button kind="primary" type="submit">
              Сохранить ссылку
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={importKind !== null}
        onClose={() => setImportKind(null)}
        title="Загрузить CSV"
        description="Проверим столбцы и строки до применения. Новый файл заменяет данные этого источника; демо-данные исключаются."
      >
        <div className="upload-box">
          <UploadSimple size={30} />
          <label className="button secondary">
            Выбрать CSV
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="Выбрать CSV"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
          </label>
          <small>UTF-8 · до 5 МБ · до 10 000 строк</small>
        </div>
        {fileName && (
          <p>
            <strong>{fileName}</strong> · {num(importRecords.length)} строк
          </p>
        )}
        {importKind && importRecords.length > 0 && (
          <>
            <h3>Сопоставление столбцов</h3>
            <div className="mapping-grid">
              {importFields[importKind].map((f) => (
                <Field key={f.key} label={f.label}>
                  <select
                    value={mapping[f.key] || ""}
                    onChange={(e) =>
                      setMapping({ ...mapping, [f.key]: e.target.value })
                    }
                  >
                    <option value="">Выбери столбец</option>
                    {Object.keys(importRecords[0]).map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            <div className="preview-import">
              <h3>Первые строки</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {Object.keys(importRecords[0]).map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {importRecords.slice(0, 3).map((r, i) => (
                      <tr key={i}>
                        {Object.values(r).map((value, j) => (
                          <td key={j}>{value}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
        {importError && (
          <div className="notice warning" role="alert">
            <Warning size={20} />
            {importError}
          </div>
        )}
        <div className="modal-actions">
          <Button onClick={() => setImportKind(null)}>Отмена</Button>
          <Button
            kind="primary"
            disabled={!importRecords.length}
            onClick={commitImport}
          >
            Проверить и загрузить
          </Button>
        </div>
      </Modal>
      {busy && (
        <div className="busy-indicator">
          <Busy />
        </div>
      )}
    </div>
  );
}
