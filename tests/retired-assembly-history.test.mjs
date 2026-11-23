import test from "node:test";
import assert from "node:assert/strict";
import { archivedPositionHasWork } from "../worker/cloud/assemblyOnlyDelivery.js";
import { forecastStocks } from "../worker/cloud/assemblyStock.js";

test("manual removal checks both archived identity columns and fails closed on schema change", async () => {
  const ranges = ["WorkLog!F1:F20","CartonContents!E1:E40"].map(range=>({range,values:[["positionId"]]}));
  const reader = {request: async()=>Response.json({spreadsheetId:"archive",valueRanges:ranges})};
  assert.equal(await archivedPositionHasWork(reader,"archive","target"),false);
  ranges[1].values.push(["target"]);
  assert.equal(await archivedPositionHasWork(reader,"archive","target"),true);
  ranges[0].values = [["sku"]];
  await assert.rejects(archivedPositionHasWork(reader,"archive","target"));
});

test("forecast stocks reuse the original timestamp and a forced read observes a new value",async()=>{
  const old={updatedAt:new Date(1000000).toISOString(),items:[]}, fresh={...old,items:["new"]};
  let reads=0, saved;
  const store={snapshot:async()=>({at:1000000,value:old}),now:()=>1010000,acquire:async()=>({}),release:async()=>{},saveSnapshot:async(k,v)=>{saved=v;}};
  const load=async()=>{reads++;return fresh;};
  assert.equal(await forecastStocks(store,load,null,false),old);
  assert.equal(reads,0);
  assert.equal(await forecastStocks(store,load,null,true),fresh);
  assert.equal(saved,fresh);
});
