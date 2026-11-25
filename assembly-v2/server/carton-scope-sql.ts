import { directionCities, wbDachaAliases } from '../shared/cities';

// Normalize characters without long GLOB patterns (D1 limits those to 50 bytes).
// The scalar CTE only reads the supplied destination; no business rows are changed.
export function cityKeySql(column:string, marketColumn?:string):string {
  const validColumn = /^[a-z_]+(?:\.[a-z_]+)?$/;
  if(!validColumn.test(column) || (marketColumn && !validColumn.test(marketColumn)))throw Error('Invalid city column');
  const upper='ABCDEFGHIJKLMNOPQRSTUVWXYZАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ0123456789';
  const lower=upper.toLocaleLowerCase('ru-RU');
  const cities=directionCities.map(c=>({key:c.key,match:'('+c.aliases.map(alias=>{
    const needle=alias.toLocaleUpperCase('ru-RU').replace(/[^A-ZА-ЯЁ0-9]/g,' ');
    return `instr(normalized,' ${needle} ')>0`;
  }).join(' OR ')+')'}));
  // Collapse space runs in the normalized name before comparing whole aliases.
  const dacha = marketColumn
    ? `WHEN ${marketColumn}='WB' AND instr(normalized,' ДАЧА ')>0
      AND trim(replace(replace(replace(normalized,' ','<>'),'><',''),'<>',' ')) IN (${wbDachaAliases.map(alias=>`'${alias}'`).join(',')})
      THEN 'DACHA' `
    : '';
  return `(WITH RECURSIVE city_chars(rest,normalized) AS (
    SELECT coalesce(${column},''),' '
    UNION ALL SELECT substr(rest,2),normalized||CASE
      WHEN instr('${upper}',substr(rest,1,1))>0 THEN substr(rest,1,1)
      WHEN instr('${lower}',substr(rest,1,1))>0 THEN substr('${upper}',instr('${lower}',substr(rest,1,1)),1)
      ELSE ' ' END FROM city_chars WHERE rest<>''
  ), city_name AS (SELECT normalized||' ' normalized FROM city_chars WHERE rest='')
  SELECT CASE ${dacha}WHEN (${cities.map(c=>c.match).join(' + ')})=1 THEN CASE ${cities.map(c=>`WHEN ${c.match} THEN '${c.key}'`).join(' ')} END END FROM city_name)`;
}
export const cartonScopeSql = (carton:string,supply:string) => {
  if(!/^[a-z]+$/.test(carton)||!/^[a-z]+$/.test(supply))throw Error('Invalid scope alias');
  return `${carton}.market=${supply}.market AND ${carton}.store=${supply}.store AND (${carton}.destination=${supply}.destination OR
    (${supply}.store GLOB '[1-9]*' AND ${supply}.store NOT GLOB '*[^0-9]*' AND ${carton}.city_key IS NOT NULL AND ${carton}.city_key=${supply}.city_key))`;
};
