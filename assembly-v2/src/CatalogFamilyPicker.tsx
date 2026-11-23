import { useEffect, useState } from 'react';
import { catalogFamilyKey, type CatalogFamilyCard, type CatalogFamilyMatches } from '../shared/catalog-editor';
import { catalogRequest } from './catalog-client';
import { Field, NativeSelect } from './ui';

export function CatalogFamilyPicker({sku, market, store, disabled, onApply}: {
  sku: string;
  market: CatalogFamilyCard['market'];
  store: string;
  disabled: boolean;
  onApply(card: CatalogFamilyCard): Promise<boolean>;
}) {
  const family = catalogFamilyKey(sku);
  const [search,setSearch] = useState('');
  const [canSearch,setCanSearch] = useState(false);
  const [applied,setApplied] = useState('');
  const [result,setResult] = useState<{key:string; matches:CatalogFamilyMatches}>();
  const [failed,setFailed] = useState('');
  const needle = search.trim();
  const query = new URLSearchParams({family:'1',sku,market,store,q:needle}).toString();

  useEffect(() => {
    if (!family) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void catalogRequest<CatalogFamilyMatches>(`/api/catalog/fill?${query}`,undefined,controller.signal)
        .then(matches => {
          if (controller.signal.aborted) return;
          if (!needle) setCanSearch(matches.hasMore);
          setResult({key:query,matches});
        })
        .catch(() => { if (!controller.signal.aborted) setFailed(query); });
    },250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  },[query,family,needle]);

  const matches = result?.key === query ? result.matches : undefined;
  if (!family || (!result?.matches.cards.length && !canSearch && !applied)) return null;
  return <section className="catalog-fill-hint" aria-label="Шаблоны по семейству артикула">
    <strong>Заполнить по похожему товару · {family}</strong>
    {canSearch && <Field label="Поиск в семействе" type="search" value={search}
      placeholder="Артикул или название" disabled={disabled} onChange={event=>setSearch(event.target.value)}
      onKeyDown={event=>{ if(event.key==='Enter')event.preventDefault(); }}/>}
    <NativeSelect label="Товар-шаблон" value="" disabled={disabled || !matches?.cards.length}
      onChange={event=>{
        const card=matches?.cards.find(row=>row.id===event.target.value);
        if (card) void onApply(card).then(ok=>{ if(ok)setApplied(card.sku); });
      }}>
      <option value="">{matches ? (matches.cards.length ? 'Выберите артикул' : 'Ничего не найдено')
        : failed===query ? 'Не удалось загрузить товары' : 'Ищем товары…'}</option>
      {matches?.cards.map(card=><option key={card.id} value={card.id}>
        {card.sku} · {card.market}{card.store ? ` / ${card.store}` : ''}{card.name ? ` · ${card.name}` : ''}
      </option>)}
    </NativeSelect>
    {applied && <p role="status">Подставлены данные из <b>{applied}</b>. Проверьте название и параметры.</p>}
  </section>;
}
