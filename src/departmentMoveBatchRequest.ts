import type {DepartmentMoveRequest} from './departmentMoveRequest';

export type MoveBatchInput = {operationId:string; items:(DepartmentMoveRequest & {sourceDepartment:'box'|'roll'})[]};
export type MoveBatchResult = {id:string; article:string; quantity:number; status:'pending'|'verified'|'skipped'|'checking'|'cancelled'; message:string};
export type MoveBatch = {id:string; status:'running'|'checking'|'complete'; input:MoveBatchInput; results:MoveBatchResult[]; blocker?:{id:string;article:string;status:string;message?:string|null}|null};
const endpoint = '/api/production-moves/batch';
class BatchError extends Error {
  readonly code:string;
  constructor(message:string, code:string) {super(message); this.code=code;}
}
async function request(url:string, fetcher:typeof fetch, init?:RequestInit):Promise<MoveBatch|null> {
  const response = await fetcher(url,{...init,signal:AbortSignal.timeout(init?.method === 'POST' ? 120_000 : 20_000)});
  const data = await response.json();
  if (!response.ok || !data.ok) throw new BatchError(data.message || 'Не удалось проверить массовый перенос.',data.error || 'move_batch_request_failed');
  return data.batch || null;
}
export async function restoreMoveBatch(shipmentId:string, sourceDepartment:'box'|'roll', fetcher:typeof fetch = fetch) {
  return request(endpoint + '?' + new URLSearchParams({shipmentId,sourceDepartment}),fetcher);
}
export async function cancelMoveBatch(operationId:string, fetcher:typeof fetch = fetch) {
  const batch = await request(endpoint,fetcher,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'cancel',operationId})});
  if (!batch || batch.id !== operationId || batch.status !== 'complete') throw new Error('Отмена оставшихся позиций не подтверждена.');
  return batch;
}

// No polling between successful children and no supply reload per article.
// A lost response is reconciled by GET before the same immutable batch resumes.
export async function completeMoveBatch(input:MoveBatchInput, {
  fetcher = fetch, wait = (ms:number) => new Promise(resolve => setTimeout(resolve,ms)),
  onProgress = (_batch:MoveBatch) => {}, shouldPause = () => false,
}: {fetcher?:typeof fetch; wait?:(ms:number)=>Promise<unknown>; onProgress?:(batch:MoveBatch)=>void; shouldPause?:()=>boolean} = {}):Promise<MoveBatch> {
  const body = JSON.stringify(input);
  let last:MoveBatch|null = null, retries = 0, checks = 0, reconcile = false;
  for (let attempt = 0; attempt < input.items.length * 4 + 12; attempt++) {
    try {
      const value = await request(reconcile ? endpoint + '?id=' + encodeURIComponent(input.operationId) : endpoint,fetcher,
        reconcile ? undefined : {method:'POST',headers:{'content-type':'application/json'},body});
      if (value && (value.id !== input.operationId || JSON.stringify(value.input) !== body))
        throw new BatchError('Состав сохранённого переноса отличается. Повторная запись остановлена.','move_batch_identity_changed');
      const wasReconcile = reconcile; reconcile = false;
      if (value) {
        last = value; onProgress(value);
        if (value.status === 'complete' || shouldPause()) return value;
        if (value.status === 'checking' && !wasReconcile) {
          if (++checks >= 3) return value;
          await wait(1500);
        } else if (value.status !== 'checking') checks = 0;
      }
      retries = 0;
    } catch (error) {
      if (error instanceof BatchError && error.code !== 'cloud_operation_busy') throw error;
      // Lease contention has not entered the handler. Network errors may have
      // committed a child, so only those require durable-state reconciliation.
      if (!(error instanceof BatchError)) reconcile = true;
      if (++retries > 5) throw new Error('Связь с сервером не восстановилась. Список сохранён; нажмите «Продолжить перенос».');
      await wait(Math.min(1000 * retries,4000));
    }
  }
  if (last) return last;
  throw new Error('Не удалось подтвердить массовый перенос. Сохранённый запрос можно продолжить.');
}
