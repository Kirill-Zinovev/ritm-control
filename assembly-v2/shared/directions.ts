import type { Supply } from "./model";
import { directionCity } from "./cities";
export { directionCity } from "./cities";

export function groupDirections(supplies: Supply[], selectedId: string | null) {
  const groups = new Map<string, Supply[]>();
  for (const s of supplies) {
    const city = directionCity(s.title),
      key =
        city && /^[1-9]\d*$/.test(s.store)
          ? JSON.stringify([s.market, city.key, s.store])
          : s.id;
    const members = groups.get(key) || [];
    members.push(s);
    groups.set(key, members);
  }
  return [...groups.values()].map((sources) => {
    const selected = sources.find((s) => s.id === selectedId) || sources[0],
      city = directionCity(selected.title);
    return {
      ...selected,
      title:
        city && /^[1-9]\d*$/.test(selected.store)
          ? `${selected.market} ${city.label} · Магазин ${selected.store}`
          : selected.title,
      sourceActive: sources.some((s) => s.sourceActive !== false),
      sourceLocked: sources.every((s) => s.sourceLocked === true),
      sources,
    };
  });
}
