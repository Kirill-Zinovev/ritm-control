import React, { useState } from 'react';
import { printEmployee, rollTitle } from './printing-workflow.mjs';

const asText = value => value == null ? '' : String(value);

export function PrintingCorrection({row, roll, isRoll, blocked, onSave}) {
  const currentRoll = roll && !roll.legacyOnly ? roll : null;
  const base = isRoll ? currentRoll : row;
  const [draft, setDraft] = useState(() => ({
    name:currentRoll?.name || '',
    quantity:asText(currentRoll?.quantity),
    printed:asText(base?.printed),
    cut:asText(base?.cut),
  }));
  const [reset, setReset] = useState('');
  const [error, setError] = useState('');
  const activeRolls = row.rolls?.filter(value => !value.legacyOnly) ?? [];
  const hasPrint = row.printed > 0 || activeRolls.some(value => value.printed > 0);
  const hasCut = row.cut > 0 || activeRolls.some(value => value.cut > 0);
  const patch = {};
  if (base) {
    for (const key of isRoll ? ['printed'] : ['printed','cut']) {
      if (draft[key] !== '' && Number(draft[key]) !== base[key]) patch[key] = Number(draft[key]);
    }
  }
  if (currentRoll) {
    if (draft.name.trim() !== currentRoll.name) patch.name = draft.name.trim();
    if (draft.quantity !== '' && Number(draft.quantity) !== currentRoll.quantity) patch.quantity = Number(draft.quantity);
  }
  const waitingToCancel = reset || (patch.printed === 0 && base?.printed > 0 && (isRoll || draft.cut === '0')
    ? 'print' : patch.cut === 0 && base?.cut > 0 ? 'cut' : '');
  const canSave = !blocked && (reset || Object.keys(patch).length > 0);

  function change(key, value) {
    setDraft(values => ({...values,[key]:value}));
    setError('');
  }

  function cancelProgress(operation) {
    setDraft(values => ({...values,...(operation === 'print' ? {printed:'0',...(!isRoll && {cut:'0'})} : {cut:'0'})}));
    setError('');
  }

  function cancelArticle(operation) {
    setReset(operation);
    setError('');
  }

  async function submit(event) {
    event.preventDefault();
    if (!canSave) return;
    if (!reset && patch.name !== undefined && !printEmployee(patch.name)) {
      setError('Название рулона должно начинаться с д, а или п.');
      return;
    }
    const target = {rowId:row.id,revision:row.workRevision};
    const edit = reset ? {reset} : {...patch,...(currentRoll ? {rollId:currentRoll.id} : {})};
    try {
      await onSave({...target,...edit});
    } catch (failure) {
      setError(failure.message || 'Не удалось сохранить исправление.');
    }
  }

  return <form className="work-form correction-form" onSubmit={submit} aria-label={isRoll ? 'Исправления печати' : 'Исправления печати и порезки'}>
    <h3>{currentRoll ? 'Рулон '+rollTitle(currentRoll) : 'Исправления по артикулу'}</h3>
    {base && !reset && <fieldset className="correction-edit" disabled={blocked}>
      {currentRoll && <div className="work-fields">
          <label>Название рулона<input required maxLength={60} value={draft.name} onChange={event => change('name',event.target.value)}/></label>
          <label>Количество на рулоне, шт.<input required type="number" min="1" step="1" value={draft.quantity}
            onChange={event => change('quantity',event.target.value)}/></label>
      </div>}
      <div className="work-fields">
        <label>Напечатано, шт.<input type="number" min={isRoll ? base.cut ?? 0 : 0} step={isRoll ? '1' : 'any'} required={base.printed != null}
          placeholder="Нет данных" value={draft.printed} onChange={event => change('printed',event.target.value)}/></label>
        {!isRoll && <label>Порезано, шт.<input type="number" min="0" step="any" required={base.cut != null}
          placeholder="Нет данных" value={draft.cut} onChange={event => change('cut',event.target.value)}/></label>}
      </div>
      <div className="correction-actions">
        <button className="outline" type="button" disabled={!(Number(draft.printed) > 0) || (isRoll && base.cut > 0)}
          onClick={() => cancelProgress('print')}>Отменить печать</button>
        {!isRoll && <button className="outline" type="button" disabled={!(Number(draft.cut) > 0)}
          onClick={() => cancelProgress('cut')}>Отменить порезку</button>}
      </div>
    </fieldset>}
    {isRoll && <details className="correction-scope">
      <summary>По всему артикулу</summary>
      <div className="correction-actions">
        <button className="outline" type="button" disabled={blocked || !hasPrint || hasCut}
          onClick={() => cancelArticle('print')}>Отменить печать по артикулу</button>
      </div>
    </details>}
    {waitingToCancel && <p className="notice" role="status">
      {isRoll ? 'После сохранения печать будет обнулена' : waitingToCancel === 'print' ?
        'После сохранения печать и порезка будут обнулены' : 'После сохранения порезка будет обнулена'}
      {reset ? ' по артикулу и его назначенным рулонам.' : currentRoll ? ' на выбранном рулоне.' : ' по этому артикулу.'}
      {reset && <> <button className="link" type="button" disabled={blocked} onClick={() => cancelArticle('')}>Снять отмену</button></>}
    </p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <button className="primary work-submit" type="submit" disabled={!canSave}>Сохранить исправление</button>
  </form>;
}
