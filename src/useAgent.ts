import { useCallback, useEffect, useRef, useState } from "react";
export function useAgentResource<T>(
  path: string,
  enabled = true,
  interval = 30000,
) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | null>(null);
  const valuePath = useRef("");
  const currentPath = useRef(path);
  currentPath.current = path;
  const reload = useCallback(async () => {
    if (!enabled) return;
    active.current?.abort();
    const ctrl = new AbortController();
    active.current = ctrl;
    if (valuePath.current !== path) setValue(null);
    setLoading(true);
    setError("");
    try {
      const response = await fetch(path, {
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(15000)]),
      });
      if (response.status === 401) {
        if (!ctrl.signal.aborted) {
          setLocked(true);
          setValue(null);
        }
        return;
      }
      const data = await response.json();
      if (!response.ok || !data.ok || typeof data !== "object")
        throw new Error("Agent response unavailable");
      if (!ctrl.signal.aborted && currentPath.current === path) {
        setValue(data);
        valuePath.current = path;
        setLocked(false);
      }
    } catch {
      if (!ctrl.signal.aborted && currentPath.current === path)
        setError(
          "Локальный агент недоступен или не настроен. Предыдущие результаты, если они есть, устарели.",
        );
    } finally {
      if (active.current === ctrl) {
        active.current = null;
        setLoading(false);
      }
    }
  }, [path, enabled]);
  useEffect(() => {
    if (!enabled) {
      active.current?.abort();
      return;
    }
    void reload();
    const timer = interval
      ? setInterval(() => {
          if (document.visibilityState === "visible") void reload();
        }, interval)
      : null;
    return () => {
      if (timer) clearInterval(timer);
      active.current?.abort();
    };
  }, [reload, interval, enabled]);
  return {
    value: valuePath.current === path ? value : null,
    error,
    locked,
    loading,
    reload,
  };
}
