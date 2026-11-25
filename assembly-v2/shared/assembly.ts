import type { Operation, Position, Supply } from "./model";
import { number } from "./model";
import { cartonStoreNumber } from "./carton-number";

function storeCorrection(p: Position, supply: Supply): string {
  const store = p.catalog?.store;
  const path = "Владелец подтверждает магазин позиции в «Управление → Подключение → Требуют проверки».";
  if (store && /^[1-9]\d*$/.test(store) && cartonStoreNumber(supply.store) === null) {
    const units = p.catalog?.unitsPerBox;
    const capacity = units ? `, ${number(units)} шт. в коробе` : "";
    const fillCapacity = units ? "" : " Укажите тип и вместимость короба в карточке.";
    return `У позиции не подтверждён магазин. В справочнике ${supply.market} уже указан магазин ${store}${capacity}.${fillCapacity} ${path}`;
  }
  if (p.storeNeedsReview && cartonStoreNumber(supply.store) !== null)
    return "Магазин позиции расходится с РИТМ. Попросите владельца сверить магазин в поставке РИТМ и в справочнике.";
  return `У позиции не подтверждён магазин. Проверьте поле «Магазин» в карточке ${supply.market} и заполните его, если оно пустое. ${path}`;
}

export function workBlockedReason(p: Position, supply: Supply): string {
  if (supply.sourceLocked)
    return "Поставка закрыта для сборки в РИТМ. Чтобы продолжить, откройте её замок в РИТМ.";
  if (p.storeNeedsReview && supply.sourceActive !== false) return storeCorrection(p, supply);
  if (p.sourceActive === false || supply.sourceActive === false)
    return "Позиция больше не активна в РИТМ. Если её вернули в поставку, обновите Сборку.";
  return p.ready ? "" : "Участок ещё не подтвердил готовность позиции. Проверьте её статус в РИТМ.";
}

export function boxingBlockedReason(p: Position, supply: Supply): string {
  const workBlock = workBlockedReason(p, supply);
  if (workBlock) return workBlock;
  if (cartonStoreNumber(supply.store) === null) return storeCorrection(p, supply);
  if (!p.unitsPerBox)
    return "Для этого артикула не задана вместимость. В справочнике откройте «Производство» и укажите тип и вместимость короба.";
  return "";
}

const cartonFillTolerance = 1e-9;

export function isCartonOverCapacity(fill: number): boolean {
  return fill > 1 + cartonFillTolerance;
}

export type CartonFitConfirmation = {
  cartonFingerprint: string | null;
  shipmentQty: number;
  unitsPerBox: number;
};

export function boxCapacity(fill: number, unitsPerBox: number | null): number {
  if (!unitsPerBox || unitsPerBox <= 0 || !Number.isFinite(fill)) return 0;
  // Match the server's mixed-carton tolerance; a 100% box can be 0.999… in JS.
  return Math.max(0, Math.floor((1 - fill + cartonFillTolerance) * unitsPerBox));
}

export type ExcessDestination = "box" | "stock";
export function placementAmounts(qty: number, remaining: number, destination: ExcessDestination) {
  const excessQty = Math.max(0, qty - Math.max(0, remaining));
  const warehouseQty = destination === "stock" ? excessQty : 0;
  return { shipmentQty: qty - warehouseQty, warehouseQty, excessQty };
}

// Preserve the collector's existing completion rule, including packed surplus.
export const isFinished = (
  p: Pick<Position, "plan" | "packing" | "boxed">,
): boolean => p.plan > 0 && p.packing >= p.plan && p.boxed >= p.packing;

export function readiness(
  positions: readonly Pick<Position, "plan" | "packing" | "boxed">[],
): number {
  const planned = positions.filter((p) => p.plan > 0);
  const plan = planned.reduce((sum, p) => sum + p.plan, 0);
  const raw =
    plan > 0
      ? (planned.reduce(
          (sum, p) => sum + Math.max(0, p.packing) + Math.max(0, p.boxed),
          0,
        ) /
          (plan * 2)) *
        100
      : 0;
  return raw > 100 ? Math.ceil(raw) : Math.floor(raw);
}

export function availableOperations(p: Position): Operation[] {
  return (["cut", "assembly", "packing"] as const).filter(
    (op) =>
      op === "packing" || op === "assembly" || (p.cutOperation === op && p.plan > 0) || p[op] > 0,
  );
}

export function positionStatus(p: Position): string {
  if (!p.ready) return "Ожидает участок";
  if (p.packing >= p.plan && p.plan > 0) return "Упаковка завершена";
  if (p.packing > 0) return "Упаковка";
  if (p.assembly > 0) return "Ручная резка";
  if (p.cut > 0) return "Резка на станке";
  return "Не начато";
}
