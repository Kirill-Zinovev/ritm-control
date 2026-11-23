import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Plus, Save, ImagePlus } from 'lucide-react';
import { catalogKey, spreadsheetError } from '../shared/catalog';
import { catalogFamilyKey, productFields, type ManagedDetail, type ManagedProduct } from '../shared/catalog-editor';
import { labelArticle, type PrintableLabel } from '../shared/labels';
import { effectiveWorkNorms, type ShiftNorm } from '../shared/work-norm';
import { dateTime, operationLabels, type Operation } from '../shared/model';
import { Button, Dialog, Field, NativeSelect } from './ui';
import { ProductPhoto } from './ProductPhoto';
import { catalogRequest } from './catalog-client';
import { useDirty, useDraftNavigation } from './DraftGuard';
import type { Workspace } from './useWorkspace';
import { LabelDialog } from './LabelDialog';
import { ManagerPanel } from './ManagerPanel';
import { CatalogLabelPreview, type LabelLookup } from './CatalogLabelPreview';
import { labelInputKey, missingLabelFields } from '../shared/product-label-fields';
import { CatalogChoiceField } from './CatalogChoiceField';
import { CatalogFamilyPicker } from './CatalogFamilyPicker';

type HistoryItem = { before: ManagedProduct | null; after: ManagedProduct; createdAt: string };
type LabelDraft = { file: Blob; generatedFor?: string };
type ReferenceCard = Pick<ManagedDetail, 'id' | 'market' | 'store' | 'name'>;
type FillHelp = {cards: ReferenceCard[]; capacities: number[]};
const reusableFields = productFields.filter(([key]) => key !== 'barcode');
function templateValues(source: ManagedProduct) {
  return Object.fromEntries(reusableFields.flatMap(([key]) => {
    const value = source[key]?.trim();
    return value && !spreadsheetError(value) ? [[key,value]] : [];
  }));
}
const shopLabel = (card: ReferenceCard) => `${card.market} · ${card.store ? 'магазин '+card.store : 'магазин не указан'}`;
const operations = ['cut','assembly','packing'] as const;
function machineSection(machine: string) {
  const value = catalogKey(machine).replace(/[-‑–\s]+/g, ' ');
  if (['2 GO','УФ','УФ БЕЛ.','УФ. БЕЛ','УФ БЕЛЫЙ','УФ ДВУСТОРОННИЙ'].includes(value)) return 'Рулонная печать';
  return ['УФ ПЛАНШЕТ','DTF','XEROX'].includes(value) ? 'Бокс' : '';
}
function historyValue(product: ManagedProduct | null, key: keyof ManagedProduct) {
  if (key === 'workNorms') return Object.fromEntries(Object.entries(product?.workNorms ?? {}).filter(([, value]) => value != null));
  return product?.[key] ?? null;
}
async function uploadMedia(file: Blob) {
  const response = await fetch('/api/catalog/media', {
    method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' },
  });
  const data = await response.json() as { sha256: string; url: string; error?: string };
  if (!response.ok) throw Error(data.error || 'Файл не загрузился.');
  return data;
}

