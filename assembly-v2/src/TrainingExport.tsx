import { useState } from "react";
import { Download, Package } from "lucide-react";
import type { Carton } from "../shared/model";
import { Button } from "./ui";

const exampleBoxes = [
  { label: "УЧЕБНЫЙ-01", quantity: 24 },
  { label: "УЧЕБНЫЙ-02", quantity: 16 },
];
const exampleDate = "2026-11-20T09:00:00.000Z";

function cartonExample(label: string, qty: number): Carton {
  return {
    id: label,
    label,
    market: "OZON",
    store: "1",
    destination: "Учебный склад",
    state: "closed",
    dispatchId: "training",
    dispatchState: "draft",
    createdAt: exampleDate,
    closedAt: exampleDate,
    fill: qty / 40,
    qty,
    items: [
      {
        id: label + "-row",
        positionId: label + "-position",
        supplyId: "training",
        supply: "Учебная поставка",
        externalSupplyId: "",
        externalPositionId: "",
        sku: "TRAIN-001",
        name: "Учебный товар",
        barcode: "",
        qty,
        unitsPerBox: 40,
      },
    ],
  };
}

export function TrainingExport({ onDownloaded }: { onDownloaded: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = exampleBoxes.filter(({ label }) => selected.includes(label));

  async function download() {
    if (!chosen.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const { accountWorkbook, downloadWorkbook } =
        await import("./exports/excel");
      const workbook = accountWorkbook({
        createdAt: exampleDate,
        payload: {
          cartons: chosen.map(({ label, quantity }) =>
            cartonExample(label, quantity),
          ),
          dispatch: { label: "Учебная отгрузка" },
        },
      });
      await downloadWorkbook(
        workbook,
        "RITM Сборка — учебный состав коробов.xlsx",
      );
      onDownloaded();
    } catch {
      setError("Не удалось подготовить учебный Excel. Попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="av2-export">
      <fieldset disabled={busy}>
        <legend>Выберите учебные короба</legend>
        {exampleBoxes.map(({ label, quantity }) => (
          <label key={label} className="av2-export-box">
            <input
              type="checkbox"
              checked={selected.includes(label)}
              onChange={(event) => {
                setSelected(
                  event.target.checked
                    ? [...selected, label]
                    : selected.filter((id) => id !== label),
                );
              }}
            />
            <Package size={18} aria-hidden="true" />
            <strong>{label}</strong>
            <span>{quantity} шт.</span>
          </label>
        ))}
      </fieldset>
      <div className="av2-export-actions">
        <span aria-live="polite">
          Выбрано {chosen.length} из {exampleBoxes.length} ·{" "}
          {chosen.reduce((sum, box) => sum + box.quantity, 0)} шт.
        </span>
        <Button
          primary
          disabled={!chosen.length || busy}
          onClick={() => void download()}
        >
          <Download size={17} aria-hidden="true" />{" "}
          {busy ? "Готовим файл…" : "Скачать учебный Excel"}
        </Button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
