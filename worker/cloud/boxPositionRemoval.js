import { CloudError } from "./access.js";
import { sourceId } from "./config.js";
import { createDepartmentMoveGateway } from "./departmentMoveGateway.js";
import { physicalShipmentId, productionOperationLabel, productionOperationPending, productionOperationTarget, sourceTargetMatches } from "./productionOperationTarget.js";

export const boxRemovalKind = "box-position-removal";
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const fail = (code, message, status = 409) => { throw new CloudError(code, message, status); };
export const pendingBoxRemoval = (scope) => [...scope.operations.values()]
  .find((row) => row.kind === boxRemovalKind && row.value.status === "checking")?.value;
// Two registered shipments with distinct IDs cannot modify each other's sheets.
// An unknown or ambiguous mapping remains protected until reconciliation.
export function boxRemovalOverlaps(scope, sheetId, department, excludeId = null) {
  const pending = [...scope.operations.values()].filter(row => row.kind === boxRemovalKind &&
    row.value.status === 'checking' && row.value.id !== excludeId).map(row => row.value);
  if (!pending.length) return false;
  if (!Number.isSafeInteger(sheetId) || !['box','roll'].includes(department)) return true;
  const supplies = scope.meta('productionSupplies') || [];
  const target = supplies.filter(s => s.parts?.some(p => p.department === department && p.sheetId === sheetId));
  if (target.length !== 1) return true;
  return pending.some(operation => {
    if (department === 'box' && operation.identity?.sheetId === sheetId) return true;
    const source = supplies.filter(s =>
      s.parts?.some(p => p.department === 'box' && p.sheetId === operation.identity?.sheetId));
    return source.length !== 1 || source[0].id !== operation.shipmentId || source[0].id === target[0].id;
  });
}
export function boxRemovalStatus(operation) {
  if (!operation) return null;
  const { id, identity, status, message } = operation;
  return { id, identity, status, message };
}
export function currentBoxLinks(links, scope) {
  const removed = [...scope.operations.values()]
    .filter(row => row.kind === boxRemovalKind && row.value.status === "verified")
    .map(row => row.value);
  return links.map(link => {
    if (!Array.isArray(link.positionKeys)) return link;
    const keys = new Set(link.positionKeys);
    let quantity = link.boxQuantity;
    for (const removal of removed) {
      if (removal.identity.sheetId !== link.boxSheetId) continue;
      const { uid, row, article } = removal.position;
      if (keys.delete(`${uid ? `uid:${uid}` : `row:${row}`}|${article}`) && Number.isFinite(quantity))
        quantity -= removal.identity.quantity;
    }
    return keys.size === link.positionKeys.length ? link :
      { ...link, positionKeys: [...keys], boxRows: keys.size, boxQuantity: quantity };
  });
}

function checkPendingSourceChanges(scope, target) {
  for (const { kind, value } of scope.operations.values()) {
    if (kind === "production" && productionOperationPending(value)) {
      const affected = productionOperationTarget(value);
      if (affected && !sourceTargetMatches(target, affected)) continue;
      const label = productionOperationLabel(value);
      fail("box_remove_busy", affected
        ? `По этой поставке ещё не завершена операция: ${label}. Проверьте её состояние в разделе «Поставки».`
        : `Сначала проверьте незавершённую операцию: ${label}. RITM пока не подтвердил, какие листы она затрагивает.`);
    }
    if (kind === "roll" && ["writing", "pending", "partial", "uncertain", "checking", "written_unverified"].includes(value.status)) {
      const sheetId = value.payload?.plan?.sheetId ?? value.payload?.sheetId ?? value.result?.sheetId;
      const part = { department: "roll", sheetId };
      if (!Number.isSafeInteger(sheetId) || sheetId < 0 ||
          sourceTargetMatches(target, { id: physicalShipmentId(part), parts: [part] }))
        fail("box_remove_busy", `Рулонная печать ещё сверяет операцию: ${productionOperationLabel(value)}. Проверьте её состояние в разделе «Поставки».`);
    }
  }
}

