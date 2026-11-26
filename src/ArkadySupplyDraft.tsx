import { useRef, useState, type FormEvent } from "react";
import { FileSpreadsheet } from "lucide-react";
import {
  formatSupplyLines,
  prepareSupplyDraft,
  readSupplyFile,
} from "./supplySpreadsheet";
import { Button, Field, Notice } from "./ui";

export type ArkadySupplyDraftInput = { text: string; fileName: string };

export function ArkadySupplyDraft({
  onPrepare,
}: {
  onPrepare: (draft: ArkadySupplyDraftInput) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");

  async function read(file?: File) {
    if (!file || reading) return;
    setReading(true);
    setError("");
    try {
      setText(formatSupplyLines(await readSupplyFile(file)));
      setFileName(file.name);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось прочитать файл.",
      );
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reading) return;
    setError("");
    try {
      onPrepare({ text: prepareSupplyDraft(text), fileName });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Проверьте список товаров.",
      );
    }
  }

  return (
    <form className="arkady-assistant__card" onSubmit={prepare}>
      <h3>Черновик поставки</h3>
      <p>
        Загрузите Excel или вставьте список. В форме поставки можно указать
        сроки и проверить распределение.
      </p>
      <div className="arkady-assistant__actions">
        <Button
          type="button"
          disabled={reading}
          onClick={() => fileInput.current?.click()}
        >
          <FileSpreadsheet size={16} />
          {reading ? "Читаю Excel…" : "Загрузить Excel"}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".xlsx"
          hidden
          onChange={(event) => void read(event.currentTarget.files?.[0])}
        />
      </div>
      {fileName && <p role="status">{fileName}</p>}
      <Field label="Артикулы и количество">
        <textarea
          rows={5}
          value={text}
          disabled={reading}
          placeholder="ST0021.A7447; 50"
          onChange={(event) => {
            setText(event.target.value);
            setFileName("");
            setError("");
          }}
        />
      </Field>
      {error && <Notice tone="warning">{error}</Notice>}
      <div className="arkady-assistant__actions">
        <Button type="submit" kind="primary" disabled={reading || !text.trim()}>
          Открыть черновик поставки
        </Button>
      </div>
    </form>
  );
}
