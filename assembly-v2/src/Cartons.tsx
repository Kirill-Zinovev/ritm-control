import { useState } from "react";
import { warehouseCity } from "../shared/warehouse-filter";
import { ManagerPanel } from "./ManagerPanel";
import type { Carton } from "../shared/model";
import { countLabel, number } from "../shared/model";
import type { Workspace } from "./useWorkspace";
import { Button, Dialog, Empty, Field, NativeSelect, Pagination, Search } from "./ui";
import { CartonProduct } from "./CartonProduct";
import { Printer } from "lucide-react";
import { CartonLabel } from "./CartonLabel";
export function CartonDetails({
  box,
  workspace: w,
  onClose,
  onReopened,
  inline=false,
}: {
  box: Carton;
  workspace: Workspace;
  onClose(): void;
  onReopened?(cartonId: string): void;
  inline?:boolean;
}) {
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmReopen, setConfirmReopen] = useState<Pick<Carton, "closedAt"> | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [allItems,setAllItems]=useState(false);
  const [printing,setPrinting]=useState(false);
  const current = w.state?.cartons.find((b) => b.id === box.id) ?? box;
  const canReopen = !!onReopened && current.state === "closed" && !current.dispatchId;
  async function close() {
    try {
      await w.command(
        "carton.close",
        {
          cartonId: current.id,
          items: current.items
            .map((i) => ({ id: i.id, qty: i.qty }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        },
        `${current.label} закрыт. Он ещё не отправлен.`,
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function extract() {
    try {
      await w.command(
        "allocation.remove",
        { allocationId: remove, reason },
        "Товар извлечён из короба. История сохранена.",
      );
      setRemove(null);
      setReason("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function reopen() {
    if (!confirmReopen || !canReopen) return;
    setError("");
    try {
      await w.command(
        "carton.reopen",
        { cartonId: current.id, closedAt: confirmReopen.closedAt },
        `${current.label} снова открыт у сборщиков.`,
      );
      setConfirmReopen(null);
      onReopened?.(current.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const Surface=inline ? ManagerPanel : Dialog;
  return (
    <Surface
      title={`${current.label} · ${current.state === "open" ? "Открыт" : "Закрыт"}`}
      className="legacy-carton-details"
      busy={w.busy}
      onClose={onClose}
    >
      <p className="muted">
        {current.market} · {current.store} · {current.destination}
      </p>
      <div className="box-summary">
        <strong>{number(current.qty)} шт.</strong>
        <span>
          {current.capacityUnknown
            ? "Вместимость не уточнена"
            : `Заполнен на ${Math.round(current.fill * 100)}%`}
        </span>
      </div>
      {inline && <><progress max={1} value={current.fill} aria-label="Заполнение выбранного короба"/><h3 className="carton-composition-heading">Состав короба · {current.items.length}</h3></>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Товар / поставка</th>
              <th>Количество</th>
              {current.state === "open" ? <th>Действие</th> : null}
            </tr>
          </thead>
          <tbody>
            {(inline && !allItems ? current.items.slice(0,3) : current.items).map((i) => (
              <tr key={i.id}>
                <td>
                  <CartonProduct item={i} />
                </td>
                <td>
                  <strong className="carton-item-quantity">
                    {number(i.qty)} шт.
                  </strong>
                </td>
                {current.state === "open" ? (
                  <td>
                    <Button
                      onClick={() => {
                        setRemove(i.id);
                        setReason("");
                        setError("");
                      }}
                      disabled={w.busy}
                    >
                      Извлечь
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {inline && current.items.length>3 && <Button onClick={()=>setAllItems(!allItems)}>{allItems?'Свернуть состав':`Показать весь состав · ${current.items.length}`}</Button>}
      {!current.items.length ? (
        <p className="muted">
          В коробе пока нет товаров. Добавьте их на экране сборки.
        </p>
      ) : null}
      {remove ? (
        <form
          className="stack callout"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void extract();
          }}
        >
          <Field
            label="Почему извлекаем товар"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={error || undefined}
          />
          <p className="muted">
            Извлечётся выбранное вложение целиком. Упаковка останется
            записанной.
          </p>
          <div className="actions">
            <Button onClick={() => setRemove(null)}>Отмена</Button>
            <Button type="submit" disabled={w.busy || reason.trim().length < 3}>
              Извлечь вложение
            </Button>
          </div>
        </form>
      ) : null}
      {error && !remove ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {current.state === "open" && !remove ? (
        <div className="stack">
          {confirmClose ? (
            <div className="callout">
              <p>
                Проверьте состав: {number(current.qty)} шт.,{" "}
                {countLabel(current.items.length, [
                  "вложение",
                  "вложения",
                  "вложений",
                ])}
                . После закрытия добавлять товары нельзя. Короб останется на
                складе до отгрузки.
              </p>
              <div className="actions">
                <Button onClick={() => setConfirmClose(false)}>
                  Вернуться к составу
                </Button>
                <Button primary disabled={w.busy} onClick={() => void close()}>
                  Закрыть короб
                </Button>
              </div>
            </div>
          ) : (
            <Button
              primary
              disabled={w.busy || !current.qty}
              onClick={() => setConfirmClose(true)}
            >
              Проверить и закрыть короб
            </Button>
          )}
        </div>
      ) : null}
      {canReopen && <div className="stack">
        {confirmReopen ? <div className="callout">
          <p>Короб снова появится у сборщиков в списке открытых. Содержимое сохранится.</p>
          <div className="actions">
            <Button disabled={w.busy} onClick={() => { setConfirmReopen(null); setError(""); }}>Отмена</Button>
            <Button primary disabled={w.busy} onClick={() => void reopen()}>Открыть короб</Button>
          </div>
        </div> : <Button disabled={w.busy} onClick={() => {
          setError("");
          setConfirmReopen({ closedAt: current.closedAt });
        }}>Открыть для исправления</Button>}
      </div>}
      {onReopened && current.state === "closed" && current.dispatchState === "draft" && (
        <p className="muted">Чтобы открыть короб, сначала отмените подготовленную отгрузку.</p>
      )}
      {inline && <div className="carton-label-action"><Button onClick={()=>setPrinting(true)}><Printer size={17}/>Этикетка короба</Button></div>}
      {printing && <CartonLabel box={current} onClose={()=>setPrinting(false)}/>}
    </Surface>
  );
}
export function Cartons({ workspace: w }: { workspace: Workspace }) {
  const [search,setSearch]=useState(''),[city,setCity]=useState(''),[market,setMarket]=useState(''),[shop,setShop]=useState(''),[status,setStatus]=useState('open');
  const [page,setPage]=useState(0),[openId,setOpenId]=useState<string|null>(null);
  const state=w.state;if(!state)return null;
  const cities=[...new Map(state.cartons.map(b=>{const c=warehouseCity(b);return [c.key,c] as const})).values()].sort((a,b)=>a.label.localeCompare(b.label,'ru'));
  const shops=[...new Set(state.cartons.filter(b=>(!market||b.market===market)&&(!city||warehouseCity(b).key===city)).map(b=>b.store))].sort();
  const boxes=state.cartons.filter(b=>(!city||warehouseCity(b).key===city)&&(!market||b.market===market)&&(!shop||b.store===shop)&&(!status||b.state===status)&&`${b.label} ${b.destination} ${b.items.map(i=>i.sku).join(' ')}`.toLocaleLowerCase('ru-RU').includes(search.toLocaleLowerCase('ru-RU')));
  const pg=Math.min(page,Math.max(0,Math.ceil(boxes.length/30)-1));
  const selected=openId==='' ? undefined : boxes.find(b=>b.id===openId) ?? boxes[pg*30];
  return <main className="content manager-cartons">
    <div className="page-title"><div><h1>Короба</h1><p className="muted">Состав и заполнение коробов, которые ещё не отправлены.</p></div></div>
    <div className="toolbar"><Search label="Номер короба или артикул" value={search} onChange={v=>{setSearch(v);setPage(0)}}/>
      <NativeSelect label="Город" value={city} onChange={e=>{setCity(e.target.value);setShop('');setPage(0)}}><option value="">Все города</option>{cities.map(c=><option key={c.key} value={c.key}>{c.label}</option>)}</NativeSelect>
      <NativeSelect label="Магазин" value={shop} onChange={e=>{setShop(e.target.value);setPage(0)}}><option value="">Все магазины</option>{shops.map(s=><option key={s} value={s}>{s || 'Не определён'}</option>)}</NativeSelect>
      <NativeSelect label="Маркетплейс" value={market} onChange={e=>{setMarket(e.target.value);setShop('');setPage(0)}}><option value="">Все</option><option>OZON</option><option>WB</option></NativeSelect>
    </div>
    <div className="tabs">{[['open','Открытые'],['closed','Закрытые'],['','Все']].map(([key,label])=><button type="button" className="tab" key={key} aria-pressed={status===key} onClick={()=>{setStatus(key);setPage(0)}}>{label}</button>)}</div>
    {boxes.length ? <div className="cartons-workspace"><section className="cartons-list-pane"><div className="table-scroll"><table className="manager-carton-table"><thead><tr><th>Короб</th><th>Направление</th><th>Товаров</th><th>Заполнение</th></tr></thead><tbody>
      {boxes.slice(pg*30,(pg+1)*30).map(b=><tr key={b.id} className={selected?.id===b.id?'is-selected':''}><td><button className="text-action carton-select" aria-pressed={selected?.id===b.id} onClick={()=>setOpenId(b.id)}>{b.label}</button><small className="muted">{b.dispatchId?'На отгрузке':b.state==='open'?'Открыт':'Закрыт'}</small></td><td>{warehouseCity(b).label}<small>Магазин {b.store || 'не определён'}</small><span className={`market-pill ${b.market.toLowerCase()}`}>{b.market}</span></td><td><strong>{number(b.qty)} шт.</strong><small>{countLabel(b.items.length,['вложение','вложения','вложений'])}</small></td><td>{b.capacityUnknown?'Норма не уточнена':`${Math.round(b.fill*100)}%`}{!b.capacityUnknown && <progress max={1} value={b.fill} aria-label={`Заполнение ${b.label}`}/>}</td></tr>)}
    </tbody></table></div><Pagination page={pg} size={30} total={boxes.length} onChange={setPage}/></section>
    {selected && <CartonDetails key={selected.id} inline box={selected} workspace={w} onClose={()=>setOpenId('')}
      onReopened={id=>{setStatus('open');setPage(0);setOpenId(id)}}/>}</div> : <Empty title="Коробов по выбранным фильтрам нет"><Button onClick={()=>{setSearch('');setCity('');setMarket('');setShop('');setStatus('')}}>Сбросить фильтры</Button></Empty>}
  </main>;
}
