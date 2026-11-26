import test from 'node:test';
import assert from 'node:assert/strict';
import { runArkadyCutReminders } from '../worker/cloud/arkadyCutReminders.js';
import { sendBitrixCutReminder } from '../worker/cloud/bitrixNotifications.js';
import { cutReminderRecipientsKey, validateCutReminderRecipients } from '../worker/cloud/bitrixSettings.js';
import { CloudStore } from '../worker/cloud/store.js';
import { LocalD1 } from './helpers/d1-sqlite.mjs';
import { cloudSchemaStatements } from './helpers/cloud-schema.mjs';

const shipmentId = 'RITM-SUPPLY-87878888-0000-4000-8000-000000000001';
const cutRecipient = { roll: '42', box: '43' };
const bitrix = {
  RITM_BITRIX_WEBHOOK_URL: 'https://kaleidoskop.bitrix24.ru/rest/1/fixtureWebhookToken1/',
  RITM_BITRIX_BOT_TOKEN: 'fixture-client-key',
  RITM_BITRIX_BOT_ID: '5768',
  RITM_BITRIX_BOX_CHAT: 'chat1',
  RITM_BITRIX_ROLL_CHAT: 'chat2',
};

function fixture(t) {
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(';\n'));
  t.after(() => db.close());
  let now = Date.parse('2026-11-26T10:00:00Z');
  const store = new CloudStore(db, { now: () => now });
  const row = department => ({
    assemblyShipmentId: shipmentId,
    uid: department + '-position',
    rawUid: department + '-position',
    sourceId: department + '-printing',
    sheetId: department === 'roll' ? 10 : 20,
    row: 5,
    quantity: 20,
    article: department === 'roll' ? 'QA0003.A0788' : 'QA0004.A0789',
    printProgress: 20,
    cutProgress: null,
    cutMarkMissing: true,
  });
  const makeSnapshot = ({ roll = {}, box = {}, revision } = {}) => {
    const at = new Date(now).toISOString();
    const supplies = [{ ...row('roll'), ...roll }, { ...row('box'), ...box }];
    return {
      ok: true,
      snapshotAt: at,
      productionSupplyRevision: revision,
      quality: { status: 'valid' },
      supplies,
      sheets: supplies.map(r => ({
        sourceId: r.sourceId, sheetId: r.sheetId, assemblyShipmentId: shipmentId, name: 'OZON Тест',
      })),
      _assemblyStages: { checkedAt: at, packing: { events: supplies.map(r => ({
        eventId: 'pack-' + r.uid, shipmentId,
        positionId: [shipmentId, ...(r.sourceId === 'box-printing' ? ['box:20'] : []), 'uid:' + r.uid, r.article].join('|'),
        article: r.article, quantity: 5, createdAt: at,
      })), invalid: [] } },
    };
  };
  return { db, store, makeSnapshot, advance: () => { now += 60_000; } };
}

test('cutting recipients are optional employee IDs scoped to roll and box', () => {
  assert.deepEqual(validateCutReminderRecipients({ roll: '42', box: null }), { roll: '42', box: null });
  assert.throws(() => validateCutReminderRecipients({ roll: 'chat42', box: null }), { code: 'bitrix_setting_invalid' });
  assert.throws(() => validateCutReminderRecipients({ roll: '42', box: null, all: '7' }), { code: 'bitrix_setting_invalid' });
});

test('maintenance sends a private message per affected department, dedupes it and reopens a resolved discrepancy', async t => {
  const { store, makeSnapshot, advance } = fixture(t);
  const messages = [];
  const fetcher = async (url, init) => {
    assert.match(url, /imbot\.message\.add$/);
    messages.push(JSON.parse(init.body));
    return Response.json({ result: 100 + messages.length });
  };
  const run = snapshot => runArkadyCutReminders(store, snapshot, {
    readRecipient: async id => ({ id }),
    send: (id, event) => sendBitrixCutReminder(bitrix, id, event, fetcher),
  });
  const snapshot = makeSnapshot();
  assert.equal((await run(snapshot)).sent, 0);
  await store.withScope(scope => scope.meta(cutReminderRecipientsKey, cutRecipient));
  assert.equal((await run(snapshot)).sent, 2);
  assert.equal((await run(snapshot)).sent, 0);
  assert.deepEqual(messages.map(message => message.DIALOG_ID).sort(), ['42', '43']);
  const roll = messages.find(message => message.DIALOG_ID === '42');
  assert.match(JSON.stringify(roll.ATTACH), /QA0003\.A0788/);
  assert.doesNotMatch(JSON.stringify(roll.ATTACH), /QA0004\.A0789/);
  advance();
  await run(makeSnapshot({ roll: { cutProgress: 20 } }));
  advance();
  assert.equal((await run(makeSnapshot())).sent, 1);
  assert.equal(messages.at(-1).DIALOG_ID, '42');
});

test('revision mismatch and unavailable directory defer the check; an ambiguous send is not replayed', async t => {
  const { store, makeSnapshot } = fixture(t);
  await store.withScope(scope => {
    scope.meta(cutReminderRecipientsKey, { roll: '42', box: null });
    scope.meta('productionSupplyRevision', 1);
  });
  let sends = 0;
  let available = false;
  const run = snapshot => runArkadyCutReminders(store, snapshot, {
    readRecipient: async id => {
      if (!available) throw new Error('Directory unavailable');
      return { id };
    },
    send: async () => {
      sends++;
      throw new Error('Lost acknowledgement');
    },
  });
  await run(makeSnapshot({ revision: 1 }));
  available = true;
  await run(makeSnapshot());
  assert.equal(sends, 0);
  assert.equal((await run(makeSnapshot({ revision: 1 }))).uncertain, 1);
  assert.equal((await run(makeSnapshot({ revision: 1 }))).sent, 0);
  assert.equal(sends, 1);
});

test('confirmed packing from the new assembly journal counts, canceled work does not', async t => {
  const { db, store, makeSnapshot, advance } = fixture(t);
  await store.withScope(scope => scope.meta(cutReminderRecipientsKey, { roll: '42', box: null }));
  const work = makeSnapshot()._assemblyStages.packing.events[0];
  const save = async (id, event) => db.prepare(
    'INSERT INTO assembly_v2_work_events(id,kind,event_id,payload,hash,received_at) VALUES(?,?,?,?,?,?)',
  ).bind(id, event.kind, event.eventId, JSON.stringify(event), id, store.now()).run();
  const snapshot = () => {
    const printing = makeSnapshot();
    printing._assemblyStages.packing.events = [];
    return printing;
  };
  let sent = 0;
  const run = () => runArkadyCutReminders(store, snapshot(), {
    readRecipient: async id => ({ id }),
    send: async () => { sent++; return { status: 'sent' }; },
  });
  await save('work', {
    kind: 'work', eventId: 'pack-new', shipmentId, positionId: work.positionId,
    sku: work.article, qty: 5, operation: 'packing', createdAt: work.createdAt,
  });
  assert.equal((await run()).sent, 1);
  advance();
  await save('canceled', { kind: 'cancel', eventId: 'pack-new' });
  assert.equal((await run()).sent, 0);
  advance();
  await save('new-work', {
    kind: 'work', eventId: 'pack-replacement', shipmentId, positionId: work.positionId,
    sku: work.article, qty: 5, operation: 'packing', createdAt: new Date(store.now()).toISOString(),
  });
  assert.equal((await run()).sent, 1);
  assert.equal(sent, 2);
});
