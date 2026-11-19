import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { catalogKey } from "../shared/catalog";
import { number, type Position } from "../shared/model";
import {
  matchesPositionQuery, positionSearchMaxLength, positionSearchMinLength,
  type PositionSearchItem, type PositionSearchPage,
} from "../shared/position-search";
import { ProductPhoto } from "./ProductPhoto";
import { Search } from "./ui";
import { request } from "./useWorkspace";
import "./assembly-search.css";

export type SearchDestination = Pick<PositionSearchItem, "id" | "sku" | "supplyId">;

type SearchResult = PositionSearchPage & { key: string; error?: boolean };

function supplyLabel(title: string, store: string) {
  const date = title.match(/\b\d{2}\.\d{2}\.\d{4}\b/)?.[0];
  const city = title.replace(/^(OZON|WB)\s+/i, "").replace(/\(\s*\d+\s+магазин\s*\)\s*$/iu, "")
    .replace(date ?? "", "").replace(/\s{2,}/g, " ").trim();
  const shop = /^\d+$/.test(store) ? `Магазин ${store}` : store;
  return { city: city || title, detail: [date, shop].filter(Boolean).join(" · ") };
}

export function AssemblySearch({ query, currentId, positions, disabled, onQuery, onSelect }: {
  query: string;
  currentId: string | null;
  positions: Position[];
  disabled: boolean;
  onQuery(value: string): void;
  onSelect(hit: SearchDestination): void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const resultsId = useId();
  const [open, setOpen] = useState(false);
  const [otherExpanded, setOtherExpanded] = useState(true);
  const [above, setAbove] = useState(false);
  const [result, setResult] = useState<SearchResult>();
  const [page, setPage] = useState({ key: "", offset: 0, retry: 0 });
  const sku = catalogKey(query).slice(0, positionSearchMaxLength);
  const visible = open && sku.length >= positionSearchMinLength;
  const key = JSON.stringify([currentId, sku]);
  const offset = page.key === key ? page.offset : 0;
  const resultForQuery = result?.key === key ? result : undefined;
  const [requested, setRequested] = useState("");
  const requestKey = JSON.stringify([key, offset, page.retry]);
  const fetching = visible && requested !== requestKey;
  const local = useMemo(() => {
    if (!visible) return [];
    const needle = query.trim().toLocaleLowerCase("ru");
    return positions.filter(p => p.supplyId === currentId && p.sourceActive !== false && matchesPositionQuery(p, needle))
      .sort((a, b) => Number(catalogKey(b.sku) === sku) - Number(catalogKey(a.sku) === sku))
      .slice(0, 6);
  }, [currentId, positions, query, sku, visible]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ q: sku, supply: currentId ?? "", offset: String(offset) });
    const timer = window.setTimeout(() => {
      void request<PositionSearchPage>(`/api/positions/search?${params}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      }).then(({ items, nextOffset }) => {
        if (controller.signal.aborted) return;
        setResult(previous => {
          const earlier = offset && previous?.key === key ? previous.items.slice(0, offset) : [];
          return { key, items: [...earlier, ...items.filter(item => !earlier.some(p => p.id === item.id))], nextOffset };
        });
      }).catch(() => {
        if (!controller.signal.aborted)
          setResult(previous => ({ key, items: previous?.key === key ? previous.items : [], nextOffset: null, error: true }));
      }).finally(() => {
        if (!controller.signal.aborted) setRequested(requestKey);
      });
    }, offset ? 0 : 160);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [currentId, key, offset, requestKey, sku, visible]);

  useEffect(() => {
    if (!visible) return;
    const dismiss = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const place = () => {
      const anchor = wrapper.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const below = top + height - anchor.bottom;
      setAbove(matchMedia("(max-width: 760px)").matches && below < height * .42 + 8 && anchor.top - top > below);
    };
    place();
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [visible]);

  function select(item: SearchDestination) {
    if (disabled) return;
    setOpen(false);
    setPage({ key: "", offset: 0, retry: 0 });
    onSelect(item);
  }

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && visible) {
      event.preventDefault();
      wrapper.current?.querySelector("input")?.focus();
      setOpen(false);
    }
    if (!visible || event.nativeEvent.isComposing || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    const input = event.target instanceof HTMLInputElement;
    if (!input && event.key === "Enter") return;
    const buttons = Array.from(wrapper.current?.querySelectorAll<HTMLButtonElement>(
      ".supply-search-popover > .supply-search-result:not(:disabled), .supply-search-popover > div:not([hidden]) > .supply-search-result:not(:disabled)",
    ) ?? []);
    const index = buttons.findIndex(button => button === event.target);
    const target = event.key === "ArrowUp" ? buttons[index - 1] : buttons[index + 1];
    if (target || index >= 0 && event.key === "ArrowUp") {
      event.preventDefault();
      if (event.key === "Enter") target?.click();
      else if (target) target.focus();
      else wrapper.current?.querySelector("input")?.focus();
    }
  }

  const otherItems = resultForQuery?.items ?? [];
  const nextOffset = resultForQuery?.nextOffset;
  return (
    <div className="supply-search" ref={wrapper} role="search" aria-label="Артикулы в поставках"
      onFocus={event => { if (event.target instanceof HTMLInputElement) setOpen(true); }}
      onClick={event => { if (event.target instanceof HTMLInputElement) setOpen(true); }}
      onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={handleKeys}>
      <Search label="Артикул или название" value={query} onChange={value => {
        setPage({ key: "", offset: 0, retry: 0 });
        setOtherExpanded(true);
        setOpen(true);
        onQuery(value);
      }} />
      {visible && (
        <div className={`supply-search-popover${above ? " is-above" : ""}`} role="region" aria-label="Результаты поиска по поставкам">
          <h2>В текущей поставке</h2>
          {local.length ? local.map(item => (
            <button type="button" key={item.id} className="supply-search-result" disabled={disabled} onClick={() => select(item)}>
              <ProductPhoto importId={item.catalogImportId ?? ""} id={item.catalog?.photoId ?? null}
                sourceUrl={item.photoUrl} sku={item.sku} />
              <span className="supply-search-copy"><strong>{item.sku}</strong><span>{item.name}</span></span>
              <span className="supply-search-packing">Упаковано {number(item.packing)} из {number(item.plan)}</span>
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          )) : <p className="supply-search-message">Нет совпадений в текущей поставке</p>}
          <button type="button" className="supply-search-section" aria-expanded={otherExpanded} aria-controls={resultsId}
            onClick={() => setOtherExpanded(value => !value)}>
            <span>В других поставках{otherItems.length ? ` · ${otherItems.length}${nextOffset != null ? "+" : ""}` : ""}</span>
            <ChevronDown size={17} aria-hidden="true" />
          </button>
          <div id={resultsId} hidden={!otherExpanded}>
            {otherItems.map(item => {
              const { city, detail } = supplyLabel(item.supplyTitle, item.store);
              return (
                <button type="button" key={item.id} className="supply-search-result" title={item.supplyTitle}
                  disabled={disabled} onClick={() => select(item)}>
                  <span className={`shipment-market${item.market === "WB" ? " is-wb" : ""}`}>{item.market}</span>
                  <span className="supply-search-copy"><strong>{city}</strong><span>
                    {[detail, catalogKey(item.sku) !== sku ? item.sku : ""].filter(Boolean).join(" · ")}
                  </span></span>
                  <span className="supply-search-packing">Упаковано {number(item.packing)} из {number(item.plan)}</span>
                  <ChevronRight size={17} aria-hidden="true" />
                </button>
              );
            })}
            {fetching ? <p className="supply-search-message" role="status">Ищем в других поставках…</p>
              : resultForQuery?.error ? <button type="button" className="supply-search-more"
                onClick={() => setPage({ key, offset, retry: page.retry + 1 })}>Повторить поиск</button>
              : nextOffset != null ? <button type="button" className="supply-search-more"
                onClick={() => setPage({ key, offset: nextOffset, retry: 0 })}>Показать ещё</button>
              : !otherItems.length ? <p className="supply-search-message">Нет совпадений в других активных поставках</p>
              : null}
          </div>
        </div>
      )}
    </div>
  );
}
