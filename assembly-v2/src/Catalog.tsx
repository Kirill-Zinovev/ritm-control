import { CatalogEditor } from "./CatalogEditor";
import type { ManagedDetail, ManagedProduct } from "../shared/catalog-editor";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type {
  CatalogBundle,
  CatalogDetail,
  CatalogListItem,
  CatalogPage,
} from "../shared/catalog";
import { dateTime, number } from "../shared/model";
import {
  Button,
  Dialog,
  Empty,
  Field,
  NativeSelect,
  Pagination,
  Search,
} from "./ui";
import {
  catalogPhotoUrl,
  catalogRequest,
  uploadCatalog,
} from "./catalog-client";
import { useDirty, useDraftNavigation } from "./DraftGuard";
import type { Workspace } from "./useWorkspace";
import "./catalog.css";
import { ProductPhoto } from "./ProductPhoto";

const labels: Record<string, string> = {
  article: "Артикул",
  alias: "Связанный артикул",
  barcode: "Штрихкод",
  ozonBarcode: "Штрихкод OZON",
  name: "Название",
  kind: "Вид",
  category: "Вид товара",
  printFolder: "Папка печати",
  department: "Кто печатает",
  sheetsPerUnit: "Кол-во листов",
  size: "Размер",
  packaging: "Упаковка",
  machine: "Станок",
  boxType: "Тип короба",
  unitsPerBoxNumber: "Кол-во вида",
  unitsPerBoxText: "В коробке",
  rollMultiplicity: "Кратность рулонная",
  xeroxMultiplicity: "Кратность Xerox",
  photo: "Фото",
  store: "Магазин",
};
export function Catalog({ workspace: w }: { workspace: Workspace }) {
  const initial = new URLSearchParams(location.search);
  const [query, setQuery] = useState(initial.get("catalog_q") ?? "");
  const [market, setMarket] = useState(initial.get("catalog_market") ?? "");
  const [store, setStore] = useState(initial.get("catalog_store") ?? "");
  const [machine, setMachine] = useState(initial.get("catalog_machine") ?? "");
  const [review, setReview] = useState(initial.get("catalog_review") === "1");
  const [missingLabel, setMissingLabel] = useState(initial.get("catalog_missingLabel") === "1");
  const [page, setPage] = useState(Number(initial.get("catalog_page")) || 0);
  const [data, setData] = useState<CatalogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<CatalogListItem | null>(null);
  const [editor,setEditor]=useState<ManagedDetail | {draft:ManagedProduct} | "new" | null>(null);
  const activeCard = editor && editor!=="new" && !("draft" in editor) ? editor : null;
  const initialDraft = editor && editor!=="new" && "draft" in editor ? editor.draft : undefined;
  const [importing, setImporting] = useState(false);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState("");
  const [opening,setOpening]=useState(false);
  const safely=useDraftNavigation();
  const editorRequest=useRef<AbortController | null>(null);
  const catalogWorkspace = useRef<HTMLDivElement>(null);
  useEffect(()=>()=>editorRequest.current?.abort(),[]);
  useEffect(() => {
    if (!editor || !matchMedia("(max-width: 960px)").matches) return;
    catalogWorkspace.current?.querySelector(".catalog-editor")?.scrollIntoView({ block: "start" });
  }, [editor]);
  async function openEditor(item:CatalogListItem) {
    editorRequest.current?.abort();
    const controller=new AbortController();editorRequest.current=controller;
    setOpening(true);setError('');
    try {const product=await catalogRequest<ManagedDetail>(`/api/catalog/entry?import=${item.importId}&id=${encodeURIComponent(item.id)}`,undefined,controller.signal);if(!controller.signal.aborted)setEditor(product);}
    catch(e){if(!controller.signal.aborted)setError((e as Error).message);}
    finally{if(!controller.signal.aborted)setOpening(false);}
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      const p = new URLSearchParams({
        q: query,
        market,
        store,
        machine,
        review: review ? "1" : "",
        missingLabel: missingLabel ? "1" : "",
        page: String(page),
      });
      const url = new URL(location.href);
      for (const [k, v] of p) {
        if (v) url.searchParams.set(`catalog_${k}`, v);
        else url.searchParams.delete(`catalog_${k}`);
      }
      history.replaceState(null, "", url);
      void catalogRequest<CatalogPage>(
        `/api/catalog?${p}`,
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setData(result);
          if (result.page !== page) setPage(result.page);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError((e as Error).message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, market, store, machine, review, missingLabel, page, version]);
  function filter(update: () => void) {
    update();
    setPage(0);
  }
  const hasEditor = !!editor && !!data?.active;
  const canOpenEditor = !w.busy && !opening;
  const reviewDetails = (item: CatalogListItem) => item.issues.length ? (
    <button className="catalog-review text-action" type="button" onClick={(event) => {
      event.stopPropagation();
      setDetail(item);
    }}>
      {item.issues.length} замеч.
    </button>
  ) : (
    <span className="catalog-ok">Данные согласованы</span>
  );
  return (
    <main className="content catalog-page">
      <div ref={catalogWorkspace} className={`catalog-workspace ${hasEditor ? "has-editor" : ""}`}>
      <div className="catalog-list-pane">
      <div className="section-heading">
        <div>
          <h1>Справочник</h1>
          <p className="muted">Артикулы, упаковка, станки и фотографии</p>
        </div>
        <div className="catalog-heading-actions"><Button onClick={() => safely(()=>setImporting(true))}>Загрузить Excel</Button><Button primary disabled={!data?.active || w.busy} onClick={()=>safely(()=>{editorRequest.current?.abort();setOpening(false);setEditor("new")})}>+ Добавить товар</Button></div>
      </div>
      {notice ? (
        <p className="status-success" role="status">
          {notice}
        </p>
      ) : null}
      {data?.active ? (
        <div className="catalog-summary">
          {missingLabel ? (
            <span className="catalog-count-chip">Без этикетки <strong>{number(data.total)}</strong></span>
          ) : (
            <span><strong>{number(data.total)}</strong> карточек WB и OZON</span>
          )}
          <span>
            <strong>{number(data.active.manifest.sourceRows)}</strong> исходные
            строки
          </span>
          <span>
            <strong>{number(data.active.manifest.photos)}</strong> записей
            фотографий
          </span>
          <span>Обновлено {dateTime(data.active.createdAt)} МСК</span>
        </div>
      ) : null}
      <div className="catalog-filters">
        <Search
          label="Артикул, название или штрихкод"
          placeholder="Артикул, название, ШК"
          value={query}
          onChange={(v) => filter(() => setQuery(v))}
        />
        <NativeSelect
          label="Маркетплейс"
          value={market}
          onChange={(e) => filter(() => setMarket(e.target.value))}
        >
          <option value="">Все</option>
          <option>WB</option>
          <option>OZON</option>
        </NativeSelect>
        <NativeSelect
          label="Магазин"
          value={store}
          onChange={(e) => filter(() => setStore(e.target.value))}
        >
          <option value="">Все</option>
          <option value="1">Магазин 1</option>
          <option value="2">Магазин 2</option>
        </NativeSelect>
        <NativeSelect
          label="Станок из базы"
          value={machine}
          onChange={(e) => filter(() => setMachine(e.target.value))}
        >
          <option value="">Все</option>
          {data?.machines.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </NativeSelect>
        <div className="catalog-filter-checks">
          <label className="check">
            <input
              type="checkbox"
              checked={review}
              onChange={(e) => filter(() => setReview(e.target.checked))}
            />
            Нужна проверка
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={missingLabel}
              onChange={(e) => filter(() => setMissingLabel(e.target.checked))}
            />
            Без этикетки
          </label>
        </div>
      </div>
      {error ? (
        <div className="status-error" role="alert">
          {error}
          <Button onClick={() => setVersion((v) => v + 1)}>
            Повторить загрузку
          </Button>
        </div>
      ) : null}
      <div className="catalog-results" aria-busy={loading}>
        {loading ? (
          <p role="status" className="muted">
            Загружаем справочник…
          </p>
        ) : null}
        {data?.active ? (
          <>
            <div className="table-scroll">
              <table className="catalog-table">
                <thead>
                  <tr>
                    <th>Товар</th>
                    <th>Маркетплейс / магазин</th>
                    <th>Упаковка / станок</th>
                    <th>В коробке</th>
                    {!hasEditor && <th>Проверка</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((e) => (
                    <tr
                      key={e.id}
                      className={`${canOpenEditor ? "is-clickable" : ""} ${activeCard?.id === e.id ? "is-selected" : ""}`}
                      onClick={canOpenEditor ? () => safely(() => void openEditor(e)) : undefined}
                    >
                      <td>
                        <div className="catalog-product">
                          <ProductPhoto
                            importId={e.importId}
                            id={e.photoId}
                            sourceUrl={e.photoUrl}
                            sku={e.sku}
                          />
                          <div>
                            <button
                              className="catalog-link"
                              type="button"
                              disabled={!canOpenEditor}
                            >
                              {e.sku}
                            </button>
                            <p>{e.name || "Название требует проверки"}</p>
                            <small className="muted">
                              {e.barcode || "Штрихкод не указан"}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`market-pill ${e.market.toLowerCase()}`}>{e.market}</span>
                        <p className="muted">
                          {e.store
                            ? `Магазин ${e.store}`
                            : "Магазин не определён"}
                        </p>
                      </td>
                      <td>
                        {e.packaging || "—"}
                        <p className="muted">
                          {e.machine || "Станок не определён"}
                        </p>
                      </td>
                      <td>
                        {e.unitsPerBox ? (
                          `${number(e.unitsPerBox)} шт. · ${e.boxType}`
                        ) : (
                          <span className="catalog-review">Нужна проверка</span>
                        )}
                        {e.capacitySource === "user" ? (
                          <p className="muted">Подтверждено вами</p>
                        ) : null}
                        {hasEditor && e.issues.length > 0 && (
                          <p className="catalog-inline-review">{reviewDetails(e)}</p>
                        )}
                      </td>
                      {!hasEditor && <td>{reviewDetails(e)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.items.length && !loading ? (
              <Empty title="По выбранным фильтрам ничего не найдено">
                <Button
                  onClick={() => {
                    setQuery("");
                    setMarket("");
                    setStore("");
                    setMachine("");
                    setReview(false);
                    setMissingLabel(false);
                    setPage(0);
                  }}
                >
                  Сбросить фильтры
                </Button>
              </Empty>
            ) : null}
            <Pagination
              page={data.page}
              total={data.total}
              size={30}
              onChange={setPage}
            />
          </>
        ) : !loading && !error ? (
          <Empty title="Справочник пока не загружен">
            Выберите «Загрузить Excel» и добавьте базу артикулов и файл
            фотографий.
          </Empty>
        ) : null}
      </div>
      </div>
      {editor && data?.active ? <CatalogEditor key={activeCard?.id ?? (initialDraft ? "wb-draft" : "new")} inline item={activeCard}
        initialDraft={initialDraft} importId={data.active.id} workspace={w}
        onOpenExisting={setEditor} onClose={()=>{editorRequest.current?.abort();setOpening(false);setEditor(null)}}
        onSaved={nextDraft=>{
          setEditor(nextDraft ? {draft:nextDraft} : null);
          setVersion(v=>v+1);
          setNotice(nextDraft ? "Карточка Ozon сохранена. Введите штрихкод WB." : "Карточка сохранена. Данные сборки обновлены; выработка сохранена.");
          void w.refresh();
        }}/>:null}
      </div>
      {opening && <p role="status">Открываем карточку…</p>}
      {data?.active ? (
        <details className="catalog-sources">
          <summary>Исходные файлы и правила переноса</summary>
          <p>{data.active.manifest.decision}</p>
          <p>
            Нормы выработки в этих файлах отсутствуют. Названия станков
            сохранены как в Excel. Фотографии загружаются по мере открытия; все
            ссылки галерей сохранены.
          </p>
          {data.active.manifest.sources.map((s) => (
            <p key={s.role}>
              <a
                href={`/api/catalog/source?import=${data.active!.id}&role=${s.role}`}
              >
                Скачать {s.name}
              </a>
              <small className="source-hash">SHA-256: {s.sha256}</small>
            </p>
          ))}
        </details>
      ) : null}
      {detail ? (
        <CatalogCard item={detail} onClose={() => setDetail(null)} onEdit={d=>safely(()=>{editorRequest.current?.abort();setOpening(false);setDetail(null);setEditor(d)})} />
      ) : null}
      {importing ? (
        <CatalogImport
          onClose={() => setImporting(false)}
          onSuccess={() => {
            setImporting(false);
            setVersion((v) => v + 1);
            setNotice(
              "Справочник перенесён. История работы и собранные короба сохранены.",
            );
            void w.refresh();
          }}
        />
      ) : null}
    </main>
  );
}
function CatalogCard({
  item,
  onClose,
  onEdit,
}: {
  item: CatalogListItem;
  onClose(): void;
  onEdit(item:ManagedDetail):void;
}) {
  const [data, setData] = useState<CatalogDetail | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    void catalogRequest<CatalogDetail>(
      `/api/catalog/entry?import=${item.importId}&id=${encodeURIComponent(item.id)}`,
      undefined,
      c.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!c.signal.aborted) setError((e as Error).message);
      });
    return () => c.abort();
  }, [item, attempt]);
  return (
    <Dialog
      title={item.sku}
      kicker={`${item.market} · ${item.store ? `Магазин ${item.store}` : "Магазин не определён"}`}
      onClose={onClose}
      className="catalog-dialog"
    >
      {error ? (
        <p className="status-error" role="alert">
          {error}
          <Button
            onClick={() => {
              setError("");
              setAttempt((n) => n + 1);
            }}
          >
            Повторить
          </Button>
        </p>
      ) : null}
      {!data && !error ? (
        <p role="status">Загружаем карточку…</p>
      ) : data ? (
        <>
          <div className="catalog-card-head">
            <ProductPhoto
              importId={data.importId}
              id={data.photoId}
              sourceUrl={data.photoUrl}
              sku={data.sku}
            />
            <div>
              <h3>{data.name || "Название требует проверки"}</h3>
              <p>{data.barcode || "Штрихкод не указан"}</p>
              <p className="muted">
                Связанные артикулы: {data.aliases.join(", ")}
              </p>
            </div>
          </div>
          <dl className="catalog-properties">
            {Object.entries({
              kind: data.kind,
              category: data.category,
              machine: data.machine,
              packaging: data.packaging,
              size: data.size,
              sheetsPerUnit: data.sheetsPerUnit,
              printFolder: data.printFolder,
              department: data.catalogDepartment,
              boxType: data.boxType,
              rollMultiplicity: data.rollMultiplicity,
              xeroxMultiplicity: data.xeroxMultiplicity,
            }).map(([k, v]) => (
              <div key={k}>
                <dt>{labels[k]}</dt>
                <dd>{v || "Не определено"}</dd>
              </div>
            ))}
            <div>
              <dt>Вместимость короба</dt>
              <dd>
                {data.unitsPerBox
                  ? `${number(data.unitsPerBox)} шт.`
                  : "Нужна проверка"}
              </dd>
            </div>
          </dl>
          {data.capacitySource === "user" ? (
            <p className="status-success">
              700 шт. — ваше подтверждение от 13.11.2026. Исходное «550 М»
              сохранено ниже.
            </p>
          ) : null}
            {data.kindCorrection&&<p className="status-success">Вид подтверждён владельцем: {data.kind}. {data.kindCorrection}</p>}
            {data.issues.length ? (
            <div className="catalog-warning">
              <strong>Нужна проверка</strong>
              <ul>
                {data.issues.map((i) => (
                  <li key={i}>
                    {i.replace(
                      /(?:Ошибка Excel|Расхождение строк|Не заполнено поле): (\w+)/g,
                      (_, key: string) =>
                        `Проверить поле «${labels[key] ?? key}»`,
                    )}
                  </li>
                ))}
              </ul>
              {data.unitsPerBox === null ? (
                <p>
                  Работу можно записывать. Добавление в короб станет доступно
                  после подтверждения вместимости.
                </p>
              ) : null}
            </div>
          ) : null}
          {data.photo ? (
            <div className="catalog-gallery">
              <p className="muted">
                Фотографий в галерее: {data.photo.urls.length}. Показаны первые
                пять.
              </p>
              <div>
                {data.photo.urls.slice(0, 5).map((_, i) => (
                  <img
                    key={i}
                    src={catalogPhotoUrl(data.importId, data.photo!.id, i)}
                    alt={`${data.sku} · фото ${i + 1}`}
                    loading="lazy"
                    width={100}
                    height={120}
                  />
                ))}
              </div>
            </div>
          ) : null}
<div className="dialog-actions"><Button primary onClick={()=>onEdit(data)}>Редактировать товар</Button></div>
          <h3>Исходные строки Excel</h3>
          {data.rows.map((r) => (
            <details className="catalog-source-row" key={`${r.sheet}:${r.row}`}>
              <summary>
                {r.sheet} · строка {r.row}
              </summary>
              <dl>
                {Object.entries(r.raw).map(([k, v]) => (
                  <div key={k}>
                    <dt>
                      {labels[k] ?? k}
                      <small>{r.refs[k]}</small>
                    </dt>
                    <dd>{v || "Пусто"}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </>
      ) : null}
    </Dialog>
  );
}
function CatalogImport({
  onClose,
  onSuccess,
}: {
  onClose(): void;
  onSuccess(): void;
}) {
  const [base, setBase] = useState<File | null>(null);
  const [photos, setPhotos] = useState<File | null>(null);
  const [bundle, setBundle] = useState<CatalogBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const worker = useRef<Worker | null>(null);
  useDirty(!!base || !!photos || busy);
  const safely = useDraftNavigation();
  const close = () => {
    if (!busy) safely(onClose);
  };
  useEffect(() => () => worker.current?.terminate(), []);
  function choose(e: ChangeEvent<HTMLInputElement>, role: "base" | "photos") {
    const file = e.target.files?.[0] ?? null;
    if (
      file &&
      (!file.name.toLowerCase().endsWith(".xlsx") || file.size > 12_000_000)
    ) {
      setError("Выберите Excel .xlsx размером не больше 12 МБ.");
      e.target.value = "";
      (role === "base" ? setBase : setPhotos)(null);
      setBundle(null);
      return;
    }
    (role === "base" ? setBase : setPhotos)(file);
    setBundle(null);
    setError("");
  }
  async function preview() {
    if (!base || !photos) return;
    setBusy(true);
    setError("");
    setProgress("Открываем Excel…");
    try {
      const task = new Worker(new URL("./catalog-worker.ts", import.meta.url), {
        type: "module",
      });
      worker.current = task;
      task.onmessage = (
        e: MessageEvent<{
          progress?: string;
          bundle?: CatalogBundle;
          error?: string;
        }>,
      ) => {
        if (e.data.progress) setProgress(e.data.progress);
        if (e.data.bundle) {
          setBundle(e.data.bundle);
          setBusy(false);
          setProgress("");
          task.terminate();
        }
        if (e.data.error) {
          setError(e.data.error);
          setBusy(false);
          setProgress("");
          task.terminate();
        }
      };
      task.onerror = () => {
        setError("Не удалось прочитать Excel. Проверьте файл и повторите.");
        setBusy(false);
        setProgress("");
        task.terminate();
      };
      task.postMessage({
        base: {
          name: base.name,
          bytes: new Uint8Array(await base.arrayBuffer()),
        },
        photos: {
          name: photos.name,
          bytes: new Uint8Array(await photos.arrayBuffer()),
        },
      });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setProgress("");
    }
  }
  async function apply() {
    if (!bundle || !base || !photos) return;
    setBusy(true);
    setError("");
    try {
      await uploadCatalog(bundle, [base, photos], setProgress);
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setProgress("");
    }
  }
  return (
    <Dialog
      title="Перенести справочник из Excel"
      onClose={close}
      busy={busy}
      className="catalog-dialog"
    >
      <p className="muted">
        Загрузка в справочник RITM Сборка. Исходные Excel сохранятся отдельными копиями;
        рабочие таблицы не меняются.
      </p>
      <Field
        type="file"
        accept=".xlsx"
        label="База артикулов · листы WB и OZON"
        disabled={busy}
        onChange={(e) => choose(e, "base")}
      />
      <Field
        type="file"
        accept=".xlsx"
        label="Фотографии · лист «Фото»"
        disabled={busy}
        onChange={(e) => choose(e, "photos")}
      />
      {error ? (
        <p className="status-error" role="alert">
          {error} Принятые пакеты сохранены: повторная загрузка продолжится с
          места остановки.
        </p>
      ) : null}
      {progress ? <p role="status">{progress}</p> : null}
      {bundle ? (
        <div className="catalog-preview">
          <p>
            <strong>{number(bundle.manifest.entries)}</strong> карточек из{" "}
            {number(bundle.manifest.sourceRows)} строк Excel
          </p>
          <p>{number(bundle.manifest.photos)} записей фотографий</p>
          <p>
            Расхождения вместимости: {bundle.manifest.capacityConflicts}.
            Подтверждено исправлений: {bundle.manifest.userCorrections}.
          </p>
          <p className="muted">
            Спорная вместимость останется пустой. Работа сохраняется отдельно от
            добавления в короб.
          </p>
        </div>
      ) : null}
      <div className="dialog-actions">
        <Button disabled={busy} onClick={close}>
          Отмена
        </Button>
        {bundle ? (
          <Button primary disabled={busy} onClick={() => void apply()}>
            Загрузить в справочник
          </Button>
        ) : (
          <Button
            primary
            disabled={busy || !base || !photos}
            onClick={() => void preview()}
          >
            Проверить файлы
          </Button>
        )}
      </div>
    </Dialog>
  );
}
