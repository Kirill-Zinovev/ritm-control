import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { bindings } from "./cloud-env.mjs";
import { cloudSchemaStatements } from "./helpers/cloud-schema.mjs";
import { bridgeSignature } from "../worker/cloud/bridge.js";
import { createHash } from "node:crypto";

test("Sites artifact excludes local filesystem, SQLite and file-backed credentials", () => {
  const graph = JSON.parse(readFileSync(new URL("../.checks/sites-bundle-inputs.json", import.meta.url), "utf8"));
  assert.ok(!Object.keys(graph.inputs).some((name) => /(?:^|\/)worker\/privateGoogleConfig\.js$/.test(name)));
  for (const file of Object.values(graph.outputs)) assert.ok(!file.imports.some((entry) => entry.path.startsWith("node:")));
  assert.ok(!readFileSync(new URL("../dist/server/index.js", import.meta.url), "utf8").includes("intelligence.local.json"));
});

test("real Workers runtime handles cloud owner access and D1 without any local files or Google traffic", async () => {
  let outbound = 0;
  const bridgeSecret = "c".repeat(64);
  const mf = new Miniflare({ modules: true, scriptPath: fileURLToPath(new URL("../dist/server/index.js", import.meta.url)), compatibilityDate: "2026-08-06", d1Databases: ["DB"], bindings: { ...bindings, RITM_OWNER_USER_IDS: "owner-site-id", RITM_GOOGLE_READER_JSON: "{}", RITM_LOCAL_BRIDGE_ID: "local-test", RITM_LOCAL_BRIDGE_SECRET: bridgeSecret }, outboundService: async () => { outbound++; throw new Error("Network forbidden in isolated migration test"); } });
  try {
    const db = await mf.getD1Database("DB");
    for (const statement of cloudSchemaStatements()) await db.prepare(statement).run();
    const anonymous = await mf.dispatchFetch("https://ritm.test/api/printing");
    assert.equal(anonymous.status, 401);
    const identity = await mf.dispatchFetch("https://ritm.test/api/runtime");
    assert.equal((await identity.json()).mode, "cloud");
    const headers = { "oai-authenticated-user-id": "owner-site-id" };
    const status = await mf.dispatchFetch("https://ritm.test/api/roll-supplies/status", { headers });
    assert.equal(status.status, 200);
    const state = await status.json();
    assert.equal(state.mode, "cloud"); assert.equal(state.available, false);
    await db.prepare("INSERT INTO cloud_leases(name,owner,expires_at,fence) VALUES('production','test-owner',?,1)").bind(Date.now() + 30_000).run();
    const active = await mf.dispatchFetch("https://ritm.test/api/roll-supplies/status", { headers });
    const activeState = await active.json();
    assert.equal(activeState.busy, true);
    assert.equal(activeState.production.busy, true);
    await db.prepare("UPDATE cloud_leases SET expires_at=0 WHERE name='production'").run();
    const released = await mf.dispatchFetch("https://ritm.test/api/roll-supplies/status", { headers });
    const releasedState = await released.json();
    assert.equal(releasedState.busy, false);
    assert.equal(releasedState.production.busy, false);
    const responses = await Promise.all(Array.from({ length: 30 }, async () => {
      const response = await mf.dispatchFetch("https://ritm.test/api/assembly-transfers/links", { headers });
      assert.equal(response.status, 200);
      return response.json();
    }));
    for (const response of responses) assert.deepEqual(response.links, []);
    const write = await mf.dispatchFetch("https://ritm.test/api/roll-supplies", { method: "POST", headers: { ...headers, origin: "https://ritm.test", "content-type": "application/json" }, body: "{}" });
    assert.equal(write.status, 403);
    const invalidReconcile=await mf.dispatchFetch('https://ritm.test/api/roll-supplies',{method:'POST',headers:{...headers,origin:'https://ritm.test','content-type':'application/json'},body:JSON.stringify({action:'finalizeDepartmentMove',operationId:'not-an-id'})});
    assert.equal(invalidReconcile.status,400);assert.equal((await invalidReconcile.json()).error,'move_input_invalid');
    const path = "/api/cloud/registry", timestamp = String(Date.now()), nonce = crypto.randomUUID();
    const bridgeHeaders = { "x-ritm-bridge-id": "local-test", "x-ritm-bridge-at": timestamp, "x-ritm-bridge-nonce": nonce, "x-ritm-bridge-signature": bridgeSignature(bridgeSecret, { method: "GET", path, timestamp, nonce }) };
    const registry = await mf.dispatchFetch("https://ritm.test" + path, { headers: bridgeHeaders });
    assert.equal(registry.status, 503); assert.equal((await registry.json()).error, "migration_not_imported");
    const replay = await mf.dispatchFetch("https://ritm.test" + path, { headers: bridgeHeaders });
    assert.equal(replay.status, 409);
    assert.equal(outbound, 0);
  } finally { await mf.dispose(); }
});

