import { Fragment, lazy, Suspense, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { ProductPhoto } from "./ProductPhoto";
import { CartonProduct } from "./CartonProduct";
import type { Carton, Dispatch, Snapshot } from "../shared/model";
import { countLabel, dateTime, number, sameScope } from "../shared/model";
import type { Workspace } from "./useWorkspace";
import { request } from "./useWorkspace";
import { filterWarehouseCartons, warehouseCity } from "../shared/warehouse-filter";
import { Button, Dialog, Empty, NativeSelect, Pagination, Search } from "./ui";
import { CartonDetails } from "./Cartons";
import { WarehouseStock } from "./WarehouseStock";
const ExportDialog = lazy(() => import("./exports/ExportDialog"));
export function Warehouse({ workspace: w }: { workspace: Workspace }) {
  const [tab, setTab] = useState("ready");
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState("");
  const [city, setCity] = useState("");
  const [shop, setShop] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState(false);
  const [details, setDetails] = useState<Carton | null>(null);
  const [send, setSend] = useState<Dispatch | null>(null);
  const [cancel, setCancel] = useState<Dispatch | null>(null);
  const [exporting, setExporting] = useState<Dispatch | null>(null);
  const [error, setError] = useState("");
  const [expanded,setExpanded]=useState<string|null>(null);
  const state = w.state;
  if (!state) return null;
  const ready = state.cartons.filter(
    (b) => b.state === "closed" && !b.dispatchId,
  );
  const selection = ready.filter((b) => selected.has(b.id));
  const first = selection[0];
  const filters = {market, city, store: shop, query};
  const filtered = filterWarehouseCartons(ready, filters);
  const cities = [...new Map(ready.filter(b => !market || b.market === market).map(b => {
    const c = warehouseCity(b); return [c.key, c] as const;
  })).values()].sort((a, b) => a.label.localeCompare(b.label, "ru"));
  const shops = [...new Set(ready.filter(b => (!market || b.market === market) && (!city || warehouseCity(b).key === city)).map(b => b.store))].sort((a,b)=>a.localeCompare(b,"ru",{numeric:true}));
  const pg = Math.min(page, Math.max(0, Math.ceil(filtered.length / 30) - 1));
  const rows = filtered.slice(pg * 30, (pg + 1) * 30);
  const dispatches = state.dispatches.filter((d) =>
    tab === "draft" ? d.state === "draft" : d.state !== "draft",
  );
  function toggle(box: Carton) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(box.id)) next.delete(box.id);
      else next.add(box.id);
      return next;
    });
  }
  async function downloadStock(boxes: Carton[]) {
    if (!boxes.length) return;
    setDownloading(true); setError("");
    try {
      const fresh = await request<Snapshot>("/api/state?cartons=all");
      const ids = new Set(boxes.map(b => b.id));
      const current = fresh.cartons.filter(b => ids.has(b.id) && b.state === "closed" && !b.dispatchId);
      if (current.length !== ids.size) throw new Error("Статус выбранных коробов изменился. Обновите список и повторите выгрузку.");
      const capturedAt = new Date().toISOString();
      const {accountWorkbook, downloadWorkbook} = await import("./exports/excel");
      const book = accountWorkbook({createdAt: capturedAt, payload: {cartons: current}});
      const info = book.addWorksheet("Параметры выгрузки");
      info.columns = [{header:"Параметр",width:30},{header:"Значение",width:70}];
      info.addRows([["Сформирован",capturedAt],["Ревизия склада",fresh.revision],["Город / направление",cities.find(c=>c.key===city)?.label || "Выбранные короба"],["Коробов",current.length],["Изделий, шт.",current.reduce((n,b)=>n+b.qty,0)],["Статус","Закрыты, ещё не отправлены. Скачивание не резервирует короба."]]);
      const label=(cities.find(c=>c.key===city)?.label || "выбранные").replace(/[<>:"/\\|?*]/g,"_");
      await downloadWorkbook(book, `Короба-${label}-${capturedAt.slice(0,10)}.xlsx`);
    } catch(e) {setError((e as Error).message);} finally {setDownloading(false);}
  }
  async function create() {
    try {
      const r = await w.command(
        "dispatch.create",
        { cartonIds: selection.map((b) => b.id) },
        "Отгрузка подготовлена. Короба зарезервированы; выезд ещё не подтверждён.",
      );
      setReview(false);
      setSelected(new Set());
      setTab("draft");
      setExporting(
        w.state?.dispatches.find((d) => d.id === r.dispatchId) ?? null,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function confirmSend() {
    if (!send) return;
    try {
      await w.command(
        "dispatch.send",
        { dispatchId: send.id, confirmed: true },
        `${send.label}: фактический выезд записан.`,
      );
      setSend(null);
      setTab("history");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function confirmCancel() {
    if (!cancel) return;
    try {
      await w.command(
        "dispatch.cancel",
        { dispatchId: cancel.id },
        "Отгрузка отменена. Короба снова доступны для выбора.",
      );
      setCancel(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main className="content warehouse">
      <div className="page-title">
        <div>
          <h1>Склад и отгрузки</h1>
          <p className="muted">
            Короба поставок, запас на складе и подготовка отгрузок.
          </p>
        </div>
      </div>
      {tab !== "stock" && <div className="warehouse-stats">
        <div>
          <strong>{number(ready.length)}</strong>
          <span>Готовы к отгрузке</span>
        </div>
        <div>
          <strong>{number(ready.reduce((n, b) => n + b.qty, 0))}</strong>
          <span>Изделий в коробах</span>
        </div>
        <div>
          <strong>
            {number(state.dispatches.filter((d) => d.state === "draft").length)}
          </strong>
          <span>Подготовлено отгрузок</span>
        </div>
      </div>}
      <div className="tabs warehouse-tabs">
        {[
          ["ready", "Готовы к отгрузке"],
          ["stock", "Запас на складе"],
          ["draft", "Подготовленные"],
          ["history", "История"],
        ].map(([key, label]) => (
          <button
            type="button"
            key={key}
            className="tab"
            aria-pressed={tab === key}
            onClick={() => {
              setTab(key);
              setPage(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "stock" ? <WarehouseStock workspace={w} manager /> : tab === "ready" ? (
        <>
          <div className="tools">
            <Search
              label="Короб, артикул, магазин или склад"
              value={query}
              onChange={(q) => {
                setQuery(q);
                setPage(0);
                setSelected(new Set());
              }}
            />
            <NativeSelect
              label="Маркетплейс"
              value={market}
              onChange={(e) => {
                setMarket(e.target.value);
                setCity(""); setShop("");
                setPage(0);
                setSelected(new Set());
              }}
            >
              <option value="">Все</option>
              <option value="WB">WB</option>
              <option value="OZON">OZON</option>
            </NativeSelect>
            <NativeSelect label="Город / направление" value={city} onChange={e => {setCity(e.target.value);setShop("");setPage(0);setSelected(new Set());}}>
              <option value="">Все города</option>
              {cities.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </NativeSelect>
            <NativeSelect label="Магазин" value={shop} onChange={e => {setShop(e.target.value);setPage(0);setSelected(new Set());}}>
              <option value="">Все магазины</option>
              {shops.map(s => <option key={s} value={s}>{s}</option>)}
            </NativeSelect>
          </div>
          <div className="actions">
            <Button disabled={downloading || w.busy || !filtered.length} onClick={() => void downloadStock(filtered)}>
              <Download size={16}/>{downloading ? "Готовим Excel…" : `${city ? "Скачать Excel по городу" : market||shop||query ? "Скачать короба по фильтру" : "Скачать все короба"} · ${countLabel(filtered.length, ["короб", "короба", "коробов"])}`}
            </Button>
            <span className="muted">{city ? `По фильтрам: ${countLabel(filtered.length, ["короб", "короба", "коробов"])} · ${number(filtered.reduce((n,b)=>n+b.qty,0))} шт.` : "Выберите город или отметьте нужные короба. В Excel будут номера, состав и сводка."}</span>
          </div>
          {error ? <p className="field-error" role="alert">{error}</p> : null}
          {rows.length ? (
            <div className="table-scroll">
              <table className="warehouse-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Выбрать все короба на этой странице"
                        checked={
                          !!rows.length && rows.every((b) => selected.has(b.id))
                        }
                        onChange={(e) => {
                          if (!e.target.checked) {
                            setSelected(
                              (s) =>
                                new Set(
                                  [...s].filter(
                                    (id) => !rows.some((b) => b.id === id),
                                  ),
                                ),
                            );
                            return;
                          }
                          setSelected(
                            (s) =>
                              new Set([
                                ...s,
                                ...rows.map((b) => b.id),
                              ]),
                          );
                        }}
                      />
                    </th>
                    <th>Короб</th>
                    <th>Магазин / назначение</th>
                    <th>Состав</th>
                    <th>Изделий</th>
                    <th>Закрыт, МСК</th>
                    <th>Действие</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <Fragment key={b.id}><tr
                      className={selected.has(b.id) ? "is-selected" : ""}
                    >
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Выбрать ${b.label}`}
                          checked={selected.has(b.id)}
                          onChange={() => toggle(b)}
                        />
                      </td>
                      <td>
                        <button className="text-action carton-select" aria-expanded={expanded===b.id} onClick={()=>setExpanded(expanded===b.id?null:b.id)}><ChevronDown size={16}/>{b.label}</button>
                        <small>{b.market}</small>
                      </td>
                      <td>
                        {warehouseCity(b).label}
                        <small>Магазин {b.store} · {b.destination}</small>
                      </td>
                      <td>
                        <div className="composition-thumbs">{b.items.slice(0,2).map(i=><ProductPhoto key={i.id} importId={i.catalogImportId || ''} id={i.photoId || null} sourceUrl={i.photoUrl} sku={i.sku}/>)}{b.items.length>2 && <span>+{b.items.length-2}</span>}</div>
                        {countLabel(b.items.length, [
                          "вложение",
                          "вложения",
                          "вложений",
                        ])}
                        <small>
                          {b.items
                            .slice(0, 2)
                            .map((i) => i.sku)
                            .join(", ")}
                          {b.items.length > 2 ? "…" : ""}
                        </small>
                      </td>
                      <td className="numeric"><strong>{number(b.qty)}</strong></td>
                      <td>{b.closedAt ? dateTime(b.closedAt) : "—"}</td>
                      <td>
                        <Button onClick={() => setDetails(b)}>Состав</Button>
                      </td>
                    </tr>
                    {expanded===b.id && <tr className="warehouse-expanded"><td colSpan={7}><div>{b.items.slice(0,3).map(i=><div className="warehouse-expanded-product" key={i.id}><CartonProduct item={i}/><strong>{number(i.qty)} шт.</strong></div>)}<Button onClick={()=>setDetails(b)}>Весь состав · {b.items.length}</Button></div></td></tr>}</Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title={
                ready.length ? "Коробов по фильтру нет" : "Нет готовых коробов"
              }
            >
              {ready.length ? (
                <Button
                  onClick={() => {
                    setQuery("");
                    setMarket("");
                    setCity(""); setShop(""); setSelected(new Set());
                  }}
                >
                  Сбросить фильтры
                </Button>
              ) : (
                "Сборщики закрывают заполненные короба — после этого они появятся здесь."
              )}
            </Empty>
          )}
          {selection.length ? (
            <div className="selection-bar">
              <span>
                <strong>
                  Выбрано{" "}
                  {countLabel(selection.length, ["короб", "короба", "коробов"])}{" "}
                  · {number(selection.reduce((n, b) => n + b.qty, 0))} шт.
                </strong>
                <small>
                  {first && selection.some(b=>!sameScope(first,b)) ? "Выбранные короба можно скачать вместе. Для одной отгрузки выберите один магазин и направление." : "Скачивание Excel не меняет статус коробов."}
                </small>
              </span>
              <div className="actions">
                <Button disabled={downloading || w.busy} onClick={() => void downloadStock(selection)}>Скачать Excel выбранных</Button>
                <Button onClick={() => setSelected(new Set())}>
                  Снять выбор
                </Button>
                <Button
                  primary
                  disabled={!first||selection.length>100||selection.some(b=>!sameScope(first,b))}
                  onClick={() => {
                    setReview(true);
                    setError("");
                  }}
                >
                  Подготовить отгрузку
                </Button>
              </div>
            </div>
          ) : null}
          <Pagination
            page={pg}
            size={30}
            total={filtered.length}
            onChange={setPage}
          />
          <p className="muted">
            В одну отгрузку выбираются короба одного маркетплейса, магазина и
            склада назначения. Максимум 100 коробов.
          </p>
        </>
      ) : (
        <>
          {dispatches.length ? (
            <div className="dispatch-list">
              {dispatches.map((d) => (
                <article className="dispatch-row" key={d.id}>
                  <div>
                    <h2>
                      {d.label}{" "}
                      <span
                        className={`badge ${d.state === "sent" ? "success" : d.state === "canceled" ? "neutral" : "warning"}`}
                      >
                        {d.state === "sent"
                          ? "Отправлена"
                          : d.state === "canceled"
                            ? "Отменена"
                            : "Подготовлена"}
                      </span>
                    </h2>
                    <p>
                      {d.market} · {d.store} · {d.destination}
                    </p>
                    <p className="muted">
                      {countLabel(d.cartonIds.length, [
                        "короб",
                        "короба",
                        "коробов",
                      ])}{" "}
                      · {number(d.qty)} шт. ·{" "}
                      {dateTime(d.sentAt ?? d.createdAt)} МСК
                    </p>
                  </div>
                  <div className="actions">
                    {d.state !== "canceled" ? (
                      <Button onClick={() => setExporting(d)}>
                        Excel и состав
                      </Button>
                    ) : null}
                    {d.state === "draft" ? (
                      <>
                        <Button
                          onClick={() => {
                            setCancel(d);
                            setError("");
                          }}
                        >
                          Отменить подготовку
                        </Button>
                        <Button
                          primary
                          onClick={() => {
                            setSend(d);
                            setError("");
                          }}
                        >
                          Подтвердить выезд
                        </Button>
                      </>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              title={
                tab === "draft"
                  ? "Подготовленных отгрузок нет"
                  : "История пока пуста"
              }
            >
              Сначала выберите закрытые короба на вкладке «Готовы к отгрузке».
            </Empty>
          )}
        </>
      )}
      {details ? (
        <CartonDetails
          box={details}
          workspace={w}
          onClose={() => setDetails(null)}
        />
      ) : null}
      {review ? (
        <Dialog title="Подготовить отгрузку" onClose={() => setReview(false)}>
          <div className="stack">
            <p>
              {first?.market} · {first?.store} · {first?.destination}
            </p>
            <p>
              <strong>
                {countLabel(selection.length, ["короб", "короба", "коробов"])} ·{" "}
                {number(selection.reduce((n, b) => n + b.qty, 0))} шт.
              </strong>
            </p>
            <p className="muted">{selection.map((b) => b.label).join(", ")}</p>
            <p>
              Короба будут зарезервированы. Excel можно скачать после
              подготовки. Фактический выезд подтверждается отдельно.
            </p>
            {error ? (
              <p role="alert" className="field-error">
                {error}
              </p>
            ) : null}
            <div className="actions">
              <Button onClick={() => setReview(false)}>
                Вернуться к выбору
              </Button>
              <Button
                primary
                disabled={w.busy || !selection.length || selection.length > 100}
                onClick={() => void create()}
              >
                Подготовить отгрузку
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {send ? (
        <Dialog
          title={`Подтвердить выезд ${send.label}`}
          onClose={() => setSend(null)}
        >
          <div className="stack">
            <p>
              <strong>
                {countLabel(send.cartonIds.length, [
                  "короб",
                  "короба",
                  "коробов",
                ])}{" "}
                · {number(send.qty)} шт.
              </strong>
            </p>
            <p>
              {send.market} · {send.store} · {send.destination}
            </p>
            <p>
              Подтвердите, что эти короба действительно уехали со склада. Они
              исчезнут из списка неотправленных. История и Excel сохранятся.
            </p>
            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="actions">
              <Button onClick={() => setSend(null)}>Ещё на складе</Button>
              <Button
                primary
                disabled={w.busy}
                onClick={() => void confirmSend()}
              >
                Короба уехали
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {cancel ? (
        <Dialog
          title={`Отменить подготовку ${cancel.label}`}
          onClose={() => setCancel(null)}
        >
          <div className="stack">
            <p>
              Короба снова станут доступны для выбора. Уже созданные выгрузки
              сохранятся в истории.
            </p>
            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="actions">
              <Button onClick={() => setCancel(null)}>Вернуться</Button>
              <Button disabled={w.busy} onClick={() => void confirmCancel()}>
                Отменить подготовку
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {exporting ? (
        <Suspense fallback={<div role="status">Загружаем выгрузку…</div>}>
          <ExportDialog
            dispatch={exporting}
            workspace={w}
            onClose={() => setExporting(null)}
          />
        </Suspense>
      ) : null}
    </main>
  );
}
