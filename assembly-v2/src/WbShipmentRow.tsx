import { useId, useRef, useState, type ChangeEvent } from "react";
import { Download, FileSpreadsheet, ScanBarcode, Upload } from "lucide-react";
import { number } from "../shared/model";
import { type OzonGroup } from "../shared/ozon-shipment";
import { wbCodesForBoxes, wbProductBarcodes, wbUnresolvedArticles, type WbCartonCode } from "../shared/wb-shipment";
import { Button } from "./ui";
import { CatalogArticleLink } from "./CatalogArticleLink";

export type WbPairSelection = { kind: "generate" }
  | { kind: "upload"; entries: WbCartonCode[]; replaceCodes: boolean };

const errorMessage = (value: unknown) => value instanceof Error ? value.message : "Повторите операцию.";

export function WbShipmentRow({ group, disabled, onSave, onDownload }: {
  group: OzonGroup;
  disabled: boolean;
  onSave: (selection: WbPairSelection) => Promise<void>;
  onDownload: (kind: "products" | "cargo") => Promise<void>;
}) {
  const [panel, setPanel] = useState<"pairs" | "upload" | "generate" | null>(null);
  const [file, setFile] = useState<{ name: string; entries: WbCartonCode[] } | null>(null);
  const [reading, setReading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [replaceCodes, setReplaceCodes] = useState(false);
  const [error, setError] = useState("");
  const detailsId = useId();
  const input = useRef<HTMLInputElement>(null);
  const { labels, boxes, dispatch, compositionChanged } = group;
  const isDraft = dispatch.state === "draft";
  const printCount = labels?.printCodes?.filter(Boolean).length ?? 0;
  const savedPairs = labels?.codes.map((code, index) => ({ code, printCode: labels.printCodes?.[index] ?? null }));
  const missing = wbUnresolvedArticles(group);
  const blocked = disabled || reading || dispatch.state === "canceled" || !!compositionChanged;
  const status = dispatch.state === "sent" ? "Отправлена" : dispatch.state === "canceled"
    ? "Отменена" : labels ? "Коды сохранены" : "Ждёт ШК коробов";
  let preview: WbCartonCode[] | undefined;
  let validation = "";
  if (file) {
    try { preview = wbCodesForBoxes(file.entries, replaceCodes ? null : labels, boxes.length); }
    catch (cause) { validation = errorMessage(cause); }
  }

  function toggle(next: typeof panel) {
    setPanel((current) => current === next ? null : next);
    setError("");
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const field = event.currentTarget;
    const source = field.files?.[0];
    if (!source) return;
    setReading(true);
    setError("");
    setFile(null);
    setReplaceCodes(false);
    try {
      if (!/\.xlsx$/iu.test(source.name)) throw Error("Выберите файл .xlsx из WB.");
      if (source.size > 10_000_000) throw Error("Размер файла должен быть до 10 МБ.");
      const { readWbCartonWorkbook } = await import("./exports/wb-excel");
      setFile({ name: source.name, entries: await readWbCartonWorkbook(await source.arrayBuffer()) });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setReading(false); field.value = ""; }
  }

  async function save(selection: WbPairSelection) {
    setError("");
    try {
      await onSave(selection);
      setPanel("pairs");
      setFile(null);
      setReplaceCodes(false);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function downloadLabels() {
    setPrinting(true);
    setError("");
    try {
      await (await import("./exports/wb-labels")).downloadWbLabels(group);
    } catch (cause) {
      setError(errorMessage(cause));
      setPanel("pairs");
    } finally { setPrinting(false); }
  }

  return <>
    <tr className="ozon-cluster-row">
      <th scope="row"><strong>{group.cluster}</strong></th>
      <td>Магазин {dispatch.store}</td>
      <td><strong className="ozon-quantity">{number(boxes.length)} / {number(dispatch.qty)}</strong></td>
      <td>
        <Button className="ozon-excel-button" disabled={blocked || !!missing.length}
          onClick={() => void onDownload("products")}><Download size={17} />Скачать товары</Button>
        {missing.length > 0 && <details className="wb-missing-codes">
          <summary>Проверить баркоды · {number(missing.length)}</summary>
          <ul>{missing.map((sku) => <li key={sku}><CatalogArticleLink sku={sku} scope={dispatch} /></li>)}</ul>
        </details>}
      </td>
      <td>
        <span className="ozon-status" data-tone={dispatch.state === "canceled" ? "muted" : labels ? "ready" : "waiting"}>{status}</span>
        <div className="ozon-actions ozon-cargo-download">
          {isDraft && !labels && <Button disabled={blocked} aria-expanded={panel === "generate"}
            aria-controls={panel === "generate" ? detailsId : undefined}
            onClick={() => toggle("generate")}><ScanBarcode size={17} />Сгенерировать коды</Button>}
          {isDraft && <Button disabled={blocked} aria-expanded={panel === "upload"}
            aria-controls={panel === "upload" ? detailsId : undefined}
            onClick={() => toggle("upload")}><Upload size={17} />{labels ? "Загрузить QR из WB" : "Загрузить Excel WB"}</Button>}
          {labels && <Button className="ozon-excel-button" disabled={blocked || !!missing.length}
            onClick={() => void onDownload("cargo")}><Download size={17} />Скачать состав коробов</Button>}
          <Button disabled={disabled || reading} aria-expanded={panel === "pairs"}
            aria-controls={panel === "pairs" ? detailsId : undefined}
            onClick={() => toggle("pairs")}>{labels ? "Пары и состав" : "Состав коробов"}</Button>
        </div>
        {compositionChanged && <p className="field-error">Состав изменился. Проверьте короба и подготовьте поставку заново.</p>}
      </td>
    </tr>
    {panel && <tr className="ozon-details-row" id={detailsId}>
      <td colSpan={5}>
        <section className="ozon-label-input wb-label-input" aria-labelledby={detailsId + "-heading"}>
          <header className="ozon-label-header">
            <ScanBarcode size={27} aria-hidden="true" />
            <div>
              <h3 id={detailsId + "-heading"}>{panel === "generate" ? "Свои коды коробов"
                : panel === "upload" ? "Коды коробов из WB" : "Короба поставки"}</h3>
              <p>{group.cluster} · Магазин {dispatch.store}</p>
            </div>
            <p className="ozon-label-count">
              <span>{panel === "generate" ? "Коробов" : panel === "upload" ? "Кодов в файле" : "QR для печати"}</span>
              <strong>{panel === "generate" ? number(boxes.length)
                : `${number(panel === "upload" ? file?.entries.length ?? 0 : printCount)} из ${number(boxes.length)}`}</strong>
            </p>
          </header>
          <div className="ozon-label-body">
            {panel === "generate" && <p className="muted">
              Для поставки в СЦ или ПФЦ. RITM сохранит по одному уникальному коду за каждым коробом.
            </p>}
            {panel === "upload" && <div className="ozon-label-method">
              <h4><FileSpreadsheet size={19} aria-hidden="true" />Шаблон упаковки WB</h4>
              <p className="muted">{labels && !replaceCodes
                ? "QR для печати сверяются с сохранёнными ШК коробов."
                : "Сверьте порядок кодов из файла с номерами коробов RITM."}</p>
              <input ref={input} hidden type="file" accept=".xlsx" disabled={blocked}
                aria-label="Файл WB с кодами коробов" onChange={(event) => void readFile(event)} />
              <Button disabled={blocked} onClick={() => input.current?.click()}>
                <Upload size={16} aria-hidden="true" />Выбрать файл
              </Button>
              {(reading || file) && <p className="ozon-label-file" role="status">
                {reading ? "Читаем коды…" : file?.name}
              </p>}
              {labels && file && (validation || replaceCodes) && <label className="wb-replace-codes">
                <input type="checkbox" checked={replaceCodes} disabled={blocked}
                  onChange={(event) => { setReplaceCodes(event.target.checked); setError(""); }} />
                Заменить сохранённые ШК коробов кодами из файла
              </label>}
            </div>}
            {(panel !== "upload" || preview) && <WbPairs group={group} entries={panel === "upload" ? preview : savedPairs} />}
            {(error || (panel === "upload" && validation)) && <p className="field-error" role="alert">{error || validation}</p>}
            {panel === "pairs" && labels && printCount < boxes.length && isDraft && <p className="muted">
              Чтобы напечатать QR, загрузите Excel с кодами для печати из WB.
            </p>}
            <div className="ozon-label-footer">
              {panel === "generate" && <Button primary disabled={blocked || !!labels}
                onClick={() => void save({ kind: "generate" })}>Сгенерировать и сохранить</Button>}
              {panel === "upload" && <Button primary disabled={blocked || !preview}
                onClick={() => {
                  if (preview) void save({ kind: "upload", entries: preview, replaceCodes });
                }}>Сохранить пары</Button>}
              {panel === "pairs" && printCount === boxes.length && <Button disabled={disabled || printing}
                onClick={() => void downloadLabels()}>
                <Download size={17} />{printing ? "Готовим PDF…" : "Скачать этикетки PDF"}
              </Button>}
            </div>
          </div>
        </section>
      </td>
    </tr>}
  </>;
}

function WbPairs({ group, entries }: { group: OzonGroup; entries?: WbCartonCode[] }) {
  const barcodes = wbProductBarcodes(group);
  return <div className="wb-pairs">
    {group.boxes.map((box, index) => <details className="wb-pair" key={box.id}>
      <summary>
        <strong>{box.label}</strong>
        <span>{entries?.[index]?.code ?? "ШК не задан"}</span>
        <span>{number(box.qty)} шт.</span>
      </summary>
      <ul>
        {box.products.map((item) => <li key={item.sku}>
          <span>
            <CatalogArticleLink sku={item.sku} scope={group.dispatch} />
            <small>{item.name} · {barcodes.get(item.sku) ?? "Баркод требует проверки"}</small>
          </span>
          <strong>{number(item.qty)} шт.</strong>
        </li>)}
      </ul>
    </details>)}
  </div>;
}
