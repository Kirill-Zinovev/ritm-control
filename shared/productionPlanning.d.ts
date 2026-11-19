export type Deadlines = {
  readyAt: string | null;
  packingAt?: string | null;
  shipAt: string | null;
};
export type Resource = {
  id: string;
  rate: number;
  rateMode?: "manual" | "auto";
  unit: "pieces" | "area" | "sheets";
  days: number[];
  start: number;
  end: number;
};
export type Planning = {
  revision: number;
  resources: Resource[];
  deadlines: Record<string, Deadlines>;
  stockSources?: PackingStockSource[];
  cutConfirmations?: ProductionCutConfirmation[];
  updatedAt: string | null;
  updatedBy: string | null;
};
export type ProductionCutConfirmation = {
  taskId: string;
  article: string;
  quantity: number;
  sourcePlan: number;
  recordedAt: string;
  recordedBy: string;
};
export type PackingStockSource = {
  taskId: string;
  article: string;
  quantity: number;
  packingEventIds: string[];
  recordedAt: string;
  recordedBy: string;
};
export const RESOURCE_IDS: string[];
export function validateDeadlines(value: unknown): Deadlines;
export function validateResources(value: unknown): Resource[];
export function emptyPlanning(): Planning;
