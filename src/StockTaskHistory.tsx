import { useEffect, useRef, useState } from 'react';
import { ClipboardCheck, RefreshCw } from 'lucide-react';
import { Button, Modal, Notice } from './ui';
import { runStockRequest } from './stockRecovery';
import { stockCloseBatchSize } from '../shared/stockCloseBatch.js';

type Source = { department: 'roll' | 'box'; destination: 'warehouse' | 'urgent' };
type Task = Source & { id: string; article: string; quantity: number };
type CloseTask = Task & { operationId: string };
type Stage = 'done' | 'partial' | 'not_started' | 'unknown';
type History = Task & { date: string; manager: string | null; print: Stage; cut: Stage; event?: 'close'; closedAt?: string; readyId?: string };
type StockTasks = { entries: History[]; ready: Task[]; checking: CloseTask[]; unavailable: Source[] };
type CloseBatch = { tasks: CloseTask[]; next: number; issues: { id: string; article: string; message: string }[] };
type CloseReceipt = { id: string; status: 'verified' | 'not_saved' | 'uncertain' | 'writing'; message?: string };

const labels: Record<Stage, string> = {done:'Готово',partial:'Частично',not_started:'Не начато',unknown:'Нет данных'};
const dateFormat = new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Moscow'});
const sourceLabel = ({department,destination}: Source) => `${destination==='warehouse'?'Запасы склад':'Срочные 2 этаж'} · ${department==='roll'?'Рулонная печать':'Бокс'}`;
const pieces = (number: number) => `${number.toLocaleString('ru-RU')} шт.`;
const pendingKey = 'ritm:stock-close-batch';

function readCloseBatch(): CloseBatch | null {
  try {
    const batch = JSON.parse(sessionStorage.getItem(pendingKey) || 'null') as CloseBatch | null;
    if (!batch || !Array.isArray(batch.tasks) || !Array.isArray(batch.issues) ||
        !Number.isSafeInteger(batch.next) || batch.next < 0 || batch.next >= batch.tasks.length ||
        batch.tasks.some(task => typeof task.id !== 'string' || typeof task.operationId !== 'string' || typeof task.article !== 'string')) return null;
    return batch;
  } catch { return null; }
}

async function closeTask({ id, operationId }: CloseTask) {
  const response = await fetch('/api/stocks/close', {
    method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
    body:JSON.stringify({entryId:id,operationId}),signal:AbortSignal.timeout(125_000),
  });
  const data = await response.json() as { ok: boolean; operation?: CloseReceipt; message?: string };
  if(!response.ok || !data.ok || data.operation?.id !== operationId)
    throw new Error(data.message || 'Сервер не подтвердил завершение.');
  return {operation:data.operation};
}

async function closeTasks(tasks: CloseTask[]) {
  if(tasks.length===1) {
    const result=await closeTask(tasks[0]);
    return {...result,results:[result.operation]};
  }
  const response=await fetch('/api/stocks/close/batch',{
    method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
    body:JSON.stringify({items:tasks.map(task=>({entryId:task.id,operationId:task.operationId}))}),
    signal:AbortSignal.timeout(125_000),
  });
  const data=await response.json() as {ok:boolean;results?:CloseReceipt[];message?:string};
  if(!response.ok || !data.ok || !Array.isArray(data.results) || data.results.length!==tasks.length ||
     data.results.some((receipt,index)=>receipt?.id!==tasks[index].operationId))
    throw new Error(data.message||'Сервер не подтвердил завершение пакета.');
  const pending=data.results.find(item=>item.status!=='verified' && item.status!=='not_saved');
  return {operation:pending||{status:'verified'},results:data.results};
}

