import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
function fixture(department){const cells=Array(30).fill(''),formulas=Array(30).fill('');cells[3]='XEROX';cells[4]='A1';cells[6]=1;cells[13]=1;cells[15]=20;cells[27]=20;cells[28]=20;cells[29]='uid';formulas[24]='=remaining';let metadata=true, archiveRows=[],propsData=new Map();const range=(row,col)=>({getValues:()=>[cells],getFormulas:()=>[formulas],getValue:()=>cells[col-1],clearContent:()=>{cells[col-1]='';formulas[col-1]='';},getDeveloperMetadata:()=>metadata?[{getKey:()=>'RITM_BOX_POSITION',getValue:()=>'box-id',remove:()=>{metadata=false}}]:[]});const sheet={getName:()=>'Срочные 2 этаж',getMaxRows:()=>50,getLastColumn:()=>30,getRange:range};const archive={appendRow:r=>archiveRows.push(r),getLastRow:()=>archiveRows.length,getRange:(row)=>({getValues:()=>[archiveRows[row-1]],getValue:()=>archiveRows[row-1][0]}),hideSheet(){}};const book={getSheetById:()=>sheet,getSheetByName:()=>archiveRows.length?archive:null,insertSheet:()=>archive};const props={getProperty:k=>k==='BOX_STOCK_SOURCE_ID'?'box':propsData.get(k)||null,setProperty:(k,v)=>propsData.set(k,v)};const ctx={JSON,Number,String,Array,Date,Error,SpreadsheetApp:{openById:()=>book,setActiveSpreadsheet(){},flush(){}},boxLocked_:f=>f(),withDocumentLock_:f=>f(),r2GetOrder_:()=>({}),r2RollsForOrder_:()=>[{}],r2Progress_:()=>({complete:true})};vm.runInNewContext(readFileSync(new URL('../apps-script/stock-gateway/StockCloseGateway.gs',import.meta.url),'utf8'),ctx);return {ctx,cells,formulas,archiveRows,props,get metadata(){return metadata}}}
for(const department of ['box','roll'])test(`${department}: archive preserves identity, cleans active row and is idempotent`,()=>{const f=fixture(department),input={operationId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',uid:'uid',article:'A1',row:5,quantity:20,sheetId:7};const r=f.ctx.stockCloseGateway_(input,f.props,department);assert.equal(r.status,'verified');assert.equal(f.cells[4],'');assert.equal(f.cells[15],'');assert.equal(f.cells[29],'');assert.equal(f.formulas[24],'=remaining');assert.equal(f.archiveRows.length,2);if(department==='box'){assert.equal(f.metadata,false);assert.match(f.archiveRows[1][7],/box-id/)}assert.equal(f.ctx.stockCloseGateway_(input,f.props,department).status,'verified');assert.equal(f.archiveRows.length,2)});
test('a changed plan or incomplete work never touches source or archive',()=>{const f=fixture('box'),input={operationId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',uid:'uid',article:'A1',row:5,quantity:20,sheetId:7};f.cells[28]=19;assert.throws(()=>f.ctx.stockCloseGateway_(input,f.props,'box'),/не подтверждены/);assert.equal(f.cells[4],'A1');assert.equal(f.archiveRows.length,0)});

function batchFixture() {
  const plans=[], rows=[], formulas=[], propsData={};
  const archiveData=[['Операция','Дата','Лист','Строка','UID','Артикул','План','Данные строки']];
  const calls={locks:0,archiveWrites:0,clear:0,props:0,flush:0,rollReads:0};
  for(let i=0;i<12;i++){
    const cells=Array(30).fill(''), formula=Array(30).fill('');
    const item={operationId:`aaaaaaaa-aaaa-4aaa-aaaa-${String(i).padStart(12,'0')}`,sheetId:7,destination:'urgent',row:i+5,uid:`uid-${i}`,article:`A-${i}`,quantity:20};
    Object.assign(cells,{3:'XEROX',4:item.article,6:1,13:1,15:20,27:20,28:20,29:item.uid});
    formula[24]='=remaining';
    plans.push(item);rows.push(cells);formulas.push(formula);
  }
  const sheet={
    getName:()=>'Срочные 2 этаж',getLastColumn:()=>30,getMaxRows:()=>50,
    getRange:(first,col,length,width)=>typeof first==='string'?{getDeveloperMetadata:()=>[]} : {
      getValues:()=>rows.slice(first-5,first-5+length).map(row=>row.slice(col-1,col-1+width)),
      getFormulas:()=>formulas.slice(first-5,first-5+length).map(row=>row.slice(col-1,col-1+width)),
    },
    getRangeList:cells=>({clearContent(){
      assert.equal(archiveData.length,13);
      calls.clear++;
      for(const cell of cells){
        const [,label,row]=cell.match(/^([A-Z]+)([0-9]+)$/);
        const col=[...label].reduce((value,char)=>26*value+char.charCodeAt(0)-64,0);
        rows[Number(row)-5][col-1]='';
      }
    }}),
  };
  const archive={
    getLastRow:()=>archiveData.length,getMaxRows:()=>100,
    getRange:(first,_col,length)=>({
      getValues:()=>archiveData.slice(first-1,first-1+length),
      setValues(values){calls.archiveWrites++;archiveData.push(...values);},
    }),
  };
  const book={getSheetById:()=>sheet,getSheetByName:()=>archive};
  const props={getProperty:()=> 'book',getProperties:()=>({...propsData}),setProperties(values){calls.props++;Object.assign(propsData,values);}};
  const lock=callback=>{calls.locks++;return callback();};
  const ctx={SpreadsheetApp:{openById:()=>book,setActiveSpreadsheet(){},flush(){calls.flush++;}},boxLocked_:lock,withDocumentLock_:lock,
    r2ReadStore_:()=>{calls.rollReads++;return [];},r2ProgressRows_:()=>[],r2JournalRows_:()=>[],r2HeaderMap_:()=>({}),
    r2OrderFromValues_:(_sheet,_row,_header,cells)=>({uid:cells[29],article:cells[4],orderQty:cells[15]}),
    r2RollsForOrder_:()=>[{}],r2Progress_:()=>({complete:true}),
  };
  vm.runInNewContext(readFileSync(new URL('../apps-script/stock-gateway/StockCloseGateway.gs',import.meta.url),'utf8'),ctx);
  return {ctx,props,plans,calls,rows,formulas,archiveData};
}

for(const department of ['box','roll'])test(department+' archives 12 rows with two flushes and groups the clear',()=>{
  const f=batchFixture(),run=()=>f.ctx.stockCloseBatchGateway_({tasks:f.plans},f.props,department);
  assert.ok(run().results.every(result=>result.status==='verified'));
  assert.deepEqual(f.calls,{locks:1,archiveWrites:1,clear:1,props:2,flush:2,rollReads:department==='roll'?1:0});
  assert.ok(f.rows.every(row=>row[4]===''&&row[15]===''&&row[29]===''));
  assert.ok(f.formulas.every(row=>row[24]==='=remaining'));
  assert.ok(run().results.every(result=>result.status==='verified'));
  assert.equal(f.archiveData.length,13);
  assert.equal(f.calls.archiveWrites,1);
});

test('changed plans skipped before archive, and no stale position is cleared',()=>{
  const f=batchFixture();
  f.rows[0][15]=21;
  const result=f.ctx.stockCloseBatchGateway_({tasks:[f.plans[0]]},f.props,'box');
  assert.equal(result.results[0].status,'not_saved');
  assert.equal(f.rows[0][4],f.plans[0].article);
  assert.equal(f.calls.archiveWrites,0);
  assert.equal(f.calls.clear,0);
});
