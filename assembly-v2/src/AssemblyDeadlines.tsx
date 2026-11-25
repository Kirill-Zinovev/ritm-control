import type { CSSProperties } from "react";
import { CalendarDays, Check, ChevronRight, Package } from "lucide-react";
import {
  deadlineCaption, deadlineClock, deadlineDate, deadlineWeekday, longDeadlineDate,
  type DeadlineState, type SupplyDeadlines,
} from "../shared/supply-deadlines";
import type { Supply } from "../shared/model";
import "./assembly-deadlines.css";

export interface DeadlineShipment {
  supply: Supply;
  deadlines: SupplyDeadlines;
}

export function deadlineTone(deadlines: SupplyDeadlines) {
  return deadlines.rank === 0 ? "overdue" : deadlines.rank === 1 ? "today" : "planned";
}

export function shipmentDate(deadlines: SupplyDeadlines) {
  const shipping = deadlines.stages[3].at;
  return shipping ? `Отправка ${deadlineDate(shipping)}` : "Дата отправки не указана";
}

const expressSnow = Array.from({ length: 64 }, (_, index) => {
  const duration = 5.5 + (index * 31 % 71) / 10;
  const near = index % 8 === 0;
  return {
    near,
    style: {
      "--snow-x": (2 + index * 37 % 96) + "%",
      "--snow-y": (-31 + index * 23 % 81) + "%",
      "--snow-size": (near ? 0.51 : 0.095 + (index * 7 % 15) * 0.021).toFixed(3) + "cqw",
      "--snow-time": duration.toFixed(1) + "s",
      "--snow-delay": (-(index * 1.38 + 0.8) % duration).toFixed(2) + "s",
    } as CSSProperties,
  };
});

function GiftExpressScene() {
  return <div className="assembly-express-art" aria-hidden="true">
    <div className="assembly-express-motion">
      <span className="assembly-express-gift" />
      <span className="assembly-express-gift is-berry" />
      {expressSnow.map(({ near, style }, index) =>
        <span className={near ? "assembly-express-snow is-near" : "assembly-express-snow"} style={style} key={index} />
      )}
    </div>
  </div>;
}

export function UpcomingDeadlines({ now, items, selected, disabled, onSelect }: {
  now: number;
  items: (DeadlineShipment & { title: string })[];
  selected: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  if (!items.length && !selected) return null;
  return <section className="assembly-upcoming" aria-labelledby="assembly-upcoming-title">
    <GiftExpressScene />
    <div className="assembly-upcoming-head">
      <h2 id="assembly-upcoming-title">Ближайшие сроки</h2>
      <span className="assembly-upcoming-date">{deadlineWeekday.format(now)}, {longDeadlineDate.format(now)}</span>
    </div>
    {items.length === 0 ? <p className="assembly-upcoming-empty">Ближайших сроков нет</p> : <div className="assembly-upcoming-grid">
      {items.map(({ supply, title, deadlines }) => {
        const shipping = deadlines.stages[3].at;
        const completed = deadlines.stages.filter(({ id, state }) =>
          (id === "print" || id === "cut") && state === "done");
        return (
          <button type="button" key={supply.id} className="assembly-upcoming-card" data-tone={deadlineTone(deadlines)}
            aria-current={supply.id === selected ? "true" : undefined}
            title={supply.title} disabled={disabled} onClick={() => onSelect(supply.id)}>
            <span>
              <strong>{title}</strong>
              {shipping
                ? <span className="assembly-upcoming-shipping">
                    Отправка <time dateTime={shipping}>{longDeadlineDate.format(Date.parse(shipping))}</time>
                  </span>
                : <span>{shipmentDate(deadlines)}</span>}
              <span className="assembly-deadline-caption">{deadlineCaption(deadlines, true)}</span>
              {completed.length > 0 && <span className="assembly-upcoming-completed">
                {completed.map(stage => <span key={stage.id} className="assembly-deadline-badge" data-tone="done">
                  <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                  {stage.label} готова
                </span>)}
              </span>}
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        );
      })}
    </div>}
  </section>;
}

const statusLabel: Record<DeadlineState, string> = {
  done: "Готово",
  overdue: "Просрочено",
  today: "Сегодня",
  tomorrow: "Завтра",
  planned: "По плану",
  missing: "Срок не задан",
};

export function ShipmentSchedule({ deadlines, title }: { deadlines: SupplyDeadlines; title?: string }) {
  const shipping = deadlines.stages[3];
  return <section className="assembly-schedule" aria-label="Сроки поставки">
    <div className="assembly-schedule-shipping">
      <div className="assembly-schedule-shipping-copy">
        <h2>Отправка</h2>
        {shipping.at ? <>
          <time dateTime={shipping.at}>{longDeadlineDate.format(Date.parse(shipping.at))}</time>
          <span>{deadlineWeekday.format(Date.parse(shipping.at))} · {deadlineClock(shipping.at)} МСК</span>
        </> : <span>Дата отправки не указана</span>}
      </div>
      <div className="assembly-schedule-illustration" aria-hidden="true">
        <CalendarDays size={83} strokeWidth={1.25} />
        <Package size={47} strokeWidth={1.4} />
      </div>
    </div>
    <div className="assembly-schedule-plan">
      <div className="assembly-schedule-head"><h2>Закончить к</h2>{title && <span>{title}</span>}</div>
      <dl className="assembly-schedule-stages">
        {deadlines.stages.slice(0, 3).map(stage => <div key={stage.id}>
          <dt>{stage.label}</dt>
          <dd>
            {stage.at ? <time dateTime={stage.at}>{deadlineDate(stage.at)}, {deadlineClock(stage.at)}</time> : "—"}
            <span className="assembly-deadline-badge" data-tone={stage.state}>{statusLabel[stage.state]}</span>
          </dd>
        </div>)}
      </dl>
    </div>
  </section>;
}
