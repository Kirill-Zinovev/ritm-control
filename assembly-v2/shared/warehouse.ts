import type { Market } from "./model";
export interface WarehouseReceipt {
  photoUrl?: string | null;
  workId?: string | null;
  workQty?: number | null;
  norm?: string | null;
  coefficient?: string | null;
  id: string;
  cartonId: string;
  sku: string;
  name: string;
  qty: number;
  catalogImportId: string | null;
  photoId: string | null;
  employee: string;
  supply: string;
  comment: string;
  createdAt: string;
}
export interface WarehouseCarton {
  id: string;
  label: string;
  market: Market;
  store: string;
  state: "open" | "closed";
  version: number;
  createdAt: string;
  closedAt: string | null;
  current: boolean;
  qty: number;
  itemCount: number;
  items: WarehouseReceipt[];
}
export interface WarehousePage {
  cartons: WarehouseCarton[];
  total: number;
  page: number;
  itemPage: number;
  summary?: { qty: number; openCount: number };
}
export type WarehouseNumberScope = "stock" | "ready";
export interface WarehouseNumberPreview {
  cartons: (Pick<WarehouseCarton, "id" | "label" | "market" | "store" | "state"> & { destination?: string })[];
  issues: { label: string; reason: "missing" | "ambiguous" | "open" | "prepared" | "sent" }[];
}
