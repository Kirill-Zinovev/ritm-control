import { DiagnosticReview, type DiagnosticState } from "./DiagnosticReview";
import {
  FormulaIntelligence,
  FormulaExceptionAction,
  type FormulaState,
} from "./FormulaIntelligence";
import {
  MonitoringSheets,
  type ScopeSheet,
  type BusinessDraft,
} from "./MonitoringSheets";
import {
  FormulaPreview,
  KpiImpactPanel,
  type RulePreview,
  type KpiImpact,
} from "./DoctorEvidence";
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
  Search,
} from "./ui";
import { ArrowSquareOut, ArrowsClockwise } from "./icons";
import {
  type Incident,
  type IncidentSummary,
  type PageResult,
  statusLabel,
  timeLabel,
} from "./intelligence";
import { useAgentResource } from "./useAgent";
import { TestRepairPanel } from "./TestRepairPanel";
type DoctorState = {
  formulaIntelligence?: FormulaState;
  review?: DiagnosticState;
  ok: true;
  running: boolean;
  fastRunning?: boolean;
  lastCheck: string | null;
  lastSuccessfulCheck: string | null;
  checkedFormulas: number | null;
  formulasRead: number | null;
  connection: string;
  demoCheckedFormulas: number;
  kpiImpact?: KpiImpact | null;
  manualAudit?: {
    channel: string;
    at: string;
    formulasRead: number;
    returnedCells: number;
    sheets: {
      name: string;
      gid: number;
      formulasRead: number;
      errors: unknown[];
      plannedMatches: number;
      plannedCandidates: number;
    }[];
  } | null;
  demoEnabled: boolean;
  testRepairEnabled?: boolean;
  productionRepairEnabled?: boolean;
  repairQueue?: {
    awaitingConfirmation: number;
    queued: number;
    executing: number;
    checking: number;
    needsDecision: number;
    fixedToday: number;
    items: {
      id: string;
      incidentId: string;
      status: string;
      direction: "repair" | "rollback";
      sourceName: string;
      target: {
        documentId: string;
        sheetId: number;
        sheet: string;
        cell: string;
      };
      createdAt: string;
      resultAt: string | null;
      errorCode: string | null;
      message: string | null;
    }[];
  } | null;
  documents: {
    id: string;
    name: string;
    department: string;
    demonstration: boolean;
    purpose: string;
    pendingRules: number;
    formulaRules?: {
      sheet: string;
      gid: number;
      id: string;
      range: string;
      approval: string;
      templates: string[];
      when: unknown;
      exceptions: unknown[];
      preview?: RulePreview;
      applicable: number;
      present: number;
      candidateMatches: number;
      samples: { cell: string; formula: string | null; result: unknown }[];
      importRows: {
        cell: string;
        formula: string;
        references: { documentId: string; range: string }[];
      }[];
    }[];
    sourceUrl: string | null;
    sheets: ScopeSheet[];
    businessPreview?: BusinessDraft | null;
    check: {
      classifications?: Record<string, number>;
      expectedNA?: number;
      status: string;
      at: string;
      message: string;
      checkedFormulas: number | null;
      issueCount: number | null;
      lastSuccessfulAt?: string;
      readVerifiedAt?: string;
      formulasRead?: number | null;
      returnedCells?: number;
      durationMs?: number;
      stale?: boolean;
      httpStatus?: number | null;
      api?: { readRequests: number; retries: number } | null;
      sheetMetrics?: {
        name: string;
        formulasRead: number;
        returnedCells: number;
      }[];
    } | null;
  }[];
};
const categories: Record<string, string> = {
  normal: "Нормальное ожидаемое поведение",
  suspicious: "Подозрительное значение",
  confirmed_formula: "Нарушение утверждённой формулы",
  business_review: "Бизнес-логика: ручная проверка",
  source_data_quality: "Качество исходных данных · возможное влияние на KPI",
};
const repairQueueLabels: Record<string, string> = {
  pending: "Ждёт подтверждения",
  queued: "В очереди",
  executing: "Исполняется",
  checking: "Проверяется",
  verified: "Проверено",
  needs_review: "Нужна ручная проверка",
  uncertain: "Результат требует проверки",
  written_unverified: "Записано, проверка не завершена",
  blocked: "Запись не выполнена",
  already_restored: "Уже восстановлено и проверено",
  cancelled: "Отменено",
  superseded: "Заменено новым предложением",
};
const types: Record<string, string> = {
  formula_missing: "Формула отсутствует",
  formula_number: "Формула заменена числом",
  formula_text: "Формула заменена текстом",
  formula_history_change: "Изменение неутверждённой формулы",
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
  if (value && typeof value === "object" && "entered" in value) {
    const native = value as {
      entered: {
        formulaValue?: string;
        numberValue?: number;
        stringValue?: string;
        boolValue?: boolean;
      } | null;
    };
    return String(
      native.entered?.formulaValue ??
        native.entered?.numberValue ??
        native.entered?.stringValue ??
        native.entered?.boolValue ??
        "Пустая ячейка",
    );
  }
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    "formula" in value
  ) {
    const entry = value as {
      formula?: string | null;
      error?: string;
      message?: string;
    };
    return (
      (entry.formula || "Формула отсутствует") +
      " · Результат: #" +
      entry.error +
      (entry.message ? " · " + entry.message : "")
    );
  }
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
function sourceValue(value: Record<string, unknown>) {
  return String(
    value.stringValue ??
      value.numberValue ??
      value.boolValue ??
      "Пустое значение",
  );
}
function productKeyOf(incident: Incident) {
  if (!incident.observed || typeof incident.observed !== "object") return "";
  const key = (incident.observed as Record<string, unknown>).productKey;
  return typeof key === "string" ? key : "";
}
function sourceStateOf(incident: Incident) {
  if (incident.type !== "data_quality_root_cause") return incident.sourceState;
  const observed = incident.observed as
    | {
        entered?: Record<string, unknown> | null;
        effective?: unknown;
        formula?: string | null;
      }
    | null
    | undefined;
  const hasValue = (value: unknown): boolean => {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return value.trim() !== "";
    if (typeof value === "object")
      return Object.values(value as Record<string, unknown>).some(hasValue);
    return true;
  };
  const populated =
    hasValue(observed?.entered) || hasValue(observed?.effective);
  // Older stored payloads may say "missing" even though their last observed
  // value is populated. Never render that stale contradiction as an empty cell.
  if (
    incident.sourceState === "missing" &&
    (populated || (!!observed?.formula && observed?.effective == null))
  )
    return "insufficient_data";
  return incident.sourceState;
}
function sourceFieldLabel(incident: Incident) {
  if (
    incident.sourceId === "doctor-shop-one" &&
    (incident.sourceFieldColumn === "P" ||
      /^P[1-9][0-9]*$/.test(incident.sourceCell || incident.cell || ""))
  )
    return "Вид";
  return incident.sourceField || "Вид товара";
}
function problemSeverityLabel(incident: Incident) {
  if (
    incident.type === "data_quality_root_cause" &&
    ["insufficient_data", "restored_pending_recalculation"].includes(
      sourceStateOf(incident) || "",
    )
  )
    return statusLabel.medium;
  return statusLabel[incident.severity] || incident.severity;
}
function problemTitle(incident: Incident) {
  if (incident.groupedRootCause)
    return `Артикул не найден в «${incident.groupedRootCause.lookupSheet}»`;
  if (incident.type === "unavailable" && ["app", "api:printing", "api:assembly"].includes(incident.sourceId))
    return problemEntity(incident) + " недоступен";
  if (
    incident.monitorStatus === "resolved" &&
    incident.sourceRecoveryOperation?.status === "verified" &&
    incident.sourceRecoveryOperation.result?.writeSucceeded
  )
    return "Исправлено агентом: зависимый расчёт восстановлен";
  if (
    incident.monitorStatus === "resolved" &&
    incident.sourceRecoveryOperation?.status === "already_restored"
  )
    return "Источник восстановлен и проверен";
  if (incident.monitorStatus === "resolved")
    return "Устранено: повторная проверка подтвердила восстановление";
  if (incident.type === "formula_history_change") {
    const observed = incident.observed as { entered?: { numberValue?: number; stringValue?: string; formulaValue?: string } } | undefined;
    return observed?.entered?.numberValue !== undefined ? "Формула заменена числом" : observed?.entered?.stringValue !== undefined ? "Формула заменена текстом" : observed?.entered?.formulaValue ? "Формула изменена" : "Формула удалена";
  }
  if (incident.type !== "data_quality_root_cause") return incident.title;
  const sourceState = sourceStateOf(incident);
  if (sourceState === "missing")
    return `В каталоге не указан «${sourceFieldLabel(incident)}»`;
  if (sourceState === "restored_pending_recalculation")
    return "Источник восстановлен, проверяется KPI";
  if (sourceState === "dependent_formula_error")
    return "Источник заполнен, зависимая формула возвращает ошибку";
  if (sourceState === "insufficient_data")
    return "Источник заполнен, результат расчёта не подтверждён";
  return "Недостаточно данных, чтобы определить состояние источника";
}
function problemEntity(incident: Incident) {
  return ({ app: "Сайт RITM", "api:printing": "API печати", "api:assembly": "API сборки" } as Record<string, string>)[incident.sourceId] || incident.sourceName;
}
function problemStateLabel(incident: Incident) {
  const operation = incident.sourceRecoveryOperation;
  if (operation) {
    const labels: Record<string, string> = { repairing: "Исправляется", checking: "Проверяется", verified: "Исправлено", already_restored: "Устранено", written_unverified: "Записано, проверка не завершена", uncertain: "Результат записи не подтверждён", blocked: "Требует вмешательства", needs_review: "Требует вмешательства" };
    if (labels[operation.status]) return labels[operation.status];
  }
  if (incident.monitorStatus === "resolved") return "Устранено";
  if (incident.recoveryCandidate && sourceStateOf(incident) === "missing") return "Ожидает подтверждения";
  if (incident.lifecycleState === "detected") return "Обнаружено";
  if (incident.lifecycleState === "awaiting_recheck")
    return "Ожидает перепроверки";
  if (incident.lifecycleState === "restored_checking_kpi")
    return "Источник восстановлен, проверяется KPI";
  if (incident.lifecycleState === "needs_intervention")
    return "Требует вмешательства";
  const sourceState = sourceStateOf(incident);
  if (sourceState === "missing") return "Источник пуст";
  if (sourceState === "restored_pending_recalculation")
    return "Источник восстановлен, проверяется KPI";
  if (sourceState === "dependent_formula_error") return "Требует вмешательства";
  if (sourceState === "insufficient_data") return "Ожидает перепроверки";
  return incident.type === "data_quality_root_cause"
    ? "Ожидает перепроверки"
    : statusLabel[incident.status] || incident.status;
}
function problemCause(incident: Incident) {
  if (incident.groupedRootCause) return incident.cause || "Общая ошибка поиска";
  if (incident.monitorStatus === "resolved" && incident.resolutionCause)
    return incident.resolutionCause;
  if (
    incident.type === "data_quality_root_cause" &&
    sourceStateOf(incident) === "restored_pending_recalculation"
  )
    return "Источник заполнен после пропуска, но зависимый расчёт пока не дал подтверждённое числовое значение.";
  if (
    incident.type === "data_quality_root_cause" &&
    sourceStateOf(incident) === "insufficient_data"
  )
    return `Источник заполнен, но числовой результат зависимого расчёта не подтверждён. По последнему снимку нельзя отличить задержку пересчёта от нехватки данных.`;
  return incident.cause || "Причина не установлена";
}
function problemRecommendation(incident: Incident) {
  if (incident.groupedRootCause)
    return incident.recommendation || "Проверьте запись артикула в справочнике.";
  if (
    incident.monitorStatus === "resolved" &&
    incident.sourceRecoveryOperation?.status === "verified" &&
    incident.sourceRecoveryOperation.result?.writeSucceeded
  )
    return (
      incident.sourceRecoveryOperation.result.resolutionCause ||
      "Агент восстановил подтверждённое значение и проверил зависимые расчёты."
    );
  if (
    incident.monitorStatus === "resolved" &&
    incident.sourceRecoveryOperation?.status === "already_restored"
  )
    return "Источник был восстановлен до запуска; Google Sheets API подтвердил значение и зависимые расчёты.";
  if (incident.monitorStatus === "resolved")
    return "Исправление не выполнялось. Инцидент закрыт после успешной read-only проверки источника и зависимых расчётов.";
  if (
    incident.type === "data_quality_root_cause" &&
    sourceStateOf(incident) === "insufficient_data"
  )
    return "Проверьте значение коэффициента и зависимые ячейки в Google Sheets. Не изменяйте формулы; закрыть проблему можно после успешной повторной проверки всей цепочки.";
  return (
    incident.recommendation ||
    incident.action ||
    "Повторно проверить источник и зависимый расчёт."
  );
}
function kpiEvidenceLabel(incident: Incident) {
  const evidence = incident.impactEvidence;
  if (incident.kpiImpactVerified || evidence?.verified)
    return (
      evidence?.summary || incident.impact || "Влияние на KPI подтверждено"
    );
  if (
    incident.monitorStatus === "resolved" &&
    incident.sourceRecoveryOperation?.status === "verified" &&
    incident.sourceRecoveryOperation.result?.writeSucceeded
  )
    return "Расчёт восстановлен · влияние на KPI не измерено";
  if (incident.groupedRootCause)
    return "Ошибка поиска подтверждена · влияние на KPI не измерено";
  if (incident.errorCells?.length)
    return `Ошибка расчёта подтверждена · влияние на KPI не измерено`;
  return "Влияние на KPI не подтверждено";
}
function SourceRecoveryApproval({
  incident,
  busy,
  available,
  onWrite,
}: {
  incident: Incident;
  busy: boolean;
  available: boolean;
  onWrite: (incidentId: string, candidateVersion?: string) => void;
}) {
  const candidate = incident.recoveryCandidate,
    operation = incident.sourceRecoveryOperation;
  const operationLabel: Record<string, string> = {
    repairing: "Исправляется",
    checking: "Проверяется",
    written_unverified: "Записано, проверка не завершена",
    verified: "Исправлено",
    already_restored: "Уже восстановлено и проверено",
    blocked: "Не выполнено · требуется проверка",
    needs_review: "Требует вмешательства",
    uncertain: "Результат записи не подтверждён",
  };
  if (operation)
    return (
      <section
        className="doctor-source-recovery"
        aria-label="Восстановление исходных данных"
      >
        <h4>{operationLabel[operation.status] || "Проверяется"}</h4>
        <p>
          {operation.target.sheet}!{operation.target.cell} ={" "}
          {sourceValue(operation.approvedValue)}
        </p>
        {operation.result?.resolutionCause && (
          <small>{operation.result.resolutionCause}</small>
        )}
        {operation.result?.message && <small>{operation.result.message}</small>}
        {operation.result?.timing?.stages && (
          <details className="doctor-recovery-timing">
            <summary>
              Этапы восстановления
              {typeof operation.result.timing.totalMs === "number"
                ? ` · ${(operation.result.timing.totalMs / 1000).toFixed(1)} с`
                : ""}
            </summary>
            <ul
              className="doctor-recovery-timings"
              aria-label="Время этапов восстановления"
            >
              {Object.entries(operation.result.timing.stages).map(
                ([id, stage]) => (
                  <li key={id}>
                    <span>{stage.label || id}</span>
                    <small>
                      {typeof stage.durationMs === "number"
                        ? `${(stage.durationMs / 1000).toFixed(2)} с`
                        : "выполнялся"}
                      {stage.attempts
                        ? ` · попыток чтения ${stage.attempts}/${stage.maxAttempts || stage.attempts}`
                        : ""}
                    </small>
                  </li>
                ),
              )}
            </ul>
          </details>
        )}
        {operation.status === "verified" ||
        operation.status === "already_restored" ? (
          <small>Проверено: {timeLabel(operation.updatedAt)}</small>
        ) : null}
      </section>
    );
  if (!candidate || !incident.cell) return null;
  const value = sourceValue(candidate.value),
    exact = `${incident.sheet}!${incident.cell} = ${value}`;
  return (
    <section
      className="doctor-source-recovery"
      aria-label="Разрешение на восстановление исходных данных"
    >
      <strong>Ожидает подтверждения записи</strong>
      <h4>{candidate.origin === "owner_proposal" ? "Значение предложено владельцем" : "Значение из последнего успешного снимка"}</h4>
      <p>{exact} · {timeLabel(candidate.observedAt)}</p>
      <small>{candidate.evidence}</small>
      {incident.repairRequested && (
        <small>Ранее сохранённая заявка подтверждает значение; разрешение на запись в ней отсутствует.</small>
      )}
      <Button
        kind="primary"
        disabled={busy || !available}
        onClick={() => onWrite(incident.id, candidate.version)}
      >
        Разрешить запись и восстановить {incident.cell}
      </Button>
      <small>
        Нажатие разрешает записать только это значение в эту ячейку. RITM
        сначала перепроверит заявку, снимок и текущее значение; при конфликте
        запись будет отменена.
      </small>
      {!available && <small>Production writer не настроен; запись недоступна.</small>}
    </section>
  );
}
function SourceValueProposal({ incident, busy, onPropose }: { incident: Incident; busy: boolean; onPropose: (value: string) => void }) {
  const [value, setValue] = useState("");
  return <section className="doctor-source-recovery">
    <h4>Уточните «Вид» для {incident.cell}</h4>
    <p>Прежнее значение этой ячейки не найдено. Укажите верное значение; затем RITM проверит источник и покажет точное изменение для разрешения записи.</p>
    <Field label="Вид"><input value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} /></Field>
    <Button disabled={busy || !value.trim()} onClick={() => onPropose(value.trim())}>Проверить предложение</Button>
  </section>;
}
function canRestoreFormula(incident: Incident) {
  return incident.type === "formula_history_change" ||
    (!!incident.baselineVersion && incident.verification === "rule_confirmed" &&
      ["formula_number", "formula_text", "formula_missing", "formula_mismatch"].includes(incident.type));
}
export function TableDoctor() {
  const [advanced, setAdvanced] = useState(false);
  const resource = useAgentResource<DoctorState>(
    "/api/intelligence/doctor",
    true,
    10000,
  );
  const [source, setSource] = useState(""),
    [sheet, setSheet] = useState(""),
    [department, setDepartment] = useState(""),
    [type, setType] = useState(""),
    [severity, setSeverity] = useState(""),
    [group, setGroup] = useState(""),
    [status, setStatus] = useState("active"),
    [page, setPage] = useState(0),
    [size, setSize] = useState(20);
  const [query, setQuery] = useState(""),
    [committedQuery, setCommittedQuery] = useState(""),
    [counterFilter, setCounterFilter] = useState("all");
  const [selected, setSelected] = useState<Incident | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [selectedIncidentIds, setSelectedIncidentIds] = useState<string[]>([]),
    [bulkConfirm, setBulkConfirm] = useState<"ignore" | "restore" | null>(null),
    [bulkProgress, setBulkProgress] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setCommittedQuery(query.trim());
      setPage(0);
      if (query.trim()) setCounterFilter("custom");
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const params = new URLSearchParams({
    sheet,
    source,
    department,
    type,
    severity,
    group,
    status,
    q: committedQuery,
    p: String(page),
    limit: String(size),
  });
  const incidents = useAgentResource<PageResult<Incident>>(
    "/api/intelligence/incidents?" + params,
    !!resource.value && !resource.locked,
    10000,
  );
  const incidentRows = incidents.value?.rows || [],
    selectedIncidents = incidentRows.filter((item) =>
      selectedIncidentIds.includes(item.id),
    ),
    allRowsSelected =
      incidentRows.length > 0 &&
      incidentRows.every((item) => selectedIncidentIds.includes(item.id)),
    bulkRestoreEligible =
      selectedIncidents.length > 0 &&
      selectedIncidents.every(
        (item) =>
          item.type === "data_quality_root_cause" &&
          item.monitorStatus === "open" &&
          !!item.recoveryCandidate &&
          !item.sourceRecoveryOperation,
      ),
    bulkIgnoreEligible =
      selectedIncidents.length > 0 &&
      selectedIncidents.every(
        (item) =>
          item.monitorStatus === "open" &&
          item.type !== "data_quality_root_cause",
      );
  const selectionScope = params.toString();
  useEffect(() => {
    setSelectedIncidentIds([]);
  }, [selectionScope]);
  const summary = useAgentResource<IncidentSummary>(
    "/api/intelligence/incidents/summary?" + new URLSearchParams({ source, sheet, department, type, severity, q: committedQuery }),
    !!resource.value && !resource.locked,
    10000,
  );
  const detail = useAgentResource<{ ok: true; incident: Incident }>(
    "/api/intelligence/incidents/" + (selected?.id || ""),
    !!selected && !resource.locked,
    10000,
  );
  const incident = detail.value?.incident || selected;
  const recovery = incident?.sourceRecoveryOperation;
  const recoveryAfter =
    recovery?.after && typeof recovery.after === "object"
      ? (recovery.after as { userEnteredValue?: Record<string, unknown> })
      : null;
  const hasRecoveryReadback = !!recoveryAfter && "userEnteredValue" in recoveryAfter;
  const currentSourceLabel = hasRecoveryReadback
    ? ["verified", "already_restored"].includes(recovery?.status || "")
      ? "Сейчас, проверено"
      : "После записи, проверяется"
    : incident?.monitorStatus === "resolved"
      ? "При обнаружении"
      : "Последнее наблюдение";
  const currentSourceValue = hasRecoveryReadback
    ? text({ entered: recoveryAfter?.userEnteredValue || null })
    : incident
      ? text(incident.observed ?? incident.found)
      : "Неизвестно";
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
          path.endsWith("/recheck")
            ? "Повторная проверка документа запущена. Google Sheets читается без записи."
            : path.endsWith("/run")
              ? "Проверка запущена. Результаты появятся после завершения."
              : path.endsWith("/request-repair")
                ? "Заявка сохранена. Google Sheets не изменён."
                : path.endsWith("/source-recovery")
                  ? "Операция восстановления запущена. RITM повторно проверяет источник и зависимые расчёты."
                  : path.endsWith("/source-candidate")
                    ? "Значение проверено. Для записи подтвердите точную ячейку и значение."
                  : path.endsWith("/ignore")
                  ? "Проблема игнорируется. Google Sheets не изменён."
                  : "Демонстрационный источник проверен. Рабочие таблицы не изменены.",
        );
        await Promise.all([
          resource.reload(),
          incidents.reload(),
          summary.reload(),
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
  async function bulkAction(action: "ignore" | "recheck") {
    if (!selectedIncidents.length || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/intelligence/incidents/bulk-action", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          incidentIds: selectedIncidents.map((item) => item.id),
        }),
        signal: AbortSignal.timeout(30000),
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(
          result.message || "Не удалось выполнить массовое действие.",
        );
      setMessage(
        action === "recheck"
          ? `Проверка запущена для ${result.queued} проблем в ${result.sources} таблицах. Только чтение.`
          : `Игнорируется проблем: ${result.changed}. Google Sheets не изменён.`,
      );
      setSelectedIncidentIds([]);
      await Promise.all([incidents.reload(), summary.reload()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Агент недоступен");
    } finally {
      setBusy(false);
    }
  }
  async function bulkRestore() {
    if (!bulkRestoreEligible || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    let completed = 0;
    try {
      for (const item of selectedIncidents) {
        const candidate = item.recoveryCandidate!;
        setBulkProgress(
          `Восстановление ${completed + 1} из ${selectedIncidents.length}: ${item.sheet}!${item.cell}`,
        );
        const response = await fetch(
          "/api/intelligence/formula-repair/source-recovery",
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              incidentId: item.id,
              candidateVersion: candidate.version,
              explicitWriteApproval: true,
            }),
            signal: AbortSignal.timeout(30000),
          },
        );
        const started = await response.json();
        if (!response.ok || !started.ok)
          throw new Error(
            `${item.sheet}!${item.cell}: ${started.message || "операция не запущена"}`,
          );
        let terminal: { status?: string } | null = null;
        for (let attempt = 0; attempt < 240; attempt++) {
          const stateResponse = await fetch(
            "/api/intelligence/formula-repair/source-recovery?incidentId=" +
              encodeURIComponent(item.id),
            { credentials: "same-origin", signal: AbortSignal.timeout(15000) },
          );
          const stateResult = await stateResponse.json();
          if (!stateResponse.ok || !stateResult.ok)
            throw new Error(
              `${item.sheet}!${item.cell}: результат не удалось проверить; повторная запись не выполнялась.`,
            );
          const operation = stateResult.operation;
          if (!operation)
            throw new Error(`${item.sheet}!${item.cell}: операция отсутствует в журнале.`);
          if (!["repairing", "checking"].includes(operation.status)) {
            terminal = operation;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        if (!terminal)
          throw new Error(
            `${item.sheet}!${item.cell}: проверка превысила 8 минут; очередь остановлена без повторной записи.`,
          );
        if (!["verified", "already_restored"].includes(terminal.status || ""))
          throw new Error(
            `${item.sheet}!${item.cell}: результат «${terminal.status}». Очередь остановлена, остальные ячейки не запускались.`,
          );
        completed++;
      }
      setMessage(`Подтверждены и проверены восстановления: ${completed}.`);
      setSelectedIncidentIds([]);
      setBulkConfirm(null);
      await Promise.all([resource.reload(), incidents.reload(), summary.reload()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Массовое восстановление остановлено.");
      await Promise.all([resource.reload(), incidents.reload(), summary.reload()]);
    } finally {
      setBusy(false);
      setBulkProgress("");
    }
  }
  if (resource.locked || incidents.locked || summary.locked || detail.locked)
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
  const realDocuments = state.documents.filter((d) => !d.demonstration);
  const protectedAddresses = state.formulaIntelligence?.metrics.reduce(
    (n, m) => n + m.protectedCells,
    0,
  );
  return (
    <div className="doctor-center">
      {(resource.error || incidents.error || summary.error || error) && (
        <Notice tone="warning">
          {error || resource.error || incidents.error || summary.error}{" "}
          Предыдущие результаты могут быть устаревшими.
        </Notice>
      )}
      {message && <Notice>{message}</Notice>}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Контроль производственных таблиц</h2>
            <p className="panel-note">
              Последняя успешная проверка:{" "}
              {timeLabel(state.lastSuccessfulCheck)}
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
        <div className="doctor-fast-action">
          <Button
            kind="primary"
            disabled={busy || state.fastRunning}
            onClick={() => void act("/api/intelligence/doctor/fast")}
          >
            <ArrowsClockwise size={16} />
            {state.fastRunning ? "Быстрая проверка…" : "Проверить сейчас"}
          </Button>
          <span>
            Проверяет эталоны и обязательные источники с цепочками расчётов.
            Полный аудит доступен отдельно ниже.
          </span>
        </div>
        <div className="ai-metrics doctor-metrics doctor-overview-metrics">
          <div>
            <span>Подключено документов</span>
            <strong>{realDocuments.length}</strong>
          </div>
          <div>
            <span>Листов под наблюдением</span>
            <strong>
              {realDocuments.reduce((n, d) => n + d.sheets.length, 0)}
            </strong>
          </div>
          <div>
            <span>Защищённых адресов в последнем цикле</span>
            <strong>{protectedAddresses ?? "Нет проверки"}</strong>
          </div>
        </div>
        <div className="ai-metrics doctor-metrics doctor-overview-metrics doctor-queue-metrics">
          <div>
            <span>Активные проблемы</span>
            <strong>{summary.value?.allProblems ?? "—"}</strong>
          </div>
          <div>
            <span>Ожидают подтверждения</span>
            <strong>{state.repairQueue?.awaitingConfirmation ?? 0}</strong>
          </div>
          <div>
            <span>В очереди / выполняются</span>
            <strong>
              {(state.repairQueue?.queued ?? 0) +
                (state.repairQueue?.executing ?? 0) +
                (state.repairQueue?.checking ?? 0)}
            </strong>
          </div>
          <div>
            <span>Исправлено сегодня</span>
            <strong>{state.repairQueue?.fixedToday ?? 0}</strong>
          </div>
          <div>
            <span>Последняя успешная полная проверка</span>
            <strong className="doctor-time">
              {timeLabel(state.lastSuccessfulCheck)}
            </strong>
          </div>
        </div>
        {state.productionRepairEnabled && state.repairQueue && state.repairQueue.items.some((item) => !["verified", "already_restored", "cancelled", "superseded"].includes(item.status)) && (
          <section className="doctor-queue" aria-label="Очередь исправлений">
            <div className="panel-heading">
              <div>
                <h3>Очередь исправлений</h3>
                <p className="panel-note">
                  Каждая операция подтверждается отдельно и повторно проверяется
                  после записи.
                </p>
              </div>
            </div>
            {state.repairQueue.items.length ? (
              <ol className="doctor-queue-list">
                {state.repairQueue.items.filter((item) => !["verified", "already_restored", "cancelled", "superseded"].includes(item.status)).slice(0, 8).map((item) => (
                  <li key={item.id}>
                    <div>
                      <strong>
                        {item.sourceName} · {item.target.sheet} ·{" "}
                        {item.target.cell}
                      </strong>
                      <small>
                        {item.direction === "rollback"
                          ? "Откат"
                          : "Восстановление"}
                        {item.resultAt ? " · " + timeLabel(item.resultAt) : ""}
                      </small>
                      {item.message && <small>{item.message}</small>}
                    </div>
                    <Badge
                      tone={
                        item.status === "verified"
                          ? "success"
                          : ["needs_review", "uncertain"].includes(item.status)
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {repairQueueLabels[item.status] || item.status}
                    </Badge>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty title="Очередь пуста">
                Подтверждённые операции появятся здесь до завершения проверки.
              </Empty>
            )}
          </section>
        )}
        <div className="doctor-check-summary">
          <span>
            Быстрая проверка:{" "}
            {timeLabel(state.formulaIntelligence?.fastCheck?.at)} ·{" "}
            {state.formulaIntelligence?.fastCheck?.checkedCells ?? 0} защищённых
            ячеек ·{" "}
            {(
              (state.formulaIntelligence?.fastCheck?.durationMs ?? 0) / 1000
            ).toFixed(1)}{" "}
            с ·{" "}
            {state.formulaIntelligence?.fastCheck?.apiReadRequests ??
              state.formulaIntelligence?.fastCheck?.readRequests ??
              0}{" "}
            запросов Google API ·{" "}
            {state.formulaIntelligence?.fastCheck?.violations ?? 0} отклонений
            {state.formulaIntelligence?.fastCheck?.dataQuality?.status !==
              "not_applicable" &&
              state.formulaIntelligence?.fastCheck?.dataQuality &&
              ` · источники: ${state.formulaIntelligence.fastCheck.dataQuality.findings} проблем`}
          </span>
          <span>
            Формул прочитано глубоко: {state.formulasRead ?? "—"} · Защищённых
            эталонов: {protectedAddresses ?? "—"}
          </span>
        </div>
        <details className="ai-advanced">
          <summary>Подключённые таблицы и состояние доступа</summary>
          <DataTable
            label="Подключённые производственные таблицы"
            rows={realDocuments}
            rowKey={(d) => d.id}
            columns={[
              {
                id: "name",
                label: "Таблица",
                render: (d) => (
                  <>
                    <strong>{d.name}</strong>
                    <small className="ai-block">
                      {d.sheets.map((s) => s.name).join(" · ")}
                    </small>
                  </>
                ),
              },
              {
                id: "status",
                label: "Состояние",
                render: (d) => (
                  <Badge
                    tone={tone(
                      d.check?.stale
                        ? "unavailable"
                        : d.check?.status || "not_configured",
                    )}
                  >
                    {statusLabel[
                      d.check?.stale
                        ? "stale"
                        : d.check?.status || "not_configured"
                    ] || d.check?.status}
                  </Badge>
                ),
              },
              {
                id: "at",
                label: "Последняя проверка",
                render: (d) => timeLabel(d.check?.at),
              },
            ]}
          />
        </details>
      </section>
      <section
        className="panel doctor-problems"
        aria-labelledby="doctor-problems-title"
      >
        <div className="panel-heading">
          <div>
            <h2 id="doctor-problems-title">
              Проблемы качества данных и формул
            </h2>
            <p className="panel-note">
              В списке только текущие инциденты. Влияние на KPI отмечается
              подтверждённым лишь при наличии измеренного доказательства.
            </p>
          </div>
          {(state.repairQueue?.needsDecision ?? 0) > 0 && (
            <Badge tone="warning">
              {state.repairQueue?.needsDecision} заявки требуют решения
            </Badge>
          )}
        </div>
        <div
          className="doctor-dispatcher-counts"
          role="group"
          aria-label="Быстрые фильтры проблем"
        >
          {(
            [
              ["all", "Все проблемы", summary.value?.allProblems ?? "—"],
              ["critical", "Критические", summary.value?.critical ?? "—"],
              [
                "missing_source",
                "Нет исходных данных",
                summary.value?.missingSource ?? "—",
              ],
              [
                "calculation_error",
                "Ошибка расчёта KPI",
                summary.value?.calculationError ?? "—",
              ],
              [
                "needs_review",
                "Требуют проверки",
                summary.value?.needsReview ?? "—",
              ],
              ["fixed", "Исправлены", summary.value?.fixed ?? "—"],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              className="doctor-dispatcher-count"
              data-active={counterFilter === id}
              aria-pressed={counterFilter === id}
              onClick={() => {
                setCounterFilter(id);
                setPage(0);
                setStatus(id === "fixed" ? "fixed" : "active");
                setSeverity(id === "critical" ? "critical" : "");
                setGroup(
                  id === "missing_source" ||
                    id === "calculation_error" ||
                    id === "needs_review"
                    ? id
                    : "",
                );
              }}
            >
              <span>{label}</span>
              <strong>{count}</strong>
            </button>
          ))}
        </div>
        <div className="doctor-dispatcher-filters">
          <Field label="Документ">
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setSheet("");
                setPage(0);
                setCounterFilter("custom");
              }}
            >
              <option value="">Все документы</option>
              {realDocuments.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Лист">
            <select
              value={sheet}
              onChange={(e) => {
                setSheet(e.target.value);
                setPage(0);
                setCounterFilter("custom");
              }}
            >
              <option value="">Все листы</option>
              {[
                ...new Set(
                  realDocuments
                    .filter((document) => !source || document.id === source)
                    .flatMap((document) =>
                      document.sheets.map((item) => item.name),
                    ),
                ),
              ].map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </Field>
          <Field label="Тип проблемы">
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setPage(0);
                setCounterFilter("custom");
              }}
            >
              <option value="">Все типы</option>
              {Object.entries({
                ...types,
                data_quality_root_cause: "Качество исходных данных",
              }).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Приоритет">
            <select
              value={severity}
              onChange={(e) => {
                setSeverity(e.target.value);
                setPage(0);
                setCounterFilter("custom");
              }}
            >
              <option value="">Все приоритеты</option>
              {["critical", "high", "medium", "low"].map((value) => (
                <option key={value} value={value}>
                  {statusLabel[value] || value}
                </option>
              ))}
            </select>
          </Field>
          <Search
            label="Артикул или ячейка"
            value={query}
            onChange={(value) => {
              setQuery(value);
              setCounterFilter("custom");
            }}
          />
        </div>
        {incidents.value?.rows.length ? (
          <div className="doctor-bulk-bar" aria-label="Массовые действия с проблемами">
            <label className="doctor-bulk-select-all">
              <input
                type="checkbox"
                checked={allRowsSelected}
                onChange={(event) =>
                  setSelectedIncidentIds(
                    event.target.checked ? incidentRows.map((item) => item.id) : [],
                  )
                }
                aria-label="Выбрать все проблемы на этой странице"
              />
              <span>
                {allRowsSelected ? "Снять выбор на странице" : "Выбрать все на странице"}
              </span>
            </label>
            <span className="doctor-bulk-count">
              Выбрано {selectedIncidents.length}
              {incidents.value.total > incidentRows.length
                ? ` из ${incidents.value.total} · выбор только на текущей странице`
                : ""}
            </span>
            <div className="doctor-bulk-actions">
              <Button
                disabled={busy || !selectedIncidents.length || state.running || !!state.fastRunning}
                onClick={() => void bulkAction("recheck")}
              >
                Проверить выбранные
              </Button>
              <Button
                disabled={busy || !bulkIgnoreEligible}
                onClick={() => setBulkConfirm("ignore")}
              >
                Игнорировать выбранные
              </Button>
              <Button
                kind="primary"
                disabled={busy || !state.productionRepairEnabled || !bulkRestoreEligible}
                onClick={() => setBulkConfirm("restore")}
              >
                Восстановить выбранные
              </Button>
            </div>
            {!bulkIgnoreEligible && selectedIncidents.length > 0 && selectedIncidents.some((item) => item.type === "data_quality_root_cause") && (
              <small className="doctor-bulk-note">
                Первопричины качества исходных данных нельзя скрыть через игнорирование.
              </small>
            )}
            {!bulkRestoreEligible && selectedIncidents.length > 0 && (
              <small className="doctor-bulk-note">
                Массовое восстановление доступно, когда у каждой выбранной проблемы есть подтверждённое точное значение. Сейчас можно восстановить: {selectedIncidents.filter((item) => item.type === "data_quality_root_cause" && item.recoveryCandidate && !item.sourceRecoveryOperation).length} из {selectedIncidents.length}.
              </small>
            )}
          </div>
        ) : null}
        {(error || message || bulkProgress) && (
          <Notice tone={error ? "warning" : "neutral"}>
            {error || bulkProgress || message}
          </Notice>
        )}
        {incidents.loading && !incidents.value ? (
          <Busy label="Загружаю проблемы…" />
        ) : incidents.value?.rows.length ? (
          <div
            className="doctor-problems-list"
            aria-live="polite"
            aria-busy={incidents.loading}
          >
            {incidents.value.rows.map((item) => (
              <article
                className={`doctor-problem-card${["critical", "high"].includes(item.severity) ? " is-danger" : ""}`}
                key={item.id}
              >
                <div className="doctor-problem-row">
                  <label className="doctor-problem-select">
                    <input
                      type="checkbox"
                      checked={selectedIncidentIds.includes(item.id)}
                      onChange={(event) =>
                        setSelectedIncidentIds((current) =>
                          event.target.checked
                            ? [...current, item.id]
                            : current.filter((id) => id !== item.id),
                        )
                      }
                      aria-label={`Выбрать проблему: ${problemTitle(item)} · ${item.sheet || ""} ${item.cell || ""}`}
                    />
                  </label>
                  <div className="doctor-problem-copy">
                    <strong>{problemTitle(item)}</strong>
                    <span className="doctor-problem-product">
                      {productKeyOf(item) || problemEntity(item)}
                    </span>
                    <span className="doctor-problem-address">
                      {item.groupedRootCause
                        ? `${item.sourceName} · ${item.sheet} · ${item.groupedRootCause.rootCell} → ${item.groupedRootCause.affectedCells.map((cell) => cell.cell).join(", ")}`
                        : item.cell
                          ? `${item.sourceName} · ${item.sheet} · ${item.cell}`
                          : item.found || text(item.observed)}
                    </span>
                  </div>
                  <div className="doctor-problem-state">
                    <Badge
                      tone={
                        item.monitorStatus === "resolved"
                          ? "success"
                          : ["missing", "dependent_formula_error"].includes(
                                sourceStateOf(item) || "",
                              )
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {problemStateLabel(item)}
                    </Badge>
                    <Badge
                      tone={
                        problemSeverityLabel(item) === statusLabel.critical ||
                        problemSeverityLabel(item) === statusLabel.high
                          ? "warning"
                          : "neutral"
                      }
                    >
                      {problemSeverityLabel(item)}
                    </Badge>
                    <span className="doctor-problem-kpi">
                      {kpiEvidenceLabel(item)}
                    </span>
                  </div>
                  <div className="doctor-problem-actions">
                    <Button
                      kind="primary"
                      disabled={
                        busy ||
                        (state.running && !(state.productionRepairEnabled && (canRestoreFormula(item) || item.type === "data_quality_root_cause"))) ||
                        (item.monitorStatus === "resolved" && !item.sourceRecoveryOperation)
                      }
                      onClick={() =>
                        (state.productionRepairEnabled && (canRestoreFormula(item) || item.type === "data_quality_root_cause")) || !realDocuments.some((document) => document.id === item.sourceId)
                          ? setSelected(item)
                          : void act(`/api/intelligence/incidents/${item.id}/recheck`)
                      }
                    >
                      {item.monitorStatus === "resolved" && item.sourceRecoveryOperation ? "Результат исправления" : state.productionRepairEnabled && canRestoreFormula(item) ? "Восстановить" : state.productionRepairEnabled && item.type === "data_quality_root_cause" ? item.sourceRecoveryOperation ? "Состояние исправления" : item.recoveryCandidate ? "Восстановить" : "Уточнить значение" : !realDocuments.some((document) => document.id === item.sourceId) ? "Подробнее" : state.running ? "Проверка…" : "Проверить"}
                    </Button>
                    {item.sourceUrl && (
                      <a
                        className="button secondary"
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={item.cell ? `Открыть ячейку ${item.sheet}!${item.groupedRootCause?.rootCell || item.cell}` : `Открыть источник ${problemEntity(item)}`}
                      >
                        {item.cell ? "Открыть ячейку" : "Открыть источник"} <ArrowSquareOut size={15} />
                      </a>
                    )}
                  </div>
                </div>
                <details className="doctor-problem-details">
                  <summary>Подробнее</summary>
                  <dl>
                    <div>
                      <dt>Текущее состояние</dt>
                      <dd>
                        {problemStateLabel(item)}
                        {item.type === "data_quality_root_cause" &&
                        productKeyOf(item)
                          ? ` · ${item.sheet}!${item.cell} для ${productKeyOf(item)}`
                          : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>Причина</dt>
                      <dd>{problemCause(item)}</dd>
                    </div>
                    {item.groupedRootCause && (
                      <div>
                        <dt>Затронутые расчёты</dt>
                        <dd>
                          {item.groupedRootCause.affectedCells.map((cell) =>
                            cell.url ? (
                              <a
                                className="doctor-problem-cell-link"
                                href={cell.url}
                                target="_blank"
                                rel="noreferrer"
                                key={cell.cell}
                              >
                                {cell.sheet}!{cell.cell}
                              </a>
                            ) : (
                              <span key={cell.cell}>
                                {cell.sheet}!{cell.cell}
                              </span>
                            ),
                          )}
                          <span className="doctor-problem-cell-list">
                            Общая ячейка поиска: {item.sheet}!
                            {item.groupedRootCause.rootCell} · лист источника: «
                            {item.groupedRootCause.lookupSheet}».
                          </span>
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>Текущее значение</dt>
                      <dd>{text(item.observed)}</dd>
                    </div>
                    {item.monitorStatus === "resolved" && (
                      <div>
                        <dt>Проверено</dt>
                        <dd>
                          {timeLabel(item.resolutionAt || item.resolvedAt)}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>
                        {item.monitorStatus === "resolved"
                          ? "Результат"
                          : "Что проверить"}
                      </dt>
                      <dd>{problemRecommendation(item)}</dd>
                    </div>
                    <div>
                      <dt>Влияние на KPI</dt>
                      <dd>{kpiEvidenceLabel(item)}</dd>
                    </div>
                    <div>
                      <dt>Последнее наблюдение</dt>
                      <dd>
                        {timeLabel(item.lastSeen)} · {item.occurrences}{" "}
                        наблюдений
                      </dd>
                    </div>
                    {item.errorCells?.length || item.affectedCells?.length ? (
                      <div>
                        <dt>Цепочка зависимостей</dt>
                        <dd>
                          {item.errorCells?.length ? (
                            <span className="doctor-problem-errors">
                              {item.monitorStatus === "resolved"
                                ? "Ошибки при обнаружении: "
                                : "Ошибки: "}
                              {item.errorCells
                                .map(
                                  (cell) =>
                                    `${cell.sheet}!${cell.cell} (#${cell.error})`,
                                )
                                .join(" · ")}
                            </span>
                          ) : (
                            <span>Ошибки формул не подтверждены.</span>
                          )}
                          {!!item.affectedCells?.length && (
                            <span className="doctor-problem-cell-list">
                              Затронутые ячейки:{" "}
                              {item.affectedCells
                                .map((cell) => `${cell.sheet}!${cell.cell}`)
                                .join(" · ")}
                            </span>
                          )}
                        </dd>
                      </div>
                    ) : null}
                    {item.previousFormula && (
                      <div>
                        <dt>Эталонная формула</dt>
                        <dd>
                          <code>{item.previousFormula}</code>
                        </dd>
                      </div>
                    )}
                    {item.recoveryCandidate ? (
                      <div>
                        <dt>Значение из истории</dt>
                        <dd>
                          {item.sheet}!{item.cell} ={" "}
                          {sourceValue(item.recoveryCandidate.value)} ·{" "}
                          {timeLabel(item.recoveryCandidate.observedAt)}
                        </dd>
                      </div>
                    ) : item.type === "data_quality_root_cause" &&
                      sourceStateOf(item) === "missing" ? (
                      <div>
                        <dt>Нужно проверить</dt>
                        <dd>
                          Уточните точный вид товара для артикула{" "}
                          {productKeyOf(item) || "из этой строки"} в ячейке{" "}
                          {item.sheet}!{item.cell}. Подтверждённого значения для
                          восстановления нет.
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  {!!item.dependencyPaths?.length && (
                    <ul className="doctor-problem-paths">
                      {item.dependencyPaths.map((path, index) => (
                        <li key={`${path.outputCell}-${index}`}>
                          {path.outputCell}: {path.cells.join(" → ")}
                        </li>
                      ))}
                    </ul>
                  )}
                  {item.type === "data_quality_root_cause" &&
                    item.monitorStatus === "open" &&
                    item.recoveryCandidate && (
                      <SourceRecoveryApproval
                        key={item.id}
                        incident={item}
                        busy={busy}
                        available={state.productionRepairEnabled || false}
                        onWrite={(incidentId, candidateVersion) =>
                          void act(
                            "/api/intelligence/formula-repair/source-recovery",
                            {
                              incidentId,
                              explicitWriteApproval: true,
                              ...(candidateVersion ? { candidateVersion } : {}),
                            },
                          )
                        }
                      />
                    )}
                  {item.monitorStatus === "open" && (
                      <Button onClick={() => setSelected(item)}>
                        Открыть полную карточку
                      </Button>
                    )}
                </details>
              </article>
            ))}
          </div>
        ) : incidents.loading ? (
          <Busy label="Обновляю список проблем…" />
        ) : (
          <Empty title="Проблем по выбранным условиям нет">
            Измените фильтры или проверьте, не закрыта ли проблема после
            успешного чтения.
          </Empty>
        )}
        {incidents.value && (
          <div
            className="doctor-dispatcher-pagination"
            aria-label="Страницы проблем"
          >
            <span>
              {incidents.value.total
                ? `${incidents.value.page * size + 1}–${Math.min((incidents.value.page + 1) * size, incidents.value.total)} из ${incidents.value.total}`
                : "0 проблем"}
            </span>
            <Field label="На странице">
              <select
                value={size}
                onChange={(event) => {
                  setSize(Number(event.target.value));
                  setPage(0);
                }}
              >
                {[10, 20, 50].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              disabled={incidents.value.page <= 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              Назад
            </Button>
            <Button
              disabled={
                (incidents.value.page + 1) * size >= incidents.value.total
              }
              onClick={() => setPage((current) => current + 1)}
            >
              Дальше
            </Button>
          </div>
        )}
      </section>
      {!state.formulaIntelligence ? (
        <Notice tone="warning">
          Контроль подмены формул: текущий агент не сообщает состояние Formula
          Intelligence. Обновление файлов не перезапускает фоновый процесс.
          Требуется загрузить обновлённый агент; количество прочитанных формул
          само по себе не подтверждает защиту эталонами.
        </Notice>
      ) : !state.formulaIntelligence.metrics.length ? (
        <Notice tone="warning">
          Контроль подмены формул: первый успешный снимок ещё не получен.
          Запустите проверку таблиц, затем просмотрите и утвердите эталоны в
          разделе Formula Intelligence ниже.
        </Notice>
      ) : state.formulaIntelligence.metrics.every(
          (m) => m.protectedCells === 0,
        ) ? (
        <Notice tone="warning">
          Контроль подмены формул: в последнем цикле защищено эталонами 0 ячеек.
          Если вы уже утвердили области, запустите новую проверку — показатели
          обновляются после её завершения. Иначе просмотрите и утвердите
          правильные формульные области в разделе Formula Intelligence ниже.
          Если формула уже заменена числом до первого снимка, этот снимок не
          доказывает её исходное содержание.
        </Notice>
      ) : (
        <Notice>
          Точные эталоны защищают утверждённые адреса. Изменения остальных формул отслеживаются по сохранённым версиям и требуют проверки владельцем.
          Защищённых адресов в последних снимках:{" "}
          {state.formulaIntelligence.metrics.reduce(
            (n, m) => n + m.protectedCells,
            0,
          )}
          . Проверьте защиту нужной области в разделе Formula Intelligence ниже;
          время и актуальность снимков указаны по каждому листу.
        </Notice>
      )}
      <details
        className="ai-advanced"
        open={advanced}
        onToggle={(e) => setAdvanced(e.currentTarget.open)}
      >
        <summary>Настроить защиту формул</summary>
        {advanced && (
          <>
            {state.formulaIntelligence && (
              <FormulaIntelligence
                state={state.formulaIntelligence}
                reload={resource.reload}
              />
            )}
            <details className="ai-advanced">
              <summary>Предварительные правила и расширенный аудит</summary>
              <Notice
                tone={state.connection === "verified" ? "neutral" : "warning"}
              >
                Google Sheets API:{" "}
                {statusLabel[state.connection] || state.connection}.
                {state.connection !== "verified" &&
                  " Успешное чтение от сервисного аккаунта не подтверждено. Путь к ключу не доказывает подключение."}
              </Notice>
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
                    <span>Реальных формул прочитано</span>
                    <strong
                      className={
                        state.formulasRead === null ? "doctor-time" : undefined
                      }
                    >
                      {state.formulasRead ?? "Нет проверки"}
                    </strong>
                    <small>
                      По прежним правилам (включая предварительные):{" "}
                      {state.checkedFormulas ?? "нет проверки"}
                    </small>
                    {state.demoEnabled && (
                      <small>Демонстрация: {state.demoCheckedFormulas}</small>
                    )}
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
                              : statusLabel[
                                  r.check?.status || "not_configured"
                                ] || r.check?.status}
                          </Badge>
                          <small className="ai-block">
                            {r.check?.stale
                              ? "Предыдущая проверка устарела. "
                              : ""}
                            {r.check?.message || "Проверка ещё не выполнялась"}
                            {r.check?.httpStatus
                              ? " · HTTP " + r.check.httpStatus
                              : ""}
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
                            ? r.pendingRules +
                              " формульных правил ждут утверждения"
                            : "Формульные шаблоны не заданы"}
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
                      label: "Чтение API и время",
                      render: (r) => (
                        <>
                          {timeLabel(r.check?.readVerifiedAt)}
                          {r.check?.durationMs !== undefined && (
                            <small className="ai-block">
                              {(r.check.durationMs / 1000).toFixed(2)} с ·
                              запросов Sheets:{" "}
                              {r.check.api?.readRequests ?? "—"} · повторов:{" "}
                              {r.check.api?.retries ?? "—"}
                            </small>
                          )}
                          {r.check?.formulasRead !== undefined &&
                            r.check.formulasRead !== null && (
                              <small className="ai-block">
                                Прочитано формул: {r.check.formulasRead}, ячеек:{" "}
                                {r.check.returnedCells}
                              </small>
                            )}
                        </>
                      ),
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
                  «Читатель». Формульные шаблоны FBO и поставок пока ждут
                  утверждения владельца. Они не используются для автоматического
                  исправления.
                </Notice>
              </section>
              {state.review && (
                <DiagnosticReview
                  state={state.review}
                  source={source}
                  sheet={sheet}
                  onChange={() => {
                    void resource.reload();
                    void incidents.reload();
                  }}
                />
              )}
              <MonitoringSheets
                documents={state.documents}
                source={source}
                sheet={sheet}
              />
              <KpiImpactPanel report={state.kpiImpact} />
              <FormulaPreview
                rows={state.documents.flatMap((d) =>
                  (d.formulaRules || []).map((r) => ({
                    key: d.id + r.gid + r.id,
                    document: d.name,
                    sheet: r.sheet,
                    range: r.range,
                    applicable: r.applicable,
                    preview: r.preview,
                  })),
                )}
              />
              {state.manualAudit?.channel === "google_drive_connector" && (
                <details>
                  <summary>
                    Исторический ручной аудит · не текущая область мониторинга
                  </summary>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h3>Реальные источники · разовый аудит Google Drive</h3>
                        <p className="panel-note">
                          {timeLabel(state.manualAudit.at)} · отдельный
                          сохранённый отчёт
                        </p>
                      </div>
                      <Badge>Ручное чтение</Badge>
                    </div>
                    <Notice>
                      Прочитано{" "}
                      {state.manualAudit.formulasRead.toLocaleString("ru-RU")}{" "}
                      формул в {state.manualAudit.sheets.length} листах и
                      диапазонах. Это разовый аудит через подключённый Google
                      Drive. Он не подтверждает авторизацию или работу фонового
                      агента от сервисного аккаунта. Формульные шаблоны ещё ждут
                      утверждения.
                    </Notice>
                    <DataTable
                      label="Диапазоны ручного аудита"
                      rows={state.manualAudit.sheets}
                      rowKey={(r) => String(r.gid)}
                      columns={[
                        { id: "sheet", label: "Лист", render: (r) => r.name },
                        {
                          id: "formulas",
                          label: "Формул прочитано",
                          render: (r) => r.formulasRead,
                        },
                        {
                          id: "errors",
                          label: "Ошибки вычисления",
                          render: (r) => r.errors.length,
                        },
                        {
                          id: "candidates",
                          label: "Совпадение кандидата площади J",
                          render: (r) =>
                            r.plannedCandidates
                              ? r.plannedMatches + " / " + r.plannedCandidates
                              : "Не применимо",
                        },
                      ]}
                    />
                  </section>
                </details>
              )}
              <section className="panel">
                <div className="panel-heading">
                  <h2>Контекстная диагностика</h2>
                  <small>Наблюдения последней проверки</small>
                </div>
                <div className="ai-metrics doctor-metrics">
                  {Object.entries(categories).map(([category, label]) => (
                    <div key={category}>
                      <span>{label}</span>
                      <strong>
                        {state.documents.some((d) => d.check?.classifications)
                          ? state.documents.reduce(
                              (sum, d) =>
                                sum +
                                (d.check?.classifications?.[category] || 0),
                              0,
                            )
                          : "Нет проверки"}
                      </strong>
                    </div>
                  ))}
                </div>
                <p className="panel-note">
                  Ожидаемые #N/A в пустых строках:{" "}
                  {state.documents.reduce(
                    (sum, d) => sum + (d.check?.expectedNA || 0),
                    0,
                  )}
                  . Исключения зависят от столбца, формулы и заполненности
                  строки. Нормальное наблюдение не утверждает шаблон формулы.
                  Отсутствие записи не означает нулевой KPI.
                </p>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <h2>Формульные правила на утверждение</h2>
                  <small>Никакие шаблоны не утверждаются автоматически</small>
                </div>
                {state.documents.flatMap((document) =>
                  (document.formulaRules || [])
                    .filter((rule) => rule.approval === "pending")
                    .map((rule) => (
                      <details key={document.id + rule.gid + rule.id}>
                        <summary>
                          {document.name} · {rule.sheet} · {rule.range} —{" "}
                          {rule.applicable} строк; совпадений кандидата{" "}
                          {rule.candidateMatches}
                        </summary>
                        <p className="panel-note">
                          Условие: {text(rule.when)}. Шаблон:{" "}
                          {rule.templates.length
                            ? rule.templates.join(" или ")
                            : "Не задан: нужны точные ссылки IMPORTRANGE для каждой строки"}
                          . Исключения: {text(rule.exceptions)}
                        </p>
                        {rule.samples.map((sample) => (
                          <p key={sample.cell}>
                            <strong>{sample.cell}</strong>
                            <br />
                            <code style={{ overflowWrap: "anywhere" }}>
                              {sample.formula || "Формула отсутствует"}
                            </code>
                          </p>
                        ))}
                        {rule.importRows.map((row) => (
                          <details key={row.cell}>
                            <summary>Точная формула {row.cell}</summary>
                            <p>
                              <code style={{ overflowWrap: "anywhere" }}>
                                {row.formula}
                              </code>
                            </p>
                          </details>
                        ))}
                        {rule.importRows.length > 0 && (
                          <p className="panel-note">
                            Сопоставление исходных диапазонов (не переносить
                            номер строки автоматически):{" "}
                            {rule.importRows
                              .map(
                                (row) =>
                                  row.cell +
                                  " → " +
                                  [
                                    ...new Set(
                                      row.references.map((ref) => ref.range),
                                    ),
                                  ].join(", ") +
                                  " · " +
                                  row.references.length +
                                  " документов",
                              )
                              .join("; ")}
                          </p>
                        )}
                        <p className="panel-note">
                          Производственная запись заблокирована. Утверждение
                          должно отдельно определить диапазон, точные формулы и
                          исключения.
                        </p>
                      </details>
                    )),
                )}
              </section>
              {state.demoEnabled && (
                <section className="panel doctor-demo">
                  <div className="panel-heading">
                    <div>
                      <h3>ДЕМОНСТРАЦИЯ · контролируемая ошибка</h3>
                      <p className="panel-note">
                        Искусственная таблица «Коэффициенты · DEMO», ячейка
                        G247. Тестовые значения и нормы не относятся к
                        производству.
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
            </details>
          </>
        )}
      </details>
      <details className="ai-advanced doctor-incident-table">
        <summary>Табличный список и расширенные статусы</summary>
        <section className="panel">
          <div className="panel-heading">
            <h2>Требует внимания</h2>
            <small>Нажмите на проблему, чтобы открыть доказательства</small>
          </div>
          <div
            className="segments ai-views"
            role="group"
            aria-label="Состояние проблем"
          >
            {[
              ["active", "Все активные"],
              ["confirmed", "Подтверждённые ошибки"],
              ["review", "Требуют проверки"],
            ].map(([id, label]) => (
              <button
                key={id}
                className={status === id ? "selected" : ""}
                aria-pressed={status === id}
                onClick={() => {
                  setStatus(id);
                  setPage(0);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <details className="ai-advanced">
            <summary>Фильтры по документам, листам и типам проблем</summary>
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
                    setSheet("");
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
              <Field label="Лист">
                <select
                  value={sheet}
                  onChange={(e) => {
                    setSheet(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">Все листы</option>
                  {[
                    ...new Set([
                      ...state.documents
                        .filter((d) => !source || d.id === source)
                        .flatMap((d) => d.sheets.map((s) => s.name)),
                      ...(status === "out_of_scope"
                        ? incidents.value?.rows
                            .map((r) => r.sheet)
                            .filter((s): s is string => !!s) || []
                        : []),
                    ]),
                  ].map((s) => (
                    <option key={s}>{s}</option>
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
                  {[
                    "active",
                    "new",
                    "review",
                    "confirmed",
                    "fixed",
                    "ignored",
                    "out_of_scope",
                  ].map((id) => (
                    <option key={id} value={id}>
                      {statusLabel[id]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </details>
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
                      {r.category && (
                        <small className="ai-block">
                          {categories[r.category] || r.category}
                        </small>
                      )}
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
      </details>
      <Modal
        open={!!selected}
        onClose={() => {
          setSelected(null);
          setMessage("");
          setError("");
        }}
        title="Проблема и предлагаемое действие"
        description={
          incident?.type === "data_quality_root_cause"
            ? "Проблема исходных данных. Формулы AP и цепочка поиска не переписываются. Любое восстановление требует отдельного подтверждения точного значения и адреса."
            : state.testRepairEnabled
              ? "Тестовый документ: точечное исправление требует отдельного подтверждения владельца."
              : state.productionRepairEnabled
                ? incident?.type === "unavailable" || incident?.type === "sheets_api_unavailable" ? "Проверка доступа к источнику. Это сообщение о доступности, а не о повреждении ячейки." : incident?.type === "calculation_error" ? "Формула сохранена. Проверяем источник ошибки; переписывать эту формулу не нужно." : "Восстановление требует вашего разрешения точного изменения."
                : "Доказательства, предполагаемая причина и заявка владельца. Google Sheets не изменяется."
        }
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
            <h3>{problemTitle(incident)}</h3>
            <Badge tone={tone(incident.status)}>
              {statusLabel[incident.status]}
            </Badge>
            {incident.type === "data_quality_root_cause" && (
              <>
                <div className="doctor-data-quality-summary">
                  <strong>{incident.monitorStatus === "resolved" ? "Восстановленные коэффициенты: " : "Ошибка расчёта: "}{(incident.errorCells || []).filter((cell) => cell.cell.startsWith("AP")).map((cell) => cell.cell).join(", ")}</strong>
                  <details><summary>Все зависимости и затронутые ячейки</summary><p>{(incident.affectedCells || []).map((cell) => `${cell.sheet}!${cell.cell}`).join(" · ")}</p></details>
                </div>
              </>
            )}
            {incident.type === "data_quality_root_cause" && ((incident.monitorStatus === "open" && incident.recoveryCandidate) || incident.sourceRecoveryOperation) && (
              <SourceRecoveryApproval key={incident.id} incident={incident} busy={busy}
                available={state.productionRepairEnabled || false}
                onWrite={(incidentId, candidateVersion) => void act("/api/intelligence/formula-repair/source-recovery", { incidentId, explicitWriteApproval: true, ...(candidateVersion ? { candidateVersion } : {}) })} />
            )}
            {incident.type === "data_quality_root_cause" && incident.monitorStatus === "open" && sourceStateOf(incident) === "missing" && !incident.recoveryCandidate && !incident.sourceRecoveryOperation && state.productionRepairEnabled && (
              <SourceValueProposal key={incident.id} incident={incident} busy={busy} onPropose={(value) => void act("/api/intelligence/formula-repair/source-candidate", { incidentId: incident.id, value })} />
            )}
            {state.productionRepairEnabled && incident.monitorStatus === "open" && canRestoreFormula(incident) && (
              <TestRepairPanel key={incident.id} incidentId={incident.id} production />
            )}
            <dl className="ai-details">
              {[
                [
                  "Где",
                  [incident.sourceName, incident.sheet, incident.cell]
                    .filter(Boolean)
                    .join(" · "),
                ],
                [currentSourceLabel, currentSourceValue],
                ["Ожидается", text(typeof incident.expected === "object" && incident.expected ? (incident.expected as { candidateFormula?: string; formula?: string }).candidateFormula || (incident.expected as { formula?: string }).formula || incident.expected : incident.expected)],
                ["Влияние на KPI", kpiEvidenceLabel(incident)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <details className="ai-advanced">
              <summary>Доказательства, контекст и история проблемы</summary>
              <KpiImpactPanel report={state.kpiImpact} incident={incident} />
              <dl className="ai-details">
                {[
                  ["ID", incident.id],
                  [
                    "Диагностика",
                    categories[incident.category || ""] ||
                      "Предыдущая версия проверки",
                  ],
                  [
                    "Контекст строки",
                    incident.rowContext
                      ? (incident.rowContext.state === "empty"
                          ? "Пустая"
                          : "Заполненная") +
                          " · " +
                          Object.entries(incident.rowContext.cells)
                            .filter(
                              ([, cell]) =>
                                cell.error ||
                                (cell.value !== null &&
                                  String(cell.value).trim() !== ""),
                            )
                            .map(
                              ([column, cell]) =>
                                column +
                                ": " +
                                (cell.error
                                  ? "#" + cell.error
                                  : String(cell.value)),
                            )
                            .join("; ") || "Ячейки контекста пусты"
                      : "Не задан для этого диапазона",
                  ],
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
                    "Предыдущее значение источника",
                    incident.recoveryCandidate
                      ? `${incident.sheet}!${incident.cell} = ${sourceValue(incident.recoveryCandidate.value)} · ${timeLabel(incident.recoveryCandidate.observedAt)}`
                      : incident.type === "data_quality_root_cause"
                        ? "Не найдено · Требует проверки"
                        : "Не проверялось",
                  ],
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
                    incident.resolvedAt
                      ? timeLabel(incident.resolvedAt)
                      : "Нет",
                  ],
                  ["Наблюдений", String(incident.occurrences)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </details>
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
                  {incident.type !== "data_quality_root_cause" && realDocuments.some((document) => document.id === incident.sourceId) && (
                      <Button
                        kind="primary"
                        disabled={busy || state.running || !!state.fastRunning}
                        onClick={() =>
                          void act(
                            "/api/intelligence/incidents/" + incident.id + "/recheck",
                          )
                        }
                      >
                        Проверить источник
                      </Button>
                    )}
                  {incident.type !== "data_quality_root_cause" && (
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
                  )}
                </>
              )}
            </div>
            {state.testRepairEnabled && (
              <TestRepairPanel key={incident.id} incidentId={incident.id} />
            )}
            {incident.formulaRegionId && incident.monitorStatus === "open" && (
              <details className="ai-advanced">
                <summary>Настроить допустимое исключение</summary>
                <FormulaExceptionAction
                  key={incident.id}
                  incidentId={incident.id}
                />
              </details>
            )}
            {!state.testRepairEnabled && !state.productionRepairEnabled && (
              <p className="panel-note">
                Заявка хранится в журнале агента. Выполнение исправлений
                появится на следующем этапе. «Исправлена» означает, что успешная
                повторная проверка больше не обнаружила проблему.
              </p>
            )}
          </>
        )}
      </Modal>
      <Modal
        open={!!bulkConfirm}
        onClose={() => !busy && setBulkConfirm(null)}
        title={bulkConfirm === "restore" ? "Массовое восстановление" : "Игнорировать выбранные проблемы"}
        description={
          bulkConfirm === "restore"
            ? "Одно подтверждение разрешит RITM по очереди восстановить только перечисленные ячейки и значения. Каждая запись будет перепроверена и отдельно прочитана обратно; при первой ошибке очередь остановится."
            : "Выбранные проблемы будут скрыты из активного списка с записью решения владельца. Данные Google Sheets не изменятся."
        }
      >
        <ol className="doctor-bulk-confirm-list">
          {selectedIncidents.map((item) => (
            <li key={item.id}>
              <strong>{problemTitle(item)}</strong>
              <span>
                {item.sourceName} · {item.sheet}!{item.cell || "—"}
                {bulkConfirm === "restore" && item.recoveryCandidate
                  ? ` = ${sourceValue(item.recoveryCandidate.value)}`
                  : ""}
              </span>
            </li>
          ))}
        </ol>
        {bulkProgress && <Notice>{bulkProgress}</Notice>}
        <div className="doctor-bulk-confirm-actions">
          <Button disabled={busy} onClick={() => setBulkConfirm(null)}>
            Отмена
          </Button>
          {bulkConfirm === "restore" ? (
            <Button
              kind="primary"
              disabled={busy || !bulkRestoreEligible || !state.productionRepairEnabled}
              onClick={() => void bulkRestore()}
            >
              {busy ? "Восстанавливаю…" : `Разрешить восстановление ${selectedIncidents.length}`}
            </Button>
          ) : (
            <Button
              kind="primary"
              disabled={busy || !bulkIgnoreEligible}
              onClick={() => {
                setBulkConfirm(null);
                void bulkAction("ignore");
              }}
            >
              {busy ? "Сохраняю…" : `Игнорировать ${selectedIncidents.length}`}
            </Button>
          )}
        </div>
      </Modal>
    </div>
  );
}
