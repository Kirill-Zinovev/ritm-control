export type SupplyLockRecord = {
  shipmentId: string;
  locked: boolean;
  pending: boolean;
  status: "locking" | "locked" | "unlocking" | "unlocked";
};

// A successful all-locks response contains every recorded lock. Missing IDs
// therefore mean no lock record; a failed or malformed response stays unknown.
export function supplyLockState(ids: string[], records: SupplyLockRecord[] | null) {
  if (!records || !ids.length) return "unknown" as const;
  const uniqueIds = [...new Set(ids)];
  const matches = uniqueIds.map((id) => records.find((item) => item.shipmentId === id));
  if (matches.some((item) => item && (item.pending || item.status === "locking" || item.status === "unlocking"))) return "pending" as const;
  if (matches.some((item) => item && ((item.status === "locked") !== item.locked))) return "unknown" as const;
  const closed = matches.filter((item) => item?.status === "locked" && item.locked).length;
  if (closed === uniqueIds.length) return "closed" as const;
  if (closed > 0) return "partial" as const;
  return "open" as const;
}
