import { useEffect, useRef, useState } from "react";
import { ChevronRight, Download, RotateCcw } from "lucide-react";
import { catalogKey } from "../shared/catalog";
import {
  dispatchHistoryPageSize, type DispatchHistoryDetail, type DispatchHistoryEntry, type DispatchHistoryPage,
} from "../shared/dispatch-history";
import { countLabel, dateTime, number, type Dispatch, type Scope } from "../shared/model";
import { ozonArticle, ozonCodesByCarton, summarizeOzonProducts, type OzonProduct } from "../shared/ozon-shipment";
import { warehouseCity } from "../shared/warehouse-filter";
import { Button, Dialog, Empty, Pagination, Search } from "./ui";
import { request } from "./useWorkspace";
import { CatalogArticleLink } from "./CatalogArticleLink";
import "./dispatch-history.css";

const historyPath = "/api/dispatch-history";
const cartonCount = (qty: number) => countLabel(qty, ["короб", "короба", "коробов"]);
const historyEntryKey = (entry: DispatchHistoryEntry) => JSON.stringify([entry.id, entry.matchedCarton?.id]);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Повторите загрузку.";
const historyDate = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow",
});

type CartonReturn = { dispatchId: string; cartonId: string; label: string };

function shipmentDays(entries: DispatchHistoryEntry[]) {
  const days = new Map<string, DispatchHistoryEntry[]>();
  for (const entry of entries) {
    const time = new Date(entry.sentAt ?? entry.createdAt);
    const day = Number.isNaN(time.getTime()) ? "Дата не указана" : historyDate.format(time);
    const group = days.get(day) ?? [];
    group.push(entry);
    days.set(day, group);
  }
  return days;
}

