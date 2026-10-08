import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Busy,
  DataTable,
  Empty,
  Field,
  Modal,
  Notice,
} from "./ui";
import { ArrowSquareOut, ArrowsClockwise } from "./icons";
import {
  type Incident,
  type PageResult,
  statusLabel,
  timeLabel,
} from "./intelligence";
import { useAgentResource } from "./useAgent";
type DoctorState = {
  ok: true;
  running: boolean;
  lastCheck: string | null;
  lastSuccessfulCheck: string | null;
  checkedFormulas: number | null;
  demoCheckedFormulas: number;
  demoEnabled: boolean;
  documents: {
    id: string;
    name: string;
    department: string;
    demonstration: boolean;
    purpose: string;
    pendingRules: number;
    sourceUrl: string | null;
    sheets: { name: string; gid: number }[];
    check: {
      status: string;
      at: string;
      message: string;
      checkedFormulas: number | null;
      issueCount: number | null;
      lastSuccessfulAt?: string;
    } | null;
  }[];
};
const types: Record<string, string> = {
  formula_missing: "Формула отсутствует",
  formula_number: "Формула заменена числом",
  formula_mismatch: "Нарушение шаблона",
  invalid_reference: "Некорректная ссылка",
  calculation_error: "Ошибка вычисления",
  business_rule: "Нарушение бизнес-правила",
  structure_changed: "Изменена структура",
  duplicate_uid: "Дубли идентификаторов",
  missing_uid: "Нет идентификатора",
  invalid_date: "Некорректная дата",
  invalid_number: "Некорректное число",
  stale_data: "Нет обновления",
  sheets_api_unavailable: "API недоступен",
};
function text(value: unknown) {
  return value === null || value === undefined
    ? "Не утверждено"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
function tone(status: string) {
  return ["ok", "fixed"].includes(status)
    ? "success"
    : ["new", "confirmed", "degraded", "unavailable", "critical"].includes(
          status,
        )
      ? "warning"
      : "neutral";
}
export function TableDoctor() {
  const resource = useAgentResource<DoctorState>(
    "/api/intelligence/doctor",
    true,
    10000,
  );
  const [source, setSource] = useState(""),
    [department, setDepartment] = useState(""),
    [type, setType] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(0),
    [size, setSize] = useState(20);
  const [selected, setSelected] = useState<Incident | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const params = new URLSearchParams({
    kind: "table_doctor",
    source,
    department,
    type,
    status,
    p: String(page),
    limit: String(size),
  });
  const incidents = useAgentResource<PageResult<Incident>>(
    "/api/intelligence/incidents?" + params,
    !!resource.value && !resource.locked,
    10000,
  );
  const detail = useAgentResource<{ ok: true; incident: Incident }>(
    "/api/intelligence/incidents/" + (selected?.id || ""),
    !!selected && !resource.locked,
    10000,
  );
  const incident = detail.value?.incident || selected;
  async function act(path: string, payload: unknown = {}) {
    if (busy) return;
    const ctrl = new AbortController();
    active.current = ctrl;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(20000)]),
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(result.message || "Не удалось выполнить действие");
      if (!ctrl.signal.aborted) {
        setMessage(
          path.endsWith("/run")
            ? "Проверка запущена. Результаты появятся после завершения."
            : path.endsWith("/request-repair")
              ? "Заявка сохранена. Google Sheets не изменён."
              : path.endsWith("/ignore")
                ? "Проблема игнорируется. Google Sheets не изменён."
                : "Демонстрационный источник проверен. Рабочие таблицы не изменены.",
        );
        await Promise.all([
          resource.reload(),
          incidents.reload(),
          detail.reload(),
        ]);
      }
    } catch (e) {
      if (!ctrl.signal.aborted)
        setError(e instanceof Error ? e.message : "Агент недоступен");
    } finally {
      if (!ctrl.signal.aborted) setBusy(false);
    }
  }
  if (resource.locked || incidents.locked || detail.locked)
    return (
      <Notice tone="warning">
        Сеанс владельца завершён. Обновите AI Center и войдите снова.
      </Notice>
    );
  if (!resource.value)
    return resource.loading ? (
      <Busy label="Загружаю Table Doctor…" />
    ) : (
      <Notice tone="warning">
        {resource.error || "Table Doctor не настроен"}
      </Notice>
    );
  const state = resource.value;
  return (
    <div className="doctor-center">
      {(resource.error || incidents.error || error) && (
        <Notice tone="warning">
          {error || resource.error || incidents.error} Предыдущие результаты
          могут быть устаревшими.
        </Notice>
      )}
      {message && <Notice>{message}</Notice>}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Table Doctor</h2>
            <p className="panel-note">
              Формулы и структура · Google Sheets только для чтения
            </p>
          </div>
          <Button
            kind="primary"
            disabled={busy || state.running}
            onClick={() => void act("/api/intelligence/doctor/run")}
          >
            <ArrowsClockwise size={16} />
            {state.running ? "Идёт проверка…" : "Проверить таблицы"}
          </Button>
        </div>
        <div className="ai-metrics doctor-metrics">
          <div>
            <span>Документов в реестре</span>
            <strong>
              {state.documents.filter((d) => !d.demonstration).length}
            </strong>
          </div>
          <div>
            <span>Формул проверено в успешных проверках</span>
            <strong
              className={
                state.checkedFormulas === null ? "doctor-time" : undefined
              }
            >
              {state.checkedFormulas ?? "Нет проверки"}
            </strong>
            <small>В демонстрации проверено: {state.demoCheckedFormulas}</small>
          </div>
          <div>
            <span>Последняя проверка</span>
            <strong className="doctor-time">
              {timeLabel(state.lastCheck)}
            </strong>
          </div>
          <div>
            <span>Последняя успешная проверка</span>
            <strong className="doctor-time">
              {timeLabel(state.lastSuccessfulCheck)}
            </strong>
          </div>
        </div>
        <DataTable
          label="Документы Table Doctor"
          rows={state.documents}
          rowKey={(r) => r.id}
          columns={[
            {
              id: "name",
              label: "Документ",
              render: (r) => (
                <>
                  <strong>{r.name}</strong>
                  <small className="ai-block">
                    {r.department} · {r.sheets.length} листов
                  </small>
                  {r.demonstration && <Badge>Демонстрация</Badge>}
                </>
              ),
            },
            {
              id: "state",
              label: "Проверка",
              render: (r) => (
                <>
                  <Badge
                    tone={tone(
                      r.check?.issueCount
                        ? "degraded"
                        : r.check?.status || "not_configured",
                    )}
                  >
                    {r.check?.issueCount
                      ? "Проблем: " + r.check.issueCount
                      : statusLabel[r.check?.status || "not_configured"] ||
                        r.check?.status}
                  </Badge>
                  <small className="ai-block">
                    {r.check?.message || "Проверка ещё не выполнялась"}
                  </small>
                </>
              ),
            },
            {
              id: "rules",
              label: "Правила",
              render: (r) => (
                <>
                  {r.pendingRules
                    ? r.pendingRules + " формульных правил ждут утверждения"
                    : "Утверждённые правила"}
                  <small className="ai-block">
                    {r.check?.checkedFormulas === null ||
                    r.check?.checkedFormulas === undefined
                      ? "Формулы не проверены"
                      : "Проверено: " + r.check.checkedFormulas}
                  </small>
                </>
              ),
            },
            {
              id: "at",
              label: "Последнее успешное чтение",
              render: (r) => timeLabel(r.check?.lastSuccessfulAt),
            },
            {
              id: "link",
              label: "Источник",
              render: (r) =>
                r.sourceUrl ? (
                  <a
                    className="text-link"
                    target="_blank"
                    rel="noreferrer"
                    href={r.sourceUrl}
                  >
                    Google Sheets <ArrowSquareOut size={15} />
                  </a>
                ) : (
                  <span>Локальная тестовая фикстура</span>
                ),
            },
          ]}
        />
        <Notice>
          Для реальных формул нужен сервисный аккаунт Google с доступом
          «Читатель». Формульные шаблоны FBO и поставок пока ждут утверждения
          владельца. Они не используются для автоматического исправления.
        </Notice>
      </section>
      {state.demoEnabled && (
        <section className="panel doctor-demo">
          <div className="panel-heading">
            <div>
              <h3>ДЕМОНСТРАЦИЯ · контролируемая ошибка</h3>
              <p className="panel-note">
                Искусственная таблица «Коэффициенты · DEMO», ячейка G247.
                Тестовые значения и нормы не относятся к производству.
              </p>
            </div>
            <Badge>Только локальный тестовый файл</Badge>
          </div>
          <div className="doctor-actions">
            <Button
              disabled={busy || state.running}
              onClick={() =>
                void act("/api/intelligence/doctor/demo", {
                  scenario: "number",
                })
              }
            >
              1. Заменить формулу числом в DEMO
            </Button>
            <Button
              disabled={busy || state.running}
              onClick={() => void act("/api/intelligence/doctor/run")}
            >
              2. Повторить проверку
            </Button>
            <Button
              kind="primary"
              disabled={busy || state.running}
              onClick={() =>
                void act("/api/intelligence/doctor/demo", {
                  scenario: "healthy",
                })
              }
            >
              3. Восстановить DEMO-формулу
            </Button>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>Проблемы формул и данных</h2>
          <small>Нажмите на проблему, чтобы открыть доказательства</small>
        </div>
        <div className="doctor-filters">
          <Field label="Отдел">
            <select
              value={department}
              onChange={(e) => {
                setDepartment(e.target.value);
                setPage(0);
              }}
            >
              <option value="">Все отделы</option>
              {[...new Set(state.documents.map((d) => d.department))].map(
                (d) => (
                  <option key={d}>{d}</option>
                ),
              )}
            </select>
          </Field>
          <Field label="Документ">
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setPage(0);
              }}
            >
              <option value="">Все документы</option>
              {state.documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Тип ошибки">
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setPage(0);
              }}
            >
              <option value="">Все типы</option>
              {Object.entries(types).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
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
              {["new", "review", "confirmed", "fixed", "ignored"].map((id) => (
                <option key={id} value={id}>
                  {statusLabel[id]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {incidents.loading && !incidents.value ? (
          <Busy label="Загружаю инциденты…" />
        ) : incidents.value ? (
          <DataTable
            label="Инциденты Table Doctor"
            rows={incidents.value.rows}
            rowKey={(r) => r.id}
            pagination={{
              page: incidents.value.page,
              size: size,
              total: incidents.value.total,
              onPageChange: setPage,
              onSizeChange: (n: number) => {
                setSize(n);
                setPage(0);
              },
            }}
            columns={[
              {
                id: "problem",
                label: "Проблема",
                render: (r) => (
                  <button
                    className="text-link"
                    onClick={() => {
                      setSelected(r);
                      setMessage("");
                      setError("");
                    }}
                  >
                    {r.title}
                    {r.demonstration && (
                      <small className="ai-block">ДЕМОНСТРАЦИЯ</small>
                    )}
                  </button>
                ),
              },
              {
                id: "where",
                label: "Источник и ячейка",
                render: (r) => (
                  <>
                    {r.sourceName}
                    <small className="ai-block">
                      {r.sheet} · {r.cell || "Документ"}
                    </small>
                  </>
                ),
              },
              {
                id: "status",
                label: "Статус",
                render: (r) => (
                  <Badge tone={tone(r.status)}>{statusLabel[r.status]}</Badge>
                ),
              },
              {
                id: "severity",
                label: "Критичность",
                render: (r) => (
                  <Badge tone={tone(r.severity)}>
                    {statusLabel[r.severity] || r.severity}
                  </Badge>
                ),
              },
              {
                id: "at",
                label: "Последняя проверка",
                render: (r) => timeLabel(r.lastSeen),
              },
              {
                id: "count",
                label: "Наблюдений",
                render: (r) => r.occurrences,
              },
            ]}
          />
        ) : (
          <Empty title="Нет результатов проверки" />
        )}
      </section>
      <Modal
        open={!!selected}
        onClose={() => {
          setSelected(null);
          setMessage("");
          setError("");
        }}
        title="Карточка Table Doctor"
        description="Доказательства, предполагаемая причина и заявка владельца. Google Sheets не изменяется."
      >
        {incident && (
          <>
            {incident.demonstration && (
              <Notice tone="warning">
                ДЕМОНСТРАЦИЯ · искусственные данные. Ссылки на рабочую
                Google-таблицу нет.
              </Notice>
            )}
            {detail.error && (
              <Notice tone="warning">
                Не удалось обновить карточку. Показаны сохранённые сведения.
              </Notice>
            )}
            <h3>{incident.title}</h3>
            <Badge tone={tone(incident.status)}>
              {statusLabel[incident.status]}
            </Badge>
            <dl className="ai-details">
              {[
                ["ID", incident.id],
                ["Отдел", incident.department],
                ["Таблица", incident.sourceName],
                [
                  "Лист и ячейка",
                  [incident.sheet, incident.cell].filter(Boolean).join(" · "),
                ],
                ["Обнаружено", text(incident.observed)],
                ["Ожидалось", text(incident.expected)],
                [
                  "Предыдущая проверенная формула",
                  incident.previousFormula || "Нет утверждённого снимка",
                ],
                ["Предполагаемая причина", incident.cause],
                ["Возможное влияние на KPI", incident.impact],
                ["Рекомендация", incident.recommendation || incident.action],
                [
                  "Доказательство",
                  incident.verification === "rule_confirmed"
                    ? "Нарушение утверждённого правила подтверждено"
                    : "Требует проверки владельца; шаблон не утверждён",
                ],
                ["Первое обнаружение", timeLabel(incident.firstSeen)],
                ["Последняя проверка", timeLabel(incident.lastSeen)],
                [
                  "Закрыт после проверки",
                  incident.resolvedAt ? timeLabel(incident.resolvedAt) : "Нет",
                ],
                ["Наблюдений", String(incident.occurrences)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {(error || message) && (
              <Notice tone={error ? "warning" : "neutral"}>
                {error || message}
              </Notice>
            )}
            <div className="doctor-actions">
              {incident.sourceUrl && (
                <a
                  className="button secondary"
                  target="_blank"
                  rel="noreferrer"
                  href={incident.sourceUrl}
                >
                  Открыть ячейку <ArrowSquareOut size={16} />
                </a>
              )}
              {incident.monitorStatus === "open" && (
                <>
                  <Button
                    kind="primary"
                    disabled={busy || incident.repairRequested}
                    onClick={() =>
                      void act(
                        "/api/intelligence/incidents/" +
                          incident.id +
                          "/request-repair",
                      )
                    }
                  >
                    {incident.repairRequested
                      ? "Заявка сохранена"
                      : "Отметить для исправления"}
                  </Button>
                  <Button
                    disabled={busy || incident.status === "ignored"}
                    onClick={() =>
                      void act(
                        "/api/intelligence/incidents/" +
                          incident.id +
                          "/ignore",
                      )
                    }
                  >
                    Игнорировать
                  </Button>
                </>
              )}
            </div>
            <p className="panel-note">
              Заявка хранится в журнале агента. Выполнение исправлений появится
              на следующем этапе. «Исправлена» означает, что успешная повторная
              проверка больше не обнаружила проблему.
            </p>
          </>
        )}
      </Modal>
    </div>
  );
}
