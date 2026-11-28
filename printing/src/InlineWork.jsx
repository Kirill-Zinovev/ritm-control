import React, { useState } from 'react';
import { BoxEmployee, showAmount } from './BatchWork.jsx';
import { PrintingCorrection } from './PrintingCorrection.jsx';
import { isXerox, localTotal, matchesRoll, operationNames, rollDraft, rollEmployee, rollTitle, unitFactor, workRemaining } from './printing-workflow.mjs';

export function Meter({label, value, plan, cut = false}) {
  return <span className={'meter'+(cut?' cut':'')} title={label}>
    <span><span className="sr-only">{label} </span>{showAmount(value)} / {showAmount(plan)}</span>
    <progress aria-label={label} value={value ?? 0} max={Math.max(1, plan || 0)}/>
  </span>;
}

export function InlineWork({row, supply, isRoll, records, onSave, onCreate, onCorrect, correctionsOnly, rollQuery, working, employees, blocked, readOnly, defaultOperation}) {
  const xerox = !isRoll && isXerox(row);
  const [rollId, setRollId] = useState('');
  const [chosenOperation, setOperation] = useState('');
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState(xerox ? 'sheets' : 'pieces');
  const [adding, setAdding] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const current = row.rolls?.find(roll => roll.id === rollId)
    || row.rolls?.find(roll => matchesRoll(roll, rollQuery))
    || row.rolls?.[0];
  const base = current || row;
  const printed = base.printed == null ? null : base.printed + localTotal(records, 'print', current?.id);
  const cut = base.cut == null ? null : base.cut + localTotal(records, 'cut', current?.id);
  const operation = isRoll ? 'print' : chosenOperation || defaultOperation || 'print';
  const limit = workRemaining(operation,current?.quantity ?? row.plan,printed,cut);
  const employee = isRoll ? rollEmployee(current, row, operation) : employees ? employees.find(item => item.id === name)?.id : name.trim();
  const factor = unitFactor(row, unit);
  const available = !readOnly && supply.status === 'open' && (!isRoll || !!current) &&
    (!working || (isRoll ? !current?.legacyOnly : !!row.fingerprint && !!employees?.length));
  const maximum = limit == null || factor == null ? null : Math.floor(limit / factor + 1e-8);
  const noWorkMessage = !isRoll && limit === 0 && (operation === 'print' ? 'Весь тираж напечатан.' :
    printed === 0 ? 'Порезка доступна после печати.' : 'Всё напечатанное уже порезано.');
  const assigned = row.rolls?.reduce((sum, roll) => sum + roll.quantity, 0);
  const unassigned = assigned == null ? null : Math.max(0, row.plan - assigned);
  const editable = Number(quantity) > 0 && Number.isSafeInteger(Number(quantity));
  const canSave = !blocked && available && employee && maximum != null && maximum > 0 && editable && Number(quantity) <= maximum;
  const correctingWork = !!onCorrect && (correcting || correctionsOnly);

  function selectOperation(value) {
    setOperation(value);
    setQuantity('');
    setError('');
    setInfo('');
  }

  async function save(event) {
    event.preventDefault();
    if (!canSave) {
      setError('Проверьте сотрудника и доступное количество.');
      return;
    }
    try {
      const message = await onSave({
        id:crypto.randomUUID(), supplyId:supply.id, rowId:row.id, article:row.article,
        rollId:current?.id || '', rollName:current ? rollTitle(current) : '',
        operation, employee, quantity:Number(quantity), unit, pieces:Number(quantity) * factor,
        at:new Date().toISOString(),
      });
      setQuantity('');
      setError('');
      setInfo(message);
    } catch (failure) { setError(failure.message || 'Не удалось сохранить запись.'); }
  }

  async function add(event) {
    event.preventDefault();
    if (blocked) return;
    const check = rollDraft(row, draft);
    if (check.error) {
      setError(check.error);
      return;
    }
    try {
      const [created] = await onCreate([{rowId:row.id, draft}]);
      if (created) setRollId(created.id);
      selectOperation('print');
      setAdding(false);
      setDraft({});
      setInfo(working ? 'Рулон добавлен через РИТМ.' : 'Рулон добавлен в этом браузере.');
    } catch (failure) { setError(failure.message || 'Не удалось сохранить рулон.'); }
  }

  async function correct(item) {
    const message = await onCorrect(item);
    setInfo(message);
    setError('');
  }

  return <section className="inline" aria-label={'Работа по артикулу '+row.article}>
    {isRoll && <>
      <div className="inline-head">
        <h2>Рулоны</h2>
        {!readOnly && !correctingWork && supply.status === 'open' && assigned != null && <button className="outline inline-add" disabled={!unassigned}
          type="button" onClick={() => { setAdding(!adding); setError(''); }}>
          {adding ? 'Скрыть добавление' : 'Добавить рулон'}
        </button>}
      </div>
      {unassigned > 0 && <p className="quiet roll-balance">Осталось распределить {showAmount(unassigned)} шт.</p>}
      {adding && <form className="work-form roll-add-form" onSubmit={add}>
        <div className="work-fields">
          <label>Название рулона<input required maxLength={60} placeholder="д17" value={draft.name ?? ''}
            onChange={event => setDraft({...draft,name:event.target.value})}/></label>
          <label>Штук на рулон<input required type="number" min="1" max={unassigned} step="1" value={draft.quantity ?? ''}
            onChange={event => setDraft({...draft,quantity:event.target.value})}/></label>
          <button className="primary" type="submit" disabled={blocked}>{working ? 'Добавить рулон' : 'Добавить локально'}</button>
        </div>
      </form>}
      {row.rolls?.length ? <div className="rolls">
        <div className="roll-row roll-head"><span>Рулон</span><span>Печать</span><span>Порезка</span></div>
        {row.rolls.map(roll => {
          const printFact = roll.printed + localTotal(records, 'print', roll.id);
          const cutFact = roll.cut + localTotal(records, 'cut', roll.id);
          return <div className={'roll-row'+(roll.id === current?.id ? ' selected' : '')} key={roll.id}>
            <label><input type="radio" name={'roll-'+row.id} checked={roll.id === current?.id}
              onChange={() => { setRollId(roll.id); selectOperation(''); }}/>
              {rollTitle(roll) || 'Без названия'}{roll.legacyOnly ? <small>История</small> : roll.local && <small>Локально</small>}
            </label>
            <Meter label="Печать рулона" plan={roll.quantity} value={printFact}/>
            <Meter cut label="Порезка рулона" plan={roll.quantity} value={cutFact}/>
          </div>;
        })}
      </div> : <p>{row.rolls ? 'Рулоны ещё не назначены.' : 'Список рулонов недоступен в текущем чтении.'}</p>}
    </>}
    {working && current?.legacyOnly && <p className="quiet">Рулон из истории.</p>}
    {working && !isRoll && !readOnly && supply.status === 'open' && !available &&
      <p className="quiet">Запись по артикулу недоступна. Проверьте строку в таблице.</p>}
    {onCorrect && !correctionsOnly && <button className="outline correction-toggle" type="button" aria-expanded={correctingWork}
      disabled={blocked} onClick={() => {setCorrecting(!correcting);setAdding(false);setInfo('');setError('');}}>
      {correctingWork ? 'Закрыть исправления' : 'Исправить запись'}
    </button>}
    {correctingWork && <PrintingCorrection key={JSON.stringify([current?.id,row.workRevision])} row={row} roll={current}
      isRoll={isRoll} blocked={blocked} onSave={correct}/>}
    {available && !adding && !correctingWork && <form onSubmit={save} className="work-form work-record">
      {!isRoll && <div className="work-heading">
        <div className="segments operation-tabs" aria-label="Операция по артикулу">
          {['print','cut'].map(key => <button key={key} type="button" aria-pressed={operation === key}
            onClick={() => selectOperation(key)}>{operationNames[key]}</button>)}
        </div>
      </div>}
      <div className="work-employee">
        {isRoll ? <div className="automatic-employee">
          <span>Печатник</span><strong>{employee || 'Не определён'}</strong>
          <small>{employee ? 'Подставляется автоматически' : 'Проверьте начало названия рулона'}</small>
        </div> : <BoxEmployee employees={employees} value={name} onChange={setName}/>}
      </div>
      <div className="work-fields">
        <label>{unit === 'sheets' ? 'Количество, л.' : 'Количество, шт.'}<input required type="number" min="1" step="1"
          max={maximum ?? undefined} value={quantity} onChange={event => setQuantity(event.target.value)}/></label>
        {xerox && <label>Единица<select value={unit} onChange={event => { setUnit(event.target.value); setQuantity(''); }}>
          <option value="sheets">Листы</option><option value="pieces">Штуки</option>
        </select></label>}
        <button className="outline" type="button" disabled={!maximum} onClick={() => setQuantity(String(maximum))}>Весь остаток</button>
      </div>
      <p className="remaining">{noWorkMessage || (maximum == null ? 'Доступное количество не подтверждено.' :
        <>Доступно <strong>{showAmount(maximum)}{unit === 'sheets' ? ' л.' : ' шт.'}</strong></>)}</p>
      <button className="primary work-submit" type="submit" disabled={!canSave}>
        {operation === 'cut' ? 'Записать порезку' : 'Записать печать'}{editable ? ' · '+showAmount(Number(quantity))+(unit === 'sheets' ? ' л.' : ' шт.') : ''}
      </button>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {info && <p className="success" role="status">{info}</p>}
    <div className="inline-links">
      {records.length > 0 && <details><summary>Локальная история</summary><ul>{records.map(record =>
        <li key={record.id}>{operationNames[record.operation]} {record.rollName ? '· '+record.rollName+' ' : ''}· {record.employee} · {showAmount(record.quantity)} {record.unit === 'sheets' ? 'л.' : 'шт.'}</li>
      )}</ul></details>}
      {row.url && <a href={row.url} target="_blank" rel="noreferrer">Открыть в таблице</a>}
    </div>
  </section>;
}
