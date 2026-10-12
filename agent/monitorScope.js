// Source reads may include dependencies for KPI. Incident scope is independent.
export function scopeAllows(finding, documents, sources = []) {
  const direct = documents.find((d) => d.id === finding.sourceId);
  const source = sources.find((s) => s.id === finding.sourceId);
  const document =
    direct ||
    (source && documents.find((d) => d.documentId === source.documentId));
  if (!document) return true; // technical API checks and explicitly separate test instances
  if (!finding.sheet) return true; // document connection, no invented cell error
  return document.sheets.some((s) => s.name === finding.sheet);
}