export default function StockTaskHistory({ blocked, setBusy, revision }: { blocked:boolean; setBusy:(busy:boolean)=>void; revision:number }) {
  const [tasks,setTasks] = useState<StockTasks>({entries:[],ready:[],checking:[],unavailable:[]});
  const [loading,setLoading] = useState(true);
  const [loadError,setLoadError] = useState('');
  const [closeError,setCloseError] = useState('');
  const [confirmation,setConfirmation] = useState<{ tasks:Task[]; all:boolean } | null>(null);
  const [batch,setBatch] = useState(readCloseBatch);
  const [result,setResult] = useState<CloseBatch | null>(null);
  const [confirmedInBatch,setConfirmedInBatch] = useState(0);
  const runningRef = useRef(false);
  const reloadRef = useRef(0);
  const [running,setRunning] = useState(false);

  async function reload() {
    const requestNumber=++reloadRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const response=await fetch('/api/stocks/history',{credentials:'same-origin',signal:AbortSignal.timeout(35_000)});
      const data=await response.json() as StockTasks & {ok:boolean;message?:string};
      if(!response.ok || !data.ok || !Array.isArray(data.ready)) throw new Error(data.message || 'Не удалось проверить рабочие листы.');
      if(requestNumber===reloadRef.current) setTasks(data);
    } catch(error) {
      if(requestNumber===reloadRef.current) setLoadError(error instanceof Error ? error.message : 'Не удалось обновить список.');
    } finally { if(requestNumber===reloadRef.current) setLoading(false); }
  }
  useEffect(() => { void reload(); }, [revision]);

  async function finish(start: CloseBatch) {
    if(blocked || runningRef.current) return;
    runningRef.current=true;
    setRunning(true);
    setBusy(true);
    setConfirmation(null);
    setCloseError('');
    setResult(null);
    setConfirmedInBatch(0);
    let current=start;
    try {
      while(current.next<current.tasks.length) {
        sessionStorage.setItem(pendingKey,JSON.stringify(current));
        setBatch(current);
        const group=current.tasks.slice(current.next,current.next+stockCloseBatchSize);
        const receipts=await runStockRequest(closeTasks,group,{
          attempts:2,
          onResult:(response:Awaited<ReturnType<typeof closeTasks>>)=>setConfirmedInBatch(
            response.results.filter(item=>item.status==='verified'||item.status==='not_saved').length),
        });
        const issues=receipts.results.flatMap((receipt:CloseReceipt,index:number)=>{
          const {id,article}=group[index];
          return receipt.status==='not_saved'?[{id,article,message:receipt.message||'Готовность больше не подтверждается.'}]:[];
        });
        current={...current,next:current.next+group.length,issues:[...current.issues,...issues]};
        setBatch(current);
        setConfirmedInBatch(0);
      }
      sessionStorage.removeItem(pendingKey);
      setBatch(null);
      setResult(current);
    } catch(error) {
      setCloseError(error instanceof Error ? error.message : 'Не удалось подтвердить завершение.');
    } finally {
      runningRef.current=false;
      setRunning(false);
      setBusy(false);
      void reload();
    }
  }

  function confirmCompletion() {
    if(!confirmation) return;
    void finish({tasks:confirmation.tasks.map(task=>({...task,operationId:crypto.randomUUID()})),next:0,issues:[]});
  }

  function stopBatch() {
    if(runningRef.current) return;
    try {
      sessionStorage.removeItem(pendingKey);
      setBatch(null);
      setCloseError('');
      setConfirmedInBatch(0);
      void reload();
    } catch {
      setCloseError('Браузер не подтвердил остановку списка.');
    }
  }

  const disabled=blocked || loading || !!loadError;
  const readyById=new Map(tasks.ready.map(task=>[task.id,task]));
  return <>
    <section className="stock-history" aria-labelledby="stock-ready-title">
      <div className="stock-history-heading">
        <div>
          <h3 id="stock-ready-title">Готовые к завершению</h3>
          <p>Печать и порезка подтверждены по всему плану позиции.</p>
        </div>
        <div className="stock-history-actions">
          <Button disabled={loading || running} onClick={()=>void reload()}><RefreshCw size={15}/> {loading?'Обновляем…':'Обновить'}</Button>
          <Button kind="primary" disabled={disabled || !!batch || !tasks.ready.length} onClick={()=>setConfirmation({tasks:tasks.ready,all:true})}>
            <ClipboardCheck size={16}/> Завершить всё{tasks.ready.length>0 ? ` · ${tasks.ready.length}` : ''}
          </Button>
        </div>
      </div>
      {loadError && <Notice tone="warning">{loadError}</Notice>}
      {!!tasks.unavailable.length && !loadError && <Notice tone="warning">Не удалось проверить {tasks.unavailable.map(sourceLabel).join(', ')}. Здесь показаны позиции из проверенных листов.</Notice>}
      {batch && <div className="stock-completion-feedback" aria-live="polite">
        <div><strong>{running?'Завершаем позиции':'Завершение приостановлено'}</strong>
          <p>Проверено {batch.next+confirmedInBatch} из {batch.tasks.length}</p></div>
        {!running && <div className="stock-history-actions">
          <Button disabled={blocked} onClick={stopBatch}>Остановить оставшиеся</Button>
          <Button disabled={blocked} onClick={()=>void finish(batch)}>Сверить и продолжить</Button>
        </div>}
      </div>}
      {closeError && <Notice tone="warning">{closeError}</Notice>}
      {result && <div className="stock-completion-feedback" role="status"><div>
        <strong>Завершено {result.tasks.length-result.issues.length} из {result.tasks.length}</strong>
        {!!result.issues.length && <ul>{result.issues.map(item=><li key={item.id}><strong>{item.article}</strong> · {item.message}</li>)}</ul>}
      </div></div>}
      {tasks.ready.length || tasks.checking.length ? <div className="stock-table-wrap"><table>
        <thead><tr><th>Артикул</th><th>Назначение / участок</th><th>План</th><th>Действие</th></tr></thead>
        <tbody>
          {tasks.ready.map(task=><tr key={task.id}>
            <td><strong>{task.article}</strong></td><td>{sourceLabel(task)}</td><td>{pieces(task.quantity)}</td>
            <td><Button disabled={disabled || !!batch} onClick={()=>setConfirmation({tasks:[task],all:false})}>Завершить</Button></td>
          </tr>)}
          {tasks.checking.map(task=><tr key={task.operationId}>
            <td><strong>{task.article}</strong></td><td>{sourceLabel(task)}</td><td>{pieces(task.quantity)}</td>
            <td><Button disabled={disabled || !!batch} onClick={()=>void finish({tasks:[task],next:0,issues:[]})}>Проверить завершение</Button></td>
          </tr>)}
        </tbody>
      </table></div> : !loadError && <p className="stock-history-note">{loading?'Проверяем рабочие листы…':'В проверенных листах нет позиций, готовых к завершению.'}</p>}
    </section>
    <section className="stock-history" aria-labelledby="stock-history-title">
      <div className="stock-history-heading"><div><h3 id="stock-history-title">История заданий</h3><p>Добавления и завершения за последние 7 дней</p></div></div>
      {tasks.entries.length ? <div className="stock-table-wrap"><table>
        <thead><tr><th>Дата</th><th>Менеджер</th><th>Артикул</th><th>Назначение / участок</th><th>Количество</th><th>Печать</th><th>Порезка</th><th>Задание</th></tr></thead>
        <tbody>{tasks.entries.map(item=>{
          const task=item.readyId ? readyById.get(item.readyId) : undefined;
          return <tr key={item.id}>
            <td>{dateFormat.format(new Date(item.date))}</td><td>{item.manager||'Не указан'}</td><td><strong>{item.article}</strong></td>
            <td>{sourceLabel(item)}</td><td>{pieces(item.quantity)}{item.event==='close'?' · план':''}</td>
            <td><span className={`stock-history-status stock-history-status--${item.print}`}>{labels[item.print]}</span></td>
            <td><span className={`stock-history-status stock-history-status--${item.cut}`}>{labels[item.cut]}</span></td>
            <td>{item.closedAt ? `Завершено ${dateFormat.format(new Date(item.closedAt))}` : task
              ? <Button disabled={disabled || !!batch} onClick={()=>setConfirmation({tasks:[task],all:false})}>Завершить</Button> : '—'}</td>
          </tr>;
        })}</tbody>
      </table></div> : !loadError && <p className="stock-history-note">{loading?'Загружаем историю…':'За последние 7 дней записей нет.'}</p>}
    </section>
    {confirmation && <Modal open onClose={()=>setConfirmation(null)}
      title={confirmation.all?'Завершить все готовые позиции?':`Завершить ${confirmation.tasks[0].article}?`}
      description="Позиции уйдут из рабочих листов запасов. Записи печати и порезки сохранятся в журналах.">
      <div className="stock-close-review">
        <p><strong>{confirmation.tasks.length} поз. · {pieces(confirmation.tasks.reduce((sum,task)=>sum+task.quantity,0))}</strong></p>
        <ul>{confirmation.tasks.map(task=><li key={task.id}>
          <span><strong>{task.article}</strong><small>{sourceLabel(task)}</small></span><strong>{pieces(task.quantity)}</strong>
        </li>)}</ul>
      </div>
      <div className="stock-history-actions stock-close-actions">
        <Button onClick={()=>setConfirmation(null)}>Отмена</Button>
        <Button kind="primary" disabled={disabled || !!batch} onClick={confirmCompletion}>{confirmation.all?'Завершить всё':'Завершить'}</Button>
      </div>
    </Modal>}
  </>;
}
