import type { Dispatch, ExportSnapshot } from "./model";
import type { OzonGroup } from "./ozon-shipment";

export const dispatchHistoryPageSize = 30;

export type DispatchHistoryEntry = Omit<Dispatch, "cartonIds"> & {
  cartonCount: number;
  returnedCartonCount: number;
  cartonLabels: string[];
  matchedCarton?: {
    id: string;
    label: string;
    exact: boolean;
    ozonCode?: string;
    articleQty?: number;
  };
};

export interface DispatchHistoryPage {
  entries: DispatchHistoryEntry[];
  total: number;
}

export interface DispatchHistoryDetail {
  dispatch: Dispatch;
  archive: {
    kind: "departure" | "export";
    createdAt: string;
    payload: ExportSnapshot["payload"];
  } | null;
  ozon: OzonGroup | null;
  cartonLabels: Record<string, string>;
  cartonStates: Record<string, "sent" | "returned" | null>;
}
