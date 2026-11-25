import type { SqlStore } from "./database";
import type { CatalogEntry } from "../shared/catalog";
import { catalogKey, cleanCatalogText } from "../shared/catalog";
import type { SupplyImport, Position } from "../shared/model";
import type { RitmSupply, RitmIssue } from "../shared/ritm";
import { ritmShipmentId } from "../shared/ritm";
import { requireCatalog as check, findCatalogAliases } from "./catalog-store";
type Previous = Position & {
  groupExternalId: string;
  store: string;
  destination: string;
  originShipmentId: string;
  catalogBindingRetired: number;
};
const storeNumber = (v: string): string | null => {
  const m = v.trim().match(/^(?:магазин\s*)?([1-9]\d*)$/iu);
  return m ? String(Number(m[1])) : null;
};
export async function prepareRitmImport(
  store: SqlStore,
  source: RitmSupply,
): Promise<{ groups: SupplyImport[]; issues: RitmIssue[] }> {
  check(
    source &&
      ritmShipmentId(source.shipmentId) &&
      typeof source.title === "string" &&
      source.title.trim() &&
      (source.market === "WB" || source.market === "OZON") &&
      typeof source.locked === "boolean" &&
      Array.isArray(source.positions) &&
      source.positions.length > 0 &&
      source.positions.length <= 10000,
    "Не подтверждены ID и состав поставки РИТМ.",
  );
  check(
    new Set(source.positions.map((p) => p.positionId)).size ===
      source.positions.length,
    "Повторяются исходные ID РИТМ.",
  );
  const previous = await store.all<Previous>(
    `select p.*,s.external_id group_external_id,s.store,s.destination,s.origin_shipment_id,
      json_extract(c.data,'$.retiredIdentity') is not null catalog_binding_retired
      from av2_positions p join av2_supplies s on s.id=p.supply_id
      left join av2_catalog_products c on c.entry_id=p.catalog_entry_id where s.origin_shipment_id=?`,
    [source.shipmentId],
  );
  const byPosition = new Map(previous.map((p) => [p.externalId, p]));
  for (const groupId of new Set(previous.filter(p => !storeNumber(p.store)).map(p => p.groupExternalId))) {
    const members = previous.filter(p => p.groupExternalId === groupId);
    const confirmed = members.map(old => source.positions.find(p => p.positionId === old.externalId)).map(p => p?.storeStatus === 'matched' ? storeNumber(p.store) : null);
    const shop = confirmed[0];
    if (!shop || confirmed.some(s => s !== shop)) continue;
    const activity = await store.all<{n:number}>(`select (select count(*) from av2_work where position_id in (select value from json_each(?)))+(select count(*) from av2_all_allocations where position_id in (select value from json_each(?)))+(select count(*) from av2_warehouse_receipts where position_id in (select value from json_each(?))) n`, Array(3).fill(JSON.stringify(members.map(p => p.id))));
    if (activity[0]?.n !== 0) continue;
    for (const old of members) old.store = shop;
  }
  const found = await findCatalogAliases(store,source.market,source.positions.map(p=>catalogKey(p.sku)));
  const candidates = new Map<string, CatalogEntry[]>();
  for (const row of found)
    candidates.set(row.alias, [
      ...(candidates.get(row.alias) || []),
      JSON.parse(row.data) as CatalogEntry,
    ]);
  const groups = new Map<string, SupplyImport>();
  const issues: RitmIssue[] = [];
  const warn = (message: string) => {
    if (!issues.some((i) => i.message === message))
      issues.push({
        shipmentId: source.shipmentId,
        title: source.title,
        message,
      });
  };
  const destination = previous[0]?.destination || source.title;
  const groupFor = (shop: string): SupplyImport => {
    let group = groups.get(shop);
    if (!group) {
      const old = previous.find((p) => p.store === shop);
      group = {
        externalId:
          old?.groupExternalId ||
          `RITM-V2:${source.shipmentId}:${encodeURIComponent(shop)}`,
        originShipmentId: source.shipmentId,
        title: source.title,
        market: source.market,
        store: shop,
        destination,
        sourceVersion: 1,
        sourceActive: true,
        positions: [],
      };
      groups.set(shop, group);
    }
    return group;
  };
  for (const p of source.positions) {
    check(
      p &&
        typeof p.positionId === "string" &&
        p.positionId.startsWith(source.shipmentId + "|") &&
        p.positionId.length <= 1500 &&
        typeof p.sku === "string" &&
        p.sku.trim() &&
        p.sku.length <= 300 &&
        Number.isSafeInteger(p.quantity) &&
        p.quantity > 0 &&
        ["roll-printing", "box-printing", "assembly-only"].includes(p.sourceId),
      "Не подтверждены артикул, количество или происхождение позиции РИТМ.",
    );
    const old = byPosition.get(p.positionId);
    const matches = [
      ...new Map(
        (candidates.get(catalogKey(p.sku)) || []).map((e) => [e.id, e]),
      ).values(),
    ];
    const explicit = p.storeStatus === "matched" ? storeNumber(p.store) : null;
    const scoped = explicit
      ? matches.filter((e) => e.store === explicit)
      : matches;
    const primary = scoped.filter(
      (e) => catalogKey(e.sku) === catalogKey(p.sku),
    );
    const choices = primary.length ? primary : scoped;
    const shops = [
      ...new Set(
        choices
          .map((e) => storeNumber(e.store))
          .filter((v): v is string => !!v),
      ),
    ];
    const retainedShop = old?.catalogBindingRetired ? storeNumber(old.store) : null;
    let shop = explicit || retainedShop || (shops.length === 1 ? shops[0] : null);
    const scopeConflict = !!old && !!shop && old.store !== shop;
    if (explicit && explicit !== retainedShop && matches.length && !scoped.length) {
      shop = null;
      warn(
        `${p.sku}: магазин РИТМ расходится со справочником. Добавление в короб заблокировано.`,
      );
    }
    if (old) {
      if (shop && old.store !== shop)
        warn(
          `${p.sku}: магазин изменился; сохранена прежняя привязка ${old.store}, требуется проверка.`,
        );
      shop = old.store;
    }
    if (!shop) {
      shop = "Не подтверждён";
      warn(
        `${p.sku}: магазин не подтверждён. Можно записывать работу, но нельзя добавлять в короб.`,
      );
    }
    const inStore = choices.filter((e) => e.store === shop);
    const entry = inStore.length === 1 ? inStore[0] : null;
    const group = groupFor(shop);
    group.positions.push({
      externalId: p.positionId,
      sku: p.sku,
      name: (cleanCatalogText(p.name || "") || entry?.name || p.sku).slice(
        0,
        300,
      ),
      barcode: old?.barcode ?? entry?.barcode ?? "",
      department:
        old?.department ||
        (p.sourceId === "roll-printing"
          ? "Рулонная печать"
          : p.sourceId === "box-printing"
            ? "Бокс"
            : "Дополнительные товары"),
      plan: p.quantity,
      unitsPerBox:
        old?.unitsPerBox ??
        (shop === "Не подтверждён" ? null : (entry?.unitsPerBox ?? (explicit && Number.isSafeInteger(p.unitsPerBox) && p.unitsPerBox! > 0 ? p.unitsPerBox! : null))),
      ready: !source.locked && !scopeConflict,
      cutOperation:
        old?.cutOperation ||
        (p.sourceId === "roll-printing" ? "cut" : "assembly"),
      sourceActive: !scopeConflict,
    });
  }
  // Retire source rows reversibly; preserve their IDs, facts and carton history.
  for (const old of previous)
    if (!source.positions.some((p) => p.positionId === old.externalId)) {
      const group = groupFor(old.store);
      group.positions.push({
        externalId: old.externalId,
        sku: old.sku,
        name: old.name,
        barcode: old.barcode,
        department: old.department,
        plan: old.plan,
        unitsPerBox: old.unitsPerBox,
        ready: false,
        cutOperation: old.cutOperation,
        sourceActive: false,
      });
    }
  for (const g of groups.values()) {
    check(
      g.positions.length <= 500,
      `В магазине ${g.store} поставки «${source.title}» больше 500 позиций. Предыдущий состав сохранён целиком.`,
    );
    g.sourceActive = g.positions.some((p) => p.sourceActive);
    g.positions.sort((a, b) => a.externalId.localeCompare(b.externalId));
    const existing = (
      await store.all<{ sourceVersion: number }>(
        "select source_version from av2_supplies where external_id=?",
        [g.externalId],
      )
    )[0];
    g.sourceVersion = (existing?.sourceVersion || 0) + 1;
  }
  return { groups: [...groups.values()], issues };
}
