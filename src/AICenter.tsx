import { useEffect, useRef, useState } from "react";
import {
  ArrowsClockwise,
  ArrowSquareOut,
  Bot,
  CheckCircle,
  Warning,
} from "./icons";
import {
  Badge,
  Button,
  Busy,
  DataTable,
  Empty,
  Field,
  Modal,
  Notice,
  Search,
} from "./ui";
import {
  type AgentStatus,
  type Incident,
  type PageResult,
  type HistoryEntry,
  statusLabel,
  timeLabel,
} from "./intelligence";
import { useAgentResource } from "./useAgent";

const views = [
  ["overview", "Обзор состояния"],
  ["incidents", "Инциденты"],
  ["recommendations", "Рекомендации"],
  ["chat", "AI-чат"],
  ["history", "История"],
  ["settings", "Настройки"],
] as const;
type View = (typeof views)[number][0];
const eventNames: Record<string, string> = {
  agent_started: "Запуск",
  agent_stopped: "Остановка",
  check_completed: "Проверка",
  incident_detected: "Новый инцидент",
  incident_reopened: "Повторное обнаружение",
  incident_resolved: "Повторная проверка",
  recommendation: "Рекомендация",
  owner_login: "Вход владельца",
  notification_sent: "Уведомление",
  notification_failed: "Ошибка Telegram",
  notification_uncertain: "Неизвестная доставка",
  agent_error: "Ошибка агента",
};
function tone(status: string) {
  return ["ok", "running"].includes(status)
    ? "success"
    : ["error", "critical", "high", "stale", "partial", "stopped"].includes(
          status,
        )
      ? "warning"
      : "neutral";
}
function OwnerLogin({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState(""),
    [show, setShow] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  return (
    <section className="panel ai-login">
      <Bot size={32} aria-hidden="true" />
      <h2>Вход владельца</h2>
      <p>
        Локальный агент доступен только владельцу. Введите ключ, заданный при
        настройке Windows.
      </p>
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          if (!token.trim()) {
            setError("Введите ключ владельца.");
            input.current?.focus();
            return;
          }
          const ctrl = new AbortController();
          active.current = ctrl;
          setBusy(true);
          setError("");
          try {
            const response = await fetch("/api/intelligence/session", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token }),
              signal: AbortSignal.any([
                ctrl.signal,
                AbortSignal.timeout(15000),
              ]),
            });
            const result = await response.json();
            if (!response.ok) {
              setError(result.message || "Не удалось войти.");
              input.current?.focus();
            } else {
              setToken("");
              onLogin();
            }
          } catch {
            if (!ctrl.signal.aborted)
              setError("Агент недоступен. Проверьте его запуск.");
          } finally {
            if (!ctrl.signal.aborted) setBusy(false);
          }
        }}
      >
        <Field label="Ключ владельца" error={error || undefined}>
          <input
            ref={input}
            type={show ? "text" : "password"}
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-invalid={!!error}
          />
        </Field>
        <div className="ai-login-actions">
          <Button
            type="button"
            aria-pressed={show}
            onClick={() => setShow(!show)}
          >
            {show ? "Скрыть ключ" : "Показать ключ"}
          </Button>
          <Button kind="primary" disabled={busy} type="submit">
            {busy ? "Вход…" : "Войти"}
          </Button>
        </div>
      </form>
      <small>
        Ключ не сохраняется в браузерном хранилище. Сеанс действует 8 часов.
      </small>
    </section>
  );
}
export function AICenter() {
  const [view, setView] = useState<View>("overview");
  const [department, setDepartment] = useState(""),
    [source, setSource] = useState(""),
    [severity, setSeverity] = useState(""),
    [status, setStatus] = useState("open");
  const [query, setQuery] = useState(""),
    [committed, setCommitted] = useState("");
  const [page, setPage] = useState(0),
    [size, setSize] = useState(20);
  const [historyPage, setHistoryPage] = useState(0),
    [historySize, setHistorySize] = useState(20);
  const [selected, setSelected] = useState<Incident | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false),
    [logoutError, setLogoutError] = useState("");
  const loginRequest = useRef<AbortController | null>(null);
  useEffect(() => () => loginRequest.current?.abort(), []);
  useEffect(() => {
    if (!query) {
      setCommitted("");
      setPage(0);
      return;
    }
    const timer = setTimeout(() => {
      setCommitted(query);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  const live = useAgentResource<AgentStatus>("/api/intelligence/status");
  const state = live.value;
  const params = new URLSearchParams({
    department,
    source,
    severity,
    status,
    q: committed,
    p: String(page),
    limit: String(size),
  });
  const incidents = useAgentResource<PageResult<Incident>>(
    "/api/intelligence/incidents?" + params,
    !!state && !live.locked && view === "incidents",
  );
  const history = useAgentResource<PageResult<HistoryEntry>>(
    "/api/intelligence/history?p=" + historyPage + "&limit=" + historySize,
    !!state && !live.locked && view === "history",
  );
  const detail = useAgentResource<{ ok: true; incident: Incident }>(
    "/api/intelligence/incidents/" + (selected?.id || ""),
    !!selected && !live.locked,
    0,
  );
  const incident = detail.value?.incident || selected;
  const sources = state?.config.sources || [];
  const departments = [...new Set(sources.map((s) => s.department))];
  const apiError = live.error || incidents.error || history.error;
  return (
    <div className="ai-center">
      <div className="ai-toolbar">
        <div className="ai-agent-label">
          <Bot size={23} />
          <div>
            <strong>RITM Intelligence</strong>
            <small>Мониторинг без открытого браузера · уровень 1</small>
          </div>
        </div>
        <div className="ai-toolbar-actions">
          <Badge tone={tone(state?.agent?.status || "not_configured")}>
            {statusLabel[state?.agent?.status || "not_configured"]}
          </Badge>
          <Button
            disabled={live.loading}
            onClick={() => {
              void live.reload();
              if (view === "incidents") void incidents.reload();
              if (view === "history") void history.reload();
            }}
          >
            <ArrowsClockwise size={16} />
            Обновить сведения
          </Button>
          {state && (
            <Button
              disabled={logoutBusy}
              onClick={async () => {
                setLogoutBusy(true);
                setLogoutError("");
                const ctrl = new AbortController();
                loginRequest.current = ctrl;
                try {
                  const r = await fetch("/api/intelligence/session", {
                    method: "DELETE",
                    signal: AbortSignal.any([
                      ctrl.signal,
                      AbortSignal.timeout(15000),
                    ]),
                  });
                  if (!r.ok) throw new Error("logout");
                  setSelected(null);
                  await live.reload();
                } catch {
                  if (!ctrl.signal.aborted)
                    setLogoutError(
                      "Не удалось завершить сеанс. Повторите выход.",
                    );
                } finally {
                  if (!ctrl.signal.aborted) setLogoutBusy(false);
                }
              }}
            >
              Выйти
            </Button>
          )}
        </div>
      </div>
      {logoutError && <Notice tone="warning">{logoutError}</Notice>}
      {apiError && (
        <Notice tone="warning">
          {apiError}
          {state && " Последнее получение: " + timeLabel(state.fetchedAt)}
        </Notice>
      )}
      {live.locked || incidents.locked || history.locked ? (
        <OwnerLogin
          onLogin={() => {
            void live.reload();
            void incidents.reload();
            void history.reload();
          }}
        />
      ) : !state ? (
        live.loading ? (
          <div className="ai-pending">
            <Busy label="Проверяю подключение локального агента…" />
          </div>
        ) : (
          <section className="panel">
            <Empty title="Локальный агент не подключён">
              Запустите RITM Intelligence на Windows и откройте локальный
              кабинет. Инциденты и показатели появятся после реальной проверки.
            </Empty>
            <a
              className="button secondary"
              href="http://127.0.0.1:4318/?page=intelligence"
              target="_blank"
              rel="noreferrer"
            >
              Открыть локальный AI Center <ArrowSquareOut size={16} />
            </a>
            <p className="panel-note">
              На опубликованном сайте защищённый агентный API пока не развёрнут.
              Формулы и AI-чат не настроены.
            </p>
          </section>
        )
      ) : (
        <>
          <div
            className="segments ai-views"
            role="group"
            aria-label="Раздел AI Center"
          >
            {views.map(([id, label]) => (
              <button
                key={id}
                className={view === id ? "selected" : ""}
                aria-pressed={view === id}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {view === "overview" && (
            <>
              <div className="ai-metrics">
                {[
                  ["Контролируемых таблиц", state.controlledSources],
                  ["Активных проблем", state.active],
                  ["Не обнаружены повторно", state.resolved],
                  ["Исправлений агентом", state.corrections],
                  ["Предложений", state.recommendations.length],
                ].map(([label, value]) => (
                  <section className="panel ai-metric" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </section>
                ))}
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Состояние источников и RITM</h2>
                    <p className="panel-note">
                      Последняя проверка: {timeLabel(state.lastCheck)} · время
                      московское
                    </p>
                  </div>
                  <CheckCircle size={22} aria-hidden="true" />
                </div>
                <DataTable
                  label="Результаты проверок"
                  rows={state.checks}
                  rowKey={(r) => r.id}
                  columns={[
                    {
                      id: "name",
                      label: "Проверка",
                      render: (r) => (
                        <>
                          <strong>{r.name}</strong>
                          <small className="ai-block">
                            {r.kind === "source"
                              ? "Google Sheets · значения CSV"
                              : r.kind === "api"
                                ? "API RITM"
                                : "Доступность HTML"}
                          </small>
                        </>
                      ),
                    },
                    {
                      id: "status",
                      label: "Состояние",
                      render: (r) => (
                        <Badge tone={tone(r.stale ? "stale" : r.status)}>
                          {statusLabel[r.stale ? "stale" : r.status] ||
                            r.status}
                        </Badge>
                      ),
                    },
                    {
                      id: "at",
                      label: "Проверено",
                      render: (r) => timeLabel(r.at),
                    },
                    {
                      id: "latency",
                      label: "Время запроса",
                      render: (r) =>
                        r.durationMs === undefined ? "—" : r.durationMs + " мс",
                    },
                    {
                      id: "freshness",
                      label: "Данные",
                      render: (r) =>
                        r.kind === "source" ? (
                          <>
                            <span>Снимок: {timeLabel(r.snapshotAt)}</span>
                            <small className="ai-block">
                              Обновление источника:{" "}
                              {r.sourceUpdatedAt
                                ? timeLabel(r.sourceUpdatedAt)
                                : "неизвестно"}
                            </small>
                          </>
                        ) : r.status === "not_configured" ? (
                          "Не настроено"
                        ) : (
                          "Проверка доступности и контракта"
                        ),
                    },
                  ]}
                />
                <p className="panel-note">
                  Закрытые проблемы означают успешную повторную проверку.
                  Изменения производственных таблиц агентом запрещены.
                  Доступность HTML не подтверждает корректность отображения
                  дашборда в браузере.
                </p>
              </section>
              <Notice>
                Проверка формул: не настроено. LLM-анализ и AI-чат: этап 3.
                Telegram:{" "}
                {state.config.telegram === "configured"
                  ? "настроен"
                  : "не настроено"}
                .
                {state.notifications.uncertain
                  ? " Неизвестный результат доставки: " +
                    state.notifications.uncertain +
                    "."
                  : ""}
                {state.notifications.failed
                  ? " Ошибок отправки: " + state.notifications.failed + "."
                  : ""}
              </Notice>
            </>
          )}
          {view === "incidents" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Инциденты</h2>
                  <p className="panel-note">
                    Только результаты реальных проверок. Нажмите на проблему для
                    подробностей.
                  </p>
                </div>
                <Search
                  label="Найти инцидент"
                  value={query}
                  onChange={setQuery}
                />
              </div>
              <div className="ai-filters">
                <Field label="Отдел">
                  <select
                    value={department}
                    onChange={(e) => {
                      setDepartment(e.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="">Все отделы</option>
                    {departments.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                    <option>Система</option>
                  </select>
                </Field>
                <Field label="Источник">
                  <select
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="">Все источники</option>
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Критичность">
                  <select
                    value={severity}
                    onChange={(e) => {
                      setSeverity(e.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="">Все уровни</option>
                    {["critical", "high", "medium", "low"].map((s) => (
                      <option key={s} value={s}>
                        {statusLabel[s]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Статус">
                  <select
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="">Все статусы</option>
                    <option value="open">Открыт</option>
                    <option value="resolved">Не обнаружен повторно</option>
                  </select>
                </Field>
              </div>
              <div className="ai-table-state" role="status">
                {incidents.loading && <Busy label="Читаю журнал инцидентов…" />}
              </div>
              {incidents.value ? (
                <DataTable
                  label="Журнал инцидентов"
                  rows={incidents.value.rows}
                  rowKey={(r) => r.id}
                  onSelect={setSelected}
                  selected={selected?.id}
                  pagination={{
                    page: incidents.value.page,
                    size,
                    total: incidents.value.total,
                    onPageChange: setPage,
                    onSizeChange: (n) => {
                      setSize(n);
                      setPage(0);
                    },
                    busy: incidents.loading,
                  }}
                  columns={[
                    {
                      id: "title",
                      label: "Проблема · открыть",
                      render: (r) => <strong>{r.title}</strong>,
                    },
                    {
                      id: "source",
                      label: "Источник",
                      render: (r) => (
                        <>
                          {r.sourceName}
                          <small className="ai-block">
                            {r.sheet || r.department}
                          </small>
                        </>
                      ),
                    },
                    {
                      id: "cell",
                      label: "Ячейка",
                      render: (r) => r.cell || "—",
                    },
                    {
                      id: "severity",
                      label: "Критичность",
                      render: (r) => (
                        <Badge tone={tone(r.severity)}>
                          {statusLabel[r.severity]}
                        </Badge>
                      ),
                    },
                    {
                      id: "status",
                      label: "Статус",
                      render: (r) => statusLabel[r.status],
                    },
                    {
                      id: "date",
                      label: "Обнаружен",
                      render: (r) => timeLabel(r.firstSeen),
                    },
                  ]}
                />
              ) : (
                !incidents.loading && (
                  <Empty title="Журнал не получен">
                    Проверьте запуск агента и повторите обновление.
                  </Empty>
                )
              )}
              {incidents.value?.total === 0 && (
                <p className="panel-note">
                  Для этих фильтров нет инцидентов. Это не подтверждает проверку
                  формул — она пока не настроена.
                </p>
              )}
            </section>
          )}
          {view === "recommendations" && (
            <section className="panel">
              <h2>Рекомендации по измерениям мониторинга</h2>
              {!state.recommendations.length ? (
                <Empty title="Предложений пока нет">
                  Они появятся при измеренной задержке API или повторяющемся
                  сбое подключения. Предполагаемое ускорение не выдаётся за
                  факт.
                </Empty>
              ) : (
                state.recommendations.map((r) => (
                  <article className="ai-recommendation" key={r.id}>
                    <div className="panel-heading">
                      <h3>{r.title}</h3>
                      <Badge tone={tone(r.priority)}>
                        {statusLabel[r.priority]} · На рассмотрении
                      </Badge>
                    </div>
                    <dl className="ai-details">
                      {[
                        ["Проблема", r.problem],
                        ["Доказательства", r.evidence],
                        ["Предложение", r.solution],
                        ["Ожидаемая польза", r.benefit],
                        ["Риски", r.risks],
                        ["Как проверить", r.verification],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))
              )}
            </section>
          )}
          {view === "history" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>История проверок и событий</h2>
                <span className="panel-note">
                  Сохраняется после перезапуска агента
                </span>
              </div>
              <div className="ai-table-state" role="status">
                {history.loading && <Busy label="Читаю историю…" />}
              </div>
              {history.value && (
                <DataTable
                  label="История агента"
                  rows={history.value.rows}
                  rowKey={(r) => String(r.id)}
                  pagination={{
                    page: history.value.page,
                    size: historySize,
                    total: history.value.total,
                    onPageChange: setHistoryPage,
                    onSizeChange: (n) => {
                      setHistorySize(n);
                      setHistoryPage(0);
                    },
                    busy: history.loading,
                  }}
                  columns={[
                    {
                      id: "at",
                      label: "Время",
                      render: (r) => timeLabel(r.at),
                    },
                    {
                      id: "event",
                      label: "Событие",
                      render: (r) => eventNames[r.type] || "Событие",
                    },
                    {
                      id: "message",
                      label: "Результат",
                      render: (r) => r.message,
                    },
                  ]}
                />
              )}
            </section>
          )}
          {view === "chat" && (
            <section className="panel">
              <h2>AI-чат</h2>
              <Notice>
                Не настроено. Аналитический чат будет подключён на этапе 3 к
                проверенным данным и выбранной модели.
              </Notice>
              <Field label="Вопрос руководителя">
                <textarea
                  className="resize-none"
                  disabled
                  placeholder="Почему снизилась производительность сборки?"
                  style={{ resize: "none" }}
                />
              </Field>
              <Button kind="primary" disabled>
                Отправить вопрос
              </Button>
              <p className="panel-note">
                В первом этапе мониторинг работает обычным кодом и не вызывает
                AI API. Причины снижения KPI без достаточных данных не
                формируются.
              </p>
            </section>
          )}
          {view === "settings" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>Настройки · только просмотр</h2>
                <Badge>Локальный агент Windows</Badge>
              </div>
              <dl className="ai-details">
                <div>
                  <dt>Интервал проверки</dt>
                  <dd>
                    {state.config.intervalSeconds} сек. после завершения
                    предыдущей проверки
                  </dd>
                </div>
                <div>
                  <dt>Разрешённые действия</dt>
                  <dd>
                    Чтение, диагностика, журнал, рекомендации, настроенные
                    уведомления. Исправления и деплой отключены.
                  </dd>
                </div>
                <div>
                  <dt>Контроль API</dt>
                  <dd>{state.config.apiBase || "Не настроено"}</dd>
                </div>
                <div>
                  <dt>Telegram</dt>
                  <dd>
                    {state.config.telegram === "configured"
                      ? "Настроен · только сообщения владельцу"
                      : "Не настроено"}
                  </dd>
                </div>
                <div>
                  <dt>Модель</dt>
                  <dd>
                    {state.config.model
                      ? state.config.model + " · вызовы пока отключены"
                      : "Не настроено"}
                  </dd>
                </div>
                <div>
                  <dt>Следующая проверка</dt>
                  <dd>{timeLabel(state.agent?.nextCheckAt)}</dd>
                </div>
                <div>
                  <dt>Изменение настроек</dt>
                  <dd>
                    В защищённой локальной конфигурации. Секреты в интерфейс не
                    передаются.
                  </dd>
                </div>
              </dl>
              <h3>Реестр источников</h3>
              {sources.map((s) => (
                <article className="ai-source" key={s.id}>
                  <div className="panel-heading">
                    <strong>{s.name}</strong>
                    <Badge>
                      {s.department} ·{" "}
                      {s.enabled ? "Контролируется" : "Отключён"}
                    </Badge>
                  </div>
                  <p>{s.purpose}</p>
                  <small>
                    Контроль формул: не настроено · Контроль обновления записей:{" "}
                    {s.freshness ? "по заданному календарю" : "не настроено"}
                  </small>
                  <ul>
                    {s.sheets.map((sheet) => (
                      <li key={sheet.gid}>
                        <a
                          target="_blank"
                          rel="noreferrer"
                          href={
                            "https://docs.google.com/spreadsheets/d/" +
                            s.documentId +
                            "/edit#gid=" +
                            sheet.gid
                          }
                        >
                          {sheet.name}
                        </a>
                        {sheet.status === "not_configured"
                          ? " · Проверка не настроена"
                          : ""}
                        {sheet.limitation && (
                          <small className="ai-block">{sheet.limitation}</small>
                        )}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </section>
          )}
        </>
      )}
      <Modal
        open={!!selected && !live.locked}
        onClose={() => setSelected(null)}
        title="Подробности инцидента"
        description="Наблюдение и предлагаемые действия. Автоматическое исправление отключено."
      >
        {incident && (
          <>
            {detail.error && (
              <Notice tone="warning">
                Не удалось повторно получить инцидент. Показана сохранённая
                карточка.
              </Notice>
            )}
            <h3>{incident.title}</h3>
            <Badge tone={tone(incident.severity)}>
              {statusLabel[incident.severity]} · {statusLabel[incident.status]}
            </Badge>
            <dl className="ai-details">
              {[
                ["Отдел", incident.department],
                ["Таблица", incident.sourceName],
                [
                  "Лист и ячейка",
                  [incident.sheet, incident.cell].filter(Boolean).join(" · ") ||
                    "Проверка сервиса",
                ],
                ["Обнаружено", incident.found],
                ["Ожидается", incident.expected],
                ["Обоснование", incident.cause],
                ["Влияние на KPI", incident.impact],
                ["Предлагаемое действие", incident.action],
                ["Первое обнаружение", timeLabel(incident.firstSeen)],
                ["Последняя проверка", timeLabel(incident.lastSeen)],
                ["Повторных наблюдений", String(incident.occurrences)],
                [
                  "Проверка",
                  incident.verification === "rule_confirmed"
                    ? "Нарушение правила подтверждено"
                    : "Результат технической проверки; причина требует анализа",
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {/^https?:\/\//.test(incident.sourceUrl) && (
              <a
                className="button secondary"
                href={incident.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Открыть источник <ArrowSquareOut size={16} />
              </a>
            )}
            <Notice tone="warning">
              <Warning size={16} /> Изменения запрещены на первом этапе.
              Закрытие означает, что проблема не обнаружена при следующей
              успешной проверке.
            </Notice>
          </>
        )}
      </Modal>
    </div>
  );
}
