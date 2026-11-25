import { catalogKey, digest } from "./catalog";
import { sameCartonScope } from "./carton-scope";
import { isCartonOverCapacity } from "./assembly";
import type { Carton, CartonItem } from "./model";

type MergeCartonMetrics = Pick<Carton, "qty" | "fill" | "capacityUnknown">;

export type CartonMergeReceipt = {
  sourceCartonId: string;
  targetCartonId: string;
  sourceLabel: string;
  targetLabel: string;
  movedQty: number;
  qty: number;
  fill: number;
  fitConfirmed: boolean;
  sourceRemaining?: MergeCartonMetrics;
};

function hasCapacity(item: CartonItem): item is CartonItem & { unitsPerBox: number } {
  return item.unitsPerBox !== null && Number.isFinite(item.unitsPerBox) && item.unitsPerBox > 0;
}

function contentMetrics(items: CartonItem[]): MergeCartonMetrics {
  let qty = 0, fill = 0, capacityUnknown = false;
  for (const item of items) {
    qty += item.qty;
    if (hasCapacity(item)) fill += item.qty / item.unitsPerBox;
    else capacityUnknown = true;
  }
  return { qty, fill, capacityUnknown };
}

export function checkCartonMerge<Item extends CartonItem>(
  source: (Omit<Carton, "items"> & { items: Item[] }) | undefined,
  target: Carton | undefined,
  selection?: ReadonlyMap<string, number | null>,
):
  { allowed: false; message: string } |
  {
    allowed: true;
    moves: { item: Item; qty: number }[];
    movedQty: number;
    qty: number;
    fill: number;
    sourceRemaining: MergeCartonMetrics;
    requiresFitConfirmation: boolean;
  } {
  if (!source || !target)
    return { allowed: false, message: "Выберите, из какого короба и в какой переложить товар." };
  if (source.id === target.id)
    return { allowed: false, message: "Выберите два разных короба." };
  if ([source, target].some(box => box.dispatchId))
    return { allowed: false, message: "Короб включён в отгрузку. Выберите другой открытый короб." };
  if (source.state !== "open" || target.state !== "open")
    return { allowed: false, message: "Для слияния оба короба должны быть открыты. Выберите открытые короба." };
  if (!/^[1-9]\d*$/.test(source.store) || !sameCartonScope(source, target))
    return { allowed: false, message: "Выберите короба одного маркетплейса, направления и подтверждённого магазина." };
  if (source.qty <= 0)
    return { allowed: false, message: "Исходный короб пуст. Выберите короб с товаром." };
  if (selection?.size === 0)
    return { allowed: false, message: "Отметьте хотя бы один артикул для переноса." };

  const available = new Map<string, number>();
  for (const item of source.items) {
    const key = catalogKey(item.sku);
    available.set(key, (available.get(key) ?? 0) + item.qty);
  }
  const pending = new Map<string, number>();
  for (const [sku, entered] of selection ?? available) {
    const maximum = available.get(sku);
    if (!maximum)
      return { allowed: false, message: "Выбранных артикулов уже нет в этом составе. Проверьте короб и обновите выбор." };
    const qty = entered ?? maximum;
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > maximum)
      return { allowed: false, message: `Для ${sku} введите целое количество от 1 до ${maximum} шт.` };
    pending.set(sku, qty);
  }

  const moves: { item: Item; qty: number }[] = [];
  const remaining: CartonItem[] = [];
  for (const item of source.items) {
    const key = catalogKey(item.sku);
    const requested = pending.get(key) ?? 0;
    const qty = Math.min(item.qty, requested);
    if (qty > 0) {
      moves.push({ item, qty });
      pending.set(key, requested - qty);
    }
    if (qty < item.qty) remaining.push({ ...item, qty: item.qty - qty });
  }
  const movedItems = moves.map(({ item, qty }) => ({ ...item, qty }));
  const missingNorm = movedItems.find(item => !hasCapacity(item)) ?? target.items.find(item => !hasCapacity(item));
  if (missingNorm)
    return { allowed: false, message: `Для ${missingNorm.sku} не задана вместимость. Сверьте норму в справочнике или выберите другой короб.` };

  const moved = contentMetrics(movedItems);
  const fill = target.fill + moved.fill;
  return {
    allowed: true,
    moves,
    movedQty: moved.qty,
    qty: target.qty + moved.qty,
    fill,
    sourceRemaining: contentMetrics(remaining),
    requiresFitConfirmation: isCartonOverCapacity(fill),
  };
}

export function cartonMergeFingerprint(box: Carton, includeSku = false): Promise<string> {
  return digest(JSON.stringify([
    box.id, box.state, box.dispatchId, box.market, box.store, box.destination,
    box.items
      .map(item => {
        const fields = [item.id, item.positionId, item.qty, item.unitsPerBox] as const;
        return includeSku ? [...fields, catalogKey(item.sku)] as const : fields;
      })
      .sort(([a], [b]) => a.localeCompare(b)),
  ]));
}
