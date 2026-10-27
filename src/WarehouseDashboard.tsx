import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle, Clock3, Cube, MagnifyingGlass, Package, Warning, X } from "./icons";
import { num } from "./model";
import type { WarehouseCarton, WarehouseSnapshot } from "./liveWarehouse";
import "./warehouseDashboard.css";

export type WarehouseView = "cartons" | "items" | "stock";
type Props = { value: WarehouseSnapshot | null; loading: boolean; error: string; view: WarehouseView; onViewChange: (view: WarehouseView) => void; onRefresh: () => void | Promise<void> };
type Product = { key: string; article: string; name: string; photo: string; shipment: string; shipmentId: string; store: string; quantity: number; boxes: WarehouseCarton[] };
const dateText = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(date) : "Время не указано"; };
const normalized = (value: string) => value.trim().toLocaleLowerCase("ru-RU");
const percent = (value: number) => value > 100 && Math.round(value * 10) === 1000 ? ">100%" : `${num(value, 1)}%`;
function Card({ icon, label, value, note }: { icon: ReactNode; label: string; value: string; note: string }) { return <div className="wh-kpi"><span className="wh-kpi-icon">{icon}</span><span><small>{label}</small><strong>{value}</strong><small>{note}</small></span></div>; }
function Photo({ src }: { src: string }) { const [failed, setFailed] = useState(false); useEffect(() => setFailed(false), [src]); return src && !failed ? <img className="wh-photo" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span className="wh-photo is-empty"><Package size={20} aria-hidden="true" /></span>; }
function State({ box, stale }: { box: WarehouseCarton; stale: boolean }) {
  if (box.dispatchStatus === "sent") return <div className="wh-state"><span className="wh-status is-sent">Отправлен</span><small className="is-sent-detail">{box.sentAt ? dateText(box.sentAt) : "Статус сохранён"}</small></div>;
  return <div className="wh-state"><span className={`wh-status is-${box.status}`}>{box.status === "closed" ? "Закрыт" : box.status === "open" ? "Открыт" : "Не подтверждён"}</span>{box.status === "closed" && <small className={box.ready && !stale ? "is-ready" : "is-review"}>{box.ready && !stale ? "Можно готовить к отправке" : "Требует проверки"}</small>}</div>;
}
function Fill({ value }: { value: number | null }) { return value === null ? <span className="wh-unknown">Не подтверждено</span> : <div className="wh-fill"><span><i style={{ width: `${Math.min(100, value)}%` }} /></span><strong>{percent(value)}</strong></div>; }

