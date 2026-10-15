import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  Bot,
  ChartBar,
  CheckCircle,
  CircleNotch,
  Cube,
  House,
  MagnifyingGlass,
  Package,
  Printer,
  Scissors,
  Truck,
  Users,
  Warning,
  X,
} from "./icons";

type Obj = Record<string, any>;
type Tab = "home" | "incidents" | "ai" | "reports";
type CheckMode = "fast" | "deep";
declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        expand?: () => void;
        colorScheme?: string;
        openLink?: (url: string) => void;
        BackButton?: { show: () => void; hide: () => void };
      };
    };
  }
}

const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const fmt = (v: unknown, digits = 0) =>
  number(v) === null
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits }).format(
        v as number,
      );
const moneyArea = (v: unknown) =>
  number(v) === null ? "—" : `${fmt(v, 2)} м²`;
const dateTime = (v: unknown) =>
  typeof v === "string" && v
    ? new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Europe/Moscow",
      }).format(new Date(v))
    : "не указано";
const text = (v: unknown, fallback = "Не подтверждено") =>
  typeof v === "string" && v.trim() ? v : fallback;
const checkStatusLabel = (v: unknown) =>
  (
    ({
      queued: "В очереди",
      running: "Выполняется",
      timing_out: "Завершает цикл",
      timed_out: "Тайм-аут",
      completed: "Завершена",
      completed_with_warnings: "С предупреждениями",
      failed: "Ошибка",
      interrupted: "Прервана",
    }) as Record<string, string>
  )[String(v)] || text(v, "Состояние неизвестно");
const severityLabel = (v: unknown) =>
  (
    ({
      critical: "Критическая",
      high: "Высокий приоритет",
      warning: "Предупреждение",
      medium: "Средний приоритет",
      low: "Низкий приоритет",
      критический: "Критическая",
    }) as Record<string, string>
  )[String(v).toLocaleLowerCase("ru-RU")] || text(v, "Проверить");
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const fmtCell = (v: unknown) =>
  typeof v === "string" ? v : v == null ? "Пусто" : String(v);
const formatDelta = (current: unknown, baseline: unknown) => {
  const difference = (number(current) ?? 0) - (number(baseline) ?? 0);
  return `${difference >= 0 ? "+" : ""}${fmt(difference)} шт.`;
};

async function api<T = Obj>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") headers.set("x-ritm-miniapp", "1");
  const response = await fetch(url, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(text(data.message, `Ошибка сервера (${response.status})`));
  return data as T;
}

function Metric({
  icon: Icon,
  label,
  value,
  caption,
  tone = "blue",
}: {
  icon: typeof Printer;
  label: string;
  value: string;
  caption?: string;
  tone?: string;
}) {
  return (
    <article className={`mini-metric ${tone}`}>
      <span className="mini-metric-icon">
        <Icon size={19} />
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        {caption && <p>{caption}</p>}
      </div>
    </article>
  );
}

function StatusPill({
  children,
  warning = false,
}: {
  children: React.ReactNode;
  warning?: boolean;
}) {
  return (
    <span className={`mini-pill ${warning ? "warning" : ""}`}>{children}</span>
  );
}

