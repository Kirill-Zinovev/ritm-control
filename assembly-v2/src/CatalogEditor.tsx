import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Plus, Save, ImagePlus } from 'lucide-react';
import { catalogKey } from '../shared/catalog';
import { productFields, type ManagedDetail, type ManagedProduct } from '../shared/catalog-editor';
import type { PrintableLabel } from '../shared/labels';
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

type HistoryItem = { before: ManagedProduct | null; after: ManagedProduct; createdAt: string };
type LabelDraft = { file: Blob; generatedFor?: string };
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
  printFolder:'',catalogDepartment:'',boxType:'',unitsPerBox:null,rollMultiplicity:'',xeroxMultiplicity:'',capacitySource:'review',photoId:null,issues:[],rows:[],
});
export function CatalogEditor({ item, importId, workspace:w, onClose, onSaved, inline=false }: {
  item:ManagedDetail | null; importId:string; workspace:Workspace; onClose():void; onSaved():void; inline?:boolean;
}) {
  const [product,setProduct]=useState<ManagedProduct>(()=>item ? {...item} : empty());
  const [aliases,setAliases]=useState(item?.aliases.filter(a=>a!==item.sku).join(', ') || '');
  const [capacity,setCapacity]=useState(item?.unitsPerBox?.toString() || '');
  const [norms,setNorms]=useState<Record<Operation,string>>({cut:String(item?.workNorms?.cut ?? ''),assembly:String(item?.workNorms?.assembly ?? ''),packing:String(item?.workNorms?.packing ?? '')});
  const [tab,setTab]=useState('Товар'),[error,setError]=useState(''),[uploading,setUploading]=useState('');
  const [changed,setChanged]=useState(false),[history,setHistory]=useState<HistoryItem[]|null>(null);
  const [options,setOptions]=useState<{norms:ShiftNorm[];machines:string[]}>({norms:[],machines:[]});
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
  const busy=w.busy || !!uploading || generating;
  const set = <K extends keyof ManagedProduct>(key:K,value:ManagedProduct[K]) => {setProduct(p=>({...p,[key]:value}));setChanged(true);};
  useEffect(() => { if (editorBody.current) editorBody.current.scrollTop = 0; }, [tab]);
  useEffect(()=>{const c=new AbortController();void catalogRequest<typeof options>('/api/catalog/options',undefined,c.signal).then(setOptions).catch(()=>{});return()=>c.abort();},[]);
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
    event.preventDefault();if(busy)return;setError('');
    if (draftOutdated) {
      setError('Данные товара изменились. Сгенерируйте этикетку заново перед сохранением.');
      return;
    }
    try {
      const draft={...product,sku:catalogKey(product.sku),aliases:[catalogKey(product.sku),...aliases.split(/[,;\n]/).map(catalogKey).filter(Boolean)],unitsPerBox:capacity ? Number(capacity) : null,
        workNorms:Object.fromEntries(Object.entries(norms).map(([k,v])=>[k,v ? Number(v.replace(',','.')) : null]))};
      if (labelDraft) {
        setUploading('label');
        draft.labelSha = (await uploadMedia(labelDraft.file)).sha256;
      }
      await w.command('catalog.save',{id:item?.id ?? null,create:!item,revision:item?.editRevision || 0,importId,product:draft},'Карточка сохранена');
      setChanged(false);onSaved();
    }catch(e){setError((e as Error).message)} finally {setUploading('')}
  }
  const changedFields=(h:HistoryItem)=>[{key:'store',label:'Магазин'},...productFields.map(([k,label])=>({key:k,label})),{key:'unitsPerBox',label:'Вместимость'},{key:'photoUrl',label:'Фото'},{key:'labelSha',label:'Этикетка'},{key:'aliases',label:'Связанные артикулы'},{key:'workNorms',label:'Нормы'}]
    .filter(({key})=>JSON.stringify(historyValue(h.before,key as keyof ManagedProduct))!==JSON.stringify(historyValue(h.after,key as keyof ManagedProduct)));
  const Surface=inline ? ManagerPanel : Dialog;
  const marketName = product.market === 'OZON' ? 'Ozon' : 'WB';
  const labelPreview = (compact: boolean) => <CatalogLabelPreview compact={compact}
    lookup={labelLookup} draftUrl={draftUrl} draftOutdated={draftOutdated} busy={busy} generating={generating}
    market={marketName} missingFields={missingLabelFields(product)}
    barcodeField={<Field label="Штрихкод" placeholder={`Введите штрихкод ${marketName}`}
      value={product.barcode} disabled={busy} autoComplete="off" spellCheck={false}
      onChange={e => set('barcode',e.target.value)}/>}
    onGenerate={() => void generateLabel()} onPrint={() => setPrinting(true)} onRetry={() => setLabelRetry(n => n + 1)}
    onUpload={() => labelFile.current?.click()}/>;
  const kicker = item ? `${item.sku} · ${item.market} · ${item.store ? `Магазин ${item.store}` : 'Магазин не указан'}` : 'Справочник Assembly';
  return <Surface title={item ? 'Карточка товара' : 'Новый товар'} kicker={kicker} className="catalog-editor" busy={busy} onClose={()=>safely(onClose)}>
    <form onSubmit={save}>
      <input ref={labelFile} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Загрузить этикетку" hidden disabled={busy}
        onChange={e=>{void stageLabel(e.target.files?.[0]);e.currentTarget.value='';}}/>
      <div className="catalog-editor-tabs" role="tablist" aria-label="Разделы карточки">{['Товар','Производство','Фото и этикетка',...(item?['История']:[])].map(t=><button key={t} type="button" role="tab" aria-selected={tab===t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t}</button>)}</div>
      <div className="catalog-editor-body" ref={editorBody}>
        {error && <p className="status-error" role="alert">{error}</p>}
        {tab==='Товар' && <>
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
            <Field label="Вид упаковки" value={product.packaging} disabled={busy} onChange={e=>set('packaging',e.target.value)}/>
            <Field label="Станок" value={product.machine} list="quick-machines" disabled={busy} onChange={e=>set('machine',e.target.value)}/>
            <datalist id="quick-machines">{options.machines.map(n=><option key={n} value={n}/>)}</datalist>
            <h3 className="catalog-box-heading">В коробке</h3>
            <div className="catalog-edit-grid">
              <Field label="Количество, шт." type="number" min={1} step={1} value={capacity} disabled={busy}
                onChange={e=>{setCapacity(e.target.value);setChanged(true)}}/>
              <Field label="Тип короба" value={product.boxType} disabled={busy} onChange={e=>set('boxType',e.target.value)}/>
            </div>
          </section>}
          <Field label="Название товара" required={!storeMissing || !!item?.name} value={product.name} disabled={busy} onChange={e=>set('name',e.target.value)}/>
          <Field label="Вид товара" value={product.kind} list="quick-kinds" disabled={busy} onChange={e=>set('kind',e.target.value)}/>
          <datalist id="quick-kinds">{options.norms.map(n=><option key={n.type} value={n.type}/>)}</datalist>
          <details className="catalog-identity" open={!item}><summary>Артикул и магазин</summary><div className="catalog-edit-grid">
            <NativeSelect label="Маркетплейс" value={product.market} disabled={!!item||busy} onChange={e=>set('market',e.target.value as 'WB'|'OZON')}><option>OZON</option><option>WB</option></NativeSelect>
            {!storeMissing && <Field label="Магазин" required value={product.store} disabled={!!item||busy} onChange={e=>set('store',e.target.value)}/>}
            <Field label="Артикул" required value={product.sku} disabled={!!item||busy} onChange={e=>set('sku',e.target.value)}/>
          </div>
          {item && !storeMissing && <p className="muted help">Артикул, магазин и маркетплейс — идентификаторы товара. Для другого товара используйте «Добавить товар».</p>}
