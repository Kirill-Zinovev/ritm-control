import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudApi } from '../worker/cloud/runtime.js';
import { CloudStore } from '../worker/cloud/store.js';
import { LocalD1 } from './helpers/d1-sqlite.mjs';
import { cloudSchemaStatements } from './helpers/cloud-schema.mjs';
import { bindings } from './cloud-env.mjs';

test('routed and single-position requests avoid pulling the full reporting snapshot into a write', async () => {
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(';\n'));
  const store = new CloudStore(db), snapshot = CloudStore.prototype.snapshot;
  const env = {...bindings, DB:db, RITM_OWNER_USER_IDS:'owner', RITM_GOOGLE_READER_JSON:'{}', RITM_GOOGLE_WRITER_JSON:'{}', RITM_CLOUD_WRITES_ENABLED:'true', RITM_CLOUD_CUTOVER_ID:'memory-test',RITM_ASSEMBLY_V2_TARGET_URL:'https://assembly-v2.zinovevkirill234.chatgpt.site',RITM_ASSEMBLY_V2_TARGET_TOKEN:'synthetic'};
  let snapshots = 0, externalCalls = 0;
  try {
    await store.withScope(async scope => {
      scope.meta('migrationReady', true);
      scope.meta('cloudCutover', {id:'memory-test', localWriterDisabled:true});
    });
    CloudStore.prototype.snapshot = async kind => {
      assert.equal(kind, 'printing'); snapshots++;
      return {at:Date.now(), value:{ok:true, supplies:[]}};
    };
    const request = (path, input) => new Request('https://ritm.test' + path, {method:'POST', headers:{'oai-authenticated-user-id':'owner', origin:'https://ritm.test', 'content-type':'application/json'}, body:JSON.stringify(input)});
    const fetcher = async () => { externalCalls++; throw Error('No external calls for invalid isolated requests'); };
    await db.prepare('INSERT INTO assembly_v2_supply_deliveries(id,shipment_id,created_at) VALUES(?,?,?)').bind('old-pending','RITM-ROLL-123',Date.now()).run();
    const tasks=[];
    const resumed = await cloudApi(request('/api/roll-supplies', {action:'resume', operationId:crypto.randomUUID(), explicitWriteApproval:true}), env, {waitUntil:task=>tasks.push(task)}, {fetcher});
    await Promise.all(tasks);
    assert.equal(tasks.length,0,'a source mutation cannot also launch a background report or delivery scan');
    assert.equal(resumed.status, 404);
    assert.equal((await resumed.json()).error, 'production_operation_missing');
    assert.equal(snapshots, 0);
    await cloudApi(request('/api/roll-supplies/preview', {}), env, {}, {fetcher});
    assert.equal(snapshots, 0);
    await cloudApi(request('/api/roll-supplies', {action:'updateItem'}), env, {}, {fetcher});
    assert.equal(snapshots, 0);
    assert.equal(externalCalls, 0);
    assert.equal(db.db.prepare('SELECT count(*) n FROM cloud_operations').get().n, 0);
  } finally { CloudStore.prototype.snapshot = snapshot; db.close(); }
});

test('parallel routing previews persist separately under an occupied production lease', async () => {
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(';\n'));
  const store = new CloudStore(db), lease = await store.acquire();
  try {
    const save = id => store.withRoutingPreview(async scope => {
      scope.saveTransferPreview('production:' + id, Date.now() + 600000, JSON.stringify({ id }));
      return { id };
    });
    await Promise.all([save('preview-a'), save('preview-b')]);
    const rows = await db.prepare('SELECT id FROM cloud_transfer_previews ORDER BY id').all();
    assert.deepEqual(rows.results.map(row => row.id), ['production:preview-a', 'production:preview-b']);
    await assert.rejects(store.withScope(() => assert.fail('callback ran'), { reportAdmission: true }), { code:'supply_writer_occupied' });
    assert.equal(await store.leaseIsActive('production'), true);
  } finally { await store.release(lease); db.db.close(); }
});
