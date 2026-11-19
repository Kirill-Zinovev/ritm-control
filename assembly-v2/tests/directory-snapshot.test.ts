import test from "node:test";
import assert from "node:assert/strict";
import {openDatabase} from "../server/local-db";
import {api} from "../server/api";
import {bootstrap} from "./fixtures";
import type {Snapshot} from "../shared/model";

test("manager directory read keeps filters and does not load carton contents; collector cannot opt into it",async()=>{
  const db=await openDatabase();
  try {
    const {employee,state}=await bootstrap(db);
    const request=new Request("https://local/api/state?cartons=directory");
    const light=await (await api(request,db,"manager","manager")).json() as Snapshot;
    assert.equal(light.cartonScope,"directory");
    assert.equal(light.employees.find(e=>e.id===employee.id)?.name,employee.name);
    assert.deepEqual(light.supplies.map(s=>s.id),state.supplies.map(s=>s.id));
    assert.deepEqual(light.positions,[]);
    assert.deepEqual(light.cartons,[]);
    const collector=await (await api(request,db,"worker","collector")).json() as Snapshot;
    assert.equal(collector.cartonScope,"supply");
    assert.equal(collector.positions.length,state.positions.length);
    const response=await api(new Request("https://local/api/command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({key:crypto.randomUUID(),action:"employee.create",payload:{name:"Локальная проверка"},supplyId:null,cartonScope:"directory"})}),db,"owner");
    const result=await response.json() as {state:Snapshot};
    assert.equal(response.status,200);
    assert.equal(result.state.cartonScope,"directory");
    assert.ok(result.state.employees.some(e=>e.name==="Локальная проверка"));
    assert.equal(result.state.revision,light.revision+1);
  } finally {db.sqlite.close();}
});
