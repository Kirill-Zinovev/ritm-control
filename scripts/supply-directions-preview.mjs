// Local-only design fixture. No credentials, API calls or production writes.
import {createServer} from 'vite';
async function servePreview(_req,res){
  const html=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RITM · Направления · тест</title></head><body><div id="root"></div><script type="module">
import React from 'react';import{createRoot}from'react-dom/client';import{SupplyDirections}from'/src/SupplyDirections.tsx';import'/src/styles.css';
const make=(id,name,shop,plan,packed,cut,manual,lock='open')=>({id,name,lock,missingPositions:0,orders:[{uid:id+'-a',rawUid:id+'-a',row:5,sheetId:1,sheetName:name,article:id==='job-1'?'NT0006.A4692':'SKU-'+id,quantity:plan,plannedArea:20,shop,shopCatalogStatus:'matched',sourceId:'roll-printing',packed,assemblyMachineCut:cut,assemblyManualCut:manual}]});
const jobs=[make('job-1','OZON МОСКВА 10_10','1',10000,8000,9000,1500),make('job-2','OZON Москва XEROX','1',1500,1100,1300,0),make('job-3','OZON Москва 2-GO','1',500,500,500,0),make('job-4','OZON МОСКВА 2й магазин','2',3000,2000,2500,300,'closed'),make('job-5','OZON СПБ (1-магазин) XEROX','1',2248,1200,1400,200),make('job-6','OZON Новосиб 2-й магазин','2',1510,300,450,0),make('job-7','WB Москва','1',1100,800,900,200)];
function Preview(){const[selected,setSelected]=React.useState('');return React.createElement('main',{style:{maxWidth:1500,margin:'auto',padding:24}},React.createElement('h1',{style:{fontSize:32,marginBottom:8}},'Сборка по направлениям'),React.createElement('p',{style:{marginBottom:24,color:'#506c8e'}},'Локальная проверка интерфейса · пример данных'),React.createElement(SupplyDirections,{jobs,selectedJobId:'job-1',onOpenJob:setSelected,onShowJobs:()=>setSelected('manage')}),React.createElement('output',{id:'selectedJob',style:{display:'block',marginTop:16}},selected));}createRoot(document.getElementById('root')).render(React.createElement(Preview));
</script></body></html>`;
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await server.transformIndexHtml('/__directions',html));
}
const server=await createServer({configFile:false,server:{host:'127.0.0.1',port:4339},esbuild:{jsx:'automatic'},plugins:[{name:'directions-preview',configureServer(s){s.middlewares.use('/__directions',servePreview);}}]});
await server.listen();console.log('Directions local fixture: http://127.0.0.1:4339/__directions');
