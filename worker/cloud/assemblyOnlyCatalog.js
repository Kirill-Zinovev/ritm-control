import {sourceId} from './config.js';
const normalize = v=>String(v??'').trim().toLocaleUpperCase('ru-RU');
const photoSafe = url=>/^https:\/\/(?:basket-\d+\.wbbasket\.ru|mow-basket-cdn-\d+\.geobasket\.ru)\/[A-Za-z0-9_./%-]+(?:\?[A-Za-z0-9_=&%-]*)?$/i.test(url)?url:'';
async function values(reader,id,range){const u=new URL(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet`);u.searchParams.append('ranges',range);u.searchParams.set('valueRenderOption','FORMATTED_VALUE');const response=await reader.request(u.href,{});const d=await response.json();if(d.spreadsheetId!==id||!Array.isArray(d.valueRanges)||d.valueRanges.length!==1)throw Error('catalog_response_invalid');return d.valueRanges[0].values||[];}
export async function findAssemblyCatalog(reader,bindings,market,articles){
 if(!['OZON','WB'].includes(market))throw Error('market_unknown');
 const requested=[...new Set(articles.map(normalize).filter(Boolean))];if(requested.length>501)throw Error('too_many_articles');if(!requested.length)return [];
 const [rows,photos]=await Promise.all([values(reader,sourceId(bindings,'catalogId'),`'${market}'!A:AD`),values(reader,sourceId(bindings,'assemblyPhotosId'),"'Ссылки'!A:B").catch(()=>null)]);
 const headers=(rows[0]||[]).map(v=>String(v).trim());const index=name=>headers.indexOf(name);const cell=(row,name)=>index(name)<0?'':String(row[index(name)]||'').trim();
 return requested.map(article=>{const matches=rows.slice(1).filter(row=>[row[0],row[1],cell(row,'Артикул'),cell(row,'Артикул (oz)')].some(x=>normalize(x)===article));const one=(field)=>{const x=[...new Set(matches.map(field).filter(Boolean))];return x.length===1?x[0]:''};const name=one(row=>cell(row,'Наименование')||cell(row,'Название')),type=one(row=>cell(row,'Вид')||cell(row,'Вид товара')),boxType=matches.length&&matches.every(row=>cell(row,'Тип короба'))?one(row=>cell(row,'Тип короба')):'';const capacity=matches.length&&matches.every(row=>cell(row,'В коробке'))?one(row=>cell(row,'В коробке')):'';const photoMatches=(photos||[]).slice(1).filter(row=>normalize(row[0])===article).map(row=>photoSafe(String(row[1]||'').trim())).filter(Boolean);const photo=[...new Set(photoMatches)];return {article,found:matches.length>0,name,type,boxType,capacity,photoUrl:photo.length===1?photo[0]:'',photoStatus:photos?'checked':'unavailable',ambiguous:matches.length>1};});
}


