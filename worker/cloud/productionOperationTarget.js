const verified = new Set(["verified", "verified_with_calculation_errors", "cancelled"]);
const shipmentIdPattern = /^RITM-(?:ROLL-\d+|BOX-\d+|SUPPLY-[a-f0-9-]{36})$/i;
const validSheet = (part) => ["box", "roll"].includes(part?.department) &&
  Number.isSafeInteger(part.sheetId) && part.sheetId >= 0;

export const productionOperationPending = (operation) => !verified.has(operation?.status);
export const physicalShipmentId = (part) => `RITM-${part.department.toUpperCase()}-${part.sheetId}`;

// A saved manifest describes all affected sheets, including a peer department
// whose roster may still be waiting for the common commit.
export function productionOperationTarget(operation) {
  const manifest = ["deletePart", "deleteSupply"].includes(operation.action) ? operation.manifestBefore : operation.manifest;
  if (!["create", "append", "deletePart", "deleteSupply"].includes(operation.action) ||
      !shipmentIdPattern.test(operation.shipmentId || "") ||
      manifest?.id !== operation.shipmentId ||
      !Array.isArray(manifest.parts) || !manifest.parts.length ||
      !manifest.parts.every(validSheet)) return null;
  return { id: operation.shipmentId, name: operation.name, parts: manifest.parts };
}

export function sourceTargetMatches(first, second) {
  return first.id === second.id ||
    second.parts.some(part => physicalShipmentId(part) === first.id) ||
    first.parts.some(part => physicalShipmentId(part) === second.id ||
      second.parts.some(other => part.department === other.department && part.sheetId === other.sheetId));
}

export function productionOperationLabel(operation) {
  const action = ({ create: "создание", append: "добавление товаров", deletePart: "удаление участка", deleteSupply: "удаление",
    delete: "удаление листа", updateItem: "изменение количества", removeItem: "удаление артикула" })[operation.action];
  const name = operation.name || operation.payload?.name;
  return name ? `${action || "изменение"} поставки «${String(name).slice(0, 100)}»` : (action || "изменение поставки");
}
