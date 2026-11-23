import type { ReactNode } from "react";
import { countLabel, number, type CartonItem } from "../shared/model";
import { ProductPhoto } from "./ProductPhoto";

export function WarehouseOverview({ title, metrics, actions }: {
  title: string;
  metrics: readonly { label: string; value: number | null }[];
  actions: ReactNode;
}) {
  return (
    <div className="warehouse-overview">
      <header className="warehouse-overview-heading">
        <h1>{title}</h1>
        <div className="actions">{actions}</div>
      </header>
      <dl className="warehouse-overview-metrics" aria-label="Сводка">
        {metrics.map(({ label, value }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value === null ? "—" : number(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function WarehousePageCheck({ rows, selected, onChange, label = "Выбрать все короба на этой странице", disabled }: {
  rows: readonly { id: string }[];
  selected: ReadonlySet<string>;
  onChange(selection: Set<string>): void;
  label?: string;
  disabled?: boolean;
}) {
  const checked = rows.length > 0 && rows.every(({ id }) => selected.has(id));
  const partial = !checked && rows.some(({ id }) => selected.has(id));
  return (
    <input type="checkbox" aria-label={label} checked={checked} disabled={disabled}
      ref={(node) => { if (node) node.indeterminate = partial; }}
      onChange={(event) => {
        const next = new Set(selected);
        for (const { id } of rows) {
          if (event.target.checked) next.add(id);
          else next.delete(id);
        }
        onChange(next);
      }} />
  );
}

export function WarehouseCompositionPreview({ items, total = items.length }: {
  items: readonly Pick<CartonItem, "id" | "sku" | "catalogImportId" | "photoId" | "photoUrl">[];
  total?: number;
}) {
  return (
    <>
      <div className="composition-thumbs">
        {items.slice(0, 2).map((item) => (
          <ProductPhoto key={item.id} importId={item.catalogImportId || ""} id={item.photoId ?? null}
            sourceUrl={item.photoUrl} sku={item.sku} />
        ))}
        {total > 2 && <span>+{total - 2}</span>}
      </div>
      {countLabel(total, ["вложение", "вложения", "вложений"])}
      {items.length > 0 && <small>{items.slice(0, 2).map((item) => item.sku).join(", ")}{total > 2 ? "…" : ""}</small>}
    </>
  );
}