export default function DispatchHistory({ revision, busy, onExport, onReturn }: {
  revision: number;
  busy: boolean;
  onExport(dispatch: Dispatch): void;
  onReturn(box: CartonReturn): Promise<unknown>;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [list, setList] = useState<DispatchHistoryPage | null>(null);
  const [selection, setSelection] = useState<{ key: string; clickCount: number } | null>(null);
  const [detail, setDetail] = useState<DispatchHistoryDetail | null>(null);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [listRetry, setListRetry] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const [returnBox, setReturnBox] = useState<CartonReturn | null>(null);
  const [returnError, setReturnError] = useState("");
  const search = query.trim();
  const firstEntry = list?.entries[0];
  const selected = list?.entries.find((entry) => historyEntryKey(entry) === selection?.key)
    ?? (!search || (page === 0 && firstEntry?.matchedCarton?.exact) ? firstEntry : undefined);
  const shipmentId = selected?.id;
  const matchedCartonId = selected?.matchedCarton?.id;

  function changeQuery(value: string) {
    setQuery(value);
    if (value.trim() === search) return;
    setPage(0);
    setSelection(null);
    setList(null);
    setListError("");
  }

  useEffect(() => {
    const abort = new AbortController();
    setListError("");
    const params = new URLSearchParams({ page: String(page) });
    if (search) params.set("q", search);
    const timer = setTimeout(() => {
      void request<DispatchHistoryPage>(historyPath + "?" + params, { signal: abort.signal })
        .then((next) => {
          if (abort.signal.aborted) return;
          const lastPage = Math.max(0, Math.ceil(next.total / dispatchHistoryPageSize) - 1);
          if (page > lastPage) setPage(lastPage);
          else setList(next);
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted) setListError(errorMessage(error));
        });
    }, search ? 240 : 0);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [page, search, revision, listRetry]);

  useEffect(() => {
    if (!shipmentId) return;
    const abort = new AbortController();
    setDetailError("");
    void request<DispatchHistoryDetail>(historyPath + "?id=" + encodeURIComponent(shipmentId), { signal: abort.signal })
      .then((item) => {
        if (!abort.signal.aborted) setDetail(item);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setDetailError(errorMessage(error));
      });
    return () => abort.abort();
  }, [shipmentId, detailRetry, revision]);

  async function confirmReturn() {
    if (!returnBox || busy) return;
    setReturnError("");
    try {
      await onReturn(returnBox);
      setReturnBox(null);
      setListRetry((value) => value + 1);
      setDetailRetry((value) => value + 1);
    } catch (error) {
      setReturnError(errorMessage(error));
    }
  }

  return (
    <div className="shipment-history">
      <div className="history-heading">
        <h1>История отгрузок</h1>
        <Search value={query} onChange={changeQuery} label="Номер короба, ШК Ozon или артикул" />
      </div>
      {listError && <div className="history-read-error">
        <p className="field-error" role="alert">{listError}</p>
        <Button onClick={() => setListRetry((value) => value + 1)}>Повторить загрузку</Button>
      </div>}
      {list?.entries.length ? (
        <div className="history-workspace">
          <aside className="history-list" aria-label={search ? "Результаты поиска" : "Отгрузки"}>
            <h2>{search ? "Результаты поиска" : "Отгрузки"}</h2>
            <div className="history-list-scroll">
              {[...shipmentDays(list.entries)].map(([day, shipments]) => (
                <section key={day}>
                  <h3 className="history-group-day">{day}</h3>
                  {shipments.map((entry) => {
                    const key = historyEntryKey(entry);
                    const match = entry.matchedCarton;
                    return (
                      <button className="history-select" type="button" key={key}
                        aria-pressed={entry === selected}
                        onClick={() => setSelection((current) => ({ key, clickCount: (current?.clickCount ?? 0) + 1 }))}>
                        <span className="history-select-title">
                          <strong>{warehouseCity(entry).label}</strong>
                          <HistoryStatus state={entry.state} returned={entry.returnedCartonCount} total={entry.cartonCount} />
                        </span>
                        <span>{entry.market} · Магазин {entry.store}</span>
                        {match ? (
                          <small className="history-search-match">
                            <b>Короб {match.label}</b>
                            {match.ozonCode && <OzonCode code={match.ozonCode} />}
                            {match.articleQty && <span>{number(match.articleQty)} шт. по артикулу</span>}
                          </small>
                        ) : (
                          <small>{entry.cartonLabels.length
                            ? entry.cartonLabels.join(", ") + (entry.cartonCount > entry.cartonLabels.length
                              ? " +" + (entry.cartonCount - entry.cartonLabels.length) : "")
                            : cartonCount(entry.cartonCount)}</small>
                        )}
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
            {list.total > dispatchHistoryPageSize ? (
              <Pagination page={page} total={list.total} size={dispatchHistoryPageSize} onChange={(next) => {
                setList(null);
                setPage(next);
                setSelection(null);
              }} />
            ) : search ? <p className="history-search-count" role="status">Найдено {cartonCount(list.total)}</p> : null}
          </aside>
          {!selected ? (
            <Empty title="Выберите короб">Состав откроется по нажатию на результат поиска.</Empty>
          ) : detail && detail.dispatch.id === shipmentId ? (
            <ShipmentDetails
              key={JSON.stringify([historyEntryKey(selected), matchedCartonId ? selection?.clickCount : null])}
              detail={detail}
              matchedCartonId={matchedCartonId}
              searchedArticle={selected.matchedCarton?.articleQty ? search : undefined}
              onExport={onExport}
              busy={busy}
              onReviewReturn={(cartonId, label) => {
                setReturnError("");
                setReturnBox({ dispatchId: detail.dispatch.id, cartonId, label });
              }}
            />
          ) : detailError ? (
            <div className="panel history-read-error">
              <p className="field-error" role="alert">{detailError}</p>
              <Button onClick={() => setDetailRetry((value) => value + 1)}>Повторить загрузку</Button>
            </div>
          ) : <p className="history-loading" role="status">Загружаем состав отгрузки…</p>}
        </div>
      ) : list ? (
        <Empty title={search ? "Совпадений в истории нет" : "История пока пуста"}>
          {search ? "Проверьте номер короба, последние цифры ШК Ozon или артикул." : "Здесь появятся отправленные и отменённые отгрузки."}
        </Empty>
      ) : !listError ? (
        <p role="status">{search ? "Ищем короб в истории…" : "Загружаем историю отгрузок…"}</p>
      ) : null}
      {returnBox && (
        <Dialog title={`Вернуть короб ${returnBox.label} на склад?`} busy={busy} onClose={() => setReturnBox(null)}>
          <div className="stack">
            <p>Подтвердите, что короб остался на складе. Он снова появится в списке «Готовы к отгрузке».</p>
            {returnError && <p className="field-error" role="alert">{returnError}</p>}
            <div className="actions">
              <Button disabled={busy} onClick={() => setReturnBox(null)}>Отмена</Button>
              <Button primary disabled={busy} onClick={() => void confirmReturn()}>
                {busy ? "Возвращаем…" : "Короб не уехал, вернуть"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function HistoryStatus({ state, returned, total }: { state: Dispatch["state"]; returned: number; total: number }) {
  const label = state !== "sent" ? "Отменена" : returned > 0
    ? returned === total ? "Возвращена" : "Частично возвращена"
    : "Отправлена";
  return <span className="history-status" data-state={returned > 0 ? "returned" : state}>{label}</span>;
}

function ShipmentDetails({ detail, matchedCartonId, searchedArticle, onExport, busy, onReviewReturn }: {
  detail: DispatchHistoryDetail;
  matchedCartonId?: string;
  searchedArticle?: string;
  onExport(dispatch: Dispatch): void;
  busy: boolean;
  onReviewReturn(cartonId: string, label: string): void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const matchedBox = useRef<HTMLElement | null>(null);
  const { dispatch, archive, ozon, cartonLabels } = detail;
  const cartonStates = detail.cartonStates ?? {};
  const isOzon = dispatch.market === "OZON";
  const codes = ozonCodesByCarton(ozon);
  const city = warehouseCity(dispatch).label;
  const scope = dispatch.market + " · Магазин " + dispatch.store;
  const article = isOzon ? ozonArticle : undefined;
  const highlightedSku = searchedArticle ? catalogKey(article?.(searchedArticle) ?? searchedArticle) : undefined;
  const cartons = archive?.payload.cartons.map(({ id, label, qty, items }) => ({ id, label, qty, products: items }))
    ?? ozon?.boxes ?? [];
  const cartonIdsWithComposition = new Set(cartons.map((box) => box.id));
  const cartonsWithoutComposition = dispatch.cartonIds.filter((id) => !cartonIdsWithComposition.has(id) && cartonLabels[id]);
  const originalCount = dispatch.cartonIds.length || cartons.length;
  const returnedCount = Object.values(cartonStates).filter((state) => state === "returned").length;
  const remainingCount = originalCount - returnedCount;
  const remaining = cartons.filter((box) => cartonStates[box.id] !== "returned");
  const productTotals = summarizeOzonProducts(remaining, article);
  const quantity = returnedCount > 0 && remaining.length !== remainingCount
    ? null
    : cartons.length || returnedCount > 0 ? remaining.reduce((total, box) => total + box.qty, 0) : dispatch.qty;
  const quantityLabel = quantity === null ? "—" : number(quantity);
  const source = archive?.kind === "export" ? "Сохранённая выгрузка · " + dateTime(archive.createdAt) + " МСК"
    : !archive && ozon ? "Состав на этапе подготовки" : "";

  function returnButton(id: string, label: string) {
    if (cartonStates[id] !== "sent") return null;
    return <Button className="history-carton-return" disabled={busy}
      aria-label={`Вернуть короб ${label} на склад`} onClick={() => onReviewReturn(id, label)}>
      <RotateCcw size={15} aria-hidden="true" />Вернуть на склад
    </Button>;
  }

  useEffect(() => {
    const box = matchedBox.current;
    if (!box) return;
    const row = box.querySelector("[data-article-match]");
    const target = row ?? box;
    const { top, bottom } = target.getBoundingClientRect();
    if (top < 0 || bottom > window.innerHeight) target.scrollIntoView({ block: row ? "center" : "start" });
  }, [matchedCartonId, highlightedSku]);

  async function download() {
    setDownloading(true);
    setDownloadError("");
    try {
      if (archive) {
        const { accountWorkbook, downloadWorkbook } = await import("./exports/excel");
        const payload = isOzon ? {
          ...archive.payload,
          cartons: archive.payload.cartons.map((box) => ({
            ...box, items: box.items.map((item) => ({ ...item, sku: ozonArticle(item.sku) })),
          })),
        } : archive.payload;
        const workbook = accountWorkbook({ createdAt: archive.createdAt, payload }, isOzon ? codes : undefined);
        await downloadWorkbook(workbook, dispatch.label.replace(/[<>:"/\\|?*]/gu, "_") + " — Состав.xlsx");
      } else if (ozon) {
        const { downloadOzonControl } = await import("./exports/ozon-excel");
        await downloadOzonControl({ id: ozon.batchId, groups: [ozon] });
      }
    } catch (error) {
      setDownloadError(errorMessage(error));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <article className="history-detail" aria-label={"Отгрузка · " + city + " · " + scope}>
      <header className="history-banner">
        <div className="history-destination">
          <h2>{city}</h2>
          <p>{scope}</p>
          {city !== dispatch.destination && dispatch.destination && <p>{dispatch.destination}</p>}
          <div className="history-event">
            <HistoryStatus state={dispatch.state} returned={returnedCount} total={originalCount} />
            <time dateTime={dispatch.sentAt ?? dispatch.createdAt}>{dateTime(dispatch.sentAt ?? dispatch.createdAt)} МСК</time>
          </div>
        </div>
        <div className="history-metric">
          <strong>{number(remainingCount)}</strong><span>Короба</span>
        </div>
        <div className="history-metric"><strong>{quantityLabel}</strong><span>Штук</span></div>
        {cartons.length > 0 && <div className="history-download">
          <Button disabled={downloading} onClick={() => void download()}>
            <Download size={17} aria-hidden="true" />{returnedCount > 0 ? "Скачать архив Excel" : "Скачать Excel"}
          </Button>
          {archive?.kind === "departure" && <button className="history-format" type="button"
            onClick={() => onExport(dispatch)}>Другие форматы</button>}
        </div>}
      </header>
      {downloadError && <p className="field-error" role="alert">{downloadError}</p>}
      {(source || returnedCount > 0) && <p className="history-source">
        {returnedCount > 0 ? "В архиве сохранён состав на момент отметки выезда." : source}
      </p>}
      <div className="history-compositions">
        <section>
          <h3>Короба поставки</h3>
          <div className="history-cartons">
              {isOzon && cartons.length > 0 && <div className="history-carton-columns" aria-hidden="true">
                <span>Короб RITM</span><span>ШК грузоместа Ozon</span><span>Кол-во</span>
              </div>}
              {cartons.map((box) => (
                <details className="history-carton" key={box.id} open={box.id === matchedCartonId}
                  data-match={box.id === matchedCartonId || undefined}
                  ref={box.id === matchedCartonId ? (element) => { matchedBox.current = element; } : undefined}>
                  <summary>
                    <ChevronRight size={17} aria-hidden="true" />
                    <div className="history-carton-name">
                      <strong>{box.label}</strong>
                      {cartonStates[box.id] === "returned" && <ReturnedCarton />}
                    </div>
                    {isOzon && <OzonCode code={codes.get(box.id)} />}
                    <b className="history-carton-qty">{number(box.qty)} шт.</b>
                  </summary>
                  {cartonStates[box.id] === "sent" && (
                    <div className="history-carton-actions">{returnButton(box.id, box.label)}</div>
                  )}
                  <ProductTable products={summarizeOzonProducts([box], article)} scope={dispatch}
                    highlightedSku={box.id === matchedCartonId ? highlightedSku : undefined} />
                </details>
              ))}
              {cartonsWithoutComposition.map((id) => (
                <div className="history-archived-box" key={id} data-match={id === matchedCartonId || undefined}
                  ref={id === matchedCartonId ? (element) => { matchedBox.current = element; } : undefined}>
                  <strong>{cartonLabels[id]}</strong>
                  {isOzon && <OzonCode code={codes.get(id)} />}
                  {cartonStates[id] === "returned" && <ReturnedCarton />}
                  {returnButton(id, cartonLabels[id])}
                </div>
              ))}
              {!cartons.length && <p className="muted">{dispatch.state === "sent"
                ? "Архивный состав на дату выезда отсутствует." : "Архивный состав подготовки отсутствует."}</p>}
          </div>
        </section>
        <section>
          <h3>Общий состав поставки</h3>
          {productTotals.length ? (
            <>
              <p className="history-product-count">{countLabel(productTotals.length, ["артикул", "артикула", "артикулов"])}</p>
              <ProductTable products={productTotals} scope={dispatch} />
            </>
          ) : <p className="history-product-count">{returnedCount > 0 && remainingCount === 0
            ? "Все короба возвращены." : "Доступен итог отгрузки."}</p>}
          <div className="history-total"><span>Всего</span><strong>{quantityLabel}{quantity !== null && " шт."}</strong></div>
        </section>
      </div>
    </article>
  );
}

function ReturnedCarton() {
  return <span className="history-status" data-state="returned">Возвращён</span>;
}

function OzonCode({ code }: { code: string | undefined }) {
  return code ? <code className="history-code" aria-label={"ШК грузоместа Ozon " + code}>{code}</code>
    : <span className="history-missing-code">ШК не привязан</span>;
}

function ProductTable({ products, scope, highlightedSku }: {
  products: OzonProduct[]; scope: Pick<Scope, "market" | "store">; highlightedSku?: string;
}) {
  return (
    <div className="table-scroll history-products">
      <table>
        <thead><tr><th scope="col">Артикул / товар</th><th scope="col">Шт.</th></tr></thead>
        <tbody>{products.map((product) => {
          const matched = highlightedSku !== undefined && catalogKey(product.sku) === highlightedSku;
          return (
            <tr key={product.sku} data-article-match={matched || undefined}>
              <td><CatalogArticleLink sku={product.sku} scope={scope} />
                {product.name && product.name !== product.sku && <small>{product.name}</small>}</td>
              <td>{matched ? <span className="history-match-qty">{number(product.qty)} шт.</span> : number(product.qty)}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
