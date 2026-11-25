import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { labelCopyLimit, labelStatusText, validLabelCopies, type PrintableLabel } from "../shared/labels";
import { Button, Dialog, Field } from "./ui";
import { request } from "./useWorkspace";
import { printLabelCopies } from "./label-print";

type LabelDialogProps = { onClose(): void; labelVersion?: string } & (
  { positionIds: string[]; warehouseReceiptId?: never; catalogEntryId?: never; catalogImportId?: never } |
  { positionIds?: never; warehouseReceiptId: string; catalogEntryId?: never; catalogImportId?: never } |
  { positionIds?: never; warehouseReceiptId?: never; catalogEntryId: string; catalogImportId: string }
);
const emptyIds: string[] = [];
export function LabelDialog({ positionIds = emptyIds, warehouseReceiptId, catalogEntryId, catalogImportId, labelVersion, onClose }: LabelDialogProps) {
  const [items, setItems] = useState<PrintableLabel[]>([]);
  const [copies, setCopies] = useState<Record<string, string>>(() => Object.fromEntries(positionIds.map(id => [id, "1"])));
  const [loading, setLoading] = useState(true), [printing, setPrinting] = useState(false);
  const [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  const [imageError, setImageError] = useState(false);
  const single = positionIds.length <= 1;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setImageError(false);
    const params = new URLSearchParams();
    positionIds.forEach(id => params.append("position", id));
    if (warehouseReceiptId) params.set("receipt", warehouseReceiptId);
    if (catalogEntryId && catalogImportId) { params.set("entry", catalogEntryId); params.set("catalogImport", catalogImportId); }
    void request<{ items: PrintableLabel[] }>(`/api/labels?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(data => { if (!controller.signal.aborted) { setItems(data.items); setCopies(old => Object.fromEntries(data.items.map(item => [item.positionId, old[item.positionId] ?? "1"]))); } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Не удалось загрузить этикетки."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt, positionIds, warehouseReceiptId, catalogEntryId, catalogImportId, labelVersion]);
  const found = items.filter(item => item.status === "found");
  const validCopies = found.length > 0 && found.every(item => validLabelCopies(copies[item.positionId] || ""));
  const total = found.reduce((n, item) => n + (Number(copies[item.positionId]) || 0), 0);
  const previewReady = !imageError && !loading && !error;
  const valid = validCopies && total <= labelCopyLimit && previewReady;
  const current = single ? items[0] : undefined;
  const currentId = current?.positionId ?? positionIds[0] ?? "";
  async function print() {
    if (!valid || printing) return;
    setPrinting(true); setError("");
    try { await printLabelCopies(found.map(label => ({ label, copies: Number(copies[label.positionId]) }))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось открыть печать."); }
    finally { setPrinting(false); }
  }
  const amount = (id: string, value: string) => setCopies(old => ({ ...old, [id]: value }));
  return (
    <Dialog title={single ? "Печать этикетки" : "Этикетки для выбранных"}
      kicker={single ? "Этикетка товара" : `Выбрано товаров · ${positionIds.length}`}
      className="label-modal" onClose={onClose} busy={printing}>
      <div className="label-modal-body">
        {single ? <>
          <div className="label-preview" aria-busy={loading}>
            {loading ? <span role="status">Загружаю оригинал…</span> : current?.imageUrl && !imageError ?
              <img key={`${attempt}:${current.imageUrl}`} src={current.imageUrl} referrerPolicy="no-referrer" alt={`Оригинал этикетки ${current.sku}`} onError={() => setImageError(true)} /> :
              <span className="subhead">{imageError ? "Оригинал не загрузился. Повторите попытку." : current ? labelStatusText[current.status] : "Не удалось загрузить оригинал."}</span>}
          </div>
          <div className="label-details">
            {current ? <>
              <span className="label-market-badge">{current.market}</span>
              <div><strong className="sku">{current.sku}</strong><div className="subhead">{current.name}</div></div>
              <div className={`label-state ${current.status !== "found" || imageError ? "is-error" : ""}`} role="status">
                {imageError ? "Оригинал не загрузился. Печать недоступна." : labelStatusText[current.status]}
              </div>
            </> : <p className="subhead" role="status">{loading ? "Ищу этикетку в базе…" : ""}</p>}
            <Field label="Количество копий" type="number" inputMode="numeric" min={1} max={999} step={1}
              value={copies[currentId] || ""} disabled={loading || printing || current?.status !== "found"}
              onChange={e => amount(currentId, e.target.value)}
              error={current?.status === "found" && !validLabelCopies(copies[currentId] || "") ? "Введите целое число от 1 до 999." : undefined} />
            <div className="label-quick-count" aria-label="Быстрый выбор копий">
              {[1, 10, 50, 100].map(n => <Button key={n} disabled={loading || printing || current?.status !== "found"} onClick={() => amount(currentId, String(n))}>{n}</Button>)}
            </div>
            <div className="label-modal-actions">
              {previewReady && current?.status === "found" && current.imageUrl ? <a className="button" href={`${current.imageUrl}&download=1&name=${encodeURIComponent(current.sku)}`} download>Скачать этикетку</a> : null}
              {previewReady && current?.originalUrl ? <a className="button" href={current.originalUrl} target="_blank" rel="noopener noreferrer">Открыть оригинал</a> : null}
              <Button primary disabled={!valid || printing} onClick={() => void print()}><Printer size={16} aria-hidden="true" />{printing ? "Готовим печать…" : `Печать ${validCopies ? total : 1} шт.`}</Button>
            </div>
          </div>
        </> : <>
          <div className="label-batch-list" aria-busy={loading}>
            {loading ? <p role="status">Проверяю этикетки…</p> : items.map(item => <div className="label-batch-row" key={item.positionId}>
              <strong>{item.sku}</strong>
              <span className={`label-batch-status ${item.status !== "found" ? "field-error" : ""}`}>{labelStatusText[item.status]}</span>
              <Field label={`Копий · ${item.sku}`} type="number" inputMode="numeric" min={1} max={999} step={1}
                value={copies[item.positionId] || ""} disabled={item.status !== "found" || printing}
                onChange={e => amount(item.positionId, e.target.value)}
                error={item.status === "found" && !validLabelCopies(copies[item.positionId] || "") ? "От 1 до 999." : undefined} />
            </div>)}
          </div>
          <div className="label-modal-actions label-batch-footer">
            <span className="subhead">{total > labelCopyLimit ? "Для одной печати выберите не более 1 000 копий." : `Файлов найдено: ${found.length} из ${items.length}`}</span>
            <Button primary disabled={!valid || printing} onClick={() => void print()}><Printer size={16} aria-hidden="true" />{printing ? "Готовим печать…" : `Печать ${total} шт.`}</Button>
          </div>
        </>}
        {error || imageError ? <div className="label-load-error" role="alert">
          <span>{error || "Оригинал не загрузился."}</span>
          <Button disabled={printing} onClick={() => setAttempt(n => n + 1)}>Повторить загрузку</Button>
        </div> : null}
        <p className="readonly-note label-print-note">Размер этикетки задаётся в настройках принтера. Одна копия — одна страница.</p>
      </div>
    </Dialog>
  );
}
