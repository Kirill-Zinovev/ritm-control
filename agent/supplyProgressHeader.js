const column = n => {let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
export function supplyProgressHeaderRequests(sheet, {box=false,newSupply=false,name=sheet.properties.title}={}) {
  const id=sheet.properties.sheetId, count=sheet.properties.gridProperties.rowCount, cols=sheet.properties.gridProperties.columnCount;
  const rows=sheet.data?.[0]?.rowData||[];
  const value=c=>c?.userEnteredValue?.stringValue??c?.effectiveValue?.stringValue??'';
  const headers=(rows[3]?.values||[]).map(c=>value(c).toLowerCase().replace(/\s+/g,' ').trim());
  const find=(names,required=true)=>{const hits=headers.flatMap((v,i)=>names.includes(v)?[i]:[]);if(hits.length!==1&&required)throw new Error('Не подтверждена колонка '+names[0]);return hits.length===1?hits[0]:-1;};
  const quantity=find(['кол-во','количество']),article=find(['артикул']);
  const uid=(rows[0]?.values||[]).findIndex(c=>value(c)==='UID');
  const end=uid>=0?uid:Math.min(cols,29);if(end<16)throw new Error('Недостаточно места для панели');
  const range=c=>`${column(c)}5:${column(c)}${count}`,q=range(quantity),a=range(article);
  const plan=`SUMIF(${a};"<>";${q})`;
  let amounts;
  if(box){
    const pc=newSupply?27:find(['напечатано годных, листы','напечатано годных (xerox — листы, остальные — шт.)'],false),cc=newSupply?28:find(['порезано годных, листы','порезано годных (xerox — листы, остальные — шт.)'],false);
    if(pc>=0&&cc>=0){const machine=range(newSupply?3:find(['станок'])),factor=range(newSupply?6:find(['кол-во листов','количество листов'])),multi=range(newSupply?13:find(['кратность']));amounts=[pc,cc].map(c=>`SUM(ARRAYFORMULA(IF(${a}="";0;IFERROR(${range(c)}*IF(REGEXMATCH(LOWER(TRIM(${machine}));"^(xerox|ксерокс|x|х)$");${multi}/${factor};1);0))))`);}
    else amounts=[find(['готовность печати','завершил печать','завершили печать']),find(['готовность порезки','завершил порезку','завершили порезку'])].map(c=>`SUMPRODUCT(N(${range(c)}=TRUE);${q};N(${a}<>""))`);
  }else amounts=[find(['прогресс печати']),find(['прогресс порезки'])].map(c=>`SUM(ARRAYFORMULA(IF(${a}="";0;IFERROR(IF(REGEXMATCH(TO_TEXT(${range(c)});"%");VALUE(REGEXEXTRACT(TO_TEXT(${range(c)});"([0-9]+[.,]?[0-9]*)%"))/100*${q};IF(ISNUMBER(${range(c)});${range(c)};0));0))))`);
  const top={sheetId:id,startRowIndex:0,endRowIndex:3,startColumnIndex:0,endColumnIndex:end};
  const requests=[{unmergeCells:{range:top}},{repeatCell:{range:top,cell:{},fields:'userEnteredValue'}},{mergeCells:{range:{...top,endRowIndex:1},mergeType:'MERGE_ALL'}}];
  const write=(row,col,v)=>requests.push({updateCells:{start:{sheetId:id,rowIndex:row,columnIndex:col},rows:[{values:[{userEnteredValue:v}]}],fields:'userEnteredValue'}});
  write(0,0,{stringValue:name});
  requests.push({repeatCell:{range:top,cell:{userEnteredFormat:{backgroundColor:{red:1,green:1,blue:1},horizontalAlignment:'LEFT',verticalAlignment:'MIDDLE',textFormat:{fontFamily:'Arial',fontSize:14,foregroundColor:{red:.09,green:.18,blue:.3}},wrapStrategy:'WRAP'}},fields:'userEnteredFormat'}});
  const mid=Math.floor(end/2);
  for(const [i,label,color] of [[0,'ПЕЧАТЬ','#2688FF'],[1,'ПОРЕЗКА','#19AF9A']]){
    const start=i?mid:0,finish=i?end:mid;
    for(const row of [1,2])requests.push({mergeCells:{range:{sheetId:id,startRowIndex:row,endRowIndex:row+1,startColumnIndex:start,endColumnIndex:finish},mergeType:'MERGE_ALL'}});
    write(1,start,{formulaValue:`=IFERROR(IF(${plan}>0;"${label}  "&TEXT(ROUNDDOWN(${amounts[i]}/${plan}*100;1)/100;"0.0%")&CHAR(10)&TO_TEXT(ROUND(${amounts[i]};2))&" из "&TO_TEXT(ROUND(${plan};2))&" шт.";"${label} · нет плана");"${label} · данные не подтверждены")`});
    write(2,start,{formulaValue:`=IFERROR(SPARKLINE(MIN(1;${amounts[i]}/${plan});{"charttype"\\"bar";"max"\\1;"color1"\\"${color}"});"")`});
    requests.push({repeatCell:{range:{sheetId:id,startRowIndex:1,endRowIndex:3,startColumnIndex:start,endColumnIndex:finish},cell:{userEnteredFormat:{backgroundColor:i?{red:.91,green:.98,blue:.96}:{red:.91,green:.95,blue:1},textFormat:{bold:true,fontSize:16}}},fields:'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat'}});
  }
  for(const [row,pixelSize] of [[0,36],[1,64],[2,16]])requests.push({updateDimensionProperties:{range:{sheetId:id,dimension:'ROWS',startIndex:row,endIndex:row+1},properties:{pixelSize},fields:'pixelSize'}});
  return requests;
}
