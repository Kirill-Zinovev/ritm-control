import { Badge, DataTable, Notice } from "./ui";
import { timeLabel, type Incident } from "./intelligence";
export type RulePreview = {
  status: string;
  rowsChecked: number | null;
  wouldFlag: number | null;
  unusedExceptions?: number;
  issues: { cell: string; type: string }[];
};
export type KpiImpact = {
  at: string;
  sheetsRead: number;
  formulasRead: number;
  requests: number;
  durationMs: number;
  history: { rows: number; coefficientErrors: number; latestDay: string };
  crossCheck: { compared: number; matches: number; differences: unknown[] };
  targets: {
    sourceId: string;
    sheet: string;
    cell: string;
    formula: string;
    directConsumers: { sheet: string; cell: string }[];
    reachesHistory: boolean;
    reachesDailyDashboard: boolean;
    productionDate?: string;
  }[];
  limits: string[];
};
export function FormulaPreview({
  rows,
}: {
  rows: {
    key: string;
    document: string;
    sheet: string;
    range: string;
    applicable: number;
    preview?: RulePreview;
  }[];
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Предварительный просмотр {rows.length} формульных правил</h2>
        <Badge>Без утверждения и записи</Badge>
      </div>
      <p className="panel-note">
        Проверка кандидатов тем же детектором на последнем снимке Google API.
        «Строк по условию» учитывает заполненность; «Проверяемых» исключает
        разрешённые ручные строки. Если эталон не задан, результат не
        объявляется успешным. Время снимка указано выше у документа.
      </p>
      <DataTable
        label="Предварительный просмотр правил"
        pageSize={20}
        rows={rows}
        rowKey={(r) => r.key}
        columns={[
          {
            id: "sheet",
            label: "Документ / лист",
            render: (r) => (
              <>
                {r.document}
                <small className="ai-block">{r.sheet}</small>
              </>
            ),
          },
          { id: "range", label: "Диапазон", render: (r) => r.range },
          {
            id: "active",
            label: "Строк по условию",
            render: (r) => r.applicable,
          },
          {
            id: "checked",
            label: "Проверяемых строк",
            render: (r) => r.preview?.rowsChecked ?? "Не проверяется",
          },
          {
            id: "result",
            label: "Результат кандидата",
            render: (r) =>
              r.preview?.status === "preview" ? (
                <>
                  {r.preview.wouldFlag} отклонений
                  {r.preview.unusedExceptions ? (
                    <small className="ai-block">
                      {r.preview.unusedExceptions} исключение не встречалось:
                      отдельно согласовать
                    </small>
                  ) : null}
                </>
              ) : r.preview?.status === "blocked_template" ? (
                "Нужны точные эталоны IMPORTRANGE"
              ) : (
                "Нет подтверждённого снимка структуры"
              ),
          },
        ]}
      />
      <Notice>
        Шаблоны остаются кандидатами. Перед утверждением согласуйте точные
        ссылки, назначение столбцов и ручные исключения. Плановая площадь не
        заменяет фактический выпуск журнала.
      </Notice>
    </section>
  );
}
export function KpiImpactPanel({
  report,
  incident,
}: {
  report: KpiImpact | null | undefined;
  incident?: Incident;
}) {
  if (!report) return null;
  const target = incident
    ? report.targets.find(
        (t) =>
          t.sourceId === incident.sourceId &&
          t.sheet === incident.sheet &&
          t.cell === incident.cell,
      )
    : null;
  if (incident && !target) return null;
  const observed = incident?.observed as { formula?: string } | undefined;
  const same = !incident || observed?.formula === target?.formula;
  const old = Date.now() - Date.parse(report.at) > 86400000;
  return (
    <section className={incident ? "ai-impact-card" : "panel"}>
      <div className="panel-heading">
        <h3>
          {incident
            ? "Проверенное влияние на KPI"
            : "Влияние 12 инцидентов на действующие KPI"}
        </h3>
        <Badge>{same && !old ? "Отдельный аудит" : "Предыдущий аудит"}</Badge>
      </div>
      <p className="panel-note">
        {timeLabel(report.at)} · {report.sheetsRead} листа ·{" "}
        {report.formulasRead} формул · {report.requests} запросов Sheets ·{" "}
        {(report.durationMs / 1000).toFixed(2)} с. Этот аудит связей не
        обновляется каждые 10 минут автоматически.
      </p>
      {!same && (
        <Notice tone="warning">
          Формула изменилась после аудита. Вывод о влиянии требует повторной
          проверки.
        </Notice>
      )}
      {old && (
        <Notice tone="warning">
          Аудиту больше суток: вывод отражает сохранённый снимок.
        </Notice>
      )}
      <p>
        RITM читает готовые коэффициенты из «История производства!H». Проверено{" "}
        {report.history.rows} строк истории: ошибок в H —{" "}
        {report.history.coefficientErrors}. Совпало {report.crossCheck.matches}{" "}
        из {report.crossCheck.compared} сопоставимых значений с «По дням ·
        Дашборд»; различий — {report.crossCheck.differences.length}.
        Отсутствующие дни не считались нулём.
      </p>
      {target ? (
        <p>
          {target.cell === "C16"
            ? "C16 относится к блоку «Осталось в этом месяце». Прямых формульных потребителей этой ячейки в прочитанных диапазонах не найдено."
            : `E1 используется в ${target.directConsumers.length} формулах C3:C16 личного листа. E2 содержит ${target.productionDate || "старую дату"}: ветки «сегодня» не активны; IFERROR может скрывать сбой пустым результатом. Это не доказывает повреждение всех зависимых значений.`}{" "}
          Формульная связь с историей или дневным дашбордом{" "}
          {target.reachesHistory || target.reachesDailyDashboard
            ? "обнаружена: требуется анализ."
            : "не обнаружена."}
        </p>
      ) : (
        <p>
          C16 — месячный остаток на 10 личных листах. E1 — повреждённая ссылка
          на листах «Настя» и «Кристина», с потенциальным влиянием на личные
          расчёты C3:C16. Прямое искажение действующих KPI RITM этими ячейками
          не подтверждено.
        </p>
      )}
      <Notice tone="warning">
        Скрипт Apps Script, записывающий историю, недоступен для проверки.
        Косвенное влияние через него не исключено. Внешние документы IMPORTRANGE
        и именованные зависимости не проверены полностью.
      </Notice>
      {incident && (
        <p className="panel-note">
          Предложение: найти исходную ссылку в истории версий и подтвердить
          точный эталон. Не заменять #REF! нулём и не восстанавливать формулу по
          соседям.
        </p>
      )}
    </section>
  );
}
