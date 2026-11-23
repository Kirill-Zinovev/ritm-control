import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BoxBatchDock, ProductPhoto, RollAllocation, RollBatchWork, SelectionBar, TakeFields, showAmount } from './BatchWork.jsx';
import { InlineWork } from './InlineWork.jsx';
import { ArticleSummary, JobFilters, JobQueue, OtherShipmentMatches, ShipmentPicker } from './WorkspaceViews.jsx';
import { printingDepartments } from './printing-departments.mjs';
import { submitBoxBatch } from './submit-box-batch.mjs';
import { BOX_GATEWAY_BATCH } from './workspace-write.mjs';
import { rollCutAvailable, summarizeShipment } from './shipment-progress.mjs';
import { rollChoiceMatches, rollWorkChoice } from './roll-batch-work.mjs';
import { MAX_ROLLS, boxTakeBlockReason, boxWorkEntry, isXerox, matchesArticle, matchesRoll, newRolls, normalize, operationNames, rollDraft, rollEmployee, takeEntry, unitFactor, workRemaining } from './printing-workflow.mjs';

const layouts = {available:'Есть макет',missing:'Нет макета',unknown:'Не проверено'};
const unknown = 'Не указано';
const readiness = row => row.printed == null ? 'Не подтверждена' : row.printed >= row.plan ? 'Готово' : row.printed ? 'В работе' : 'Не начата';
const groups = [
  ['material','Материал',row=>row.material||unknown],
  ['layout','Наличие макета',row=>layouts[row.layout]||layouts.unknown],
  ['extension','Расширение печати',row=>row.extension||unknown],
  ['readiness','Готовность печати',readiness],
];
const workKey = 'ritm-printing-local-work-v1';
const rollKey = 'ritm-printing-local-rolls-v1';
const previousPendingKey = 'ritm-printing-pending-v1';
const empty = [];

function pendingOperation(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function readLocal(key) {
  const value = JSON.parse(localStorage.getItem(key) || '[]');
  if (!Array.isArray(value)) throw new Error('Локальный журнал повреждён.');
  return value;
}

function initialLocal(key) {
  try { return readLocal(key); } catch { return []; }
}

async function api(department,id,signal,{summary = false,fresh = false,preview = false,journal = false,search = ''} = {}) {
  const params = new URLSearchParams({department});
  if (id) params.set('supply',id);
  if (summary) params.set('summary','1');
  if (fresh) params.set('fresh','1');
  if (preview) params.set('preview','1');
  if (journal) params.set('journal','1');
  if (search) params.set('search',search);
  const response = await fetch('/api/printing-workspace?'+params, {signal});
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message || 'Источник недоступен'),{status:response.status});
  return data;
}

function WorkJournal({work,journalError}) {
  return <section className="journal">
    <h1>Журнал печати</h1>
    {journalError ? <p className="notice error" role="alert">{journalError}</p> : work.length ? <table>
      <thead><tr><th>Дата</th><th>Поставка</th><th>Артикул</th><th>Рулон</th><th>Сотрудник</th><th>Операция</th><th>Количество</th><th>Площадь, м²</th></tr></thead>
      <tbody>{work.map(entry => <tr key={entry.id}>
        <td>{new Date(entry.at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})}</td><td>{entry.supplyName || '—'}</td><td>{entry.article}</td>
        <td>{entry.beforeName !== entry.afterName ? entry.beforeName+' → '+entry.afterName : entry.rollName || '—'}</td>
        <td>{entry.employee || '—'}</td>
        <td>{entry.operation === 'roll-edit' ? 'Изменение рулона' : entry.correction
          ? (entry.operation === 'print' ? 'Исправление печати' : 'Исправление порезки') : operationNames[entry.operation] || entry.operation}</td>
        <td>{entry.correction ? showAmount(entry.before)+' → '+showAmount(entry.after) : showAmount(entry.quantity)}
          {' '}{entry.unit === 'sheets' ? 'л.' : 'шт.'}</td>
        <td>{entry.area == null ? '—' : entry.area.toLocaleString('ru-RU',{maximumFractionDigits:6})}</td>
      </tr>)}</tbody>
    </table> : <p>Записей пока нет.</p>}
  </section>;
}

function mergeRolls(row, saved, supplyId) {
  if (!Array.isArray(row.rolls)) return row;
  return {...row, rolls:[...row.rolls, ...saved.filter(roll => roll.supplyId === supplyId && roll.rowId === row.id)]};
}

function rowRecords(work, id, rowId) {
  return work.filter(entry => entry.supplyId === id && entry.rowId === rowId);
}

