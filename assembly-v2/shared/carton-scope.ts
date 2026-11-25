import type { Scope } from './model';
import { sameScope } from './model';
import { directionCity } from './cities';

// Cartons are shared within a confirmed direction and shop.
export function sameCartonScope(a:Scope,b:Scope):boolean {
  if(sameScope(a,b))return true;
  if(a.market!==b.market || a.store!==b.store || !/^[1-9]\d*$/.test(a.store))return false;
  const direction=directionCity(a.destination,a.market);
  return !!direction && direction.key===directionCity(b.destination,b.market)?.key;
}
