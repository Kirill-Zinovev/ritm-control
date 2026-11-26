import type { Operation } from "./model";
import { spreadsheetError } from "./catalog";
export const workTypeKey = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
export interface ShiftNorm {
  type: string;
  cut: number | null;
  packing: number | null;
  assembly: number | null;
  conflict?: boolean;
  row: number;
}
export interface WorkNorms {
  cut: number | null;
  packing: number | null;
  assembly: number | null;
  multiplier: number | null;
}
export function effectiveWorkNorms(
  catalog: Record<string, unknown> | null,
  norms: ShiftNorm[],
): WorkNorms {
  const empty = { cut: null, packing: null, assembly: null, multiplier: null };
  if (!catalog || typeof catalog.kind !== "string") return empty;
  const n = norms.find(
    (n) => workTypeKey(n.type) === workTypeKey(String(catalog.kind)),
  );
  const base = n && !n.conflict ? n : {packing:null,assembly:null,cut:null};
  const overrides = catalog.workNorms as Partial<Record<Operation, number | null>> | undefined;
  const raw = catalog.sheetsPerUnit;
  const rows = catalog.rows as
    | { raw?: { sheetsPerUnit?: string } }[]
    | undefined;
  const error = (!catalog.editRevision || catalog.sheetCountSourceError === true)
    && rows?.some((r) => spreadsheetError(String(r.raw?.sheetsPerUnit || "")));
  const multiplier =
    error || raw === undefined
      ? null
      : raw === ""
        ? 1
        : Number(String(raw).replace(",", "."));
  return {
    packing: overrides?.packing ?? base.packing,
    assembly: overrides?.assembly ?? base.assembly,
    cut: overrides?.cut ?? (multiplier && multiplier > 0 && base.cut ? base.cut / multiplier : null),
    multiplier: multiplier && multiplier > 0 ? multiplier : null,
  };
}
export const savedCoefficient = (
  norms: WorkNorms,
  operation: Operation,
  qty: number,
) => (norms[operation] ? qty / norms[operation]! : null);

export function missingWorkNormReason(
  catalog: Record<string, unknown> | null,
  shifts: ShiftNorm[],
  operation: Operation,
) {
  if (!catalog) return "catalog";
  const norm = effectiveWorkNorms(catalog, shifts);
  if (norm[operation]) return "ready";
  if (typeof catalog.kind !== "string" || !catalog.kind.trim()) return "kind";
  if (operation === "cut" && !norm.multiplier) return "sheets";
  return "norm";
}