// The production lease serializes these checks with move writes. A saved
// move that appends into new rows and clears specific source cells cannot
// touch another verified row. Legacy plans may rewrite existing rows.
function checkMoveRows(scope, row) {
  for (const { kind, value } of scope.operations.values()) {
    if (kind !== "production-department-move" || ["verified", "cancelled"].includes(value.status)) continue;
    const plan = value.proof?.plan;
    const proof = plan?.proof;
    const boxId = proof?.box?.sheetId;
    if (Number.isSafeInteger(boxId) && boxId >= 0 && boxId !== row.sheetId) continue;
    if (boxId === row.sheetId && plan.destination?.preserveExistingRows === true) {
      const sources = proof.sources || [proof.source];
      const outsideSource = proof.from === "box" && sources.length > 0 &&
        sources.every(source => source && Number.isSafeInteger(source.row) && source.row !== row.row &&
          source.article && source.article !== row.article);
      const destination = plan.destination;
      const outsideDestination = proof.to === "box" && destination.sheetId === row.sheetId &&
        Number.isSafeInteger(destination.startRow) && destination.startRow >= 5 && row.row < destination.startRow &&
        destination.lines?.length && destination.lines.every(line => line.article && line.article !== row.article);
      if (outsideSource || outsideDestination) continue;
    }
    fail("box_remove_move_overlap", `Перенос ${value.input?.article || "товара"} ещё проверяется. Нельзя подтвердить, что он не затрагивает строку ${row.article}.`);
  }
}

