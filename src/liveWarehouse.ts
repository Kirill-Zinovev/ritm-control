import { useCallback, useEffect, useRef, useState } from "react";

export type CartonItem = { article: string; positionId: string; quantity: number; store: string; storeStatus: string; productName: string; photoUrl: string };
export type CartonHistory = { action: "add" | "remove" | "close"; article: string; quantity: number | null; createdAt: string; reason: string; employee: string | null };
export type WarehouseCarton = { id: string; number: string; shipmentId: string; shipment: string; directionId: string; market: string; store: string; boxType: string; status: "open" | "closed" | "unknown"; createdAt: string; closedAt: string; quantity: number; fillPercent: number | null; ready: boolean; issues: string[]; contents: CartonItem[]; history: CartonHistory[] };
export type WarehouseSnapshot = { ok: true; schemaVersion: 1; checkedAt: string; snapshotAt?: string; stale: boolean; staleReason?: string; cartons: WarehouseCarton[]; cancelledCount: number; issues: string[]; catalogAvailable: boolean };

function validSnapshot(value: WarehouseSnapshot) {
  return value?.ok === true && value.schemaVersion === 1 && Number.isFinite(Date.parse(value.checkedAt)) && Array.isArray(value.cartons) && Array.isArray(value.issues) && value.cartons.every((carton) =>
    typeof carton.id === "string" && typeof carton.number === "string" && typeof carton.shipment === "string" && ["open", "closed", "unknown"].includes(carton.status) && Number.isSafeInteger(carton.quantity) && carton.quantity >= 0 && (carton.fillPercent === null || (Number.isFinite(carton.fillPercent) && carton.fillPercent >= 0)) && typeof carton.ready === "boolean" && Array.isArray(carton.issues) && Array.isArray(carton.contents) && Array.isArray(carton.history) && carton.contents.every((item) => typeof item.article === "string" && Number.isSafeInteger(item.quantity) && item.quantity > 0),
  );
}

export function useLiveWarehouse(enabled: boolean) {
  const [value, setValue] = useState<WarehouseSnapshot | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null), sequence = useRef(0);
  const reload = useCallback(async (force = false) => {
    const request = ++sequence.current;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 45000);
    setLoading(true); setError("");
    try {
      const response = await fetch(force ? "/api/warehouse?refresh=1" : "/api/warehouse", { cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (!response.ok || !validSnapshot(body)) throw new Error(body?.message || "Не удалось подтвердить данные коробов.");
      if (request === sequence.current) setValue(body);
    } catch (reason) {
      if (request !== sequence.current) return;
      const message = controller.signal.aborted ? "Обновление коробов заняло слишком много времени." : reason instanceof Error && reason.message !== "Failed to fetch" ? reason.message : "Не удалось подключиться к источнику коробов. Проверьте подключение и повторите обновление.";
      setError(message);
      setValue((previous) => previous ? { ...previous, stale: true, staleReason: "Показаны предыдущие данные. Повторите обновление перед отправкой." } : null);
    } finally {
      window.clearTimeout(timeout);
      if (request === sequence.current) { active.current = null; setLoading(false); }
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void reload();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void reload(); }, 300000);
    const onVisible = () => { if (document.visibilityState === "visible") void reload(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { sequence.current++; active.current?.abort(); active.current = null; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled, reload]);
  return { value, loading, error, reload };
}
