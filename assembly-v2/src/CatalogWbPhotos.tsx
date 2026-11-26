import { useState, type ChangeEvent } from "react";
import { catalogWbPhotoBatchSize, type CatalogWbPhoto, type CatalogWbPhotoResult } from "../shared/catalog-wb-photo";
import { catalogRequest } from "./catalog-client";
import { Button, Dialog, Field } from "./ui";

export function CatalogWbPhotos({ importId, onClose, onSaved }: {
  importId: string;
  onClose: () => void;
  onSaved: (rows: CatalogWbPhotoResult[]) => void;
}) {
  const [entries, setEntries] = useState<CatalogWbPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [error, setError] = useState("");

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setEntries([]);
    setCompleted(0);
    setError("");
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error();
      const input = JSON.parse(await file.text());
      if (!Array.isArray(input) || !input.length || input.length > 2000 ||
        !input.every((item: CatalogWbPhoto) => typeof item?.sku === "string" && typeof item.photoUrl === "string"))
        throw new Error();
      setEntries(input);
    } catch {
      setError("Выберите JSON со списком артикулов и ссылок на фото WB весом до 1 МБ.");
    }
  }

  async function save() {
    if (!entries.length || busy) return;
    setBusy(true);
    setError("");
    const saved: CatalogWbPhotoResult[] = [];
    try {
      for (let start = 0; start < entries.length; start += catalogWbPhotoBatchSize) {
        const batch = entries.slice(start, start + catalogWbPhotoBatchSize);
        const response = await catalogRequest<{ result: { rows: CatalogWbPhotoResult[] } }>("/api/command", {
          action: "catalog.importWbPhotos", key: crypto.randomUUID(), payload: { importId, entries: batch },
        });
        if (response.result?.rows?.length !== batch.length)
          throw new Error("Не удалось подтвердить загрузку пакета.");
        saved.push(...response.result.rows);
        setCompleted(saved.length);
      }
      onSaved(saved);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Не удалось сохранить фото.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Загрузить фото WB" onClose={onClose} busy={busy} className="catalog-dialog">
      <p className="muted">Фото добавляются по артикулу и магазину. Для новых товаров создаются карточки WB.</p>
      <Field type="file" accept=".json,application/json" label="Список артикулов и ссылок" disabled={busy} onChange={choose} />
      {entries.length > 0 && <p role="status">Проверено строк {completed} из {entries.length}.</p>}
      {error && <p className="status-error" role="alert">{error}</p>}
      <div className="actions">
        <Button primary disabled={!entries.length || busy} onClick={() => void save()}>
          {busy ? "Загрузка…" : "Сохранить фото"}
        </Button>
      </div>
    </Dialog>
  );
}
