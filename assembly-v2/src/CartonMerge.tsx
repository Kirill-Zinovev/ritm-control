import { useId, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import { catalogKey } from "../shared/catalog";
import { cartonMergeFingerprint, checkCartonMerge, type CartonMergeReceipt } from "../shared/carton-merge";
import { number, type Carton } from "../shared/model";
import { Button, NativeSelect } from "./ui";
import type { Workspace } from "./useWorkspace";
import "./carton-merge.css";

function fillPercent(fill: number) {
  return fill > 1 + 1e-9 ? Math.ceil(fill * 100) : Math.round(fill * 100);
}

function fillWidth(fill: number) {
  return `${Math.min(100, Math.max(0, fillPercent(fill)))}%`;
}

function CartonFill({ fill, label, previousFill }: { fill: number; label: string; previousFill?: number }) {
  const percent = fillPercent(fill);
  const style: CSSProperties & { "--merge-fill-before"?: string } = { width: fillWidth(fill) };
  if (previousFill !== undefined) style["--merge-fill-before"] = fillWidth(previousFill);
  return (
    <div className={percent > 100 ? "merge-fill merge-fill-overflow" : "merge-fill"}>
      <span>{percent}%</span>
      <div className="merge-fill-track" aria-label={`${label}: ${percent}%`} role="img">
        <span className={previousFill === undefined ? undefined : "merge-fill-settling"} style={style} />
      </div>
    </div>
  );
}

function CartonMetrics({ carton, label, previousFill }: {
  carton: Pick<Carton, "qty" | "fill"> & { capacityUnknown?: boolean };
  label: string;
  previousFill?: number;
}) {
  return (
    <div className="merge-carton-metrics">
      <strong>{number(carton.qty)} шт.</strong>
      {carton.capacityUnknown ? <span>Норма не задана</span> : (
        <CartonFill fill={carton.fill} label={label} previousFill={previousFill} />
      )}
    </div>
  );
}

function composition(source: Carton, target: Carton | undefined) {
  const rows = new Map<string, { key: string; sku: string; sourceQty: number; targetQty: number }>();
  for (const [items, side] of [[source.items, "sourceQty"], [target?.items ?? [], "targetQty"]] as const) {
    for (const item of items) {
      const key = catalogKey(item.sku);
      const row = rows.get(key) ?? { key, sku: item.sku, sourceQty: 0, targetQty: 0 };
      row[side] += item.qty;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) =>
    Number(b.sourceQty > 0) - Number(a.sourceQty > 0) || a.sku.localeCompare(b.sku, "ru", { numeric: true }));
}

export function CartonMerge({ cartons, workspace }: { cartons: Carton[]; workspace: Workspace }) {
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [selectedSkus, setSelectedSkus] = useState<ReadonlySet<string>>();
  const [quantityDrafts, setQuantityDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [receipt, setReceipt] = useState<(CartonMergeReceipt & {
    previousSourceFill: number;
    previousTargetFill: number;
  }) | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const saving = useRef(false);
  const helpId = useId();
  const open = cartons.filter(box => box.state === "open" && !box.dispatchId);
  const donors = open.filter(box => box.qty > 0);
  const source = donors.find(box => box.id === sourceId);
  const target = open.find(box => box.id === targetId);
  const sourceMetrics = receipt ? receipt.sourceRemaining ?? { qty: 0, fill: 0 } : source;
  const targetMetrics = receipt ?? target;
  const rows = source && !receipt ? composition(source, target) : [];
  const available = new Map(rows.filter(row => row.sourceQty > 0).map(row => [row.key, row.sourceQty]));
  const sourceSkus = [...available.keys()];
  const selectedCount = selectedSkus ? sourceSkus.filter(key => selectedSkus.has(key)).length : sourceSkus.length;
  const selection = selectedSkus || quantityDrafts.size > 0
    ? new Map([...selectedSkus ?? sourceSkus].map(key => {
      const draft = quantityDrafts.get(key);
      const qty = draft === undefined ? available.get(key) ?? 0 : (/^\d+$/.test(draft) ? Number(draft) : NaN);
      return [key, qty];
    }))
    : undefined;
  const check = checkCartonMerge(source, target, selection);
  const overCapacity = check.allowed && check.requiresFitConfirmation;
  const busy = submitting || workspace.busy || workspace.loading || workspace.selectionPending;
  const guidance = check.allowed ? "" : open.length < 2
    ? "Для слияния нужны два открытых короба одного направления."
    : !donors.length ? "В открытых коробах пока нет товара." : check.message;

  function selectSkus(skus?: ReadonlySet<string>) {
    setSelectedSkus(skus);
    setError("");
  }

  function toggleSku(key: string, checked: boolean) {
    const next = new Set(sourceSkus.filter(sku => !selectedSkus || selectedSkus.has(sku)));
    if (checked) next.add(key);
    else next.delete(key);
    selectSkus(next);
  }

  function editQuantity(key: string, value: string) {
    setQuantityDrafts(current => {
      const next = new Map(current);
      if (value === String(available.get(key))) next.delete(key);
      else next.set(key, value);
      return next;
    });
    setError("");
  }

  async function merge() {
    if (!source || !target || !check.allowed || busy || saving.current) return;
    saving.current = true;
    setSubmitting(true);
    setError("");
    try {
      const [sourceFingerprint, targetFingerprint] = await Promise.all([
        cartonMergeFingerprint(source, !!selection), cartonMergeFingerprint(target, !!selection),
      ]);
      const result = await workspace.command("carton.merge", {
        sourceCartonId: source.id,
        cartonId: target.id,
        sourceFingerprint,
        targetFingerprint,
        fitConfirmed: overCapacity,
        ...(selection && { quantities: [...selection].sort(([a], [b]) => a.localeCompare(b)).map(([sku, qty]) => ({ sku, qty })) }),
      }, `${number(check.movedQty)} шт. перенесено в ${target.label}`);
      const saved = result as CartonMergeReceipt;
      setReceipt({
        ...saved,
        previousSourceFill: source.fill,
        previousTargetFill: target.fill,
      });
      if (!saved.sourceRemaining?.qty) setSourceId("");
      setSelectedSkus(undefined);
      setQuantityDrafts(new Map());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось объединить короба. Проверьте их состав и повторите.");
    } finally {
      saving.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="carton-merge" aria-label="Слияние коробов направления">
      <div className="merge-body">
        <p className="merge-intro">Выберите короба, отметьте артикулы и укажите, сколько штук переложить.</p>
        <div className={receipt ? "merge-choices is-saved" : "merge-choices"}>
          <div className="merge-carton">
            <NativeSelect label="Откуда переложить" value={source?.id ?? ""} disabled={busy || !donors.length}
              onChange={event => {
                setSourceId(event.target.value);
                setReceipt(null);
                selectSkus();
                setQuantityDrafts(new Map());
              }}>
              <option value="">{source ? "Выберите короб" : receipt?.sourceLabel ?? "Выберите короб"}</option>
              {donors.filter(box => box.id !== targetId).map(box => <option key={box.id} value={box.id}>{box.label}</option>)}
            </NativeSelect>
            {sourceMetrics && <CartonMetrics carton={sourceMetrics} label="Заполнение исходного короба" previousFill={receipt?.previousSourceFill} />}
          </div>
          <ArrowRight className="merge-arrow" size={23} aria-hidden="true" />
          <div className="merge-carton merge-carton-target">
            <NativeSelect label="Куда переложить" value={target?.id ?? ""} disabled={busy || !open.length}
              onChange={event => { setTargetId(event.target.value); setReceipt(null); setError(""); }}>
              <option value="">{target ? "Выберите короб" : receipt?.targetLabel ?? "Выберите короб"}</option>
              {open.filter(box => box.id !== sourceId).map(box => <option key={box.id} value={box.id}>{box.label}</option>)}
            </NativeSelect>
            {targetMetrics && <CartonMetrics carton={targetMetrics} label="Заполнение короба-получателя" previousFill={receipt?.previousTargetFill} />}
          </div>
          {receipt && <span className="merge-flight" aria-hidden="true">{number(receipt.movedQty)} шт.</span>}
        </div>
        {receipt ? (
          <div className="merge-summary merge-saved" role="status">
            <Check size={21} aria-hidden="true" />
            <div><strong>Переложено {number(receipt.movedQty)} шт. в {receipt.targetLabel}</strong>
              <p>{receipt.sourceRemaining?.qty
                ? `В ${receipt.sourceLabel} осталось ${number(receipt.sourceRemaining.qty)} шт.`
                : `${receipt.sourceLabel} освободился.`} В {receipt.targetLabel} теперь {number(receipt.qty)} шт.</p>
              {receipt.fitConfirmed && <p>Фактическая вместимость подтверждена.</p>}
              <p>После закрытия короба новый состав будет в отгрузке и Excel.</p>
            </div>
            {receipt.sourceRemaining?.qty && source ? (
              <Button className="merge-next" disabled={busy} onClick={() => setReceipt(null)}>Выбрать ещё артикулы</Button>
            ) : null}
          </div>
        ) : source && target && check.allowed ? (
          <div className={`merge-summary${overCapacity ? " merge-warning" : ""}`}>
            <div className="merge-summary-text">
              <span>После слияния</span>
              <strong>{target.label} · {number(check.qty)} шт.</strong>
              <p>{check.sourceRemaining.qty
                ? `В ${source.label} останется ${number(check.sourceRemaining.qty)} шт.`
                : `${source.label} освободится`}</p>
            </div>
            <CartonFill fill={check.fill} label="Заполнение после слияния" />
            <span className="merge-fit">
              {overCapacity ? <TriangleAlert size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
              {overCapacity ? "Выше нормы" : "Всё помещается"}
            </span>
          </div>
        ) : null}
        {source && !receipt && (
          <div className="merge-composition">
            <div className="merge-composition-header">
              <div>
                <h3>Артикулы к переносу</h3>
                <p>Выбрано {selectedCount} из {sourceSkus.length}</p>
              </div>
              <div className="merge-sku-buttons">
                <Button disabled={busy || !selectedSkus} onClick={() => selectSkus()}>Выбрать все</Button>
                <Button disabled={busy || selectedCount === 0} onClick={() => selectSkus(new Set())}>Снять выбор</Button>
              </div>
            </div>
            <table aria-label="Артикулы и количества после переноса">
              <thead><tr><th scope="col">Артикул</th><th scope="col">В исходном</th><th scope="col">Переносим, шт.</th><th scope="col">В получателе</th></tr></thead>
              <tbody>{rows.map(row => {
                const checked = selectedSkus?.has(row.key) ?? true;
                const moved = checked ? selection?.get(row.key) ?? row.sourceQty : 0;
                const invalid = row.sourceQty > 0 && checked &&
                  (!Number.isSafeInteger(moved) || moved < 1 || moved > row.sourceQty);
                return (
                  <tr key={row.key}>
                    <th scope="row">{row.sourceQty > 0 ? (
                      <label className="merge-sku-control">
                        <input type="checkbox" checked={checked} disabled={busy}
                          aria-label={`Перенести ${row.sku}`} onChange={event => toggleSku(row.key, event.target.checked)} />
                        <span>{row.sku}</span>
                      </label>
                    ) : row.sku}</th>
                    <td>
                      {number(row.sourceQty)}
                      {checked && !invalid && moved < row.sourceQty && (
                        <small className="merge-row-remaining">Останется {number(row.sourceQty - moved)}</small>
                      )}
                    </td>
                    <td>{row.sourceQty > 0 ? (
                      <input className="merge-quantity" type="number" inputMode="numeric" min={1} max={row.sourceQty} step={1}
                        value={checked ? quantityDrafts.get(row.key) ?? row.sourceQty : 0} disabled={busy || !checked}
                        aria-label={`Количество для ${row.sku}`} aria-invalid={invalid || undefined}
                        onChange={event => editQuantity(row.key, event.target.value)} />
                    ) : "—"}</td>
                    <td><strong>{target && !invalid ? number(row.targetQty + moved) : "—"}</strong></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {!receipt && target && check.allowed && (
          <p className="merge-export-note">После закрытия {target.label} этот состав попадёт в отгрузку и Excel.</p>
        )}
      </div>

      {!receipt && <div className="box-action-footer merge-actions">
        {source && target && <div className="merge-action-summary">
          <strong>{source.label} <ArrowRight size={16} aria-label="в" /> {target.label}</strong>
          {check.allowed && <span>Перенос {number(check.movedQty)} шт.</span>}
        </div>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {(overCapacity || !!guidance) && (
          <p id={helpId} className={`box-guidance${overCapacity || (source && target) ? " is-error" : ""}`}>
            {overCapacity ? "По расчёту короб переполнится. Подтвердите только после проверки, что весь товар физически помещается." : guidance}
          </p>
        )}
        <Button primary type="button" className="box-primary-action" disabled={busy || !check.allowed}
          aria-busy={submitting} aria-describedby={overCapacity || guidance ? helpId : undefined}
          onClick={() => void merge()}>
          {submitting ? "Сохраняем слияние…" : overCapacity ? "Подтвердить, что помещается"
            : check.allowed && check.sourceRemaining.qty > 0 ? "Перенести выбранное" : "Подтвердить слияние"}
        </Button>
      </div>}
    </section>
  );
}
