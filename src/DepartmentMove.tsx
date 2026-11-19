import {useRef, useState} from 'react';
import {Button, Field, Modal} from './ui';
import {departmentMoveAvailability} from './departmentMoveAvailability';
import {completeDepartmentMove, restoreDepartmentMove, type DepartmentMoveOperation, type DepartmentMoveRequest} from './departmentMoveRequest';

const pendingKey = 'ritm:pending-department-move';
type Props = {
  shipmentId: string; uid: string; article: string; quantity: number;
  disabled: boolean; disabledReason?: string; printed?: number | null; cut?: number | null;
  sourceDepartment?: 'box' | 'roll'; onDone: (moves: DepartmentMoveRequest[]) => Promise<void>;
};

export function DepartmentMove({shipmentId, uid, article, quantity, disabled, onDone, disabledReason, printed, cut, sourceDepartment = 'box'}: Props) {
  const unavailable = departmentMoveAvailability({shipmentId, disabled, disabledReason, printed, cut});
  const target = sourceDepartment === 'box' ? 'рулонную печать' : 'бокс';
  const machines = sourceDepartment === 'box' ? ['2-GO', 'УФ', 'УФ БЕЛ.', 'УФ ДВУСТОРОННИЙ'] : ['XEROX', 'УФ планшет', 'DTF'];
  const [open, setOpen] = useState(false), [machine, setMachine] = useState(machines[0]), [extension, setExtension] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [done, setDone] = useState(false);
  const [request, setRequest] = useState<DepartmentMoveRequest | null>(null);
  const [operation, setOperation] = useState<DepartmentMoveOperation | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);
  // React state updates are asynchronous: a second click must not start a new ID.
  const active = useRef(false);

  async function completed(move: DepartmentMoveRequest) {
    setDone(true);
    sessionStorage.removeItem(pendingKey);
    setMessage('Артикул перенесён в ' + target + '.');
    // The physical move is confirmed. Updating the aggregate report must not
    // keep the completed dialog locked; it cannot submit again while done.
    active.current = false; setBusy(false);
    try { await onDone([move]); }
    catch { setMessage('Артикул перенесён в ' + target + '. Список обновится при следующем обновлении страницы.'); }
  }

  async function submit() {
    if (active.current || done || unavailable) return;
    active.current = true;
    const payload = request || {operationId: crypto.randomUUID(), shipmentId, uid, article, quantity, machine, sourceDepartment, extension: extension.trim()};
    setRequest(payload); setBusy(true); setMessage('Проверяем исходную позицию и выполняем перенос…');
    try {
      sessionStorage.setItem(pendingKey, payload.operationId);
      const result = await completeDepartmentMove(payload, {onProgress: progress => {
        setMessage(progress.message);
        if (progress.operation) setOperation(progress.operation);
      }});
      setOperation(result);
      if (result.status === 'verified') await completed(payload);
      else if (result.status === 'cancelled') {
        sessionStorage.removeItem(pendingKey); setRequest(null);
        setMessage('Перенос отменён. Исходная позиция сохранена.');
      } else setMessage(result.message || 'Сверка пока не завершена. Продолжение использует тот же запрос без повторного копирования.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось проверить результат переноса.'); }
    finally { active.current = false; setBusy(false); }
  }

  async function cancel() {
    if (!request || active.current) return;
    active.current = true; setBusy(true);
    try {
      const response = await fetch('/api/production-moves', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'cancel', operationId: request.operationId})});
      const data = await response.json();
      if (!response.ok || data.operation?.status !== 'cancelled') throw Error(data.message || 'Отмена не подтверждена.');
      sessionStorage.removeItem(pendingKey); setRequest(null); setOperation(null);
      setMessage('Перенос отменён. Исходная позиция сохранена.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось подтвердить отмену.'); }
    finally { active.current = false; setBusy(false); }
  }

  async function launch() {
    if (active.current) return;
    active.current = true;
    setOpen(true); setMessage('Проверяем сохранённый перенос…'); setLookupFailed(false); setBusy(true);
    try {
      const found = await restoreDepartmentMove({shipmentId, uid, article, quantity}, sessionStorage.getItem(pendingKey));
      setOperation(found); setDone(found?.status === 'verified');
      if (!found) { sessionStorage.removeItem(pendingKey); setRequest(null); setMessage(''); return; }
      if (!found.input) throw Error('Не удалось восстановить параметры переноса.');
      setRequest(found.input); setMachine(found.input.machine); setExtension(found.input.extension);
      if (found.status === 'verified') await completed(found.input);
      else { sessionStorage.setItem(pendingKey, found.id); setMessage(found.message || 'Продолжим сохранённый перенос без повторного добавления.'); }
    } catch (error) { setLookupFailed(true); setMessage(error instanceof Error ? error.message : 'Не удалось восстановить перенос.'); }
    finally { active.current = false; setBusy(false); }
  }

  return <>
    <span className="department-move-control" title={unavailable?.reason}>
      <Button className="department-move-button" disabled={!!unavailable} onClick={() => void launch()}>Перенести в {target}</Button>
      {unavailable && <small className="department-move-reason">{unavailable.label}</small>}
    </span>
    <Modal open={open} onClose={() => {if (!busy) setOpen(false);}} title={'Перенести в ' + target} description="Перенос доступен, только если работа на исходном участке ещё не начата.">
      <p><strong>{article}</strong> · {quantity} шт.</p>
      <Field label="Станок"><select value={machine} disabled={busy || !!request} onChange={event => setMachine(event.target.value)}>{machines.map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Расширение печати"><input value={extension} disabled={busy || !!request} onChange={event => setExtension(event.target.value)} maxLength={40}/></Field>
      {message && <p role="status" aria-live="polite" aria-busy={busy}>{message}</p>}
      <div className="modal-actions">
        {request && !done && operation?.steps?.destination === 'pending' && <Button disabled={busy} onClick={() => void cancel()}>Отменить перенос</Button>}
        <Button disabled={busy} onClick={() => setOpen(false)}>{done ? 'Закрыть' : 'Отмена'}</Button>
        {!done && <Button kind="primary" disabled={busy || (!lookupFailed && !extension.trim())} onClick={() => void (lookupFailed ? launch() : submit())}>{busy ? request ? 'Переносим…' : 'Проверяем…' : lookupFailed ? 'Повторить проверку' : request ? 'Продолжить перенос' : 'Перенести'}</Button>}
      </div>
    </Modal>
  </>;
}
