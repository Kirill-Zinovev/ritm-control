import { useEffect, useState } from "react";
import { Badge, Button, DataTable, Field, Modal, Notice } from "./ui";
import { timeLabel } from "./intelligence";
type Region = {
  id: string;
  version: string;
  sourceId: string;
  document: string;
  gid: number;
  sheet: string;
  column: string;
  family: string;
  range: string;
  count: number;
  kind: string;
  protected: number;
  changed: number;
  unprotected: number;
  manual: number;
  errors: number;
  merged: number;
  dependencies: string[];
  at: string;
  stale: boolean;
  samples: { cell: string; formula: string; url: string; error: unknown }[];
  manualSamples: { cell: string; value: unknown; url: string }[];
};
export type FormulaState = {
  fastCheck?: {
    at: string;
    status: string;
    durationMs: number;
    readRequests: number;
    retries: number;
    responseBytes: number;
    checkedCells: number;
    protectedCells: number;
    violations: number;
    documents: {
      sourceId: string;
      name: string;
      sheets: {
        gid: number;
        sheet: string;
        status: string;
        checkedCells: number;
        protectedCells: number;
        matchingCells: number | null;
        violations: number | null;
        readRequests?: number;
        durationMs: number;
        errorCode?: string;
        at: string;
      }[];
    }[];
  } | null;
  metrics: {
    sourceId: string;
    document: string;
    gid: number;
    sheet: string;
    at: string;
    stale: boolean;
    formulasRead: number;
    protectedCells: number;
    checkedCells: number;
    protectedFormulasRead: number;
    unprotectedFormulas: number;
    protectedPercent: number | null;
    damage: number;
    exceptions: number;
    durationMs: number;
    fullSheetRead: boolean;
    readRows: number;
    readColumns: number;
  }[];
  regions: Region[];
  productionWritesEnabled: boolean;
  exceptions: {
    id: string;
    sourceId: string;
    gid: number;
    cell: string;
    reason: string;
    expiresAt: string;
    status: string;
  }[];
  decisions: { id: number; at: string; action: string }[];
};
type Detail = Region & {
  total: number;
  cells: { cell: string; formula: string; merge: string | null; url: string }[];
  history: { version: string; at: string }[];
};
type ProtectionRegion = {
  id: string;
  version: string;
  at: string;
  sourceId: string;
  document: string;
  gid: number;
  sheet: string;
  range: string;
  formulaCells: number;
  newCells: number;
  alreadyProtected?: number;
  protected?: number;
  changedProtected?: number;
  manual: number;
  merged: number;
  manualSamples?: { cell: string; value: unknown; url: string }[];
  kind?: string;
  sampleFormula: string;
  includesM11?: boolean;
  m11: string | null;
  reasons?: string[];
};
type ProtectionPreview = {
  previewId: string;
  generatedAt: string;
  expiresAt: string;
  sheets: {
    sourceId: string;
    document: string;
    gid: number;
    sheet: string;
    at: string | null;
    stale: boolean;
    fullSheetRead: boolean;
    formulasRead: number | null;
    protectedCells: number;
    protectedNow: number;
    protectable: number;
    review: number;
    excluded: number;
    knownDamage: number;
    manualValuesObserved: number;
    coverageNow: number | null;
    coverageAfterApproval: number | null;
    reasons: string[];
  }[];
  totals: {
    formulasRead: number;
    protectedNow: number;
    protectable: number;
    review: number;
    excluded: number;
    knownDamage: number;
    staleSheets: number;
    coverageNow: number | null;
    coverageAfterApproval: number | null;
  };
  manualSamples: {
    sourceId: string;
    document: string;
    gid: number;
    sheet: string;
    cell: string;
    value: unknown;
    url: string;
    range: string;
    formulaCells: number;
    sampleFormula: string;
    manualSignature: string | null;
  }[];
  safeRegions: ProtectionRegion[];
  reviewRegions: ProtectionRegion[];
  m11: {
    sourceId: string;
    document: string;
    sheet: string;
    gid: number;
    cell: string;
    formula: string | null;
    currentValue?: unknown;
    formulaExample?: string;
    range?: string;
    url?: string;
    status: string;
    reasons: string[];
  }[];
};
const reviewReason = (reason: string) =>
  ({
    stale_snapshot: "Снимок устарел или лист прочитан не полностью",
    individual_formula: "Одиночную формулу нельзя подтвердить по семейству",
    invalid_reference_token: "В формуле присутствует #REF!",
    formula_result_error: "Результат формулы требует контекстной проверки",
    open_incident: "По области есть открытый инцидент",
    approved_baseline_changed:
      "Найдена формула, отличающаяся от действующего эталона",
    mixed_merge_layout: "Область смешивает обычные и объединённые ячейки",
    invalid_merge_metadata: "Не удалось проверить структуру объединения",
  })[reason] || reason;
