import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { showAmount } from './BatchWork.jsx';
import { MAX_ROLLS, matchesRoll, rollTitle } from './printing-workflow.mjs';
import './cutter.css';

const cutterUrl = '/api/printing-cutter';
const pendingKey = 'ritm-printing-cutter-pending-v1';
const refreshInterval = 30_000;
const stages = {
  ready: {label:'К порезке',region:'Рулоны к порезке',empty:'Рулонов к порезке пока нет.',action:'take',actionLabel:'Взять в порезку'},
  inProgress: {label:'В порезке',region:'Рулоны в порезке',empty:'Рулонов в порезке пока нет.',action:'cut',actionLabel:'Порезал'},
  completed: {label:'Завершённые',region:'Завершённые рулоны',empty:'Завершённых рулонов пока нет.'},
};
const stageEntries = Object.entries(stages);
const completedFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle:'short', timeStyle:'short', timeZone:'Europe/Moscow',
});

function savedRequest() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(pendingKey));
    const supported = pending?.action === undefined || ['take','cut'].includes(pending.action);
    return supported && typeof pending?.requestId === 'string' && Array.isArray(pending.rolls) && pending.rolls.length ? pending : null;
  } catch { return null; }
}

function storeRequest(request) {
  try {
    if (request) sessionStorage.setItem(pendingKey, JSON.stringify(request));
    else sessionStorage.removeItem(pendingKey);
  } catch { /* The active workspace can still retry the request. */ }
}

async function cutterRequest(signal, payload) {
  const url = payload?.action ? `${cutterUrl}/work` : cutterUrl;
  const response = await fetch(url,payload ? {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
  } : {signal,cache:'no-store'});
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    throw Object.assign(new Error(result?.message || 'Сервер порезки недоступен.'),{status:response.status});
  }
  return result;
}

function ShipmentList({supplies, selected, onSelect}) {
  const remaining = supplies.reduce((sum,supply) => sum+supply.remaining,0);
  return <aside className="cutter-shipments" aria-labelledby="cutter-shipments-title">
    <h2 id="cutter-shipments-title">Поставки</h2>
    <p className="quiet">Рулонов к порезке</p>
    <nav aria-label="Фильтр по поставкам">
      {[{id:'',name:'Все поставки',remaining},...supplies].map(supply => <button key={supply.id}
        type="button" className="outline cutter-shipment" aria-pressed={selected === supply.id}
        onClick={() => onSelect(supply.id)}>
        <span>{supply.name}</span><strong>{showAmount(supply.remaining)}</strong>
      </button>)}
    </nav>
  </aside>;
}

function RollRows({roll, stage, selected, blocked, onToggle, onWork}) {
  const isComplete = !stage.action;
  const [expanded,setExpanded] = useState(false);
  const detailsId = useId();
  const title = rollTitle(roll);
  const description = [title,roll.supplyName].join(', ');
  const completed = roll.completedAt && new Date(roll.completedAt);
  return <>
    <tr className="cutter-roll-row" data-selected={selected || expanded}>
      {!isComplete && <td className="cutter-check-cell"><input type="checkbox" aria-label={'Выбрать рулон '+description}
        checked={selected} onChange={onToggle} disabled={blocked}/></td>}
      <th scope="row"><button type="button" className="link cutter-expand" aria-expanded={expanded}
        aria-controls={expanded ? detailsId : undefined} aria-label={title+', состав рулона, '+roll.supplyName}
        onClick={() => setExpanded(value => !value)}>
        <span className="cutter-chevron" aria-hidden="true"/>{title}
      </button></th>
      <td>{roll.supplyName}</td>
      <td className="cutter-number">{showAmount(isComplete ? roll.cut : roll.remaining)}</td>
      {isComplete ? <td className="cutter-time">{completed && Number.isFinite(+completed)
        ? <time dateTime={completed.toISOString()}>{completedFormat.format(completed)}</time> : '—'}</td>
        : <td className="cutter-row-action"><button type="button" className="outline" aria-label={stage.actionLabel+' · '+description}
          onClick={() => onWork([roll])} disabled={blocked}>{stage.actionLabel}</button></td>}
    </tr>
    {expanded && <tr className="cutter-detail-row"><td colSpan={isComplete ? 4 : 5}>
      <section className="cutter-composition" id={detailsId}>
        <h3>Состав рулона {title}</h3>
        <table>
          <thead><tr><th scope="col">Артикул</th><th scope="col">Наименование</th>
            <th scope="col" className="cutter-number">{isComplete ? 'Порезано, шт.' : 'К порезке, шт.'}</th></tr></thead>
          <tbody>{roll.items.map((item,index) => <tr key={item.id || JSON.stringify([item.article,index])}>
            <th scope="row">{item.article}</th><td>{item.name || '—'}</td>
            <td className="cutter-number">{showAmount(isComplete ? item.cut : item.remaining)}</td>
          </tr>)}</tbody>
        </table>
      </section>
    </td></tr>}
  </>;
}

