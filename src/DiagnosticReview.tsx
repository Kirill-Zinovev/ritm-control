import { useState } from "react";
import { Badge, Button, DataTable, Field, Modal, Notice } from "./ui";
import { timeLabel } from "./intelligence";
type Evidence = {
  sheet: string;
  gid: number;
  cell: string;
  value: unknown;
  formula: string | null;
  error?: unknown;
  url: string;
};
type Observation = {
  id: string;
  evidenceVersion: string;
  ruleVersion: string | null;
  sourceId: string;
  document: string;
  sheet: string;
  cell: string;
  ruleId: string;
  type: string;
  title: string;
  why: string;
  cause: string;
  impact: string;
  recommendation: string;
  confidence: string;
  classification: string;
  expected: unknown;
  expectedResult?: number;
  sourceUrl: string;
  at: string;
  stale: boolean;
  evidence: Evidence[];
  exceptionReason?: string | null;
};
type Rule = {
  id: string;
  sourceId: string;
  document: string;
  sheet: string;
  range: string;
  title: string;
  version: string;
  template: string | null;
  condition: string;
  exceptions: string;
  impact: string;
  clarification: string;
  rowsChecked: number;
  formulaMatches: number;
  excludedRows: number;
  deviations: number;
  deviatingRows: number;
  approval: string;
  status: string;
  at: string;
  stale: boolean;
  sourceStatus: string;
  sampleFormulas: { cell: string; formula: string | null; expected: string }[];
};
type Exception = {
  id: string;
  sourceId: string;
  documentId: string;
  sheet: string;
  cell: string;
  ruleId: string;
  reason: string;
  expiresAt: string;
  status: string;
  applies: boolean;
  createdAt: string;
};
export type DiagnosticState = {
  at: string;
  rules: Rule[];
  observations: Observation[];
  exceptions: Exception[];
  attention: number;
  confirmed: number;
};
const labels: Record<string, string> = {
  suspicious: "Подозрительное отклонение",
  business_process: "Расхождение бизнес-процесса",
  confirmed_formula: "Подтверждённое нарушение эталона",
  expected_behavior: "Ожидаемо по текущей формуле",
  expected_exception: "Допустимое исключение владельца",
};
const printable = (v: unknown) =>
  v === null || v === undefined
    ? "Пусто"
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);
function reviewAdvice(rule: Rule) {
  if (rule.stale || rule.sourceStatus !== "ok")
    return "Сначала дождитесь успешной проверки источника: устаревший снимок недостаточен для утверждения.";
  if (rule.id === "catalog-sum" && rule.deviations > 0)
    return `Перед утверждением разберите наблюдения: ${rule.deviations}; затронуто строк: ${rule.deviatingRows}. Совпадение формулы не подтверждает числовой тип входов. Допустимые ручные корректировки согласуются точечно.`;
  if (rule.deviations > 0)
    return "Сначала рассмотрите найденные отклонения и допустимые исключения. Утверждение эталона не означает, что каждое наблюдение является ошибкой.";
  if (rule.id === "catalog-sum")
    return "Перед утверждением подтвердите обязательность формулы K и допустимые ручные корректировки. Совпадение формул не подтверждает правильность количества.";
  if (rule.id === "fbo-sum")
    return "Можно рассмотреть после правил печати: подтвердите состав строк сотрудников и исключение специальных строк. Проверка суммы не утверждает корректность внешних IMPORTRANGE.";
  if (rule.id === "supply-area")
    return "Можно рассмотреть первым: подтвердите обязательность формулы для заполненных производственных строк и перечислите ручные площади. Это проверка плана, не нормы фактического выпуска.";
  return "Можно рассмотреть первым вместе с площадью: подтвердите группировку и полноту зарегистрированного журнала. Сверка QUERY не заменяет проверку уникальных записей в KPI.";
}
export function DiagnosticReview({
  state,
  source,
  sheet,
  onChange,
}: {
  state: DiagnosticState;
  source: string;
  sheet: string;
  onChange: () => void;
}) {
  const [view, setView] = useState("attention"),
    [rule, setRule] = useState<Rule | null>(null),
    [action, setAction] = useState("approve"),
    [ack, setAck] = useState(false),
    [observation, setObservation] = useState<Observation | null>(null),
    [exception, setException] = useState<Observation | null>(null),
    [reason, setReason] = useState(""),
    [expires, setExpires] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const currentEvidence = observation?.evidence.find(
    (e) => e.sheet === observation.sheet && e.cell === observation.cell,
  );
  const visible = state.observations.filter(
    (o) => (!source || o.sourceId === source) && (!sheet || o.sheet === sheet),
  );
  const confirmed = visible.filter(
      (o) => o.classification === "confirmed_formula",
    ),
    expected = visible.filter((o) =>
      ["expected_behavior", "expected_exception"].includes(o.classification),
    ),
    attention = visible.filter(
      (o) =>
        ![
          "confirmed_formula",
          "expected_behavior",
          "expected_exception",
        ].includes(o.classification),
    );
  const observations =
    view === "confirmed"
      ? confirmed
      : view === "expected"
        ? expected
        : attention;
  async function send(path: string, payload: unknown) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.message || "Решение не сохранено");
      onChange();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Решение не сохранено");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="panel" aria-label="Утверждение диагностики">
        <div className="panel-heading">
          <h2>Четыре базовых правила</h2>
          <Badge>Только диагностика</Badge>
        </div>
        <Notice>
          Утверждение включает проверку данных, без права исправлять Google
          Sheets. Эталоны взяты из настоящих формул. Ручные и индивидуальные
          значения требуют точечных исключений.
        </Notice>
        <DataTable
          label="Базовые правила диагностики"
          rows={state.rules}
          rowKey={(r) => r.id}
          pageSize={10}
          columns={[
            {
              id: "rule",
              label: "Правило и эталон",
              render: (r) => (
                <>
                  <strong>{r.title}</strong>
                  <small className="ai-block">
                    {r.document} · {r.sheet} · {r.range}
                  </small>
                  <code>
                    {r.template || "Сумма L по дате, сотруднику и операции"}
                  </code>
                </>
              ),
            },
            {
              id: "scope",
              label: "Проверка",
              render: (r) => (
                <>
                  {r.rowsChecked} строк / групп
                  <small className="ai-block">
                    Наблюдений: {r.deviations} в {r.deviatingRows} строках;
                    исключено условием: {r.excludedRows}
                  </small>
                  {r.template && (
                    <small className="ai-block">
                      Совпадений формулы: {r.formulaMatches}
                    </small>
                  )}
                  <small className="ai-block">
                    {timeLabel(r.at)}
                    {r.stale ? " · снимок устарел" : ""}
                  </small>
                </>
              ),
            },
            {
              id: "state",
              label: "Состояние",
              render: (r) => (
                <>
                  <Badge>
                    {r.approval === "approved"
                      ? "Утверждено владельцем"
                      : "Ждёт утверждения"}
                  </Badge>
                  <small className="ai-block">
                    {r.status === "ready"
                      ? "Предварительная проверка выполнена"
                      : "Недостаточно данных"}
                  </small>
                </>
              ),
            },
            {
              id: "action",
              label: "Решение владельца",
              render: (r) => (
                <Button
                  disabled={
                    busy ||
                    (r.approval !== "approved" &&
                      (r.stale || r.sourceStatus !== "ok"))
                  }
                  onClick={() => {
                    setRule(r);
                    setAction(r.approval === "approved" ? "revoke" : "approve");
                    setAck(false);
                    setError("");
                  }}
                >
                  {r.approval === "approved"
                    ? "Отозвать правило"
                    : "Рассмотреть правило"}
                </Button>
              ),
            },
          ]}
        />
        {state.rules.length !== 4 && (
          <Notice tone="warning">
            Ожидаются успешные снимки всех трёх документов, чтобы подготовить
            четыре правила.
          </Notice>
        )}
      </section>
      <section className="panel" aria-label="Расследования Table Doctor">
        <div className="panel-heading">
          <h2>Расследования и решения</h2>
          <small>Факты отделены от предполагаемых причин</small>
        </div>
        <div
          className="segments"
          role="group"
          aria-label="Категория диагностики"
        >
          <button
            className={view === "attention" ? "active" : ""}
            onClick={() => setView("attention")}
          >
            Требует внимания ({attention.length})
          </button>
          <button
            className={view === "confirmed" ? "active" : ""}
            onClick={() => setView("confirmed")}
          >
            Подтверждённые ошибки ({confirmed.length})
          </button>
          <button
            className={view === "expected" ? "active" : ""}
            onClick={() => setView("expected")}
          >
            Ожидаемое поведение ({expected.length})
          </button>
          <button
            className={view === "exceptions" ? "active" : ""}
            onClick={() => setView("exceptions")}
          >
            Допустимые исключения
          </button>
        </div>
        {error && <Notice tone="warning">{error}</Notice>}
        {message && <Notice>{message}</Notice>}
        {view === "exceptions" ? (
          <>
            <Notice>
              Исключение ограничено документом, листом, ячейкой, правилом и
              прочитанным содержимым. При изменении доказательств оно не
              применяется. Срок и отмена сохраняются в SQLite.
            </Notice>
            <DataTable
              label="Допустимые исключения диагностики"
              rows={state.exceptions.filter(
                (e) =>
                  (!source || e.sourceId === source) &&
                  (!sheet || e.sheet === sheet),
              )}
              rowKey={(e) => e.id}
              columns={[
                {
                  id: "scope",
                  label: "Область",
                  render: (e) => (
                    <>
                      {e.sheet}!{e.cell}
                      <small className="ai-block">
                        Правило:{" "}
                        {state.rules.find((r) => r.id === e.ruleId)?.title ||
                          e.ruleId}
                      </small>
                    </>
                  ),
                },
                { id: "reason", label: "Причина", render: (e) => e.reason },
                {
                  id: "status",
                  label: "Состояние",
                  render: (e) => (
                    <>
                      {e.status === "revoked"
                        ? "Отменено"
                        : e.status === "expired"
                          ? "Истёк срок"
                          : e.applies
                            ? "Применяется"
                            : "Содержимое изменилось или наблюдения больше нет"}
                      <small className="ai-block">
                        До {timeLabel(e.expiresAt)}
                      </small>
                    </>
                  ),
                },
                {
                  id: "revoke",
                  label: "Действие",
                  render: (e) =>
                    e.status === "active" ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void send(
                            "/api/intelligence/doctor/exceptions/" +
                              e.id +
                              "/revoke",
                            {},
                          )
                        }
                      >
                        Отменить исключение
                      </Button>
                    ) : null,
                },
              ]}
            />
          </>
        ) : (
          <DataTable
            label="Наблюдения диагностики"
            rows={observations}
            rowKey={(o) => o.id}
            pageSize={20}
            columns={[
              {
                id: "problem",
                label: "Что произошло",
                render: (o) => (
                  <button
                    className="text-link"
                    onClick={() => {
                      setObservation(o);
                      setError("");
                    }}
                  >
                    {o.title}
                  </button>
                ),
              },
              {
                id: "source",
                label: "Источник",
                render: (o) => (
                  <>
                    {o.document}
                    <small className="ai-block">
                      {o.sheet}!{o.cell}
                    </small>
                    <small className="ai-block">
                      {timeLabel(o.at)}
                      {o.stale ? " · предыдущий снимок" : ""}
                    </small>
                  </>
                ),
              },
              {
                id: "category",
                label: "Заключение",
                render: (o) => (
                  <>
                    <Badge>
                      {labels[o.classification] || o.classification}
                    </Badge>
                    <small className="ai-block">{o.confidence}</small>
                  </>
                ),
              },
              { id: "impact", label: "Влияние", render: (o) => o.impact },
            ]}
          />
        )}
        <p className="panel-note">
          Отсутствие записи не равно нулевому KPI. Межлистовые чтения не
          атомарны; новые записи во время проверки могут потребовать повторного
          сравнения.
        </p>
      </section>
      <Modal
        open={!!rule}
        onClose={() => {
          if (!busy) setRule(null);
        }}
        title={
          action === "approve"
            ? "Утверждение правила диагностики"
            : "Отзыв правила диагностики"
        }
        description="Это решение не разрешает агенту изменять производственные таблицы."
      >
        {rule && (
          <>
            <h3>{rule.title}</h3>
            <p>
              {rule.document} · {rule.sheet} · {rule.range}
            </p>
            <p>
              <strong>Эталон:</strong>{" "}
              <code>
                {rule.template ||
                  "Сумма фактического L журнала по производственной дате, сотруднику и операции; московский часовой пояс"}
              </code>
            </p>
            <Notice>{rule.clarification}</Notice>
            {action === "approve" && (
              <p>
                <strong>Перед решением:</strong> {reviewAdvice(rule)}
              </p>
            )}
            <p>
              <strong>Условия:</strong> {rule.condition}
            </p>
            <p>
              <strong>Исключения:</strong> {rule.exceptions}
            </p>
            <p>
              <strong>Влияние:</strong> {rule.impact}
            </p>
            <p>
              Проверено: {rule.rowsChecked}; отклонений: {rule.deviations}.
              Версия: {rule.version.slice(0, 12)}.
            </p>
            {rule.sampleFormulas.map((s) => (
              <p key={s.cell}>
                <strong>{s.cell}</strong>:{" "}
                <code>{s.formula || "Формула отсутствует"}</code>
              </p>
            ))}
            <div className="field">
              <span>Подтверждение владельца</span>
              <label>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />{" "}
                Я подтверждаю указанный диапазон, условия и эталон только для
                диагностики
              </label>
            </div>
            {error && <Notice tone="warning">{error}</Notice>}
            <div className="modal-actions">
              <Button disabled={busy} onClick={() => setRule(null)}>
                Отмена
              </Button>
              <Button
                kind="primary"
                disabled={busy || !ack}
                onClick={async () => {
                  if (
                    await send(
                      "/api/intelligence/doctor/rules/" +
                        rule.id +
                        "/" +
                        action,
                      { version: rule.version, acknowledged: ack },
                    )
                  ) {
                    setRule(null);
                    setMessage(
                      "Решение сохранено. Новые проверки вступят в силу в следующем цикле; Google Sheets не изменялись.",
                    );
                  }
                }}
              >
                {action === "approve"
                  ? "Подтвердить диагностику"
                  : "Подтвердить отзыв"}
              </Button>
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={!!observation}
        onClose={() => setObservation(null)}
        title={observation?.title || "Наблюдение"}
        description="Исходные данные, механизм, ограничения и рекомендация."
      >
        {observation && (
          <>
            <Badge>{labels[observation.classification]}</Badge>
            <p>
              <a
                className="text-link"
                href={observation.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {observation.document} · {observation.sheet}!{observation.cell}
              </a>
            </p>
            {currentEvidence && (
              <Notice>
                <strong>Обнаружено в {observation.cell}:</strong>{" "}
                {currentEvidence.formula || printable(currentEvidence.value)}
                {!currentEvidence.formula &&
                typeof currentEvidence.value === "string"
                  ? " (текст)"
                  : ""}
              </Notice>
            )}
            <p>
              <strong>Почему обнаружено:</strong> {observation.why}
            </p>
            <p>
              <strong>Причина и ограничения:</strong> {observation.cause}
            </p>
            <p>
              <strong>Влияние:</strong> {observation.impact}
            </p>
            <p>
              <strong>Рекомендация:</strong> {observation.recommendation}
            </p>
            <p>
              <strong>Надёжность:</strong> {observation.confidence}. Снимок{" "}
              {timeLabel(observation.at)}.
            </p>
            {observation.expected !== null &&
              observation.expected !== undefined && (
                <Notice>
                  <strong>Ожидается по предлагаемому правилу:</strong>{" "}
                  {printable(observation.expected)}
                  {observation.expectedResult !== undefined && (
                    <small className="ai-block">
                      Результат по прочитанным входным данным:{" "}
                      {printable(observation.expectedResult)}. Это не разрешение
                      на изменение ячейки.
                    </small>
                  )}
                </Notice>
              )}
            {observation.exceptionReason && (
              <Notice>
                Причина исключения владельца: {observation.exceptionReason}
              </Notice>
            )}
            <DataTable
              label="Доказательства наблюдения"
              rows={observation.evidence}
              rowKey={(e) => e.gid + ":" + e.cell}
              pageSize={10}
              columns={[
                {
                  id: "cell",
                  label: "Ячейка",
                  render: (e) => (
                    <a
                      className="text-link"
                      href={e.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {e.sheet}!{e.cell}
                    </a>
                  ),
                },
                {
                  id: "value",
                  label: "Значение",
                  render: (e) => (
                    <>
                      {printable(e.value)}
                      {e.error && (
                        <small className="ai-block">{printable(e.error)}</small>
                      )}
                    </>
                  ),
                },
                {
                  id: "formula",
                  label: "Формула",
                  render: (e) => (
                    <code style={{ overflowWrap: "anywhere" }}>
                      {e.formula || "Обычное значение"}
                    </code>
                  ),
                },
              ]}
            />
            <Button
              disabled={observation.stale || busy}
              onClick={() => {
                setException(observation);
                setObservation(null);
                setReason("");
                setExpires(
                  new Intl.DateTimeFormat("en-CA", {
                    timeZone: "Europe/Moscow",
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                  }).format(new Date(Date.now() + 7 * 86400000)),
                );
                setError("");
              }}
            >
              Допустимое исключение
            </Button>
          </>
        )}
      </Modal>
      <Modal
        open={!!exception}
        onClose={() => {
          if (!busy) setException(null);
        }}
        title="Точечное допустимое исключение"
        description="Не скрывает другие ячейки или все ошибки одного типа."
      >
        {exception && (
          <>
            <p>
              {exception.document} · {exception.sheet}!{exception.cell}
            </p>
            <p>
              Область: только правило{" "}
              {state.rules.find((r) => r.id === exception.ruleId)?.title ||
                exception.title}{" "}
              и текущее содержимое. При изменении доказательств исключение
              перестанет применяться.
            </p>
            <Field label="Причина допустимого исключения">
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
              />
            </Field>
            <Field label="Срок исключения">
              <input
                type="date"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </Field>
            {error && <Notice tone="warning">{error}</Notice>}
            <div className="modal-actions">
              <Button disabled={busy} onClick={() => setException(null)}>
                Отмена
              </Button>
              <Button
                kind="primary"
                disabled={busy || reason.trim().length < 5 || !expires}
                onClick={async () => {
                  if (
                    await send("/api/intelligence/doctor/exceptions", {
                      observationId: exception.id,
                      evidenceVersion: exception.evidenceVersion,
                      reason,
                      expiresAt: new Date(
                        expires + "T23:59:59+03:00",
                      ).toISOString(),
                    })
                  ) {
                    setException(null);
                    setMessage(
                      "Точечное исключение сохранено с причиной и сроком; ячейка Google Sheets не изменялась.",
                    );
                  }
                }}
              >
                Подтвердить исключение
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
