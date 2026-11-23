import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button, Field, Modal } from "./ui";
import { WarehouseExportDeparture } from "./WarehouseExportDeparture";
import type { WarehouseCarton } from "./liveWarehouse";
import { warehouseCartonFingerprint } from "./warehouseFingerprint";
import type {
  Mapping,
  ExportRow,
  SavedWarehouseExport,
} from "./warehouseExcel";

const signature = (box: WarehouseCarton) =>
  warehouseCartonFingerprint(box) + "|" + (box.dispatchStatus || "pending");
export function useWarehouseSelection(boxes: WarehouseCarton[], scope: string) {
  const [selected, setSelected] = useState<Map<string, string>>(
    () => new Map(),
  );
  useEffect(() => setSelected(new Map()), [scope]);
  useEffect(() => {
    setSelected((previous) => {
      const next = new Map(
        [...previous].filter(([id, sig]) => {
          const box = boxes.find((b) => b.id === id);
          return !!box && signature(box) === sig;
        }),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [boxes]);
  const cartons = boxes.filter((b) => selected.get(b.id) === signature(b));
  const eligible = (box: WarehouseCarton) =>
    box.status === "closed" &&
    !box.sourceStale &&
    !box.dispatchBlocked &&
    !box.historicalSnapshotMissing &&
    (!box.archivedSourceUnavailable || box.dispatchStatus === "sent");
  const toggle = (box: WarehouseCarton) =>
    setSelected((previous) => {
      const next = new Map(previous);
      if (next.has(box.id)) next.delete(box.id);
      else if (eligible(box) && next.size < 100)
        next.set(box.id, signature(box));
      return next;
    });
  return {
    cartons,
    selected,
    eligible,
    toggle,
    clear: () => setSelected(new Map()),
    selectPage: (page: WarehouseCarton[]) =>
      setSelected((previous) => {
        const next = new Map(previous),
          rows = page.filter(eligible);
        const all = rows.length > 0 && rows.every((b) => next.has(b.id));
        for (const box of rows) {
          if (all) next.delete(box.id);
          else if (next.size < 100) next.set(box.id, signature(box));
        }
        return next;
      }),
  };
}
async function responseJson(response: Response) {
  const body = await response.json();
  if (!response.ok || body?.ok !== true)
    throw new Error(
      body?.message ||
        body?.error ||
        "Не удалось подтвердить операцию. Повторите после обновления.",
    );
  return body;
}
export function WarehouseSelectionActions({
  cartons,
  warehouseCartons,
  onRefresh,
  onClear,
}: {
  cartons: WarehouseCarton[];
  warehouseCartons: WarehouseCarton[];
  onRefresh: () => void | Promise<void>;
  onClear: () => void;
}) {
  const [mode, setMode] = useState<"template" | "send" | "history" | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [saved, setSaved] = useState<SavedWarehouseExport | null>(null),
    [file, setFile] = useState<ArrayBuffer | null>(null),
    [filename, setFilename] = useState(""),
    [sheets, setSheets] = useState<{ name: string; headers: string[] }[]>([]),
    [sheet, setSheet] = useState(""),
    [start, setStart] = useState("2"),
    [mapping, setMapping] = useState<Mapping>({}),
    [confirmed, setConfirmed] = useState(false),
    [checked, setChecked] = useState(false);
  const [history, setHistory] = useState<
    { id: string; created_at: string; carton_count: number; quantity: number }[]
  >([]);
  const [departure, setDeparture] = useState<SavedWarehouseExport | null>(null);
  const prepared = useRef<{ signature: string; key: string } | null>(null),
    sendKeys = useRef(new Map<string, string>());
  const currentSignature = JSON.stringify(
    cartons.map((b) => [b.id, signature(b)]).sort(),
  );
  useEffect(() => {
    setSaved(null);
    setChecked(false);
    setConfirmed(false);
  }, [currentSignature]);
  async function snapshot() {
    if (saved) return saved;
    if (!cartons.length) throw new Error("Выберите закрытые короба.");
    if (prepared.current?.signature !== currentSignature)
      prepared.current = {
        signature: currentSignature,
        key: crypto.randomUUID(),
      };
    const body = await responseJson(
      await fetch("/api/warehouse/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: prepared.current.key,
          cartons: cartons.map((b) => ({
            cartonId: b.id,
            fingerprint: warehouseCartonFingerprint(b),
            dispatchStatus: b.dispatchStatus || "pending",
          })),
        }),
      }),
    );
    setSaved(body.snapshot);
    return body.snapshot as SavedWarehouseExport;
  }
  async function account(selected?: SavedWarehouseExport) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = selected || (await snapshot()),
        excel = await import("./warehouseExcel");
      await excel.downloadWorkbook(
        excel.accountWorkbook(excel.exportSnapshot(value)),
        `РИТМ-короба-${value.id.slice(0, 8)}.xlsx`,
      );
      setNotice(
        "Excel скачан. Состав выгрузки сохранён, статусы отправки не изменены.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось скачать Excel.");
    } finally {
      setBusy(false);
    }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    setBusy(true);
    setError("");
    setChecked(false);
    try {
      if (!/\.xlsx$/i.test(selected.name))
        throw new Error("Выберите пустой шаблон .xlsx.");
      const buffer = await selected.arrayBuffer(),
        excel = await import("./warehouseExcel"),
        book = await excel.readTemplate(buffer);
      setFile(buffer);
      setFilename(selected.name);
      setSheets(
        book.worksheets.map((s) => ({
          name: s.name,
          headers: Array.from(
            { length: Math.max(s.columnCount, 10) },
            (_, i) => s.getCell(1, i + 1).text || `Колонка ${i + 1}`,
          ),
        })),
      );
      setSheet(book.worksheets[0]?.name || "");
      setMapping({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось прочитать шаблон.");
    } finally {
      event.target.value = "";
      setBusy(false);
    }
  }
  async function template(download = false) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const value = await snapshot(),
        excel = await import("./warehouseExcel");
      if (!mapping.carton)
        throw new Error(
          "Сопоставьте номер короба, количество и артикул либо штрихкод.",
        );
      const workbook = await excel.templateWorkbook(
        file,
        sheet,
        Number(start),
        mapping,
        excel.exportSnapshot(value),
      );
      if (download)
        await excel.downloadWorkbook(
          workbook,
          `РИТМ-шаблон-${value.id.slice(0, 8)}.xlsx`,
        );
      else setChecked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Проверьте шаблон.");
      setChecked(false);
    } finally {
      setBusy(false);
    }
  }
  async function send(chosen: WarehouseCarton[], fromHistory = false) {
    if (busy || !chosen.length || (!fromHistory && !confirmed)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const rows = chosen.map((box) => {
        const fingerprint = warehouseCartonFingerprint(box);
        const commandKey = sendKeys.current.get(fingerprint) ?? crypto.randomUUID();
        sendKeys.current.set(fingerprint, commandKey);
        return { cartonId: box.id, shipmentId: box.shipmentId, fingerprint, commandKey };
      });
      const body = await responseJson(
        await fetch("/api/warehouse/dispatch/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cartons: rows }),
        }),
      );
      if (!Array.isArray(body.results)) throw new Error("Статусы коробов не подтверждены.");
      const statuses = new Map<string, string>(
        body.results.map((result: { cartonId: string; status: string }) => [result.cartonId, result.status]),
      );
      let sent = 0, alreadySent = 0;
      for (const row of rows) {
        const status = statuses.get(row.cartonId);
        if (status === "sent") sent++;
        else if (status === "already_sent") alreadySent++;
        else continue;
        sendKeys.current.delete(row.fingerprint);
      }
      const failed = rows.length - sent - alreadySent;
      setNotice(
        `Отмечено отправленными · ${sent}${alreadySent ? ` · уже отправлены · ${alreadySent}` : ""}`,
      );
      if (failed) setError(`Коробов без подтверждения выезда · ${failed}. Проверьте их статус перед повтором.`);
      await onRefresh();
      if (!failed) {
        if (fromHistory) setDeparture(null);
        else {
          setMode(null);
          onClear();
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Отправка не подтверждена.");
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }
  async function loadHistory() {
    setMode("history");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setHistory(
        (
          await responseJson(
            await fetch("/api/warehouse/exports", { cache: "no-store" }),
          )
        ).exports,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "История недоступна.");
    } finally {
      setBusy(false);
    }
  }
  async function previous(id: string, markDeparture = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await responseJson(
        await fetch("/api/warehouse/exports?id=" + encodeURIComponent(id), {
          cache: "no-store",
        }),
      );
      if (!Array.isArray(body.snapshot?.cartons)) throw new Error("Состав выгрузки недоступен.");
      if (markDeparture) setDeparture(body.snapshot);
      else await account(body.snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Выгрузка недоступна.");
    } finally {
      setBusy(false);
    }
  }
  const canSend =
    cartons.length > 0 &&
    cartons.every(
      (b) =>
        b.dispatchStatus !== "sent" && b.status === "closed" && !b.reserved,
    );
  return (
    <div className="wh-selection">
      <div className="wh-selection-buttons">
        <strong>
          Выбрано: {cartons.length} ·{" "}
          {cartons.reduce((n, b) => n + b.quantity, 0).toLocaleString("ru-RU")}{" "}
          шт.
        </strong>
        <Button
          disabled={busy || !cartons.length}
          onClick={() => void account()}
        >
          Excel для учёта
        </Button>
        <Button
          disabled={busy || !cartons.length}
          onClick={() => {
            setMode("template");
            setError("");
            setChecked(false);
          }}
        >
          Для маркетплейса
        </Button>
        <Button
          kind="primary"
          disabled={busy || !canSend}
          onClick={() => {
            setMode("send");
            setError("");
            setConfirmed(false);
          }}
        >
          Отметить выезд
        </Button>
        <Button disabled={busy} onClick={() => void loadHistory()}>
          История Excel
        </Button>
        {cartons.length > 0 && (
          <Button disabled={busy} onClick={onClear}>
            Снять выбор
          </Button>
        )}
      </div>
      {!mode && error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!mode && notice && <p role="status">{notice}</p>}
      <Modal
        open={mode !== null}
        onClose={() => {
          if (!busy) {
            setMode(null);
            setDeparture(null);
          }
        }}
        title={
          mode === "send"
            ? "Подтвердить выезд коробов"
            : departure
              ? "Отметить выезд по выгрузке"
              : mode === "history"
              ? "Сохранённые выгрузки"
              : "Excel по шаблону маркетплейса"
        }
        description={
          mode === "send"
            ? "Статус изменится в РИТМ и «RITM Сборка». Перед сохранением проверим состав каждого короба."
            : departure
              ? "Проверьте список и оставьте галочки у коробов, которые фактически уехали."
              : "Скачивание Excel не отправляет короба."
        }
      >
        {departure ? (
          <WarehouseExportDeparture
            snapshot={departure}
            warehouseCartons={warehouseCartons}
            busy={busy}
            onBack={() => {
              setDeparture(null);
              setError("");
            }}
            onSend={(chosen) => void send(chosen, true)}
          />
        ) : mode === "history" ? (
          <div className="wh-export-list wh-export-history">
            {history.map((row) => (
              <div key={row.id}>
                <span>
                  {new Date(row.created_at).toLocaleString("ru-RU", {
                    timeZone: "Europe/Moscow",
                  })}{" "}
                  · {row.carton_count} коробов · {row.quantity} шт.
                </span>
                <div className="wh-export-actions">
                  <Button disabled={busy} onClick={() => void previous(row.id)}>
                    Скачать учёт
                  </Button>
                  <Button kind="primary" disabled={busy} onClick={() => void previous(row.id, true)}>
                    Отметить выезд
                  </Button>
                </div>
              </div>
            ))}
            {!history.length && !busy && <p>Сохранённых выгрузок пока нет.</p>}
          </div>
        ) : (
          <>
            <div className="wh-export-list">
              {cartons.slice(0, 20).map((box) => (
                <div key={box.id}>
                  <strong>{box.number}</strong>
                  <span>{box.shipment}</span>
                  <b>{box.quantity} шт.</b>
                </div>
              ))}
              {cartons.length > 20 && (
                <p>Ещё {cartons.length - 20} коробов в выборе.</p>
              )}
            </div>
            {mode === "send" ? (
              <>
                <label className="wh-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    disabled={busy}
                  />
                  Подтверждаю: эти короба фактически уехали.
                </label>
                <Button
                  kind="primary"
                  disabled={busy || !confirmed || !canSend}
                  onClick={() => void send(cartons)}
                >
                  {busy ? "Сохраняем…" : "Отметить отправленными"}
                </Button>
              </>
            ) : (
              <div className="wh-template-form">
                <p>
                  Загрузите актуальный пустой шаблон из кабинета маркетплейса и
                  сопоставьте колонки. Номера коробов «RITM Сборка» не заменяют
                  назначенные маркетплейсом штрихкоды грузомест.
                </p>
                <Field label="Пустой шаблон .xlsx">
                  <input
                    type="file"
                    accept=".xlsx"
                    onChange={(e) => void upload(e)}
                    disabled={busy}
                  />
                </Field>
                {file && (
                  <>
                    <p>{filename}</p>
                    <Field label="Лист шаблона">
                      <select
                        value={sheet}
                        onChange={(e) => {
                          setSheet(e.target.value);
                          setChecked(false);
                        }}
                      >
                        {sheets.map((s) => (
                          <option key={s.name}>{s.name}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Первая строка данных">
                      <input
                        type="number"
                        min="2"
                        max="1000"
                        value={start}
                        onChange={(e) => {
                          setStart(e.target.value);
                          setChecked(false);
                        }}
                      />
                    </Field>
                    {(
                      ["carton", "sku", "barcode", "qty"] as (keyof ExportRow)[]
                    ).map((field) => (
                      <Field
                        key={field}
                        label={
                          field === "carton"
                            ? "Номер короба «RITM Сборка»"
                            : field === "sku"
                              ? "Артикул"
                              : field === "barcode"
                                ? "Штрихкод товара"
                                : "Количество"
                        }
                      >
                        <select
                          value={mapping[field] || ""}
                          onChange={(e) => {
                            setMapping({
                              ...mapping,
                              [field]: Number(e.target.value) || undefined,
                            });
                            setChecked(false);
                          }}
                        >
                          <option value="">Не переносить</option>
                          {sheets
                            .find((s) => s.name === sheet)
                            ?.headers.map((header, i) => (
                              <option key={i} value={i + 1}>
                                {i + 1} · {header}
                              </option>
                            ))}
                        </select>
                      </Field>
                    ))}
                    <Button disabled={busy} onClick={() => void template()}>
                      Проверить шаблон
                    </Button>
                    {checked && saved && (
                      <>
                        <p role="status">
                          Проверено: {saved.cartons.length} коробов. Данные
                          заполнят только выбранные пустые колонки.
                        </p>
                        <div className="wh-scroll"><table className="wh-table"><caption>Предпросмотр первых 10 строк</caption><thead><tr><th>Короб «RITM Сборка»</th><th>Артикул</th><th>Штрихкод</th><th>Количество</th></tr></thead><tbody>{saved.cartons.flatMap(box=>box.contents.map(item=>({box:box.number,...item}))).slice(0,10).map((row,i)=><tr key={i}><td>{row.box}</td><td>{row.article}</td><td>{mapping.barcode?row.barcode:'Не переносится'}</td><td>{row.quantity}</td></tr>)}</tbody></table></div>
                        <Button
                          kind="primary"
                          disabled={busy}
                          onClick={() => void template(true)}
                        >
                          Скачать заполненный шаблон
                        </Button>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
        {busy && <p role="status">Подготавливаем данные…</p>}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </Modal>
    </div>
  );
}
