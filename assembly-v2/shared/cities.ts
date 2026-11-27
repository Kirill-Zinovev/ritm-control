import type { Market } from "./model";

// The old Assembly recognizes these aliases. Keep city matching shared by UI and DB guards.
export const directionCities = [
  {key:'SPB',label:'СПБ',aliases:['СПБ','САНКТ ПЕТЕРБУРГ','САНКТ-ПЕТЕРБУРГ','САНКТПЕТЕРБУРГ','САНКТ ПЕТЕРБУРГА','САНКТ-ПЕТЕРБУРГА','САНКТПЕТЕРБУРГА','ПИТЕР']},
  {key:'MOSCOW',label:'Москва',aliases:['МОСКВА','МОСКВЫ','МСК']},
  {key:'EKATERINBURG',label:'Екатеринбург',aliases:['ЕКБ','ЕКАТЕРИНБУРГ']},
  {key:'NOVOSIBIRSK',label:'Новосибирск',aliases:['НОВОСИБ','НОВОСИБИРСК']},
  {key:'KAZAN',label:'Казань',aliases:['КАЗАНЬ','КАЗАНИ']},
  {key:'ROSTOV',label:'Ростов',aliases:['РОСТОВ','РОСТОВА']},
  {key:'KOSTROMA',label:'Кострома',aliases:['КОСТРОМА','КОСТРОМЫ']},
] as const;

// Additional cities shown as a single direction in the assembly sidebar.
// Carton routing continues to use the city list shared with its SQL guards.
const supplyCities = [
  ...directionCities,
  { key: 'YAROSLAVL', label: 'Ярославль', aliases: ['ЯРОСЛАВЛЬ', 'ЯРОСЛАВЛЯ'] },
  { key: 'UFA', label: 'Уфа', aliases: ['УФА', 'УФЫ'] },
  { key: 'KRASNOYARSK', label: 'Красноярск', aliases: ['КРАСНОЯРСК', 'КРАСНОЯРСКА'] },
] as const;
type City = (typeof supplyCities)[number];
export const wbDachaAliases = [
  'ДАЧА', 'ДАЧА 2', 'WB ДАЧА', 'WB ДАЧА 2',
  'ВБ ДАЧА', 'ВБ ДАЧА 2', 'WILDBERRIES ДАЧА', 'WILDBERRIES ДАЧА 2',
];
const normalize=(name:string)=>name.toLocaleUpperCase('ru-RU').replace(/[^A-ZА-ЯЁ0-9]/g,' ');
function matchCity(name: string, market: Market | undefined, cities: readonly City[]) {
  const normalized=' '+normalize(name)+' ';
  if(market==='WB' && wbDachaAliases.includes(normalized.trim().replace(/ +/g,' ')))
    return {key:'DACHA',label:'ДАЧА'};
  const matches=cities.filter(c=>c.aliases.some(alias=>normalized.includes(' '+normalize(alias)+' ')));
  return matches.length===1 ? {key:matches[0].key,label:matches[0].label} : null;
}

export function directionCity(name: string, market?: Market) {
  return matchCity(name, market, directionCities);
}

export function supplyDirectionCity(name: string, market: Market) {
  return matchCity(name, market, supplyCities);
}
