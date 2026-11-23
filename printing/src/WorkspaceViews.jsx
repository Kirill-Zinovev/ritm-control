import React, { useEffect, useState } from 'react';
import { ProductPhoto, showAmount } from './BatchWork.jsx';
import { Meter } from './InlineWork.jsx';
import { localTotal, matchesRoll, normalize, rollTitle, workRemaining } from './printing-workflow.mjs';
import { rollCutAvailable } from './shipment-progress.mjs';

const layouts = {available:'Есть макет', missing:'Нет макета', unknown:'Не проверено'};

export function JobFilters({groups, rows, filters, onToggle, onReset}) {
  const count = Object.values(filters).reduce((total, values) => total + values.length, 0);
  return <details className="filter-menu">
    <summary className="outline">Фильтры{count ? ' · '+count : ''}</summary>
    <div className="filter-options">
      {groups.map(([key,label,value]) => <fieldset key={key}>
        <legend>{label}</legend>
        {[...new Set(rows.map(value))].sort((a,b) => a.localeCompare(b,'ru')).map(option => <label key={option}>
          <input type="checkbox" checked={filters[key]?.includes(option) || false} onChange={() => onToggle(key,option)}/>{option}
        </label>)}
      </fieldset>)}
      {count > 0 && <button className="link" type="button" onClick={onReset}>Сбросить фильтры</button>}
    </div>
  </details>;
}

export function ShipmentPicker({supplies, current, loading, stale, busy, onPick}) {
  const currentTab = current?.status === 'completed' ? 'completed' : 'open';
  const [status, setStatus] = useState(currentTab);
  const [query, setQuery] = useState('');
  useEffect(() => { setStatus(currentTab); }, [current?.id,currentTab]);
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const matches = supply => words.every(word => normalize(supply.name).includes(word));
  const open = supplies.filter(item => item.status === 'open');
  const completed = supplies.filter(item => item.status === 'completed');
  const visible = (status === 'open' ? open : completed).filter(matches);
  const unconfirmed = status === 'open' ? supplies.filter(item => item.status === 'unknown' && matches(item)) : [];

  function item(supply) {
    const selected = supply.id === current?.id;
    const progress = supply.progress;
    const complete = progress?.total > 0 && progress.printed === progress.total && progress.cut === progress.total;
    const incompleteData = progress?.total > 0 && (progress.printKnown < progress.total ||
      progress.cutKnown < progress.total || progress.cutAvailabilityUnknown > 0);
    return <li key={supply.id}>
      <button className="shipment-row" type="button" aria-current={selected ? 'true' : undefined} disabled={busy}
        onClick={() => onPick(supply)}>
        <span className="shipment-name">{supply.name}</span>
        <span className="shipment-caret" aria-hidden="true"/>
        <span className="shipment-count">{showAmount(supply.count)} поз.</span>
        <ShipmentMeter label="Печать" total={supply.count} done={progress?.printed} known={progress?.printKnown}/>
        <ShipmentMeter label="Порезка" total={supply.count} done={progress?.cut} known={progress?.cutKnown}/>
        <span className="shipment-remaining">
          {complete ? <strong className="shipment-done">Всё готово</strong> : <>
            {progress?.canCut > 0 && <strong>Можно порезать {showAmount(progress.canCut)} поз.</strong>}
            {progress?.toPrint > 0 && <span>К печати {showAmount(progress.toPrint)} поз.</span>}
            {(!progress || incompleteData) && <small>Данные неполные</small>}
            {progress && !progress.total && <small>Нет позиций</small>}
          </>}
        </span>
      </button>
    </li>;
  }

  return <section aria-labelledby="shipment-title">
    <div className="shipment-toolbar">
      <h2 id="shipment-title">Поставки</h2>
      <input className="shipment-search" type="search" aria-label="Найти поставку" placeholder="Найти поставку"
        value={query} onChange={event => setQuery(event.target.value)}/>
      <div className="segments shipment-tabs" aria-label="Статус поставки">
        <button type="button" aria-pressed={status === 'open'} onClick={() => setStatus('open')}>Открытые <strong>{open.length}</strong></button>
        <button type="button" aria-pressed={status === 'completed'} onClick={() => setStatus('completed')}>Завершённые <strong>{completed.length}</strong></button>
      </div>
      {(loading || stale) && <small className="shipment-loading" role="status">
        {loading ? 'Обновляем прогресс…' : 'Показан предыдущий снимок РИТМ'}
      </small>}
    </div>
    {(visible.length > 0 || unconfirmed.length > 0) ? <>
      <ul className="shipment-list">{visible.map(item)}</ul>
      {unconfirmed.length > 0 && <section aria-label="Поставки без подтверждённого статуса">
        <h2 className="shipment-unknown">Статус не подтверждён</h2>
        <ul className="shipment-list">{unconfirmed.map(item)}</ul>
      </section>}
    </> : <p className="notice" role="status">{words.length ? 'Поставки не найдены.' : 'В этом списке пока нет поставок.'}</p>}
  </section>;
}

