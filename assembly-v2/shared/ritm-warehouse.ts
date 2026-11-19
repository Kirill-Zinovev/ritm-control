export interface RitmCartonItem {
  article: string;
  shipmentId: string;
  shipment: string;
  market: string;
  positionId: string;
  quantity: number;
  store: string;
  storeStatus: string;
  productName: string;
  photoUrl: string;
  barcode: string;
}
export interface RitmCarton {
  id: string;
  assemblyV2Id: string;
  sourceSystem: "assembly-v2";
  sourceKind: "direction" | "warehouse";
  legacyId: string | null;
  legacyBaseline: string | null;
  modifiedInV2: boolean;
  number: string;
  shipmentId: string;
  shipment: string;
  directionId: string;
  market: string;
  store: string;
  boxType: string;
  status: "open" | "closed";
  createdAt: string;
  closedAt: string;
  quantity: number;
  fillPercent: number | null;
  ready: boolean;
  issues: string[];
  contents: RitmCartonItem[];
  history: {
    action: "add" | "remove" | "close";
    article: string;
    quantity: number | null;
    shipmentId: string;
    shipment: string;
    createdAt: string;
    reason: string;
    employee: string | null;
  }[];
  dispatchStatus: "pending" | "sent";
  sentAt: string | null;
  dispatchChangedBy: string | null;
  reserved?: boolean;
  historicalSnapshotMissing?: boolean;
  archivedSourceUnavailable?: boolean;
}
export function cartonFingerprint(
  box: Pick<
    RitmCarton,
    | "id"
    | "shipmentId"
    | "number"
    | "status"
    | "quantity"
    | "boxType"
    | "contents"
  >,
): string {
  const contents = box.contents
    .map((i) => [i.shipmentId || "", i.positionId, i.article, i.quantity])
    .sort((a, b) =>
      JSON.stringify(a) < JSON.stringify(b)
        ? -1
        : JSON.stringify(a) > JSON.stringify(b)
          ? 1
          : 0,
    );
  return JSON.stringify([
    box.id,
    box.shipmentId,
    box.number,
    box.status,
    box.quantity,
    box.boxType,
    contents,
  ]);
}
export function legacyCartonComparison(
  box: Pick<RitmCarton, "number" | "status" | "quantity" | "contents">,
): string {
  const contents = box.contents
    .map((i) => [i.shipmentId || "", i.positionId, i.article, i.quantity])
    .sort((a, b) =>
      JSON.stringify(a) < JSON.stringify(b)
        ? -1
        : JSON.stringify(a) > JSON.stringify(b)
          ? 1
          : 0,
    );
  return JSON.stringify([box.number, box.status, box.quantity, contents]);
}
