import {CloudError} from './access.js';
import {warehouseCartonFingerprint} from '../../src/warehouseFingerprint.js';

// This check runs for the entire list before any dispatch status is changed.
export function validateWarehouseBatch(requested, cartons) {
  if (!Array.isArray(requested) || !requested.length || requested.length > 500 || requested.some(row => typeof row?.cartonId !== 'string' || !row.cartonId.trim() || row.cartonId.length > 160 || typeof row?.shipmentId !== 'string' || !row.shipmentId.trim() || row.shipmentId.length > 200 || typeof row?.fingerprint !== 'string' || row.fingerprint.length > 200000))
    throw new CloudError('warehouse_dispatch_invalid', 'Укажите от 1 до 500 подтверждённых коробов.', 400);
  if (new Set(requested.map(row => row.cartonId)).size !== requested.length)
    throw new CloudError('warehouse_dispatch_duplicate', 'Один короб указан несколько раз. Проверьте список.', 400);
  const current = new Map(cartons.map(box => [box.id, box]));
  if (requested.some(row => { const box = current.get(row.cartonId); return !box || box.archivedSourceUnavailable || box.dispatchBlocked || box.sourceStale || box.reserved || box.shipmentId !== row.shipmentId || box.status !== 'closed' || warehouseCartonFingerprint(box) !== row.fingerprint; }))
    throw new CloudError('warehouse_carton_changed', 'Список изменился: короб не найден или ещё не закрыт. Обновите данные и проверьте список.', 409);
  return current;
}
