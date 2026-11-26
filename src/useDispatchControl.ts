import { useEffect, useMemo, useState } from "react";
import { ASSEMBLY_URL } from "./liveAssembly";
import type { LivePrinting } from "./livePrinting";
import {
  buildDispatchPositions,
  buildDispatchRows,
  dispatchSupplyIds,
  type DispatchFact,
  type DispatchReport,
} from "./dispatchControlData";

const PAGE_LIMIT = 100;
const AUTO_REFRESH_MS = 60_000;

async function fetchDispatchFacts(ids: string[], signal: AbortSignal) {
  const rows: DispatchFact[] = [];
  let checkedAt = "";
  let revision: number | undefined;
  let stale = false;
  for (let offset = 0; offset < ids.length; offset += PAGE_LIMIT) {
    const response = await fetch("/api/production-dispatch", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supplyIds: ids.slice(offset, offset + PAGE_LIMIT),
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(14_000)]),
    });
    const body = (await response.json()) as
      | DispatchReport
      | { ok: false; message?: string };
    if (
      !response.ok ||
      !body.ok ||
      body.schemaVersion !== 1 ||
      !Array.isArray(body.rows)
    ) {
      throw Error(
        (!body.ok && body.message) || "Не удалось прочитать историю отгрузок.",
      );
    }
    if (revision !== undefined && revision !== body.revision) {
      throw Error(
        "История отгрузок обновилась во время загрузки. Повторите сверку.",
      );
    }
    revision = body.revision;
    if (!checkedAt || body.checkedAt < checkedAt) checkedAt = body.checkedAt;
    stale ||= body.stale;
    rows.push(...body.rows);
  }
  return { rows, checkedAt, stale };
}

export function useDispatchControl(live: LivePrinting | null) {
  const positions = useMemo(() => buildDispatchPositions(live), [live]);
  const ids = JSON.stringify(dispatchSupplyIds(positions));
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<{
    ids: string;
    facts: DispatchFact[];
    updatedAt: string | null;
    stale: boolean;
    error: string;
    loading: boolean;
  }>({
    ids: "",
    facts: [],
    updatedAt: null,
    stale: false,
    error: "",
    loading: false,
  });
  useEffect(() => {
    const supplyIds = JSON.parse(ids) as string[];
    if (!supplyIds.length) return;
    const controller = new AbortController();
    const load = () => {
      setState((previous) => ({
        ids,
        facts: previous.ids === ids ? previous.facts : [],
        updatedAt: previous.ids === ids ? previous.updatedAt : null,
        stale: previous.ids === ids && previous.stale,
        error: "",
        loading: true,
      }));
      void fetchDispatchFacts(supplyIds, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setState({
            ids,
            facts: result.rows,
            updatedAt: result.checkedAt,
            stale: result.stale,
            error: "",
            loading: false,
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState((previous) => ({
            ...previous,
            loading: false,
            stale: previous.updatedAt !== null,
            error:
              error instanceof Error && error.name === "Error"
                ? error.message
                : "Не удалось прочитать историю отгрузок. Повторите сверку.",
          }));
        });
    };
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, AUTO_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [ids, reloadKey]);

  const matches = state.ids === ids;
  const rows = useMemo(
    () => buildDispatchRows(positions, matches ? state.facts : []),
    [positions, matches, state.facts],
  );
  return {
    rows,
    loading: ids !== "[]" && (!matches || state.loading),
    updatedAt: matches ? state.updatedAt : null,
    stale: matches && state.stale,
    error: matches ? state.error : "",
    reload: () => setReloadKey((value) => value + 1),
    historyUrl: `${ASSEMBLY_URL}/?view=warehouse&warehouse=history`,
  };
}
