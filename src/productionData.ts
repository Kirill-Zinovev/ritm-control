import type { LiveOrder, LivePrinting } from "./livePrinting";
import { rollCut, rollPrinted } from "./liveSupplyProgress";
import { supplyMarketplace } from "./liveSupplyMarketplace";

export type Fact = {
  value: number | null;
  known: number;
  expected: number;
  complete: boolean;
};
type ArticleRow = {
  key: string;
  department: "roll" | "box";
  article: string;
  store: string;
  plan: number;
  orders: LiveOrder[];
  printed: Fact;
  cut: Fact;
  packed: Fact;
};
export type ProductionDepartment = {
  id: "roll" | "box";
  label: string;
  rows: ArticleRow[];
  orders: LiveOrder[];
  plan: number;
  printed: Fact;
  cut: Fact;
  sourceUrl?: string;
};
export type SupplyGroup = {
  key: string;
  sheetId: number;
  sourceId: string;
  name: string;
  market: "Ozon" | "WB" | null;
  sourceUrl?: string;
  rows: ArticleRow[];
  orders: LiveOrder[];
  plan: number;
  printed: Fact;
  cut: Fact;
  packed: Fact;
  stores: string[];
  departments: ProductionDepartment[];
};

export function productionFact(values: (number | null | undefined)[]): Fact {
  const known = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  return {
    value: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
    known: known.length,
    expected: values.length,
    complete: known.length === values.length,
  };
}

function storeName(value: string | null | undefined) {
  const normalized = String(value || "").trim();
  if (!normalized) return "Не указан";
  return /^\d+$/.test(normalized) ? `Магазин ${normalized}` : normalized;
}