export function TelegramMiniApp() {
  const [tab, setTab] = useState<Tab>("home");
  const [view, setView] = useState("summary");
  const [dashboard, setDashboard] = useState<Obj | null>(null);
  const [session, setSession] = useState<Obj | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chat, setChat] = useState<
    { role: "assistant" | "user"; text: string }[]
  >([]);
  const [checkBusy, setCheckBusy] = useState<CheckMode | "">("");
  const [checkMessage, setCheckMessage] = useState("");
  const [incidentFilter, setIncidentFilter] = useState("");
  const [coefficientSearch, setCoefficientSearch] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState("Все сотрудники");
  const [coefficientDate, setCoefficientDate] = useState("Все даты");
  const [coefficientDocument, setCoefficientDocument] =
    useState("Все документы");
  const [sortDirection, setSortDirection] = useState<"desc" | "asc">("desc");
  const [repair, setRepair] = useState<Obj | null>(null);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairOperationStarted, setRepairOperationStarted] = useState(false);
  const [exclusiveAcknowledged, setExclusiveAcknowledged] = useState(false);
  const [historyAcknowledged, setHistoryAcknowledged] = useState(false);
  const [repairResult, setRepairResult] = useState("");
  const polling = useRef(false);

  const refresh = useCallback(async (quiet = false) => {
    try {
      if (!quiet) setLoading(true);
      setError("");
      let ownerSession: Obj;
      try {
        ownerSession = await api("/api/mini/session");
      } catch {
        const initData = window.Telegram?.WebApp?.initData;
        if (!initData)
          throw new Error(
            "Откройте RITM из личного Telegram через кнопку Mini App. В обычной вкладке Telegram initData недоступна.",
          );
        ownerSession = await api("/api/mini/session", {
          method: "POST",
          body: JSON.stringify({ initData }),
        });
      }
      setSession(ownerSession);
      const result = await api("/api/mini/dashboard");
      setDashboard(result);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось загрузить данные RITM.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const checkStatus = useCallback(async (mode: CheckMode) => {
    try {
      const result = await api(`/api/mini/checkstatus?mode=${mode}`);
      return obj(result.run);
    } catch {
      return {};
    }
  }, []);

  useEffect(() => {
    if (!dashboard?.checks) return;
    const timer = window.setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const [fast, deep] = await Promise.all([
          checkStatus("fast"),
          checkStatus("deep"),
        ]);
        const next = {
          ...dashboard,
          checks: { ...dashboard.checks, fast, deep },
        };
        setDashboard(next);
        if (checkBusy) {
          const run = checkBusy === "deep" ? deep : fast;
          if (
            [
              "completed",
              "completed_with_warnings",
              "failed",
              "timed_out",
              "interrupted",
            ].includes(run.status)
          ) {
            setCheckBusy("");
            setCheckMessage(
              `${checkBusy === "deep" ? "Глубокая" : "Быстрая"} проверка ${run.status === "completed" ? "завершена" : run.status === "completed_with_warnings" ? "завершена с предупреждениями" : "завершилась с ошибкой"}. ${text(run.resultSummary || run.error, "Откройте AI Center для подробного результата.")}`,
            );
            void refresh(true);
          }
        }
      } finally {
        polling.current = false;
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [dashboard, checkBusy, checkStatus, refresh]);

  useEffect(() => {
    if (!repairOperationStarted || !repairResult || !repair?.incidentId) return;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const state = await api(
          `/api/mini/repair/status?incidentId=${encodeURIComponent(repair.incidentId)}`,
        );
        const source = obj(state.source);
        const formula = Array.isArray(state.repair) ? state.repair[0] : null;
        const status = source.status || formula?.status;
        if (!active || !status) return;
        if (
          [
            "verified",
            "already_restored",
            "blocked",
            "uncertain",
            "written_unverified",
            "needs_review",
          ].includes(status)
        ) {
          setRepairResult(
            status === "verified"
              ? "Исправление записано и проверено RITM."
              : status === "already_restored"
                ? "Ячейка уже восстановлена и проверена; повторной записи нет."
                : `Операция остановлена: ${text(source.result?.message || formula?.message, status)}. Проверьте AI Center.`,
          );
          setRepairOperationStarted(false);
          window.clearInterval(timer);
          void refresh(true);
        }
      } catch {
        /* Status is read-only; retry next interval. */
      }
    }, 1800);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [repairOperationStarted, repairResult, repair?.incidentId, refresh]);

  const production = obj(dashboard?.production);
  const printing = obj(production.printing);
  const cutting = obj(production.cutting);
  const assembly = obj(dashboard?.assembly);
  const employees = Array.isArray(assembly.employees) ? assembly.employees : [];
  const incidents = Array.isArray(dashboard?.incidents)
    ? dashboard!.incidents
    : [];
  const coefficientRecords = Array.isArray(dashboard?.coefficientRecords)
    ? dashboard!.coefficientRecords
    : [];
  const employeeNames = useMemo(
    () => [
      "Все сотрудники",
      ...new Set(
        coefficientRecords
          .map((row: Obj) => String(row.employee || ""))
          .filter(Boolean),
      ),
    ],
    [coefficientRecords],
  );
  const coefficientDates = useMemo(
    () => [
      "Все даты",
      ...new Set(
        coefficientRecords
          .map((row: Obj) => String(row.date || ""))
          .filter(Boolean),
      ).values(),
    ],
    [coefficientRecords],
  );
  const coefficientDocuments = useMemo(
    () => [
      "Все документы",
      ...new Set(
        coefficientRecords
          .map((row: Obj) => String(row.source || ""))
          .filter(Boolean),
      ).values(),
    ],
    [coefficientRecords],
  );
  const filteredCoefficients = useMemo(
    () =>
      coefficientRecords
        .filter(
          (row: Obj) =>
            employeeFilter === "Все сотрудники" ||
            row.employee === employeeFilter,
        )
        .filter(
          (row: Obj) =>
            coefficientDate === "Все даты" || row.date === coefficientDate,
        )
        .filter(
          (row: Obj) =>
            coefficientDocument === "Все документы" ||
            row.source === coefficientDocument,
        )
        .filter(
          (row: Obj) =>
            !coefficientSearch ||
            `${row.employee} ${row.date} ${row.source}`
              .toLocaleLowerCase("ru-RU")
              .includes(coefficientSearch.toLocaleLowerCase("ru-RU")),
        )
        .sort(
          (a: Obj, b: Obj) =>
            ((number(a.coefficient) ?? -Infinity) -
              (number(b.coefficient) ?? -Infinity)) *
            (sortDirection === "desc" ? -1 : 1),
        ),
    [
      coefficientRecords,
      employeeFilter,
      coefficientDate,
      coefficientDocument,
      coefficientSearch,
      sortDirection,
    ],
  );
  const filteredIncidents = incidents.filter(
    (item: Obj) =>
      !incidentFilter ||
      `${item.title} ${item.sheet} ${item.cell} ${item.sourceName}`
        .toLocaleLowerCase("ru-RU")
        .includes(incidentFilter.toLocaleLowerCase("ru-RU")),
  );

  async function startCheck(mode: CheckMode) {
    if (checkBusy) return;
    setCheckBusy(mode);
    setCheckMessage(
      `${mode === "deep" ? "Глубокая" : "Быстрая"} проверка отправлена RITM…`,
    );
    try {
      const result = await api("/api/mini/check", {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      setCheckMessage(text(result.message, "Проверка принята RITM."));
      const status = await checkStatus(mode);
      setDashboard((prior) =>
        prior
          ? { ...prior, checks: { ...prior.checks, [mode]: status } }
          : prior,
      );
      if (
        status.status &&
        ["completed", "completed_with_warnings", "failed"].includes(
          status.status,
        )
      )
        setCheckBusy("");
    } catch (e) {
      setCheckBusy("");
      setCheckMessage(
        e instanceof Error ? e.message : "Не удалось запустить проверку.",
      );
    }
  }

  async function askAssistant(question = chatInput) {
    const clean = question.trim();
    if (!clean || chatBusy) return;
    setChatInput("");
    setChat((items) => [...items, { role: "user", text: clean }]);
    setChatBusy(true);
    try {
      const answer = await api("/api/intelligence/assistant/chat", {
        method: "POST",
        body: JSON.stringify({ message: clean }),
      });
      setChat((items) => [
        ...items,
        { role: "assistant", text: text(answer.text, "RITM не вернул ответ.") },
      ]);
      if (/проверка .*запущена|проверка .*очередь/i.test(answer.text || "")) {
        setCheckBusy(/глубок/i.test(answer.text) ? "deep" : "fast");
        setCheckMessage(answer.text);
      }
    } catch (e) {
      setChat((items) => [
        ...items,
        {
          role: "assistant",
          text: e instanceof Error ? e.message : "Ошибка связи с RITM.",
        },
      ]);
    } finally {
      setChatBusy(false);
    }
  }

  async function prepareRepair(incident: Obj) {
    setRepairBusy(true);
    setRepairResult("");
    setRepairOperationStarted(false);
    setExclusiveAcknowledged(false);
    setHistoryAcknowledged(false);
    try {
      const prepared = await api("/api/mini/repair/prepare", {
        method: "POST",
        body: JSON.stringify({ incidentId: incident.id }),
      });
      setRepair(prepared.proposal);
    } catch (e) {
      setRepairResult(
        e instanceof Error
          ? e.message
          : "Безопасное предложение не подготовлено.",
      );
    } finally {
      setRepairBusy(false);
    }
  }

  async function confirmRepair() {
    if (
      !repair?.token ||
      !exclusiveAcknowledged ||
      (repair.requiresHistoryApproval && !historyAcknowledged) ||
      repairBusy
    )
      return;
    setRepairBusy(true);
    try {
      const result = await api("/api/mini/repair/confirm", {
        method: "POST",
        body: JSON.stringify({
          token: repair.token,
          exclusiveEditingAcknowledged: true,
          historyCandidateApproved: historyAcknowledged,
        }),
      });
      setRepairResult(
        "Запись передана существующей очереди RITM. Проверяю итог и зависимые расчёты…",
      );
      setRepairOperationStarted(true);
      setRepair({ ...repair, incidentId: result.incidentId });
    } catch (e) {
      setRepairOperationStarted(false);
      setRepairResult(
        e instanceof Error ? e.message : "RITM заблокировал запись.",
      );
    } finally {
      setRepairBusy(false);
    }
  }

  function openCell(item: Obj) {
    const url = item.sourceUrl || item.openUrl || item.cellUrl;
    if (
      typeof url === "string" &&
      /^https:\/\/docs\.google\.com\/spreadsheets\//.test(url)
    ) {
      const webApp = window.Telegram?.WebApp;
      if (webApp?.openLink) webApp.openLink(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } else
      setRepairResult("Ссылка на ячейку не сохранена в карточке инцидента.");
  }

  function setTabSafe(next: Tab) {
    setTab(next);
    setView("summary");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const checkFor = (mode: CheckMode) => obj(dashboard?.checks?.[mode]);
  const showChecks = () => (
    <section className="mini-card mini-check-card">
      <div className="mini-card-heading">
        <div>
          <small>Проверка источников</small>
          <h2>Контроль таблиц</h2>
        </div>
        <StatusPill warning={!!checkBusy}>
          {checkBusy ? "Выполняется" : "Готово к запуску"}
        </StatusPill>
      </div>
      <p className="mini-muted">
        Быстрая проверка — текущий цикл. Глубокая — все контролируемые
        документы; если цикл идёт, RITM поставит глубокую в очередь.
      </p>
      <div className="mini-check-actions">
        <button
          className="mini-button secondary"
          disabled={!!checkBusy}
          onClick={() => void startCheck("fast")}
        >
          <ArrowsClockwise size={16} /> Быстрая
        </button>
        <button
          className="mini-button primary"
          disabled={!!checkBusy}
          onClick={() => void startCheck("deep")}
        >
          <CheckCircle size={16} /> Проверить все
        </button>
      </div>
      {checkMessage && <div className="mini-notice">{checkMessage}</div>}
      {(["fast", "deep"] as CheckMode[]).map((mode) => {
        const run = checkFor(mode);
        return run.id ? (
          <div className="mini-run" key={mode}>
            <div>
              <b>{mode === "deep" ? "Глубокая" : "Быстрая"} проверка</b>
              <StatusPill warning={!String(run.status).startsWith("completed")}>
                {checkStatusLabel(run.status)}
              </StatusPill>
            </div>
            <small>
              ID {run.id} · Старт {dateTime(run.startedAt || run.queuedAt)} ·{" "}
              {fmt((run.elapsedMs || 0) / 1000)} сек
            </small>
            {run.progress?.phase && (
              <small>
                {run.progress.phase}
                {run.progress?.document ? ` · ${run.progress.document}` : ""}
                {run.progress?.sheet ? ` · ${run.progress.sheet}` : ""}
              </small>
            )}
          </div>
        ) : null;
      })}
    </section>
  );

  function renderIncident(item: Obj) {
    const canRepair =
      item.recoveryCandidate?.status === "candidate" ||
      item.repairAvailability?.status === "candidate";
    return (
      <article className="mini-incident" key={item.id}>
        <div className="mini-incident-top">
          <div className="mini-incident-mark">
            <Warning size={17} />
          </div>
          <div className="mini-incident-copy">
            <strong>{text(item.title, "Проблема данных")}</strong>
            <small>
              {text(item.sourceName || item.source)} · {text(item.sheet)} ·{" "}
              {text(item.cell)}
            </small>
            <small>
              Артикул: {text(item.productKey || item.article, "не указан")}
            </small>
          </div>
          <StatusPill warning>
            {severityLabel(item.severity || item.priority)}
          </StatusPill>
        </div>
        <div className="mini-incident-details">
          <span>
            Сейчас: <b>{fmtCell(item.found ?? item.currentValue)}</b>
          </span>
          <span>
            Эталон:{" "}
            <b>
              {text(
                item.recoveryCandidate?.evidence,
                item.repairAvailability?.status === "candidate"
                  ? "Утверждённая формула"
                  : "не найден",
              )}
            </b>
          </span>
          {item.impact?.confirmed && (
            <span>
              Влияние на KPI: <b>{text(item.impact.summary)}</b>
            </span>
          )}
        </div>
        <div className="mini-incident-actions">
          <button
            className="mini-button secondary compact"
            onClick={() => void startCheck("fast")}
          >
            Проверить
          </button>
          <button
            className="mini-button secondary compact"
            onClick={() => openCell(item)}
          >
            Открыть ячейку
          </button>
          {canRepair && (
            <button
              className="mini-button primary compact"
              disabled={repairBusy}
              onClick={() => void prepareRepair(item)}
            >
              {repairBusy ? "Проверяю…" : "Исправить"}
            </button>
          )}
          <button
            className="mini-link-button"
            onClick={() =>
              setRepairResult(
                `${text(item.title)} · ${text(item.sourceName)} · ${text(item.sheet)}!${text(item.cell)}\nТекущее: ${fmtCell(item.found)}\nПричина: ${text(item.cause)}\nРекомендация: ${text(item.recommendation)}`,
              )
            }
          >
            Подробнее
          </button>
        </div>
      </article>
    );
  }

  if (loading && !dashboard && !error)
    return (
      <div className="mini-shell">
        <div className="mini-loading">
          <span className="mini-brand">
            RITM<span>/</span>
          </span>
          <CircleNotch className="spin" size={22} />
          Подключаю защищённые данные…
        </div>
      </div>
    );
  if (error && !dashboard)
    return (
      <div className="mini-shell">
        <header className="mini-header">
          <span className="mini-brand">
            RITM<span>/</span>
          </span>
          <span className="mini-live">
            <i /> Производство
          </span>
        </header>
        <main className="mini-content">
          <section className="mini-card mini-error-card">
            <div className="mini-hero-icon">
              <Warning size={23} />
            </div>
            <h1>Не удалось открыть Mini App</h1>
            <p>{error}</p>
            <p className="mini-muted">
              Доступ включается только через подписанные данные Telegram и
              привязанный личный аккаунт владельца. Рабочий API не открывается
              по обычной локальной ссылке.
            </p>
            <button
              className="mini-button primary full"
              onClick={() => void refresh()}
            >
              Повторить подключение
            </button>
          </section>
        </main>
      </div>
    );

  return (
    <div className="mini-shell">
      <header className="mini-header">
        <span className="mini-brand">
          RITM<span>/</span>
        </span>
        <span className="mini-live">
          <i /> Производство
        </span>
        <button
          className="mini-icon-button"
          aria-label="Обновить данные"
          onClick={() => void refresh(true)}
        >
          <ArrowsClockwise size={18} />
        </button>
      </header>
      <main className="mini-content">
        {error && (
          <div className="mini-notice warning">
            <Warning size={16} />
            {error}
          </div>
        )}
        <div className="mini-greeting">
          <div>
            <span className="mini-eyebrow">ПРОИЗВОДСТВЕННЫЙ ПУЛЬТ</span>
            <h1>
              {tab === "home"
                ? "Добрый день"
                : tab === "incidents"
                  ? "Инциденты"
                  : tab === "ai"
                    ? "AI-ассистент"
                    : "Отчёты"}
              {session?.user?.firstName ? `, ${session.user.firstName}` : ""}
            </h1>
            <p>Экран обновлён: {dateTime(dashboard?.fetchedAt)}</p>
          </div>
          <span className="mini-avatar">R</span>
        </div>
        {tab === "home" && (
          <>
            <div className="mini-metrics-grid">
              <Metric
                icon={Printer}
                label="Печать сегодня"
                value={
                  printing.unavailable
                    ? "Нет данных"
                    : `${fmt(printing.quantity)} шт.`
                }
                caption={
                  printing.confirmed
                    ? `${moneyArea(printing.areaM2)} · ${text(printing.source)}${!printing.stale && dashboard?.baselines?.printing?.confirmed && !dashboard?.baselines?.printing?.stale ? ` · к вчера ${formatDelta(printing.quantity, dashboard.baselines.printing.quantity)}` : ""}`
                    : text(printing.message)
                }
                tone="blue"
              />
              <Metric
                icon={Scissors}
                label="Порезка сегодня"
                value={
                  cutting.unavailable
                    ? "Нет данных"
                    : `${fmt(cutting.quantity)} шт.`
                }
                caption={
                  cutting.confirmed
                    ? `${moneyArea(cutting.areaM2)} · ${text(cutting.source)}${!cutting.stale && dashboard?.baselines?.cutting?.confirmed && !dashboard?.baselines?.cutting?.stale ? ` · к вчера ${formatDelta(cutting.quantity, dashboard.baselines.cutting.quantity)}` : ""}`
                    : text(cutting.message)
                }
                tone="violet"
              />
              <Metric
                icon={Warning}
                label="Активные проблемы"
                value={fmt(dashboard?.activeCount)}
                caption="Текущие инциденты без демонстрационных данных"
                tone="amber"
              />
              <Metric
                icon={Users}
                label="Сотрудники сегодня"
                value={employees.length ? fmt(employees.length) : "Нет данных"}
                caption={
                  assembly.confirmed
                    ? text(assembly.source)
                    : text(assembly.message)
                }
                tone="green"
              />
            </div>
            <section className="mini-card">
              <div className="mini-card-heading">
                <div>
                  <small>ПОСЛЕДНИЕ ДАННЫЕ</small>
                  <h2>Производство</h2>
                </div>
                <StatusPill warning={!!(printing.stale || cutting.stale)}>
                  {printing.stale || cutting.stale
                    ? "Нужна проверка источника"
                    : "Подтверждено"}
                </StatusPill>
              </div>
              <div className="mini-production-grid">
                <div>
                  <span>
                    <Printer size={16} /> Печать
                  </span>
                  <b>
                    {printing.confirmed
                      ? `${fmt(printing.quantity)} шт.`
                      : "Нет подтверждённых данных"}
                  </b>
                  <small>
                    {printing.confirmed
                      ? moneyArea(printing.areaM2)
                      : text(printing.message)}
                  </small>
                </div>
                <div>
                  <span>
                    <Scissors size={16} /> Порезка
                  </span>
                  <b>
                    {cutting.confirmed
                      ? `${fmt(cutting.quantity)} шт.`
                      : "Нет подтверждённых данных"}
                  </b>
                  <small>
                    {cutting.confirmed
                      ? moneyArea(cutting.areaM2)
                      : text(cutting.message)}
                  </small>
                </div>
              </div>
              <p className="mini-source-line">
                Источники обновлены{" "}
                {dateTime(printing.updatedAt || cutting.updatedAt)} · Период{" "}
                {text(printing.period?.from)} — {text(printing.period?.to)}
              </p>
            </section>
            <section className="mini-card">
              <div className="mini-card-heading">
                <div>
                  <small>СВОДКА УЧАСТКА</small>
                  <h2>KPI сотрудников</h2>
                </div>
                <button
                  className="mini-link-button"
                  onClick={() => {
                    setTab("reports");
                    setView("coefficients");
                  }}
                >
                  Коэффициенты <ArrowRight size={14} />
                </button>
              </div>
              {employees.length ? (
                <div className="mini-employee-list">
                  {employees.slice(0, 5).map((employee: Obj, index: number) => (
                    <div
                      className="mini-employee-row"
                      key={`${employee.employee}-${index}`}
                    >
                      <span className="mini-employee-avatar">
                        {String(employee.employee || "?").slice(0, 1)}
                      </span>
                      <div>
                        <b>{text(employee.employee)}</b>
                        <small>
                          Порезано {fmt(employee.cut)} · упаковано{" "}
                          {fmt(employee.packed)}
                        </small>
                      </div>
                      <StatusPill>
                        {number(employee.coefficient) === null
                          ? "Факт"
                          : `× ${fmt(employee.coefficient, 2)}`}
                      </StatusPill>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mini-empty">
                  KPI участка за сегодня не подтверждён.
                </div>
              )}
            </section>
            <section className="mini-card">
              <div className="mini-card-heading">
                <div>
                  <small>КОНТРОЛЬ ОСТАТКА</small>
                  <h2>Осталось печатать</h2>
                </div>
                <span className="mini-column-tag">X · остаток</span>
              </div>
              {Array.isArray(dashboard?.remaining?.items) &&
              dashboard!.remaining.items.length ? (
                <div className="mini-table-wrap">
                  <table className="mini-table">
                    <thead>
                      <tr>
                        <th>Артикул</th>
                        <th>Поставка</th>
                        <th>Остаток</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard!.remaining.items
                        .slice(0, 8)
                        .map((row: Obj, i: number) => (
                          <tr key={`${row.article}-${i}`}>
                            <td>{text(row.article)}</td>
                            <td>{text(row.sheet)}</td>
                            <td>
                              <b>{fmt(row.remaining)} шт.</b>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mini-empty">
                  {dashboard?.remaining?.unavailable
                    ? text(dashboard.remaining.message)
                    : "Подтверждённые остатки не найдены."}
                </div>
              )}
            </section>
            <section className="mini-card">
              <div className="mini-card-heading">
                <div>
                  <small>ТРЕБУЮТ ВНИМАНИЯ</small>
                  <h2>Важные проблемы</h2>
                </div>
                <button
                  className="mini-link-button"
                  onClick={() => setTabSafe("incidents")}
                >
                  Все <ArrowRight size={14} />
                </button>
              </div>
              {incidents.slice(0, 3).length ? (
                incidents
                  .slice(0, 3)
                  .map((incident: Obj) => renderIncident(incident))
              ) : (
                <div className="mini-empty success">
                  <CheckCircle size={18} /> Активных инцидентов нет по последней
                  проверке.
                </div>
              )}
            </section>
            <section className="mini-ask-card">
              <div className="mini-ask-heading">
                <span>
                  <Bot size={19} />
                </span>
                <div>
                  <b>Спросить AI</b>
                  <small>Ответы из подтверждённых данных RITM</small>
                </div>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setTabSafe("ai");
                  void askAssistant();
                }}
              >
                <input
                  aria-label="Задать вопрос"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Например: что по порезке сегодня?"
                />
                <button
                  aria-label="Отправить вопрос"
                  disabled={!chatInput.trim()}
                >
                  <ArrowRight size={18} />
                </button>
              </form>
              <div className="mini-suggestions">
                <button
                  onClick={() => {
                    setTabSafe("ai");
                    void askAssistant("Как дела на производстве сегодня?");
                  }}
                >
                  Итог дня
                </button>
                <button
                  onClick={() => {
                    setTabSafe("ai");
                    void askAssistant("Проверь все таблицы");
                  }}
                >
                  Проверить таблицы
                </button>
              </div>
            </section>
            {showChecks()}
          </>
        )}
        {tab === "incidents" && (
          <>
            <section className="mini-card">
              <div className="mini-card-heading">
                <div>
                  <small>АКТИВНЫЕ ПРОБЛЕМЫ</small>
                  <h2>{incidents.length} инцидентов</h2>
                </div>
                <StatusPill warning={incidents.length > 0}>
                  {incidents.length ? "Требуют внимания" : "Всё спокойно"}
                </StatusPill>
              </div>
              <label className="mini-search">
                <MagnifyingGlass size={16} />
                <input
                  value={incidentFilter}
                  onChange={(e) => setIncidentFilter(e.target.value)}
                  placeholder="Артикул, лист или ячейка"
                />
              </label>
              {filteredIncidents.length ? (
                filteredIncidents.map((incident: Obj) =>
                  renderIncident(incident),
                )
              ) : (
                <div className="mini-empty">
                  По последней проверке подходящих инцидентов нет.
                </div>
              )}
            </section>
            {showChecks()}
          </>
        )}
        {tab === "ai" && (
          <section className="mini-chat-page">
            <div className="mini-chat-intro">
              <span className="mini-ai-orb">
                <Bot size={23} />
              </span>
              <div>
                <small>RITM AI ASSISTANT</small>
                <h2>Чем помочь?</h2>
                <p>
                  Я использую инструменты и данные RITM. Если сведений нет,
                  сообщу об этом.
                </p>
              </div>
            </div>
            <div className="mini-chat-prompts">
              {[
                "Как дела на производстве?",
                "Что по порезке у Лукмана?",
                "Какие ошибки сейчас есть?",
                "Проверь все таблицы",
              ].map((prompt) => (
                <button key={prompt} onClick={() => void askAssistant(prompt)}>
                  {prompt}
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
            <div className="mini-chat-messages">
              {chat.length ? (
                chat.map((message, i) => (
                  <div key={i} className={`mini-bubble ${message.role}`}>
                    {message.text}
                  </div>
                ))
              ) : (
                <div className="mini-chat-placeholder">
                  Задайте вопрос обычным языком. Например: «Сколько напечатали
                  сегодня?»
                </div>
              )}
              {chatBusy && (
                <div className="mini-bubble assistant">
                  <CircleNotch className="spin" size={15} /> Смотрю данные RITM…
                </div>
              )}
            </div>
            <form
              className="mini-chat-input"
              onSubmit={(e) => {
                e.preventDefault();
                void askAssistant();
              }}
            >
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                maxLength={1000}
                placeholder="Напишите сообщение…"
              />
              <button
                disabled={!chatInput.trim() || chatBusy}
                aria-label="Отправить"
              >
                <ArrowRight size={18} />
              </button>
            </form>
            {showChecks()}
          </section>
        )}
        {tab === "reports" && (
          <>
            <div className="mini-subnav">
              <button
                className={view === "summary" ? "active" : ""}
                onClick={() => setView("summary")}
              >
                Сводка
              </button>
              <button
                className={view === "coefficients" ? "active" : ""}
                onClick={() => setView("coefficients")}
              >
                Коэффициенты
              </button>
              <button
                className={view === "cutting" ? "active" : ""}
                onClick={() => setView("cutting")}
              >
                Порезка
              </button>
            </div>
            {view === "coefficients" ? (
              <section className="mini-card">
                <div className="mini-card-heading">
                  <div>
                    <small>ФАКТИЧЕСКИЕ ЗНАЧЕНИЯ</small>
                    <h2>Коэффициенты</h2>
                  </div>
                  <StatusPill
                    warning={!dashboard?.coefficientSource?.normConfigured}
                  >
                    Норма не задана
                  </StatusPill>
                </div>
                <p className="mini-muted">
                  Коэффициенты операций имеют разный смысл. Без нормы и
                  направления метрики RITM не помечает отклонение как плохое. В
                  текущем источнике нет связи коэффициента с артикулом.
                </p>
                <div className="mini-filter-grid">
                  <label className="mini-search">
                    <MagnifyingGlass size={16} />
                    <input
                      value={coefficientSearch}
                      onChange={(e) => setCoefficientSearch(e.target.value)}
                      placeholder="Сотрудник или дата"
                    />
                  </label>
                  <select
                    value={employeeFilter}
                    onChange={(e) => setEmployeeFilter(e.target.value)}
                    aria-label="Фильтр по сотруднику"
                  >
                    {employeeNames.map((name: string) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                  <select
                    value={coefficientDate}
                    onChange={(e) => setCoefficientDate(e.target.value)}
                    aria-label="Фильтр по дате"
                  >
                    {coefficientDates.map((date: string) => (
                      <option key={date}>{date}</option>
                    ))}
                  </select>
                  <select
                    value={coefficientDocument}
                    onChange={(e) => setCoefficientDocument(e.target.value)}
                    aria-label="Фильтр по документу"
                  >
                    {coefficientDocuments.map((document: string) => (
                      <option key={document}>{document}</option>
                    ))}
                  </select>
                  <select disabled aria-label="Фильтр по артикулу">
                    <option>Артикул: нет в источнике</option>
                  </select>
                  <button
                    className="mini-icon-button"
                    onClick={() =>
                      setSortDirection((value) =>
                        value === "desc" ? "asc" : "desc",
                      )
                    }
                    aria-label="Сортировать по фактическому коэффициенту"
                  >
                    {sortDirection === "desc" ? "↓" : "↑"}
                  </button>
                </div>
                <div className="mini-sort-note">
                  Сортировка по фактическому значению. Отклонение недоступно,
                  пока для этого вида операции не задана норма.
                </div>
                <div className="mini-coefficient-list">
                  {filteredCoefficients
                    .slice(0, 80)
                    .map((row: Obj, index: number) => (
                      <div
                        className="mini-coefficient-row"
                        key={`${row.employee}-${row.date}-${index}`}
                      >
                        <div>
                          <b>{text(row.employee)}</b>
                          <small>
                            {text(row.date)} · {text(row.source)}
                          </small>
                        </div>
                        <strong>{fmt(row.coefficient, 3)}</strong>
                        <span className="mini-na">
                          Норма —<br />
                          Отклонение —
                        </span>
                      </div>
                    ))}
                </div>
                {!filteredCoefficients.length && (
                  <div className="mini-empty">
                    Нет подтверждённых коэффициентов для выбранного фильтра.
                  </div>
                )}
                <p className="mini-source-line">
                  Источник: {text(dashboard?.coefficientSource?.name)} ·
                  обновлён {dateTime(dashboard?.coefficientSource?.updatedAt)}
                  {dashboard?.coefficientSource?.stale
                    ? " · снимок устарел"
                    : ""}
                </p>
              </section>
            ) : view === "cutting" ? (
              <section className="mini-card">
                <div className="mini-card-heading">
                  <div>
                    <small>ПЕЧАТЬ И ПОРОЗКА</small>
                    <h2>Порезка сегодня</h2>
                  </div>
                  <StatusPill warning={cutting.stale}>
                    {cutting.confirmed ? "Подтверждено" : "Нет данных"}
                  </StatusPill>
                </div>
                <div className="mini-big-number">
                  {cutting.confirmed
                    ? `${fmt(cutting.quantity)} шт.`
                    : "Нет подтверждённых данных"}
                </div>
                <p>
                  {cutting.confirmed
                    ? moneyArea(cutting.areaM2)
                    : text(cutting.message)}
                </p>
                <p className="mini-source-line">
                  {text(cutting.source)} · {dateTime(cutting.updatedAt)}
                </p>
                {Array.isArray(cutting.employees) &&
                  cutting.employees.map((row: Obj) => (
                    <div className="mini-employee-row" key={row.employee}>
                      <span className="mini-employee-avatar">
                        <Scissors size={15} />
                      </span>
                      <div>
                        <b>{row.employee}</b>
                        <small>
                          {fmt(row.quantity)} шт. · {moneyArea(row.areaM2)}
                        </small>
                      </div>
                    </div>
                  ))}
              </section>
            ) : (
              <>
                <section className="mini-card">
                  <div className="mini-card-heading">
                    <div>
                      <small>СЕГОДНЯ · МОСКВА</small>
                      <h2>Производственные отчёты</h2>
                    </div>
                    <span className="mini-date-dot">
                      <ChartBar size={18} />
                    </span>
                  </div>
                  <div className="mini-report-row">
                    <span>
                      <Printer size={16} /> Печать
                    </span>
                    <b>
                      {printing.confirmed
                        ? `${fmt(printing.quantity)} шт. · ${moneyArea(printing.areaM2)}`
                        : "Нет фактических данных"}
                    </b>
                  </div>
                  <div className="mini-report-row">
                    <span>
                      <Scissors size={16} /> Порезка
                    </span>
                    <b>
                      {cutting.confirmed
                        ? `${fmt(cutting.quantity)} шт. · ${moneyArea(cutting.areaM2)}`
                        : "Нет фактических данных"}
                    </b>
                  </div>
                  <div className="mini-report-row">
                    <span>
                      <Package size={16} /> Упаковка и отправка
                    </span>
                    <b>Нет подтверждённого журнала</b>
                  </div>
                  <p className="mini-source-line">
                    Показаны только фактические записи журнала. Обновлено{" "}
                    {dateTime(printing.updatedAt)}
                  </p>
                </section>
                {showChecks()}
              </>
            )}
          </>
        )}
        {checkMessage && tab !== "home" && tab !== "incidents" && (
          <div className="mini-notice">{checkMessage}</div>
        )}
      </main>
      <nav className="mini-bottom-nav" aria-label="Навигация Mini App">
        {(
          [
            { id: "home", label: "Главная", icon: House },
            { id: "incidents", label: "Инциденты", icon: Warning },
            { id: "ai", label: "AI", icon: Bot },
            { id: "reports", label: "Отчёты", icon: ChartBar },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTabSafe(id)}
            className={tab === id ? "active" : ""}
          >
            <Icon size={19} />
            <span>{label}</span>
            {id === "incidents" && (dashboard?.activeCount || 0) > 0 && (
              <i>{dashboard!.activeCount}</i>
            )}
          </button>
        ))}
      </nav>
      {repair && (
        <div
          className="mini-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !repairBusy) setRepair(null);
          }}
        >
          <section
            className="mini-repair-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mini-repair-title"
          >
            <header>
              <div>
                <small>ТОЧНОЕ ИЗМЕНЕНИЕ</small>
                <h2 id="mini-repair-title">Подтвердите исправление</h2>
              </div>
              <button
                className="mini-icon-button"
                aria-label="Закрыть"
                disabled={repairBusy}
                onClick={() => setRepair(null)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="mini-repair-alert">
              <Warning size={17} /> Изменится только одна проверенная ячейка
              через очередь RITM.
            </div>
            <dl className="mini-repair-fields">
              <div>
                <dt>Документ</dt>
                <dd>{text(repair.document)}</dd>
              </div>
              <div>
                <dt>Лист и ячейка</dt>
                <dd>
                  {text(repair.sheet)}!{text(repair.cell)}
                </dd>
              </div>
              <div>
                <dt>Артикул</dt>
                <dd>{text(repair.article, "не указан")}</dd>
              </div>
              <div>
                <dt>Сейчас</dt>
                <dd>{fmtCell(repair.current)}</dd>
              </div>
              <div>
                <dt>Будет записано</dt>
                <dd>{fmtCell(repair.proposed)}</dd>
              </div>
              <div>
                <dt>Источник эталона</dt>
                <dd>{text(repair.evidence)}</dd>
              </div>
            </dl>
            <label className="mini-consent">
              <input
                type="checkbox"
                checked={exclusiveAcknowledged}
                onChange={(e) => setExclusiveAcknowledged(e.target.checked)}
              />
              <span>
                Подтверждаю именно это изменение и отсутствие параллельного
                редактирования листа до проверки результата.
              </span>
            </label>
            {repair.requiresHistoryApproval && (
              <label className="mini-consent">
                <input
                  type="checkbox"
                  checked={historyAcknowledged}
                  onChange={(e) => setHistoryAcknowledged(e.target.checked)}
                />
                <span>
                  Подтверждаю, что значение из истории верное, и разрешаю его
                  восстановление.
                </span>
              </label>
            )}
            {repairResult && (
              <div className="mini-notice" role="status">
                {repairResult}
              </div>
            )}
            <div className="mini-modal-actions">
              <button
                className="mini-button secondary"
                disabled={repairBusy}
                onClick={() => setRepair(null)}
              >
                Отмена
              </button>
              <button
                className="mini-button primary"
                disabled={
                  repairBusy ||
                  !exclusiveAcknowledged ||
                  (repair.requiresHistoryApproval && !historyAcknowledged)
                }
                onClick={() => void confirmRepair()}
              >
                {repairBusy ? (
                  <>
                    <CircleNotch className="spin" size={16} /> Проверяю…
                  </>
                ) : (
                  "Подтвердить и исправить"
                )}
              </button>
            </div>
            <p className="mini-security-note">
              При подтверждении RITM повторно проверит актуальность заявки,
              эталон, ячейку и права доступа. Если что-то изменилось, запись
              будет заблокирована. Адрес и значение нельзя подменить из
              интерфейса.
            </p>
          </section>
        </div>
      )}
      {!repair && repairResult && (
        <div
          className="mini-toast"
          role="status"
          onClick={() => setRepairResult("")}
        >
          {repairResult}
          <button aria-label="Закрыть">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
