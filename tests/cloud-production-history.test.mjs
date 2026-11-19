import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudStore } from '../worker/cloud/store.js';
import { DEPARTMENTS, ProductionSupplyService } from '../agent/productionSupplies.js';
import { LocalD1 } from './helpers/d1-sqlite.mjs';
import { cloudSchemaStatements } from './helpers/cloud-schema.mjs';

function fixture(count = 140) {
  const db = new LocalD1();
  db.db.exec(cloudSchemaStatements().join(';\n'));
  const insert = db.db.prepare('INSERT INTO cloud_operations(kind,id,payload,created_at,ordinal) VALUES(?,?,?,?,?)');
  for (let index = 0; index < count; index++) {
    const operation = {
      id: 'history-' + index, action: 'create', status: index % 5 ? 'verified' : 'cancelled',
      shipmentId: 'RITM-ROLL-' + (1000 + index), name: 'OZON historical ' + index,
      requestHash: 'original-' + index, createdAt: '2026-11-01T09:00:00Z', steps: [],
    };
    insert.run('production', operation.id, JSON.stringify(operation), operation.createdAt, index);
  }
  return { db, store: new CloudStore(db) };
}

const historyRows = db => db.db.prepare("SELECT * FROM cloud_operations WHERE kind='production' AND id LIKE 'history-%' ORDER BY ordinal").all();
const current = () => ({
  id: 'current-request', action: 'create', status: 'pending', requestHash: 'same-approved-list',
  createdAt: '2026-11-16T12:00:00Z', shipmentId: 'RITM-ROLL-12345', name: 'OZON current',
  steps: [{department: 'roll', status: 'pending', lines: [{article: 'TEST001', quantity: 10}], plan: {sheetId: 12345, uids: ['original-uid']}}],
});

test('a new supply checkpoints only its own operation after a large production history', async () => {
  const {db, store} = fixture(), before = historyRows(db), id = current().id;
  let externalWrites = 0;
  try {
    await store.withScope(async scope => {
      const operation = current();
      const save = async () => {
        scope.meta('productionSupplyOperations', [...scope.meta('productionSupplyOperations').filter(row => row.id !== id), operation]);
        await scope.checkpoint();
      };
      await save();
      assert.ok(db.db.prepare('SELECT id FROM cloud_operations WHERE id=?').get(id));
      operation.status = 'writing'; operation.steps[0].status = 'writing';
      await save();
      // The external writer is synthetic and may run only after its journal.
      externalWrites++;
      operation.status = 'verified'; operation.steps[0].status = 'verified';
      await save();
      const batch = db.batch.bind(db);
      db.batch = async () => { throw Error('unchanged history must not issue another batch'); };
      scope.meta('productionSupplyOperations', scope.meta('productionSupplyOperations'));
      await scope.checkpoint();
      db.batch = batch;
    });
    assert.equal(externalWrites, 1);
    assert.deepEqual(historyRows(db), before);
    assert.equal(db.db.prepare('SELECT count(*) n FROM cloud_operations WHERE id=?').get(id).n, 1);
    assert.deepEqual(db.db.prepare('SELECT id FROM assembly_v2_supply_deliveries').all().map(row => row.id), ['production:' + id]);
    assert.equal((await store.scope()).meta('productionSupplyOperations').at(-1).status, 'verified');
  } finally { db.close(); }
});

test('the real two-department supply service completes and deduplicates a request with a large D1 history', async () => {
  const {db, store} = fixture(), before = historyRows(db), writes = [];
  try {
    await store.withScope(async scope => {
      let sheetId = 20000;
      const writers = Object.fromEntries(['roll', 'box'].map(department => {
        const sheets = new Map();
        return [department, {
          documentId: DEPARTMENTS[department].documentId,
          async xeroxFormats() { return new Map([["BOX-TEST", { factor: 20, multiplicity: 8 }]]); },
          async prepareCreate(input) { return {...input, action: 'create', sheetId: ++sheetId}; },
          async execute(plan) {
            await scope.checkpoint();
            const saved = JSON.parse(db.db.prepare('SELECT payload FROM cloud_operations WHERE id=?').get(plan.operationId).payload);
            assert.equal(saved.steps.find(step => step.department === department).status, 'writing');
            writes.push(department); sheets.set(plan.sheetId, structuredClone(plan));
          },
          async verify(plan) { assert.ok(sheets.has(plan.sheetId)); return {calculations: []}; },
          async publish(plan, manifest) { await scope.checkpoint(); sheets.get(plan.sheetId).manifest = {...manifest, ready: true}; },
          async manifest(id) { return sheets.get(id)?.manifest || null; },
        }];
      }));
      const service = new ProductionSupplyService(scope, {writers, refreshAfterWrite: false});
      service.catalog = async () => ({
        WB: [['Артикул', 'Вид станка по умолчанию']],
        OZON: [['Артикул', '', 'станок', 'магазин'], ['ROLL-TEST', '', '2-GO', '1'], ['BOX-TEST', '', 'XEROX', '1']],
        extensions: [['Артикул', 'Расширение печати'], ['ROLL-TEST', 'A3']],
      });
      const input = {
        action: 'create', operationId: crypto.randomUUID(), explicitWriteApproval: true, name: 'OZON isolated checkpoint test',
        lines: [{article: 'ROLL-TEST', quantity: 10}, {article: 'BOX-TEST', quantity: 7}],
        planning: {readyAt: '2026-11-19T12:00:00.000Z', packingAt: '2026-11-21T14:00:00.000Z', shipAt: '2026-11-23T07:00:00.000Z'},
      };
      const preview = await service.preview(input);
      const request = {...input, previewId: preview.id, xeroxRounding: [{article: 'BOX-TEST', direction: 'up'}]};
      assert.equal((await service.execute(request)).status, 'verified');
      await scope.checkpoint();
      assert.equal((await service.execute(request)).status, 'verified');
      assert.deepEqual(writes, ['roll', 'box']);
      assert.equal(scope.meta('productionSupplyOperations').length, before.length + 1);
      assert.equal(scope.meta('productionSupplyOperations').at(-1).id, input.operationId);
      assert.deepEqual(scope.meta('productionSupplies')[0].planning, input.planning);
    });
    assert.deepEqual(historyRows(db), before);
    assert.equal(db.db.prepare('SELECT count(*) n FROM assembly_v2_supply_deliveries').get().n, 1);
  } finally { db.close(); }
});

