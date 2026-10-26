// An owner-supplied value is a proposal, never a historical observation or a
// write authorization. Bind it to this incident generation and exact target.
export const sourceCandidateKey = (id) => "owner-source-candidate:" + id;
export function ownerSourceCandidate(store, row, incident, now = Date.now()) {
  const proposed = store.getSnapshot(sourceCandidateKey(row.id))?.value;
  if (
    !proposed ||
    row.status !== "open" ||
    incident.sourceState !== "missing" ||
    proposed.generation !== row.generation ||
    proposed.sourceId !== incident.sourceId ||
    proposed.gid !== incident.gid ||
    proposed.cell !== incident.cell ||
    proposed.productKey !== incident.observed?.productKey ||
    proposed.expiresAt <= now
  )
    return null;
  return proposed.candidate;
}
