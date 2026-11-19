import type { Carton } from "./model";
import { directionCity } from "./directions";
export function warehouseCity(box: Pick<Carton, "destination">) {
  const city = directionCity(box.destination);
  return city || {key: "destination:" + box.destination, label: box.destination || "Направление не указано"};
}
export function filterWarehouseCartons(cartons: Carton[], filters: {market: string; city: string; store: string; query: string}) {
  const query = filters.query.trim().toLocaleLowerCase("ru-RU");
  return cartons.filter(b => b.state === "closed" && !b.dispatchId
    && (!filters.market || b.market === filters.market)
    && (!filters.city || warehouseCity(b).key === filters.city)
    && (!filters.store || b.store === filters.store)
    && `${b.label} ${b.store} ${b.destination} ${b.items.map(i => i.sku).join(" ")}`.toLocaleLowerCase("ru-RU").includes(query));
}