function ShipmentMeter({label,total,done,known}) {
  return <span className="shipment-meter" data-operation={label === 'Печать' ? 'print' : 'cut'}>
    <span className="shipment-meter-label">{label}</span>
    {known > 0 ? <>
      <span className="shipment-ratio">
        {known < total && <span title="Часть данных не подтверждена">≥ </span>}{showAmount(done)} / {showAmount(total)}
      </span>
      <progress aria-label={label} value={done} max={total}/>
    </> : <span className="shipment-ratio" aria-label={label+': нет данных'}>—</span>}
  </span>;
}

function RemainingQuantity({label, amount}) {
  return <small className="remaining-quantity" data-actionable={amount > 0}>
    <span>{label}</span>
    <strong title={amount == null ? 'Остаток не подтверждён' : undefined}>
      {showAmount(amount)}{amount != null && ' шт.'}
    </strong>
  </small>;
}

export function OtherShipmentMatches({result, busy, onOpen}) {
  return <section className="article-search-results" aria-labelledby="other-supplies-title">
    <h2 className="search-section-title" id="other-supplies-title">В других поставках</h2>
    {!result ? <p className="quiet" role="status">Ищем артикулы…</p> : result.error ?
      <p className="error" role="alert">{result.error}</p> : !result.total ?
      <p className="quiet" role="status">Совпадений нет.</p> : <>
        <ul className="article-matches">
          {result.hits.map(hit => <li key={JSON.stringify([hit.supplyId,hit.rowId])}>
            <button className="article-match" type="button" disabled={busy} onClick={() => onOpen(hit)}>
              <span className="match-product"><strong>{hit.article}</strong><small>{hit.supplyName}</small></span>
              <span>
                <small className="quiet" aria-hidden="true">Печать</small>
                <Meter label="Печать" value={hit.printed} plan={hit.plan}/>
                <RemainingQuantity label="К печати" amount={workRemaining('print',hit.plan,hit.printed)}/>
              </span>
              <span>
                <small className="quiet" aria-hidden="true">Порезка</small>
                <Meter cut label="Порезка" value={hit.cut} plan={hit.plan}/>
                <RemainingQuantity label="Можно порезать" amount={hit.cutAvailable}/>
              </span>
            </button>
          </li>)}
        </ul>
        {result.hits.length < result.total && <p className="quiet">Показано {result.hits.length} из {result.total}. Уточните поиск.</p>}
      </>}
  </section>;
}

