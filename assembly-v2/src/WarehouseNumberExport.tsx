import { useState, type FormEvent } from "react";
import { Download } from "lucide-react";
import type { WarehouseNumberPreview, WarehousePage } from "../shared/warehouse";
import { request } from "./useWorkspace";
import { Button, Dialog } from "./ui";

export async function downloadWarehouseCartons(params: URLSearchParams, order?: readonly string[]) {
  const { cartons } = await request<WarehousePage>(`/api/warehouse?${params}`);
  const { warehouseWorkbook, downloadWorkbook } = await import("./exports/excel");
  if (order) {
    const index = new Map(order.map((id, i) => [id, i]));
    cartons.sort((a, b) => (index.get(a.id) ?? order.length) - (index.get(b.id) ?? order.length));
  }
  const at = new Date().toISOString();
  await downloadWorkbook(warehouseWorkbook(cartons, at), `Запас-на-складе-${at.slice(0, 10)}.xlsx`);
}

export function WarehouseNumberExport({ onClose }: { onClose(): void }) {
  const [numbers, setNumbers] = useState("");
  const [preview, setPreview] = useState<WarehouseNumberPreview | null>(null);
  const [busy, setBusy] = useState<"search" | "download" | null>(null);
  const [error, setError] = useState("");
  const found = preview?.cartons.length ?? 0;

  async function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !numbers.trim()) return;
    setPreview(null);
    setError("");
    setBusy("search");
    try {
      setPreview(await request<WarehouseNumberPreview>("/api/warehouse/number-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ numbers }),
      }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    if (busy || !preview?.cartons.length) return;
    setBusy("download");
    setError("");
    try {
      const ids = preview.cartons.map(box => box.id);
      await downloadWarehouseCartons(new URLSearchParams({ export: JSON.stringify(ids) }), ids);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog title="Скачать состав по номерам" busy={busy !== null} onClose={onClose} initialFocusId="warehouse-number-list">
      <form className="stack" onSubmit={find}>
        <div className="field-wrap">
          <label className="label" htmlFor="warehouse-number-list">Номера складских коробов</label>
          <textarea id="warehouse-number-list" className="field" rows={5} spellCheck={false}
            placeholder={"1скл11\n1скл10"} value={numbers} disabled={busy !== null} aria-describedby="warehouse-number-help"
            onChange={event => { setNumbers(event.target.value); setPreview(null); setError(""); }} />
          <span id="warehouse-number-help" className="muted">Разделяйте номера новой строкой, пробелом или запятой.</span>
        </div>
        {preview && <>
          <p role="status"><strong>Найдено {found} из {found + preview.issues.length}</strong></p>
          {!!found && <div className="table-scroll">
            <table>
              <thead><tr><th scope="col">Короб</th><th scope="col">Маркетплейс и магазин</th><th scope="col">Статус</th></tr></thead>
              <tbody>{preview.cartons.map(box => (
                <tr key={box.id}><td><strong>{box.label}</strong></td>
                  <td>{box.market} · Магазин {box.store}</td>
                  <td>{box.state === "open" ? "Открыт" : "Закрыт"}</td></tr>
              ))}</tbody>
            </table>
          </div>}
          {!!preview.issues.length && <ul>
            {preview.issues.map(({ label, reason }) => (
              <li key={label}><strong>{label}</strong> · {reason === "missing"
                ? "Короб не найден. Проверьте номер."
                : "Несколько коробов с этим номером. Отметьте нужный в таблице склада."}</li>
            ))}
          </ul>}
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <Button type="submit" primary={!found} disabled={busy !== null || !numbers.trim()}>
            {busy === "search" ? "Ищем короба…" : "Найти короба"}
          </Button>
          {!!found && <Button primary disabled={busy !== null} onClick={() => void download()}>
            <Download size={16} aria-hidden="true" />
            {busy === "download" ? "Готовим Excel…" : preview?.issues.length ? "Скачать найденные в Excel" : "Скачать Excel"}
          </Button>}
        </div>
      </form>
    </Dialog>
  );
}
