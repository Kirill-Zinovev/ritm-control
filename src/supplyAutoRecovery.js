// Resume the accepted durable request only; never manufacture another create ID.
export function recoverableSupply(operation, writerBusy, attempts, now = Date.now()) {
  if (!operation || writerBusy || attempts >= 5 || !['create','append'].includes(operation.action) || !['writing','checking','partial'].includes(operation.status)) return false;
  if (!/^[a-f0-9-]{36}$/i.test(operation.id || '') || !operation.steps?.length) return false;
  const updated = Date.parse(operation.updatedAt || '');
  return Number.isFinite(updated) && now - updated >= 10000;
}
