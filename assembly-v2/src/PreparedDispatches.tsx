import { useEffect, useState } from "react";
import { Truck } from "lucide-react";
import { countLabel, dateTime, number, type Dispatch, type PreparedDispatch } from "../shared/model";
import { warehouseCity } from "../shared/warehouse-filter";
import { Button, Empty } from "./ui";
import { request } from "./useWorkspace";
import { WarehousePageCheck } from "./WarehouseOverview";
import "./prepared-dispatches.css";

export type DepartureReview = {
  city: string;
  market: Dispatch["market"];
  waiting: number;
  drafts: { dispatchId: string; store: string; cartons: PreparedDispatch["cartons"] }[];
};

const cartonCount = (quantity: number) => countLabel(quantity, ["короб", "короба", "коробов"]);

export function PreparedDispatches({ revision, busy, onSend, onCancel, onExport }: {
  revision: string;
  busy: boolean;
  onSend(review: DepartureReview): void;
  onCancel(dispatch: Dispatch): void;
  onExport(dispatch: Dispatch): void;
}) {
  const [rows, setRows] = useState<PreparedDispatch[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void request<PreparedDispatch[]>("/api/dispatches/prepared", { signal: abort.signal })
      .then((drafts) => {
        if (abort.signal.aborted) return;
        setRows(drafts);
        const available = new Set(drafts.flatMap((draft) => draft.cartons.map(({ id }) => id)));
        setSelected((previous) => new Set([...previous].filter((id) => available.has(id))));
      })
      .catch((failure: Error) => {
        if (!abort.signal.aborted) setError(failure.message);
      })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [revision, retry]);

  if (!rows && !error) return <p role="status">Загружаем подготовленные отгрузки…</p>;
  if (!rows?.length && !error) return (
    <Empty title="Подготовленных отгрузок нет">
      Сначала выберите закрытые короба на вкладке «Готовы к отгрузке».
    </Empty>
  );
  const groups = new Map<string, { city: string; market: Dispatch["market"]; drafts: PreparedDispatch[] }>();
  for (const dispatch of rows ?? []) {
    const city = warehouseCity(dispatch);
    const key = JSON.stringify([dispatch.market, city.key]);
    const group = groups.get(key) ?? { city: city.label, market: dispatch.market, drafts: [] };
    group.drafts.push(dispatch);
    groups.set(key, group);
  }
  const disabled = busy || loading || Boolean(error);
  return (
    <div className="prepared-dispatches">
      {error && <div className="actions">
        <p role="alert" className="field-error">{error}</p>
        <Button onClick={() => setRetry((value) => value + 1)}>Обновить список</Button>
      </div>}
      {[...groups].map(([key, { city, market, drafts }]) => {
        const cartons = drafts.flatMap((draft) => draft.cartons);
        const chosen = cartons.filter(({ id }) => selected.has(id)).length;
        return (
          <section key={key} className="prepared-city" aria-label={`${city} · ${market}`}>
            <header className="prepared-city-head">
              <div>
                <h2>{city}</h2>
                <p className="muted">{market} · {cartonCount(cartons.length)} в подготовке</p>
              </div>
              <div className="prepared-city-actions">
                <label>
                  <WarehousePageCheck rows={cartons} selected={selected} onChange={setSelected}
                    disabled={disabled || !cartons.length} label={`Все короба города ${city} · ${market}`} />
                  Все короба города
                </label>
                <Button primary disabled={disabled || chosen === 0} onClick={() => onSend({
                  city, market, waiting: cartons.length - chosen,
                  drafts: drafts.map(({ id, store, cartons }) => ({
                    dispatchId: id, store, cartons: cartons.filter(({ id }) => selected.has(id)),
                  })).filter((draft) => draft.cartons.length > 0),
                })}><Truck size={17} aria-hidden="true" />Отметить выезд{chosen > 0 ? " · " + number(chosen) : ""}</Button>
              </div>
            </header>
            {drafts.map((draft) => (
              <article key={draft.id} className="prepared-store">
                <div className="prepared-store-head">
                  <div>
                    <h3>Магазин {draft.store}</h3>
                    <p className="muted">{cartonCount(draft.cartons.length)} · {number(draft.cartons.reduce((qty, box) => qty + box.qty, 0))} шт. · {dateTime(draft.createdAt)} МСК</p>
                  </div>
                  <div className="actions">
                    <Button disabled={disabled} onClick={() => onExport(draft)}>Excel и состав</Button>
                    <Button disabled={disabled} onClick={() => onCancel(draft)}>Отменить подготовку</Button>
                  </div>
                </div>
                <div className="prepared-cartons">
                  {draft.cartons.map((box) => (
                    <label key={box.id} className="prepared-carton" data-selected={selected.has(box.id)}>
                      <input type="checkbox" checked={selected.has(box.id)} disabled={disabled} onChange={(event) => {
                        const checked = event.target.checked;
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (checked) next.add(box.id);
                          else next.delete(box.id);
                          return next;
                        });
                      }} />
                      <strong>{box.label}</strong><span>{number(box.qty)} шт.</span>
                    </label>
                  ))}
                </div>
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}
