import test from "node:test";
import assert from "node:assert/strict";
import type { Carton } from "../shared/model";
import {filterWarehouseCartons,warehouseCity} from "../shared/warehouse-filter";
import {accountWorkbook,readTemplate} from "../src/exports/excel";
function carton(id:string,destination:string,store="1",market:"OZON"|"WB"="OZON"):Carton {
  return {id,label:id,market,store,destination,state:"closed",dispatchId:null,dispatchState:null,createdAt:"2026-11-17T06:00:00Z",closedAt:"2026-11-17T07:00:00Z",fill:0.1,qty:10,
    items:[{id:"i"+id,positionId:"p"+id,supplyId:"s"+id,supply:destination,externalSupplyId:"RITM-"+id,externalPositionId:"UID-"+id,sku:"0001",name:"Товар",barcode:"0012345678901",qty:10,unitsPerBox:100}]};
}
test("city filters include only matching closed unsent cartons; Excel preserves scope, contents and barcode text",async()=>{
 const boxes=[carton("1мос1","OZON Москва 17.11.2026"),carton("2мос1","OZON МОСКВА","2"),carton("1мос2","WB Москва","1","WB"),carton("1каз1","OZON Казань"),{...carton("open","OZON Москва"),state:"open" as const},{...carton("sent","OZON Москва"),dispatchId:"departed"}];
 const before=JSON.stringify(boxes),filters={market:"",store:"",query:"",city:"MOSCOW"};
 const city=filterWarehouseCartons(boxes,filters);assert.equal(city.length,3);
 assert.equal(filterWarehouseCartons(boxes,{...filters,market:"OZON",store:"2"})[0].id,"2мос1");
 assert.equal(filterWarehouseCartons(boxes,{...filters,query:"0001"}).length,3);
 assert.notEqual(warehouseCity(carton("a","Индивидуальный А")).key,warehouseCity(carton("b","Индивидуальный Б")).key);
 const wb=accountWorkbook({createdAt:"2026-11-17T08:00:00Z",payload:{cartons:city}});
 const loaded=await readTemplate(await wb.xlsx.writeBuffer() as ArrayBuffer);
 assert.equal(loaded.getWorksheet("Короба")!.rowCount,4);
 const contents=loaded.getWorksheet("Состав")!;assert.equal(contents.rowCount,4);
 assert.equal(contents.getCell("G2").value,"0012345678901");assert.equal(contents.getCell("G2").numFmt,"@");
 assert.equal(loaded.getWorksheet("Сводка")!.rowCount,4);
 assert.equal(JSON.stringify(boxes),before,"a report never prepares or sends cartons");
});
