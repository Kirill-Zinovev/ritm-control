import type { RitmSchedule } from "./ritm";

export type Operation = "cut" | "assembly" | "packing";
export type Market = "WB" | "OZON";
export interface Scope {
  market: Market;
  store: string;
  destination: string;
}
export interface Supply extends Scope {
  sources?: Supply[];
  schedule?: RitmSchedule | null;
  packingComplete?: boolean;
  sourceLocked?: boolean;
  originShipmentId?: string | null;
  sourceActive?: boolean;
  id: string;
  externalId: string;
  title: string;
  sourceVersion: number;
}
export interface Employee {
  id: string;
  name: string;
  active: boolean;
}
export interface TeamRow {
  employeeId: string;
  name: string;
  cut: number;
  assembly: number;
  packing: number;
}
export interface Position {
  photoUrl?: string | null;
  photoCatalogImportId?: string;
  workNorms?:import('./work-norm').WorkNorms;
  warehouseQty?: number;
  sourceActive?: boolean;
  storeNeedsReview?: boolean;
  catalogImportId?: string | null;
  catalogEntryId?: string | null;
  catalog?: {
    kind: string;
    boxType: string;
    machine: string;
    packaging: string;
    size: string;
    photoId: string | null;
    labelSha?: string | null;
    store?: string;
    unitsPerBox?: number | null;
    capacitySource: string;
  } | null;
  id: string;
  supplyId: string;
  externalId: string;
  sku: string;
  name: string;
  barcode: string;
  department: string;
  plan: number;
  unitsPerBox: number | null;
  ready: boolean;
  cutOperation: "cut" | "assembly";
  cut: number;
  assembly: number;
  packing: number;
  boxed: number;
  team: TeamRow[];
}
export interface Work {
  name?: string;
  photoUrl?: string | null;
  photoId?: string | null;
  catalogImportId?: string | null;
  scope?: "supply" | "warehouse";
  norm?:string|null;
  coefficient?:string|null;
  id: string;
  positionId: string;
  employeeId: string;
  employee: string;
  sku: string;
  operation: Operation;
  qty: number;
  createdAt: string;
  canceled: boolean;
  cancelReason: string | null;
}
export interface CartonItem {
  photoUrl?: string | null;
  catalogImportId?: string | null;
  photoId?: string | null;
  id: string;
  positionId: string;
  supplyId: string;
  supply: string;
  externalSupplyId: string;
  externalPositionId: string;
  sku: string;
  name: string;
  barcode: string;
  qty: number;
  unitsPerBox: number | null;
}
export interface Carton extends Scope {
  capacityUnknown?: boolean;
  id: string;
  label: string;
  state: "open" | "closed";
  dispatchId: string | null;
  dispatchState: "draft" | "sent" | "canceled" | null;
  createdAt: string;
  closedAt: string | null;
  fill: number;
  qty: number;
  items: CartonItem[];
}
export interface Dispatch extends Scope {
  id: string;
  label: string;
  state: "draft" | "sent" | "canceled";
  createdAt: string;
  sentAt: string | null;
  cartonIds: string[];
  qty: number;
}
export interface PreparedDispatch extends Dispatch {
  cartons: Pick<Carton, "id" | "label" | "qty">[];
}
export interface ExportSnapshot {
  id: string;
  dispatchId: string;
  kind: "account" | "template";
  createdAt: string;
  payload: { dispatch: Dispatch; cartons: Carton[] };
}
export interface Snapshot {
  sourceSupplies?: Supply[];
  cartonScope?: "supply" | "all" | "directory";
  revision: number;
  progress: { plan: number; packed: number };
  supplies: Supply[];
  employees: Employee[];
  selectedSupplyId: string | null;
  positions: Position[];
  works: Work[];
  cartons: Carton[];
  dispatches: Dispatch[];
  exports: Omit<ExportSnapshot, "payload">[];
}
export interface SupplyImport extends Scope {
  originShipmentId?: string;
  sourceActive?: boolean;
  externalId: string;
  title: string;
  sourceVersion: number;
  positions: {
    sourceActive?: boolean;
    externalId: string;
    sku: string;
    name: string;
    barcode: string;
    department: string;
    plan: number;
    unitsPerBox: number | null;
    ready: boolean;
    cutOperation: "cut" | "assembly";
  }[];
}
export interface Command {
  directions?: boolean;
  cartonScope?: "supply" | "all" | "directory";
  action: string;
  payload: Record<string, unknown>;
  key: string;
  supplyId: string | null;
}
export interface ApiError {
  error: string;
  code?: string;
}
export const operationLabels: Record<Operation, string> = {
  cut: "Резка на станке",
  assembly: "Ручная резка",
  packing: "Упаковка",
};
export const sameScope = (a: Scope, b: Scope): boolean =>
  a.market === b.market &&
  a.store === b.store &&
  a.destination === b.destination;
export const number = (value: number): string =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value);
export const dateTime = (value: string): string =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
export const countLabel = (
  value: number,
  forms: readonly [string, string, string],
): string => {
  const n = Math.abs(value) % 100;
  const index =
    n >= 11 && n <= 14
      ? 2
      : n % 10 === 1
        ? 0
        : n % 10 >= 2 && n % 10 <= 4
          ? 1
          : 2;
  return `${number(value)} ${forms[index]}`;
};