export function WarehouseDashboard({ value, loading, error, view, onViewChange, onRefresh }: Props) {
  const [query, setQuery] = useState(""), [market, setMarket] = useState("all"), [store, setStore] = useState("all"), [status, setStatus] = useState("active"), [selected, setSelected] = useState(""), [history, setHistory] = useState(false), [limit, setLimit] = useState(20);
  const [dispatching, setDispatching] = useState(""), [dispatchError, setDispatchError] = useState(""), [dispatchMessage, setDispatchMessage] = useState("");
  const boxes = value?.cartons || [];
  const stores = useMemo(() => [...new Set(boxes.map((box) => box.store).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru", { numeric: true })), [boxes]);
  const filtered = useMemo(() => {
    const search = normalized(query);
    return boxes.filter((box) => {
      const sent = box.dispatchStatus === "sent";
      const matchesStatus = status === "all"
        || (status === "active" && !sent)
        || (status === "sent" && sent)
        || (status === "open" && !sent && box.status === "open")
        || (status === "closed" && !sent && box.status === "closed")
        || (status === "review" && !sent && box.issues.length > 0)
        || (status === "unknown" && !sent && box.status === "unknown");
      return (market === "all" || box.market === market) && (store === "all" || box.store === store) && matchesStatus && (!search || normalized(`${box.number} ${box.shipment} ${box.store} ${box.contents.map((item) => `${item.article} ${item.productName}`).join(" ")}`).includes(search));
    });
  }, [boxes, query, market, store, status]);
  const products = useMemo(() => {
    const grouped = new Map<string, Product>();
    for (const box of filtered) for (const item of box.contents) {
      const itemStore = item.store || box.store || "";
      const key = `${box.shipmentId}\u0000${itemStore}\u0000${item.article.toLocaleUpperCase("ru-RU")}`;
      const product = grouped.get(key) || { key, article: item.article, name: item.productName, photo: item.photoUrl, shipment: box.shipment, shipmentId: box.shipmentId, store: itemStore, quantity: 0, boxes: [] };
      product.quantity += item.quantity;
      if (!product.boxes.some((entry) => entry.id === box.id)) product.boxes.push(box);
      grouped.set(key, product);
    }
    return [...grouped.values()].sort((a, b) => a.article.localeCompare(b.article, "ru", { numeric: true }));
  }, [filtered]);
  const selectedBox = filtered.find((box) => box.id === selected) || null;
  const selectedProduct = products.find((item) => item.key === selected) || null;
  useEffect(() => { setSelected(""); setHistory(false); setLimit(20); }, [query, market, store, status]);
  const known = !!value, stale = !!value?.stale;
  const currentBoxes = boxes.filter((box) => box.dispatchStatus !== "sent"), sentBoxes = boxes.filter((box) => box.dispatchStatus === "sent");
  const currentQuantity = currentBoxes.reduce((sum, box) => sum + box.quantity, 0), sentQuantity = sentBoxes.reduce((sum, box) => sum + box.quantity, 0);
  const count = (key: string) => currentBoxes.filter((box) => box.status === key).length;
  const issues = boxes.filter((box) => box.issues.length > 0).length + (value?.issues.length || 0);
  const updated = value?.snapshotAt || value?.checkedAt;
  async function updateDispatch(box: WarehouseCarton) {
    const nextStatus = box.dispatchStatus === "sent" ? "pending" : "sent";
    setDispatching(box.id); setDispatchError(""); setDispatchMessage("");
    try {
      const response = await fetch("/api/warehouse/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cartonId: box.id, shipmentId: box.shipmentId, status: nextStatus }),
      });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) throw new Error(result?.message || "Не удалось сохранить статус короба.");
      setDispatchMessage(nextStatus === "sent" ? "Короб отмечен как отправленный." : "Короб возвращён в список неотправленных.");
      await onRefresh();
    } catch (reason) {
      setDispatchError(reason instanceof Error ? reason.message : "Не удалось сохранить статус короба.");
    } finally {
      setDispatching("");
    }
  }
  return <div className="wh-dashboard">
    <div className="wh-tabs" role="tablist" aria-label="Виды склада">{[["cartons", "Короба"], ["items", "По товарам"], ["stock", "Остатки по ячейкам"]].map(([id, title]) => <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? "is-active" : ""} onClick={() => { setSelected(""); setHistory(false); setLimit(20); onViewChange(id as WarehouseView); }}>{title}</button>)}</div>
    {view !== "stock" && <>
      {(error || stale) && <div className="wh-warning"><Warning size={20} /><span>{stale ? value?.staleReason || "Показан предыдущий снимок. Обновите данные перед отправкой." : error}</span><button type="button" onClick={onRefresh} disabled={loading}>Повторить</button></div>}
      <section className="wh-kpis" aria-label="Сводка коробов"><Card icon={<Cube size={24} />} label="Короба на складе" value={known ? num(currentBoxes.length) : "—"} note="Ещё не отправлены" /><Card icon={<Package size={24} />} label="Товаров на складе" value={known ? `${num(currentQuantity)} шт.` : "—"} note={issues ? "Есть данные для проверки" : "По составу коробов"} /><Card icon={<CheckCircle size={24} />} label="Отправлено" value={known ? num(sentBoxes.length) : "—"} note={`${num(sentQuantity)} шт. уехало`} /><Card icon={<CheckCircle size={24} />} label="Закрыто к отправке" value={known ? num(count("closed")) : "—"} note="Ожидают отметки об отправке" /><Card icon={<Cube size={24} />} label="Открыто" value={known ? num(count("open")) : "—"} note={known && count("unknown") ? `${num(count("unknown"))} со статусом на проверке` : "Можно продолжить сборку"} /></section>
      {value && <div className="wh-source-line">{stale ? "Предыдущий снимок" : "Данные Assembly"} · проверено {updated ? dateText(updated) : "—"} МСК · обновление каждые 5 минут при открытой вкладке</div>}
      {value && !value.catalogAvailable && <div className="wh-warning"><Warning size={20} /><span>Каталог временно недоступен: магазин и заполнение требуют проверки.</span></div>}
      {value && issues > 0 && <div className="wh-warning"><Warning size={20} /><span>Есть записи, которые требуют проверки: {num(issues)}. Проверьте состав перед физической отправкой.</span></div>}
      <div className={`wh-layout${selectedBox || selectedProduct ? " has-detail" : ""}`}><section className="wh-main"><div className="wh-toolbar"><div className="wh-search"><MagnifyingGlass size={18} /><input aria-label="Поиск по коробу, артикулу или поставке" placeholder="Найти короб, артикул или поставку" value={query} onChange={(event) => setQuery(event.target.value)} /></div><select aria-label="Маркетплейс" value={market} onChange={(event) => setMarket(event.target.value)}><option value="all">Все маркетплейсы</option><option value="OZON">Ozon</option><option value="WB">Wildberries</option><option value="">Не определён</option></select><select aria-label="Магазин" value={store} onChange={(event) => setStore(event.target.value)}><option value="all">Все магазины</option>{stores.map((item) => <option key={item} value={item}>Магазин {item}</option>)}<option value="">Не подтверждён</option></select><select aria-label="Состояние короба" value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">Не отправлены</option><option value="sent">Отправлены</option><option value="all">Все состояния</option><option value="open">Открыт</option><option value="closed">Закрыт</option><option value="review">Требует проверки</option><option value="unknown">Не подтверждён</option></select></div>
        {!value ? <div className="wh-empty">{loading ? "Загружаем короба…" : error || "Данные коробов пока недоступны."}</div> : view === "cartons" ? <div className="wh-scroll"><table className="wh-table"><thead><tr><th>Номер короба</th><th>Поставка</th><th>Магазин</th><th>Тип</th><th>Заполнение</th><th>Товаров, шт.</th><th>Состояние</th></tr></thead><tbody>{filtered.slice(0, limit).map((box) => <tr key={box.id} className={selected === box.id ? "is-selected" : ""}><td><button className="wh-row-link" type="button" onClick={() => { setSelected(box.id); setHistory(false); }}>{box.number || "Без номера"}</button></td><td><span className={`wh-market is-${box.market.toLowerCase() || "unknown"}`}>{box.market || "?"}</span> {box.shipment || "Не подтверждена"}</td><td>{box.store ? `Магазин ${box.store}` : "Не подтверждён"}</td><td>{box.boxType || "—"}</td><td><Fill value={box.fillPercent} /></td><td><strong>{num(box.quantity)}</strong></td><td><div className="wh-table-state"><State box={box} stale={stale} />{box.status === "closed" && <button className="wh-inline-dispatch" type="button" disabled={stale || loading || dispatching === box.id} onClick={() => { setSelected(box.id); setHistory(false); void updateDispatch(box); }}>{dispatching === box.id ? "Сохраняем…" : box.dispatchStatus === "sent" ? "Вернуть" : "Отметить отправленным"}</button>}</div></td></tr>)}</tbody></table>{!filtered.length && <div className="wh-empty">Короба не найдены. Измените поиск или фильтры.</div>}</div> : <div className="wh-scroll"><table className="wh-table"><thead><tr><th>Артикул</th><th>Поставка</th><th>Магазин</th><th>Товаров в коробах</th><th>Коробов</th></tr></thead><tbody>{products.slice(0, limit).map((item) => <tr key={item.key} className={selected === item.key ? "is-selected" : ""}><td><button type="button" className="wh-product-link" onClick={() => { setSelected(item.key); setHistory(false); }}><Photo src={item.photo} /><span><strong>{item.article}</strong><small>{item.name || "Наименование не подтверждено"}</small></span></button></td><td>{item.shipment}</td><td>{item.store ? `Магазин ${item.store}` : "Не подтверждён"}</td><td><strong>{num(item.quantity)} шт.</strong></td><td>{num(item.boxes.length)}</td></tr>)}</tbody></table>{!products.length && <div className="wh-empty">Товары в коробах не найдены.</div>}</div>}
        {value && (view === "cartons" ? filtered.length : products.length) > limit && <button type="button" className="wh-more" onClick={() => setLimit((current) => current + 20)}>Показать ещё</button>}
        <p className="wh-note">Отправляйте только закрытые короба. Отметка «Отправлен» убирает короб из списка неотправленных; его можно найти фильтром «Отправлены» и вернуть обратно.</p>
      </section>
      {selectedBox && <aside className="wh-detail"><div className="wh-detail-heading"><h2>Короб {selectedBox.number}</h2><button type="button" aria-label="Закрыть карточку" onClick={() => setSelected("")}><X size={19} /></button></div><State box={selectedBox} stale={stale} /><dl><div><dt>Поставка</dt><dd>{selectedBox.shipment}</dd></div><div><dt>Магазин</dt><dd>{selectedBox.store ? `Магазин ${selectedBox.store}` : "Не подтверждён"}</dd></div><div><dt>Тип короба</dt><dd>{selectedBox.boxType || "Не подтверждён"}</dd></div><div><dt>Заполнение</dt><dd>{selectedBox.fillPercent === null ? "Не подтверждено" : percent(selectedBox.fillPercent)}</dd></div>{selectedBox.dispatchStatus === "sent" && <div><dt>Отметил</dt><dd>{selectedBox.dispatchChangedBy || "Менеджер"}</dd></div>}</dl>{selectedBox.issues.length > 0 && <div className="wh-detail-warning">{selectedBox.issues.map((issue) => <span key={issue}>{issue}</span>)}</div>}{selectedBox.status === "closed" && <div className="wh-dispatch-action"><button type="button" disabled={stale || loading || dispatching === selectedBox.id} onClick={() => void updateDispatch(selectedBox)}>{dispatching === selectedBox.id ? "Сохраняем…" : selectedBox.dispatchStatus === "sent" ? "Вернуть в неотправленные" : "Отметить отправленным"}</button>{stale && <small>Обновите данные: статус можно менять только по актуальному снимку.</small>}{dispatchError && <small className="is-error" role="alert">{dispatchError}</small>}{dispatchMessage && <small className="is-success" role="status">{dispatchMessage}</small>}</div>}<h3>Состав короба</h3><div className="wh-detail-items">{selectedBox.contents.map((item) => <div key={`${item.positionId}:${item.article}`}><Photo src={item.photoUrl} /><span><strong>{item.productName || item.article}</strong><small>{item.article}</small></span><b>{num(item.quantity)} шт.</b></div>)}</div><div className="wh-detail-total"><strong>Всего товаров</strong><strong>{num(selectedBox.quantity)} шт.</strong></div><button type="button" className="wh-history-toggle" aria-expanded={history} onClick={() => setHistory(!history)}><Clock3 size={18} /> {history ? "Скрыть историю" : "История изменений"} <ArrowRight size={16} /></button>{history && <div className="wh-history">{selectedBox.history.length ? selectedBox.history.map((entry, i) => <div key={`${entry.action}:${entry.createdAt}:${i}`}><strong>{entry.action === "close" ? "Короб закрыт" : entry.action === "remove" ? "Корректировка состава" : "Добавлено в короб"}</strong><small>{dateText(entry.createdAt)} МСК{entry.article ? ` · ${entry.article} · ${num(entry.quantity || 0)} шт.` : ""}</small>{entry.reason && <small>{entry.reason}</small>}<small>Сотрудник в записи не указан</small></div>) : <p>История недоступна.</p>}</div>}</aside>}
      {selectedProduct && <aside className="wh-detail"><div className="wh-detail-heading"><h2>{selectedProduct.article}</h2><button type="button" aria-label="Закрыть карточку" onClick={() => setSelected("")}><X size={19} /></button></div><div className="wh-product-detail"><Photo src={selectedProduct.photo} /><span>{selectedProduct.name || "Наименование не подтверждено"}</span></div><p>{selectedProduct.shipment} · {selectedProduct.store ? `Магазин ${selectedProduct.store}` : "магазин не подтверждён"}</p><h3>Находится в коробах</h3>{selectedProduct.boxes.map((box) => <button type="button" className="wh-box-link" key={box.id} onClick={() => { setSelected(box.id); setHistory(false); onViewChange("cartons"); }}><strong>{box.number}</strong><span>{num(box.contents.filter((item) => item.article.toLocaleUpperCase("ru-RU") === selectedProduct.article.toLocaleUpperCase("ru-RU") && item.positionId && box.shipmentId === selectedProduct.shipmentId && (item.store || box.store || "") === selectedProduct.store).reduce((sum, item) => sum + item.quantity, 0))} шт.</span><ArrowRight size={16} /></button>)}</aside>}
      </div>
    </>}
  </div>;
}
