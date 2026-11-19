import type { Scope } from './model';
import { sameScope } from './model';
import { directionCity } from './cities';

// Cartons are shared within a city/shop. Shipment identity and dispatch checks remain separate.
export function sameCartonScope(a:Scope,b:Scope):boolean {
  if(sameScope(a,b))return true;
  if(a.market!==b.market || a.store!==b.store || !/^[1-9]\d*$/.test(a.store))return false;
  const city=directionCity(a.destination);
  return !!city && city.key===directionCity(b.destination)?.key;
}
