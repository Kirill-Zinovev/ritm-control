import { useState, type ChangeEvent } from "react";
import type { Dispatch, ExportSnapshot } from "../../shared/model";
import { countLabel, dateTime, number } from "../../shared/model";
import type { Workspace } from "../useWorkspace";
import { request } from "../useWorkspace";
import { Button, Dialog, Field, NativeSelect } from "../ui";
import {
  accountWorkbook,
  downloadWorkbook,
  flatten,
  mappingLabels,
  readTemplate,
  templateWorkbook,
  type ExportRow,
  type Mapping,
} from "./excel";
export default function ExportDialog({
  dispatch: d,
  workspace: w,
  title,
  onClose,
}: {
  dispatch: Dispatch;
  workspace: Workspace;
  title?: string;
  onClose(): void;
}) {
  const [snapshot, setSnapshot] = useState<ExportSnapshot | null>(null);
  const [kind, setKind] = useState<"account" | "template">("account");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [filename, setFilename] = useState("");
  const [sheets, setSheets] = useState<{ name: string; headers: string[] }[]>(
    [],
  );
  const [sheet, setSheet] = useState("");
  const [start, setStart] = useState("2");
  const [mapping, setMapping] = useState<Mapping>({});
  const [templateReady, setTemplateReady] = useState(false);
  const history = w.state?.exports.filter((e) => e.dispatchId === d.id) ?? [];
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const r = await w.command(
        "export.create",
        { dispatchId: d.id, kind },
        "Состав выгрузки сохранён. Статус отправки не изменился.",
      );
      setSnapshot(await request<ExportSnapshot>(`/api/exports/${r.exportId}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadSaved(id: string) {
    setBusy(true);
    setError("");
    try {
      setSnapshot(await request<ExportSnapshot>(`/api/exports/${id}`));
      setTemplateReady(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    setTemplateReady(false);
    try {
      if (!/\.xlsx$/i.test(file.name))
        throw new Error("Загрузите шаблон .xlsx.");
      const data = await file.arrayBuffer();
      const book = await readTemplate(data);
      setBuffer(data);
      setFilename(file.name);
      setSheets(
        book.worksheets.map((s) => ({
          name: s.name,
          headers: Array.from({ length: Math.max(s.columnCount, 10) }, (_, i) =>
            String(s.getCell(1, i + 1).text || `Колонка ${i + 1}`),
          ),
        })),
      );
      setSheet(book.worksheets[0]?.name ?? "");
      setMapping({});
    } catch (e) {
      setError((e as Error).message);
    }
    event.target.value = "";
  }
  async function validate() {
    if (!buffer || !snapshot) return;
    setBusy(true);
    setError("");
    try {
      await templateWorkbook(buffer, sheet, Number(start), mapping, snapshot);
      setTemplateReady(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    if (!snapshot) return;
    setBusy(true);
    setError("");
    try {
      const workbook =
        kind === "account"
          ? accountWorkbook(snapshot)
          : buffer
            ? await templateWorkbook(
                buffer,
                sheet,
                Number(start),
                mapping,
                snapshot,
              )
            : null;
      if (!workbook) throw new Error("Сначала загрузите шаблон.");
      await downloadWorkbook(
        workbook,
        `${d.label}-${kind === "account" ? "учёт" : "шаблон"}-${snapshot.id.slice(0, 8)}.xlsx`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const rows = snapshot ? flatten(snapshot) : [];
  return (
    <Dialog title={title ?? `Excel · ${d.label}`} onClose={onClose}>
      <div className="stack">
        <p>
          {d.market} · {d.store} · {d.destination}
        </p>
        <p className="muted">
          Скачивание файла не отмечает короба отправленными. Состав выгрузки
          сохраняется отдельно.
        </p>
        <div className="tabs">
          <button
            type="button"
            className="tab"
            aria-pressed={kind === "account"}
            onClick={() => setKind("account")}
          >
            Для учёта
          </button>
          <button
            type="button"
            className="tab"
            aria-pressed={kind === "template"}
            onClick={() => setKind("template")}
          >
            По шаблону маркетплейса
          </button>
        </div>
        {!snapshot ? (
          <>
            <p>
              {countLabel(d.cartonIds.length, ["короб", "короба", "коробов"])} ·{" "}
              {number(d.qty)} шт.
            </p>
            <Button
              primary
              disabled={busy || w.busy}
              onClick={() => void prepare()}
            >
              Подготовить выгрузку
            </Button>
          </>
        ) : (
          <>
            <div className="callout">
              <strong>Снимок от {dateTime(snapshot.createdAt)} МСК</strong>
              <p>
                {countLabel(snapshot.payload.cartons.length, [
                  "короб",
                  "короба",
                  "коробов",
                ])}{" "}
                · {number(rows.reduce((n, r) => n + r.qty, 0))} шт. ·{" "}
                {countLabel(rows.length, [
                  "строка состава",
                  "строки состава",
                  "строк состава",
                ])}
              </p>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Короб</th>
                    <th>Артикул</th>
                    <th>Штрихкод</th>
                    <th>Количество</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 30).map((r, i) => (
                    <tr key={i}>
                      <td>{r.carton}</td>
                      <td>{r.sku}</td>
                      <td>{r.barcode || "—"}</td>
                      <td>{number(r.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 30 ? (
              <p className="muted">
                Показаны первые 30 строк; в файле будут все {rows.length}.
              </p>
            ) : null}
            {kind === "account" ? (
              <p className="muted">
                Excel: листы «Короба», «Состав», «Сводка». Штрихкоды и исходные
                ID сохраняются текстом.
              </p>
            ) : (
              <div className="stack">
                <p className="callout">
                  Загрузите ваш актуальный пустой шаблон WB или Ozon и
                  сопоставьте поля. Номер короба RITM Сборка является внутренним:
                  если кабинет требует собственный штрихкод короба, его нужно
                  получить отдельно. Совместимость с кабинетом подтверждается
                  проверкой вашего шаблона.
                </p>
                <label className="label upload">
                  Пустой шаблон .xlsx
                  <input
                    type="file"
                    accept=".xlsx"
                    onChange={(e) => void upload(e)}
                  />
                </label>
                {filename ? <p className="muted">{filename}</p> : null}
                {buffer ? (
                  <>
                    <NativeSelect
                      label="Лист шаблона"
                      value={sheet}
                      onChange={(e) => {
                        setSheet(e.target.value);
                        setTemplateReady(false);
                      }}
                    >
                      {sheets.map((s) => (
                        <option key={s.name}>{s.name}</option>
                      ))}
                    </NativeSelect>
                    <Field
                      label="Первая строка для данных"
                      type="number"
                      min="2"
                      max="1000"
                      value={start}
                      onChange={(e) => {
                        setStart(e.target.value);
                        setTemplateReady(false);
                      }}
                    />
                    <div className="mapping">
                      {Object.entries(mappingLabels).map(([key, label]) => (
                        <NativeSelect
                          key={key}
                          label={label}
                          value={mapping[key as keyof ExportRow] ?? ""}
                          onChange={(e) => {
                            setMapping((m) => ({
                              ...m,
                              [key]: e.target.value
                                ? Number(e.target.value)
                                : undefined,
                            }));
                            setTemplateReady(false);
                          }}
                        >
                          <option value="">Не заполнять</option>
                          {sheets
                            .find((s) => s.name === sheet)
                            ?.headers.map((h, i) => (
                              <option key={i} value={i + 1}>
                                {i + 1}. {h}
                              </option>
                            ))}
                        </NativeSelect>
                      ))}
                    </div>
                    <Button disabled={busy} onClick={() => void validate()}>
                      Проверить заполнение шаблона
                    </Button>
                    {templateReady ? (
                      <p className="success-text">
                        Проверка заполнения прошла. Заголовки и остальные листы
                        сохранятся.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            )}
            <Button
              primary
              disabled={busy || (kind === "template" && !templateReady)}
              onClick={() => void download()}
            >
              {busy
                ? "Готовим файл…"
                : kind === "account"
                  ? "Скачать Excel для учёта"
                  : "Скачать заполненный шаблон"}
            </Button>
          </>
        )}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        {history.length ? (
          <details>
            <summary>Сохранённые выгрузки · {history.length}</summary>
            <div className="stack">
              {history.map((e) => (
                <Button
                  key={e.id}
                  disabled={busy}
                  onClick={() => void loadSaved(e.id)}
                >
                  {dateTime(e.createdAt)} МСК ·{" "}
                  {e.kind === "account" ? "Учёт" : "Шаблон"} · открыть снимок
                </Button>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </Dialog>
  );
}
