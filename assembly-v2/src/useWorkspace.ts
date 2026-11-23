import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, Snapshot } from "../shared/model";
import type { RitmStatus } from "../shared/ritm";
import { useAccess } from "./Access";
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(22000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new Error(
      "Нет ответа от сервера. Введённые данные сохранены в форме. Повторите операцию.",
    );
  }
  if (response.status === 401)
    throw new Error(
      "Рабочая ссылка больше не действует. Откройте её повторно; данные формы останутся на экране.",
    );
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(
      data.error ?? "Не удалось выполнить запрос. Повторите попытку.",
    );
  return data;
}
export function useWorkspace(view = "all") {
  const role = useAccess();
  const operational = view !== "learning";
  const cartonScope =
    role === "collector" || view === "assembly" ? "supply" : ["catalog","setup","work"].includes(view) ? "directory" : "all";
  const pollInterval = role === "collector" || view === "assembly" ? 5000 : 30000;
  const directionsRef = useRef(view === "assembly");
  directionsRef.current = view === "assembly";
  const cartonScopeRef = useRef<"supply" | "all" | "directory">(cartonScope);
  cartonScopeRef.current = cartonScope;
  const [state, setState] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ritm, setRitm] = useState<RitmStatus | null>(null);
  const syncingRitm = useRef(false);
  const [supplyId, setSupplyId] = useState<string | null>(() => {
    const fromUrl = new URLSearchParams(location.search).get("supply");
    try {
      return fromUrl || localStorage.getItem("assembly.v2.lastSupply");
    } catch {
      return fromUrl;
    }
  });
  useEffect(() => {
    if (state?.selectedSupplyId)
      try {
        localStorage.setItem("assembly.v2.lastSupply", state.selectedSupplyId);
      } catch {}
  }, [state?.selectedSupplyId]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const supplyRef = useRef(supplyId);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const pendingCommand = useRef<{ signature: string; command: Command } | null>(
    null,
  );
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++generation.current;
    try {
      const data = await request<Snapshot>(
        `/api/state?directions=${directionsRef.current ? 1 : 0}&cartons=${cartonScopeRef.current}${supplyRef.current ? `&supply=${encodeURIComponent(supplyRef.current)}` : ""}`,
        { signal },
      );
      if (sequence !== generation.current) return;
      supplyRef.current = data.selectedSupplyId;
      setState(data);
      setError("");
    } catch (e) {
      if (
        !(e instanceof DOMException && e.name === "AbortError") &&
        sequence === generation.current
      )
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить данные.",
        );
    } finally {
      if (sequence === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!operational) return;
    const abort = new AbortController();
    setLoading(true);
    void refresh(abort.signal);
    return () => abort.abort();
  }, [operational, supplyId, cartonScope, refresh]);
  useEffect(() => {
    if (!operational) return;
    const abort = new AbortController();
    let checking = false;
    const check = async () => {
      if (checking || abort.signal.aborted || document.visibilityState !== "visible" || busyRef.current) return;
      checking = true;
      try {
        const data = await request<{ revision: number }>("/api/revision", {
          signal: abort.signal,
        });
        if (!busyRef.current && data.revision !== stateRef.current?.revision)
          await refresh(abort.signal);
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "Связь потеряна.");
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), pollInterval);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      clearInterval(timer);
      abort.abort();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [operational, refresh, pollInterval]);
  const command = useCallback(
    async (
      action: string,
      payload: Record<string, unknown>,
      message: string,
    ) => {
      if (busyRef.current)
        throw new Error("Дождитесь сохранения предыдущей записи.");
      if (stateRef.current?.selectedSupplyId !== supplyRef.current)
        throw new Error("Сначала дождитесь загрузки выбранной поставки.");
      busyRef.current = true;
      setBusy(true);
      setNotice("");
      setError("");
      generation.current++;
      const signature = JSON.stringify({ action, payload });
      if (pendingCommand.current?.signature !== signature)
        pendingCommand.current = {
          signature,
          command: {
            action,
            payload,
            key: crypto.randomUUID(),
            supplyId: supplyRef.current,
          },
        };
      try {
        pendingCommand.current.command.cartonScope = cartonScopeRef.current;
        pendingCommand.current.command.directions = directionsRef.current;
        const data = await request<{
          result: Record<string, unknown>;
          state: Snapshot | null;
        }>("/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pendingCommand.current.command),
        });
        pendingCommand.current = null;
        if (data.state) {
          setState(data.state);
          supplyRef.current = data.state.selectedSupplyId;
        }
        setNotice(message);
        if (typeof data.result.supplyId === "string") {
          supplyRef.current = data.result.supplyId;
          setSupplyId(data.result.supplyId);
        }
        if (!data.state) {
          setError("Запись сохранена. Не удалось обновить данные на экране.");
          void refresh();
        }
        return data.result;
      } catch (e) {
        const text = e instanceof Error ? e.message : "Не удалось сохранить.";
        setError(text);
        throw new Error(text);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [refresh],
  );
  const syncFromRitm = useCallback(
    async (force = false) => {
      if (syncingRitm.current || busyRef.current) return;
      syncingRitm.current = true;
      if (force)
        setRitm((previous) =>
          previous
            ? {
                ...previous,
                status: "syncing",
                message: "Получаем поставки из РИТМ…",
              }
            : null,
        );
      try {
        const value = await request<RitmStatus>("/api/ritm/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
          signal: AbortSignal.timeout(65000),
        });
        setRitm(value);
        if (value.configured) {
          const revision = await request<{ revision: number }>("/api/revision");
          if (
            !busyRef.current &&
            revision.revision !== stateRef.current?.revision
          )
            await refresh();
        }
      } catch {
        setRitm((previous) =>
          previous
            ? {
                ...previous,
                status: "waiting",
                message:
                  "Связь с РИТМ временно недоступна. Прежние поставки сохранены.",
              }
            : null,
        );
      } finally {
        syncingRitm.current = false;
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (!operational) return;
    let cancelled = false;
    void request<RitmStatus>("/api/ritm/status")
      .then((value) => {
        if (cancelled) return;
        setRitm(value);
        if (value.configured) void syncFromRitm();
      })
      .catch(() => {});
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void syncFromRitm();
    }, pollInterval);
    const visible = () => {
      if (document.visibilityState === "visible") void syncFromRitm();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [operational, syncFromRitm, pollInterval]);
  const selectSupply = (id: string) => {
    if (busyRef.current || id === supplyRef.current) return;
    setLoading(true);
    generation.current++;
    setNotice("");
    const url = new URL(location.href);
    url.searchParams.set("supply", id);
    history.replaceState(null, "", url);
    supplyRef.current = id;
    setSupplyId(id);
  };
  return {
    ritm,
    syncFromRitm,
    state,
    error,
    notice,
    busy,
    loading,
    selectionPending: state?.selectedSupplyId !== supplyRef.current,
    refresh,
    command,
    selectSupply,
    clearNotice: () => setNotice(""),
  };
}
export type Workspace = ReturnType<typeof useWorkspace>;
