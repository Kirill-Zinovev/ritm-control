const clean = value => String(value || '').replace(/[\r\n\[\]]/g, ' ').trim().slice(0, 120);
const label = department => department === 'box' ? 'Бокс' : 'Рулонная печать';

export function stockCompletionSections(event) {
  return event.sections || [{department:event.department,sheetId:event.sheetId,entries:[{article:event.article,quantity:event.quantity}]}];
}

export function formatStockCompletion(event, {documentId, documentIds = {}, joke = ''} = {}) {
  const sections = stockCompletionSections(event);
  const destination = event.destination === 'urgent' ? 'Срочные 2 этаж' : 'Запасы склад';
  const lines = sections.map(section => {
    const doc = documentIds[section.department] || documentId;
    const link = /^[A-Za-z0-9_-]+$/.test(doc || '') && Number.isSafeInteger(section.sheetId) && section.sheetId >= 0
      ? `\n[URL=https://docs.google.com/spreadsheets/d/${doc}/edit#gid=${section.sheetId}]Открыть таблицу ${section.department === 'box' ? 'бокса' : 'рулонной печати'}[/URL]` : '';
    return `${section.department === 'box' ? '📦' : '🖨️'} [B]${label(section.department)}[/B]\n${section.entries.map(entry => `▪️ [B]${clean(entry.article)}[/B] — ${entry.quantity} шт.`).join('\n')}${link}`;
  }).join('\n\n');
  return `🦎 [B]Аркадий на связи![/B]\n\n✅ [B]ПЕЧАТЬ И ПОРЕЗКА ЗАВЕРШЕНЫ · ЗАПАСЫ[/B]\n\n📍 Назначение: [B]${destination}[/B]\n[B]Весь список готов[/B]\n\n${lines}${event.manager ? `\n\n👤 Добавил(а): ${clean(event.manager)}` : ''}${joke ? `\n\n[I]${joke}[/I]` : ''}`;
}

// One immutable, verified StockOperations upload is one notification. Separate
// uploads on the same sheet remain independent. Readiness still uses the whole
// current position plan, including later increases.
export function evaluateStockWatch({batches, history, previous = {}, startedAt = null, now = Date.now()}) {
  const state = structuredClone(previous), events = [], statuses = new Map(history.map(row => [row.id, row]));
  for (const batch of batches) {
    if (!batch.valid) continue;
    const fingerprint = JSON.stringify(batch.entries.map(entry => [entry.department,entry.sheetId,entry.row,entry.uid,entry.article,entry.quantity,entry.plannedQuantity]).sort());
    const old = state[batch.id];
    // A committed batch ID must never be reused for a different membership.
    if (old?.fingerprint && old.fingerprint !== fingerprint) continue;
    const current = batch.entries.map(entry => {
      const h = statuses.get(entry.id);
      if (!h || h.department !== entry.department || h.destination !== batch.destination || h.article !== entry.article) return null;
      if (h.status === 'closed') return h.print === 'done' && h.cut === 'done' ? h : null;
      return Number.isSafeInteger(h.currentPlan) && h.currentPlan >= entry.plannedQuantity ? h : null;
    });
    const complete = current.every(h => h?.print === 'done' && h?.cut === 'done');
    const unfinished = current.some(h => h && (['partial','not_started'].includes(h.print) || ['partial','not_started'].includes(h.cut)));
    const addedAt = Date.parse(batch.date);
    const eligible = old?.eligible === true || unfinished || !!startedAt && addedAt >= Date.parse(startedAt);
    const excluded = batch.destination === 'urgent' && addedAt >= Date.parse('2026-11-05T21:00:00Z') && addedAt < Date.parse('2026-11-06T21:00:00Z')
      && batch.entries.some(entry => entry.department === 'box' && clean(entry.article).toUpperCase() === 'KS0013.A7986' && entry.plannedQuantity === 300);
    const next = {...old, fingerprint, eligible, complete, notified:old?.notified === true};
    // The first observation of already finished historical work is silent.
    if (complete && !eligible) next.notified = true;
    if (complete && eligible && !next.notified && !excluded) {
      const sections = [];
      for (const department of ['roll','box']) {
        const entries = batch.entries.filter(entry => entry.department === department);
        if (entries.length) sections.push({department,sheetId:entries[0].sheetId,entries:entries.map(({article,quantity}) => ({article,quantity}))});
      }
      events.push({id:`stock-batch:${batch.id}:complete`,batchId:batch.id,destination:batch.destination,manager:batch.manager,quantity:batch.entries.reduce((sum,entry) => sum + entry.quantity,0),sections,stage:'complete'});
      next.notified = true;
    }
    state[batch.id] = next;
  }
  return {events,state,startedAt:startedAt || new Date(now).toISOString()};
}
