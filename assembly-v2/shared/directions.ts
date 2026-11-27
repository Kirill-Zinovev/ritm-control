import type { Supply } from "./model";
import { supplyDirectionCity } from "./cities";
export { directionCity } from "./cities";

export function groupDirections(supplies: Supply[], selectedId: string | null) {
  const groups = new Map<string, Supply[]>();
  for (const s of supplies) {
    const direction = supplyDirectionCity(s.title, s.market),
      key =
        direction && /^[1-9]\d*$/.test(s.store)
          ? JSON.stringify([s.market, direction.key, s.store])
          : s.id;
    const members = groups.get(key) || [];
    members.push(s);
    groups.set(key, members);
  }
  return [...groups.values()].map((sources) => {
    const selected = sources.find((s) => s.id === selectedId) || sources[0],
      direction = supplyDirectionCity(selected.title, selected.market);
    return {
      ...selected,
      title:
        direction && /^[1-9]\d*$/.test(selected.store)
          ? `${selected.market} ${direction.label} · Магазин ${selected.store}`
          : selected.title,
      sourceActive: sources.some((s) => s.sourceActive !== false),
      sourceLocked: sources.every((s) => s.sourceLocked === true),
      sources,
    };
  });
}
