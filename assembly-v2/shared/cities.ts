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
const normalize=(name:string)=>name.toLocaleUpperCase('ru-RU').replace(/[^A-ZА-ЯЁ0-9]/g,' ');
export function directionCity(name:string) {
  const normalized=' '+normalize(name)+' ';
  const matches=directionCities.filter(c=>c.aliases.some(alias=>normalized.includes(' '+normalize(alias)+' ')));
  return matches.length===1 ? {key:matches[0].key,label:matches[0].label} : null;
}
