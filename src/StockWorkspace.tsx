import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Box, ClipboardCheck, ExternalLink, FileSpreadsheet, ImageOff, Layers3, PackagePlus, Printer, Trash2 } from 'lucide-react';
import { Button, Field, Notice } from './ui';
import { parseSupplyWorkbook, type SupplyImportLine } from './supplySpreadsheet';
import { runStockRequest } from './stockRecovery';
import StockTaskHistory from './StockTaskHistory';
import './stockWorkspace.css';

type Destination = 'warehouse' | 'urgent';
type RoundingDirection = 'down' | 'up';
type RoundingChoice = { direction: RoundingDirection; quantity: number; newQuantity: number; sheets?: number };
type Change = SupplyImportLine & {
  department: 'roll' | 'box' | null;
  action: 'insert' | 'increase' | 'skip';
  previousQuantity?: number;
  newQuantity?: number;
  issue?: string | null;
  photoUrl?: string;
  machine?: string;
  stockDetails?: { name: string; kind: string; size: string; printFolder: string };
  rounding?: {kind:'roll'|'xerox';multiplicity:number;choices:RoundingChoice[]};
};
type Preview = { fingerprint: string; changes: Change[] };
type Pending = { operationId:string; input:{destination:Destination;lines:SupplyImportLine[]; rounding?:{article:string;direction:RoundingDirection}[]}; expectedFingerprint:string };
type RecoveryStep = {department:'roll'|'box';status:string;plan?:{entries?:SupplyImportLine[]}};
type RecoveryOperation = {status:string;message?:string;steps?:RecoveryStep[]};
type RecoveryResult = {operation?:RecoveryOperation;notSaved?:boolean;message?:string};

function parseLines(text:string):SupplyImportLine[] {
  const lines=text.split(/\r?\n/).filter(line=>line.trim());
  if(!lines.length||lines.length>500)throw new Error('Укажите от 1 до 500 строк с артикулом и количеством.');
  return lines.map((line,index)=>{
    const parts=line.trim().split(/[;\t,]+/).map(part=>part.trim());
    const quantity=Number(parts[1]);
    if(parts.length!==2||!parts[0]||!Number.isSafeInteger(quantity)||quantity<=0)throw new Error(`Проверьте строку ${index+1}: укажите артикул и целое количество через точку с запятой.`);
    return {article:parts[0],quantity};
  });
}
async function request<T>(path:string,body:unknown):Promise<T>{
  const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json() as T & {ok?:boolean;message?:string};
  if(!response.ok||data.ok===false)throw new Error(data.message||'Не удалось выполнить операцию.');
  return data;
}

