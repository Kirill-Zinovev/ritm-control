import { sameCartonScope } from "../shared/carton-scope";
import { StockBoxSelect } from "./StockBoxSelect";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Supply } from "../shared/model";
import { number } from "../shared/model";
import { boxCapacity, boxingBlockedReason, isCartonOverCapacity, placementAmounts, workBlockedReason, type CartonFitConfirmation, type ExcessDestination } from "../shared/assembly";
import { cartonMergeFingerprint } from "../shared/carton-merge";
import { cartonPrefix, cartonStoreNumber } from "../shared/carton-number";
import type { Workspace } from "./useWorkspace";
import { Button, Dialog, Empty, NativeSelect, Search } from "./ui";
import { useDirty, useDraftNavigation } from "./DraftGuard";
import { CartonDetails } from "./Cartons";
import { ProductPhoto } from "./ProductPhoto";
import { CartonProduct } from "./CartonProduct";
import { WarehouseStock } from "./WarehouseStock";
import { CartonMerge } from "./CartonMerge";

const boxTabs = [
  { id: "direction", label: "Короба направления" },
  { id: "warehouse", label: "На склад" },
  { id: "merge", label: "Слияние" },
] as const;

export function BoxDrawer({
  initialPositionId,
  supply: directionSupply,
  workspace: w,
  onClose,
  onWork,
}: {
  initialPositionId: string | null;
  supply: Supply;
  workspace: Workspace;
  onClose(): void;
  onWork?(positionId: string): void;
}) {
  const state = w.state!;
  const [stockBox,setStockBox]=useState("");
  const [tab, setTab] = useState<(typeof boxTabs)[number]["id"]>("direction");
  const tabsId = useId();
  const warehouse = tab === "warehouse";
  const [employeeId, setEmployeeId] = useState(() => {
    try {
      return sessionStorage.getItem("assembly.v2.employee") || "";
    } catch {
      return "";
    }
  });
  const [positionId, setPositionId] = useState(
    initialPositionId ?? state.positions.find((p) => p.ready)?.id ?? "",
  );
  const p = state.positions.find((p) => p.id === positionId);
  const supply =
    state.sourceSupplies?.find((s) => s.id === p?.supplyId) || directionSupply;
  useEffect(()=>setStockBox(""),[supply.market,supply.store]);
  const scopeBoxes = state.cartons.filter((c) => sameCartonScope(c, supply));
  const [boxId, setBoxId] = useState(
    () =>
      scopeBoxes.find(
        (c) =>
          c.state === "open" &&
          !c.dispatchId &&
          !c.capacityUnknown &&
          boxCapacity(c.fill, p?.unitsPerBox ?? null) > 0,
      )?.id ?? "",
  );
  const [query, setQuery] = useState("");
  const [newBox, setNewBox] = useState(false);
  const [closed, setClosed] = useState(false);
  const [qty, setQty] = useState("");
  const [excessDestination, setExcessDestination] = useState<ExcessDestination>("box");
  const [error, setError] = useState("");
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const safely = useDraftNavigation();
  useDirty(tab === "direction" && !!qty);
  const box = newBox
    ? undefined
    : scopeBoxes.find(
        (c) => c.id === boxId && c.state === "open" && !c.dispatchId,
      );
  const detail = scopeBoxes.find((c) => c.id === detailsId);
  const available = p ? Math.max(0, p.packing - p.boxed) : 0;
  const value = Number(qty);
  const shipmentRemaining = p
    ? Math.max(0, p.plan - p.boxed + (p.warehouseQty || 0))
    : 0;
  const { shipmentQty, warehouseQty, excessQty } = placementAmounts(
    Number.isSafeInteger(value) && value > 0 ? value : 0, shipmentRemaining, excessDestination,
  );
  const fill =
    (box || newBox) && p?.unitsPerBox
      ? (box?.fill || 0) + shipmentQty / p.unitsPerBox
      : 0;
  const capacity =
    box || newBox
      ? box?.capacityUnknown
        ? 0
        : boxCapacity(box?.fill || 0, p?.unitsPerBox ?? null)
      : 0;
  const placementCapacity =
    excessDestination === "stock" && capacity >= shipmentRemaining ? available : capacity;
  let prefix = "", prefixError = "";
  try {
    prefix = cartonPrefix(supply);
  } catch (e) {
    prefixError = e instanceof Error ? e.message : "Проверьте название и магазин поставки в РИТМ.";
  }
  const blocked = p ? workBlockedReason(p, supply) : "Выберите товар.";
  const itemBlock = p ? boxingBlockedReason(p, supply) : blocked;
  const newBoxBlock = blocked || (cartonStoreNumber(supply.store) === null ? itemBlock : prefixError);
  const validQuantity = /^\d+$/.test(qty) && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
  let placementBlock = closed ? "Переключитесь на открытые короба, чтобы добавить товар." : itemBlock;
  if (!placementBlock) {
    if (!available) {
      placementBlock = p?.packing
        ? "Вся упаковка уже в коробах. Проверьте состав, если товар нужно переложить."
        : "Сначала запишите упаковку этого товара.";
    } else if (newBox && newBoxBlock) {
      placementBlock = newBoxBlock;
    } else if ((shipmentQty > 0 || !qty) && !box && !newBox) {
      placementBlock = "Выберите открытый короб или нажмите «Новый короб».";
    } else if (!validQuantity) {
      placementBlock = "Введите количество целым числом больше нуля.";
    } else if (value > available) {
      placementBlock = `Упаковано без короба ${number(available)} шт. Уменьшите количество.`;
    } else if (shipmentQty > 0 && box?.capacityUnknown) {
      placementBlock = "У товара в этом коробе нет подтверждённой вместимости. Выберите другой короб.";
    } else if (warehouseQty > 0 && !stockBox) {
      placementBlock = "Выберите складской короб для излишка.";
    } else if (warehouseQty > 0 && !state.employees.some(e => e.id === employeeId && e.active)) {
      placementBlock = "Выберите сотрудника для записи товара на склад.";
    }
  }
  const requiresFitConfirmation = !placementBlock && shipmentQty > 0 && isCartonOverCapacity(fill);
  const guidance = requiresFitConfirmation
    ? `По норме в коробе есть место для ${number(capacity)} шт. Подтвердите, если ${number(shipmentQty)} шт. физически помещаются.`
    : placementBlock || (newBox ? "Короб создастся при добавлении первого товара." : "");
  const rows = scopeBoxes.filter(
    (c) =>
      (closed ? c.state === "closed" : c.state === "open") &&
      `${c.label} ${c.items.map((i) => i.sku).join(" ")}`
        .toLocaleLowerCase("ru")
        .includes(query.toLocaleLowerCase("ru")),
  );
  const [limit, setLimit] = useState(30);
  function close() {
    if (!w.busy) safely(onClose);
  }
  function create() {
    setError("");
    setClosed(false);
    setQuery("");
    setNewBox(true);
    setBoxId("");
    setQty("");
    setExcessDestination("box");
    requestAnimationFrame(() => input.current?.focus());
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void add(false);
  }
  async function add(confirmFit: boolean) {
    if (!p?.unitsPerBox || placementBlock || w.busy || saving.current || confirmFit !== requiresFitConfirmation) return;
    saving.current = true;
    setError("");
    try {
      const fitConfirmation: CartonFitConfirmation | undefined = confirmFit ? {
        cartonFingerprint: box ? await cartonMergeFingerprint(box) : null,
        shipmentQty,
        unitsPerBox: p.unitsPerBox,
      } : undefined;
      const result = await w.command(
        "allocation.place",
        {
          positionId: p.id,
          ...(newBox ? { newCarton: true } : box ? { cartonId: box.id } : {}),
          qty: value,
          excessDestination,
          ...(fitConfirmation ? { fitConfirmation } : {}),
          ...(warehouseQty > 0 ? { employeeId, warehouseCartonId:stockBox === "new" ? undefined : stockBox, newWarehouseCarton:stockBox === "new" } : {}),
        },
        warehouseQty > 0
          ? `В направление: ${number(shipmentQty)} шт. На склад: ${number(warehouseQty)} шт.`
          : `Товар добавлен в короб · ${number(value)} шт.`,
      );
      if(typeof result.warehouseCartonId === "string")setStockBox(result.warehouseCartonId);
      setNewBox(false);
      if (result.cartonId) setBoxId(String(result.cartonId));
      setQty("");
      setExcessDestination("box");
      requestAnimationFrame(() => input.current?.focus());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saving.current = false;
    }
  }
  return (
    <Dialog
      title="📦 Короба"
      kicker={`Поставка · ${supply.title}`}
      className={`box-drawer legacy-box-drawer ${warehouse ? "show-warehouse-stock" : ""}${tab === "merge" ? " show-carton-merge" : ""}`}
      busy={w.busy}
      onClose={close}
    >
      <div className="drawer-content">
        <div
          className="warehouse-tabs"
          role="tablist"
          aria-label="Назначение коробов"
        >
          {boxTabs.map(({ id, label }, index) => (
            <button
              type="button"
              role="tab"
              key={id}
              id={`${tabsId}-${id}`}
              aria-selected={tab === id}
              aria-controls={id === "merge" && tab === id ? `${tabsId}-merge-panel` : undefined}
              tabIndex={tab === id ? 0 : -1}
              disabled={w.busy}
              onClick={() => { if (tab !== id) safely(() => setTab(id)); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  const offset = e.key === "ArrowRight" ? 1 : -1;
                  const next = (index + offset + boxTabs.length) % boxTabs.length;
                  const nextButton = e.currentTarget.parentElement?.children[next] as HTMLElement | undefined;
                  safely(() => { setTab(boxTabs[next].id); nextButton?.focus(); });
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "merge" ? (
          <div id={`${tabsId}-merge-panel`} role="tabpanel" aria-labelledby={`${tabsId}-merge`} className="merge-tab-panel">
            <CartonMerge cartons={scopeBoxes} workspace={w} />
          </div>
        ) : warehouse ? (
          <WarehouseStock workspace={w} supply={supply} />
        ) : (
          <>
            <NativeSelect
              label="Товар"
              id="boxItemSelect"
              disabled={w.busy}
              value={positionId}
              onChange={(e) =>
                safely(() => {
                  setPositionId(e.target.value);
                  setQty("");
                  setExcessDestination("box");
                  setError("");
                })
              }
            >
              {state.positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} · {p.name}
                </option>
              ))}
            </NativeSelect>
            {p ? (
              <>
                <div className="box-product-card">
                  <ProductPhoto
                    importId={p.photoCatalogImportId ?? p.catalogImportId ?? ""}
                    id={p.catalog?.photoId || null}
                    sourceUrl={p.photoUrl}
                    sku={p.sku}
                    className="box-photo-slot"
                  />
                  <div className="box-product-copy">
                    <strong>{p.sku}</strong>
                    {p.name !== p.sku ? (
                      <span className="box-sku">{p.name}</span>
                    ) : null}
                    <span className="readonly-note">
                      {p.department} ·{" "}
                      {p.unitsPerBox
                        ? `${number(p.unitsPerBox)} шт. / короб`
                        : "Норма короба не задана"}
                    </span>
                  </div>
                </div>
                <div className="box-facts">
                  <div>
                    <span>Упаковано</span>
                    <strong>{number(p.packing)}</strong>
                  </div>
                  <div>
                    <span>В коробах</span>
                    <strong>{number(p.boxed)}</strong>
                  </div>
                  <div className="box-fact-available">
                    <span>Можно добавить</span>
                    <strong>{number(available)}</strong>
                  </div>
                </div>
                <p className="box-note">
                  В короб добавляется только уже упакованный товар. Работа
                  повторно не начисляется.
                </p>
              </>
            ) : null}
            <section
              className="box-list-section"
              aria-label={closed ? "Закрытые короба" : "Открытые короба"}
            >
              <div className="box-section-heading">
                <h3>
                  {closed ? "Закрытые короба" : "Открытые короба"} ·{" "}
                  {
                    scopeBoxes.filter(
                      (c) => c.state === (closed ? "closed" : "open"),
                    ).length
                  }
                </h3>
                <Button
                  disabled={w.busy || !!newBoxBlock}
                  aria-describedby={newBoxBlock ? "new-box-blocked" : undefined}
                  title={newBoxBlock || undefined}
                  onClick={() => safely(create)}
                >
                  ＋ Новый короб
                </Button>
              </div>
              {newBoxBlock && newBoxBlock !== guidance && (
                <p id="new-box-blocked" className="box-guidance is-error" role="status">{newBoxBlock}</p>
              )}
              <div className="box-list-tools">
                <Search
                  label="Найти номер короба или артикул"
                  value={query}
                  onChange={(q) => {
                    setQuery(q);
                    setLimit(30);
                  }}
                />
                <Button
                  aria-pressed={closed}
                  disabled={w.busy}
                  onClick={() =>
                    safely(() => {
                      setClosed((v) => !v);
                      setQty("");
                      setLimit(30);
                    })
                  }
                >
                  {closed ? "Открытые" : "Закрытые"}
                </Button>
              </div>
              <div className="box-cards">
                {rows.slice(0, limit).map((c) => (
                  <article
                    className={`box-card ${boxId === c.id && !closed ? "is-selected" : ""}`}
                    key={c.id}
                  >
                    <button
                      type="button"
                      className="box-card-button"
                      aria-pressed={boxId === c.id && !closed}
                      disabled={w.busy || !!c.dispatchId}
                      onClick={() => {
                        if (closed) setDetailsId(c.id);
                        else {
                          setBoxId(c.id);
                          
      setNewBox(false);
                          setError("");
                        }
                      }}
                    >
                      <strong className="box-card-title">{c.label}</strong>
                      <span className={`box-card-badge ${c.state}`}>
                        {c.dispatchId
                          ? "На отгрузку"
                          : c.state === "open"
                            ? "Открыт"
                            : "Закрыт"}
                      </span>
                      <span className="box-card-progress">
                        <span
                          style={{ width: `${Math.min(100, c.fill * 100)}%` }}
                        />
                      </span>
                      <span className="box-card-meta">
                        {number(c.qty)} шт. · заполнен на{" "}
                        {c.capacityUnknown
                          ? "Вместимость не уточнена"
                          : `${Math.round(c.fill * 100)}%`}
                      </span>
                    </button>
                    <div className="box-card-actions">
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setDetailsId(c.id)}
                      >
                        Состав и {c.state === "open" ? "закрытие" : "сведения"}
                      </button>
                    </div>
                    <details className="box-composition">
                      <summary>Состав · {c.items.length}</summary>
                      {c.items.map((i) => (
                        <div className="box-content-row" key={i.id}>
                          <CartonProduct item={i} />
                          <strong className="carton-item-quantity">
                            {number(i.qty)} шт.
                          </strong>
                        </div>
                      ))}
                    </details>
                  </article>
                ))}
              </div>
              {!rows.length ? (
                <Empty
                  title={
                    closed ? "Закрытых коробов нет" : "Открытых коробов нет"
                  }
                >
                  {query
                    ? "По этому поиску ничего не найдено."
                    : "Откройте новый короб для размещения товара."}
                </Empty>
              ) : null}
              {rows.length > limit ? (
                <Button onClick={() => setLimit((n) => n + 30)}>
                  Показать ещё · {rows.length - limit}
                </Button>
              ) : null}
            </section>
          </>
        )}
      </div>
      {tab === "direction" ? (
        <form className="box-action-footer" noValidate onSubmit={submit}>
          <div className="box-placement">
            <p className="box-selected-row">
              {newBox ? (
                <>
                  Создать автоматически <strong>Новый короб · {prefix}…</strong>
                </>
              ) : box ? (
                <>
                  Выбран <strong>{box.label}</strong>
                </>
              ) : (
                "Выберите открытый короб или создайте новый"
              )}
            </p>
            {guidance && (
              <p id={newBoxBlock === guidance ? "new-box-blocked" : "box-placement-help"}
                className={`box-guidance${itemBlock || requiresFitConfirmation ? " is-error" : ""}`} role="status">{guidance}</p>
            )}
            {excessQty > 0 ? (
              <>
                <NativeSelect label="Куда направить излишек?" value={excessDestination} disabled={w.busy}
                  onChange={e => { setExcessDestination(e.target.value as ExcessDestination); setError(""); }}
                  hint={warehouseQty > 0
                    ? `В поставку: ${number(shipmentQty)} шт. · На склад: ${number(warehouseQty)} шт.`
                    : `Все ${number(shipmentQty)} шт. — в выбранный короб, включая ${number(excessQty)} шт. сверх плана.`}>
                  <option value="box">В выбранный короб</option>
                  <option value="stock">На склад</option>
                </NativeSelect>
              </>
            ) : null}
            {warehouseQty > 0 ? (
              <>
                <StockBoxSelect market={supply.market} store={supply.store} value={stockBox} onChange={setStockBox} disabled={w.busy} revision={state.revision}/>
                <NativeSelect
                  label="Кто перемещает на склад"
                  value={employeeId}
                  disabled={w.busy}
                  onChange={(e) => setEmployeeId(e.target.value)}
                >
                  <option value="">Выберите своё имя</option>
                  {state.employees
                    .filter((e) => e.active)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </NativeSelect>
              </>
            ) : null}
            {p?.ready && available <= 0 && onWork ? (
              <Button
                className="box-work-shortcut"
                disabled={w.busy}
                onClick={() => safely(() => onWork(p.id))}
              >
                Записать упаковку
              </Button>
            ) : null}
            <div className="box-quantity-field">
              <label htmlFor="boxQuantityInput">Количество, шт.</label>
              <input
                ref={input}
                className="field"
                id="boxQuantityInput"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="0"
                value={qty}
                readOnly={w.busy}
                onChange={(e) => setQty(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby="box-error box-capacity"
              />
              <Button
                disabled={w.busy || available <= 0 || placementCapacity <= 0}
                onClick={() =>
                  setQty(String(Math.min(available, placementCapacity)))
                }
              >
                Все доступные
              </Button>
            </div>
            <div className="placement-track">
              <span
                style={{ width: `${Math.min(100, Math.max(0, fill * 100))}%` }}
              />
            </div>
            <p className="box-capacity-preview" id="box-capacity">
              <span>
                По норме в короб:{" "}
                {number(Math.min(available, capacity))} шт.
              </span>
              <span>После добавления: {Math.round(fill * 100)}%</span>
            </p>
          </div>
          <p className="form-error" role="alert" id="box-error">
            {error}
          </p>
          <Button
            primary
            type={requiresFitConfirmation ? "button" : "submit"}
            className="box-primary-action"
            disabled={w.busy || !!placementBlock}
            aria-describedby={guidance ? newBoxBlock === guidance ? "new-box-blocked" : "box-placement-help" : undefined}
            aria-busy={w.busy}
            onClick={requiresFitConfirmation ? () => void add(true) : undefined}
          >
            {w.busy
              ? "Добавляем…"
              : requiresFitConfirmation
                ? "Подтвердить и добавить"
                : newBox
                ? "Создать и добавить"
                : "Добавить в короб"}
          </Button>
          <p className="drawer-bottom">
            {closed
              ? "Для размещения вернитесь к открытым коробам."
              : "Закрытие короба и отправка — отдельные действия."}
          </p>
        </form>
      ) : null}
      {detail ? (
        <CartonDetails
          box={detail}
          workspace={w}
          onClose={() => setDetailsId(null)}
        />
      ) : null}
    </Dialog>
  );
}