function RollTable({rolls, stage, selected, blocked, onToggle, onToggleAll, onWork}) {
  const isComplete = !stage.action;
  const selectAll = useRef(null);
  const selectedCount = rolls.reduce((total,roll) => total+Number(selected.has(roll.id)),0);
  const allSelected = selectedCount > 0 && selectedCount === rolls.length;
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selectedCount > 0 && !allSelected;
  },[selectedCount,allSelected]);

  return <div className="cutter-table-wrap" role="region" aria-label={stage.region} tabIndex={0}>
    <table className="cutter-table">
      <thead><tr>
        {!isComplete && <th scope="col" className="cutter-check-cell"><input type="checkbox" ref={selectAll}
          aria-label="Выбрать все показанные рулоны" checked={allSelected} onChange={() => onToggleAll(rolls,!allSelected)} disabled={blocked}/></th>}
        <th scope="col">Рулон</th><th scope="col">Поставка</th>
        <th scope="col" className="cutter-number">{isComplete ? 'Порезано, шт.' : 'К порезке, шт.'}</th>
        {isComplete ? <th scope="col" className="cutter-time">Завершён</th> : <th scope="col"><span className="sr-only">Действие</span></th>}
      </tr></thead>
      <tbody>{rolls.map(roll => <RollRows key={roll.id} roll={roll} stage={stage} selected={selected.has(roll.id)}
        blocked={blocked} onToggle={() => onToggle(roll)} onWork={onWork}/>)}</tbody>
    </table>
  </div>;
}

function SelectedRolls({rolls, actionLabel, blocked, onClear, onWork}) {
  const pieces = rolls.reduce((total,roll) => total+roll.remaining,0);
  const tooMany = rolls.length > MAX_ROLLS;
  return <aside className="cutter-selection" aria-labelledby="cutter-selection-title">
    <h2 id="cutter-selection-title">Выбранные рулоны</h2>
    <ul>{rolls.map(roll => <li key={roll.id}>
      <div><strong>{rollTitle(roll)}</strong><small>{roll.supplyName}</small></div>
      <strong>{showAmount(roll.remaining)} шт.</strong>
    </li>)}</ul>
    <div className="cutter-selection-footer">
      <p><span>Итого · {showAmount(rolls.length)} рул.</span><strong>{showAmount(pieces)} шт.</strong></p>
      {tooMany && <p className="error" role="alert">За один раз можно записать до {MAX_ROLLS} рулонов.</p>}
      <button type="button" className="primary" disabled={blocked || tooMany} onClick={() => onWork(rolls)}>{actionLabel}</button>
      <button type="button" className="outline" disabled={blocked} onClick={onClear}>Снять выбор</button>
    </div>
  </aside>;
}

function removeRecorded(data, written, action) {
  if (!data) return data;
  const source = action === 'cut' ? 'inProgress' : 'ready';
  const recordedBySupply = new Map();
  const rolls = (data[source] ?? []).filter(roll => {
    if (!written.has(roll.id)) return true;
    recordedBySupply.set(roll.supplyId,(recordedBySupply.get(roll.supplyId) ?? 0)+1);
    return false;
  });
  if (action === 'take') return {...data,[source]:rolls};
  return {...data,[source]:rolls,supplies:data.supplies.map(supply => ({
    ...supply,remaining:Math.max(0,supply.remaining-(recordedBySupply.get(supply.id) ?? 0)),
  }))};
}