export function buildProductionGroups(
  live: LivePrinting | null,
): SupplyGroup[] {
  if (!live) return [];
  const shipmentSheets = new Map<string, LivePrinting["sheets"]>();
  for (const sheet of live.sheets) {
    if (!["roll-printing", "box-printing"].includes(sheet.sourceId || ""))
      continue;
    const identities = new Set(
      [
        sheet.assemblyShipmentId,
        ...live.supplies
          .filter(
            (order) =>
              order.sheetId === sheet.sheetId &&
              order.sourceId === sheet.sourceId,
          )
          .map((order) => order.assemblyShipmentId),
      ].filter((id): id is string => !!id),
    );
    const shipmentId =
        identities.size === 1
          ? [...identities][0]
          : identities.size === 0 && sheet.sourceId === "roll-printing"
            ? `RITM-ROLL-${sheet.sheetId}`
            : null,
      key = shipmentId
        ? `shipment:${shipmentId}`
        : `sheet:${sheet.sourceId}:${sheet.sheetId}`;
    shipmentSheets.set(key, [...(shipmentSheets.get(key) || []), sheet]);
  }

  return [...shipmentSheets.entries()].map(([key, sheets]) => {
    const primarySheet =
      sheets.find((sheet) => sheet.sourceId === "roll-printing") || sheets[0];
    const orders = live.supplies.filter((order) =>
      sheets.some(
        (sheet) =>
          order.sheetId === sheet.sheetId &&
          (!order.sourceId ||
            !sheet.sourceId ||
            order.sourceId === sheet.sourceId),
      ),
    );
    const grouped = new Map<string, LiveOrder[]>();
    for (const order of orders) {
      const sheet = sheets.find(
        (candidate) =>
          candidate.sheetId === order.sheetId &&
          (!order.sourceId ||
            !candidate.sourceId ||
            order.sourceId === candidate.sourceId),
      );
      const department: ArticleRow["department"] =
        order.sourceId === "box-printing" || sheet?.sourceId === "box-printing"
          ? "box"
          : "roll";
      const store = productionStoreName(order),
        articleKey = `${department}\u0000${order.article.trim().toLocaleUpperCase("ru-RU")}\u0000${store}`;
      grouped.set(articleKey, [...(grouped.get(articleKey) || []), order]);
    }
    const rows: ArticleRow[] = [...grouped.entries()].map(
      ([articleKey, items]) => {
        const first = items[0];
        const department: ArticleRow["department"] =
          first.sourceId === "box-printing" ||
          sheets.some(
            (sheet) =>
              sheet.sheetId === first.sheetId &&
              sheet.sourceId === "box-printing",
          )
            ? "box"
            : "roll";
        return {
          key: `${key}:${articleKey}`,
          department,
          article: first.article,
          store: productionStoreName(first),
          plan: items.reduce((sum, item) => sum + item.quantity, 0),
          orders: items,
          printed: productionFact(items.map(rollPrinted)),
          cut: productionFact(items.map(rollCut)),
          packed: productionFact(items.map((item) => item.packed)),
        };
      },
    );
    const departments: ProductionDepartment[] = [];
    for (const { id, label, sourceId } of [
      { id: "roll", label: "Рулонная печать", sourceId: "roll-printing" },
      { id: "box", label: "Бокс", sourceId: "box-printing" },
    ] as const) {
      const departmentOrders = orders.filter((order) => {
        const sheet = sheets.find(
          (candidate) =>
            candidate.sheetId === order.sheetId &&
            (!order.sourceId ||
              !candidate.sourceId ||
              order.sourceId === candidate.sourceId),
        );
        return order.sourceId === sourceId || sheet?.sourceId === sourceId;
      });
      const departmentRows = rows.filter((row) => row.department === id);
      if (!departmentRows.length) continue;
      const departmentSheets = sheets.filter(
        (sheet) => sheet.sourceId === sourceId,
      );
      departments.push({
        id,
        label,
        rows: departmentRows,
        orders: departmentOrders,
        plan: departmentOrders.reduce((sum, item) => sum + item.quantity, 0),
        printed: productionFact(departmentOrders.map(rollPrinted)),
        cut: productionFact(departmentOrders.map(rollCut)),
        sourceUrl: departmentSheets.find((sheet) => sheet.spreadsheetUrl)
          ?.spreadsheetUrl,
      });
    }
    const stores = [...new Set(rows.map((row) => row.store))].sort((a, b) =>
      a.localeCompare(b, "ru-RU", { numeric: true }),
    );
    return {
      key,
      sheetId: primarySheet.sheetId,
      sourceId: primarySheet.sourceId || "",
      name: primarySheet.name,
      market: supplyMarketplace(primarySheet.name),
      sourceUrl: primarySheet.spreadsheetUrl,
      rows,
      orders,
      plan: orders.reduce((sum, item) => sum + item.quantity, 0),
      printed: productionFact(orders.map(rollPrinted)),
      cut: productionFact(orders.map(rollCut)),
      packed: productionFact(orders.map((item) => item.packed)),
      stores,
      departments,
    };
  });
}

export function productionStoreName(order: LiveOrder) {
  if (order.shopCatalogStatus && order.shopCatalogStatus !== "matched")
    return "Не указан";
  return storeName(order.shop);
}

export function productionStoreCoverage(orders: LiveOrder[]) {
  const result = {
    matched: 0,
    missing: 0,
    ambiguous: 0,
    unavailable: 0,
    unknown_marketplace: 0,
  };
  for (const order of orders) {
    const state =
      order.shopCatalogStatus || (order.shop ? "matched" : "missing");
    result[state]++;
  }
  return result;
}

export function productionStoreIssue(order: LiveOrder) {
  const labels: Record<string, string> = {
    article_missing: "Артикул не найден во вкладке его маркетплейса",
    store_error: "В ячейке магазина ошибка формулы",
    store_empty: "Номер магазина в каталоге не заполнен",
    store_invalid: "В каталоге указан некорректный номер магазина",
    conflicting_stores: "В каталоге у артикула разные номера магазина",
    marketplace_unknown: "Маркетплейс поставки не определён",
    catalog_unavailable: "Каталог магазина временно недоступен",
    catalog_schema: "Не найдены заголовки артикула и магазина в каталоге",
  };
  return order.shopCatalogReason
    ? labels[order.shopCatalogReason] || "Магазин не подтверждён"
    : "";
}