test("RITM manager PIN login grants business sections except AI and owner administration", async () => {
  const owner = "owner-site-id";
  const mf = new Miniflare({ modules: true, scriptPath: fileURLToPath(new URL("../dist/server/index.js", import.meta.url)), compatibilityDate: "2026-08-06", d1Databases: ["DB"], bindings: { ...bindings, RITM_OWNER_USER_IDS: owner, RITM_GOOGLE_READER_JSON: "{}" }, outboundService: async () => { throw new Error("Network forbidden in isolated PIN-auth test"); } });
  try {
    const db = await mf.getD1Database("DB");
    for (const statement of cloudSchemaStatements()) await db.prepare(statement).run();
    const anonymous = await mf.dispatchFetch("https://ritm.test/api/runtime");
    const anonymousRuntime = await anonymous.json();
    assert.equal(anonymousRuntime.authenticated, false);
    assert.equal(anonymousRuntime.authorized, false);

    const ownerHeaders = { "oai-authenticated-user-id": owner, origin: "https://ritm.test", "content-type": "application/json" };
    const created = await mf.dispatchFetch("https://ritm.test/api/auth/users", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ username: "manager.test", displayName: "Тестовый менеджер" }) });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    const temporaryPin = createdBody.user.temporaryPin;
    assert.match(temporaryPin, /^\d{8}$/);
    const stored = await db.prepare("SELECT pin_salt,pin_hash FROM ritm_manager_users WHERE id=?").bind(createdBody.user.id).first();
    assert.ok(stored.pin_hash !== temporaryPin);
    assert.ok(stored.pin_salt.length >= 20);

    const invalid = await mf.dispatchFetch("https://ritm.test/api/auth/login", { method: "POST", headers: { origin: "https://ritm.test", "content-type": "application/json" }, body: JSON.stringify({ username: "manager.test", pin: "00000000" }) });
    assert.equal(invalid.status, 401);
    const login = await mf.dispatchFetch("https://ritm.test/api/auth/login", { method: "POST", headers: { origin: "https://ritm.test", "content-type": "application/json" }, body: JSON.stringify({ username: "manager.test", pin: temporaryPin }) });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") || "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = setCookie.split(";")[0];
    assert.match(cookie, /^__Host-ritm_session=/);
    const loginBody = await login.json();
    assert.match(loginBody.sessionToken, /^[A-Za-z0-9_-]{40,50}$/);
    const sessionHeaders = { authorization: `Bearer ${loginBody.sessionToken}` };

    const runtimeBeforePinChange = await mf.dispatchFetch("https://ritm.test/api/runtime", { headers: { cookie } });
    const managerBeforePinChange = await runtimeBeforePinChange.json();
    assert.equal(managerBeforePinChange.role, "manager");
    assert.equal(managerBeforePinChange.mustChangePin, true);
    const runtimeByBearer = await mf.dispatchFetch("https://ritm.test/api/runtime", { headers: sessionHeaders });
    assert.equal((await runtimeByBearer.json()).role, "manager");
    const blockedBeforePinChange = await mf.dispatchFetch("https://ritm.test/api/roll-supplies/status", { headers: { cookie } });
    assert.equal(blockedBeforePinChange.status, 403);

    const changed = await mf.dispatchFetch("https://ritm.test/api/auth/change-pin", { method: "POST", headers: { cookie, origin: "https://ritm.test", "content-type": "application/json" }, body: JSON.stringify({ newPin: "87654321" }) });
    assert.equal(changed.status, 200);
    const forecast=await mf.dispatchFetch('https://ritm.test/api/production-planning',{headers:sessionHeaders});assert.equal(forecast.status,200);
    const forbiddenRates=await mf.dispatchFetch('https://ritm.test/api/production-planning',{method:'POST',headers:{...sessionHeaders,origin:'https://ritm.test','content-type':'application/json'},body:JSON.stringify({action:'resources',revision:0,resources:[]})});assert.equal(forbiddenRates.status,403);assert.equal((await forbiddenRates.json()).error,'planning_owner_required');

    const runtime = await mf.dispatchFetch("https://ritm.test/api/runtime", { headers: { cookie } });
    const manager = await runtime.json();
    assert.equal(manager.authorized, true);
    const deniedReconcile=await mf.dispatchFetch('https://ritm.test/api/roll-supplies',{method:'POST',headers:{...sessionHeaders,origin:'https://ritm.test','content-type':'application/json'},body:JSON.stringify({action:'finalizeDepartmentMove',operationId:crypto.randomUUID()})});
    assert.equal(deniedReconcile.status,403);
    assert.equal((await mf.dispatchFetch('https://ritm.test/api/roll-supplies/status?stockRollPanelHealth=1',{headers:sessionHeaders})).status,403);assert.equal((await deniedReconcile.json()).error,'owner_required');
    assert.equal(manager.mustChangePin, false);

    await db.prepare("INSERT INTO cloud_state(key,value,updated_at) VALUES('migrationReady','true',?)").bind(Date.now()).run();
    assert.equal((await mf.dispatchFetch("https://ritm.test/api/roll-supplies/status", { headers: { cookie } })).status, 200);
    assert.equal((await mf.dispatchFetch("https://ritm.test/api/roll-supplies/status", { headers: sessionHeaders })).status, 200);
    assert.equal((await mf.dispatchFetch("https://ritm.test/api/cloud/registry", { headers: sessionHeaders })).status, 200);
    assert.equal((await mf.dispatchFetch("https://ritm.test/api/assembly-transfers/links", { headers: sessionHeaders })).status, 200);
    const moves = await mf.dispatchFetch("https://ritm.test/api/production-moves?id=missing", {headers:sessionHeaders});
    assert.equal(moves.status,200);
    const bulkMoves=await mf.dispatchFetch('https://ritm.test/api/production-moves/batch?shipmentId=synthetic&sourceDepartment=box',{headers:sessionHeaders});
    assert.equal(bulkMoves.status,200);assert.equal((await bulkMoves.json()).batch,null);
    const bulkPost=await mf.dispatchFetch('https://ritm.test/api/production-moves/batch',{method:'POST',headers:{...sessionHeaders,origin:'https://ritm.test','content-type':'application/json'},body:'{}'});
    assert.equal(bulkPost.status,403);assert.equal((await bulkPost.json()).error,'cloud_write_disabled');
    assert.equal((await mf.dispatchFetch('https://ritm.test/api/production-moves/batch?id=missing')).status,401);
    const batch = await mf.dispatchFetch("https://ritm.test/api/warehouse/dispatch/batch", {method:"POST",headers:{...sessionHeaders,origin:"https://ritm.test","content-type":"application/json"},body:JSON.stringify({cartons:[]})});
    assert.equal(batch.status,400);
    assert.equal((await batch.json()).error,"warehouse_dispatch_invalid");
    const anonymousMove = await mf.dispatchFetch("https://ritm.test/api/production-moves?id=missing");
    assert.equal(anonymousMove.status,401);
    const assemblyAccess = await mf.dispatchFetch("https://ritm.test/api/assembly", { headers: { cookie } });
    assert.notEqual(assemblyAccess.status, 403);
    assert.notEqual((await assemblyAccess.json()).error, "manager_route_forbidden");
    for (const path of ["/api/cloud/state", "/api/intelligence/status", "/api/auth/users", "/api/bitrix-settings"]) {
      const denied = await mf.dispatchFetch("https://ritm.test" + path, { headers: { cookie } });
      assert.equal(denied.status, 403, path);
      const bearerDenied = await mf.dispatchFetch("https://ritm.test" + path, { headers: sessionHeaders });
      assert.equal(bearerDenied.status, 403, path);
    }
    for (const path of ['/api/bitrix-settings','/api/bitrix-setup','/api/bitrix-setup/test','/api/bitrix-setup/avatar']) {
      const denied = await mf.dispatchFetch('https://ritm.test'+path,{method:'POST',headers:{...sessionHeaders,origin:'https://ritm.test','content-type':'application/json'},body:'{}'});
      assert.equal(denied.status,403,path);
    }
    const supplyPreview = await mf.dispatchFetch("https://ritm.test/api/roll-supplies/preview", { method: "POST", headers: { ...sessionHeaders, origin: "https://ritm.test", "content-type": "application/json" }, body: JSON.stringify({}) });
    const previewResult = await supplyPreview.json();
    assert.equal(previewResult.ok, false);
    assert.notEqual(previewResult.error, "manager_route_forbidden");
    assert.notEqual(previewResult.error, "authentication_required");

    const disabled = await mf.dispatchFetch(`https://ritm.test/api/auth/users/${createdBody.user.id}/status`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ status: "disabled" }) });
    assert.equal(disabled.status, 200);
    const afterDisable = await mf.dispatchFetch("https://ritm.test/api/runtime", { headers: { cookie } });
    const disabledRuntime = await afterDisable.json();
    assert.equal(disabledRuntime.authorized, false);
    const bearerAfterDisable = await mf.dispatchFetch("https://ritm.test/api/runtime", { headers: sessionHeaders });
    assert.equal((await bearerAfterDisable.json()).authorized, false);
  } finally { await mf.dispose(); }
});
test('owner-only stock panel health exercises the authenticated read path without exposing credentials or making a production write',async()=>{
 const token='SYNTHETIC_HEALTH_TOKEN_0000000000000000000';let calls=0;
 const mf=new Miniflare({modules:true,scriptPath:fileURLToPath(new URL('../dist/server/index.js',import.meta.url)),compatibilityDate:'2026-08-06',d1Databases:['DB'],bindings:{...bindings,RITM_OWNER_USER_IDS:'owner-site-id',RITM_GOOGLE_READER_JSON:'{}',RITM_STOCK_ROLL_GATEWAY_URL:'https://script.google.com/macros/s/SYNTHETIC_HEALTH_00000000000/exec',RITM_STOCK_ROLL_GATEWAY_TOKEN:token},outboundService:async request=>{calls++;const body=await request.json();assert.equal(body.action,'health');assert.equal(body.token,token);assert.equal(body.entries,undefined);return Response.json({ok:true,status:'ready',token:'DO_NOT_RETURN',panelCheck:[{sheetId:7,status:'ready',article:'SYNTHETIC',quantity:32,rolls:2,printed:32,cut:0,internal:'DO_NOT_RETURN'}]});}});
 try{const db=await mf.getD1Database('DB');for(const statement of cloudSchemaStatements())await db.prepare(statement).run();
 const path='https://ritm.test/api/roll-supplies/status?stockRollPanelHealth=1';assert.equal((await mf.dispatchFetch(path)).status,401);assert.equal(calls,0);
 const result=await mf.dispatchFetch(path,{headers:{'oai-authenticated-user-id':'owner-site-id'}});assert.equal(result.status,200);const response=await result.json();assert.equal(response.panelCheck[0].rolls,2);assert.ok(!JSON.stringify(response).includes('DO_NOT_RETURN'));assert.ok(!JSON.stringify(response).includes(token));assert.equal(calls,1);
 }finally{await mf.dispose();}
});


