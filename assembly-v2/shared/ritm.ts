import type { Market } from "./model";
export interface RitmSchedule {
  readyAt: string | null;
  packingAt: string | null;
  shipAt: string | null;
  urgent: boolean;
  printed: boolean;
  cut: boolean;
}
export interface RitmPosition {
  photoUrl?: string;
  unitsPerBox?: number | null;
  positionId: string;
  sku: string;
  name: string;
  quantity: number;
  sourceId: "roll-printing" | "box-printing" | "assembly-only";
  sheetId: number | null;
  row: number | null;
  rawUid: string | null;
  store: string;
  storeStatus: string;
}
export interface RitmSupply {
  shipmentId: string;
  title: string;
  market: Market;
  locked: boolean;
  schedule?: RitmSchedule;
  positions: RitmPosition[];
}
export interface RitmIssue {
  shipmentId: string;
  title: string;
  message: string;
}
const unconfirmedStoreWarnings = [
  ": магазин изменился; сохранена прежняя привязка Не подтверждён, требуется проверка.",
  ": магазин не подтверждён. Можно записывать работу, но нельзя добавлять в короб.",
];
export function unconfirmedStoreArticle(message: string): string | null {
  const warning = unconfirmedStoreWarnings.find(suffix => message.endsWith(suffix));
  return warning
    ? message.slice(0, -warning.length).trim() || null
    : null;
}
export interface RitmFeed {
  format: "ritm-assembly-v2";
  version: 1;
  sourceRevision: number;
  sourceAt: string;
  activeShipmentIds: string[];
  supplies: RitmSupply[];
  issues: RitmIssue[];
}
export interface RitmStatus {
  workDelivery?: {
    pending: number;
    delivered: number;
    failed: number;
    lastDelivered: string | null;
  };
  configured: boolean;
  status:
    | "unconfigured"
    | "waiting"
    | "syncing"
    | "synced"
    | "partial"
    | "error";
  checkedAt: string | null;
  sourceAt: string | null;
  message: string;
  supplies: number;
  groups: number;
  positions: number;
  issues: RitmIssue[];
}
export const ritmShipmentId = (value: string): boolean =>
  /^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i.test(value);
export async function signRitmFeed(
  secret: string,
  path: string,
  at: string,
  nonce: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [
    ...new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(JSON.stringify([1, "GET", path, at, nonce])),
      ),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
