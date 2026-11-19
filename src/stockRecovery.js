// Retry only the same idempotent operation. The server decides whether a
// previous write can be confirmed; the browser never invents a new request ID.
export async function runStockRequest(send, payload, {wait = ms => new Promise(resolve=>setTimeout(resolve,ms)), onRetry = () => {}, onResult = _result => {}, attempts = 3} = {}) {
  let lastError;
  for (let attempt=0; attempt<attempts; attempt++) {
    try {
      const result=await send(payload);
      onResult(result);
      if (result.notSaved || ['verified','not_saved'].includes(result.operation?.status)) return result;
      lastError=new Error(result.operation?.message || 'Результат ещё не подтверждён.');
    } catch (error) { lastError=error; }
    if (attempt+1<attempts) { onRetry(); await wait(1000 * (attempt+1)); }
  }
  throw lastError || new Error('Результат ещё не подтверждён.');
}
