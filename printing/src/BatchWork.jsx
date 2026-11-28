import React from 'react';
import { MAX_ROLLS, boxSelectionText, isXerox, operationNames, rollDraft, takeRemaining, unitFactor } from './printing-workflow.mjs';

export const quantityText = new Intl.NumberFormat('ru-RU', {maximumFractionDigits:3});
export const showAmount = value => value == null ? '—' : quantityText.format(value);

export function ProductPhoto({url, loading = 'lazy'}) {
  const [failed, setFailed] = React.useState(false);
  return url && !failed
    ? <img className="photo" alt="" src={url} loading={loading} referrerPolicy="no-referrer" onError={() => setFailed(true)}/>
    : <span className="photo missing">Нет фото</span>;
}

export function PrintExtension({value}) {
  const extension = typeof value === 'string' ? value.trim() : '';
  return <small className="print-extension" title={extension ? 'Расширение печати' : 'Расширение печати не указано'}>
    <span className="sr-only">Расширение печати </span>{extension || '—'}
  </small>;
}

export function CopyBoxSelection({rows, entryForRow, disabled}) {
  const [feedback, setFeedback] = React.useState(null);
  async function copy() {
    const result = boxSelectionText(rows,entryForRow);
    if (result.error) {
      setFeedback({error:result.error});
      return;
    }
    try {
      await navigator.clipboard.writeText(result.text);
      setFeedback({message:'Скопировано позиций: '+rows.length});
    } catch {
      setFeedback({error:'Не удалось скопировать. Проверьте доступ к буферу обмена.'});
    }
  }
  return <>
    <button className="link" type="button" disabled={disabled} onClick={copy}>Скопировать артикулы и количество (шт.)</button>
    {feedback?.message && <small className="quiet" role="status">{feedback.message}</small>}
    {feedback?.error && <small className="error" role="alert">{feedback.error}</small>}
  </>;
}

export function SelectionBar({eligible, count, onSelectAll, onClear, children, disabled}) {
  const control = React.useRef(null);
  React.useEffect(() => {
    if (control.current) control.current.indeterminate = count > 0 && count < eligible;
  }, [count, eligible]);
  return <div className="selection-bar">
    <label><input ref={control} type="checkbox" checked={eligible > 0 && count === eligible}
      disabled={disabled || !eligible} onChange={event => event.target.checked ? onSelectAll() : onClear()}/>
      Выбрать все доступные ({eligible})
    </label>
    {count > 0 && <><strong>Выбрано {count} из {eligible}</strong>
      <button className="link" type="button" disabled={disabled} onClick={onClear}>Снять выбор</button></>}
    {children}
  </div>;
}

export function TakeFields({row, records, draft, checked, onChange}) {
  const remaining = takeRemaining(row, records);
  if (remaining == null) return <span className="quiet">Остаток не подтверждён</span>;
  if (remaining <= 1e-8) return <span className="done-text">В работе на весь план</span>;
  const unit = draft?.unit || 'pieces';
  const factor = unitFactor(row, unit);
  const available = factor ? remaining / factor : null;
  return <div className="take-fields">
    <div className="take-inputs">
      <input aria-label={'Взять в работу ' + row.article} type="number" min="1" step="1" disabled={!checked}
        placeholder={showAmount(available)} value={draft?.quantity ?? ''}
        onChange={event => onChange({quantity:event.target.value})}/>
      {isXerox(row) ? <select aria-label={'Единица для ' + row.article} disabled={!checked} value={unit}
        onChange={event => onChange({unit:event.target.value,quantity:''})}>
        <option value="pieces">шт.</option><option value="sheets">листов</option>
      </select> : <span>шт.</span>}
    </div>
    <small>Доступно {showAmount(available)} {unit === 'sheets' ? 'л.' : 'шт.'}</small>
  </div>;
}