test('forecast settings persist in isolated D1 with origin checks and revision safety; no Google requests',async()=>{
  let outbound=0;
  const mf=new Miniflare({modules:true,scriptPath:fileURLToPath(new URL('../dist/server/index.js',import.meta.url)),compatibilityDate:'2026-08-06',d1Databases:['DB'],bindings:{...bindings,RITM_OWNER_USER_IDS:'owner-site-id',RITM_GOOGLE_READER_JSON:'{}'},outboundService:async()=>{outbound++;throw new Error('Network forbidden');}});
  try {
    const db=await mf.getD1Database('DB');for(const sql of cloudSchemaStatements())await db.prepare(sql).run();
    const headers={'oai-authenticated-user-id':'owner-site-id',origin:'https://ritm.test','content-type':'application/json'},url='https://ritm.test/api/production-planning';
    assert.equal((await mf.dispatchFetch(url)).status,401);
    const initial=await mf.dispatchFetch(url,{headers});assert.equal(initial.status,200);assert.equal((await initial.json()).planning.revision,0);
    const body=JSON.stringify({action:'resources',revision:0,resources:[{id:'xerox',rate:100,unit:'sheets',days:[1,2,3,4,5],start:540,end:1080}]});
    const cross=await mf.dispatchFetch(url,{method:'POST',headers:{...headers,origin:'https://evil.test'},body});assert.equal(cross.status,403);
    const responses=await Promise.all([1,2].map(()=>mf.dispatchFetch(url,{method:'POST',headers,body})));assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
    const final=await (await mf.dispatchFetch(url,{headers})).json();assert.equal(final.planning.revision,1);assert.equal(final.planning.resources[0].rate,100);
    const automatic=await mf.dispatchFetch(url,{method:'POST',headers,body:JSON.stringify({action:'resources',revision:1,resources:[{...final.planning.resources[0],rate:0,rateMode:'auto'}]})});
    assert.equal(automatic.status,200);assert.equal((await automatic.json()).planning.resources[0].rateMode,'auto');
    const manual=await mf.dispatchFetch(url,{method:'POST',headers,body:JSON.stringify({action:'resources',revision:2,resources:[{...final.planning.resources[0],rate:150,rateMode:'manual'}]})});
    assert.equal(manual.status,200);assert.equal((await manual.json()).planning.resources[0].rate,150);
    const snapshotText=JSON.stringify({supplies:[{sourceId:'roll-printing',spreadsheetId:'book',sheetId:5,rawUid:'uid',article:'SKU',quantity:10,printProgress:10,cutProgress:0,packed:5,packingEventIds:['event-1']}]});
    const hash=createHash('sha256').update(snapshotText).digest('hex');
    await db.prepare('INSERT INTO cloud_snapshots(kind,generation,updated_at,chunks,digest) VALUES(?,?,?,?,?)').bind('printing','generation',Date.now(),1,hash).run();
    await db.prepare('INSERT INTO cloud_snapshot_chunks(kind,generation,ordinal,payload) VALUES(?,?,?,?)').bind('printing','generation',0,snapshotText).run();
    const stockBody=JSON.stringify({action:'packing-stock',revision:3,taskId:'book:5:uid',article:'SKU',quantity:5});
    const source=await mf.dispatchFetch(url,{method:'POST',headers,body:stockBody});assert.equal(source.status,200);
    const sourceResult=await source.json();assert.equal(sourceResult.planning.stockSources[0].quantity,5);assert.deepEqual(sourceResult.planning.stockSources[0].packingEventIds,['event-1']);
    const cut=await mf.dispatchFetch(url,{method:'POST',headers,body:JSON.stringify({action:'cut-confirmation',revision:4,taskId:'book:5:uid',article:'SKU',quantity:10})});
    assert.equal(cut.status,200);const confirmed=(await cut.json()).planning;assert.equal(confirmed.cutConfirmations[0].quantity,10);assert.equal(confirmed.cutConfirmations[0].sourcePlan,10);
    await db.prepare("UPDATE cloud_snapshots SET updated_at=? WHERE kind='printing'").bind(Date.now()-16*60000).run();
    const stale=await mf.dispatchFetch(url,{method:'POST',headers,body:JSON.stringify({action:'packing-stock',revision:5,taskId:'book:5:uid',article:'SKU',quantity:5})});assert.equal(stale.status,409);
    assert.equal(outbound,0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM cloud_operations').first()).n,0);
    const extra={id:'qa-extra',shipmentId:'RITM-ROLL-1',positionId:'RITM-ROLL-1|manual:qa|SKU',article:'SKU',quantity:12,createdAt:'2026-11-13T10:00:00.000Z',comment:'private comment'};
    await db.prepare('INSERT INTO cloud_operations(kind,id,payload,created_at,ordinal) VALUES(?,?,?,?,?)').bind('assembly-only-item',extra.id,JSON.stringify(extra),extra.createdAt,1).run();
    const withExtra=await (await mf.dispatchFetch(url,{headers})).json();
    assert.equal(withExtra.extraItemsConfirmed,true);assert.equal(withExtra.extraItems.length,1);assert.equal(withExtra.extraItems[0].quantity,12);assert.equal(withExtra.extraItems[0].comment,undefined);
    await db.prepare("UPDATE cloud_leases SET expires_at=? WHERE name='production'").bind(Date.now()+60000).run();
    const busy=await (await mf.dispatchFetch(url,{headers})).json();assert.equal(busy.extraItemsConfirmed,false);
  }finally{await mf.dispose();}
});

test('stock source validates the same Assembly v2 work and cancellations as the forecast',async()=>{
  let outbound=0;
  const mf=new Miniflare({modules:true,scriptPath:fileURLToPath(new URL('../dist/server/index.js',import.meta.url)),compatibilityDate:'2026-08-06',d1Databases:['DB'],bindings:{...bindings,RITM_OWNER_USER_IDS:'owner-site-id',RITM_GOOGLE_READER_JSON:'{}'},outboundService:async()=>{outbound++;throw new Error('Network forbidden');}});
  try {
    const db=await mf.getD1Database('DB');for(const sql of cloudSchemaStatements())await db.prepare(sql).run();
    const headers={'oai-authenticated-user-id':'owner-site-id',origin:'https://ritm.test','content-type':'application/json'},url='https://ritm.test/api/production-planning';
    const snapshot={supplies:[{sourceId:'roll-printing',spreadsheetId:'book',sheetId:10,rawUid:'one',row:5,article:'SKU',quantity:20,packed:0,packingEventIds:[]}],_assemblyStages:{packing:{events:[],invalid:[]},cut:{events:[],invalid:[]},assembly:{events:[],invalid:[]},checkedAt:new Date().toISOString()}};
    const payload=JSON.stringify(snapshot),digest=createHash('sha256').update(payload).digest('hex');
    await db.prepare('INSERT INTO cloud_snapshots(kind,generation,updated_at,chunks,digest) VALUES(?,?,?,?,?)').bind('printing','generation',Date.now(),1,digest).run();
    await db.prepare('INSERT INTO cloud_snapshot_chunks(kind,generation,ordinal,payload) VALUES(?,?,?,?)').bind('printing','generation',0,payload).run();
    const id='av2:00000000-0000-4000-8000-000000000001', shipmentId='RITM-ROLL-10';
    const work={id,kind:'work',eventId:id,shipmentId,positionId:shipmentId+'|uid:one|SKU',sku:'SKU',employeeId:'emp-001',employee:'Тест',operation:'packing',qty:24,coefficient:null,norm:null,createdAt:new Date().toISOString()};
    const insert=async event=>{const value=JSON.stringify(event);await db.prepare('INSERT INTO assembly_v2_work_events(id,kind,event_id,payload,hash,received_at) VALUES(?,?,?,?,?,?)').bind(event.id,event.kind,event.eventId,value,createHash('sha256').update(value).digest('hex'),Date.now()).run();};
    await insert(work);
    const body={action:'packing-stock',revision:0,taskId:'book:10:one',article:'SKU',quantity:24};
    const saved=await mf.dispatchFetch(url,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(saved.status,200);
    const state=(await saved.json()).planning;assert.equal(state.stockSources[0].quantity,24);assert.deepEqual(state.stockSources[0].packingEventIds,[id]);
    await insert({id:'av2:cancel:00000000-0000-4000-8000-000000000002',kind:'cancel',eventId:id,reason:'test',createdAt:new Date().toISOString()});
    const cancelled=await mf.dispatchFetch(url,{method:'POST',headers,body:JSON.stringify({...body,revision:1})});assert.equal(cancelled.status,409);
    const final=(await (await mf.dispatchFetch(url,{headers})).json()).planning;assert.equal(final.stockSources.length,1);
    const oldSnapshot=JSON.stringify({supplies:snapshot.supplies});
    await db.prepare("UPDATE cloud_snapshots SET digest=? WHERE kind='printing'").bind(createHash('sha256').update(oldSnapshot).digest('hex')).run();
    await db.prepare("UPDATE cloud_snapshot_chunks SET payload=? WHERE kind='printing' AND generation='generation' AND ordinal=0").bind(oldSnapshot).run();
    const missingEvidence=await mf.dispatchFetch(url,{method:'POST',headers,body:JSON.stringify({...body,revision:1,quantity:0})});
    assert.equal(missingEvidence.status,409);assert.equal((await missingEvidence.json()).error,'planning_stock_source_stale');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cloud_operations").first()).n,0);assert.equal(outbound,0);
  }finally{await mf.dispose();}
});
