import { StockBoxSelect } from "./StockBoxSelect";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Operation, Supply } from "../shared/model";
import { number, dateTime, operationLabels } from "../shared/model";
import type { WarehouseCarton, WarehousePage, WarehouseReceipt } from "../shared/warehouse";
import type { CatalogPage } from "../shared/catalog";
import type { Workspace } from "./useWorkspace";
import { request } from "./useWorkspace";
import { Button, Dialog, Empty, Field, NativeSelect, Pagination, Search } from "./ui";
import { LabelDialog } from "./LabelDialog";
import { ProductPhoto } from "./ProductPhoto";
import { useDirty, useDraftNavigation } from "./DraftGuard";

export function WarehouseStock({
  workspace: w,
  supply,
  manager = false,
}: {
  workspace: Workspace;
  supply?: Supply;
  manager?: boolean;
}) {
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [data, setData] = useState<WarehousePage | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<WarehouseCarton | null>(null);
  const [labelReceipt, setLabelReceipt] = useState<string | null>(null);
  const [removal, setRemoval] = useState<{ box: WarehouseCarton; item: WarehouseReceipt } | null>(null);
  const [reason, setReason] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [reopen, setReopen] = useState<WarehouseCarton | null>(null);
  const [moving,setMoving]=useState<{box:WarehouseCarton;item:WarehouseReceipt}|null>(null);
  const [moveTarget,setMoveTarget]=useState("");
  const [moveQty,setMoveQty]=useState("");
  const validMoveQty=!!moving && /^\d+$/.test(moveQty) && Number.isSafeInteger(Number(moveQty)) && Number(moveQty)>0 && Number(moveQty)<=moving.item.qty;
  const [dragged,setDragged]=useState<{box:WarehouseCarton;item:WarehouseReceipt}|null>(null);
  const [over,setOver]=useState("");
  const [market,setMarket]=useState(""),[shop,setShop]=useState(""),[status,setStatus]=useState("");
  const [selected,setSelected]=useState<Set<string>>(new Set()),[downloading,setDownloading]=useState(false);
  const [exportError,setExportError]=useState("");
  async function downloadSelected(all=false){
    if(!all&&!selected.size)return;
    setDownloading(true);setExportError("");
    try{
      const params=new URLSearchParams({export:all?"all":JSON.stringify([...selected])});
      if(all){params.set("market",market);params.set("store",shop);params.set("state",status);params.set("q",query)}
      const fresh=await request<WarehousePage>(`/api/warehouse?${params}`);
      const {warehouseWorkbook,downloadWorkbook}=await import("./exports/excel");
      const at=new Date().toISOString();
      await downloadWorkbook(warehouseWorkbook(fresh.cartons,at),`Запас-на-складе-${at.slice(0,10)}.xlsx`);
    }catch(e){setExportError((e as Error).message)}finally{setDownloading(false)}
  }
  async function move(source:{box:WarehouseCarton;item:WarehouseReceipt}, target:string){
    setError("");try {await w.command("warehouse.move",{receiptId:source.item.id,fromCartonId:source.box.id,version:source.box.version,toCartonId:target,qty:Number(moveQty)},"Товар перемещён. Выработка сохранена.");setMoving(null);}catch(e){setError((e as Error).message);}
  }
  const safely = useDraftNavigation();
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void request<WarehousePage>(
        `/api/warehouse?q=${encodeURIComponent(query)}&page=${page}&market=${encodeURIComponent(market)}&store=${encodeURIComponent(shop)}&state=${status}`,
        { signal: abort.signal },
      )
        .then(setData)
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, page, market, shop, status, w.state?.revision]);
  async function command(
    action: string,
    payload: Record<string, unknown>,
    message: string,
  ) {
    setError("");
    try {
      await w.command(action, payload, message);
      setConfirm(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function more(box: WarehouseCarton) {
    try {
      const next = await request<WarehousePage>(
        `/api/warehouse?carton=${encodeURIComponent(box.id)}&itemPage=${Math.floor(box.items.length / 30)}`,
      );
      const loaded = next.cartons[0];
      if (loaded?.version !== box.version)
        throw new Error("Состав изменился. Обновите список.");
      setData((d) =>
        d
          ? {
              ...d,
              cartons: d.cartons.map((c) =>
                c.id === box.id
                  ? { ...c, items: [...c.items, ...loaded.items] }
                  : c,
              ),
            }
          : d,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove() {
    if (!removal) return;
    setRemoveError("");
    try {
      await w.command("warehouse.remove", { receiptId: removal.item.id, cartonId: removal.box.id, version: removal.box.version, reason }, "Ошибочная запись удалена из складского короба.");
      setRemoval(null); setReason("");
    } catch (e) { setRemoveError((e as Error).message); }
  }
  return (
    <section aria-label="На склад" className="warehouse-stock-view">
      {supply && <ManualReceipt workspace={w} supply={supply} />}
      {manager && <div className="stock-manager-toolbar">
        <div><h2>Запас на складе</h2><p className="muted">Складские короба «1скл1», «2скл1» и другие — открытые и закрытые. Товар остаётся запасом до назначения в поставку.</p></div>
        <div className="tools">
          <NativeSelect label="Маркетплейс запаса" value={market} onChange={e=>{setMarket(e.target.value);setPage(0);setSelected(new Set())}}><option value="">Все маркетплейсы</option><option value="OZON">OZON</option><option value="WB">WB</option></NativeSelect>
          <Field label="Магазин запаса" placeholder="Все магазины" value={shop} onChange={e=>{setShop(e.target.value);setPage(0);setSelected(new Set())}}/>
          <NativeSelect label="Статус складского короба" value={status} onChange={e=>{setStatus(e.target.value);setPage(0);setSelected(new Set())}}><option value="">Открытые и закрытые</option><option value="open">Открытые</option><option value="closed">Закрытые</option></NativeSelect>
        </div>
        <div className="actions">
          <Button primary disabled={downloading||loading||!data?.total||w.busy} onClick={()=>void downloadSelected(true)}>{downloading?"Готовим Excel…":market||shop||status||query?`Скачать короба по фильтру · ${data?.total??0}`:`Скачать все короба · ${data?.total??0}`}</Button>
          <Button disabled={downloading||!selected.size||w.busy} onClick={()=>void downloadSelected()}>{`Скачать Excel выбранных · ${selected.size}`}</Button>
          <Button disabled={loading||!data?.cartons.length} onClick={()=>setSelected(previous=>new Set([...previous,...(data?.cartons.map(b=>b.id)||[])]))}>Выбрать всю страницу</Button>
          {selected.size>0&&<Button onClick={()=>setSelected(new Set())}>Снять выбор</Button>}
          <small className="muted">{data?`Найдено коробов: ${number(data.total)}. `:""}Отметьте нужные короба галочками. В Excel попадёт полный состав.</small>
        </div>
        {exportError&&<p className="form-error" role="alert">{exportError}</p>}
      </div>}
      <Button onClick={() => safely(() => {
        const url = new URL(location.href);
        url.searchParams.set("view", "work");
        url.searchParams.set("historySupply", "warehouse");
        location.assign(url.href);
      })}>История работы в запас</Button>
      <p className="label">Найти на складе</p>
      <Search
        label="Артикул, название или номер короба"
        value={query}
        onChange={(q) =>
          safely(() => {
            setQuery(q);
            setPage(0);
            setSelected(new Set());
          })
        }
      />
      <p className="readonly-note">
        Выберите короб при добавлении товара. Для переноса перетащите строку товара в открытый короб того же магазина или нажмите «Переместить».
      </p>
      {error ? (
        <div>
          <p className="form-error" role="alert">
            {error}
          </p>
          <Button disabled={w.busy} onClick={() => void w.refresh()}>
            Повторить загрузку
          </Button>
        </div>
      ) : null}
      {error ? null : loading ? (
        <p role="status">Загружаем складские короба…</p>
      ) : !data?.cartons.length ? (
        <Empty
          title={query ? "Ничего не найдено" : "Складских коробов пока нет"}
        >
          {query
            ? "Измените поиск."
            : "Добавьте товар выше или разместите излишек упаковки."}
        </Empty>
      ) : (
        data.cartons.map((box) => (
          <article className={`box-card stock-carton ${over===box.id ? "stock-drop-target" : ""}`} key={box.id}
            onDragOver={e=>{if(dragged && !w.busy && box.state==="open" && box.id!==dragged.box.id && box.market===dragged.box.market && box.store===dragged.box.store){e.preventDefault();e.dataTransfer.dropEffect="move";setOver(box.id);}}}
            onDragLeave={()=>setOver("")} onDrop={e=>{e.preventDefault();setOver("");if(dragged&&!w.busy){setMoving(dragged);setMoveTarget(box.id);setMoveQty(String(dragged.item.qty));setError("");}setDragged(null);}}>
            <div className="stock-carton-heading">
              <div>
                <h3>{manager && <input className="stock-select" type="checkbox" aria-label={`Выбрать складской короб ${box.label}`} checked={selected.has(box.id)} onChange={e=>setSelected(previous=>{const next=new Set(previous);if(e.target.checked)next.add(box.id);else next.delete(box.id);return next})}/>} {box.label}</h3>
                <small className="readonly-note">
                  {box.current
                    ? "Текущий короб"
                    : box.state === "closed"
                      ? "Закрыт"
                      : "Открыт"}{" "}
                  · {box.market} · Магазин {box.store} · {number(box.qty)} шт.
                </small>
              </div>
              <div className="actions">
                {box.current ? (
                  <Button
                    disabled={w.busy}
                    onClick={() =>
                      void command(
                        "warehouse.create",
                        { market: box.market, store: box.store },
                        "Новый складской короб создан.",
                      )
                    }
                  >
                    + Новый короб
                  </Button>
                ) : null}
                {box.state === "open" ? (
                  <Button
                    disabled={w.busy || !box.qty}
                    onClick={() => setConfirm(box)}
                  >
                    Закрыть короб
                  </Button>
                ) : <Button disabled={w.busy} onClick={() => setReopen(box)}>Открыть для исправления</Button>}
              </div>
            </div>
            {confirm?.id === box.id ? (
              <div className="stock-close-confirmation">
                <p>
                  Закрыть {box.label}? Новые товары будут направляться в другой
                  открытый или новый короб этого магазина.
                </p>
                <div className="actions">
                  <Button onClick={() => setConfirm(null)} disabled={w.busy}>
                    Отмена
                  </Button>
                  <Button
                    primary
                    disabled={w.busy}
                    onClick={() =>
                      void command(
                        "warehouse.close",
                        { cartonId: box.id, version: confirm.version },
                        "Складской короб закрыт.",
                      )
                    }
                  >
                    Подтвердить закрытие
                  </Button>
                </div>
              </div>
            ) : null}
            {box.items.map((item) => (
              <div className="stock-transfer" key={item.id} draggable={!w.busy && box.state==="open"}
                onDragStart={e=>{e.dataTransfer.setData("text/plain",item.id);e.dataTransfer.effectAllowed="move";setDragged({box,item});}} onDragEnd={()=>{setDragged(null);setOver("");}}>
                <ProductPhoto
                  importId={item.catalogImportId || ""}
                  id={item.photoId}
                  sourceUrl={item.photoUrl}
                  sku={item.sku}
                  className="stock-product-photo"
                />
                <div className="stock-product-info">
                  <strong className="stock-product-name">{item.name}</strong>
                  <span className="stock-product-sku">{item.sku}</span>
                  <small className="readonly-note">{item.supply}</small>
                  <span>{item.employee}</span>
                  {item.workId ? <small className="readonly-note">
                    {item.workQty && item.workQty!==item.qty ? `Часть упаковки ${number(item.workQty)} шт. · Кэф всей работы: ` : "Новая упаковка · Кэф: "}{item.coefficient != null ? Number(item.coefficient).toLocaleString("ru-RU", { maximumFractionDigits: 4 }) : "норма не задана"}
                  </small> : null}
                  <small className="readonly-note">
                    {dateTime(item.createdAt)} МСК
                  </small>
                  {item.comment ? <small>{item.comment}</small> : null}
                  <div className="stock-item-actions actions">
                    <Button disabled={w.busy} aria-label={`Этикетка ${item.sku}`} onClick={() => setLabelReceipt(item.id)}>Этикетка</Button>
                    <Button disabled={w.busy || box.state !== "open"} onClick={()=>{setMoving({box,item});setMoveTarget("");setMoveQty(String(item.qty));setError("");}}>Переместить</Button>
                    <Button danger disabled={w.busy || box.state !== "open" || !!(item.workId && item.workQty && item.workQty !== item.qty)} aria-label={`Удалить из короба ${item.sku}`}
                      onClick={() => { setRemoval({ box, item }); setReason(""); setRemoveError(""); }}>Удалить из короба</Button>
                  </div>
                  {item.workId && item.workQty && item.workQty !== item.qty ? <small className="readonly-note">Упаковка разделена. Отменить всю исходную работу можно в истории работы в запас.</small> : null}
                  {box.state === "closed" ? <small className="readonly-note">Для удаления откройте короб для исправления.</small> : null}
                </div>
                <strong className="stock-product-quantity">
                  {number(item.qty)} шт.
                </strong>
              </div>
            ))}
            {box.items.length < box.itemCount ? (
              <Button onClick={() => void more(box)}>
                Показать ещё поступления · {box.itemCount - box.items.length}
              </Button>
            ) : null}
          </article>
        ))
      )}
      {data ? (
        <Pagination
          page={page}
          total={data.total}
          size={5}
          onChange={setPage}
        />
      ) : null}
      {moving ? <Dialog title="Переместить товар" kicker={`Из короба ${moving.box.label}`} onClose={()=>{if(!w.busy)setMoving(null);}} busy={w.busy}><div className="stack">
        <strong>{moving.item.sku} · {number(moving.item.qty)} шт.</strong><p>Укажите количество для переноса. Остаток останется в исходном коробе. Работа и кэф сохранятся.</p>
        <Field label="Количество для переноса, шт." inputMode="numeric" value={moveQty} disabled={w.busy} onChange={e=>setMoveQty(e.target.value)}/>
        <div className="actions"><Button disabled={w.busy} onClick={()=>setMoveQty(String(moving.item.qty))}>Все {number(moving.item.qty)} шт.</Button><small>В исходном останется: {validMoveQty?number(moving.item.qty-Number(moveQty)):"—"} шт.</small></div>
        <StockBoxSelect market={moving.box.market} store={moving.box.store} exclude={moving.box.id} value={moveTarget} onChange={setMoveTarget} disabled={w.busy} revision={w.state?.revision}/>
        {error?<p role="alert" className="form-error">{error}</p>:null}
        <Button primary disabled={w.busy||!moveTarget||!validMoveQty} onClick={()=>void move(moving,moveTarget)}>Переместить</Button>
      </div></Dialog>:null}
      {labelReceipt ? <LabelDialog warehouseReceiptId={labelReceipt} onClose={() => setLabelReceipt(null)} /> : null}
      {removal ? <Dialog title="Удалить ошибочную запись?" kicker={`Складской короб · ${removal.box.label}`} onClose={() => { if (!w.busy) setRemoval(null); }} busy={w.busy}>
        <div className="stack">
          <strong>{removal.item.sku} · {number(removal.item.qty)} шт.</strong>
          <p>{removal.item.name}</p>
          <p>{removal.item.workId
            ? `Товар будет убран из короба. Связанная упаковка сотрудника «${removal.item.employee}» и её кэф будут отменены, в том числе в РИТМ. Записи резки и другая работа сохранятся.`
            : "Товар будет убран из короба. Ранее выполненная работа и кэфы не отменяются. При переносе из поставки количество снова станет доступно для размещения."} История исправления сохранится.</p>
          <Field label="Причина удаления" value={reason} maxLength={500} disabled={w.busy} onChange={e => setReason(e.target.value)} />
          {removeError ? <p className="form-error" role="alert">{removeError}</p> : null}
          <div className="actions"><Button disabled={w.busy} onClick={() => setRemoval(null)}>Оставить в коробе</Button><Button danger disabled={w.busy} onClick={() => void remove()}>{w.busy ? "Удаляем…" : "Удалить из короба"}</Button></div>
        </div>
      </Dialog> : null}
      {reopen ? <Dialog title="Открыть короб для исправления?" kicker={`Складской короб · ${reopen.label}`} onClose={() => { if (!w.busy) setReopen(null); }} busy={w.busy}>
        <div className="stack"><p>Короб станет открытым. После исправления состава закройте его снова. Товары и кэфы при открытии не меняются.</p>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="actions"><Button disabled={w.busy} onClick={() => setReopen(null)}>Отмена</Button><Button primary disabled={w.busy} onClick={async () => {
            setError("");
            try { await w.command("warehouse.reopen", { cartonId: reopen.id, version: reopen.version }, "Складской короб открыт для исправления."); setReopen(null); }
            catch (e) { setError((e as Error).message); }
          }}>Открыть короб</Button></div>
        </div>
      </Dialog> : null}
    </section>
  );
}
function ManualReceipt({
  workspace: w,
  supply,
}: {
  workspace: Workspace;
  supply: Supply;
}) {
  const [market, setMarket] = useState<string>(supply.market),
    [receiptMode, setReceiptMode] = useState("packing"),
    [operation, setOperation] = useState<Operation>("packing"),
    [additionalWork, setAdditionalWork] = useState(false),
    [additionalOperation, setAdditionalOperation] = useState<Operation>("assembly"),
    [additionalEmployee, setAdditionalEmployee] = useState(""),
    [additionalQty, setAdditionalQty] = useState(""),
    [store, setStore] = useState(
      /^\d+$/.test(supply.store) ? supply.store : "",
    ),
    [sku, setSku] = useState(""),
    [qty, setQty] = useState(""),
    [employeeId, setEmployee] = useState(() => {
      try {
        return sessionStorage.getItem("assembly.v2.employee") || "";
      } catch {
        return "";
      }
    }),
    [comment, setComment] = useState(""),
    [catalog, setCatalog] = useState<CatalogPage | null>(null),
    [chosen, setChosen] = useState(""),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [stockBox,setStockBox]=useState("");
  useEffect(()=>setStockBox(""),[market,store]);
  const hasPacking = receiptMode === "receipt" || operation === "packing" || (additionalWork && additionalOperation === "packing");
  const quantity = useRef<HTMLInputElement>(null);
  const safely = useDraftNavigation();
  useDirty(!!(sku || qty || comment || additionalWork));
  useEffect(() => {
    const abort = new AbortController();
    setCatalog(null);
    setChosen("");
    setLoading(false);
    if (!sku.trim() || !store) return;
    setLoading(true);
    const timer = setTimeout(() => {
      void request<CatalogPage>(
        `/api/catalog?market=${market}&store=${encodeURIComponent(store)}&q=${encodeURIComponent(sku)}`,
        { signal: abort.signal },
      )
        .then((p) => {
          setCatalog(p);
          const exact = p.items.filter(
            (e) =>
              e.sku.toLocaleUpperCase("ru") ===
              sku.trim().toLocaleUpperCase("ru"),
          );
          if (exact.length === 1) setChosen(exact[0].id);
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [market, store, sku]);
  const product = catalog?.items.find((e) => e.id === chosen);
  const additionalQtyValid = /^\d+$/.test(additionalQty) && Number.isSafeInteger(Number(additionalQty)) && Number(additionalQty) > 0 && Number(additionalQty) <= 2147483647;
  const [labelProduct, setLabelProduct] = useState<{ entryId: string; importId: string } | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (
      !product ||
      !catalog ||
      !/^\d+$/.test(qty) ||
      !Number.isSafeInteger(Number(qty)) ||
      Number(qty) <= 0
    ) {
      setError(
        "Выберите товар из справочника и введите целое количество больше нуля.",
      );
      return;
    }
    if (receiptMode === "packing" && additionalWork && (!additionalEmployee || additionalOperation === operation || !additionalQtyValid)) {
      setError("Для дополнительной работы выберите операцию, сотрудника и целое количество больше нуля.");
      return;
    }
    if(hasPacking && !stockBox){setError("Выберите складской короб или создание нового.");return;}
    try {
      const saved = await w.command(
        "warehouse.receive",
        {
          market,
          store,
          entryId: product.id,
          catalogImportId: catalog.active?.id,
          qty: Number(qty),
          employeeId,
          comment,
          receiptMode,
          operation,
          warehouseCartonId:stockBox === "new" ? undefined : stockBox,
          newWarehouseCarton:stockBox === "new",
          ...(receiptMode === "packing" && additionalWork ? { additionalWork: { operation: additionalOperation, employeeId: additionalEmployee, qty: Number(additionalQty) } } : {}),
        },
        receiptMode === "packing" ? additionalWork ? "Обе операции сохранены. Каждая добавлена в выработку своего сотрудника." : `${operationLabels[operation]} в запас записана. Работа добавлена в выработку.` : "Готовый остаток принят на склад без повторного начисления выработки.",
      );
      try {
        sessionStorage.setItem("assembly.v2.employee", employeeId);
      } catch {}
      if(typeof saved.warehouseCartonId === "string")setStockBox(saved.warehouseCartonId);
      setSku("");
      setQty("");
      setComment("");
      setAdditionalWork(false);
      setAdditionalEmployee("");
      setAdditionalQty("");
      quantity.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <details className="manual-warehouse">
      <summary>Записать работу в запас / добавить готовый товар</summary>
      <form noValidate onSubmit={save} className="stack">
        <NativeSelect label="Что записываем" value={receiptMode} disabled={w.busy} onChange={e => setReceiptMode(e.target.value)}>
          <option value="packing">Работа в запас — учесть кэф</option>
          <option value="receipt">Приём готового остатка — без кэфа</option>
        </NativeSelect>
        {receiptMode === "packing" ? (
          <NativeSelect label="Что сделали" value={operation} disabled={w.busy} onChange={e => {
            const next = e.target.value as Operation;
            setOperation(next);
            if (additionalOperation === next) setAdditionalOperation(next === "packing" ? "assembly" : "packing");
          }}>
            {(["cut", "assembly", "packing"] as const).map(op => <option key={op} value={op}>{operationLabels[op]}</option>)}
          </NativeSelect>
        ) : null}
        <div className="manual-warehouse-grid">
          <NativeSelect
            label="Маркетплейс"
            value={market}
            disabled={w.busy}
            onChange={(e) => setMarket(e.target.value)}
          >
            <option value="OZON">OZON</option>
            <option value="WB">WB</option>
          </NativeSelect>
          <Field
            label="Магазин"
            inputMode="numeric"
            value={store}
            disabled={w.busy}
            onChange={(e) => setStore(e.target.value)}
          />
          <Field
            label="Артикул"
            placeholder="Например, LT0001.A5427"
            value={sku}
            disabled={w.busy}
            onChange={(e) => setSku(e.target.value)}
          />
          <div>
            <label className="label" htmlFor="warehouse-quantity">
              Количество, шт.
            </label>
            <input
              ref={quantity}
              id="warehouse-quantity"
              className="field"
              inputMode="numeric"
              value={qty}
              disabled={w.busy}
              onChange={(e) => setQty(e.target.value)}
            />
          </div>
        </div>
        {loading ? (
          <p role="status">Подгружаем карточку из базы…</p>
        ) : catalog?.items.length ? (
          <NativeSelect
            label="Товар из справочника"
            value={chosen}
            disabled={w.busy}
            onChange={(e) => setChosen(e.target.value)}
          >
            <option value="">Выберите товар</option>
            {catalog.items.map((e) => (
              <option value={e.id} key={e.id}>
                {e.sku} · {e.name}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <p className="readonly-note">
            {sku
              ? "Товар не найден для выбранного магазина. Проверьте артикул."
              : "Введите артикул — подгрузим карточку из базы."}
          </p>
        )}
        {product ? (
          <div className="manual-warehouse-product">
            <ProductPhoto
              importId={catalog?.active?.id || ""}
              id={product.photoId}
              sourceUrl={product.photoUrl}
              sku={product.sku}
            />
            <div>
              <strong>{product.sku}</strong>
              <span>{product.name}</span>
              <Button disabled={w.busy || !catalog?.active?.id} onClick={() => setLabelProduct({ entryId: product.id, importId: catalog!.active!.id })}>Этикетка</Button>
            </div>
          </div>
        ) : null}
        {hasPacking?<StockBoxSelect market={market} store={store} value={stockBox} onChange={setStockBox} disabled={w.busy} revision={w.state?.revision}/>:null}
        <NativeSelect
          label={receiptMode === "packing" ? "Кто выполнил работу" : "Кто добавляет"}
          value={employeeId}
          disabled={w.busy}
          onChange={(e) => setEmployee(e.target.value)}
        >
          <option value="">Выберите своё имя</option>
          {w.state?.employees
            .filter((e) => e.active)
            .map((e) => (
              <option value={e.id} key={e.id}>
                {e.name}
              </option>
            ))}
        </NativeSelect>
        {receiptMode === "packing" ? <>
          {!additionalWork ? <div className="stock-add-operation">
            <Button disabled={w.busy} aria-expanded={false} onClick={() => setAdditionalWork(true)}>+ Добавить операцию</Button>
            <span className="readonly-note">Укажите, кто резал и кто упаковал</span>
          </div> : <section className="stock-extra-operation" aria-label="Дополнительная работа">
            <div className="stock-extra-heading">
              <strong>Дополнительная работа</strong>
              <Button disabled={w.busy} aria-label="Убрать дополнительную операцию" onClick={() => { setAdditionalWork(false); setAdditionalEmployee(""); setAdditionalQty(""); }}>Убрать</Button>
            </div>
            <div className="stock-extra-grid">
            <NativeSelect label="Операция" aria-label="Дополнительная операция" value={additionalOperation} disabled={w.busy} onChange={e => setAdditionalOperation(e.target.value as Operation)}>
              {(["cut", "assembly", "packing"] as const).filter(op => op !== operation).map(op => <option key={op} value={op}>{operationLabels[op]}</option>)}
            </NativeSelect>
            <NativeSelect label="Сотрудник" aria-label="Кто выполнил дополнительную операцию" value={additionalEmployee} disabled={w.busy} onChange={e => setAdditionalEmployee(e.target.value)}>
              <option value="">Выберите сотрудника</option>
              {w.state?.employees.filter(e => e.active).map(e => <option value={e.id} key={e.id}>{e.name}</option>)}
            </NativeSelect>
            <Field label="Количество, шт." aria-label="Количество дополнительной работы, шт." inputMode="numeric" placeholder="Например, 100" value={additionalQty} disabled={w.busy} onChange={e => setAdditionalQty(e.target.value)} />
            </div>
            <p className="readonly-note">У каждой операции — своё количество, сотрудник и кэф. На склад поступит только количество упаковки.</p>
          </section>}
        </> : null}
        <Field
          label="Комментарий · необязательно"
          maxLength={500}
          value={comment}
          disabled={w.busy}
          onChange={(e) => setComment(e.target.value)}
        />
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="manual-warehouse-actions">
          <Button
            primary
            type="submit"
            disabled={
              w.busy ||
              !product ||
              !employeeId ||
              (receiptMode === "packing" && additionalWork && (!additionalEmployee || !additionalQtyValid)) ||
              !/^\d+$/.test(qty) ||
              Number(qty) <= 0
            }
          >
            {w.busy ? "Сохраняем…" : receiptMode === "packing" ? "Записать работу в запас" : "Добавить на склад"}
          </Button>
          <Button
            disabled={w.busy}
            onClick={() =>
              safely(() => {
                setSku("");
                setQty("");
                setComment("");
                setError("");
                setAdditionalWork(false);
                setAdditionalEmployee("");
                setAdditionalQty("");
              })
            }
          >
            Очистить
          </Button>
        </div>
        <p className="readonly-note">
          {receiptMode === "packing"
            ? additionalWork
              ? "Обе операции сохранятся вместе. Кэф каждой получит указанный сотрудник. Готовый товар добавится на склад один раз, только при наличии упаковки."
              : operation === "packing"
              ? "Упаковка добавит готовый товар на склад и начислит кэф выбранному сотруднику."
              : "Резка начислит кэф выбранному сотруднику. Готовый остаток не увеличится — упаковку отдельно запишет тот, кто её выполнит."
            : "Принимаем уже готовый остаток. Повторно упаковку и кэф не начисляем."} Повтор запроса не создаёт вторую запись.
        </p>
      </form>
      {labelProduct ? <LabelDialog catalogEntryId={labelProduct.entryId} catalogImportId={labelProduct.importId} onClose={() => setLabelProduct(null)} /> : null}
    </details>
  );
}
