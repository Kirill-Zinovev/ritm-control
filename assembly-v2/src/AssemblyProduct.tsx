import { useState } from "react";
import { Box, ChevronDown, History, Printer } from "lucide-react";
import type { Operation, Position, Supply } from "../shared/model";
import { dateTime, number, operationLabels } from "../shared/model";
import { availableOperations, workBlockedReason } from "../shared/assembly";
import { Button } from "./ui";
import type { Workspace } from "./useWorkspace";
import { CancelWorkDialog } from "./WorkHistory";
import { ProductPhoto } from "./ProductPhoto";

export function AssemblyProduct({
  product: p,
  supply,
  workspace: w,
  expanded,
  highlighted,
  onExpand,
  onWork,
  onBox,
  onLabel,
  labelSelected,
  labelSelectionDisabled,
  onSelectLabel,
}: {
  product: Position;
  supply: Supply;
  workspace: Workspace;
  expanded: boolean;
  highlighted: boolean;
  onExpand(): void;
  onWork(): void;
  onBox(): void;
  onLabel(): void;
  labelSelected: boolean;
  labelSelectionDisabled: boolean;
  onSelectLabel(selected: boolean): void;
}) {
  return (
    <article id={`position-${p.id}`} className={`article${expanded ? " expanded" : ""}${highlighted ? " is-search-target" : ""}`}>
      <button
        type="button"
        className="article-main"
        aria-label={`${p.sku} · ${expanded ? "свернуть" : "развернуть"} подробности`}
        aria-expanded={expanded}
        onClick={onExpand}
      >
        <div className="product-cell">
          <ProductPhoto
            importId={p.catalogImportId ?? ""}
            id={p.catalog?.photoId ?? null}
            sourceUrl={p.photoUrl}
            sku={p.sku}
            className="photo"
          />
          <div className="product-copy">
            <div className="sku-line">
              <span className="sku">{p.sku}</span>
              <span className="store-badge">{supply.store}</span>
            </div>
            <div className="product-name">{p.name}</div>
            <div className="product-type mobile-product-type">
              {p.catalog?.kind || "Вид не указан"}
            </div>
            <span className="item-source-label">{p.department}</span>
          </div>
        </div>
        <div className="type-cell">{p.catalog?.kind || "—"}</div>
        <div className="box-type-cell">{p.catalog?.boxType || "—"}</div>
        <div className="plan-cell">
          <span>{number(p.plan)}</span>
          <span className="plan-unit">шт.</span>
        </div>
        {(["cut", "assembly", "packing"] as const).map((op) => (
          <Stage key={op} position={p} operation={op} />
        ))}
        <div className="remaining-cell" title="Осталось упаковать">
          {number(Math.max(0, p.plan - p.packing))}
        </div>
        <span className="expand-button">
          <ChevronDown size={18} aria-hidden="true" />
        </span>
      </button>
      <Button
        className="quick-work"
        aria-label={`Записать работу · ${p.sku}`}
        disabled={w.busy || w.loading || w.selectionPending || !p.ready}
        title={workBlockedReason(p, supply) || undefined}
        onClick={onWork}
      >
        Записать работу
      </Button>
      {expanded ? (
        <ProductDetails product={p} workspace={w} onBox={onBox} onLabel={onLabel}
          labelSelected={labelSelected} labelSelectionDisabled={labelSelectionDisabled} onSelectLabel={onSelectLabel} />
      ) : null}
    </article>
  );
}
function Stage({
  position: p,
  operation: op,
}: {
  position: Position;
  operation: Operation;
}) {
  const available = availableOperations(p).includes(op);
  const plan = op === "packing" || op === "assembly" || p.cutOperation === op ? p.plan : 0;
  const ratio = plan > 0 ? p[op] / plan : 0;
  const progress = plan > 0 ? `${number(p[op])} из ${number(plan)}` : `${number(p[op])} шт.`;
  return (
    <div
      className={`stage stage-${op} ${available ? "" : "stage-na"}`}
      data-stage={operationLabels[op]}
      aria-label={`${operationLabels[op]}: ${available ? progress : "не требуется"}`}
    >
      {available && plan > 0 ? (
        <>
          <div className="stage-top">
            <div className="stage-number">
              {number(p[op])} <span>/ {number(plan)}</span>
            </div>
            <div className="stage-percent">{Math.round(ratio * 100)}%</div>
          </div>
          <div className="track">
            <div
              className="track-fill"
              style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
            />
          </div>
          {p[op] > plan && plan > 0 ? (
            <div className="stage-over">
              +{number(p[op] - plan)} сверх плана
            </div>
          ) : null}
        </>
      ) : available ? (
        <div className="stage-number">{number(p[op])} <span>шт.</span></div>
      ) : (
        "—"
      )}
    </div>
  );
}
function ProductDetails({
  product: p,
  workspace: w,
  onBox,
  onLabel,
  labelSelected,
  labelSelectionDisabled,
  onSelectLabel,
}: {
  product: Position;
  workspace: Workspace;
  onBox(): void;
  onLabel(): void;
  labelSelected: boolean;
  labelSelectionDisabled: boolean;
  onSelectLabel(selected: boolean): void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const records = w.state!.works.filter((x) => x.positionId === p.id);
  const boxes = w.state!.cartons.filter((c) =>
    c.items.some((i) => i.positionId === p.id),
  );
  const cancel = records.find((x) => x.id === cancelId);
  return (
    <div className="details compact-details">
      <div className="compact-actions">
        <Button
          className="button-quiet history-toggle"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((v) => !v)}
        >
          <History size={15} aria-hidden="true" />
          История работы{records.length ? ` · ${records.length}` : ""}
        </Button>
        <Button className="button-quiet label-action" disabled={w.loading || w.selectionPending}
          aria-label={`Печать этикетки ${p.sku}`} onClick={onLabel}>
          <Printer size={15} aria-hidden="true" />Этикетка
        </Button>
        <Button
          className="button-quiet compact-add-box"
          disabled={w.busy || w.loading || w.selectionPending || !p.ready}
          onClick={onBox}
        >
          <Box size={15} aria-hidden="true" />
          Добавить в короб
        </Button>
        <label className="label-select-row">
          <input type="checkbox" checked={labelSelected} disabled={labelSelectionDisabled || w.loading || w.selectionPending}
            aria-label={`Выбрать этикетку ${p.sku} для общей печати`}
            onChange={e => onSelectLabel(e.target.checked)} />В печать
        </label>
      </div>
      <div className="compact-source-note">
        {p.department} ·{" "}
        {p.unitsPerBox
          ? `${number(p.unitsPerBox)} шт. / короб`
          : "Норма короба не задана"}{" "}
        · Упаковано без короба: {number(p.packing - p.boxed)} шт.
      </div>
      {boxes.length ? (
        <details className="compact-carton-summary">
          <summary>Короба по артикулу · {boxes.length}</summary>
          <div className="inline-box-list">
            {boxes.map((c) => (
              <div className="inline-box-card" key={c.id}>
                <strong className="inline-box-number">{c.label}</strong>
                <span>
                  {number(
                    c.items
                      .filter((i) => i.positionId === p.id)
                      .reduce((n, i) => n + i.qty, 0),
                  )}{" "}
                  шт. · {c.state === "open" ? "Открыт" : "Закрыт"}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {historyOpen ? (
        <section
          className="compact-history"
          aria-label={`История работы ${p.sku}`}
        >
          <h3>История работы</h3>
          <div className="worker-card-list">
            {p.team.map((t) => (
              <article className="worker-card" key={t.employeeId}>
                <div className="worker-card-head">
                  <span className="worker-card-person">
                    <span className="avatar">{t.name[0]}</span>
                    <strong className="worker-card-name">{t.name}</strong>
                  </span>
                </div>
                <div className="worker-operation-list">
                  {availableOperations(p).map((op) => (
                    <div
                      className={`worker-operation worker-operation-${op}`}
                      key={op}
                    >
                      <span className="worker-operation-label">
                        {operationLabels[op]}
                      </span>
                      <strong className="worker-operation-value">
                        {number(t[op])} шт.
                      </strong>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
          {!p.team.length ? (
            <p className="empty-workers">Работа ещё не записана.</p>
          ) : null}
          <div className="history-panel">
            {records.map((x) => (
              <div className="history-event" key={x.id}>
                <div>
                  <strong className="history-event-summary">
                    {x.employee} · {operationLabels[x.operation]} ·{" "}
                    {number(x.qty)} шт.
                  </strong>
                  <span className="history-event-meta">
                    {dateTime(x.createdAt)} МСК
                    {x.canceled ? ` · Отменена: ${x.cancelReason}` : ""}
                  </span>
                </div>
                {!x.canceled ? (
                  <Button
                    className="history-event-delete"
                    disabled={w.busy}
                    onClick={() => setCancelId(x.id)}
                  >
                    Отменить запись
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
          <p className="readonly-note">
            Показаны записи из последних 100 операций поставки; итог по
            сотрудникам включает всю работу.
          </p>
        </section>
      ) : null}
      {cancel ? (
        <CancelWorkDialog
          work={cancel}
          workspace={w}
          onClose={() => setCancelId(null)}
        />
      ) : null}
    </div>
  );
}
