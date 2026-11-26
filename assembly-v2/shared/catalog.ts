import type { Market } from "./model";

export const catalogVersion = "assembly-catalog-1";
export const catalogKey = (value: string): string =>
  value.trim().normalize("NFC").toLocaleUpperCase("ru-RU");
export const spreadsheetError = (value: string): boolean =>
  /^#(?:N\/A|VALUE!|REF!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR!)/i.test(value.trim());
export const cleanCatalogText = (value: string): string =>
  spreadsheetError(value) ? "" : value.trim();
export function photoAllowed(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      /^(?:basket-\d+\.wbbasket\.ru|mow-basket-cdn-\d+\.geobasket\.ru)$/.test(
        u.hostname,
      ) &&
      /^\/vol\d+\/part\d+\/\d+\/images\//.test(u.pathname)
    );
  } catch {
    return false;
  }
}
export async function digest(value: string | Uint8Array): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export interface CatalogSource {
  role: "base" | "photos";
  name: string;
  sha256: string;
  bytes: number;
}
export interface CatalogRow {
  sheet: Market;
  row: number;
  raw: Record<string, string>;
  refs: Record<string, string>;
}
export interface CatalogPhoto {
  id: string;
  sku: string;
  store: string;
  primary: string | null;
  urls: string[];
  sources: { sheet: string; row: number; raw: string[] }[];
}
export interface CatalogEntry {
  printExtension?: string;
  photoUrl?: string | null;
  /** Public photo for Sheets when the main catalog image cannot leave RITM. */
  layoutPhotoUrl?: string;
  kindCorrection?: string;
  id: string;
  market: Market;
  store: string;
  sku: string;
  aliases: string[];
  name: string;
  barcode: string;
  kind: string;
  category: string;
  machine: string;
  packaging: string;
  size: string;
  sheetsPerUnit: string;
  printFolder: string;
  catalogDepartment: string;
  boxType: string;
  unitsPerBox: number | null;
  rollMultiplicity: string;
  xeroxMultiplicity: string;
  capacitySource: "consistent" | "user" | "review";
  photoId: string | null;
  issues: string[];
  rows: CatalogRow[];
}
export interface CatalogChunk {
  kind: "entries" | "photos";
  part: number;
  digest: string;
  count: number;
}
export interface CatalogManifest {
  version: string;
  sources: CatalogSource[];
  entries: number;
  photos: number;
  sourceRows: number;
  capacityConflicts: number;
  userCorrections: number;
  chunks: CatalogChunk[];
  decision: string;
}
export interface CatalogBundle {
  id: string;
  manifest: CatalogManifest;
  chunks: { meta: CatalogChunk; data: string }[];
}
export interface CatalogListItem extends Omit<
  CatalogEntry,
  "rows" | "aliases"
> {
  importId: string;
}
export interface CatalogPage {
  total: number;
  page: number;
  items: CatalogListItem[];
  active: { id: string; manifest: CatalogManifest; createdAt: string } | null;
  machines: string[];
}
export interface CatalogDetail extends CatalogEntry {
  importId: string;
  photo: CatalogPhoto | null;
}

export function capacity(
  raw: Record<string, string>,
  market: Market,
): {
  value: number | null;
  source: CatalogEntry["capacitySource"];
  conflict: boolean;
} {
  if (
    market === "OZON" &&
    catalogKey(raw.article) === "SS0031.A7484(OZ)" &&
    raw.store.trim() === "1"
  )
    return { value: 700, source: "user", conflict: false };
  const numeric = Number(
    cleanCatalogText(raw.unitsPerBoxNumber).replace(",", "."),
  );
  const match = cleanCatalogText(raw.unitsPerBoxText).match(
    /^(\d+(?:[.,]\d+)?)\s*(.*?)$/,
  );
  const written = match ? Number(match[1].replace(",", ".")) : 0;
  const type = cleanCatalogText(raw.boxType);
  const valid = (n: number) => Number.isSafeInteger(n) && n > 0;
  const conflict = !!(
    (valid(numeric) && valid(written) && numeric !== written) ||
    (match?.[2] && type && catalogKey(match[2]) !== catalogKey(type))
  );
  const value = valid(numeric) ? numeric : valid(written) ? written : null;
  return {
    value: conflict || !type ? null : value,
    source: conflict || !type || !value ? "review" : "consistent",
    conflict,
  };
}

// Empty duplicates carry no contradictory capacity; malformed or differing values do.
export function duplicateCapacity(rows: CatalogRow[], market: Market): ReturnType<typeof capacity> {
  const filled = rows.filter(r => (r.raw.unitsPerBoxNumber || "").trim() || (r.raw.unitsPerBoxText || "").trim());
  const types = new Set(rows.map(r=>catalogKey(r.raw.boxType || "")).filter(Boolean));
  const norms = filled.map(r=>capacity(r.raw,market));
  if (!norms.length || types.size > 1 || norms.some(n=>n.source === "review") || new Set(norms.map(n=>n.value)).size !== 1)
    return {value:null,source:"review",conflict:types.size>1 || norms.some(n=>n.conflict) || new Set(norms.map(n=>n.value)).size>1};
  return {value:norms[0].value,source:norms.some(n=>n.source === "user") ? "user" : "consistent",conflict:false};
}