export async function removeBoxPosition(input, { scope, bindings, fetcher, guard, readPrinting, readSourceRow, hasAssemblyWork, now = Date.now }) {
  const { operationId: id, sheetId, name, uid, article, quantity } = input || {};
  if (!scope.lease || input?.explicitWriteApproval !== true || !uuid.test(id || "") ||
      !Number.isSafeInteger(sheetId) || sheetId < 0 || typeof name !== "string" || !name || name.length > 100 ||
      typeof uid !== "string" || !uid || uid.length > 240 || typeof article !== "string" || !article || article.length > 120 ||
      !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000)
    fail("box_remove_invalid", "Подтвердите удаление конкретной позиции.", 400);
  const identity = { sheetId, name, uid, article, quantity };
  let operation = scope.operations.get(`${boxRemovalKind}:${id}`)?.value;
  if (operation && JSON.stringify(operation.identity) !== JSON.stringify(identity))
    fail("box_remove_conflict", "Этот запрос относится к другой позиции.");
  if (operation?.status === "verified" || operation?.status === "cancelled") return operation;
  const pending = pendingBoxRemoval(scope);
  if (pending && pending.id !== id)
    fail("box_remove_pending", "Сначала завершите проверку предыдущего удаления.");

  const documentId = sourceId(bindings, "boxPrintingId");
  if (!documentId) fail("box_remove_source_missing", "Таблица бокса не подключена.", 503);
  await guard(documentId);
  const send = createDepartmentMoveGateway({
    url: bindings.RITM_BOX_MOVE_GATEWAY_URL, token: bindings.RITM_BOX_MOVE_GATEWAY_TOKEN,
    fetcher, beforeWrite: () => guard(documentId),
  });
  const checkpoint = async (patch) => {
    operation = { ...operation, ...patch, updatedAt: new Date(now()).toISOString() };
    scope.putOperation(boxRemovalKind, operation);
    await scope.checkpoint();
    return operation;
  };
  if (!operation) {
    const part = { department: "box", sheetId };
    const registered = (scope.meta("productionSupplies") || []).find(supply =>
      supply.parts?.some(item => item.department === "box" && item.sheetId === sheetId));
    const target = { id: registered?.id || physicalShipmentId(part), parts: registered?.parts || [part] };
    checkPendingSourceChanges(scope, target);
    const snapshot = await readPrinting();
    if (snapshot?.ok !== true || snapshot.stale || snapshot.refreshFailed)
      fail("box_remove_source_unconfirmed", snapshot?.refreshFailure?.message ||
        "Не удалось проверить актуальный состав бокса. Дождитесь обновления и повторите удаление.");
    const matches = (snapshot?.supplies || []).filter((order) =>
      order.sourceId === "box-printing" && order.spreadsheetId === documentId &&
      order.sheetId === sheetId && order.sheetName === name && order.uid === uid);
    const row = matches[0];
    if (matches.length !== 1 || row.article !== article || row.quantity !== quantity ||
        !Number.isSafeInteger(row.row) || row.row < 5)
      fail("box_remove_changed", "Состав бокса изменился. Обновите поставку и выберите артикул заново.");
    if (snapshot.quality?.status === "partial" && (!snapshot.issues?.length ||
        snapshot.issues.some(issue => !issue.source || [name, row.sourceName, row.sourceId].includes(issue.source) ||
          String(issue.source).endsWith(" · " + name))))
      fail("box_remove_source_unconfirmed", "Не удалось подтвердить данные выбранного листа бокса.");
    checkMoveRows(scope, row);
    if (row.packed !== 0 || row.packingRecords !== 0 || row.printProgress > 0 || row.cutProgress > 0 ||
        row.assemblyMachineCut > 0 || row.assemblyManualCut > 0 ||
        (Number.isFinite(row.remainingPrint) && row.remainingPrint < quantity))
      fail("box_remove_has_work", "Удаление недоступно. По артикулу есть работа или её отсутствие не удалось подтвердить.");
    const sourceInputs = await readSourceRow({ documentId, sheetId, name, row: row.row });
    const physicalUid = sourceInputs?.[30]?.stringValue || "";
    if (sourceInputs?.[5]?.stringValue !== article || sourceInputs?.[16]?.numberValue !== quantity ||
        physicalUid !== (row.rawUid || "") || sourceInputs?.[30]?.formulaValue)
      fail("box_remove_changed", "Исходная строка бокса изменилась или её формат не подтверждён.");
    const shipmentId = row.assemblyShipmentId || `RITM-BOX-${sheetId}`;
    if (shipmentId !== target.id) {
      checkPendingSourceChanges(scope, { id: shipmentId, parts: (snapshot.sheets || [])
        .filter(sheet => sheet.assemblyShipmentId === shipmentId && ["box-printing", "roll-printing"].includes(sheet.sourceId))
        .map(sheet => ({ department: sheet.sourceId.split("-")[0], sheetId: sheet.sheetId })) });
    }
    const wasLastSource = !snapshot.supplies.some(other => other !== row &&
      (other.assemblyShipmentId === shipmentId || (!other.assemblyShipmentId && other.sheetId === sheetId && other.sourceId === "box-printing")));
    const positionId = `${shipmentId}|box:${sheetId}|${row.rawUid ? `uid:${row.rawUid}` : `row:${row.row}`}|${article}`;
    await checkpoint({
      id, action: "removeItem", status: "checking", identity, shipmentId, positionId, wasLastSource,
      position: { operationId: id, sheetId, row: row.row, uid: physicalUid, article, quantity },
      sourceInputs,
      createdAt: new Date(now()).toISOString(), phase: "locking", message: null,
    });
  }

  const { position, shipmentId, positionId } = operation;
  const verifyRemoved = () => checkpoint({ status: "verified", message: null });
  try {
    if (operation.phase === "removing") {
      const state = await send("status", position);
      if (state.status === "removed") return await verifyRemoved();
      if (state.status !== "locked") fail("box_remove_lock_missing", "Скрипт бокса не подтвердил блокировку строки.");
    } else {
      // Lock shares the same Apps Script lock and work journal as employee saves.
      // A lost reply can be checked or repeated using the same operation ID.
      const locked = await send("lock", position);
      if (locked.locked !== true && locked.status !== "locked")
        fail("box_remove_lock_missing", "Скрипт бокса не подтвердил блокировку строки.");
      if (await hasAssemblyWork({ shipmentId, positionId })) {
        await send("abort", position);
        return await checkpoint({ status: "cancelled", message: "У сборщиков уже есть работа по этому артикулу." });
      }
      await checkpoint({ phase: "removing" });
    }
    const removed = await send("remove", position);
    if (removed.status !== "removed") fail("box_remove_unconfirmed", "Таблица бокса ещё не подтвердила удаление.");
    return await verifyRemoved();
  } catch (error) {
    if (operation.phase === "locking") {
      try {
        const state = await send("status", position);
        if (state.status === "absent")
          return await checkpoint({ status: "cancelled", message: error.message });
      } catch { /* Keep the original operation for a safe retry. */ }
    }
    return await checkpoint({ message: error.message || "Удаление требует проверки." });
  }
}
