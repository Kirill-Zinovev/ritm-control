import { overlayPrintingV2, readAssemblyV2Events } from './assemblyV2Events.js';
import { evaluateArkadyCutWatch } from './arkadyCutWatch.js';
import { cutReminderRecipients, cutReminderRecipientsKey } from './bitrixSettings.js';

const stateKey = 'arkadyCutReminderStateV1';
const scanLimit = 4;
const maxSnapshotAge = 15 * 60 * 1000;

export async function runArkadyCutReminders(store, printing, { readRecipient, send }) {
  const [saved, enabled] = await Promise.all([
    store.readMeta(cutReminderRecipientsKey),
    store.readMeta('bitrixNotificationsEnabled'),
  ]);
  const recipients = cutReminderRecipients(saved);
  if (enabled === false || (!recipients.roll && !recipients.box)) return { checked: 0, sent: 0 };

  const now = store.now();
  const snapshotAt = Date.parse(printing?.snapshotAt ?? '');
  if (!Number.isFinite(snapshotAt) || snapshotAt > now || now - snapshotAt > maxSnapshotAge ||
      !printing.ok || printing.stale || printing.refreshFailed || printing.refreshInProgress || !printing._assemblyStages)
    return { checked: 0, sent: 0 };

  const [registry, workEvents] = await Promise.all([
    store.readMeta('productionSupplies'),
    readAssemblyV2Events(store),
  ]);
  const assembly = overlayPrintingV2(printing, workEvents);
  const { events, resolvedKeys } = evaluateArkadyCutWatch({ printing: assembly, supplies: registry || [], now });
  const targets = events.filter(event => recipients[event.department]);
  if (!targets.length && !resolvedKeys.length) return { checked: 0, sent: 0 };

  const prior = await store.readMeta(stateKey);
  if (snapshotAt < (prior?.snapshotAt || 0)) return { checked: 0, sent: 0 };
  const freshTargets = targets.filter(event => !prior?.open?.[event.key]);
  if (!targets.length && !resolvedKeys.some(key => prior?.open?.[key]))
    return { checked: 0, sent: 0 };
  const available = new Set();
  for (const id of new Set(freshTargets.map(event => recipients[event.department]))) {
    try {
      if ((await readRecipient(id))?.id === id) available.add(id);
    } catch { /* Leave issues eligible for the next scan when the directory recovers. */ }
  }

  const claimed = await store.withScope(scope => {
    if (scope.meta('bitrixNotificationsEnabled') === false ||
        (scope.meta('productionSupplyRevision') || null) !== (printing.productionSupplyRevision || null) ||
        (scope.meta('printingMoveRevision') || null) !== (printing.productionMoveRevision || null)) return [];
    const current = cutReminderRecipients(scope.meta(cutReminderRecipientsKey));
    const previous = scope.meta(stateKey);
    if (snapshotAt < (previous?.snapshotAt || 0)) return [];
    const open = previous?.open || {};
    const resolved = resolvedKeys.some(key => Object.hasOwn(open, key));
    for (const key of resolvedKeys) delete open[key];
    const reservations = [];
    for (const event of freshTargets) {
      const id = current[event.department];
      if (!id || id !== recipients[event.department] || !available.has(id) || open[event.key]) continue;
      const attempt = crypto.randomUUID();
      open[event.key] = { attempt, status: 'sending', at: now };
      reservations.push({ event, id, attempt });
      if (reservations.length === scanLimit) break;
    }
    if (snapshotAt !== previous?.snapshotAt || reservations.length || resolved)
      scope.meta(stateKey, { snapshotAt, open });
    return reservations;
  });

  const outcomes = [];
  for (const claim of claimed) {
    const latest = cutReminderRecipients(await store.readMeta(cutReminderRecipientsKey));
    const globallyEnabled = await store.readMeta('bitrixNotificationsEnabled');
    let status = 'skipped';
    if (globallyEnabled !== false && latest[claim.event.department] === claim.id) {
      try { status = (await send(claim.id, claim.event)).status; }
      catch { status = 'uncertain'; }
    }
    outcomes.push({ ...claim, status });
  }
  if (outcomes.length) await store.withScope(scope => {
    const state = scope.meta(stateKey);
    for (const { event, attempt, status } of outcomes) {
      const record = state?.open?.[event.key];
      if (record?.attempt !== attempt) continue;
      if (status === 'skipped' || status === 'failed') delete state.open[event.key];
      else record.status = status === 'sent' ? 'sent' : 'uncertain';
    }
    if (state) scope.meta(stateKey, state);
  });

  return {
    checked: targets.length,
    sent: outcomes.filter(outcome => outcome.status === 'sent').length,
    uncertain: outcomes.filter(outcome => outcome.status === 'uncertain').length,
  };
}
