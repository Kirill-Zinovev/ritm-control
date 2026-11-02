const documentId = /^[A-Za-z0-9_-]{20,100}$/;
const keys = ["seasonalPrintingId", "rollPrintingId", "boxPrintingId", "catalogId", "fboSourceId", "assemblyDatabaseId"];

export function sourceId(bindings, key) {
  const name = "RITM_GOOGLE_" + key.replace(/[A-Z]/g, (letter) => "_" + letter).toUpperCase();
  const value = bindings[name];
  return typeof value === "string" && documentId.test(value) ? value : "";
}

export function sourceIds(bindings) {
  return [...new Set([...keys, "photosId", "boxJournalId"].map((key) => sourceId(bindings, key)).filter(Boolean))];
}

export function cloudConfig(bindings) {
  const owners = String(bindings.RITM_OWNER_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const missing = keys.filter((key) => !sourceId(bindings, key));
  return {
    owners,
    sources: sourceIds(bindings),
    writableSources: [sourceId(bindings, "rollPrintingId"), sourceId(bindings, "boxPrintingId")].filter(Boolean),
    missing,
    configured: missing.length === 0 && owners.length > 0 && !!bindings.RITM_GOOGLE_READER_JSON && !!bindings.DB,
    writesEnabled: bindings.RITM_CLOUD_WRITES_ENABLED === "true" && !!bindings.RITM_CLOUD_CUTOVER_ID,
    snapshotMaxAgeMs: 5 * 60 * 1000,
  };
}

export function assemblyUrl(bindings) {
  const value = bindings.RITM_ASSEMBLY_WEB_APP_URL;
  return typeof value === "string" && /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,100}\/exec$/.test(value) ? value : "";
}
