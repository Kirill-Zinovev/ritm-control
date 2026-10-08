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
    writesEnabled: false;
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
export function timeLabel(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Нет проверки";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}
export const statusLabel: Record<string, string> = {
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