export function CutterWorkspace({onSessionExpired,onLogout,loggingOut,accessError,themeControl}) {
  const [data,setData] = useState(null);
  const [supplyId,setSupplyId] = useState('');
  const [stageId,setStageId] = useState('ready');
  const [query,setQuery] = useState('');
  const [selected,setSelected] = useState(() => new Map());
  const [loading,setLoading] = useState(true);
  const [loadError,setLoadError] = useState('');
  const [notice,setNotice] = useState(null);
  const [pending,setPending] = useState(savedRequest);
  const [saving,setSaving] = useState(false);
  const tabButtons = useRef({});
  const mounted = useRef(false);
  const writing = useRef(false);
  const reading = useRef(null);

  const refresh = useCallback(async () => {
    if (writing.current) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setLoading(true);
    try {
      const snapshot = await cutterRequest(controller.signal);
      if (controller.signal.aborted) return;
      const current = new Map([...snapshot.ready,...(snapshot.inProgress ?? [])].map(roll => [roll.id,roll.revision]));
      setData(snapshot);
      setLoadError('');
      setSupplyId(value => snapshot.supplies.some(supply => supply.id === value) ? value : '');
      setSelected(value => new Map([...value].filter(([id,revision]) => current.get(id) === revision)));
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure.status === 401) onSessionExpired();
      else setLoadError(failure.message);
    } finally {
      if (reading.current === controller) {
        reading.current = null;
        setLoading(false);
      }
    }
  },[onSessionExpired]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    function refreshVisible() {
      if (document.visibilityState === 'visible') refresh();
    }
    const timer = setInterval(refreshVisible,refreshInterval);
    document.addEventListener('visibilitychange',refreshVisible);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange',refreshVisible);
      const controller = reading.current;
      reading.current = null;
      controller?.abort();
    };
  },[refresh]);

  const stage = stages[stageId];
  const scopedRolls = useMemo(() => Object.fromEntries(stageEntries.map(([key]) => [key,
    data?.[key]?.filter(roll => !supplyId || roll.supplyId === supplyId) ?? [],
  ])),[data,supplyId]);
  const stageRolls = scopedRolls[stageId];
  const rolls = useMemo(() => query.trim() ? stageRolls.filter(roll => matchesRoll(roll,query)) : stageRolls,[stageRolls,query]);
  const chosenRolls = useMemo(() => stage.action
    ? data?.[stageId]?.filter(roll => selected.get(roll.id) === roll.revision) ?? [] : [],[stage,stageId,data,selected]);
  const blocked = saving || loggingOut || !!pending;

  function toggleRoll(roll) {
    setSelected(previous => {
      const next = new Map(previous);
      if (next.has(roll.id)) next.delete(roll.id);
      else next.set(roll.id,roll.revision);
      return next;
    });
  }

  function toggleVisible(rolls, include) {
    setSelected(previous => {
      const next = new Map(previous);
      for (const roll of rolls) {
        if (include) next.set(roll.id,roll.revision);
        else next.delete(roll.id);
      }
      return next;
    });
  }

  async function save(request) {
    if (writing.current || loggingOut) return;
    writing.current = true;
    reading.current?.abort();
    setNotice(null);
    setSaving(true);
    setPending(request);
    storeRequest(request);
    let shouldRefresh = true;
    let nextStage;
    try {
      const result = await cutterRequest(null,request);
      storeRequest(null);
      if (!mounted.current) return;
      setPending(null);
      const written = new Set(request.rolls.map(roll => roll.id));
      setData(previous => removeRecorded(previous,written,request.action));
      setSelected(previous => new Map([...previous].filter(([id]) => !written.has(id))));
      const tookRolls = request.action === 'take';
      const confirmed = tookRolls ? 'Взято в порезку' : 'Порезка записана';
      const summary = Number.isSafeInteger(result.recorded) && Number.isFinite(result.quantity)
        ? `${confirmed} · ${showAmount(result.recorded)} рул. · ${showAmount(result.quantity)} шт.` : `${confirmed}.`;
      setNotice({type:'success',message:summary});
      nextStage = tookRolls ? 'inProgress' : 'completed';
    } catch (failure) {
      const rejected = failure.status >= 400 && failure.status < 500 && ![401,408,429].includes(failure.status);
      if (rejected) storeRequest(null);
      if (!mounted.current) return;
      if (failure.status === 401) {
        shouldRefresh = false;
        onSessionExpired();
      } else {
        if (rejected) {
          setPending(null);
          setSelected(new Map());
        }
        setNotice({type:'error',message:failure.message});
      }
    } finally {
      writing.current = false;
      if (mounted.current && nextStage) {
        await refresh();
        if (mounted.current) {
          setStageId(nextStage);
          tabButtons.current[nextStage]?.focus();
        }
      } else if (mounted.current && shouldRefresh) {
        refresh();
      }
      if (mounted.current) setSaving(false);
    }
  }

  function work(rolls) {
    if (!blocked && stage.action && rolls.length && rolls.length <= MAX_ROLLS) {
      save({action:stage.action,requestId:crypto.randomUUID(),rolls:rolls.map(({id,revision}) => ({id,revision}))});
    }
  }

  return <div className="cutter-shell">
    <header className="header cutter-header">
      <div className="brand"><b>RITM /</b> Печать</div><span className="department-title">Резчик</span>
      <span className="cutter-header-art" aria-hidden="true"/>
      <div className="header-actions">{themeControl}
        <button className="link" type="button" disabled={saving || loggingOut} onClick={onLogout}>{loggingOut ? 'Выходим…' : 'Выйти'}</button>
      </div>
    </header>
    <main className="cutter-workspace">
      <ShipmentList supplies={data?.supplies ?? []} selected={supplyId} onSelect={setSupplyId}/>
      <section className="cutter-queue" aria-labelledby="cutter-queue-title">
        <div className="cutter-queue-content" data-show-selection={chosenRolls.length > 0}>
          <div className="cutter-queue-list">
            <div className="cutter-queue-heading"><h1 id="cutter-queue-title">Очередь порезки</h1>
              <button type="button" className="link" onClick={refresh} disabled={saving || loading}>Обновить</button>
            </div>
            <div className="segments cutter-tabs" role="group" aria-label="Состояние рулонов">
              {stageEntries.map(([key,item]) => <button type="button" key={key} aria-pressed={stageId === key}
                ref={button => { tabButtons.current[key] = button; }} onClick={() => setStageId(key)}>
                {item.label}{data && <> <span>{showAmount(scopedRolls[key].length)}</span></>}
              </button>)}
            </div>
            {accessError && <p className="notice error" role="alert">{accessError}</p>}
            {loadError && <p className="notice error" role="alert">{loadError}</p>}
            {notice && <p className={'notice '+notice.type} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.message}</p>}
            {pending && <div className="notice cutter-pending" role="status">
              <p>{pending.action === 'take'
                ? (saving ? 'Берём рулоны в порезку…' : 'Журнал пока не подтвердил взятие рулонов в порезку.')
                : (saving ? 'Записываем порезку…' : 'Журнал пока не подтвердил результат порезки.')}</p>
              {!saving && <button className="outline" type="button" disabled={loggingOut} onClick={() => save(pending)}>Проверить запись</button>}
            </div>}
            <label className="cutter-search"><span className="sr-only">Название рулона</span>
              <input type="search" placeholder="Название рулона" value={query} onChange={event => setQuery(event.target.value)}/>
            </label>
            {rolls.length ? <RollTable key={stageId} rolls={rolls} stage={stage} selected={selected}
              blocked={blocked} onToggle={toggleRoll} onToggleAll={toggleVisible} onWork={work}/>
              : (!loadError || data) && <p className="cutter-empty quiet" role="status">{loading && !data ? 'Загружаем рулоны…'
                : query.trim() ? 'Рулоны по этому названию не найдены.' : stage.empty}</p>}
          </div>
          {chosenRolls.length > 0 && <SelectedRolls rolls={chosenRolls} actionLabel={stage.actionLabel} blocked={blocked} onWork={work}
            onClear={() => toggleVisible(chosenRolls,false)}/>}
        </div>
      </section>
    </main>
  </div>;
}
