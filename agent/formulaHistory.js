import { gunzipSync } from "node:zlib";

const unpack = (row) => JSON.parse(gunzipSync(row.payload).toString("utf8"));

// Evidence remains unapproved. It must never enter formula_protected implicitly.
export function observedFormulaCells(db, sourceId, gid, protectedCells) {
  const protectedSet = new Set(protectedCells.map((cell) => cell.cell)),
    result = new Map();
  for (const row of db
    .prepare(
      "SELECT v.payload FROM formula_regions r JOIN formula_versions v ON v.version=r.version WHERE r.source_id=? AND r.gid=? AND json_extract(r.payload,'$.current')=1",
    )
    .all(sourceId, gid)) {
    for (const [cell, formula, merge] of unpack(row).cells) {
      if (!protectedSet.has(cell))
        result.set(cell, { cell, formula, merge_signature: merge || null });
    }
  }
  for (const row of db
    .prepare("SELECT payload FROM incidents WHERE scope=? AND status='open'")
    .all(`doctor:formula:${sourceId}:${gid}`)) {
    const incident = JSON.parse(row.payload);
    if (
      incident.type === "formula_history_change" &&
      !protectedSet.has(incident.cell) &&
      incident.expected?.candidateFormula
    )
      result.set(incident.cell, {
        cell: incident.cell,
        formula: incident.expected.candidateFormula,
        merge_signature: null,
      });
  }
  return [...result.values()];
}

export function historicalFormulaEvidence(db, incident, firstSeen, gid) {
  const candidate = incident.expected?.candidateFormula;
  if (typeof candidate !== "string" || !candidate.startsWith("=")) return null;
  for (const row of db
    .prepare(
      "SELECT v.version,v.at,v.payload,v.region_id FROM formula_versions v JOIN formula_regions r ON r.id=v.region_id WHERE r.source_id=? AND r.gid=? AND v.at<=? ORDER BY v.at DESC",
    )
    .all(incident.sourceId, gid, firstSeen)) {
    const area = unpack(row),
      cell = area.cells.find(
        ([address, formula]) =>
          address === incident.cell && formula === candidate,
      );
    if (
      area.sourceId === incident.sourceId &&
      area.gid === gid &&
      area.sheet === incident.sheet &&
      cell
    )
      return {
        source_id: incident.sourceId,
        gid,
        cell: incident.cell,
        formula: candidate,
        merge_signature: cell[2] || null,
        region_id: row.region_id,
        version: row.version,
        historyApprovalRequired: true,
        observedAt: row.at,
      };
  }
  return null;
}