</details>
          {!item && <section className="catalog-media-card catalog-label-overview">{labelPreview(true)}</section>}
          <Field label="Связанные артикулы" value={aliases} disabled={busy} hint="Через запятую. Например, артикул без суффикса (OZ)." onChange={e=>{setAliases(e.target.value);setChanged(true)}}/>
          <Field label="Категория" value={product.category} disabled={busy} onChange={e=>set('category',e.target.value)}/>
        </>}
        {tab==='Производство' && <>
          <div className="catalog-edit-grid">{productFields.filter(([k])=>!['name','barcode','category'].includes(k)).map(([key,label])=><Field key={key} label={label} value={product[key]} disabled={busy} list={key==='kind'?'catalog-kinds':key==='machine'?'catalog-machines':undefined} onChange={e=>set(key,e.target.value)}/>)}
            <Field label="Вместимость короба, шт." type="number" min={1} step={1} value={capacity} disabled={busy} onChange={e=>{setCapacity(e.target.value);setChanged(true)}}/>
          </div>
          <datalist id="catalog-kinds">{options.norms.map(n=><option key={n.type} value={n.type}/>)}</datalist>
          <datalist id="catalog-machines">{options.machines.map(n=><option key={n} value={n}/>)}</datalist>
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
      <div className="catalog-editor-footer"><span aria-live="polite">{uploading?'Загружаем файл…':changed?'Есть несохранённые изменения':''}</span><div><Button disabled={busy} onClick={()=>safely(onClose)}>Отмена</Button><Button primary type="submit" disabled={busy || (!!item&&!changed)}>{item?<Save size={16}/>:<Plus size={16}/>} {w.busy?'Сохраняем…':item?'Сохранить изменения':'Добавить товар'}</Button></div></div>
    </form>
    {printing && item && <LabelDialog catalogEntryId={item.id} catalogImportId={importId} onClose={()=>setPrinting(false)}/>}
  </Surface>;
}
