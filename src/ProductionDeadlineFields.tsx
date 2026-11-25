import { Package, Printer, Truck } from "./icons";
import { Field } from "./ui";

export function ProductionDeadlineFields({
  ready,
  packing,
  ship,
  onReady,
  onPacking,
  onShip,
  disabled = false,
  timeline = false,
}: {
  ready: string;
  packing: string;
  ship: string;
  onReady: (v: string) => void;
  onPacking: (v: string) => void;
  onShip: (v: string) => void;
  disabled?: boolean;
  timeline?: boolean;
}) {
  const steps = [
    {
      label: "Печать и порезка готовы к",
      id: "print",
      value: ready,
      onChange: onReady,
      icon: Printer,
    },
    {
      label: "Упаковка готова к",
      id: "pack",
      value: packing,
      min: ready,
      onChange: onPacking,
      icon: Package,
    },
    {
      label: "Отгрузка",
      id: "ship",
      value: ship,
      min: packing || ready,
      onChange: onShip,
      icon: Truck,
    },
  ];
  const fields = (
    <div
      className={timeline ? "supply-deadline-steps" : "production-deadlines"}
    >
      {steps.map(({ label, id, value, min, onChange, icon: Icon }) => {
        const field = (
          <Field key={id} label={label}>
            <input
              aria-label={label}
              type="datetime-local"
              value={value}
              min={min || undefined}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
            />
          </Field>
        );
        return timeline ? (
          <div key={id} className={`supply-deadline-step is-${id}`}>
            <div className="supply-deadline-icon">
              <Icon size={22} aria-hidden="true" />
            </div>
            {field}
          </div>
        ) : (
          field
        );
      })}
      {!timeline && <small>Время московское.</small>}
    </div>
  );
  if (!timeline) return fields;
  return (
    <section className="supply-deadline-timeline" aria-label="Сроки поставки">
      <header>
        <h3>Сроки поставки</h3>
      </header>
      {fields}
    </section>
  );
}
