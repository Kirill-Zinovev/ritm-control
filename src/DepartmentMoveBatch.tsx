import {useMemo,useRef,useState} from 'react';
import {Button,DataTable,Field,Modal} from './ui';
import type {DepartmentMoveRequest} from './departmentMoveRequest';
import {departmentMoveAvailability} from './departmentMoveAvailability';
import {cancelMoveBatch,completeMoveBatch,restoreMoveBatch,type MoveBatch,type MoveBatchInput} from './departmentMoveBatchRequest';

export type MovePosition = {shipmentId:string; uid:string; article:string; quantity:number; printed?:number|null; cut?:number|null};
type Props = {positions:MovePosition[]; sourceDepartment:'box'|'roll'; disabled:boolean; disabledReason?:string; onDone:(moves:DepartmentMoveRequest[])=>Promise<void>};
const labels = {pending:'Ожидает',verified:'Перенесён',skipped:'Пропущен',checking:'На проверке',cancelled:'Отменён'};
const count = (n:number) => n.toLocaleString('ru-RU');

export function DepartmentMoveBatch({positions,sourceDepartment,disabled,disabledReason,onDone}:Props) {
  const target = sourceDepartment === 'box' ? 'рулонную печать' : 'бокс';
  const machines = sourceDepartment === 'box' ? ['2-GO','УФ','УФ БЕЛ.','УФ ДВУСТОРОННИЙ'] : ['XEROX','УФ планшет','DTF'];
  const [open,setOpen] = useState(false),[busy,setBusy] = useState(false),[loading,setLoading] = useState(false);
  const [search,setSearch] = useState(''),[selected,setSelected] = useState<Set<string>>(new Set());
  const [machine,setMachine] = useState(machines[0]),[extension,setExtension] = useState('');
  const [extensions,setExtensions] = useState<Record<string,string>>({});
  const [batch,setBatch] = useState<MoveBatch|null>(null),[input,setInput] = useState<MoveBatchInput|null>(null);
  const [message,setMessage] = useState(''),[lookupFailed,setLookupFailed] = useState(false);
  const active = useRef(false),pause = useRef(false),refreshed = useRef<string|null>(null);
  const rows = useMemo(() => positions.map(p => ({...p,unavailable:departmentMoveAvailability({...p,disabled,disabledReason})})),[positions,disabled,disabledReason]);
  const filtered = rows.filter(row => row.article.toLowerCase().includes(search.trim().toLowerCase()));
  const chosen = rows.filter(row => selected.has(row.uid) && !row.unavailable);
  const eligible = filtered.filter(row => !row.unavailable);
  const sameSupply = new Set(chosen.map(row => row.shipmentId)).size <= 1;
  const ready = chosen.length > 0 && chosen.length <= 500 && sameSupply && chosen.every(row => /^[A-Za-z0-9._ -]{1,40}$/.test((extensions[row.uid] || extension).trim()));
  const verified = batch?.results.filter(row => row.status === 'verified').length || 0;
  const skipped = batch?.results.filter(row => ['skipped','cancelled'].includes(row.status)).length || 0;

  async function launch() {
    if (active.current) return;
    active.current = true; setOpen(true); setLoading(true); setMessage(''); setLookupFailed(false);
    try {
      const ids = [...new Set(positions.map(p => p.shipmentId).filter(Boolean))];
      if (ids.length !== 1) throw Error('Для массового переноса выберите одну связанную поставку.');
      const found = await restoreMoveBatch(ids[0],sourceDepartment);
      setBatch(found); setInput(found?.input || null);
      if (found) setMessage('Восстановлен сохранённый список. Продолжим с непроверенной позиции.');
    } catch (error) {setLookupFailed(true); setMessage(error instanceof Error ? error.message : 'Не удалось проверить сохранённый список.');}
    finally {setLoading(false); active.current = false;}
  }

  async function submit() {
    if (active.current || (!input && !ready)) return;
    active.current = true; pause.current = false; setBusy(true); setMessage('Проверяем и переносим выбранные позиции…');
    const payload:MoveBatchInput = input || {operationId:crypto.randomUUID(),items:chosen.map(row => ({
      operationId:crypto.randomUUID(),shipmentId:row.shipmentId,uid:row.uid,article:row.article,quantity:row.quantity,
      sourceDepartment,machine,extension:(extensions[row.uid] || extension).trim(),
    }))};
    setInput(payload);
    try {
      const result = await completeMoveBatch(payload,{onProgress:setBatch,shouldPause:()=>pause.current});
      setBatch(result);
      setMessage(result.status === 'complete' ? 'Обработка списка завершена. Результат каждой позиции указан ниже.' : pause.current ? 'Пауза. Подтверждённые позиции уже перенесены, остальные можно продолжить.' : 'Перенос остановлен для сверки указанной позиции. Продолжение сохранит тот же ID и не создаст повторную копию.');
      if (result.status === 'complete') {active.current = false; setBusy(false);}
      // One refresh at the end (or pause), including partially completed lists.
      const revision = result.id + ':' + result.results.filter(row => row.status === 'verified').length;
      if (refreshed.current !== revision && result.results.some(row => row.status === 'verified')) {
        try {
          const moved = new Set(result.results.filter(row => row.status === 'verified').map(row => row.id));
          await onDone(result.input.items.filter(row => moved.has(row.operationId)));
          refreshed.current = revision;
        } catch {setMessage(m => m + ' Обновите список поставки, чтобы увидеть изменения.');}
      }
    } catch (error) {setMessage(error instanceof Error ? error.message : 'Не удалось подтвердить перенос.');}
    finally {active.current = false; setBusy(false);}
  }

  function toggle(uid:string) {setSelected(before => {const next = new Set(before); if (next.has(uid)) next.delete(uid); else next.add(uid); return next;});}
  async function cancelRemaining() {
    if (active.current || !input) return;
    active.current=true; setBusy(true);
    try {setBatch(await cancelMoveBatch(input.operationId)); setMessage('Оставшиеся позиции отменены. Подтверждённые переносы сохранены.');}
    catch (error) {setMessage(error instanceof Error ? error.message : 'Не удалось подтвердить отмену.');}
    finally {active.current=false; setBusy(false);}
  }
  return <>
    <Button disabled={disabled || !positions.length} title={disabledReason} onClick={() => void launch()}>Массовый перенос</Button>
    <Modal open={open} onClose={() => {if (!active.current) setOpen(false);}} title={'Массовый перенос в ' + target}
      description="Выберите артикулы. Переносится весь план позиции; работа на исходном участке должна быть ещё не начата.">
      <div className="department-move-batch">
        {loading ? <p role="status">Проверяем сохранённый список…</p> : input ? <>
          <div className="move-batch-summary"><strong>{verified} из {input.items.length} перенесено</strong><span>Пропущено: {skipped}</span></div>
          <progress aria-label="Выполнено переносов" max={input.items.length} value={verified + skipped}/>
          {batch?.blocker && <p className="move-batch-message" role="status"><strong>{['verified','cancelled'].includes(batch.blocker.status)?'Предыдущий перенос сверён: ':'Сверяем предыдущий перенос: '}{batch.blocker.article}</strong><br/>{batch.blocker.message || 'Проверяем сохранённую операцию перед продолжением выбранного списка. Повторная копия не создаётся.'}</p>}
          <DataTable rows={batch?.results || input.items.map(item => ({id:item.operationId,article:item.article,quantity:item.quantity,status:'pending' as const,message:''}))}
            rowKey={row => row.id} label="Результаты массового переноса" pageSize={20} columns={[
              {id:'article',label:'Артикул',render:row => <strong>{row.article}</strong>},
              {id:'quantity',label:'План, шт.',render:row => count(row.quantity)},
              {id:'status',label:'Результат',render:row => <span className={'move-batch-status ' + row.status}><strong>{labels[row.status]}</strong>{row.message && <small>{row.message}</small>}</span>},
            ]}/>
        </> : <>
          <div className="move-batch-settings">
            <Field label="Станок назначения"><select value={machine} onChange={e => setMachine(e.target.value)}>{machines.map(value => <option key={value}>{value}</option>)}</select></Field>
            <Field label="Общее расширение печати"><input value={extension} maxLength={40} onChange={e => setExtension(e.target.value)} placeholder="Можно указать отдельно в строках"/></Field>
          </div>
          <Field label="Поиск по артикулу"><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Артикул или его часть"/></Field>
          <div className="move-batch-selection"><Button disabled={!eligible.length} onClick={() => setSelected(before => new Set([...before,...eligible.map(row => row.uid)]))}>Выбрать найденные ({eligible.length})</Button>
            <Button disabled={!selected.size} onClick={() => setSelected(new Set())}>Снять выбор</Button><strong>{chosen.length} поз. · {count(chosen.reduce((sum,row) => sum + row.quantity,0))} шт.</strong></div>
          <DataTable rows={filtered} rowKey={row => row.uid} label="Выбор артикулов для переноса" pageSize={20} columns={[
            {id:'selected',label:'Выбор',render:row => <input type="checkbox" aria-label={'Перенести ' + row.article} checked={selected.has(row.uid)} disabled={!!row.unavailable} onChange={() => toggle(row.uid)}/>},
            {id:'article',label:'Артикул',render:row => <><strong>{row.article}</strong>{row.unavailable && <small className="move-batch-unavailable">{row.unavailable.reason}</small>}</>},
            {id:'quantity',label:'План, шт.',render:row => count(row.quantity)},
            {id:'extension',label:'Расширение',render:row => <input aria-label={'Расширение ' + row.article} value={extensions[row.uid] || ''} maxLength={40} disabled={!!row.unavailable} onChange={e => setExtensions(before => ({...before,[row.uid]:e.target.value}))} placeholder={extension || 'Укажите'}/>},
          ]}/>
          {!sameSupply && <p className="error-text">Выбранные позиции относятся к разным поставкам. Выберите одну поставку.</p>}
          {chosen.length > 500 ? <p>За один список можно перенести до 500 позиций.</p> : chosen.length > 0 && !ready && <p>Укажите расширение для каждой выбранной позиции или общее для всех.</p>}
        </>}
        {message && <p className="move-batch-message" role="status" aria-live="polite">{message}</p>}
        <div className="modal-actions">
          {input && batch?.status !== 'complete' && !busy && <Button onClick={() => void cancelRemaining()}>Отменить оставшиеся</Button>}
          {busy ? <Button onClick={() => {pause.current = true; setMessage('Остановимся после проверки текущего пакета…');}}>Пауза после пакета</Button> : <Button disabled={loading} onClick={() => setOpen(false)}>Закрыть</Button>}
          {batch?.status !== 'complete' && <Button kind="primary" disabled={busy || loading || (!lookupFailed && !input && !ready)} onClick={() => void (lookupFailed ? launch() : submit())}>
            {busy ? 'Переносим…' : lookupFailed ? 'Повторить проверку' : input ? 'Продолжить перенос' : 'Перенести выбранные (' + chosen.length + ')'}
          </Button>}
        </div>
      </div>
    </Modal>
  </>;
}