test('resuming an older production operation preserves every other payload and its original ordering evidence', async () => {
  const {db, store} = fixture(), before = historyRows(db);
  try {
    await store.withScope(async scope => {
      const history = scope.meta('productionSupplyOperations'), operation = history[0];
      operation.status = 'verified'; operation.updatedAt = '2026-11-16T12:00:00Z';
      scope.meta('productionSupplyOperations', [...history.slice(1), operation]);
      await scope.checkpoint();
      assert.equal(scope.dirtyOperations.size, 0);
    });
    assert.deepEqual(historyRows(db).filter(row => row.id !== before[0].id), before.slice(1));
    const reloaded = (await store.scope()).meta('productionSupplyOperations');
    assert.deepEqual(reloaded.map(row => row.id), [...before.slice(1).map(row => row.id), before[0].id]);
    assert.equal(reloaded.at(-1).requestHash, 'original-0');
    assert.equal(db.db.prepare('SELECT count(*) n FROM assembly_v2_supply_deliveries').get().n, 1);
  } finally { db.close(); }
});

test('an interrupted current request stays recoverable with its exact identity and does not replay historical work', async () => {
  const {db, store} = fixture(), before = historyRows(db), operation = current();
  try {
    await assert.rejects(store.withScope(async scope => {
      operation.status = 'writing'; operation.steps[0].status = 'writing';
      scope.meta('productionSupplyOperations', [...scope.meta('productionSupplyOperations'), operation]);
      await scope.checkpoint();
      throw Error('lost response');
    }), /lost response/);
    await store.withScope(async scope => { new ProductionSupplyService(scope, {recoverInterrupted: true}); });
    const saved = (await store.scope()).meta('productionSupplyOperations').find(row => row.id === operation.id);
    assert.equal(saved.status, 'partial'); assert.equal(saved.steps[0].status, 'uncertain');
    assert.equal(saved.requestHash, operation.requestHash);
    assert.deepEqual(saved.steps[0].plan, operation.steps[0].plan);
    assert.deepEqual(historyRows(db), before);
    assert.equal(db.db.prepare('SELECT count(*) n FROM cloud_operations WHERE id=?').get(operation.id).n, 1);
    assert.equal(db.db.prepare('SELECT count(*) n FROM assembly_v2_supply_deliveries').get().n, 0);
  } finally { db.close(); }
});

test('an oversized actual change still fails atomically without bypassing the journal batch guard', async () => {
  const {db, store} = fixture(0);
  try {
    await assert.rejects(store.withScope(async scope => {
      for (let index = 0; index < 91; index++) scope.meta('changed-' + index, true);
      await scope.checkpoint();
    }), {code: 'checkpoint_too_large'});
    assert.equal(db.db.prepare('SELECT count(*) n FROM cloud_state').get().n, 0);
  } finally { db.close(); }
});

test('saving one production operation never copies or serializes unrelated history through the cloud metadata adapter', async () => {
  const {db, store} = fixture(), before = historyRows(db);
  try {
    await store.withScope(async scope => {
      const service = new ProductionSupplyService(scope, {recoverInterrupted: false});
      const meta = scope.meta.bind(scope);
      scope.meta = (...args) => {
        assert.notEqual(args[0], 'productionSupplyOperations', 'save must use the single-operation adapter');
        return meta(...args);
      };
      const operation = current();
      service.save(operation);
      await scope.checkpoint();
      operation.status = 'partial';
      service.save(operation);
      await scope.checkpoint();
    });
    assert.deepEqual(historyRows(db), before);
    assert.equal((await store.scope()).meta('productionSupplyOperations').at(-1).status, 'partial');
  } finally { db.close(); }
});

test('interrupted final confirmation becomes resumable without downgrading verified department writes', async () => {
  const {db, store} = fixture(), before = historyRows(db), operation = current();
  operation.status = 'writing'; operation.steps[0].status = 'verified';
  try {
    await store.withScope(async scope => { scope.saveProductionSupplyOperation(operation); });
    await store.withScope(async scope => { new ProductionSupplyService(scope, {recoverInterrupted: true}); });
    const saved = (await store.scope()).meta('productionSupplyOperations').find(row => row.id === operation.id);
    assert.equal(saved.status, 'partial'); assert.match(saved.message, /Требуется завершить/);
    assert.equal(saved.steps[0].status, 'verified');
    assert.deepEqual(saved.steps[0].plan, operation.steps[0].plan);
    assert.deepEqual(historyRows(db), before);
  } finally { db.close(); }
});
