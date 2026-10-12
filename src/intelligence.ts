export type SourceDefinition = {
  id: string;
  name: string;
  documentId: string;
  department: string;
  enabled: boolean;
  purpose: string;
  formulaAccess: string;
  freshness: unknown;
  sheets: {
    name: string;
    gid: number;
    role: string;
    status?: string;
    limitation?: string;
    columns?: Record<string, string>;
  }[];
};
export type Incident = {
  id: string;
  kind?: string;
  demonstration?: boolean;
  observed?: unknown;
  recommendation?: string;
  previousFormula?: string | null;
  baselineVersion?: string;
  formulaRegionId?: string;
  category?: string;
  sourceField?: string;
  sourceFieldColumn?: string;
  sourceCell?: string;
  sourceState?: string;
  lifecycleState?: string;
  resolutionCause?: string;
  resolutionAt?: string;
  resolutionEvidence?: unknown;
  kpiImpactVerified?: boolean;
  impactEvidence?: {
    verified?: boolean;
    summary?: string;
    value?: number;
  } | null;
  recoveryStatus?: string;
  recoveryNote?: string;
  recoveryCandidate?: {
    status: string;
    value: Record<string, unknown>;
    observedAt: string;
    confirmation: string;
    evidence: string;
  } | null;
  affectedCells?: {
    gid: number;
    sheet: string;
    cell: string;
    error: string | null;
  }[];
  errorCells?: {
    gid: number;
    sheet: string;
    cell: string;
    error: string;
  }[];
  dependencyPaths?: { outputCell: string; cells: string[] }[];
  rowContext?: {
    row: number;
    state: string;
    cells: Record<
      string,
      { value: unknown; formula: string | null; error: string | null }
    >;
  } | null;
  monitorStatus?: string;
  repairRequested?: boolean;
  sourceRecoveryOperation?: {
    id: string;
    requestId: string;
    incidentId: string;
    status:
      | "repairing"
      | "checking"
      | "written_unverified"
      | "verified"
      | "already_restored"
      | "blocked"
      | "needs_review"
      | "uncertain";
    createdAt: string;
    updatedAt: string;
    owner: string;
    target: {
      documentId: string;
      sheetId: number;
      sheet: string;
      cell: string;
    };
    approvedValue: Record<string, unknown>;
    before: unknown;
    after: unknown;
    result: {
      phase?: string;
      message?: string;
      code?: string;
      resolutionCause?: string;
      writeSucceeded?: boolean;
      timing?: {
        startedAt?: string;
        totalMs?: number;
        stages?: Record<
          string,
          {
            label?: string;
            status?: string;
            durationMs?: number;
            attempts?: number;
            maxAttempts?: number;
          }
        >;
      };
    } | null;
  } | null;
  type: string;
  severity: string;
  sourceId: string;
  sourceName: string;
  department: string;
  sheet: string | null;
  row: number | null;
  cell: string | null;
  title: string;
  found: string;
  expected: string;
  cause: string;
  impact: string;
  action: string;
  sourceUrl: string;
  verification: string;
  layer: string;
  status: string;
  firstSeen: string;
  lastSeen: string;
  resolvedAt: string | null;
  occurrences: number;
};
export type Recommendation = {
  id: string;
  title: string;
  priority: string;
  problem: string;
  evidence: string;
  solution: string;
  benefit: string;
  risks: string;
  verification: string;
  status: string;
  at: string;
};
export type AgentStatus = {
  ok: true;
  schemaVersion: 1;
  fetchedAt: string;
  agent: {
    status: string;
    heartbeatAt: string;
    nextCheckAt: string | null;
  } | null;
  lastCheck: string | null;
  active: number;
  demoActive?: number;
  resolved: number;
  corrections: number;
  controlledSources: number;
  recommendations: Recommendation[];
  checks: {
    id: string;
    name: string;
    kind: string;
    status: string;
    at: string;
    durationMs?: number;
    records?: number;
    issueCount?: number;
    snapshotAt?: string;
    sourceUpdatedAt?: string;
    stale: boolean;
    freshness?: string;
    layer?: string;
  }[];
  notifications: {
    status: string;
    uncertain?: number;
    failed?: number;
    pending?: number;
  };
  config: {
    intervalSeconds: number;
    permissionLevel: number;
    writesEnabled: boolean;
    productionRepair?: string;
    testRepair?: string;
    sources: SourceDefinition[];
    apiBase: string | null;
    model: string | null;
    llm: string;
    telegram: string;
    formulaAccess: string;
    deployment: string;
    snapshotMaxAgeSeconds: number;
  };
};
export type HistoryEntry = {
  id: number;
  at: string;
  type: string;
  message: string;
  incidentId: string | null;
};
export type PageResult<T> = {
  ok: true;
  rows: T[];
  page: number;
  limit: number;
  total: number;
};
export type IncidentSummary = {
  allProblems: number;
  critical: number;
  missingSource: number;
  calculationError: number;
  needsReview: number;
  fixed: number;
};
export function timeLabel(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Нет проверки";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}
export const statusLabel: Record<string, string> = {
  active: "Активные проблемы",
  excepted: "Допустимое исключение",
  rule_paused: "Правило отозвано",
  out_of_scope: "Вне области мониторинга",
  verified: "Чтение подтверждено",
  awaiting_verification: "Ожидает проверки подключения",
  new: "Новая проблема",
  review: "Требует проверки",
  confirmed: "Подтверждена",
  fixed: "Исправлена",
  ignored: "Игнорируется",
  warning: "Предупреждение",
  unavailable: "Недоступен",
  degraded: "Проверка неполная",
  ok: "Доступен",
  partial: "Данные неполные",
  stale: "Устарели",
  error: "Ошибка",
  not_configured: "Не настроено",
  running: "Работает",
  stopped: "Остановлен",
  open: "Открыт",
  resolved: "Не обнаружен повторно",
  high: "Высокая",
  critical: "Критическая",
  medium: "Средняя",
  low: "Низкая",
  outside_window: "Вне рабочего окна",
};
