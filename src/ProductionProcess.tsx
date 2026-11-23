import { useEffect, useState } from "react";
import { Printer, Scissors, ChevronRight, PackageCheck } from "lucide-react";
import { Badge, Button, Progress } from "./ui";
import { num } from "./model";
import { MACHINES } from "./machineWorkloadData";
import {
  processFact,
  processGroups,
  type ProcessFact,
} from "./productionProcessFacts";
import type { ForecastRow, ForecastTask } from "./productionForecastModel";

export function ProcessStage({
  fact,
  phase,
  compact = false,
  forecast,
  deadline,
  notApplicable = false,
}: {
  fact: ProcessFact;
  phase: "print" | "cut" | "packing";
  compact?: boolean;
  forecast?: number | null;
  deadline?: string | null;
  notApplicable?: boolean;
}) {
  const print = phase === "print";
  return (
    <div
      className={`production-process-stage ${phase} ${compact ? "compact" : ""}`}
    >
      {!compact && (
        <span className="production-process-label">
          {print ? (
            <Printer size={18} />
          ) : phase === "cut" ? (
            <Scissors size={18} />
          ) : (
            <PackageCheck size={18} />
          )}{" "}
          {print ? "Печать" : phase === "cut" ? "Порезка" : "Упаковка"}
        </span>
      )}
      {compact && (
        <small className="production-process-compact-label">
          {print ? "Напечатано" : phase === "cut" ? "Порезано" : "Упаковано"}
        </small>
      )}
      {notApplicable ? (
        <small>Не передаётся в «RITM Сборка»</small>
      ) : (
        <>
          <div className="production-process-values">
            <strong>
              {fact.unknownCount > 0 ? "≥ " : ""}
              {num(fact.ready)} <span>из {num(fact.plan)} шт.</span>
            </strong>
            <span>
              {fact.unknownCount ? "≥ " : ""}
              {num(fact.plan > 0 ? (fact.ready / fact.plan) * 100 : 0)}%
            </span>
          </div>
          <Progress value={fact.ready} plan={fact.plan} showValue={false} />
          <small>
            {fact.unknownCount > 0
              ? "Остаток по проверенным позициям"
              : "Осталось"}
            : {num(fact.remaining)} шт.
          </small>
          {fact.unknownCount > 0 && (
            <small className="production-process-warning">
              Не подтверждено: {fact.unknownCount} поз. ·{" "}
              {num(fact.unknownPlan)} шт. плана
            </small>
          )}
          {fact.done > fact.ready && (
            <small>Сверх плана: +{num(fact.done - fact.ready)} шт.</small>
          )}
          {fact.unconfirmedExcess > 0 && (
            <small className="production-process-warning">
              Старые записи Xerox: излишек по {fact.unconfirmedExcess} поз. требует проверки
            </small>
          )}
          {!compact && forecast !== undefined && (
            <small>
              {fact.unknownCount === 0 && fact.remaining === 0 && fact.positions
                ? "Готово"
                : forecast
                  ? `Прогноз: ${new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(forecast)}`
                  : "Прогноз: нет данных"}
            </small>
          )}
          {!compact && deadline && (
            <small>
              План:{" "}
              {new Intl.DateTimeFormat("ru-RU", {
                timeZone: "Europe/Moscow",
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              }).format(new Date(deadline))}
            </small>
          )}
        </>
      )}
    </div>
  );
}
export function ProductionProcess({
  rows,
  tasks,
  fresh,
  onSelect,
}: {
  rows: ForecastRow[];
  tasks: ForecastTask[];
  fresh: boolean;
  onSelect: (key: string) => void;
}) {
  const [limit, setLimit] = useState(6),
    identity = rows.map((r) => r.key).join("|");
  useEffect(() => setLimit(6), [identity]);
  return (
    <section
      className="production-process"
      aria-label="Фактический процесс производства"
    >
      <div className="production-process-heading">
        <div>
          <h3>Как идёт работа</h3>
          <p>Фактическое выполнение → что осталось → ожидаемый срок</p>
        </div>
        <Badge tone={fresh ? "success" : "warning"}>
          {fresh
            ? "По текущим данным"
            : "Последний снимок · требуется обновление"}
        </Badge>
      </div>
      {!rows.length && <p>По выбранным фильтрам заданий нет.</p>}
      {rows.slice(0, limit).map((row) => {
        const items = tasks.filter((t) => t.supplyKey === row.key),
          print = processFact(items, "print"),
          cut = processFact(items, "cut"),
          packing = processFact(items, "packing");
        const ahead = items.find((item) => !item.packingExcluded && item.packed != null && item.cut != null &&
          Math.min(item.packed, item.plan) > Math.min(item.cut, item.plan) + (item.stockPacked || 0));
        const unknown = print.unknownCount + cut.unknownCount > 0;
        const done =
          items.length > 0 &&
          !unknown &&
          print.remaining === 0 &&
          cut.remaining === 0;
        return (
          <article className="card production-process-card" key={row.key}>
            <header>
              <div>
                <span
                  className={`forecast-market ${row.market === "WB" ? "wb" : ""}`}
                >
                  {row.market || "R"}
                </span>
                <div>
                  <h3>{row.name}</h3>
                  <small>
                    {items.length} поз. ·{" "}
                    {row.packingExcluded
                      ? `план ${num(row.plan)} шт.`
                      : packing.plan !== row.plan
                        ? `печать ${num(row.plan)} · упаковка ${num(packing.plan)} шт.`
                        : `план ${num(row.plan)} шт.`}
                    {row.urgent ? " · 🔥 Срочно" : ""}
                  </small>
                </div>
              </div>
              <Badge tone={unknown ? "warning" : done ? "success" : "neutral"}>
                {unknown
                  ? "Часть данных требует проверки"
                  : done
                    ? "Печать и порезка готовы"
                    : print.done + cut.done > 0
                      ? "Выполняется"
                      : "Выпуск ещё не отмечен"}
              </Badge>
              {row.packingAt && (
                <Badge
                  tone={
                    row.packingStatus === "done" ||
                    row.packingStatus === "on-time"
                      ? "success"
                      : row.packingStatus === "late"
                        ? "danger"
                        : "warning"
                  }
                >
                  {row.packingStatus === "done"
                    ? "Упаковка готова"
                    : row.packingStatus === "on-time"
                      ? "Упаковка в срок"
                      : row.packingStatus === "late"
                        ? "Упаковка позже срока"
                        : row.packingStatus === "risk"
                          ? "Упаковка под риском"
                          : "Срок упаковки не подтверждён"}
                </Badge>
              )}
            </header>
            <div className="production-process-stages">
              <ProcessStage
                fact={print}
                phase="print"
                forecast={row.printAt}
                deadline={row.readyAt}
              />
              <ProcessStage
                fact={cut}
                phase="cut"
                forecast={row.finishAt}
                deadline={row.readyAt}
              />
              <ProcessStage
                fact={packing}
                phase="packing"
                notApplicable={row.packingExcluded}
                forecast={row.packingFinishAt}
                deadline={row.packingAt}
              />
            </div>
            {items.some((item) => item.cutConfirmation) && <p className="production-process-warning">
              Для прогноза руководитель подтвердил порезку {num(items.reduce((total, item) => total + (item.cutConfirmation ? item.cutConfirmation.quantity - item.cutConfirmation.sourceCut : 0), 0))} шт. без даты и исполнителя.
            </p>}
            <details open={rows.length === 1}>
              <summary>
                По участкам и станкам · {processGroups(items).length}
              </summary>
              <div className="production-process-machines">
                <div className="production-process-machine-head">
                  <span>Участок</span>
                  <span>Напечатано</span>
                  <span>Порезано</span>
                </div>
                {processGroups(items).map((group) => (
                  <div className="production-process-machine" key={group.key}>
                    <div>
                      <strong>
                        {MACHINES.find((m) => m.id === group.machine)?.label ||
                          "Станок не определён"}
                      </strong>
                      <small>
                        {group.department === "roll"
                          ? "Рулонная печать"
                          : "Бокс"}{" "}
                        · {group.positions} поз.
                      </small>
                    </div>
                    <ProcessStage fact={group.print} phase="print" compact />
                    <ProcessStage fact={group.cut} phase="cut" compact />
                  </div>
                ))}
              </div>
            </details>
            <footer>
              <div>
                <strong>
                  {row.finishAt
                    ? `Печать и порезка: ${new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(row.finishAt)}`
                    : done
                      ? "Выпуск подтверждён"
                      : "Срок пока не рассчитан"}
                </strong>
                {row.reasons.length > 0 && <small>{row.reasons[0]}</small>}
                {row.packingStatus === "late" && (
                  <small className="production-process-warning">
                    Упаковка позже срока на {num(-(row.packingMargin || 0), 1)}{" "}
                    ч.
                  </small>
                )}
                {row.packingReasons.length > 0 && (
                  <small>Упаковка: {row.packingReasons[0]}</small>
                )}
                {ahead && <small className="production-process-warning">
                  {ahead.article}: упаковано {num(ahead.packed!)} шт., порезка отмечена на {num(ahead.cut!)} шт. Проверьте источник товара.
                </small>}
              </div>
              <Button onClick={() => onSelect(row.key)}>
                {row.reasons.length ? "Причины и сроки" : "Открыть детали"}
                <ChevronRight size={16} />
              </Button>
            </footer>
          </article>
        );
      })}
      {rows.length > limit && (
        <Button onClick={() => setLimit((n) => n + 6)}>
          Показать ещё · осталось {rows.length - limit}
        </Button>
      )}
    </section>
  );
}