export function BoxEmployee({employees, value, onChange}) {
  return <label>Сотрудник{employees ? <select required value={value} onChange={event => onChange(event.target.value)}>
    <option value="">Выберите сотрудника</option>
    {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
  </select> : <input required value={value} maxLength={100} placeholder="Имя сотрудника"
    onChange={event => onChange(event.target.value)}/>}</label>;
}

export function BoxBatchDock({count, employee, setEmployee, action, employees, blocked, label, note}) {
  return <form className="batch-dock" onSubmit={event => { event.preventDefault(); action(); }}>
    <BoxEmployee employees={employees} value={employee} onChange={setEmployee}/>
    {note && <span className="quiet">{note}</span>}
    <button className="primary" disabled={blocked || !count || !employee.trim() || (employees && !employees.some(item => item.id === employee))} type="submit">{label} · {count}</button>
  </form>;
}

export function RollBatchWork({selection, operation, onOperation, onAssign, onOpen, onSave, blocked}) {
  const entries = selection.flatMap(item => item[operation]);
  const pieces = entries.reduce((total, item) => total + item.quantity, 0);
  const tooMany = entries.length > MAX_ROLLS;
  const action = operation === 'print' ? 'Записать печать' : 'Записать порезку';
  const needsRolls = operation === 'print' && selection.some(item => item.unassigned > 0);
  return <>
    <h2 className="panel-title">Печать и порезка по выбранным</h2>
    <div className="segments" role="group" aria-label="Массовая операция по рулонам">
      {['print','cut'].map(key => <button key={key} type="button" aria-pressed={operation === key} disabled={blocked}
        onClick={() => onOperation(key)}>{operationNames[key]}</button>)}
    </div>
    {selection.length ? <ul className="box-selection">
      {selection.map(({row,[operation]:work,unassigned,printRemaining}) => <li key={row.id}>
        <button className="product" type="button" onClick={() => onOpen(row.id)}>
          <ProductPhoto key={row.photo} url={row.photo}/>
          <span className="product-copy"><span className="product-heading"><strong>{row.article}</strong><PrintExtension value={row.extension}/></span><small className="product-name" title={row.name}>{row.name}</small></span>
        </button>
        <div className="take-fields">
          {work.map(item => <small key={item.rollId}>{item.name || 'Рулон'} · <strong>{showAmount(item.quantity)} шт.</strong> · {item.employee}</small>)}
          {operation === 'print' && unassigned > 0
            ? <small>Нужно назначить рулон · <strong>{showAmount(Math.min(unassigned,printRemaining || unassigned))} шт.</strong></small>
            : !work.length && <small className="quiet">Проверьте данные рулона в карточке артикула.</small>}
        </div>
      </li>)}
    </ul> : <p className="notice">{operation === 'print'
      ? 'Среди отмеченных артикулов нет остатка к печати.' : 'Среди отмеченных артикулов нет остатка к порезке.'}</p>}
    <div className="batch-dock">
      {selection.length > 0 && <strong>Артикулов {selection.length}
        {entries.length > 0 && ' · рулонов '+entries.length+' · '+showAmount(pieces)+' шт.'}</strong>}
      {needsRolls && <button className={entries.length ? 'outline' : 'primary'} type="button" disabled={blocked}
        onClick={onAssign}>Назначить рулоны по выбранным</button>}
      {tooMany && <p className="error" role="alert">За один раз можно записать до {MAX_ROLLS} рулонов.</p>}
      {(entries.length > 0 || !needsRolls) && <button className="primary" type="button" disabled={blocked || !entries.length || tooMany}
        onClick={() => onSave(entries)}>{action}{pieces ? ' · '+showAmount(pieces)+' шт.' : ''}</button>}
    </div>
  </>;
}

export function RollAllocation({rows, drafts, changeDraft, mode, setMode, sharedName, setSharedName, onSave, onBack, blocked}) {
  const shared = mode === 'shared';
  const validated = rows.map(row => ({
    row, result:rollDraft(row, drafts[row.id], shared ? sharedName : undefined),
  }));
  const valid = validated.filter(({result}) => !result.error);
  const count = valid.reduce((sum, {result}) => sum + result.count, 0);
  const pieces = valid.reduce((sum, {result}) => sum + result.count * result.quantity, 0);
  return <form className="allocation" onSubmit={event => { event.preventDefault(); onSave(); }}>
    <div className="allocation-head">
      <h2>Создать рулоны</h2>
      <div className="segments" aria-label="Настройка названий">
        {[['shared','Одно название'],['individual','Каждому своё']].map(([key,label]) => (
          <button className={mode === key ? 'primary' : ''} aria-pressed={mode === key}
            type="button" key={key} onClick={() => setMode(key)}>{label}</button>
        ))}
      </div>
      <button className="link" type="button" onClick={onBack}>К списку заданий</button>
    </div>
    {shared && <label className="shared-name">Название для выбранных артикулов
      <input required placeholder="Например, д17" maxLength={60} value={sharedName}
        onChange={event => setSharedName(event.target.value)}/>
    </label>}
    <ul className="allocation-list">{validated.map(({row,result}) => {
      const value = drafts[row.id] || {};
      const showError = result.error && (shared ? sharedName.trim() : value.name?.trim());
      const field = (key,label,attrs) => <label>{label}<input aria-label={label+' '+row.article}
        value={value[key] ?? ''} onChange={event => changeDraft(row.id,{[key]:event.target.value})} {...attrs}/></label>;
      return <li key={row.id}>
        <div className="allocation-product"><ProductPhoto url={row.photo}/><span className="product-copy"><span className="product-heading"><strong>{row.article}</strong><PrintExtension value={row.extension}/></span>
          {row.name && <small className="product-name" title={row.name}>{row.name}</small>}
          <small>В рулонах {showAmount(row.rolls?.reduce((sum,roll) => sum + roll.quantity,0))} из {showAmount(row.plan)} шт.</small>
        </span></div>
        <div className="allocation-fields">
          {!shared && field('name','Название рулона',{required:true,maxLength:60,placeholder:'д17'})}
          {field('quantity','Штук на рулон',{type:'number',min:1,step:1,placeholder:row.plan})}
          {field('count','Рулонов',{type:'number',min:1,max:500,step:1,placeholder:'1'})}
        </div>
        {showError && <p className="error">{result.error}</p>}
      </li>;
    })}</ul>
    <div className="batch-dock">
      <strong>Артикулов: {rows.length} · Рулонов: {count} · {showAmount(pieces)} шт.</strong>
      <span className="quiet">Без количества берётся план артикула.</span>
      <button className="primary" disabled={blocked || !rows.length || valid.length !== rows.length || count > 500}
        type="submit">Создать рулоны{count ? ' · '+count : ''}</button>
    </div>
    {count > 500 && <p className="error" role="alert">За один раз можно создать до 500 рулонов.</p>}
  </form>;
}
