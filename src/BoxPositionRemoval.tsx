import { useEffect, useRef, useState } from "react";
import { num } from "./model";
import type { LiveOrder } from "./livePrinting";
import { Button, Modal } from "./ui";

type Position = Pick<LiveOrder, "sheetId" | "sheetName" | "uid" | "article" | "quantity">;
type RemovalRequest = {
  operationId: string;
  sheetId: number;
  name: string;
  uid: string;
  article: string;
  quantity: number;
  explicitWriteApproval: true;
};
const path = "/api/box-position-removal";
const pendingKey = "ritm:pending-box-position-removal";
export const boxPositionKey = (position: Pick<Position, "sheetId" | "uid" | "article" | "quantity">) =>
  JSON.stringify([position.sheetId, position.uid, position.article, position.quantity]);

export function useBoxPositionRemoval(onVerified: (key: string) => void) {
  const [target, setTarget] = useState<Position | null>(null);
  const [pending, setPending] = useState<RemovalRequest | null>(() => {
    try { return JSON.parse(sessionStorage.getItem(pendingKey) || "null"); }
    catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const running = useRef(false);
  const remember = (request: RemovalRequest | null) => {
    setPending(request);
    try {
      if (request) sessionStorage.setItem(pendingKey, JSON.stringify(request));
      else sessionStorage.removeItem(pendingKey);
    } catch { /* The request is also recorded by the server. */ }
  };
  useEffect(() => {
    if (pending) return;
    const controller = new AbortController();
    void fetch(path, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (data?.operation?.status === "checking")
          remember({ ...data.operation.identity, operationId: data.operation.id, explicitWriteApproval: true });
      }).catch(() => {});
    return () => controller.abort();
  }, []);
  // Reconcile persisted requests in every open session, including after a lost reply.
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    const check = async () => {
      if (running.current) return;
      try {
        const response = await fetch(`${path}?id=${encodeURIComponent(pending.operationId)}`, {
          credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15000),
        });
        if (!response.ok || stopped) return;
        const { operation } = await response.json();
        if (!stopped && (!operation || ["verified", "cancelled"].includes(operation.status))) {
          remember(null);
          if (operation?.status === "verified") {
            const key = boxPositionKey(pending);
            setTarget(current => current && boxPositionKey(current) === key ? null : current);
            onVerified(key);
          }
          if (operation?.status === "cancelled") setMessage(operation.message || "Удаление отменено при проверке.");
        }
      } catch { /* Retry on the next check. */ }
    };
    void check();
    const timer = window.setInterval(() => void check(), 4000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [pending?.operationId]);
  const open = (order: Position) => {
    setMessage("");
    setTarget(order);
  };
  const resume = () => {
    if (pending) open({ ...pending, sheetName: pending.name });
  };
  async function submit() {
    if (!target || running.current) return;
    const request = pending || {
      operationId: crypto.randomUUID(), sheetId: target.sheetId, name: target.sheetName,
      uid: target.uid, article: target.article, quantity: target.quantity, explicitWriteApproval: true as const,
    };
    if (boxPositionKey(request) !== boxPositionKey(target)) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    remember(request);
    let rejected = false;
    try {
      const response = await fetch(path, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify(request), signal: AbortSignal.timeout(240000),
      });
      const data = await response.json();
      rejected = [400, 403, 404, 409].includes(response.status);
      if (!response.ok) throw new Error(data.message || "Не удалось выполнить запрос.");
      if (data.operation?.status === "verified") {
        remember(null);
        setTarget(null);
        onVerified(boxPositionKey(request));
      } else if (data.operation?.status === "cancelled") {
        remember(null);
        setMessage(data.operation.message || "Позиция не удалена.");
      } else {
        setMessage(data.operation?.message || "Удаление требует проверки. Повторите проверку этого запроса.");
      }
    } catch (error) {
      try {
        const status = await fetch(`${path}?id=${encodeURIComponent(request.operationId)}`, {
          credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(8000),
        });
        if (status.ok) {
          const { operation } = await status.json();
          if (operation?.status === "verified") {
            remember(null);
            setTarget(null);
            onVerified(boxPositionKey(request));
            return;
          }
          // A hard validation failure is safe to retry as a fresh attempt.
          if (operation?.status === "cancelled" || (!operation && rejected)) remember(null);
        }
      } catch { /* Keep the original request ID. */ }
      setMessage(error instanceof Error ? error.message : "Результат удаления требует проверки.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return {
    open, resume, pending, busy, backgroundMessage: target ? "" : message,
    dialog: <Modal open={!!target} title="Удалить артикул из поставки?"
      description={target ? `${target.article} · ${num(target.quantity)} шт. · ${target.sheetName}` : undefined}
      onClose={() => setTarget(null)}>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <p className="supply-delete-warning">Позиция исчезнет из таблицы бокса и из активных заданий «RITM Сборка». Перед удалением проверим работу по артикулу.</p>
        {busy && <p role="status">Проверяем работу и подтверждаем изменение в таблице…</p>}
        {message && <p role="alert" className="supply-operation-error">{message}</p>}
        <div className="modal-actions">
          <Button type="button" onClick={() => setTarget(null)}>{pending ? "Закрыть" : "Отмена"}</Button>
          <Button kind="danger" type="submit" disabled={busy}>
            {busy ? "Проверяем…" : pending ? "Проверить удаление" : "Удалить артикул"}
          </Button>
        </div>
      </form>
    </Modal>,
  };
}
