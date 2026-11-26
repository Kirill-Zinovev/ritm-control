import { useEffect, useMemo, useState } from "react";
import {
  ArkadyAttention,
  type ArkadyAttentionActions,
} from "./ArkadyAttention";
import {
  buildArkadyAttention,
  type ArkadyAttentionItem,
} from "./arkadyAttentionData";
import {
  requestArkadyPlanning,
  type ArkadyPlanningSnapshot,
} from "./arkadyPlanningClient";
import type { LivePrinting } from "./livePrinting";

export type ArkadyAttentionViewProps = {
  live: LivePrinting | null;
  stale?: boolean;
  loadingPrinting: boolean;
  refreshPrinting: () => Promise<void>;
  getActions: (item: ArkadyAttentionItem) => ArkadyAttentionActions;
};

export function ArkadyAttentionView({
  live,
  stale,
  loadingPrinting,
  refreshPrinting,
  getActions,
}: ArkadyAttentionViewProps) {
  const [planning, setPlanning] = useState<ArkadyPlanningSnapshot | null>(null);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setError("");
      setLoading(true);
      try {
        const [planning] = await Promise.all([
          requestArkadyPlanning(controller.signal),
          refresh ? refreshPrinting() : undefined,
        ]);
        if (!controller.signal.aborted) {
          setNow(Date.now());
          setPlanning(planning);
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        setPlanning(null);
        setError(
          cause instanceof Error && cause.name === "Error"
            ? cause.message
            : "Не удалось проверить поставки. Попробуйте обновить данные.",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [refresh, refreshPrinting]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const report = useMemo(
    () =>
      buildArkadyAttention(live, planning?.deadlines ?? null, {
        stale,
        now,
        cutConfirmations: planning?.cutConfirmations,
        extraItems: planning?.extraItems,
        extraItemsConfirmed: planning?.extraItemsConfirmed,
      }),
    [live, planning, stale, now],
  );

  return (
    <ArkadyAttention
      report={report}
      loading={loading || (!live && loadingPrinting)}
      error={error}
      onRetry={() => {
        setNow(Date.now());
        setRefresh((value) => value + 1);
      }}
      getActions={getActions}
    />
  );
}
