import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { showAmount } from './BatchWork.jsx';
import { MAX_ROLLS, matchesRoll, rollTitle } from './printing-workflow.mjs';
import './cutter.css';

const cutterUrl = '/api/printing-cutter';
const pendingKey = 'ritm-printing-cutter-pending-v1';
const refreshInterval = 30_000;
const completedFormat = new Intl.DateTimeFormat('ru-RU', {
  dateStyle:'short', timeStyle:'short', timeZone:'Europe/Moscow',
});

function savedRequest() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(pendingKey));
    return typeof pending?.requestId === 'string' && Array.isArray(pending.rolls) && pending.rolls.length ? pending : null;
  } catch { return null; }
}

function storeRequest(request) {
  try {
    if (request) sessionStorage.setItem(pendingKey, JSON.stringify(request));
    else sessionStorage.removeItem(pendingKey);
  } catch { /* The active workspace can still retry the request. */ }
}

async function cutterRequest(signal, payload) {
  const response = await fetch(cutterUrl,payload ? {
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

function RollRows({roll, isComplete, selected, blocked, onToggle, onCut}) {
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
        : <td className="cutter-row-action"><button type="button" className="outline" aria-label={'Порезать рулон '+description}
          onClick={() => onCut([roll])} disabled={blocked}>Порезать</button></td>}
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

function RollTable({rolls, isComplete, selected, blocked, onToggle, onToggleAll, onCut}) {
  const selectAll = useRef(null);
  const selectedCount = rolls.reduce((total,roll) => total+Number(selected.has(roll.id)),0);
  const allSelected = selectedCount > 0 && selectedCount === rolls.length;
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selectedCount > 0 && !allSelected;
  },[selectedCount,allSelected]);

  return <div className="cutter-table-wrap" role="region" aria-label={isComplete ? 'Завершённые рулоны' : 'Рулоны к порезке'} tabIndex={0}>
    <table className="cutter-table">
      <thead><tr>
        {!isComplete && <th scope="col" className="cutter-check-cell"><input type="checkbox" ref={selectAll}
          aria-label="Выбрать все показанные рулоны" checked={allSelected} onChange={() => onToggleAll(rolls,!allSelected)} disabled={blocked}/></th>}
        <th scope="col">Рулон</th><th scope="col">Поставка</th>
        <th scope="col" className="cutter-number">{isComplete ? 'Порезано, шт.' : 'К порезке, шт.'}</th>
        {isComplete ? <th scope="col" className="cutter-time">Завершён</th> : <th scope="col"><span className="sr-only">Действие</span></th>}
      </tr></thead>
      <tbody>{rolls.map(roll => <RollRows key={roll.id} roll={roll} isComplete={isComplete} selected={selected.has(roll.id)}
        blocked={blocked} onToggle={() => onToggle(roll)} onCut={onCut}/>)}</tbody>
    </table>
  </div>;
}

function SelectedRolls({rolls, blocked, onClear, onCut}) {
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
      <button type="button" className="primary" disabled={blocked || tooMany} onClick={() => onCut(rolls)}>Записать порезку</button>
      <button type="button" className="outline" disabled={blocked} onClick={onClear}>Снять выбор</button>
    </div>
  </aside>;
}

function removeRecorded(data, written) {
  if (!data) return data;
  const cutBySupply = new Map();
  const ready = data.ready.filter(roll => {
    if (!written.has(roll.id)) return true;
    cutBySupply.set(roll.supplyId,(cutBySupply.get(roll.supplyId) ?? 0)+1);
    return false;
  });
  return {...data,ready,supplies:data.supplies.map(supply => ({
    ...supply,remaining:supply.remaining-(cutBySupply.get(supply.id) ?? 0),
  }))};
}

export function CutterWorkspace({onSessionExpired,onLogout,loggingOut,accessError,themeControl}) {
  const [data,setData] = useState(null);
  const [supplyId,setSupplyId] = useState('');
  const [isComplete,setComplete] = useState(false);
  const [query,setQuery] = useState('');
  const [selected,setSelected] = useState(() => new Map());
  const [loading,setLoading] = useState(true);
  const [loadError,setLoadError] = useState('');
  const [notice,setNotice] = useState(null);
  const [pending,setPending] = useState(savedRequest);
  const [saving,setSaving] = useState(false);
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
      const current = new Map(snapshot.ready.map(roll => [roll.id,roll.revision]));
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

  const rolls = useMemo(() => (isComplete ? data?.completed : data?.ready)?.filter(roll =>
    (!supplyId || roll.supplyId === supplyId) && (!query.trim() || matchesRoll(roll,query))) ?? [],[data,isComplete,supplyId,query]);
  const chosenRolls = useMemo(() => data?.ready.filter(roll => selected.get(roll.id) === roll.revision) ?? [],[data,selected]);
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
    try {
      const result = await cutterRequest(null,request);
      storeRequest(null);
      if (!mounted.current) return;
      setPending(null);
      const written = new Set(request.rolls.map(roll => roll.id));
      setData(previous => removeRecorded(previous,written));
      setSelected(previous => new Map([...previous].filter(([id]) => !written.has(id))));
      const summary = Number.isSafeInteger(result.recorded) && Number.isFinite(result.quantity)
        ? `Порезка записана · ${showAmount(result.recorded)} рул. · ${showAmount(result.quantity)} шт.` : 'Порезка записана.';
      setNotice({type:'success',message:summary});
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
      if (mounted.current) {
        setSaving(false);
        if (shouldRefresh) refresh();
      }
    }
  }

  function cut(rolls) {
    if (!blocked && rolls.length && rolls.length <= MAX_ROLLS) {
      save({requestId:crypto.randomUUID(),rolls:rolls.map(({id,revision}) => ({id,revision}))});
    }
  }

  return <>
    <header className="header">
      <div className="brand"><b>RITM /</b> Печать</div><span className="department-title">Резчик</span>
      <div className="header-actions">{themeControl}
        <button className="link" type="button" disabled={saving || loggingOut} onClick={onLogout}>{loggingOut ? 'Выходим…' : 'Выйти'}</button>
      </div>
    </header>
    <main className="cutter-workspace">
      <ShipmentList supplies={data?.supplies ?? []} selected={supplyId} onSelect={setSupplyId}/>
      <section className="cutter-queue" aria-labelledby="cutter-queue-title">
        <div className="cutter-queue-heading"><h1 id="cutter-queue-title">Очередь порезки</h1>
          <button type="button" className="link" onClick={refresh} disabled={saving || loading}>Обновить</button>
        </div>
        <div className="segments" role="group" aria-label="Состояние рулонов">
          <button type="button" aria-pressed={!isComplete} onClick={() => setComplete(false)}>К порезке</button>
          <button type="button" aria-pressed={isComplete} onClick={() => setComplete(true)}>Завершённые</button>
        </div>
        <div className="cutter-queue-content" data-show-selection={!isComplete && chosenRolls.length > 0}>
          <div className="cutter-queue-list">
            {accessError && <p className="notice error" role="alert">{accessError}</p>}
            {loadError && <p className="notice error" role="alert">{loadError}</p>}
            {notice && <p className={'notice '+notice.type} role={notice.type === 'error' ? 'alert' : 'status'}>{notice.message}</p>}
            {pending && <div className="notice cutter-pending" role="status">
              <p>{saving ? 'Записываем порезку…' : 'Журнал пока не подтвердил результат порезки.'}</p>
              {!saving && <button className="outline" type="button" disabled={loggingOut} onClick={() => save(pending)}>Проверить запись</button>}
            </div>}
            <label className="cutter-search"><span className="sr-only">Название рулона</span>
              <input type="search" placeholder="Название рулона" value={query} onChange={event => setQuery(event.target.value)}/>
            </label>
            {rolls.length ? <RollTable key={String(isComplete)} rolls={rolls} isComplete={isComplete} selected={selected}
              blocked={blocked} onToggle={toggleRoll} onToggleAll={toggleVisible} onCut={cut}/>
              : (!loadError || data) && <p className="cutter-empty quiet" role="status">{loading && !data ? 'Загружаем рулоны…'
                : query.trim() ? 'Рулоны по этому названию не найдены.'
                : isComplete ? 'Завершённых рулонов пока нет.' : 'Рулонов к порезке пока нет.'}</p>}
          </div>
          {!isComplete && chosenRolls.length > 0 && <SelectedRolls rolls={chosenRolls} blocked={blocked} onCut={cut}
            onClear={() => setSelected(new Map())}/>}
        </div>
      </section>
    </main>
  </>;
}
