// Notifications use confirmed snapshots only; missing or stale data is unknown,
// never treated as an unstarted job or a completed stage.
const validQty = value => Number.isSafeInteger(value) && value > 0;
// Only future, explicitly registered creations qualify for a completed first
// observation. Older supplies remain silent to avoid replaying historical work.
const NEW_SUPPLY_NOTIFICATION_CUTOFF = Date.parse('2026-11-09T06:39:18Z');
const stage = (rows, field) => rows.length && rows.every(row => validQty(row.quantity) && typeof row[field] === 'number' && Number.isFinite(row[field]) && row[field] >= 0)
  ? rows.every(row => row[field] >= row.quantity) : null;
export function evaluateArkadyWatch({printing, supplies, watches, previous = {}, starts = {}, now = Date.now()}) {
  if (!printing || printing.ok !== true || printing.stale === true || printing.refreshFailed === true || !['valid','partial'].includes(printing.quality?.status) || (printing.quality?.status === 'partial' && (!Array.isArray(printing.issues) || printing.issues.some(issue => !issue?.source))) || !Array.isArray(printing.supplies) || !Array.isArray(printing.sheets)) return {events:[], states:previous};
  const states = structuredClone(previous), events = [];
  for (const supply of supplies || []) {
    if (!supply?.id || !Array.isArray(supply.parts)) continue;
    const config = watches?.[supply.id] || {};
    for (const part of supply.parts) {
      if (!['box','roll'].includes(part.department) || !Number.isSafeInteger(part.sheetId)) continue;
      const sourceId = part.department === 'box' ? 'box-printing' : 'roll-printing';
      const sheet = printing.sheets.find(s => s.sourceId === sourceId && s.sheetId === part.sheetId && s.assemblyShipmentId === supply.id);
      if (!sheet) continue;
      // Unrelated legacy journal or other-sheet issues must not block this
      // shipment, but a problem attributed to this sheet leaves it unconfirmed.
      if (printing.quality.status === 'partial' && (!sheet.name || printing.issues.some(issue => issue.source === sheet.name))) continue;
      const rows = printing.supplies.filter(row => row.sourceId === sourceId && row.sheetId === part.sheetId && row.assemblyShipmentId === supply.id);
      if (!rows.length || rows.some(row => !validQty(row.quantity) || !row.uid)) continue;
      const key = `${supply.id}:${part.department}`, old = states[key] || {}, next = {...old};
      const printDone=stage(rows,'printProgress'), cutDone=stage(rows,'cutProgress');
      const previouslyDone=typeof old.readyBoth==='boolean' ? old.readyBoth : old.print===true && old.cut===true;
      const createdAt = Date.parse(config.createdAt || '');
      const newlyCreated = !Object.prototype.hasOwnProperty.call(states,key) && Number.isFinite(createdAt) && createdAt >= NEW_SUPPLY_NOTIFICATION_CUTOFF && createdAt <= now;
      if (printDone === true && cutDone === true && (newlyCreated || old.print === false || old.cut === false || old.readyBoth === false) && !previouslyDone && !old.completeNotified) {
        events.push({id:`watch:${key}:complete`,kind:'completion',name:supply.name,department:part.department,stage:'complete',articles:rows.length,quantity:rows.reduce((n,row)=>n+row.quantity,0),url:sheet.spreadsheetUrl || ''});
        next.completeNotified = true;
      }
      if(printDone !== null && cutDone !== null) next.readyBoth=printDone && cutDone;
      else if(typeof next.readyBoth !== 'boolean') next.readyBoth=previouslyDone;
      if(printDone !== null) next.print=printDone;
      if(cutDone !== null) next.cut=cutDone;
      const start = starts[key];
      const at = Date.parse(config.createdAt || '');
      if (config.priority === 'urgent' && Number.isInteger(config.reminderMinutes) && config.reminderMinutes > 0 && Number.isFinite(at) && now >= at + config.reminderMinutes*60000 && start === false && !old.reminded) {
        events.push({id:`watch:${key}:reminder`,kind:'reminder',name:supply.name,department:part.department,articles:rows.length,quantity:rows.reduce((n,row)=>n+row.quantity,0),url:sheet.spreadsheetUrl || ''});
        next.reminded = true;
      }
      states[key] = next;
    }
  }
  return {events,states};
}
