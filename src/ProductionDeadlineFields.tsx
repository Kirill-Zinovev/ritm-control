import { Field } from "./ui";
export function ProductionDeadlineFields({
  ready,
  packing,
  ship,
  onReady,
  onPacking,
  onShip,
  disabled = false,
}: {
  ready: string;
  packing: string;
  ship: string;
  onReady: (v: string) => void;
  onPacking: (v: string) => void;
  onShip: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="production-deadlines">
      <Field label="Печать и порезка готовы к">
        <input
          aria-label="Печать и порезка готовы к"
          type="datetime-local"
          value={ready}
          disabled={disabled}
          onChange={(e) => onReady(e.target.value)}
        />
      </Field>
      <Field label="Упаковка готова к">
        <input
          aria-label="Упаковка готова к"
          type="datetime-local"
          value={packing}
          disabled={disabled}
          min={ready || undefined}
          onChange={(e) => onPacking(e.target.value)}
        />
      </Field>
      <Field label="Отгрузка">
        <input
          aria-label="Отгрузка"
          type="datetime-local"
          value={ship}
          disabled={disabled}
          min={packing || ready || undefined}
          onChange={(e) => onShip(e.target.value)}
        />
      </Field>
      <small>Время московское.</small>
    </div>
  );
}