export function JobQueue({rows, showChecks, selectionDisabled, chosen, eligible, activeId, onOpen, onChoose, recordsForRow, rollQuery, rollOperation, rollChoices, boxChoices, showTake, isBox, showRemaining, emptyMessage = 'По выбранным условиям нет артикулов.'}) {
  const columns = showChecks ? 5 : 4;
  return <table className="job-table" data-selectable={showChecks}>
    <colgroup>{showChecks && <col className="job-check"/>}<col/><col className="job-machine"/>
      <col className="job-meter"/><col className="job-meter"/></colgroup>
    <thead><tr>{showChecks && <th scope="col"><span className="sr-only">Выбор</span></th>}
      <th scope="col">Изделие</th><th scope="col" className="machine-cell">Станок</th>
      <th scope="col" className="meter-cell">Печать</th><th scope="col" className="meter-cell">Порезка</th>
    </tr></thead>
    <tbody>
      {rows.map(row => {
        const active = activeId === row.id;
        const records = recordsForRow(row.id);
        const fact = (value,operation) => value == null ? null : value +
          records.reduce((sum,entry) => entry.operation === operation ? sum + entry.pieces : sum,0);
        const printed = fact(row.printed,'print');
        const cut = fact(row.cut,'cut');
        const taken = isBox ? fact(row.taken,'take') : null;
        const ready = row.plan > 0 && printed >= row.plan && cut >= row.plan;
        const fullyTaken = row.machine && Number.isSafeInteger(row.plan) && row.plan > 0 && taken >= row.plan - 1e-8;
        const found = rollQuery.trim() ? row.rolls?.filter(roll => matchesRoll(roll,rollQuery)) : null;
        const rollAssigned = !isBox && row.plan > 0 && row.rolls?.length > 0 &&
          row.rolls.reduce((total,roll) => total + roll.quantity,0) >= row.plan;
        const needsRoll = rollOperation === 'print' && rollChoices?.get(row.id)?.needsAssignment;
        const blockReason = isBox ? boxChoices?.get(row.id)?.error :
          ready ? 'Печать и порезка завершены.' :
          !Array.isArray(row.rolls) ? 'Список рулонов недоступен.' :
          !eligible.has(row.id) ? (rollOperation ? 'Артикул недоступен для выбранной операции.' :
            'Откройте артикул, чтобы проверить остаток по рулонам.') : undefined;
        return <tr key={row.id} className={active ? 'selected' : undefined}>
          {showChecks && <td className="check-cell" title={blockReason || undefined}><input type="checkbox" aria-label={'Выбрать '+row.article}
            checked={chosen.has(row.id) && eligible.has(row.id)} disabled={selectionDisabled || !eligible.has(row.id)} onChange={() => onChoose(row.id)}/></td>}
          <td className="product-cell"><button className="product" type="button" aria-current={active ? 'true' : undefined}
            aria-controls="article-details" aria-expanded={active} onClick={() => onOpen(row.id)}>
            <ProductPhoto key={row.photo} url={row.photo}/>
            <span className="product-copy">
              <span className="product-heading">
                <strong>{row.article}</strong>
                {ready ? <small className="job-state done">Готово</small> :
                  needsRoll ? <small className="quiet">Нужно назначить рулон</small> : rollAssigned ?
                  <small className="quiet">Рулоны назначены</small> : taken > 0 &&
                  <small className="job-state">В работе · {showAmount(taken)} / {showAmount(row.plan)}</small>}
              </span>
              {row.name && <small className="product-name" title={row.name}>{row.name}</small>}
              {showTake && blockReason && !fullyTaken && <small className="quiet">{blockReason}</small>}
              {found?.length > 0 && <small className="roll-match">Рулоны: {found.map(rollTitle).join(', ')}</small>}
            </span>
          </button></td>
          <td className="machine-cell">{row.machine || '—'}</td>
          <td className="meter-cell">
            <Meter label="Печать" value={printed} plan={row.plan}/>
            {showRemaining && <RemainingQuantity label="К печати" amount={workRemaining('print',row.plan,printed)}/>}
          </td>
          <td className="meter-cell">
            <Meter cut label="Порезка" value={cut} plan={row.plan}/>
            {showRemaining && <RemainingQuantity label="Можно порезать" amount={isBox
              ? workRemaining('cut',row.plan,printed,cut)
              : rollCutAvailable(row.rolls,printed,cut)}/>}
          </td>
        </tr>;
      })}
      {!rows.length && <tr><td colSpan={columns} className="notice">{emptyMessage}</td></tr>}
    </tbody>
  </table>;
}

export function ArticleSummary({row, records, isRoll}) {
  const specs = [row.machine,row.material,row.extension].filter(Boolean);
  return <>
    <div className="article-summary">
      <ProductPhoto key={row.photo} url={row.photo} loading="eager"/>
      <div className="article-copy">
        <h2>{row.article}</h2>
        {row.name && <p className="article-name">{row.name}</p>}
        <div className="article-specs">
          {specs.length > 0 && <strong>{specs.join(' · ')}</strong>}
          {row.layoutUrl ? <a className="layout available" href={row.layoutUrl} target="_blank" rel="noreferrer">Открыть макет</a> :
            <span className={'layout '+row.layout}>{layouts[row.layout] || layouts.unknown}</span>}
          <span>План <strong>{showAmount(row.plan)} шт.</strong></span>
        </div>
      </div>
    </div>
    {!isRoll && <div className="box-facts">
      <div><span>В работе</span><Meter label="В работе" value={row.taken == null ? null : row.taken + localTotal(records,'take')} plan={row.plan}/></div>
      <div><span>Печать</span><Meter label="Печать" value={row.printed == null ? null : row.printed + localTotal(records,'print')} plan={row.plan}/></div>
      <div><span>Порезка</span><Meter cut label="Порезка" value={row.cut == null ? null : row.cut + localTotal(records,'cut')} plan={row.plan}/></div>
    </div>}
  </>;
}
