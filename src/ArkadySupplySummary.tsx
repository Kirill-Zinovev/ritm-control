import { useMemo } from "react";
import { ArrowRight, PackageCheck, Printer, Scissors } from "lucide-react";
import {
  diagnoseArkadySupply,
  type ArkadySupplyOptions,
} from "./arkadyAssistantData";
import { summarizeArkadySupply } from "./arkadySupplySummaryData";
import type { LiveOrder } from "./livePrinting";
import { formatPrintQuantity as quantity } from "./liveSupplyProgress";
import "./arkadySupplySummary.css";

type Props = {
  orders: readonly LiveOrder[];
  missingPositions?: number;
  plan?: number | null;
  lock?: ArkadySupplyOptions["lock"];
  snapshotStale?: boolean;
  packingAvailable?: boolean;
  onRevealOrder?: (order: LiveOrder) => void;
};

const stageMeta = {
  print: { label: "Печать", Icon: Printer },
  cut: { label: "Порезка", Icon: Scissors },
  packing: { label: "Упаковка", Icon: PackageCheck },
};

const lockLabels = {
  closed: "Сборка закрыта",
  partial: "Часть поставки закрыта для сборки",
  pending: "Изменение статуса сборки проверяется",
  unknown: "Статус сборки не подтверждён",
};

export function ArkadySupplySummary({
  orders,
  missingPositions,
  plan,
  lock,
  snapshotStale,
  packingAvailable,
  onRevealOrder,
}: Props) {
  const summary = useMemo(
    () =>
      summarizeArkadySupply(orders, {
        missingPositions,
        plan,
        snapshotStale,
        packingAvailable,
      }),
    [orders, missingPositions, plan, snapshotStale, packingAvailable],
  );
  const actions = useMemo(() => {
    const next: { order: LiveOrder; title: string }[] = [];
    if (!onRevealOrder) return next;
    const picked = new Set<LiveOrder>();
    for (const { position, title } of diagnoseArkadySupply(orders, {
      lock,
      missingPositions,
      stale: snapshotStale,
      packingAvailable,
    })) {
      if (!position) continue;
      const order = orders.find(
        (item) =>
          item.uid === position.uid &&
          item.sourceId === position.sourceId &&
          item.sheetId === position.sheetId &&
          item.row === position.row,
      );
      if (!order || picked.has(order)) continue;
      picked.add(order);
      next.push({ order, title });
      if (next.length === 3) break;
    }
    return next;
  }, [
    orders,
    lock,
    missingPositions,
    snapshotStale,
    packingAvailable,
    onRevealOrder,
  ]);

  return (
    <section className="arkady-summary" aria-label="Сводка поставки">
      <header className="arkady-summary__heading">
        <h3>Сводка поставки</h3>
        <small>{quantity(summary.positions)} поз.</small>
      </header>
      <ul className="arkady-summary__stages">
        {summary.stages.map((stage) => {
          const { Icon, label } = stageMeta[stage.stage];
          const coveragePartial = stage.exact < stage.positions;
          const width =
            stage.confirmed !== null && stage.plan !== null
              ? Math.min(
                  stage.complete ? 100 : 98,
                  (stage.confirmed / stage.plan) * 100,
                )
              : 0;
          const excess = (stage.recorded ?? 0) - (stage.confirmed ?? 0);
          return (
            <li
              className={
                "arkady-summary__stage arkady-summary__stage--" + stage.stage
              }
              key={stage.stage}
            >
              <span className="arkady-summary__stage-name">
                <Icon size={16} aria-hidden="true" /> {label}
              </span>
              <strong className="arkady-summary__stage-amount">
                {stage.confirmed === null
                  ? "—"
                  : (coveragePartial ? "≥ " : "") + quantity(stage.confirmed)}
                <span>
                  {" "}
                  / {stage.plan === null ? "—" : quantity(stage.plan)} шт.
                </span>
              </strong>
              <div className="arkady-summary__meter" aria-hidden="true">
                <span style={{ width: width + "%" }} />
              </div>
              <small className="arkady-summary__stage-note">
                {stage.stage === "packing" && packingAvailable === false
                  ? "Данные Сборки недоступны"
                  : stage.complete
                    ? "План выполнен"
                    : stage.confirmed === null
                      ? "Факт не подтверждён"
                      : stage.exact < stage.positions
                        ? "Точные данные " +
                          quantity(stage.exact) +
                          " из " +
                          quantity(stage.positions) +
                          " поз."
                        : "Подтверждено по всем позициям"}
              </small>
              {excess > 0 && stage.recorded !== null && (
                <small className="arkady-summary__stage-note">
                  Учтено {coveragePartial ? "не менее " : ""}
                  {quantity(stage.recorded)} шт.
                </small>
              )}
            </li>
          );
        })}
      </ul>
      {summary.plan === null && summary.observedPlan > 0 && (
        <p className="arkady-summary__note">
          План по доступным позициям {quantity(summary.observedPlan)} шт.
        </p>
      )}
      {snapshotStale && (
        <p className="arkady-summary__note">
          Показан последний снимок. Текущий статус уточняется.
        </p>
      )}
      {lock && lock !== "open" && (
        <p className="arkady-summary__note">{lockLabels[lock]}</p>
      )}
      {!!actions.length && (
        <ul
          className="arkady-summary__actions"
          aria-label="Позиции для проверки"
        >
          {actions.map(({ order, title }) => (
            <li
              key={JSON.stringify([
                order.sourceId,
                order.sheetId,
                order.row,
                order.uid,
              ])}
            >
              <button type="button" onClick={() => onRevealOrder?.(order)}>
                <span>
                  <b>{order.article}</b> <small>{title}</small>
                </span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
