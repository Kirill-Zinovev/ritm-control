import { useId, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  CircleAlert,
  Clock3,
  ClipboardCheck,
  RefreshCw,
} from "lucide-react";
import type {
  ArkadyAttentionItem,
  ArkadyAttentionReport,
} from "./arkadyAttentionData";
import { formatPrintQuantity as quantity } from "./liveSupplyProgress";
import { Busy, Button, Notice } from "./ui";
import "./arkadyAttention.css";

export type ArkadyAttentionActions = {
  shipment?: () => void;
  diagnosis?: () => void;
  catalog?: () => void;
  task?: () => void;
};

type Props = {
  report: ArkadyAttentionReport | null;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  getActions?: (item: ArkadyAttentionItem) => ArkadyAttentionActions;
};

const stageLabel = {
  production: "Печать и порезка",
  packing: "Упаковка",
  catalog: "Справочник",
};

const statusLabel = {
  overdue: "Просрочено",
  "due-soon": "Срок близко",
  "needs-check": "Требует сверки",
};

const deadlineFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

const perPage = 6;

function AttentionItem({
  item,
  actions,
}: {
  item: ArkadyAttentionItem;
  actions?: ArkadyAttentionActions;
}) {
  const catalogAction = item.article ? actions?.catalog : undefined;
  return (
    <li className="arkady-attention__item">
      <div className="arkady-attention__item-main">
        <div className="arkady-attention__item-title">
          <h3>{item.name}</h3>
          <span className={`arkady-attention__status is-${item.status}`}>
            {statusLabel[item.status]}
          </span>
        </div>
        <p className="arkady-attention__context">
          <span>{stageLabel[item.stage]}</span>
          {item.deadline && item.deadlineMs !== null && (
            <time dateTime={item.deadline}>
              <Clock3 size={14} aria-hidden="true" />
              {deadlineFormat.format(item.deadlineMs)} МСК
            </time>
          )}
          {item.article && (
            <strong className="arkady-attention__article">
              {item.article}
            </strong>
          )}
        </p>
        <p className="arkady-attention__detail">{item.detail}</p>
        {item.confirmed !== null && item.plan !== null && (
          <p className="arkady-attention__quantity">
            Подтверждено {quantity(item.confirmed)} из {quantity(item.plan)} шт.
          </p>
        )}
        {(actions?.diagnosis || catalogAction || actions?.task) && (
          <div className="arkady-attention__actions">
            {actions?.diagnosis && (
              <Button type="button" onClick={actions.diagnosis}>
                Разобрать причину
              </Button>
            )}
            {catalogAction && (
              <Button type="button" onClick={catalogAction}>
                <BookOpen size={15} aria-hidden="true" /> Проверить справочник
              </Button>
            )}
            {actions?.task && (
              <Button type="button" onClick={actions.task}>
                Подготовить задачу
              </Button>
            )}
          </div>
        )}
      </div>
      {actions?.shipment && (
        <Button
          type="button"
          className="arkady-attention__open"
          onClick={actions.shipment}
        >
          Открыть поставку <ArrowRight size={16} aria-hidden="true" />
        </Button>
      )}
    </li>
  );
}

export function ArkadyAttention({
  report,
  loading = false,
  error = "",
  onRetry,
  getActions,
}: Props) {
  const headingId = useId();
  const [limit, setLimit] = useState(perPage);
  const ready = !loading && !error && report?.state === "ready";
  const unavailable = !loading && !ready;
  const overdue =
    report?.items.filter((item) => item.status === "overdue").length ?? 0;
  const upcoming =
    report?.items.filter((item) => item.status === "due-soon").length ?? 0;
  return (
    <section className="arkady-attention panel" aria-labelledby={headingId}>
      <header className="arkady-attention__heading">
        <span className="arkady-attention__heading-icon">
          <CircleAlert size={22} aria-hidden="true" />
        </span>
        <div>
          <h2 id={headingId}>Требует внимания</h2>
          {ready && report && (
            <>
              <p>Проверено поставок {quantity(report.checked)}</p>
              {(overdue > 0 || upcoming > 0) && (
                <p>
                  {overdue > 0 && `Просрочено этапов ${quantity(overdue)}`}
                  {overdue > 0 && upcoming > 0 && " · "}
                  {upcoming > 0 && `В ближайшие сутки ${quantity(upcoming)}`}
                </p>
              )}
            </>
          )}
        </div>
      </header>

      {loading && (
        <div className="arkady-attention__state">
          <Busy label="Проверяю сроки и готовность…" />
        </div>
      )}
      {unavailable && (
        <div
          className="arkady-attention__state"
          role={error ? "alert" : "status"}
        >
          <Notice tone="warning">
            {error ||
              (report?.state === "stale"
                ? "Данные поставок требуют обновления."
                : "Сроки или текущие данные поставок недоступны.")}
          </Notice>
          {onRetry && (
            <Button type="button" onClick={onRetry}>
              <RefreshCw size={16} aria-hidden="true" /> Повторить проверку
            </Button>
          )}
        </div>
      )}
      {ready && report && (
        <>
          {report.items.length > 0 ? (
            <ul className="arkady-attention__list">
              {report.items.slice(0, limit).map((item) => (
                <AttentionItem
                  key={JSON.stringify([item.key, item.stage, item.article])}
                  item={item}
                  actions={getActions?.(item)}
                />
              ))}
            </ul>
          ) : (
            <div className="arkady-attention__state arkady-attention__empty">
              {report.unconfirmed > 0 ? (
                <CircleAlert
                  className="is-unconfirmed"
                  size={20}
                  aria-hidden="true"
                />
              ) : (
                <ClipboardCheck size={20} aria-hidden="true" />
              )}
              <p>
                {report.checked === 0
                  ? "Пока нет активных поставок для проверки."
                  : "Среди проверенных данных нет поставок, требующих внимания."}
              </p>
            </div>
          )}
          {(report.unconfirmed > 0 || report.items.length > limit) && (
            <footer className="arkady-attention__footer">
              {report.unconfirmed > 0 && (
                <p>
                  Поставок с неподтверждёнными данными{" "}
                  {quantity(report.unconfirmed)}
                </p>
              )}
              {report.items.length > limit && (
                <Button
                  type="button"
                  onClick={() => setLimit((count) => count + perPage)}
                >
                  Показать ещё{" "}
                  {quantity(Math.min(perPage, report.items.length - limit))}
                </Button>
              )}
            </footer>
          )}
        </>
      )}
    </section>
  );
}

export function ArkadyOperationAttention({
  issue,
  onOpen,
  actionLabel = "Проверить операцию",
}: {
  issue: { title: string; detail: string } | null;
  onOpen: () => void;
  actionLabel?: string;
}) {
  if (!issue) return null;
  return (
    <aside
      className="arkady-attention-operation"
      aria-label="Операции поставок"
    >
      <span className="arkady-attention-operation__icon">
        <RefreshCw size={20} aria-hidden="true" />
      </span>
      <div>
        <h3>{issue.title}</h3>
        <p>{issue.detail}</p>
      </div>
      <Button type="button" onClick={onOpen}>
        {actionLabel} <ArrowRight size={16} aria-hidden="true" />
      </Button>
    </aside>
  );
}
