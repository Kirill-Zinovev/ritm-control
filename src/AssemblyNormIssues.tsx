import { ArrowUpRight, CircleAlert } from "lucide-react";
import { ASSEMBLY_URL, type AssemblyEvent } from "./liveAssembly";

export function missingAssemblyCoefficient(event: AssemblyEvent) {
  return event.quantity > 0 && event.coefficient === null;
}

export function assemblyNormReason(event: AssemblyEvent) {
  switch (event.normIssue?.reason) {
    case "catalog": return "Проверьте артикул и магазин в справочнике";
    case "kind": return "Заполните вид товара в карточке";
    case "sheets": return "Укажите число листов на изделие";
    case "ready": return "Норма найдена в справочнике";
    case "norm": return "Укажите норму за смену для этой операции";
    default: return event.norm === null
      ? "Норма операции не сохранена"
      : "Норма сохранена. КЭФ записи требует проверки";
  }
}

function catalogLink(events: AssemblyEvent[]) {
  const first = events[0];
  const issue = first.normIssue;
  const params = new URLSearchParams({ view: "catalog", catalog_q: first.article });
  if (issue) {
    params.set("catalog_market", issue.market);
    if (issue.store) params.set("catalog_store", issue.store);
    if (issue.hasCard) params.set("catalog_open", "1");
    if (issue.reason === "kind") params.set("catalog_focus", "kind");
    params.set("catalog_norm_work", events.slice(0, 50).map(event => event.eventId).join(","));
  }
  return `${ASSEMBLY_URL}/?${params}`;
}

export function AssemblyNormIssues({ events, onOpenCatalog }: {
  events: AssemblyEvent[];
  onOpenCatalog: () => void;
}) {
  const groups = new Map<string, AssemblyEvent[]>();
  const unique = new Map(events.map(event => [event.eventId, event]));
  for (const event of unique.values()) {
    const { article, operationId, normIssue } = event;
    const key = JSON.stringify([article, operationId, normIssue?.market, normIssue?.store, normIssue?.reason]);
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }
  if (!groups.size) return null;
  const entries = [...groups];
  const renderRows = (items: typeof entries) => items.map(([key, rows]) => {
    const event = rows[0];
    const workers = [...new Set(rows.map(row => row.employee))];
    const action = event.normIssue?.reason === "ready" ? "Подтянуть КЭФ" : "Открыть справочник";
    const scope = [event.normIssue?.market, event.normIssue?.store && `магазин ${event.normIssue.store}`].filter(Boolean).join(" · ");
    return (
      <div className="assembly-norm-issue" key={key}>
        <div className="assembly-norm-issue-item">
          <strong>{event.article}</strong>
          {scope && <small>{scope}</small>}
        </div>
        <div className="assembly-norm-issue-reason">
          <strong>{assemblyNormReason(event)}</strong>
          <small>{event.operation} · {workers.join(", ")}</small>
        </div>
        <a className="button secondary assembly-norm-issue-link" href={catalogLink(rows)}
          target="_blank" rel="noopener" onClick={onOpenCatalog}
          aria-label={`${action} · ${event.article} · ${event.operation}`}>
          {action}
          <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </div>
    );
  });
  return (
    <section className="assembly-norm-issues" id="assembly-norm-issues" aria-labelledby="assembly-norm-issues-heading">
      <header>
        <span className="assembly-norm-issues-icon"><CircleAlert size={20} aria-hidden="true" /></span>
        <div>
          <h2 id="assembly-norm-issues-heading">Почему КЭФ пустой</h2>
          <p>Откройте карточку и подтвердите норму для указанных операций.</p>
        </div>
        <span className="assembly-norm-issues-count">{unique.size} без КЭФ</span>
      </header>
      {renderRows(entries.slice(0, 3))}
      {entries.length > 3 && (
        <details className="assembly-norm-issues-more">
          <summary>Ещё {entries.length - 3}</summary>
          {renderRows(entries.slice(3))}
        </details>
      )}
    </section>
  );
}