const empty = (): ManagedProduct => ({
  id:'',market:'OZON',store:'1',sku:'',aliases:[],name:'',barcode:'',kind:'',category:'',machine:'',packaging:'',size:'',sheetsPerUnit:'',
  printFolder:'',printExtension:'',catalogDepartment:'',boxType:'',unitsPerBox:null,rollMultiplicity:'',xeroxMultiplicity:'',capacitySource:'review',photoId:null,issues:[],rows:[],
});
export function CatalogEditor({ item, initialDraft, importId, workspace:w, onClose, onSaved, onOpenExisting, inline=false }: {
  item:ManagedDetail | null; initialDraft?:ManagedProduct; importId:string; workspace:Workspace;
  onClose():void; onSaved(nextDraft?:ManagedProduct):void; inline?:boolean;
  onOpenExisting?(entry: ManagedDetail): void;
}) {
  const initial = item ?? initialDraft;
  const [product,setProduct]=useState<ManagedProduct>(()=>initial ? {...initial} : empty());
  const [aliases,setAliases]=useState(item?.aliases.filter(a=>a!==item.sku).join(', ') || '');
  const [capacity,setCapacity]=useState(initial?.unitsPerBox?.toString() || '');
  const [norms,setNorms]=useState<Record<Operation,string>>({cut:String(initial?.workNorms?.cut ?? ''),assembly:String(initial?.workNorms?.assembly ?? ''),packing:String(initial?.workNorms?.packing ?? '')});
  const [tab,setTab]=useState('Товар'),[error,setError]=useState(''),[uploading,setUploading]=useState('');
  const [focusField,setFocusField]=useState('');
  const [changed,setChanged]=useState(!!initialDraft),[history,setHistory]=useState<HistoryItem[]|null>(null);
  const [options,setOptions]=useState<{norms:ShiftNorm[];machines:string[];packaging:string[];boxTypes:string[]}>({norms:[],machines:[],packaging:[],boxTypes:[]});
  const [help,setHelp]=useState<{key:string;value:FillHelp}>();
  const [base,setBase]=useState<ManagedDetail>();
  const [referenceLoading,setReferenceLoading]=useState('');
  const [printing,setPrinting]=useState(false);
  const [labelLookup, setLabelLookup] = useState<LabelLookup>({ state: item ? 'loading' : 'new' });
  const [labelRetry, setLabelRetry] = useState(0);
  const [labelDraft, setLabelDraft] = useState<LabelDraft>();
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const labelFile = useRef<HTMLInputElement>(null);
  const editorBody = useRef<HTMLDivElement>(null);
  const entryId = item?.id;
  const storeMissing = item?.store === '';
  const draftOutdated = !!labelDraft?.generatedFor && labelDraft.generatedFor !== labelInputKey(product);
  useDirty(changed); const safely=useDraftNavigation();
  const busy=w.busy || !!uploading || generating || !!referenceLoading;
  const needsWbBarcode = !!initialDraft && (!product.barcode.trim() || spreadsheetError(product.barcode));
  const set = <K extends keyof ManagedProduct>(key:K,value:ManagedProduct[K]) => {setProduct(p=>({...p,[key]:value}));setChanged(true);};
  useEffect(() => { if (editorBody.current) editorBody.current.scrollTop = 0; }, [tab]);
  useEffect(() => {
    if (!focusField) return;
    const field = editorBody.current?.querySelector<HTMLInputElement>(`[data-label-input="${focusField}"]`);
    if (field) {
      const details = field.closest('details');
      if (details) details.open = true;
      field.focus();
      field.scrollIntoView({block:'nearest'});
    }
    setFocusField('');
  },[focusField,tab]);
  useEffect(()=>{const c=new AbortController();void catalogRequest<typeof options>('/api/catalog/options',undefined,c.signal).then(setOptions).catch(()=>{});return()=>c.abort();},[]);
  const sku = item ? '' : catalogKey(product.sku);
  const fillQuery = String(new URLSearchParams({market:product.market, sku, kind:product.kind.trim(), box:product.boxType.trim()}));
  useEffect(() => {
    if (!sku && !(product.kind.trim() && product.boxType.trim())) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void catalogRequest<FillHelp>(`/api/catalog/fill?${fillQuery}`,undefined,controller.signal)
        .then(value => {if(!controller.signal.aborted)setHelp({key:fillQuery,value});})
        .catch(() => {});
    }, 250);
    return () => {clearTimeout(timer);controller.abort();};
  }, [fillQuery,sku,product.kind,product.boxType]);
  const assistance = help?.key === fillQuery ? help.value : undefined;
  const duplicate = sku ? assistance?.cards.find(card => card.market===product.market && card.store===product.store.trim()) : undefined;
  const references = sku ? assistance?.cards.filter(card => card.store && card.id!==duplicate?.id) ?? [] : [];
  const selectedBase = base && references.some(reference=>reference.id===base.id) ? base : undefined;
  const fillFields = reusableFields.filter(([key]) => {
    const value = selectedBase?.[key]?.trim() || '';
    return value && !spreadsheetError(value) && !product[key]?.trim();
  });
  const fillPhoto = !product.photoUrl && !product.photoId ? selectedBase?.photoUrl || selectedBase?.photo?.primary : null;
  async function loadReference(card:ReferenceCard, action:'open'|'preview'|'family') {
    setReferenceLoading(card.id);setError('');
    try {
      const params = new URLSearchParams({import:importId,id:card.id});
      const detail = await catalogRequest<ManagedDetail>(`/api/catalog/entry?${params}`);
      if (action==='open') onOpenExisting?.(detail);
      if (action==='preview') setBase(detail);
      if (action==='family') {
        setProduct(current=>({...current,...templateValues(detail)}));
        setCapacity(detail.unitsPerBox?.toString() || '');
        setNorms({cut:String(detail.workNorms?.cut ?? ''),assembly:String(detail.workNorms?.assembly ?? ''),packing:String(detail.workNorms?.packing ?? '')});
        setBase(undefined);
        setChanged(true);
      }
      return true;
    } catch (error) {setError((error as Error).message);return false;}
    finally {setReferenceLoading('');}
  }
  function applyReference() {
    if (!selectedBase) return;
    setProduct(current=>({...current,...Object.fromEntries(fillFields.map(([key])=>[key,selectedBase[key]])),
      ...(fillPhoto ? {photoUrl:fillPhoto} : {})}));
    setBase(undefined);
    setChanged(true);
  }
  useEffect(() => {
    if (!entryId) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ entry: entryId, catalogImport: importId });
    setLabelLookup({ state: 'loading' });
    void catalogRequest<{ items: PrintableLabel[] }>(`/api/labels?${params}`, undefined, controller.signal)
      .then(({ items: [label] }) => {
        if (!controller.signal.aborted) setLabelLookup(label ? { state: 'ready', label } : { state: 'error' });
      })
      .catch(() => { if (!controller.signal.aborted) setLabelLookup({ state: 'error' }); });
    return () => controller.abort();
  }, [entryId, importId, labelRetry]);
  useEffect(() => {
    if (!labelDraft) return;
    const url = URL.createObjectURL(labelDraft.file);
    setDraftUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [labelDraft]);
  useEffect(()=>{if(tab!=='История' || !item)return;const c=new AbortController();void catalogRequest<{items:HistoryItem[]}>(`/api/catalog/history?id=${encodeURIComponent(item.id)}`,undefined,c.signal).then(r=>setHistory(r.items)).catch(e=>{if(!c.signal.aborted)setError(e.message)});return()=>c.abort();},[tab,item]);
  const computed=useMemo(()=>effectiveWorkNorms({...product,editRevision:1,workNorms:Object.fromEntries(Object.entries(norms).map(([k,v])=>[k,v ? Number(v.replace(',','.')) : null]))},options.norms),[product,norms,options.norms]);
  async function uploadPhoto(file:File|undefined) {
    if(!file)return;setError('');setUploading('photo');
    try {
      if(file.size>8*1024*1024)throw Error('Максимальный размер изображения — 8 МБ.');
      set('photoUrl', (await uploadMedia(file)).url);
    } catch(e){setError((e as Error).message)} finally{setUploading('')}
  }
  async function stageLabel(file: File | undefined) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setError('Максимальный размер этикетки — 8 МБ.');
      return;
    }
    setError('');
    setUploading('label');
    try {
      const bitmap = await createImageBitmap(file);
      bitmap.close();
      setLabelDraft({ file });
      setChanged(true);
    } catch {
      setError('Не удалось прочитать этикетку. Выберите изображение PNG, JPG или WebP.');
    } finally {
      setUploading('');
    }
  }
  async function generateLabel() {
    if (busy) return;
    setError('');
    setGenerating(true);
    try {
      const { generateProductLabel } = await import('./generate-product-label');
      const file = await generateProductLabel(product);
      setLabelDraft({ file, generatedFor: labelInputKey(product) });
      setChanged(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось сгенерировать этикетку.');
    } finally {
      setGenerating(false);
    }
  }
  async function save(event:FormEvent) {
    event.preventDefault();if(busy || duplicate || needsWbBarcode)return;setError('');
    const createWb = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('data-catalog-action') === 'wb'
      && product.market==='OZON';
    if (draftOutdated) {
      setError('Данные товара изменились. Сгенерируйте этикетку заново перед сохранением.');
      return;
    }
    try {
      const draft:ManagedProduct={...product,sku:catalogKey(product.sku),aliases:[catalogKey(product.sku),...aliases.split(/[,;\n]/).map(catalogKey).filter(Boolean)],unitsPerBox:capacity ? Number(capacity) : null,
        workNorms:Object.fromEntries(Object.entries(norms).map(([k,v])=>[k,v ? Number(v.replace(',','.')) : null]))};
      if (labelDraft) {
        setUploading('label');
        draft.labelSha = (await uploadMedia(labelDraft.file)).sha256;
      }
      if (!createWb || !item || changed)
        await w.command('catalog.save',{id:item?.id ?? null,create:!item,revision:item?.editRevision || 0,importId,product:draft},'Карточка сохранена');
      setChanged(false);
      onSaved(createWb ? {
        ...empty(),...templateValues(draft),market:'WB',store:draft.store,
        sku:labelArticle(draft.sku,'OZON'),
        unitsPerBox:draft.unitsPerBox,workNorms:draft.workNorms,
        photoUrl:draft.photoUrl ?? item?.photo?.primary ?? null,
      } : undefined);
    }catch(e){setError((e as Error).message)} finally {setUploading('')}
  }
  const changedFields=(h:HistoryItem)=>[{key:'store',label:'Магазин'},...productFields.map(([k,label])=>({key:k,label})),{key:'unitsPerBox',label:'Вместимость'},{key:'photoUrl',label:'Фото'},{key:'labelSha',label:'Этикетка'},{key:'aliases',label:'Связанные артикулы'},{key:'workNorms',label:'Нормы'}]
    .filter(({key})=>JSON.stringify(historyValue(h.before,key as keyof ManagedProduct))!==JSON.stringify(historyValue(h.after,key as keyof ManagedProduct)));
  const Surface=inline ? ManagerPanel : Dialog;
  const marketName = product.market === 'OZON' ? 'Ozon' : 'WB';
  const labelFields = missingLabelFields(product);
  const firstLabelField = labelFields[0]?.startsWith('упаковка') ? 'упаковка' : labelFields[0];
  const labelPreview = (compact: boolean) => <CatalogLabelPreview compact={compact}
    lookup={labelLookup} draftUrl={draftUrl} draftOutdated={draftOutdated} busy={busy} generating={generating}
    market={marketName} missingFields={labelFields}
    onFill={firstLabelField && (!item || !['артикул','номер магазина'].includes(firstLabelField))
      ? () => {setTab('Товар');setFocusField(firstLabelField);} : undefined}
    barcodeField={<Field label="Штрихкод" placeholder={`Введите штрихкод ${marketName}`}
      value={product.barcode} required={!!initialDraft} disabled={busy} autoComplete="off" spellCheck={false} data-label-input="штрихкод"
      onChange={e => set('barcode',e.target.value)}/>}
    onGenerate={() => void generateLabel()} onPrint={() => setPrinting(true)} onRetry={() => setLabelRetry(n => n + 1)}
    onUpload={() => labelFile.current?.click()}/>;
  const kicker = item ? `${item.sku} · ${item.market} · ${item.store ? `Магазин ${item.store}` : 'Магазин не указан'}`
    : initialDraft ? 'Черновик WB' : 'Справочник RITM Сборка';
  const choiceLists = {machine:options.machines,kind:options.norms.map(norm=>norm.type),packaging:options.packaging,boxType:options.boxTypes};
  function choice(field:keyof typeof choiceLists,label:string) {
    return <CatalogChoiceField label={label} value={product[field]} disabled={busy}
      inputTag={field==='packaging'?'упаковка':undefined}
      options={choiceLists[field] ?? []} onChange={value=>set(field,value)}/>;
  }
  const section = machineSection(product.machine);
  const identity = <details className="catalog-identity" open={!item}><summary>Артикул и магазин</summary>
    <div className="catalog-edit-grid">
      <Field label="Артикул" required value={product.sku} data-label-input="артикул" disabled={!!item||busy} onChange={e=>{setBase(undefined);set('sku',e.target.value);}}/>
      <NativeSelect label="Маркетплейс" value={product.market} disabled={!!item||!!initialDraft||busy} onChange={e=>{setBase(undefined);set('market',e.target.value as 'WB'|'OZON');}}><option>OZON</option><option>WB</option></NativeSelect>
      {!storeMissing && (item ? <Field label="Магазин" value={product.store} disabled/> :
        <NativeSelect label="Магазин" value={product.store} disabled={busy} onChange={e=>{setBase(undefined);set('store',e.target.value);}}>
          <option value="1">Магазин 1</option><option value="2">Магазин 2</option>
        </NativeSelect>)}
    </div>
    {duplicate && <div className="catalog-fill-hint" role="status">
      <strong>Такая карточка уже есть · {shopLabel(duplicate)}</strong>
      {onOpenExisting && <Button disabled={busy} onClick={()=>safely(()=>void loadReference(duplicate,'open'))}>Открыть карточку</Button>}
    </div>}
    {!duplicate && references.length>0 && <div className="catalog-fill-hint">
      {selectedBase ? <>
        <strong>{selectedBase.name || selectedBase.sku} · {shopLabel(selectedBase)}</strong>
        <p>{fillFields.length || fillPhoto ? [...fillFields.map(([,label])=>label),...(fillPhoto?['Фото']:[])].join(' · ') : 'Подходящие поля уже заполнены.'}</p>
        <div className="catalog-fill-actions">
          <Button disabled={busy || (!fillFields.length&&!fillPhoto)} onClick={applyReference}>Заполнить пустые поля</Button>
          <Button disabled={busy} onClick={()=>setBase(undefined)}>Назад</Button>
        </div>
      </> : <>
        <strong>Взять за основу</strong>
        <div className="catalog-fill-actions">{references.map(card=><Button key={card.id} disabled={busy} onClick={()=>void loadReference(card,'preview')}>
          {shopLabel(card)}{referenceLoading===card.id ? ' · Открываем…' : ''}
        </Button>)}</div>
      </>}
    </div>}
    {!item && !duplicate && <CatalogFamilyPicker key={catalogFamilyKey(sku)} sku={sku} market={product.market} store={product.store.trim()}
      disabled={busy} onApply={card=>loadReference(card,'family')}/>}
    {item && !storeMissing && <p className="muted help">Для другого артикула или магазина используйте «Добавить товар».</p>}
  </details>;
  const capacityChoices = assistance?.capacities ?? [];
  const capacityHint = capacityChoices.length>0 && <div className="catalog-fill-hint">
    <strong>{capacityChoices.length===1 ? 'Вместимость по справочнику' : 'Для этого товара и короба есть разные варианты'}</strong>
    <div className="catalog-fill-actions">
      {capacityChoices.map(quantity=><Button key={quantity} disabled={busy || capacity===String(quantity)}
        onClick={()=>{setCapacity(String(quantity));setChanged(true);}}>
        {capacityChoices.length===1 && capacity!==String(quantity) ? 'Подставить ' : ''}{quantity} шт.
      </Button>)}
    </div>
  </div>;
  const normsHint = product.kind.trim() && <p className="muted help" aria-live="polite">
    {operations.map(op=>`${operationLabels[op]}: ${computed[op] ?? '—'}`).join(' · ')} шт./смену
  </p>;
  return <Surface title={item ? 'Карточка товара' : 'Новый товар'} kicker={kicker} className="catalog-editor" busy={busy} onClose={()=>safely(onClose)}>
    <form onSubmit={save}>
      <input ref={labelFile} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Загрузить этикетку" hidden disabled={busy}
        onChange={e=>{void stageLabel(e.target.files?.[0]);e.currentTarget.value='';}}/>
      <div className="catalog-editor-tabs" role="tablist" aria-label="Разделы карточки">{['Товар','Производство','Фото и этикетка',...(item?['История']:[])].map(t=><button key={t} type="button" role="tab" aria-selected={tab===t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t}</button>)}</div>
      <div className="catalog-editor-body" ref={editorBody}>
        {error && <p className="status-error" role="alert">{error}</p>}
        {tab==='Товар' && <>
          {!item && identity}
          {item && <>
            <div className="catalog-edit-intro">
              <ProductPhoto importId={importId} id={product.photoId} sourceUrl={product.photoUrl} sku={product.sku}/>
              <strong>{product.name || 'Название требует проверки'}</strong>
            </div>
            {storeMissing && <NativeSelect label="Магазин" required value={product.store} disabled={busy}
              onChange={e=>set('store',e.target.value)}>
              <option value="" disabled>Выберите магазин</option>
              <option value="1">Магазин 1</option>
              <option value="2">Магазин 2</option>
            </NativeSelect>}
            <section className="catalog-media-card catalog-label-overview">{labelPreview(true)}</section>
          </>}
          {inline && <section className="catalog-quick-fields">
            <h3>Упаковка</h3>
            {choice('packaging','Вид упаковки')}
            {choice('machine','Станок')}
            {section && <p className="muted help" aria-live="polite">Участок · {section}</p>}
            {catalogKey(product.machine)==='XEROX' && <div className="catalog-edit-grid">
              <Field label="Листов на изделие" type="number" min={1} step={1} value={product.sheetsPerUnit}
                disabled={busy} onChange={e=>set('sheetsPerUnit',e.target.value)}/>
              <Field label="Кратность Xerox" type="number" min={1} step={1} value={product.xeroxMultiplicity}
                disabled={busy} onChange={e=>set('xeroxMultiplicity',e.target.value)}/>
            </div>}
            <h3 className="catalog-box-heading">В коробке</h3>
            <div className="catalog-edit-grid">
              <Field label="Количество, шт." type="number" min={1} step={1} value={capacity} disabled={busy}
                onChange={e=>{setCapacity(e.target.value);setChanged(true)}}/>
              {choice('boxType','Тип короба')}
            </div>
          </section>}
          <Field label="Название товара" data-label-input="название товара" required={!storeMissing || !!item?.name} value={product.name} disabled={busy} onChange={e=>set('name',e.target.value)}/>
          {choice('kind','Вид товара')}
          {normsHint}
          {inline && capacityHint}
          {item && identity}
          {!item && <section className="catalog-media-card catalog-label-overview">{labelPreview(true)}</section>}
          <Field label="Связанные артикулы" value={aliases} disabled={busy} hint="Через запятую. Например, артикул без суффикса (OZ)." onChange={e=>{setAliases(e.target.value);setChanged(true)}}/>
          <Field label="Категория" value={product.category} disabled={busy} onChange={e=>set('category',e.target.value)}/>
        </>}
        {tab==='Производство' && <>
          <div className="catalog-edit-grid">{productFields.filter(([k])=>!['name','barcode','category'].includes(k)).map(([key,label])=>
            key==='kind' || key==='machine' || key==='packaging' || key==='boxType'
              ? <CatalogChoiceField key={key} label={label} value={product[key]} options={choiceLists[key] ?? []} disabled={busy} onChange={value=>set(key,value)}/>
              : <Field key={key} label={label} value={product[key] ?? ''} disabled={busy} onChange={e=>set(key,e.target.value)}/>)}
            <Field label="Вместимость короба, шт." type="number" min={1} step={1} value={capacity} disabled={busy} onChange={e=>{setCapacity(e.target.value);setChanged(true)}}/>
          </div>
          {capacityHint}
          <section className="catalog-norm-panel"><h3>Нормы за смену</h3><p>Готовых изделий за смену. Пустое поле — норма выбранного вида товара. Ранее записанные кэфы сохраняются.</p>
            <div className="catalog-edit-grid">{(['cut','assembly','packing'] as const).map(op=><Field key={op} label={operationLabels[op]} type="number" min={0.01} step="any" value={norms[op]} disabled={busy} placeholder="По виду товара" hint={`Для новых записей: ${computed[op] ?? 'норма не задана'}${computed[op] ? ' шт./смену' : ''}`} onChange={e=>{setNorms(n=>({...n,[op]:e.target.value}));setChanged(true)}}/>)}</div>
          </section>
          <p className="muted help">Вместимость пересчитывается в коробах, ещё не выбранных на отгрузку. Количество товара не меняется.</p>
        </>}
        {tab==='Фото и этикетка' && <div className="catalog-media-grid">
          <section className="catalog-media-card"><h3><ImagePlus size={18}/>Фото товара</h3><div className="catalog-media-preview"><ProductPhoto importId={importId} id={product.photoId} sourceUrl={product.photoUrl} sku={product.sku}/></div>
            <Field label="Загрузить фото" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e=>void uploadPhoto(e.target.files?.[0])}/>
            <Field label="Ссылка на фото WB" value={product.photoUrl?.startsWith('https:')?product.photoUrl:''} disabled={busy} onChange={e=>set('photoUrl',e.target.value)}/>
          </section>
          <section className="catalog-media-card">{labelPreview(false)}
            <p className="muted help">PNG, JPG или WebP до 8 МБ. Размер этикетки при генерации — 58 × 40 мм.</p>
          </section>
        </div>}
        {tab==='История' && (history===null ? <p>Загружаем историю…</p>:history.length ? <div className="catalog-edit-history">{history.map(h=><article key={h.after.editRevision}><strong>{h.before?'Карточка обновлена':'Товар добавлен'}</strong><time>{dateTime(h.createdAt)} МСК</time><p>{changedFields(h).map(f=>f.label).join(' · ')}</p><details><summary>Что изменилось</summary>{changedFields(h).map(({key,label})=><p key={key}><b>{label}: </b>{['photoUrl','labelSha'].includes(key)?'Файл обновлён':`${JSON.stringify(h.before?.[key as keyof ManagedProduct] ?? '—')} → ${JSON.stringify(h.after[key as keyof ManagedProduct] ?? '—')}`}</p>)}</details></article>)}</div>:<p className="muted">Изменений через редактор пока нет. Исходная карточка сохранена.</p>)}
      </div>
      <div className="catalog-editor-footer">
        <span aria-live="polite">{uploading?'Загружаем файл…':changed?'Есть несохранённые изменения':''}</span>
        <div><Button disabled={busy} onClick={()=>safely(onClose)}>Отмена</Button><Button primary type="submit" disabled={busy || !!duplicate || needsWbBarcode || (!!item&&!changed)}>{item?<Save size={16}/>:<Plus size={16}/>} {w.busy?'Сохраняем…':item?'Сохранить изменения':'Добавить товар'}</Button></div>
        {product.market==='OZON' && <Button className="catalog-wb-create" type="submit" data-catalog-action="wb"
          disabled={busy || !!duplicate || !product.sku.trim() || !product.name.trim() || !product.store.trim()}>
          <Plus size={16} aria-hidden="true"/>Создать карточку артикула для WB
        </Button>}
      </div>
    </form>
    {printing && item && <LabelDialog catalogEntryId={item.id} catalogImportId={importId} onClose={()=>setPrinting(false)}/>}
  </Surface>;
}
