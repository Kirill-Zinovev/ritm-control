import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { Download, FileSpreadsheet, Plus, RefreshCw, ScanBarcode, Upload } from "lucide-react";
import { countLabel, dateTime, number } from "../shared/model";
import {
  ozonArticle, ozonProductBarcodes, readOzonCargoCodes, summarizeOzonProducts,
  type OzonBatch, type OzonBatchSummary, type OzonGroup, type OzonPreview,
} from "../shared/ozon-shipment";
import { Button, Dialog, Empty } from "./ui";
import { request, type Workspace } from "./useWorkspace";
import "./ozon-shipments.css";

const shipmentPath = "/api/ozon/shipments";
const readBatch = (id: string, signal?: AbortSignal) =>
  request<OzonBatch>(shipmentPath + "?id=" + encodeURIComponent(id), { signal });
const readBatches = (signal?: AbortSignal) => request<{ batches: OzonBatchSummary[] }>(shipmentPath, { signal });
const message = (error: unknown) => error instanceof Error ? error.message : "Операция не выполнена. Повторите запрос.";

export default function OzonShipments({ workspace }: { workspace: Workspace }) {
  const [creating, setCreating] = useState(false);
  const [numbers, setNumbers] = useState("");
  const [preview, setPreview] = useState<OzonPreview | null>(null);
  const [clusters, setClusters] = useState<Record<string, string>>({});
  const [batches, setBatches] = useState<OzonBatchSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [batch, setBatch] = useState<OzonBatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const disabled = busy || loading || workspace.busy;

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const data = await readBatches(abort.signal);
        if (abort.signal.aborted) return;
        setBatches(data.batches);
        const first = data.batches[0]?.id;
        if (first) {
          setSelectedId(first);
          const saved = await readBatch(first, abort.signal);
          if (!abort.signal.aborted) setBatch(saved);
        }
      } catch (error) {
        if (!abort.signal.aborted) setError(message(error));
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();
    return () => abort.abort();
  }, []);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await task(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function load(id: string) {
    const saved = await readBatch(id);
    setBatch(saved);
    setSelectedId(saved.id);
  }
  async function refresh() {
    const { batches } = await readBatches();
    setBatches(batches);
    const id = batches.find((item) => item.id === selectedId)?.id ?? batches[0]?.id;
    if (id) await load(id);
    else {
      setSelectedId("");
      setBatch(null);
    }
  }
  async function find() {
    const data = await request<OzonPreview>("/api/ozon/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ numbers }),
    });
    setPreview(data);
    setClusters(Object.fromEntries(data.groups.map((group) => [group.key, group.cluster])));
  }
  const preparedBoxes = preview?.groups.flatMap((group) => group.boxes) ?? [];
  const openCount = preparedBoxes.filter((box) => box.state === "open").length;
  async function prepare() {
    if (!preview || preview.issues.length) return;
    const result = await workspace.command("ozon.prepare", {
      boxes: preview.groups.flatMap((group) => group.boxes.map((box) => ({
        id: box.id, proof: box.proof, cluster: clusters[group.key],
      }))),
    }, "Состав заявок Ozon сохранён.");
    setNumbers("");
    setPreview(null);
    setCreating(false);
    await load(String(result.batchId));
    setBatches((await readBatches()).batches);
  }
  async function assign(group: OzonGroup, codes: string[]) {
    setBusy(true);
    setError("");
    try {
      await workspace.command("ozon.assign", {
        dispatchId: group.dispatch.id, previousLabelId: group.labels?.id ?? null, codes,
      }, "Пары коробов и грузомест сохранены.");
      try {
        await load(group.batchId);
        setBatches((await readBatches()).batches);
      } catch {
        setError("Пары сохранены. Нажмите «Обновить», чтобы загрузить актуальные данные.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ozon-shipments">
      <header className="ozon-page-head">
        <h1>Отгрузки Ozon</h1>
        <div className="ozon-actions">
          <Button className="ozon-refresh" disabled={disabled} aria-label="Обновить"
            title="Обновить" onClick={() => void run(refresh)}><RefreshCw size={17} /></Button>
          <Button disabled={disabled || !batch} onClick={() => void run(async () => {
            if (batch) await (await import("./exports/ozon-excel")).downloadOzonControl(batch);
          })}><Download size={18} />Контрольный Excel</Button>
          <Button primary disabled={disabled} onClick={() => {
            setError("");
            setCreating(true);
          }}><Plus size={20} />Новая подготовка</Button>
        </div>
      </header>

      {creating && <Dialog title="Подготовить состав заявки" className="ozon-prepare-dialog"
        initialFocusId="ozon-box-numbers" busy={disabled} onClose={() => {
          setCreating(false);
          setError("");
        }}>
        <p className="muted">Вставьте номера коробов поставок RITM по одному на строку или через запятую.</p>
        <label className="ozon-field">
          Номера коробов
          <textarea
            id="ozon-box-numbers"
            className="field"
            rows={3}
            value={numbers}
            disabled={disabled}
            placeholder={"1мос260\n1мос258"}
            onChange={(event) => { setNumbers(event.target.value); setPreview(null); }}
          />
        </label>
        <Button primary disabled={disabled || !numbers.trim()} onClick={() => void run(find)}>Найти короба</Button>
        {error && <p className="field-error" role="alert">{error}</p>}
        {preview && (
          <div className="ozon-preview">
            {preview.issues.length > 0 && <ul className="field-error" aria-label="Короба для проверки">
              {preview.issues.map(({ label, reason }) => <li key={label}>{label} · {reason}</li>)}
            </ul>}
            {preview.groups.map((group) => (
              <div className="ozon-preview-group" key={group.key}>
                <div>
                  <strong>{group.city} · магазин {group.store}</strong>
                  <p className="muted">{countLabel(group.boxes.length, ["короб", "короба", "коробов"])} · {number(group.boxes.reduce((qty, box) => qty + box.qty, 0))} шт.</p>
                  <details>
                    <summary>Номера коробов</summary>
                    <p>{group.boxes.map((box) => box.label + (box.state === "open" ? " (открыт)" : "")).join(", ")}</p>
                  </details>
                </div>
                <label className="ozon-field">
                  Кластер Ozon
                  <input className="field" value={clusters[group.key] ?? ""} maxLength={120} disabled={disabled}
                    onChange={(event) => setClusters({ ...clusters, [group.key]: event.target.value })} />
                </label>
              </div>
            ))}
            {!!preparedBoxes.length && (
              <div className="ozon-actions">
                <Button primary disabled={disabled || !!preview.issues.length ||
                  preview.groups.some((group) => !clusters[group.key]?.trim())}
                  onClick={() => void run(prepare)}>Подготовить состав</Button>
                {openCount > 0 && <small className="muted">При подготовке будут закрыты открытые короба из списка · {openCount}</small>}
              </div>
            )}
          </div>
        )}
      </Dialog>}

      {!creating && error && <p className="field-error" role="alert">{error}</p>}
      {loading ? <p role="status">Загружаем отгрузки Ozon…</p> : batch ? (
        <>
          <OzonBatchOverview batch={batch} batches={batches} selectedId={selectedId}
            disabled={disabled} onSelect={(id) => void run(() => load(id))} />
          <div className="table-scroll ozon-table-wrap" role="region" aria-label="Отгрузки по кластерам" tabIndex={0}>
            <table className="ozon-table">
              <thead>
                <tr>
                  <th scope="col">Кластер</th>
                  <th scope="col">Магазин</th>
                  <th scope="col">Короба / шт.</th>
                  <th scope="col">
                    <span className="ozon-step-title"><Download size={18} />1. Состав заявки</span>
                    <small>Excel для Ozon</small>
                  </th>
                  <th scope="col">
                    <span className="ozon-step-title"><Upload size={18} />2. Состав грузомест</span>
                    <small>После создания грузомест в Ozon</small>
                  </th>
                </tr>
              </thead>
              <tbody>
                {batch.groups.map((group) => (
                  <OzonShipmentRow
                    key={group.dispatch.id + (group.labels?.id ?? "")}
                    group={group}
                    disabled={disabled}
                    onAssign={(codes) => assign(group, codes)}
                    onDownload={(kind) => run(async () => {
                      await (await import("./exports/ozon-excel")).downloadOzonGroup(group, kind);
                    })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : !error ? <Empty title="Отгрузок Ozon пока нет">Подготовьте состав по номерам коробов.</Empty> : null}
    </div>
  );
}

function OzonBatchOverview({ batch, batches, selectedId, disabled, onSelect }: {
  batch: OzonBatch;
  batches: OzonBatchSummary[];
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const boxes = batch.groups.reduce((total, group) => total + group.boxes.length, 0);
  const items = batch.groups.reduce((total, group) => total + group.dispatch.qty, 0);
  const labels = batch.groups.reduce((total, group) => total + (group.labels?.codes.length ?? 0), 0);
  return (
    <section className="ozon-overview" aria-label="Сводка подготовки">
      <label className="ozon-batch-select">
        Сохранённая подготовка
        <select value={selectedId} disabled={disabled} onChange={(event) => onSelect(event.target.value)}>
          {batches.map((item) => (
            <option key={item.id} value={item.id}>{dateTime(item.createdAt)} МСК · {number(item.boxCount)} кор.</option>
          ))}
        </select>
      </label>
      <div className="ozon-metric"><span>Кластеры</span><strong>{number(batch.groups.length)}</strong></div>
      <div className="ozon-metric"><span>Короба</span><strong>{number(boxes)}</strong></div>
      <div className="ozon-metric"><span>Изделия</span><strong>{number(items)}</strong></div>
      <div className="ozon-metric ozon-metric-progress">
        <span>ШК грузомест</span>
        <div>
          <strong>{number(labels)} из {number(boxes)}</strong>
          <progress aria-label="Загружено штрихкодов грузомест" value={labels} max={boxes} />
        </div>
      </div>
    </section>
  );
}

function OzonShipmentRow({ group, disabled, onAssign, onDownload }: {
  group: OzonGroup;
  disabled: boolean;
  onAssign: (codes: string[]) => Promise<void>;
  onDownload: (kind: "products" | "cargo") => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<"labels" | "pairs" | null>(null);
  const editing = expanded === "labels";
  const detailsId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [reading, setReading] = useState(false);
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const [saveError, setSaveError] = useState("");
  let codes: string[] = [];
  let codeError = "";
  if (text.trim()) {
    try { codes = readOzonCargoCodes(text); }
    catch (error) { codeError = message(error); }
  }
  const matches = codes.length > 0 && codes.length === group.boxes.length;
  const validation = codeError || (codes.length > 0 && !matches
    ? `Штрихкодов в списке ${number(codes.length)}, коробов в отгрузке ${number(group.boxes.length)}.` : "");
  const productCodes = ozonProductBarcodes(group.labels);
  const unresolved = group.labels
    ? summarizeOzonProducts(group.boxes, ozonArticle).filter(({ sku }) => !productCodes.get(sku))
    : [];
  const isDraft = group.dispatch.state === "draft";
  const status = group.dispatch.state === "sent" ? "Отправлена" : group.dispatch.state === "canceled"
    ? "Отменена" : group.labels ? (unresolved.length ? "Пары сохранены" : "Грузоместа готовы") : "Ждёт ШК";
  const tone = isDraft && !group.labels ? "waiting" : group.dispatch.state === "canceled" ? "muted" : "ready";

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setReading(true);
    setFileError("");
    setSaveError("");
    try {
      if (!/\.xlsx$/iu.test(file.name)) throw Error("Выберите файл Excel .xlsx.");
      const { readOzonBarcodeWorkbook } = await import("./exports/ozon-excel");
      setText((await readOzonBarcodeWorkbook(await file.arrayBuffer(), group.cluster)).join("\n"));
      setFileName(file.name);
    } catch (error) { setFileError(message(error)); }
    finally { setReading(false); input.value = ""; }
  }

  async function save() {
    setSaveError("");
    try { await onAssign(codes); }
    catch (error) { setSaveError(message(error)); }
  }

  return (
    <>
      <tr className="ozon-cluster-row">
        <th scope="row">
          <strong>{group.cluster}</strong>
          <small>{group.dispatch.label}</small>
        </th>
        <td>Магазин {group.dispatch.store}</td>
        <td><strong className="ozon-quantity">{number(group.boxes.length)} / {number(group.dispatch.qty)}</strong></td>
        <td>
          <Button className="ozon-excel-button" disabled={disabled} onClick={() => void onDownload("products")}
            title="Скачать состав заявки для Ozon">
            <Download size={17} />Скачать Excel
          </Button>
          <span className="ozon-status ozon-product-status" data-tone="ready">Состав готов</span>
        </td>
        <td>
          <div className="ozon-cargo-actions">
            <span className="ozon-status" data-tone={tone}>{status}</span>
            {isDraft && <Button disabled={disabled || reading} aria-expanded={editing}
              aria-controls={editing ? detailsId : undefined} onClick={() => {
                setExpanded(editing ? null : "labels");
                setFileError("");
                setSaveError("");
                setFileName("");
                setText(editing ? "" : group.labels?.codes.join("\n") ?? "");
              }}>
              <Upload size={17} />{editing ? "Закрыть ввод" : group.labels ? "Обновить ШК" : "Загрузить ШК"}
            </Button>}
          </div>
          {group.labels && (
            <div className="ozon-actions ozon-cargo-download">
              <Button className="ozon-excel-button" disabled={disabled || unresolved.length > 0}
                onClick={() => void onDownload("cargo")}>
                <Download size={17} />Скачать грузоместа
              </Button>
              <Button disabled={disabled || reading} aria-expanded={expanded === "pairs"}
                aria-controls={expanded === "pairs" ? detailsId : undefined}
                onClick={() => setExpanded(expanded === "pairs" ? null : "pairs")}>Пары коробов</Button>
            </div>
          )}
          {unresolved.length > 0 && <p className="muted">Для Excel нужны ШК товаров. Список в «Пары коробов».</p>}
        </td>
      </tr>
      {expanded && <tr className="ozon-details-row" id={detailsId}>
        <td colSpan={5}>
          {editing ? (
            <section className="ozon-label-input" aria-labelledby={detailsId + "-heading"}>
              <header className="ozon-label-header">
                <ScanBarcode size={27} aria-hidden="true" />
                <div>
                  <h3 id={detailsId + "-heading"}>Штрихкоды грузомест</h3>
                  <p>{group.cluster} · Магазин {group.dispatch.store}</p>
                </div>
                <p className="ozon-label-count" role="status">
                  <span>Распознано ШК</span>
                  <strong>{number(codes.length)} из {number(group.boxes.length)}</strong>
                </p>
              </header>
              <div className="ozon-label-body">
                <div className="ozon-label-methods">
                  <div className="ozon-label-method">
                    <h4><FileSpreadsheet size={19} aria-hidden="true" /> Загрузить из Excel</h4>
                    <p className="muted">Файл Ozon в формате .xlsx</p>
                    <input ref={fileInput} hidden type="file" accept=".xlsx" disabled={disabled || reading}
                      aria-label="Файл со штрихкодами Ozon" onChange={(event) => void readFile(event)} />
                    <Button disabled={disabled || reading} onClick={() => fileInput.current?.click()}>
                      <Upload size={16} aria-hidden="true" />Выбрать файл
                    </Button>
                    <p className="ozon-label-file" role="status">
                      {reading ? "Читаем штрихкоды…" : fileName}
                    </p>
                    {fileError && <p role="alert" className="field-error">{fileError}</p>}
                  </div>
                  <div className="ozon-label-method">
                    <label htmlFor={detailsId + "-codes"}>Вставить штрихкоды</label>
                    <p id={detailsId + "-help"} className="muted">По одному на строку, в порядке коробов.</p>
                    <textarea id={detailsId + "-codes"} className="field" rows={3} value={text}
                      aria-invalid={Boolean(validation) || undefined}
                      aria-describedby={detailsId + "-help" + (validation ? " " + detailsId + "-error" : "")}
                      disabled={disabled || reading} onChange={(event) => {
                        setText(event.target.value);
                        setFileError("");
                        setFileName("");
                        setSaveError("");
                      }} />
                    {validation && <p id={detailsId + "-error"} role="alert" className="field-error">{validation}</p>}
                  </div>
                </div>
                {matches && !reading && !fileError && (
                  <div className="ozon-label-review">
                    <h4>Сверка коробов</h4>
                    <p className="muted">Проверьте пары перед сохранением.</p>
                    <OzonPairs group={group} codes={codes} />
                  </div>
                )}
                {saveError && <p className="field-error" role="alert">{saveError}</p>}
                <div className="ozon-label-footer">
                  <Button primary disabled={disabled || reading || Boolean(fileError) || !matches}
                    onClick={() => void save()}>
                    Сохранить пары
                  </Button>
                </div>
              </div>
            </section>
          ) : group.labels && <>
            <OzonPairs group={group} codes={group.labels.codes} />
            {unresolved.length > 0 && <p className="field-error">
              Укажите однозначные ШК товаров в справочнике: {unresolved.map(({ sku }) => sku).join(", ")}.
              {isDraft && " Затем нажмите «Обновить ШК» и сохраните уже заполненные пары."}
            </p>}
          </>}
        </td>
      </tr>}
    </>
  );
}

function OzonPairs({ group, codes }: { group: OzonGroup; codes: string[] }) {
  return (
    <div className="table-scroll ozon-pairs">
      <table aria-label="Короба RITM и штрихкоды Ozon">
        <thead><tr><th scope="col">Короб RITM</th><th scope="col">ШК грузоместа Ozon</th><th scope="col">Штук</th></tr></thead>
        <tbody>
          {group.boxes.map((box, index) => (
            <tr key={box.id}>
              <th scope="row">{box.label}</th>
              <td><code>{codes[index]}</code></td>
              <td><strong>{number(box.qty)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
