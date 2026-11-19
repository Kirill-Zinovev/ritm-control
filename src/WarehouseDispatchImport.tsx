import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { WarehouseCarton } from "./liveWarehouse";
import { matchWarehouseNumbers, parseWarehouseNumbers, parseWarehouseWorkbook } from "./warehouseImport";
import { warehouseCartonFingerprint } from "./warehouseFingerprint";

type Props = { cartons: WarehouseCarton[]; disabled: boolean; onClose: () => void; onRefresh: () => void | Promise<void> };
const labels: Record<string, string> = { ready: "Найден", missing: "Не найден", ambiguous: "Несколько похожих номеров · требуется проверка", duplicate: "Повтор в списке", sent: "Уже отправлен", open: "Короб открыт", unconfirmed: "Требует сверки источников" };

export function WarehouseDispatchImport({ cartons, disabled, onClose, onRefresh }: Props) {
  const [text, setText] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const commandKeys = useRef(new Map<string, string>());
  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); }; document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey); }, [busy, onClose]);
  const preview = useMemo(() => {
    try { return { rows: matchWarehouseNumbers(parseWarehouseNumbers(text), cartons), error: "" }; }
    catch (reason) { return { rows: [], error: reason instanceof Error ? reason.message : "Проверьте список." }; }
  }, [text, cartons]);
  const ready = preview.rows.filter(row => row.status === "ready" && row.box);
  const invalid = preview.rows.length - ready.length;
  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    setError(""); setChecked(false); setResult("");
    try {
      if (!file.name.toLocaleLowerCase("ru-RU").endsWith(".xlsx")) throw new Error("Выберите файл Excel .xlsx.");
      const numbers = await parseWarehouseWorkbook(await file.arrayBuffer());
      if (!numbers.length) throw new Error("В файле не найдены номера коробов.");
      setText(numbers.join("\n"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Ошибка чтения файла."); }
    finally { event.target.value = ""; }
  }
  async function submit() {
    if (disabled || busy || !checked || !ready.length) return;
    setBusy(true); setError(""); setResult("");
    try {
      const response = await fetch("/api/warehouse/dispatch/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cartons: ready.map(row => {
        const box = row.box!, fingerprint = warehouseCartonFingerprint(box), signature = JSON.stringify([box.id, box.shipmentId, fingerprint]);
        if (!commandKeys.current.has(signature)) commandKeys.current.set(signature, crypto.randomUUID());
        return { cartonId: box.id, shipmentId: box.shipmentId, fingerprint, commandKey: commandKeys.current.get(signature) };
      }) }) });
      const body = await response.json();
      if (!response.ok || body?.ok !== true || !Array.isArray(body.results)) throw new Error(body?.message || "Не удалось подтвердить отправку.");
      const sent = body.results.filter((entry: {status: string}) => entry.status === "sent").length;
      const already = body.results.filter((entry: {status: string}) => entry.status === "already_sent").length;
      const uncertain = body.results.filter((entry: {status: string}) => entry.status === "unconfirmed").length;
      setResult(`Отмечено отправленными: ${sent}. Уже были отправлены: ${already}.${uncertain ? ` Не подтверждено: ${uncertain}. Обновите склад и проверьте эти короба.` : ""}`);
      setChecked(false);
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error && reason.message !== "Failed to fetch" ? reason.message : "Ответ не получен. Обновите склад и проверьте статусы перед повтором.");
      setChecked(false);
      await onRefresh();
    } finally { setBusy(false); }
  }
  return <div className="wh-modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="wh-import" role="dialog" aria-modal="true" aria-labelledby="wh-import-title">
      <div className="wh-import-head"><div><small>ОТГРУЗКА КОРОБОВ</small><h2 id="wh-import-title">Загрузить отправленные</h2><p>Добавьте номера коробов, которые уже уехали.</p></div><button type="button" onClick={onClose} disabled={busy} aria-label="Закрыть">×</button></div>
      <label className="wh-import-label">Номера коробов<textarea ref={field} rows={5} value={text} disabled={busy} onChange={event => { setText(event.target.value); setChecked(false); setResult(""); }} placeholder={'По одному номеру в строке\nНапример: 1мос217'} /></label>
      <label className="wh-import-file">Или загрузите Excel (.xlsx)<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={event => void readFile(event)} /><small>Первый столбец или колонка «Номер короба» · до 500 строк</small></label>
      {(error || preview.error) && <p className="wh-import-error" role="alert">{error || preview.error}</p>}
      {result && <p className="wh-import-success" role="status">{result}</p>}
      {!checked ? <div className="wh-import-actions"><button type="button" className="wh-secondary" onClick={onClose} disabled={busy}>Отмена</button><button type="button" className="wh-primary" disabled={busy || disabled || !preview.rows.length || !!preview.error} onClick={() => setChecked(true)}>Проверить список</button></div> : <>
        <h3>Проверка списка</h3><p>{ready.length} можно отметить · {invalid} требуют внимания</p>
        <div className="wh-import-rows">{preview.rows.map((row, i) => <div key={`${row.number}:${i}`}><span><strong>{row.number}</strong>{row.corrected && <small style={{display:"block"}}>В базе: {row.box?.number}</small>}</span><span>{row.box?.shipment || "—"}{row.box?.archivedOrigin ? " · архив" : ""}</span><span className={row.status === "ready" ? "is-ready" : "is-review"} title={row.box?.issues?.join(" · ")}>{labels[row.status]}{row.status === "ready" && row.box?.issues.length ? " · есть замечания к составу" : ""}</span></div>)}</div>
        <div className="wh-import-actions"><button type="button" className="wh-secondary" onClick={() => setChecked(false)} disabled={busy}>Изменить список</button><button type="button" className="wh-primary" disabled={busy || disabled || !ready.length} onClick={() => void submit()}>{busy ? "Сохраняем…" : `Отметить отправленными · ${ready.length}`}</button></div>
      </>}
      {disabled && <p className="wh-import-error">Обновите данные склада перед сохранением.</p>}
    </section>
  </div>;
}