export function App({department, onSessionExpired, onLogout, loggingOut, accessError, themeControl}) {
  const pendingKey = previousPendingKey+':'+department;
  const [metadata, setMetadata] = useState(null);
  const [serverJournal,setServerJournal] = useState({work:[],error:''});
  const [chosenSupply, setChosenSupply] = useState('');
  const [shipmentsOpen, setShipmentsOpen] = useState(true);
  const [queueOpen, setQueueOpen] = useState(true);
  const [detailOpen, setDetailOpen] = useState(false);
  const [loaded, setLoaded] = useState(null);
  const [selectedPreview, setSelectedPreview] = useState(null);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [reload, setReload] = useState(0);
  const [summaryReload, setSummaryReload] = useState(0);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [articleId, setArticleId] = useState('');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [rollQuery, setRollQuery] = useState('');
  const [machine, setMachine] = useState('');
  const [filters, setFilters] = useState({});
  const [work, setWork] = useState(() => initialLocal(workKey));
  const [localRolls, setLocalRolls] = useState(() => initialLocal(rollKey));
  const [page, setPage] = useState('jobs');
  const [checked, setChecked] = useState(() => new Set());
  const [drafts, setDrafts] = useState({});
  const [employee, setEmployee] = useState('');
  const [boxMode, setBoxMode] = useState('take');
  const [boxOperation, setBoxOperation] = useState('cut');
  const [batchView, setBatchView] = useState(true);
  const [allocate, setAllocate] = useState(false);
  const [rollMode, setRollMode] = useState('individual');
  const [rollOperation, setRollOperation] = useState('');
  const [sharedName, setSharedName] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [currentPending, setPendingWork] = useState(() => pendingOperation(pendingKey));
  const [previousPending, setPreviousPending] = useState(() => pendingOperation(previousPendingKey));
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const workGeneration = useRef(0);
  const lastDetailRefresh = useRef(0);
  const articlePane = useRef(null);
  const queuePane = useRef(null);
  const shipmentButton = useRef(null);
  const detailButton = useRef(null);
  const keyword = normalize(query);
  const canLoadSummary = !!metadata?.supportsSupplyPreview && page === 'jobs';
  useEffect(()=>{
    if (page!=='journal') return;
    const controller=new AbortController();
    api(department,'',controller.signal,{journal:true}).then(value=>{
      if (!controller.signal.aborted) setServerJournal({work:value.work,error:''});
    }).catch(error=>{
      if (controller.signal.aborted) return;
      if (error.status===401) onSessionExpired();
      else setServerJournal({work:[],error:error.message});
    });
    return ()=>controller.abort();
  },[department,onSessionExpired,page,summaryReload]);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api(department,'',controller.signal,{fresh:reload>0}).then(value => {
      if (!controller.signal.aborted) setMetadata(current => current?.summaryLoaded && current.at === value.at
        ? {...value,supplies:current.supplies,summaryLoaded:true}
        : value);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) onSessionExpired();
      else setError(failure.message);
    });
    return () => controller.abort();
  }, [department,onSessionExpired,reload,summaryReload]);

  useEffect(() => {
    if (!canLoadSummary) {
      setSummaryLoading(false);
      return;
    }
    const controller = new AbortController();
    setSummaryLoading(true);
    api(department,'',controller.signal,{summary:true}).then(value=>{
      if (!controller.signal.aborted) setMetadata(current=>({...current,...value,summaryLoaded:true}));
    }).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) onSessionExpired();
      else setError(failure.message);
    }).finally(() => { if (!controller.signal.aborted) setSummaryLoading(false); });
    return () => controller.abort();
  }, [department,onSessionExpired,canLoadSummary,reload,summaryReload]);

  useEffect(() => {
    function sync(event) {
      if (event.key === workKey || event.key == null) setWork(initialLocal(workKey));
      if (event.key === rollKey || event.key == null) setLocalRolls(initialLocal(rollKey));
      if (event.key === pendingKey || event.key == null) setPendingWork(pendingOperation(pendingKey));
      if (event.key === previousPendingKey || event.key == null) setPreviousPending(pendingOperation(previousPendingKey));
    }
    window.addEventListener('storage',sync);
    return () => window.removeEventListener('storage',sync);
  }, [pendingKey]);

  const supplies = metadata?.supplies || empty;
  const supplyIds = useMemo(() => new Set(supplies.map(item => item.id)),[supplies]);
  const pendingWork = currentPending || (supplyIds.has(previousPending?.supplyId) ? previousPending : null);
  const supply = supplies.find(item => item.id === chosenSupply) || supplies.find(item => item.status === 'open') || supplies[0];
  const id = supply?.id;
  const needsPreview = !!metadata?.supportsSupplyPreview && !!id && metadata.preview?.id !== id;
  const searchKey = keyword && id ? JSON.stringify([id,keyword,reload,summaryReload]) : '';

  useEffect(() => {
    if (page !== 'jobs' || !queueOpen || !searchKey) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api(department,id,controller.signal,{search:keyword}).then(result => {
        if (!controller.signal.aborted) setSearchResults({key:searchKey,...result});
      }).catch(failure => {
        if (controller.signal.aborted) return;
        if (failure.status === 401) onSessionExpired();
        else setSearchResults({key:searchKey,error:failure.message});
      });
    },220);
    return () => { clearTimeout(timer);controller.abort(); };
  }, [department,id,keyword,onSessionExpired,page,queueOpen,searchKey]);

  useEffect(() => {
    if (!needsPreview) return;
    const controller = new AbortController();
    api(department,id,controller.signal,{preview:true}).then(data => {
      if (!controller.signal.aborted && data.id === id && data.partial && Array.isArray(data.rows)) {
        setSelectedPreview(data);
      }
    }).catch(() => {
      // The full request can still provide the rows and report any error.
    });
    return () => controller.abort();
  }, [department,id,needsPreview]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const revision = workGeneration.current;
    const fresh = lastDetailRefresh.current !== reload;
    lastDetailRefresh.current = reload;
    let next;
    setDetailError('');
    function load(attempt,checkFresh) {
      api(department,id,controller.signal,{fresh:checkFresh}).then(data => {
        if (controller.signal.aborted || revision !== workGeneration.current) return;
        setLoaded({id,...data});
        if (data.retryAfterMs > 0) {
          if (attempt < 12) next = setTimeout(() => load(attempt+1,data.retryFresh !== false),data.retryAfterMs);
          else setDetailError('РИТМ ещё обновляет поставку. Повторите обновление.');
        } else if (data.catalog?.refreshing && attempt < 30) {
          next = setTimeout(() => load(attempt+1,false),4000);
        }
      }).catch(failure => {
        if (controller.signal.aborted) return;
        if (failure.status === 401) onSessionExpired();
        else setDetailError(failure.message);
      });
    }
    load(0,fresh);
    return () => { controller.abort();clearTimeout(next); };
  }, [department,id,onSessionExpired,reload]);

  const loadedDetails = loaded?.id === id ? loaded : null;
  const preview = selectedPreview?.id === id ? selectedPreview : metadata?.preview?.id === id ? metadata.preview : null;
  const details = loadedDetails || preview;
  const sourceRows = details?.rows;
  const working = !!metadata?.working;
  const readOnly = !!metadata?.readOnly;
  const employees = working ? details?.employees || empty : undefined;
  const draftRolls = working || readOnly ? empty : localRolls;
  const draftWork = working || readOnly ? empty : work;
  const rows = useMemo(() => (sourceRows || []).map(row => mergeRolls(row,draftRolls,id)), [sourceRows,draftRolls,id]);
  const isRoll = department === 'roll';
  const pickerSupplies = useMemo(() => {
    if (!loadedDetails?.confirmedWrite) return supplies;
    const currentProgress = summarizeShipment(rows.map(row => ({
      ...row,...(isRoll ? {cutAvailable:rollCutAvailable(row.rolls,row.printed,row.cut)} : {}),
    })));
    return supplies.map(item => item.id === id && item.count === rows.length ? {...item,progress:currentProgress} : item);
  },[loadedDetails?.confirmedWrite,supplies,rows,isRoll,id]);
  const editable = supply?.status === 'open' && !readOnly && !!loadedDetails && loadedDetails.writeReady !== false;
  const canCorrect = working && !readOnly && loadedDetails?.correctionReady === true;
  const activeBoxMode = editable ? boxMode : 'correct';
  const showTake = editable && !isRoll && activeBoxMode === 'take';
  const showBoxWork = editable && !isRoll && activeBoxMode === 'work';
  const boxCorrections = !isRoll && activeBoxMode === 'correct' && canCorrect;
  const boxAction = showTake ? 'take' : boxOperation;
  const boxSubmitLabel = showTake ? 'Взять в работу' : boxOperation === 'cut' ? 'Записать порезку' : 'Записать печать';
  const matchingRows = rows.filter(row => {
    if (machine && row.machine !== machine) return false;
    if (keyword && !matchesArticle(row,keyword)) return false;
    if (isRoll && rollQuery.trim() && !row.rolls?.some(roll => matchesRoll(roll,rollQuery))) return false;
    return groups.every(([key,,value]) => !filters[key]?.length || filters[key].includes(value(row)));
  });
  const machines = [...new Set(rows.map(row => row.machine).filter(Boolean))].sort((a,b) => a.localeCompare(b,'ru'));
  const boxChoices = showTake || showBoxWork ? new Map(matchingRows.map(row => {
    const records = rowRecords(draftWork,id,row.id);
    return [row.id,showTake ? {error:boxTakeBlockReason(row,records,working)} :
      boxWorkEntry(row,records,boxOperation,working)];
  })) : null;
  const rollChoices = editable && isRoll
    ? new Map(matchingRows.map(row => [row.id,rollWorkChoice(row,rollQuery,working)])) : null;
  const selectable = !!(boxChoices || rollChoices);
  const eligible = new Set((selectable ? matchingRows : [])
    .filter(row => {
      if (!isRoll) return !boxChoices.get(row.id).error;
      return rollChoiceMatches(rollChoices.get(row.id),rollOperation);
    })
    .map(row => row.id));
  const queueOperation = showBoxWork ? boxOperation : rollChoices ? rollOperation : '';
  const visible = boxChoices || queueOperation ? matchingRows.filter(row => eligible.has(row.id)) : matchingRows;
  const emptyQueue = showTake ? 'Нет доступных артикулов для взятия в работу.' : queueOperation
    ? (queueOperation === 'cut' ? 'Нет доступного остатка для порезки.' : 'Нет доступного остатка для печати.') : undefined;
  const selected = visible.filter(row => checked.has(row.id) && eligible.has(row.id));
  const activeRow = rows.find(row => row.id === articleId);
  const recordsForRow = rowId => rowRecords(draftWork,id,rowId);
  const blocked = !!pendingWork || busy;
  const boxBatch = !!boxChoices && selected.length > 0 && batchView;
  const rollSelection = rollChoices
    ? [...rollChoices.values()].filter(choice => checked.has(choice.row.id) && rollChoiceMatches(choice)) : empty;
  const selectedRollOperation = rollOperation || (rollSelection.some(choice => choice.cut.length) ? 'cut' : 'print');
  const rollWorkSelection = rollSelection.filter(choice => rollChoiceMatches(choice,selectedRollOperation));
  const assignmentSelection = rollOperation === 'cut' ? empty : rollOperation ? rollWorkSelection : rollSelection;
  const assignmentRows = assignmentSelection.filter(choice => choice.unassigned > 0).map(choice => choice.row);
  const allocationOpen = allocate && assignmentRows.length > 0;
  const rollBatch = working && rollSelection.length > 0 && batchView && !allocationOpen;
  const batchDetails = boxBatch || rollBatch || allocationOpen;
  const hasDetail = !!(articleId || batchDetails || feedback);
  const detailVisible = detailOpen && hasDetail;
  const detailArticle = batchDetails ? undefined : activeRow;

  function clearSelection() {
    setChecked(new Set());
    setDrafts({});
    setBatchView(true);
    setAllocate(false);
    setFeedback(null);
  }

  function chooseBoxMode(mode) {
    if (boxMode === mode) return;
    clearSelection();
    setEmployee('');
    setBoxMode(mode);
    queuePane.current?.scrollTo(0,0);
  }

  function chooseRollOperation(operation) {
    if (rollOperation === operation) return;
    setRollOperation(operation);
    setAllocate(false);
    setFeedback(null);
    queuePane.current?.scrollTo(0,0);
  }

  function resetScope(keepQuery) {
    clearSelection();
    setArticleId('');
    setDetailOpen(false);
    setMachine('');
    setFilters({});
    if (!keepQuery) setQuery('');
    setRollQuery('');
    setSharedName('');
  }

  function closeShipments() {
    setShipmentsOpen(false);
    shipmentButton.current?.focus({preventScroll:true});
  }

  function chooseSupply(item, keepQuery = false) {
    if (busy) return;
    if (item.id !== id) {
      resetScope(keepQuery);
      queuePane.current?.scrollTo(0,0);
    }
    setChosenSupply(item.id);
    setQueueOpen(true);
  }

  function focusArticlePane() {
    if (window.matchMedia('(max-width: 900px)').matches) {
      requestAnimationFrame(() => articlePane.current?.scrollIntoView({block:'start'}));
    }
  }

  function openArticle(rowId) {
    setArticleId(rowId);
    setDetailOpen(true);
    setAllocate(false);
    setBatchView(false);
    articlePane.current?.scrollTo(0,0);
    focusArticlePane();
  }

  function openSearchMatch(match) {
    if (busy) return;
    const item = supplies.find(supply => supply.id === match.supplyId);
    if (!item) {
      setSummaryReload(value => value+1);
      return;
    }
    chooseSupply(item,true);
    openArticle(match.rowId);
  }

  function closeDetail() {
    setDetailOpen(false);
    detailButton.current?.focus({preventScroll:true});
  }

  function openRollAllocation(operation) {
    if (operation) setRollOperation(operation);
    setAllocate(true);
    setDetailOpen(true);
    setFeedback(null);
    focusArticlePane();
  }

  function toggleCheck(rowId) {
    if (busy || !eligible.has(rowId)) return;
    setFeedback(null);
    setBatchView(true);
    setDetailOpen(true);
    setChecked(previous => {
      const next = new Set(previous);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function toggleFilter(key,value) {
    clearSelection();
    setFilters(previous => {
      const options = previous[key] || [];
      return {...previous,[key]:options.includes(value) ? options.filter(option => option !== value) : [...options,value]};
    });
  }

  function changeDraft(rowId,patch) {
    setFeedback(null);
    setDrafts(previous => ({...previous,[rowId]:{...previous[rowId],...patch}}));
  }

  function commit(key, value, update) {
    localStorage.setItem(key,JSON.stringify(value));
    update(value);
  }

  async function sendWork(request, retry = false) {
    const legacy = pendingOperation(previousPendingKey);
    const hasLegacy = supplyIds.has(legacy?.supplyId);
    if (writing.current || (!retry && (pendingOperation(pendingKey) || hasLegacy))) {
      throw new Error('Сначала проверьте предыдущую запись.');
    }
    writing.current = true;
    setBusy(true);
    function saveCheckpoint(value) {
      localStorage.setItem(pendingKey,JSON.stringify(value));
      setPendingWork(value);
    }
    async function send(payload) {
      const response = await fetch('/api/printing-write',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...payload,department,checking:retry})});
      if (response.status === 401) {
        onSessionExpired();
        throw new Error('Сеанс завершён. Войдите и повторите тот же запрос.');
      }
      const result = await response.json();
      if (result.uncertain || (!response.ok && !result.rejected)) {
        throw new Error(result.message || 'Журнал не подтвердил результат. Повторите тот же запрос.');
      }
      return result;
    }
    try {
      saveCheckpoint(request);
      const reply = department === 'box' && request.items?.length > BOX_GATEWAY_BATCH
        ? await submitBoxBatch(request,send,saveCheckpoint) : await send(request);
      localStorage.removeItem(pendingKey);
      setPendingWork(null);
      if (hasLegacy && JSON.stringify(legacy) === JSON.stringify(request)) {
        localStorage.removeItem(previousPendingKey);
        setPreviousPending(null);
      }
      if (reply.rejected) {
        setReload(value => value+1);
        throw new Error(reply.message || 'Журнал отклонил запись.');
      }
      workGeneration.current++;
      setLoaded(current => {
        if (current?.id !== request.supplyId) return current;
        const patches = new Map((reply.patches || []).map(patch => [patch.id,patch]));
        for (const result of reply.results || []) {
          if (!result.ok) continue;
          const row = current.rows.find(item => item.id === result.rowId);
          if (!row) continue;
          const factor = isXerox(row) ? unitFactor(row,'sheets') : 1;
          if (factor) patches.set(row.id,{taken:result.totals.taken*factor,printed:result.totals.printed*factor,
            cut:result.totals.cut*factor,workRevision:result.workRevision ?? row.workRevision});
        }
        return {...current,confirmedWrite:patches.size > 0,rows:current.rows.map(row => ({...row,...patches.get(row.id)}))};
      });
      setSummaryReload(value => value+1);
      if (retry || request.command === 'correct') setReload(value => value+1);
      return reply;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }

  async function saveCorrection(item) {
    if (blocked || !canCorrect || !id) throw new Error('Обновите поставку перед исправлением.');
    if (boxCorrections) setBoxMode('correct');
    const reply = await sendWork({supplyId:id,command:'correct',requestId:crypto.randomUUID(),items:[item]});
    return reply.message;
  }

  const batchSummary = results => {
    const failures = results.filter(result => !result.ok);
    const count = results.length - failures.length;
    return {error:!!failures.length,value:'Записано в журнал бокса: '+count+' поз.'+
      (failures.length ? ' '+failures.map(result => (result.article || rows.find(row => row.id === result.rowId)?.article || 'Позиция')+
        ' — '+result.error).join(' ') : '')};
  };

  async function retryWork() {
    setDetailOpen(true);
    try {
      const reply = await sendWork(pendingWork,true);
      clearSelection();
      setFeedback(reply.results ? batchSummary(reply.results) : {value:reply.message || 'Журнал подтвердил запись.'});
    } catch (failure) { setFeedback({error:true,value:failure.message}); }
  }

  async function handleBoxBatch() {
    if (blocked || !boxBatch || !employee.trim() || (employees && !employees.some(item => item.id === employee))) return;
    try {
      const previous = working ? empty : readLocal(workKey);
      const at = new Date().toISOString();
      const entries = selected.flatMap(row => {
        const records = rowRecords(previous,id,row.id);
        const result = showTake ? takeEntry(row,records,drafts[row.id]) : boxWorkEntry(row,records,boxOperation,working);
        if (result.error) throw new Error(row.article + ' — ' + result.error);
        return result.skip ? [] : [{
          ...result,id:crypto.randomUUID(),supplyId:id,rowId:row.id,article:row.article,
          operation:boxAction,employee:employee.trim(),rollId:'',rollName:'',at,
        }];
      });
      if (!entries.length) throw new Error('Выбранные позиции уже взяты в работу на весь план.');
      if (working) {
        const positions = new Map(selected.map(row => [row.id,row]));
        const result = await sendWork({supplyId:id, command:'work', items:entries.map(entry => ({
          rowId:entry.rowId,requestId:entry.id,action:entry.operation,employeeId:entry.employee,
          fingerprint:positions.get(entry.rowId).fingerprint, unit:entry.unit, quantity:entry.quantity,
        }))});
        clearSelection();
        setFeedback(batchSummary(result.results));
        if (result.results.some(item => !item.ok)) setReload(value => value+1);
        return;
      }
      commit(workKey,[...entries,...previous],setWork);
      clearSelection();
      setFeedback({value:(showTake ? 'Локально взято в работу: ' : 'Записано в локальный журнал: ')+entries.length+' поз.'});
    } catch (failure) { setFeedback({error:true,value:failure.message || 'Не удалось записать работу.'}); }
  }

  async function handleCreate(requests, shared) {
    if (!editable || !isRoll || !id || !requests.length) throw new Error('Выберите артикулы открытой поставки.');
    const previous = working ? empty : readLocal(rollKey);
    const indexed = new Map((sourceRows || []).map(row => [row.id,row]));
    const used = new Set();
    const batches = requests.map(({rowId,draft}) => {
      const source = indexed.get(rowId);
      if (!source || used.has(rowId)) throw new Error('Обновите список выбранных артикулов.');
      used.add(rowId);
      const row = mergeRolls(source,previous,id);
      const valid = rollDraft(row,draft,shared);
      if (valid.error) throw new Error(row.article + ' — ' + valid.error);
      return {row,valid};
    });
    if (batches.reduce((sum,batch) => sum + batch.valid.count,0) > MAX_ROLLS) throw new Error('За один раз можно создать до 500 рулонов.');
    if (working) {
      const result = await sendWork({supplyId:id, command:'create',requestId:crypto.randomUUID(),
        items:batches.map(({row,valid}) => ({rowId:row.id,...valid,expectedPlan:row.plan,
          expectedAllocated:row.rolls.reduce((sum,roll) => sum+roll.quantity,0)}))});
      const previousIds = new Set(batches.flatMap(({row}) => row.rolls.map(roll => roll.id)));
      return (result.patches || []).flatMap(patch => patch.rolls.filter(roll => !previousIds.has(roll.id)));
    }
    const created = batches.flatMap(({row,valid}) => newRolls(row,valid,id));
    commit(rollKey,[...previous,...created],setLocalRolls);
    return created;
  }

  async function saveSelectedRolls() {
    if (!allocationOpen || blocked) return;
    try {
      const result = await handleCreate(assignmentRows.map(row => ({rowId:row.id,draft:drafts[row.id]})),rollMode === 'shared' ? sharedName : undefined);
      if (rollOperation === 'print') {
        setAllocate(false);
        setDrafts({});
        setSharedName('');
        setBatchView(true);
      } else {
        clearSelection();
        setRollQuery('');
        setArticleId(assignmentRows[0].id);
      }
      setFeedback({value:(working ? 'Создано рулонов: ' : 'Локально создано рулонов: ')+result.length+'. Артикулов: '+assignmentRows.length+'.'});
    } catch (failure) { setFeedback({error:true,value:failure.message || 'Не удалось создать рулоны.'}); }
  }

  async function saveRollBatch(entries) {
    if (!rollBatch || blocked || !entries.length || entries.length > MAX_ROLLS) return;
    const items = entries.map(({rowId,rollId,quantity,expectedQuantity,expectedActual}) =>
      ({rowId,rollId,quantity,expectedQuantity,expectedActual}));
    try {
      const result = await sendWork({
        supplyId:id,command:'work-many',requestId:crypto.randomUUID(),operation:selectedRollOperation,items,
      });
      const total = items.reduce((sum,item) => sum + item.quantity,0);
      clearSelection();
      const action = selectedRollOperation === 'print' ? 'Печать записана' : 'Порезка записана';
      setFeedback({value:action+' · '+showAmount(total)+' шт. · позиций '+result.confirmed});
    } catch (failure) {
      setFeedback({error:true,value:failure.message || 'Не удалось записать работу по выбранным рулонам.'});
    }
  }

  async function saveWork(entry) {
    const source = sourceRows?.find(row => row.id === entry.rowId);
    if (!source || !editable || entry.supplyId !== id) throw new Error('Откройте артикул заново.');
    const previous = working ? empty : readLocal(workKey);
    const records = rowRecords(previous,id,entry.rowId);
    const row = mergeRolls(source,working ? empty : readLocal(rollKey),id);
    const roll = row.rolls?.find(item => item.id === entry.rollId);
    if (isRoll && (!roll || rollEmployee(roll,row,entry.operation) !== entry.employee)) {
      throw new Error('Рулон или сотрудник изменился. Откройте артикул заново.');
    }
    const target = roll || row;
    const current = operation => {
      const value = operation === 'print' ? target.printed : target.cut;
      return value == null ? null : value + records.filter(r => r.rollId === entry.rollId && r.operation === operation)
        .reduce((sum,r)=>sum+r.pieces,0);
    };
    const printed = current('print');
    const cut = current('cut');
    const remaining = workRemaining(entry.operation,roll?.quantity ?? row.plan,printed,cut);
    if (remaining == null || entry.pieces - remaining > 1e-8) throw new Error('Доступное количество изменилось. Проверьте остаток.');
    if (working) {
      const item = {rowId:entry.rowId,quantity:entry.quantity};
      const reply = await sendWork(isRoll ? {
        supplyId:id,command:'work',requestId:entry.id,operation:entry.operation,
        items:[{...item,rollId:roll.id,expectedQuantity:roll.quantity,expectedActual:entry.operation === 'print' ? printed : cut}],
      } : {supplyId:id, command:'work',items:[{...item,requestId:entry.id,action:entry.operation,
        employeeId:entry.employee,unit:entry.unit,fingerprint:row.fingerprint}]});
      if (reply.results && !reply.results[0]?.ok) throw new Error(reply.results[0]?.error || 'Запись отклонена журналом бокса.');
      return reply.skipped ? 'Операция уже завершена.' : 'РИТМ подтвердил запись.';
    }
    commit(workKey,[entry,...previous],setWork);
    return 'Работа записана в локальный журнал.';
  }

  return <>
    <header className="header">
      <div className="brand"><b>RITM /</b> Печать</div>
      <span className="department-title">{printingDepartments[department]}</span>
      <div className="header-actions">
        {themeControl}
        {!readOnly && <button className="link" type="button" aria-pressed={page === 'journal'} onClick={() => setPage(page === 'journal' ? 'jobs' : 'journal')}>
          {page === 'journal' ? 'К заданиям' : 'Журнал печати'}
        </button>}
        <button className="link" type="button" disabled={busy || loggingOut} onClick={onLogout}>{loggingOut ? 'Выходим…' : 'Выйти'}</button>
      </div>
    </header>
    <main className="print-main">
      {accessError && <p className="notice error" role="alert">{accessError}</p>}
      {pendingWork && <p className="notice" role="status">{busy ? 'Ждём подтверждение из журнала.' : 'Нужно проверить результат предыдущей записи.'}{' '}
        <button className="outline" disabled={busy || !working} onClick={retryWork}>Повторить тот же запрос</button></p>}
      {page === 'journal' ? <WorkJournal journalError={serverJournal.error} work={serverJournal.work}/> : <>
        {(metadata?.stale || !loadedDetails && preview?.stale) && <p className="notice">РИТМ отдаёт предыдущий снимок. Часть данных может быть устаревшей.</p>}
        <div className="workspace-toolbar">
          <button className="outline supply-current" type="button" ref={shipmentButton} aria-expanded={shipmentsOpen}
              disabled={!metadata || busy} aria-controls="shipment-picker"
              onClick={() => setShipmentsOpen(open => !open)}>
            <span className="quiet">Поставка</span>
            <strong>{supply?.name || '—'}</strong>
            <span className="supply-chevron" aria-hidden="true"/>
          </button>
          <button className="outline pane-toggle" type="button" aria-expanded={queueOpen} aria-controls="article-queue"
            onClick={() => setQueueOpen(open => !open)}>Список артикулов</button>
          {hasDetail && <button className="outline pane-toggle" type="button" ref={detailButton}
            aria-expanded={detailVisible} aria-controls="article-details" disabled={busy}
            onClick={() => {
              setDetailOpen(open => !open);
              if (!detailVisible) focusArticlePane();
            }}>{detailArticle?.article || 'Рабочая панель'}</button>}
        </div>
        <div className="printing-workspace" data-shipments-open={shipmentsOpen} data-queue-open={queueOpen} data-detail-open={detailVisible}>
          <aside className="shipment-sidebar" id="shipment-picker" aria-label="Поставки" hidden={!shipmentsOpen}
            onKeyDown={event => { if (event.key === 'Escape') closeShipments(); }}>
            {metadata && <ShipmentPicker key={department} supplies={pickerSupplies} current={supply}
              loading={summaryLoading} stale={metadata.stale || !!error} busy={busy} onPick={chooseSupply}/>}
          </aside>
          <section className="queue-pane" id="article-queue" aria-labelledby="queue-title" ref={queuePane} hidden={!queueOpen}>
              <div className="queue-toolbar">
                <div className="queue-heading">
                  <h1 id="queue-title">Задания на печать</h1>
                  <button className="link refresh" type="button" disabled={busy}
                    onClick={() => { clearSelection();setReload(value => value+1); }}>Обновить</button>
                </div>
                {id && <div className="queue-search">
                    {isRoll && <input type="search" aria-label="Поиск по рулонам" placeholder="Поиск по рулонам"
                      value={rollQuery} onChange={event => { clearSelection();setRollQuery(event.target.value); }}/>}
                    <input type="search" aria-label="Артикул или название" placeholder="Артикул или название" value={query}
                      maxLength={160} onChange={event => {
                        clearSelection();
                        setQuery(event.target.value);
                        queuePane.current?.scrollTo(0,0);
                      }}/>
                    {details && <div className="queue-filters">
                      <select aria-label="Станок" value={machine} disabled={busy}
                        onChange={event => { clearSelection();setMachine(event.target.value); }}>
                        <option value="">Все станки</option>
                        {machines.map(option => <option key={option}>{option}</option>)}
                      </select>
                      <JobFilters groups={groups} rows={rows} filters={filters} onToggle={toggleFilter}
                        onReset={() => { clearSelection();setFilters({}); }}/>
                    </div>}
                </div>}
                  {rollChoices && <div className="queue-mode-controls">
                    <div className="segments" role="group" aria-label="Режим списка рулонной печати">
                      {[['','Все артикулы'],['print','Печать'],['cut','Порезка']].map(([operation,label]) =>
                        <button key={operation} type="button" aria-pressed={rollOperation === operation} disabled={busy}
                          onClick={() => chooseRollOperation(operation)}>{label}</button>)}
                    </div>
                  </div>}
                  {!isRoll && (editable || canCorrect) && <div className="queue-mode-controls">
                    <div className="segments" aria-label="Режим бокса">
                      <button type="button" disabled={busy || !editable} aria-pressed={showTake}
                        onClick={() => chooseBoxMode('take')}>В работу</button>
                      <button type="button" disabled={busy || !editable} aria-pressed={showBoxWork}
                        onClick={() => chooseBoxMode('work')}>Печать и порезка</button>
                      {canCorrect && <button type="button" disabled={busy} aria-pressed={boxCorrections}
                        onClick={() => chooseBoxMode('correct')}>Исправления</button>}
                    </div>
                    {showBoxWork && <div className="segments" role="group" aria-label="Массовая операция">
                      {['print','cut'].map(operation => <button type="button" key={operation} disabled={busy}
                        aria-pressed={boxOperation === operation} onClick={() => {
                          if (boxOperation !== operation) {
                            clearSelection();setEmployee('');setBoxOperation(operation);
                            queuePane.current?.scrollTo(0,0);
                          }
                        }}>{operationNames[operation]}</button>)}
                    </div>}
                  </div>}
              </div>
                {error && <p className="notice error" role="alert">{error}</p>}
                {!metadata && !error && <p className="notice" role="status">Загружаем поставки РИТМ…</p>}
                {metadata && !supply && <p className="notice">В этом разделе нет поставок.</p>}
                {id && (!loadedDetails || loadedDetails.partial) && !detailError && <p className="notice" role="status">
                  {details ? (isRoll ? 'Подгружаем рулоны и журнал…' : 'Подгружаем рабочий журнал…') : 'Загружаем артикулы поставки…'}</p>}
                {detailError && <p className="notice error" role="alert">{detailError}</p>}
                {searchKey && <OtherShipmentMatches result={searchResults?.key === searchKey ? searchResults : null}
                  busy={busy} onOpen={openSearchMatch}/>}
                {details && <>
                  {!details.partial && !details.detailsAvailable && <p className="notice">Дополнительные поля из таблицы пока недоступны.</p>}
                  {details.writeMessage && <p className="notice error" role="alert">{details.writeMessage}</p>}
                  {keyword && <h2 className="search-section-title">В текущей поставке</h2>}
                  <div className="queue-tools">
                    {selectable && <SelectionBar eligible={eligible.size} count={selected.length} disabled={busy}
                      onSelectAll={() => { setChecked(new Set(eligible));setBatchView(true);setDetailOpen(true);setFeedback(null); }} onClear={clearSelection}>
                      {assignmentRows.length > 0 && <button className="link" type="button" disabled={allocationOpen || blocked}
                        onClick={() => openRollAllocation()}>Назначить рулоны</button>}
                      {selected.length > 0 && (!isRoll || working) && <button className="link" type="button" disabled={busy}
                        onClick={() => { setAllocate(false);setBatchView(true);setDetailOpen(true);focusArticlePane(); }}>К выбранным</button>}
                    </SelectionBar>}
                    <span className="queue-count">{visible.length}{visible.length !== rows.length && ' из '+rows.length} поз.</span>
                  </div>
                  <JobQueue rows={visible} showChecks={selectable} selectionDisabled={busy} chosen={checked} eligible={eligible} emptyMessage={emptyQueue}
                    activeId={detailVisible ? detailArticle?.id : undefined} onOpen={openArticle} onChoose={toggleCheck} recordsForRow={recordsForRow}
                    rollQuery={rollQuery} rollOperation={rollOperation} rollChoices={rollChoices} boxChoices={boxChoices}
                    showTake={showTake} isBox={!isRoll} showRemaining={!!keyword}/>
                </>}
          </section>
          <section className={'detail-pane'+(boxBatch || rollBatch ? ' box-batch-open' : activeRow && !allocationOpen ? ' article-open' : '')}
            id="article-details" aria-label="Рабочая панель" ref={articlePane} hidden={!detailVisible}>
            <button className="link detail-close" type="button" disabled={busy} onClick={closeDetail}>Свернуть панель</button>
            {feedback && <p className={'notice '+(feedback.error ? 'error' : 'success')}
              role={feedback.error ? 'alert' : 'status'}>{feedback.value}</p>}
            {allocationOpen ? <RollAllocation rows={assignmentRows} drafts={drafts} changeDraft={changeDraft}
              mode={rollMode} setMode={setRollMode} sharedName={sharedName} setSharedName={setSharedName}
              onSave={saveSelectedRolls} onBack={() => setAllocate(false)} blocked={blocked}/> : rollBatch ?
              <RollBatchWork selection={rollWorkSelection} operation={selectedRollOperation}
                onOperation={chooseRollOperation}
                onAssign={() => openRollAllocation('print')} onOpen={openArticle} onSave={saveRollBatch} blocked={blocked}/> :
              boxBatch ? <>
                <h2 className="panel-title">{showTake ? 'Взять в работу' : operationNames[boxOperation]+' по выбранным'}</h2>
                <ul className="box-selection">{selected.map(row => {
                  const entry = boxChoices.get(row.id);
                  return <li key={row.id}>
                    <button className="product" type="button" onClick={() => openArticle(row.id)}>
                      <ProductPhoto key={row.photo} url={row.photo}/>
                      <span className="product-copy"><strong>{row.article}</strong><small className="product-name" title={row.name}>{row.name}</small></span>
                    </button>
                    {showTake ? <TakeFields row={row} records={recordsForRow(row.id)} draft={drafts[row.id]}
                      checked={!blocked} onChange={patch => changeDraft(row.id,patch)}/> :
                      <strong className="box-batch-quantity">{showAmount(entry.quantity)} {entry.unit === 'sheets' ? 'л.' : 'шт.'}</strong>}
                  </li>;
                })}</ul>
                <BoxBatchDock count={selected.length} employee={employee} setEmployee={setEmployee}
                  action={handleBoxBatch} employees={employees} blocked={blocked} label={boxSubmitLabel}
                  note={showTake ? 'Пустое количество — весь доступный остаток.' : undefined}/>
              </> : activeRow ? <>
                <ArticleSummary row={activeRow} records={recordsForRow(activeRow.id)} isRoll={isRoll}/>
                <div className="article-scroller" key={JSON.stringify([id,activeRow.id,normalize(rollQuery),!isRoll && activeBoxMode,queueOperation])}>
                  <InlineWork row={activeRow} supply={supply} isRoll={isRoll} records={recordsForRow(activeRow.id)} onSave={saveWork} onCreate={handleCreate}
                    rollQuery={rollQuery} working={working} employees={employees} blocked={blocked} readOnly={!editable || boxCorrections}
                    onCorrect={canCorrect ? saveCorrection : undefined} correctionsOnly={boxCorrections}
                    defaultOperation={queueOperation || undefined}/>
                </div>
              </> : articleId && !feedback && <p className="notice" role="status">
                {detailError || (details ? 'Артикул отсутствует в поставке.' : 'Загружаем артикул…')}</p>}
          </section>
        </div>
      </>}
    </main>
  </>;
}
