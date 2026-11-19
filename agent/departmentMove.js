import { createHash } from 'node:crypto';
const key = value => String(value || '').trim().toUpperCase().replace(/\(OZ\)$/u, '');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw Object.assign(new Error(message), {code:'production_move_conflict',status:409}); };

// The adapters must hold their production lease for the entire invocation.
// Ambiguous writes are verified by stable operation/position IDs, never replayed.
export async function runDepartmentMove(input, {store, source, destination, coordinator}) {
  if (!input || !/^[a-f0-9-]{36}$/i.test(input.operationId || '') || !input.shipmentId || !input.uid || !key(input.article) || !Number.isSafeInteger(input.quantity) || input.quantity <= 0)
    fail('Не подтверждены поставка, ID артикула или количество.');
  const fingerprint = hash(input);
  let op = await store.get(input.operationId);
  if (op && op.fingerprint !== fingerprint) fail('ID операции уже занят другим переносом.');
  if (op?.status === 'verified' || op?.status === 'cancelled') return op;
  if (!op) {
    const proof = await source.inspect(input);
    if (proof.uid !== input.uid || key(proof.article) !== key(input.article) || proof.quantity !== input.quantity || proof.department !== (input.sourceDepartment||'box')) fail('Исходная позиция изменилась.');
    if (!proof.workConfirmed || proof.hasWork) fail('Перенос доступен только при подтверждённом отсутствии работы.');
    if (await destination.exists(input)) fail('Артикул уже есть в рулонной части поставки.');
    op = {id:input.operationId,fingerprint,input:structuredClone(input),proof,status:'prepared',steps:{freeze:'pending',destination:'pending',source:'pending',publish:'pending'}};
    await store.put(op);
  }
  const steps = [
    ['freeze', () => coordinator.freeze(op), () => coordinator.isFrozen(op)],
    ['destination', () => destination.write(op), () => destination.verify(op)],
    ['source', () => source.remove(op), () => source.verifyRemoved(op)],
    ['publish', () => coordinator.publish(op), () => coordinator.verifyPublished(op)],
  ];
  for (const [name, write, verify] of steps) {
    if (op.steps[name] === 'verified') continue;
    if (op.steps[name] === 'writing' || op.steps[name] === 'uncertain') {
      let currentError = null;
      const confirmed = async () => {try{return await verify();}catch(error){currentError=error;return false;}};
      if (!await confirmed()) {
        const recover = name === 'freeze' ? coordinator.recoverFreeze : name === 'publish' ? coordinator.recoverPublish : name === 'source' ? source.recoverRemove : name === 'destination' ? destination.recoverAbsent : null;
        if (recover) { try { await recover(op, async () => { op.destinationAttemptAt = Date.now(); await store.put(op); }); } catch(error) { currentError=error; } }
        if (!await confirmed()) { op.status='uncertain'; op.failedStep=name; op.message=currentError?.message || op.message || 'Результат шага «'+({freeze:'блокировка исходной позиции',destination:'копирование в другой участок',source:'удаление исходной позиции',publish:'подтверждение переноса'}[name])+'» пока не подтверждён. Повторное копирование не выполнялось.'; await store.put(op); return op; }
      }
      op.steps[name]='verified'; delete op.message; delete op.failedStep; await store.put(op); continue;
    }
    // Recheck the source after freezing and before copying. This catches work
    // recorded while the user was viewing the confirmation dialog.
    if ((name === 'destination' || name === 'source') && !await source.verifyUnstarted(op)) {
      op.status = 'blocked'; op.message = 'По артикулу появилась работа; перенос остановлен для сверки.';
      await store.put(op); return op;
    }
    op.steps[name]='writing'; if (name === 'destination') op.destinationAttemptAt = Date.now(); await store.put(op);
    let writeAcknowledged = false;
    try {
      await write();
      writeAcknowledged = true;
      if (!await verify()) throw new Error('Результат записи не подтверждён.');
      op.steps[name]='verified'; delete op.message; delete op.failedStep; await store.put(op);
    } catch (error) {
      // Only retry a destination write when the service explicitly rejected it,
      // or a guard failed before any request was sent. A failed readback after
      // an acknowledged write must remain uncertain and must never be replayed.
      const definitelyNotWritten = name === 'destination' && !writeAcknowledged &&
        (error?.beforeExternalWrite === true || (error?.code === 'roll_supply_api_rejected' && error?.uncertain !== true));
      op.steps[name]=definitelyNotWritten?'pending':'uncertain'; op.status='uncertain'; op.failedStep=name;
      op.message=String(error.message || error); await store.put(op); return op;
    }
  }
  op.status='verified'; delete op.message; delete op.failedStep; await store.put(op); return op;
}
