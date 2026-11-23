import { useMemo, useState } from "react";
import type { WarehouseCarton } from "./liveWarehouse";
import { Button } from "./ui";
import type { SavedWarehouseExport } from "./warehouseExcel";
import { warehouseCartonFingerprint } from "./warehouseFingerprint";

function departureIssue(saved: WarehouseCarton, current?: WarehouseCarton) {
  if (!current) return "Короб не найден на складе";
  if (current.dispatchStatus === "sent") return "Уже отправлен";
  if (current.reserved) return "В подготовленной отгрузке";
  if (current.status === "open") return "Короб открыт";
  if (
    current.status !== "closed" ||
    current.archivedSourceUnavailable ||
    current.dispatchBlocked ||
    current.sourceStale ||
    current.historicalSnapshotMissing
  ) return "Требуется сверка на складе";
  return warehouseCartonFingerprint(saved) === warehouseCartonFingerprint(current)
    ? ""
    : "Состав изменился после выгрузки";
}

export function WarehouseExportDeparture({
  snapshot,
  warehouseCartons,
  busy,
  onBack,
  onSend,
}: {
  snapshot: SavedWarehouseExport;
  warehouseCartons: WarehouseCarton[];
  busy: boolean;
  onBack: () => void;
  onSend: (cartons: WarehouseCarton[]) => void;
}) {
  const rows = useMemo(() => {
    const current = new Map(warehouseCartons.map((box) => [box.id, box]));
    return snapshot.cartons.map((box) => ({
      box,
      issue: departureIssue(box, current.get(box.id)),
    }));
  }, [snapshot, warehouseCartons]);
  const available = rows.filter((row) => !row.issue);
  const [selected, setSelected] = useState(
    () => new Set(available.map(({ box }) => box.id)),
  );
  const chosen = available
    .filter(({ box }) => selected.has(box.id))
    .map(({ box }) => box);
  const date = new Date(snapshot.createdAt).toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
  });

  function toggle(id: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <div className="wh-export-departure">
      <p className="muted">Выгрузка от {date} МСК</p>
      <div className="wh-export-actions">
        <Button
          disabled={busy || chosen.length === available.length}
          onClick={() => setSelected(new Set(available.map(({ box }) => box.id)))}
        >
          Выбрать все
        </Button>
        <Button disabled={busy || !chosen.length} onClick={() => setSelected(new Set())}>
          Снять выбор
        </Button>
        <strong aria-live="polite">Выбрано {chosen.length} из {available.length} доступных</strong>
      </div>
      <div className="wh-export-list wh-departure-list" role="group" aria-label="Короба из выгрузки">
        {rows.map(({ box, issue }) => (
          <label key={box.id} className={issue ? "wh-departure-unavailable" : ""}>
            <input
              type="checkbox"
              checked={!issue && selected.has(box.id)}
              disabled={busy || !!issue}
              onChange={(event) => toggle(box.id, event.target.checked)}
            />
            <span>
              <strong>{box.number}</strong>
              <small>{box.shipment}</small>
              {issue && <small>{issue}</small>}
            </span>
            <b>{box.quantity.toLocaleString("ru-RU")} шт.</b>
          </label>
        ))}
      </div>
      <div className="modal-actions">
        <Button disabled={busy} onClick={onBack}>К истории Excel</Button>
        <Button
          kind="primary"
          disabled={busy || !chosen.length}
          onClick={() => onSend(chosen)}
        >
          {busy ? "Сохраняем…" : `Отметить отправленными · ${chosen.length}`}
        </Button>
      </div>
    </div>
  );
}
