/** @param {import('./liveWarehouse').WarehouseCarton} box */
export function warehouseCartonFingerprint(box) {
  const contents = box.contents.map(item => [item.shipmentId || "", item.positionId, item.article, item.quantity]).sort((a,b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  return JSON.stringify([box.id, box.shipmentId, box.number, box.status, box.quantity, box.boxType, contents]);
}
