import { Badge, DataTable, Notice } from "./ui";
import { timeLabel, statusLabel } from "./intelligence";
const checkLabel: Record<string, string> = {
  "coefficient-B": "Коэффициент B (эталон не утверждён)",
  "coefficient-C": "Коэффициент C (эталон не утверждён)",
  "coefficient-D": "Коэффициент D (эталон не утверждён)",
  "total-coefficient": "Итоговый коэффициент E",
  "planned-area": "Плановая площадь J",
  pieces: "Количество: целое положительное",
  "order-uid": "Обязательный UID",
  "entry-id": "Уникальный ID записи",
  "production-day": "Производственная дата",
  "actual-area": "Валидная фактическая площадь",
};
export type BusinessDraft = {
  at: string;
  checks: {
    id: string;
    title: string;
    sheet: string;
    gid: number;
    approval: string;
    status: string;
    rowsChecked: number;
    observations: number;
    samples: {
      cell: string;
      gid?: number;
      sheet?: string;
      observed: unknown;
      expected: unknown;
      reason: string;
    }[];
    metrics: Record<string, unknown>;
    limitations: string;
  }[];
};
export type ScopeSheet = {
  name: string;
  gid: number;
  purpose?: string;
  lastCheck?: string | null;
  status?: string;
  formulasRead?: number | null;
  displayedErrors?: number | null;
  issueCount?: number | null;
  activeChecks?: string[];
  pendingChecks?: string[];
};
export function MonitoringSheets({
  documents,
  source,
  sheet,
}: {
  documents: {
    id: string;
    name: string;
    demonstration?: boolean;
    sourceUrl: string | null;
    sheets: ScopeSheet[];
    businessPreview?: BusinessDraft | null;
  }[];
  source: string;
  sheet: string;
}) {
  const productionDocuments = documents.filter((d) => !d.demonstration),
    monitoredSheetCount = productionDocuments.reduce(
      (count, document) => count + document.sheets.length,
      0,
    );
  const rows = documents
    .filter((d) => !source || source === d.id)
    .flatMap((d) =>
      d.sheets
        .filter((s) => !sheet || sheet === s.name)
        .map((s) => ({
          ...s,
          key: d.id + ":" + s.gid,
          document: d.name,
          url: d.sourceUrl ? d.sourceUrl + "#gid=" + s.gid : null,
          draft: d.businessPreview,
        })),
    );
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Производственные листы под контролем</h2>
        <Badge>
          {productionDocuments.length} документа · {monitoredSheetCount} листов
        </Badge>
      </div>
      <p className="panel-note">
        Инциденты создаются только в зарегистрированных вкладках. Зависимые вкладки
        продолжают участвовать в расчётах KPI. Исключённые проблемы сохраняются
        со статусом «Вне области мониторинга».
      </p>
      <DataTable
        label="Листы мониторинга"
        pageSize={20}
        rows={rows}
        rowKey={(r) => r.key}
        columns={[
          {
            id: "name",
            label: "Документ / лист",
            render: (r) => (
              <>
                <strong>{r.document}</strong>
                <small className="ai-block">{r.name}</small>
                {r.url && (
                  <a
                    className="text-link"
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Google Sheets
                  </a>
                )}
              </>
            ),
          },
          {
            id: "at",
            label: "Последняя проверка",
            render: (r) => (
              <>
                {timeLabel(r.lastCheck)}
                <small className="ai-block">
                  {statusLabel[r.status || "not_configured"] || r.status} ·
                  формул: {r.formulasRead ?? "—"}
                </small>
              </>
            ),
          },
          {
            id: "issues",
            label: "Активных проблем",
            render: (r) => (
              <>
                {r.issueCount ?? "Нет актуальной проверки"}
                {r.displayedErrors ? (
                  <small className="ai-block">
                    Отображаемых ошибок: {r.displayedErrors}. Требуется
                    контекст, это не число сломанных формул.
                  </small>
                ) : null}
              </>
            ),
          },
          {
            id: "rules",
            label: "Правила",
            render: (r) => (
              <>
                Структура + {(r.activeChecks || []).length} утверждённых
                проверок
                <small className="ai-block">
                  Ожидают утверждения: {(r.pendingChecks || []).length}
                </small>
              </>
            ),
          },
        ]}
      />
      {rows.map((r) => (
        <details key={r.key}>
          <summary>{r.name} — назначение и бизнес-проверки</summary>
          <p>{r.purpose}</p>
          <p className="panel-note">
            Активные: структура
            {r.activeChecks?.length
              ? ", " +
                r.activeChecks.map((id) => checkLabel[id] || id).join(", ")
              : ""}
            . Кандидаты:{" "}
            {r.pendingChecks?.map((id) => checkLabel[id] || id).join("; ") ||
              "Нет"}
            .
          </p>
          {r.draft?.checks
            .filter((c) => c.gid === r.gid)
            .map((c) => (
              <div key={c.id}>
                <h4>
                  {c.title} <Badge>На утверждение</Badge>
                </h4>
                <p className="panel-note">
                  Снимок {timeLabel(r.draft?.at)} · строк: {c.rowsChecked} ·
                  наблюдений для анализа: {c.observations} ·{" "}
                  {c.status === "preview"
                    ? "предварительная проверка выполнена"
                    : "недостаточно контекста, вывод ограничен"}
                  . {c.limitations}
                </p>
                {c.observations > c.samples.length && (
                  <p className="panel-note">
                    Показаны первые {c.samples.length} примеров из{" "}
                    {c.observations}.
                  </p>
                )}
                {c.samples.map((s, i) => (
                  <p key={i}>
                    {r.url ? (
                      <a
                        className="text-link"
                        target="_blank"
                        rel="noreferrer"
                        href={
                          r.url.split("#")[0] +
                          "#gid=" +
                          (s.gid ?? r.gid) +
                          "&range=" +
                          encodeURIComponent(s.cell)
                        }
                      >
                        {s.sheet ? s.sheet + " · " : ""}
                        {s.cell}
                      </a>
                    ) : (
                      <strong>{s.cell}</strong>
                    )}
                    : {JSON.stringify(s.observed)}.{" "}
                    {s.expected !== null && s.expected !== undefined ? (
                      <>Расчётный кандидат: {JSON.stringify(s.expected)}. </>
                    ) : null}
                    {s.reason}
                  </p>
                ))}
                <details>
                  <summary>Измерения и ограничения</summary>
                  <pre
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {JSON.stringify(c.metrics, null, 2)}
                  </pre>
                </details>
              </div>
            ))}
        </details>
      ))}
      <Notice>
        Наблюдения новых бизнес-правил не являются подтверждёнными инцидентами.
        Нормы, календарь, допустимые ручные корректировки и пороги аномалий не
        придуманы и требуют вашего утверждения.
      </Notice>
    </section>
  );
}