export default function StockWorkspace(){
  const [destination,setDestination]=useState<Destination>('warehouse'),[text,setText]=useState(''),[preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [pendingState]=useState(()=>{try{const raw=sessionStorage.getItem('ritm:stock-pending');if(!raw)return {value:null,invalid:false};const value=JSON.parse(raw) as Pending;if(!value||typeof value.operationId!=='string'||typeof value.expectedFingerprint!=='string'||!Array.isArray(value.input?.lines)||!['warehouse','urgent'].includes(value.input.destination))return {value:null,invalid:true};return {value,invalid:false};}catch{return {value:null,invalid:true};}});
  const [pending,setPending]=useState<Pending|null>(pendingState.value);
  const [recovery,setRecovery]=useState<RecoveryOperation|null>(null);
  const recoveryStarted=useRef(false);
  const [historyRevision,setHistoryRevision]=useState(0);
  const [checkedInput,setCheckedInput]=useState<{destination:Destination;lines:SupplyImportLine[]}|null>(null);
  const [rounding, setRounding] = useState(() => new Map<string, RoundingDirection>());
  const needsRounding = preview?.changes.filter(row => row.rounding) || [];
  const choiceFor = (row: Change) => row.rounding?.choices.find(choice => choice.direction === rounding.get(row.article));
  const roundingPending = needsRounding.some(row => !choiceFor(row));
  const additions = (preview?.changes || []).reduce((total, row) => total + (row.action === 'skip' ? 0 :
    row.rounding ? choiceFor(row)?.quantity ?? 0 : row.quantity), 0);
  const changeInput=(value:string)=>{setText(value);setPreview(null);setRounding(new Map());setMessage('');};
  async function importFile(file:File|undefined){if(!file)return;setBusy(true);try{const lines=await parseSupplyWorkbook(await file.arrayBuffer());changeInput(lines.map(line=>`${line.article}; ${line.quantity}`).join('\n'));}catch(error){setMessage(error instanceof Error?error.message:'Не удалось прочитать файл.');}finally{setBusy(false);}}
  async function check(){setBusy(true);setMessage('');setPreview(null);setRounding(new Map());try{const input={destination,lines:parseLines(text)};const result=await request<{preview:Preview}>('/api/stocks/preview',input);setCheckedInput(input);setPreview(result.preview);}catch(error){setMessage(error instanceof Error?error.message:'Не удалось проверить список.');}finally{setBusy(false);}}
  function removeDraft(article:string){if(pending||busy)return;const key=article.trim().toUpperCase();changeInput(text.split(/\r?\n/).filter(line=>line.trim().split(/[;\t,]+/)[0]?.trim().toUpperCase()!==key).join('\n'));setCheckedInput(null);setMessage('Позиция убрана из списка. Проверьте оставшиеся артикулы ещё раз.');}
  async function save(){
    if(!pending&&(!preview||!checkedInput||roundingPending||!additions))return;
    const decisions = needsRounding.flatMap(row => {
      const choice = choiceFor(row);
      return choice ? [{article:row.article,direction:choice.direction}] : [];
    });
    const payload=pending||{operationId:crypto.randomUUID(),input:{...checkedInput!,...(decisions.length > 0 && {rounding:decisions})},expectedFingerprint:preview!.fingerprint};
    setPending(payload);
    try{sessionStorage.setItem('ritm:stock-pending',JSON.stringify(payload));}
    catch{setMessage('Браузер не сохранил защиту от повтора. Запись остановлена.');setPending(null);return;}
    setBusy(true);setMessage('');
    try{
      const result=await runStockRequest((data:Pending)=>request<RecoveryResult>('/api/stocks',data),payload,{
        onRetry:()=>setMessage('Сверяем сохранение с таблицей…'),
        onResult:(response:RecoveryResult)=>setRecovery(response.operation||null),
      });
      if(result.notSaved||result.operation?.status==='not_saved'){
        setPending(null);setRecovery(null);sessionStorage.removeItem('ritm:stock-pending');setPreview(null);
        setMessage(result.message||result.operation?.message||'Запись не отправлена. Проверьте список заново.');
      }else if(result.operation?.status==='verified'){
        setPending(null);setRecovery(null);sessionStorage.removeItem('ritm:stock-pending');setPreview(null);setText('');
        setMessage('Запасы добавлены и проверены.');setHistoryRevision(value=>value+1);
      }
    }catch(error){setMessage((error instanceof Error?error.message:'Ответ не получен.')+' Сохранённый запрос требует проверки; не создавайте новый.');}
    finally{setBusy(false);}
  }
  useEffect(()=>{if(pending && !pendingState.invalid && !recoveryStarted.current){recoveryStarted.current=true;void save();}},[]);
  return <section className="panel stock-workspace"><div className="stock-header"><div className="stock-header-icon"><PackagePlus size={24}/></div><div><h2>Запасы для производства</h2><p className="stock-workspace-intro">Добавьте товары на склад или на срочный второй этаж. Артикулы распределятся между боксом и рулонной печатью.</p></div></div>
    {pendingState.invalid&&<Notice tone="warning">Не удалось прочитать состояние предыдущего запроса. Добавление заблокировано до проверки результата.</Notice>}
    <div className="stock-layout"><div className="stock-form"><div className="stock-form-heading"><div><h3>Подготовка задания</h3><p>Укажите, куда направить товары, и добавьте список.</p></div><span className="stock-heading-icon"><ClipboardCheck size={21}/></span></div><Field label="Назначение"><select value={destination} disabled={busy||!!pending||pendingState.invalid} onChange={e=>{setDestination(e.target.value as Destination);setPreview(null);setRounding(new Map());}}><option value="warehouse">Запасы склад</option><option value="urgent">Срочные 2 этаж</option></select></Field>
    <Field label="Артикулы и количество"><textarea rows={8} value={text} disabled={busy||!!pending||pendingState.invalid} onChange={e=>changeInput(e.target.value)} placeholder={'Артикул; количество\nНапример: NC0005.A5121; 20'} /></Field>
    <p className="stock-input-hint">Каждый артикул — с новой строки. Количество укажите через точку с запятой.</p>
    <div className="stock-file"><span className="stock-file-icon"><FileSpreadsheet size={20}/></span><Field label="Или загрузите Excel"><input type="file" accept=".xlsx" disabled={busy||!!pending||pendingState.invalid} onChange={e=>void importFile(e.target.files?.[0])} /></Field></div>
    <div className="stock-form-actions"><span>Перед добавлением проверьте распределение.</span><Button kind="primary" disabled={busy||!!pending||pendingState.invalid} onClick={()=>void check()}>{busy?'Проверяем…':'Проверить и распределить'} <ArrowRight size={16}/></Button></div></div>
    <aside className="stock-guide" aria-label="Работа с запасами"><div className="stock-guide-top"><span className="stock-guide-icon"><Layers3 size={22}/></span><h3>Как распределяются товары</h3><p>RITM определит участок по станку в базе и покажет результат перед добавлением.</p></div><div className="stock-route"><div><span className="stock-route-icon stock-route-icon--box"><Box size={18}/></span><span><strong>Бокс</strong><small>Задания для бокса</small></span></div><div><span className="stock-route-icon"><Printer size={18}/></span><span><strong>Рулонная печать</strong><small>Задания для рулонной печати</small></span></div></div><p className="stock-guide-note">Если артикул уже есть в выбранном списке запасов, количество прибавится к плану.</p><div className="stock-workspace-links"><a href="https://docs.google.com/spreadsheets/d/1VWIy6t3cIJzTMHgtwkiZKUbzjHf1TBSDNV1TJSrUMaI/edit" target="_blank" rel="noreferrer">Таблица бокса <ExternalLink size={15}/></a><a href="https://docs.google.com/spreadsheets/d/1vzLLRe7oi4IlvzIaWZd08dte7byCkqeXVAL4iSFqhOg/edit" target="_blank" rel="noreferrer">Таблица рулонной печати <ExternalLink size={15}/></a></div></aside></div>
    {preview&&<div className="stock-preview">
      <div className="stock-preview-heading">
        <div><h3>Проверка перед добавлением</h3>
          <p>{needsRounding.length
            ? 'Выберите, как округлить итоговый план по кратности из справочника Assembly.'
            : 'Проверьте товары и участки. Удалить из этого списка можно до сохранения.'}</p>
        </div><span>{preview.changes.length} поз.</span>
      </div>
      <div className="stock-table-wrap"><table>
        <thead><tr><th>Товар</th><th>Участок</th><th>Добавить</th><th>Новый план</th><th>Результат</th><th><span className="stock-sr-only">Действие</span></th></tr></thead>
        <tbody>{preview.changes.map((row,index) => {
          const chosen = choiceFor(row);
          const planned = row.rounding ? chosen?.newQuantity : row.newQuantity;
          return <tr key={`${row.article}-${index}`}>
            <td><div className="stock-product"><div className="stock-photo">{row.photoUrl?<img src={row.photoUrl} alt="" referrerPolicy="no-referrer"/>:<ImageOff size={18} aria-label="Нет фото"/>}</div>
              <div><strong>{row.article}</strong>{row.stockDetails?.name&&<small className="stock-catalog-detail">{row.stockDetails.name}</small>}</div>
            </div></td>
            <td><span className={`stock-department stock-department--${row.department||'unknown'}`}>{row.department==='box'?'Бокс':row.department==='roll'?'Рулонная печать':'Не определён'}</span>
              {row.machine&&<small className="stock-catalog-detail">{row.machine}</small>}
            </td>
            <td>
              {chosen ? <><s>{row.quantity}</s> <strong>{chosen.quantity} шт.</strong></> : `${row.quantity} шт.`}
            </td>
            <td>{planned==null?'—':`${planned} шт.`}</td>
            <td>{row.rounding ? <><small className="stock-catalog-detail">Кратность {row.rounding.kind==='xerox'?'Xerox ':''}{row.rounding.multiplicity} шт.</small>
            <select className="stock-rounding-select"
              aria-label={`Округление ${row.article}`}
              value={chosen?.direction || ''} disabled={busy||!!pending}
              onChange={event => {
                const direction = event.target.value;
                setRounding(previous => {
                  const next = new Map(previous);
                  if (direction === 'down' || direction === 'up') next.set(row.article,direction);
                  else next.delete(row.article);
                  return next;
                });
              }}>
              <option value="">{row.rounding.choices.length?'Выбрать округление':'Укажите другое количество'}</option>
              {row.rounding.choices.map(choice => <option key={choice.direction} value={choice.direction}>
                {choice.direction==='down'?'Вниз':'Вверх'} · {choice.quantity===0?'не добавлять':`добавить ${choice.quantity} шт.`}{choice.sheets!==undefined&&` · ${choice.sheets.toLocaleString('ru-RU')} лист.`}
              </option>)}
            </select></> : row.issue || (row.action==='increase'?'Прибавить к плану':'Новый артикул')}</td>
            <td><button type="button" className="stock-remove" disabled={busy||!!pending} aria-label={`Убрать ${row.article} из списка`} title="Убрать из списка" onClick={()=>removeDraft(row.article)}><Trash2 size={17}/></button></td>
          </tr>;
        })}</tbody>
      </table></div>
      <div className="stock-preview-actions">
        <Button kind="primary" disabled={busy||(!pending&&(roundingPending||!additions))} onClick={()=>void save()}>
          {busy?'Сохраняем…':pending?'Проверить сохранение':needsRounding.length?'Подтвердить и добавить':'Добавить в запасы'}
        </Button>
        {needsRounding.length > 0 && !pending && <span className="stock-rounding-summary" aria-live="polite">
          {roundingPending?'Выберите округление для всех отмеченных строк.':additions?`Добавится ${additions.toLocaleString('ru-RU')} шт.`:'По выбранным значениям добавлять нечего.'}
        </span>}
      </div>
    </div>}
    {pending&&<div className="stock-recovery" aria-live="polite"><Notice tone="warning">{busy?'Проверяем сохранение предыдущего запроса…':'Предыдущий список ещё сверяется. Не добавляйте его повторно.'}</Notice>
      <p><strong>{pending.input.destination==='warehouse'?'Запасы склад':'Срочные 2 этаж'}</strong> · {pending.input.lines.length} поз. · {pending.input.lines.reduce((sum,line)=>sum+line.quantity,0).toLocaleString('ru-RU')} шт.</p>
      {recovery?.steps?.map(step=><p key={step.department}><strong>{step.department==='roll'?'Рулонная печать':'Бокс'}:</strong> {step.status==='verified'?'сохранено и подтверждено':step.status==='prepared'?'ещё не отправлено':'требует сверки'} · {step.plan?.entries?.length||0} поз.</p>)}
      <details><summary>Показать исходный список</summary><ul>{pending.input.lines.map((line,index)=><li key={`${line.article}-${index}`}>{line.article} · {line.quantity} шт.</li>)}</ul></details>
      {!busy&&!preview&&<Button onClick={()=>void save()}>Проверить сохранение</Button>}
    </div>}
    {message&&<Notice tone="warning">{message}</Notice>}
    <StockTaskHistory blocked={busy} setBusy={setBusy} revision={historyRevision} />
  </section>;
}