const enteredValueLabel = (value: unknown) => {
  if (value && typeof value === "object") {
    const cell = value as Record<string, unknown>;
    if (cell.numberValue !== undefined) return String(cell.numberValue);
    if (cell.stringValue !== undefined) return String(cell.stringValue);
    if (cell.boolValue !== undefined) return String(cell.boolValue);
  }
  return String(value ?? "пусто");
};
export function FormulaIntelligence({
  state,
  reload,
}: {
  state: FormulaState;
  reload: () => Promise<unknown>;
}) {
  const [document, setDocument] = useState(""),
    [sheet, setSheet] = useState(""),
    [filter, setFilter] = useState("pending");
  const [selected, setSelected] = useState<Region[]>([]),
    [confirm, setConfirm] = useState(false),
    [ack, setAck] = useState(false);
  const [protectionPreview, setProtectionPreview] =
      useState<ProtectionPreview | null>(null),
    [massConfirm, setMassConfirm] = useState(false);
  const [area, setArea] = useState<Region | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0),
    [size, setSize] = useState(20);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [reason, setReason] = useState("");
  useEffect(() => {
    if (!area) {
      setDetail(null);
      return;
    }
    const ctrl = new AbortController();
    setDetail(null);
    const params = new URLSearchParams({
      version: area.version,
      p: String(page),
      limit: String(size),
      search,
    });
    void fetch(
      `/api/intelligence/doctor/formulas/regions/${area.id}?${params}`,
      { credentials: "include", signal: ctrl.signal },
    )
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || "Нет доступа к эталонам");
        return data as Detail;
      })
      .then(setDetail)
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted)
          setError(e instanceof Error ? e.message : "Ошибка чтения");
      });
    return () => ctrl.abort();
  }, [area, page, search, size]);
  async function act(
    action: string,
    body: unknown,
  ): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/intelligence/doctor/formulas/" + action, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Решение не сохранено");
      setMessage(
        data.message || "Решение сохранено. Google Sheets не изменялся.",
      );
      await reload();
      return data as Record<string, unknown>;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Агент недоступен");
      return null;
    } finally {
      setBusy(false);
    }
  }
  const rows = state.regions.filter(
    (r) =>
      (!document || document === r.sourceId) &&
      (!sheet || sheet === String(r.gid)) &&
      (filter === "all" ||
        (filter === "pending" && (r.unprotected > 0 || r.changed > 0)) ||
        (filter === "protected" && r.protected > 0)),
  );
  const fresh = state.metrics.filter((m) => !m.stale);
  const total = (
    key:
      | "formulasRead"
      | "checkedCells"
      | "protectedFormulasRead"
      | "unprotectedFormulas"
      | "protectedCells",
  ) => fresh.reduce((n, m) => n + m[key], 0);
  const read = total("formulasRead"),
    coverage = read
      ? ((100 * total("protectedFormulasRead")) / read).toFixed(2)
      : null;
  const prepareProtection = async () => {
    setProtectionPreview(null);
    const result = await act("prepare", {});
    if (result?.previewId) setProtectionPreview(result as ProtectionPreview);
  };
  return (
    <section
      className="panel formula-intelligence"
      aria-label="Formula Intelligence"
    >
      <div className="panel-heading">
        <div>
          <h2>Formula Intelligence</h2>
          <p className="panel-note">
            Формульные снимки и эталоны для точечной проверки по утверждённым
            ячейкам
          </p>
        </div>
      </div>
      <Notice>
        Обнаруженная формула — кандидат, а не доказательство правильности.
        Утверждение разрешает диагностику, но не запись.
        {state.productionWritesEnabled
          ? " Восстановление доступно только после отдельного подтверждения конкретной ячейки."
          : " Аккаунт производственной записи пока не подключён."}
      </Notice>
      {state.metrics.some((m) => m.stale) && (
        <Notice tone="warning">
          Часть снимков устарела или источник недоступен. Покрытие ниже
          посчитано только по свежим успешным проверкам.
        </Notice>
      )}
      <div className="ai-metrics doctor-metrics">
        <div>
          <span>Формул прочитано</span>
          <strong>
            {fresh.length ? read.toLocaleString("ru-RU") : "Нет проверки"}
          </strong>
        </div>
        <div>
          <span>Ячеек проверено по утверждённым снимкам</span>
          <strong>
            {fresh.length
              ? total("checkedCells").toLocaleString("ru-RU")
              : "Нет проверки"}
          </strong>
          <small>
            Защищённых адресов:{" "}
            {total("protectedCells").toLocaleString("ru-RU")}, включая
            повреждённые
          </small>
        </div>
        <div>
          <span>Формул без контроля снимком</span>
          <strong>
            {fresh.length
              ? total("unprotectedFormulas").toLocaleString("ru-RU")
              : "Нет проверки"}
          </strong>
        </div>
        <div>
          <span>Покрытие прочитанных формул</span>
          <strong>
            {coverage === null ? "Не определено" : coverage + "%"}
          </strong>
          <small>
            Утверждённые снимки; четыре отдельные бизнес-проверки сохраняются
            ниже
          </small>
        </div>
      </div>
      {error && <Notice tone="warning">{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <section
        className="formula-protection-preview"
        aria-label="Массовая защита формул"
      >
        <div className="formula-protection-heading">
          <div>
            <h3>Массовая защита формул</h3>
            <p className="panel-note">
              Подготовка запускает новую проверку семи листов только на чтение.
              Она ничего не утверждает и не записывает в Google Sheets.
            </p>
          </div>
          <Button
            kind="primary"
            disabled={busy}
            onClick={() => void prepareProtection()}
          >
            {busy ? "Готовлю отчёт…" : "Подготовить защиту"}
          </Button>
        </div>
        {protectionPreview && (
          <div className="formula-protection-report">
            <Notice>
              Отчёт сформирован {timeLabel(protectionPreview.generatedAt)}. Он
              действителен до {timeLabel(protectionPreview.expiresAt)} и будет
              отменён, если снимок изменится.
            </Notice>
            {protectionPreview.totals.staleSheets > 0 && (
              <Notice tone="warning">
                {protectionPreview.totals.staleSheets} листов без свежего
                полного чтения. Их формулы не попадут в массовую защиту.
              </Notice>
            )}
            <div className="ai-metrics doctor-metrics">
              <div>
                <span>Формул прочитано</span>
                <strong>
                  {protectionPreview.totals.formulasRead.toLocaleString(
                    "ru-RU",
                  )}
                </strong>
              </div>
              <div>
                <span>Уже защищено и совпало</span>
                <strong>
                  {protectionPreview.totals.protectedNow.toLocaleString(
                    "ru-RU",
                  )}
                </strong>
                <small>до этого утверждения</small>
              </div>
              <div>
                <span>Можно добавить после подтверждения</span>
                <strong>
                  {protectionPreview.totals.protectable.toLocaleString("ru-RU")}
                </strong>
                <small>
                  {protectionPreview.safeRegions.length} повторяющихся областей
                </small>
              </div>
              <div>
                <span>Покрытие после подтверждения</span>
                <strong>
                  {protectionPreview.totals.coverageAfterApproval === null
                    ? "—"
                    : `${protectionPreview.totals.coverageAfterApproval}%`}
                </strong>
                <small>из прочитанных формул; без зон ручной проверки</small>
              </div>
              <div>
                <span>Требуют проверки</span>
                <strong>
                  {protectionPreview.totals.review.toLocaleString("ru-RU")}
                </strong>
                <small>{protectionPreview.reviewRegions.length} областей</small>
              </div>
              <div>
                <span>Исключено из защиты</span>
                <strong>
                  {protectionPreview.totals.excluded.toLocaleString("ru-RU")}
                </strong>
                <small>
                  внутренние ячейки объединений и точечные исключения
                </small>
              </div>
            </div>
            {protectionPreview.m11
              .filter((entry) => entry.status !== "manual_value_unprotected")
              .map((entry) => (
                <Notice
                  key={`${entry.sourceId}:${entry.gid}:${entry.cell}`}
                  tone={entry.status === "protectable" ? "info" : "warning"}
                >
                  M11 · {entry.document} → {entry.sheet}:{" "}
                  {entry.status === "protectable"
                    ? "войдёт в область массовой защиты после твоего подтверждения"
                    : "оставлена для ручной проверки"}
                  . Формула: <code>{entry.formula}</code>
                  {entry.reasons.length > 0 &&
                    ` Причина: ${entry.reasons.map(reviewReason).join("; ")}.`}
                </Notice>
              ))}
            {protectionPreview.m11
              .filter((entry) => entry.status === "manual_value_unprotected")
              .map((entry) => (
                <Notice
                  key={`${entry.sourceId}:${entry.gid}:${entry.cell}:manual`}
                  tone="warning"
                >
                  Google API сейчас читает M11 как число{" "}
                  <code>{enteredValueLabel(entry.currentValue)}</code> в{" "}
                  <a href={entry.url} target="_blank" rel="noreferrer">
                    {entry.document} → {entry.sheet}!M11
                  </a>
                  . Формулы в ячейке нет, а точного эталона M11 в истории SQLite
                  нет. Пример из области {entry.range} — только образец
                  семейства, не эталон: <code>{entry.formulaExample}</code>. M11
                  не войдёт в массовую защиту.
                </Notice>
              ))}
            {protectionPreview.manualSamples.length > 0 && (
              <details className="formula-subsection">
                <summary>
                  Ручные значения внутри формульных областей ·{" "}
                  {protectionPreview.manualSamples.length} примеров для сверки
                </summary>
                <DataTable
                  label="Ручные значения внутри формульных областей"
                  rows={protectionPreview.manualSamples}
                  rowKey={(r) => `${r.sourceId}:${r.gid}:${r.cell}`}
                  columns={[
                    {
                      id: "cell",
                      label: "Документ · лист · ячейка",
                      render: (r) => (
                        <a href={r.url} target="_blank" rel="noreferrer">
                          {r.document}
                          <small className="ai-block">
                            {r.sheet}!{r.cell} · область {r.range}
                          </small>
                        </a>
                      ),
                    },
                    {
                      id: "value",
                      label: "Текущее ручное значение",
                      render: (r) => enteredValueLabel(r.value),
                    },
                    {
                      id: "example",
                      label: "Формула-пример, не эталон",
                      render: (r) => (
                        <code className="formula-code-preview">
                          {r.sampleFormula}
                        </code>
                      ),
                    },
                  ]}
                />
              </details>
            )}
            <DataTable
              label="Предварительный результат по листам"
              rows={protectionPreview.sheets}
              rowKey={(r) => `${r.sourceId}:${r.gid}`}
              columns={[
                {
                  id: "sheet",
                  label: "Документ · лист",
                  render: (r) => (
                    <>
                      {r.document}
                      <small className="ai-block">
                        {r.sheet} · {r.at ? timeLabel(r.at) : "Нет проверки"}
                      </small>
                    </>
                  ),
                },
                {
                  id: "read",
                  label: "Прочитано",
                  render: (r) =>
                    r.formulasRead === null
                      ? "—"
                      : r.formulasRead.toLocaleString("ru-RU"),
                },
                {
                  id: "protected",
                  label: "Уже защищено",
                  render: (r) => r.protectedNow.toLocaleString("ru-RU"),
                },
                {
                  id: "safe",
                  label: "Можно добавить",
                  render: (r) => r.protectable.toLocaleString("ru-RU"),
                },
                {
                  id: "review",
                  label: "Проверить",
                  render: (r) => r.review.toLocaleString("ru-RU"),
                },
                {
                  id: "excluded",
                  label: "Исключено",
                  render: (r) => r.excluded.toLocaleString("ru-RU"),
                },
                {
                  id: "coverage",
                  label: "Станет защищено",
                  render: (r) =>
                    r.coverageAfterApproval === null
                      ? "—"
                      : `${r.coverageAfterApproval}%`,
                },
                {
                  id: "state",
                  label: "Снимок",
                  render: (r) =>
                    r.stale ? (
                      <Badge tone="warning">Нужна проверка</Badge>
                    ) : (
                      <Badge>Свежий</Badge>
                    ),
                },
              ]}
            />
            <DataTable
              label="Безопасные области для массового утверждения"
              rows={protectionPreview.safeRegions}
              rowKey={(r) => r.id}
              columns={[
                {
                  id: "area",
                  label: "Документ · лист · диапазон",
                  render: (r) => (
                    <>
                      {r.document}
                      <small className="ai-block">
                        {r.sheet}!{r.range}
                      </small>
                    </>
                  ),
                },
                {
                  id: "count",
                  label: "Новых эталонов",
                  render: (r) => r.newCells.toLocaleString("ru-RU"),
                },
                {
                  id: "kind",
                  label: "Тип",
                  render: (r) =>
                    r.merged
                      ? `Типовая · ${r.merged} объединённых якорей`
                      : "Типовая семья",
                },
                {
                  id: "manual",
                  label: "Ручные значения вне защиты",
                  render: (r) =>
                    (r.manualSamples || []).map((sample) => (
                      <a
                        key={sample.cell}
                        className="ai-block"
                        href={sample.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {sample.cell}: {enteredValueLabel(sample.value)}
                      </a>
                    )),
                },
                {
                  id: "sample",
                  label: "Формула-пример",
                  render: (r) => (
                    <code
                      className="formula-code-preview"
                      title={r.sampleFormula}
                    >
                      {r.sampleFormula}
                    </code>
                  ),
                },
              ]}
            />
            <details className="formula-subsection">
              <summary>
                Области, которые требуют ручной проверки ·{" "}
                {protectionPreview.reviewRegions.length}
              </summary>
              <DataTable
                label="Формульные области на ручную проверку"
                rows={protectionPreview.reviewRegions}
                rowKey={(r) => r.id}
                columns={[
                  {
                    id: "area",
                    label: "Документ · лист · диапазон",
                    render: (r) => (
                      <>
                        {r.document}
                        <small className="ai-block">
                          {r.sheet}!{r.range}
                        </small>
                      </>
                    ),
                  },
                  {
                    id: "count",
                    label: "Новых формул",
                    render: (r) => r.newCells.toLocaleString("ru-RU"),
                  },
                  {
                    id: "reasons",
                    label: "Почему",
                    render: (r) =>
                      (r.reasons || []).map(reviewReason).join("; "),
                  },
                  {
                    id: "sample",
                    label: "Формула-пример",
                    render: (r) => (
                      <code
                        className="formula-code-preview"
                        title={r.sampleFormula}
                      >
                        {r.sampleFormula}
                      </code>
                    ),
                  },
                ]}
              />
            </details>
            <div className="doctor-actions">
              <Button
                kind="primary"
                disabled={
                  busy ||
                  protectionPreview.totals.protectable === 0 ||
                  protectionPreview.totals.staleSheets >=
                    protectionPreview.sheets.length
                }
                onClick={() => {
                  setAck(false);
                  setMassConfirm(true);
                }}
              >
                Предпросмотр и подтверждение ·{" "}
                {protectionPreview.totals.protectable.toLocaleString("ru-RU")}{" "}
                ячеек
              </Button>
            </div>
          </div>
        )}
      </section>
      <DataTable
        label="Покрытие формул по листам"
        rows={state.metrics}
        rowKey={(r) => r.sourceId + r.gid}
        columns={[
          {
            id: "sheet",
            label: "Документ и лист",
            render: (r) => (
              <>
                {r.document}
                <small className="ai-block">
                  {r.sheet} · {r.readRows} строк × {r.readColumns} столбцов ·{" "}
                  {r.fullSheetRead
                    ? "Весь лист прочитан"
                    : "Ограниченный диапазон"}
                </small>
              </>
            ),
          },
          { id: "read", label: "Прочитано", render: (r) => r.formulasRead },
          {
            id: "protect",
            label: "Защищено / проверено",
            render: (r) => `${r.protectedCells} / ${r.checkedCells}`,
          },
          {
            id: "without",
            label: "Без эталона",
            render: (r) => r.unprotectedFormulas,
          },
          {
            id: "coverage",
            label: "Покрытие",
            render: (r) =>
              r.protectedPercent === null ? "—" : `${r.protectedPercent}%`,
          },
          {
            id: "damage",
            label: "Нарушения / исключения",
            render: (r) => `${r.damage} / ${r.exceptions}`,
          },
          {
            id: "at",
            label: "Последняя проверка",
            render: (r) => (
              <>
                {timeLabel(r.at)}
                {r.stale && <Badge tone="warning">Устарело</Badge>}
              </>
            ),
          },
        ]}
      />
      <div className="ai-filters">
        <Field label="Документ">
          <select
            value={document}
            onChange={(e) => {
              setDocument(e.target.value);
              setSheet("");
              setSelected([]);
            }}
          >
            <option value="">Все документы</option>
            {[
              ...new Map(
                state.regions.map((r) => [r.sourceId, r.document]),
              ).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Лист">
          <select
            value={sheet}
            onChange={(e) => {
              setSheet(e.target.value);
              setSelected([]);
            }}
          >
            <option value="">Все листы</option>
            {[
              ...new Map(
                state.regions
                  .filter((r) => !document || r.sourceId === document)
                  .map((r) => [r.gid, r.sheet]),
              ).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Области">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="pending">Ожидают утверждения / изменены</option>
            <option value="protected">Есть защищённые ячейки</option>
            <option value="all">Все области</option>
          </select>
        </Field>
      </div>
      <p className="panel-note">
        Область объединяет одну семью формул в столбце; защищаются только адреса
        из списка. Промежутки и ручные значения не включаются автоматически.
      </p>
      <div className="doctor-actions">
        <Button
          disabled={!rows.some((r) => !r.stale)}
          onClick={() => setSelected(rows.filter((r) => !r.stale).slice(0, 50))}
        >
          Выбрать до 50 областей по фильтру
        </Button>
        <Button onClick={() => setSelected([])}>Снять выбор</Button>
        <Button
          kind="primary"
          disabled={!selected.length || busy}
          onClick={() => {
            setAck(false);
            setConfirm(true);
          }}
        >
          Утвердить выбранные ({selected.length})
        </Button>
      </div>
      <DataTable
        label="Области формул для утверждения"
        rows={rows}
        rowKey={(r) => r.id}
        columns={[
          {
            id: "select",
            label: "Выбор",
            render: (r) => (
              <input
                type="checkbox"
                aria-label={`Выбрать ${r.sheet} ${r.range}`}
                disabled={
                  r.stale ||
                  (selected.length >= 50 &&
                    !selected.some((s) => s.id === r.id))
                }
                checked={selected.some((s) => s.id === r.id)}
                onChange={(e) =>
                  setSelected((old) =>
                    e.target.checked
                      ? [...old, r]
                      : old.filter((s) => s.id !== r.id),
                  )
                }
              />
            ),
          },
          {
            id: "region",
            label: "Область",
            render: (r) => (
              <button
                className="text-link"
                onClick={() => {
                  setArea(r);
                  setPage(0);
                  setSearch("");
                  setReason("");
                }}
              >
                {r.sheet}
                <small className="ai-block">
                  {r.range} ·{" "}
                  {r.kind === "typical"
                    ? "Типовая семья"
                    : "Индивидуальная формула"}
                </small>
              </button>
            ),
          },
          {
            id: "cells",
            label: "Формул / защищено",
            render: (r) => `${r.count} / ${r.protected}`,
          },
          {
            id: "manual",
            label: "Ручных / объединений",
            render: (r) => `${r.manual} / ${r.merged}`,
          },
          {
            id: "errors",
            label: "Ошибки / изменения эталона",
            render: (r) => `${r.errors} / ${r.changed}`,
          },
          {
            id: "sample",
            label: "Пример",
            render: (r) => {
              const formula = r.samples[0]?.formula;
              return (
                <code
                  className="formula-code-preview"
                  title={formula || "Формула для примера отсутствует"}
                >
                  {formula || "Нет примера"}
                </code>
              );
            },
          },
        ]}
      />
      <details className="formula-subsection">
        <summary>Точечные исключения · {state.exceptions.length}</summary>
        <DataTable
          label="Исключения формульных снимков"
          rows={state.exceptions}
          rowKey={(r) => r.id}
          columns={[
            { id: "cell", label: "Ячейка", render: (r) => r.cell },
            { id: "reason", label: "Причина", render: (r) => r.reason },
            { id: "at", label: "До", render: (r) => timeLabel(r.expiresAt) },
            {
              id: "state",
              label: "Состояние",
              render: (r) =>
                r.status === "revoked"
                  ? "Отменено"
                  : Date.parse(r.expiresAt) < Date.now()
                    ? "Истекло"
                    : "Только для зафиксированного содержимого",
            },
            {
              id: "revoke",
              label: "Действие",
              render: (r) => (
                <Button
                  disabled={busy || r.status === "revoked"}
                  onClick={() => void act("exceptions/revoke", { id: r.id })}
                >
                  Отменить
                </Button>
              ),
            },
          ]}
        />
      </details>
      <Modal
        open={massConfirm}
        onClose={() => {
          if (!busy) setMassConfirm(false);
        }}
        title="Подтвердить массовую защиту"
        description="Будут сохранены точные формулы только новых ячеек из свежих безопасных областей. Производственные таблицы останутся только для чтения."
      >
        {protectionPreview && (
          <>
            <p>
              Добавить{" "}
              {protectionPreview.totals.protectable.toLocaleString("ru-RU")}{" "}
              формул из {protectionPreview.safeRegions.length} областей. Уже
              действующие эталоны останутся без изменений; подозрительные
              области не войдут в операцию.
            </p>
            <ul>
              {protectionPreview.sheets
                .filter((r) => r.protectable > 0)
                .map((r) => (
                  <li key={`${r.sourceId}:${r.gid}`}>
                    {r.document} · {r.sheet}:{" "}
                    {r.protectable.toLocaleString("ru-RU")} новых формул;
                    покрытие{" "}
                    {r.coverageNow === null ? "—" : `${r.coverageNow}%`} →{" "}
                    {r.coverageAfterApproval === null
                      ? "—"
                      : `${r.coverageAfterApproval}%`}
                  </li>
                ))}
            </ul>
            {protectionPreview.m11.length > 0 &&
              protectionPreview.m11[0].status !==
                "manual_value_unprotected" && (
                <Notice>
                  M11 будет сохранена только как точный эталон обнаружения:{" "}
                  <code>{protectionPreview.m11[0].formula}</code>. Это не
                  разрешение на её исправление.
                </Notice>
              )}
            {protectionPreview.m11.some(
              (entry) => entry.status === "manual_value_unprotected",
            ) && (
              <Notice tone="warning">
                M11 сейчас содержит ручное значение{" "}
                <code>
                  {enteredValueLabel(protectionPreview.m11[0].currentValue)}
                </code>
                , поэтому не входит в это утверждение. Массовое действие не
                изменит M11.
              </Notice>
            )}
            <Notice tone="warning">
              Эталон подтверждает текущее содержимое, но сам по себе не
              доказывает его бизнес-корректность. Для одиночных, изменённых,
              подозрительных и неполностью проверенных областей потребуется
              отдельный просмотр.
            </Notice>
            <Field label="Подтверждение владельца">
              <label>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />{" "}
                Я проверил сводку и разрешаю добавить новые точные эталоны
                только для перечисленных безопасных областей. Google Sheets не
                изменять.
              </label>
            </Field>
          </>
        )}
        {error && <Notice tone="warning">{error}</Notice>}
        <Button
          kind="primary"
          disabled={!ack || busy || !protectionPreview}
          onClick={async () => {
            if (!protectionPreview) return;
            const result = await act("bulk-approve", {
              previewId: protectionPreview.previewId,
              acknowledged: true,
            });
            if (result) {
              setMassConfirm(false);
              setProtectionPreview(null);
            }
          }}
        >
          Подтвердить защиту формул
        </Button>
      </Modal>
      <Modal
        open={confirm}
        onClose={() => {
          if (!busy) setConfirm(false);
        }}
        title="Утверждение формульных областей"
        description="Вы утверждаете снимок диагностики; разрешения на исправление Google Sheets не выдаются."
      >
        <p>
          Областей: {selected.length}. Точных формул:{" "}
          {selected.reduce((n, r) => n + r.count, 0)}. Объединённых якорей:{" "}
          {selected.reduce((n, r) => n + r.merged, 0)}.
        </p>
        <Notice tone="warning">
          Формул с отображаемыми ошибками результата:{" "}
          {selected.reduce((n, r) => n + r.errors, 0)}. Ошибка поиска может быть
          ожидаемой; перед утверждением убедитесь в корректности формул. Ручные
          значения остаются вне защиты.
        </Notice>
        <ul>
          {selected.map((r) => (
            <li key={r.id}>
              {r.document} · {r.sheet}!{r.range} · {r.count} формул · версия{" "}
              {r.version.slice(0, 12)}
            </li>
          ))}
        </ul>
        <Field label="Подтверждение владельца">
          <label>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />{" "}
            Я просмотрел точные формулы и исключения выбранных областей и
            утверждаю их как эталон диагностики. Изменённая бизнес-логика
            заменит соответствующие эталоны новой версией.
          </label>
        </Field>
        {error && <Notice tone="warning">{error}</Notice>}
        <Button
          kind="primary"
          disabled={!ack || busy}
          onClick={async () => {
            if (
              await act("approve", {
                regions: selected.map((r) => ({
                  id: r.id,
                  version: r.version,
                })),
                acknowledged: true,
              })
            ) {
              setConfirm(false);
              setSelected([]);
            }
          }}
        >
          Подтвердить эталоны
        </Button>
      </Modal>
      <Modal
        open={!!area}
        onClose={() => setArea(null)}
        title="Точные формулы области"
        description="Текущий кандидат и история версий; совпадение с соседями не доказывает правильность."
      >
        {area && (
          <>
            <p>
              {area.document} · {area.sheet}!{area.range}
            </p>
            <p>
              Зависимости: {area.dependencies.join(", ") || "Локальные ссылки"}.
              Объединённых якорей: {area.merged}.
            </p>
            <Field label="Поиск ячейки или формулы">
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
                placeholder="Например, M11"
              />
            </Field>
            {detail && (
              <DataTable
                label="Точные формулы снимка"
                rows={detail.cells}
                rowKey={(r) => r.cell}
                pagination={{
                  page,
                  size,
                  total: detail.total,
                  onPageChange: setPage,
                  onSizeChange: (value) => {
                    setSize(value);
                    setPage(0);
                  },
                }}
                columns={[
                  {
                    id: "cell",
                    label: "Ячейка",
                    render: (r) => (
                      <a
                        href={r.url}
                        className="text-link"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r.cell}
                      </a>
                    ),
                  },
                  {
                    id: "formula",
                    label: "Эталон-кандидат",
                    render: (r) => (
                      <code className="formula-code-full">{r.formula}</code>
                    ),
                  },
                  {
                    id: "merge",
                    label: "Объединение",
                    render: (r) => r.merge || "Нет",
                  },
                ]}
              />
            )}
            <h3>Ручные промежутки — не защищены</h3>
            <ul>
              {area.manualSamples.map((s) => (
                <li key={s.cell}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.cell}
                  </a>
                  : {JSON.stringify(s.value)}
                </li>
              ))}
            </ul>
            <h3>Версии снимка</h3>
            <ul>
              {detail?.history.map((v) => (
                <li key={v.version}>
                  {timeLabel(v.at)} · {v.version.slice(0, 12)}
                </li>
              ))}
            </ul>
            <Field label="Причина отмены защиты области">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <Button
              disabled={busy || reason.trim().length < 5}
              onClick={async () => {
                if (await act("revoke", { id: area.id, reason })) setArea(null);
              }}
            >
              Отменить защиту области
            </Button>
          </>
        )}
      </Modal>
    </section>
  );
}
export function FormulaExceptionAction({ incidentId }: { incidentId: string }) {
  const [reason, setReason] = useState(""),
    [until, setUntil] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div>
      <h3>Допустимое ручное исключение</h3>
      <p className="panel-note">
        Только эта ячейка, версия эталона и текущее содержимое. При изменении
        значения исключение перестаёт применяться. Это не исправление.
      </p>
      <Field label="Причина исключения">
        <input
          value={reason}
          maxLength={1000}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <Field label="Действует до">
        <input
          type="date"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
        />
      </Field>
      <Button
        disabled={busy || reason.trim().length < 5 || !until}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await fetch(
              "/api/intelligence/doctor/formulas/exceptions",
              {
                method: "POST",
                credentials: "include",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  incidentId,
                  reason,
                  expiresAt: new Date(until + "T23:59:59+03:00").toISOString(),
                }),
              },
            );
            const data = await r.json();
            setMessage(
              r.ok
                ? "Точечное исключение сохранено. Google Sheets не изменялся."
                : data.message || "Не удалось сохранить исключение",
            );
          } catch {
            setMessage("Агент недоступен");
          } finally {
            setBusy(false);
          }
        }}
      >
        Сохранить точечное исключение
      </Button>
      {message && <Notice>{message}</Notice>}
    </div>
  );
}
