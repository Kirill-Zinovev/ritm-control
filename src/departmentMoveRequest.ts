export type DepartmentMoveRequest = {
  operationId: string;
  shipmentId: string;
  uid: string;
  article: string;
  quantity: number;
  machine: string;
  extension: string;
  sourceDepartment?: 'box' | 'roll';
};

export type DepartmentMoveOperation = {
  id: string;
  status: 'prepared' | 'uncertain' | 'blocked' | 'verified' | 'cancelled';
  input?: DepartmentMoveRequest;
  message?: string | null;
  steps?: Record<string, string>;
};

type Reply = { ok: boolean; error?: string; message?: string; operation?: DepartmentMoveOperation | null };
type Progress = { message: string; operation?: DepartmentMoveOperation };
type Options = {
  fetcher?: typeof fetch;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  onProgress?: (progress: Progress) => void;
};
const endpoint = '/api/production-moves';
const terminal = (op: DepartmentMoveOperation) => ['verified', 'cancelled', 'blocked'].includes(op.status);

class MoveRequestError extends Error {
  readonly code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

async function reply(fetcher: typeof fetch, url: string, init?: RequestInit): Promise<Reply> {
  const response = await fetcher(url, init);
  const data: Reply = await response.json();
  if (!response.ok || data.ok !== true)
    throw new MoveRequestError(data.message || 'Не удалось проверить перенос.', data.error || 'move_request_failed');
  return data;
}

export async function restoreDepartmentMove(
  position: Pick<DepartmentMoveRequest, 'shipmentId' | 'uid' | 'article' | 'quantity'>,
  pendingId: string | null,
  fetcher: typeof fetch = fetch,
): Promise<DepartmentMoveOperation | null> {
  if (pendingId) {
    const previous = (await reply(fetcher, endpoint + '?id=' + encodeURIComponent(pendingId))).operation;
    // A different position is looked up independently on the server. The
    // server still serializes writes and protects any unresolved shipment.
    if (previous && !['verified', 'cancelled'].includes(previous.status)) {
      if (samePosition(previous, position)) return previous;
    }
    if (previous?.status === 'verified' && samePosition(previous, position)) return previous;
  }
  const query = new URLSearchParams({ ...position, quantity: String(position.quantity) });
  const found = (await reply(fetcher, endpoint + '?' + query)).operation;
  if (found && !samePosition(found, position)) throw new MoveRequestError('Параметры сохранённого переноса отличаются от выбранной позиции.', 'move_position_changed');
  return found || null;
}

function samePosition(op: DepartmentMoveOperation, position: Pick<DepartmentMoveRequest, 'shipmentId' | 'uid' | 'article' | 'quantity'>) {
  return op.input?.shipmentId === position.shipmentId && op.input.uid === position.uid &&
    op.input.article === position.article && op.input.quantity === position.quantity;
}

// All attempts use the original immutable operation ID. The server reconciles
// uncertain steps by receipt/readback and never replays an ambiguous copy.
export async function completeDepartmentMove(input: DepartmentMoveRequest, {
  fetcher = fetch, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 240_000, onProgress = () => {},
}: Options = {}): Promise<DepartmentMoveOperation> {
  const body = JSON.stringify(input), deadline = now() + timeoutMs;
  let checkResult = false, attempt = 0, recoveries = 0;
  let last: DepartmentMoveOperation | undefined;
  while (now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - now());
      const data = await reply(fetcher, checkResult ? endpoint + '?id=' + encodeURIComponent(input.operationId) : endpoint,
        checkResult
          ? { signal: AbortSignal.timeout(Math.min(15_000, remaining)) }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(Math.min(120_000, remaining)) });
      const op = data.operation;
      if (op) {
        if (op.id !== input.operationId) throw new MoveRequestError('Сервер вернул другой перенос. Повторная запись остановлена.', 'move_identity_changed');
        last = op;
        onProgress({ operation: op, message: terminal(op) ? op.message || '' : 'Проверяем результат переноса…' });
        if (terminal(op)) return op;
      }
      if (checkResult) {
        checkResult = false;
        // A missing record after a lost reply can be retried only with the same
        // ID and under the server lease, including when the first call runs on.
      } else {
        if (!op) { checkResult = true; }
        else if (++recoveries >= 3) return op;
        else checkResult = true;
      }
    } catch (error) {
      if (error instanceof MoveRequestError) {
        if (error.code !== 'cloud_operation_busy') throw error;
        onProgress({ message: 'Ожидаем завершения другой записи. Перенос продолжится автоматически…' });
      } else {
        // A missing response never means that the write failed. Read its
        // durable result before attempting any continuation.
        checkResult = true;
        onProgress({ message: 'Связь прервалась. Проверяем сохранённый результат автоматически…' });
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(1500 + attempt++ * 500, 5000, remaining));
  }
  if (last) return last;
  throw new MoveRequestError('Сервер пока занят. Запрос сохранён в этой вкладке; повторная сверка продолжит этот же перенос.', 'move_wait_timeout');
}
