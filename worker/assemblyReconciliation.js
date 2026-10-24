// Add only owner-confirmed pairs here. Keys are exact legacy names from FBO;
// values are stable employeeIds from Assembly. Similar names are never joined.
export const FBO_ASSEMBLY_EMPLOYEE_CROSSWALK = Object.freeze([]);

function normalized(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ru-RU");
}

function employeeNameKey(value) {
  return normalized(value).replace(/\s+\d+$/, "");
}

function mappingIndex(crosswalk) {
  const fboToAssembly = new Map();
  const assemblyToFbo = new Map();
  for (const item of crosswalk || []) {
    const fboName = String(item?.fboName ?? "").trim();
    const employeeId = String(item?.employeeId ?? "").trim();
    if (!fboName || !employeeId) continue;
    if (fboToAssembly.has(fboName) || assemblyToFbo.has(employeeId))
      throw new Error("assembly_employee_crosswalk_not_unique");
    fboToAssembly.set(fboName, employeeId);
    assemblyToFbo.set(employeeId, fboName);
  }
  return { fboToAssembly, assemblyToFbo };
}

function hasWork(record) {
  return (
    record.total > 0 ||
    (record.coefficient !== null &&
      record.coefficient !== undefined &&
      record.coefficient > 0)
  );
}

function eventFamily(operationId) {
  if (operationId === "packing") return "packing";
  if (operationId === "cut" || operationId === "assembly") return "cut";
  return "other";
}

function itemsFor(record) {
  if (record.sourceKind === "assembly") {
    return (record.events || []).map((event) => ({
      family: eventFamily(event.operationId),
      type: normalized(event.productType),
      quantity: event.quantity,
    }));
  }
  const items = [];
  for (const [family, quantity, types] of [
    ["cut", record.cut, record.cutTypes || []],
    ["packing", record.packed, record.packTypes || []],
  ]) {
    if (quantity <= 0) continue;
    const sum = types.reduce((total, item) => total + item.quantity, 0);
    const complete = sum === quantity;
    if (!complete || !types.length) {
      items.push({ family, type: "", quantity });
      continue;
    }
    types.forEach((item) =>
      items.push({
        family,
        type: normalized(item.name),
        quantity: item.quantity,
      }),
    );
  }
  return items;
}

function overlapPossible(left, right) {
  const leftItems = itemsFor(left);
  const rightItems = itemsFor(right);
  return leftItems.some((a) =>
    rightItems.some(
      (b) =>
        a.family === b.family &&
        (!a.type || !b.type || a.type === b.type) &&
        a.quantity > 0 &&
        b.quantity > 0,
    ),
  );
}

function emptyTotals() {
  return {
    machineCut: 0,
    manualCut: 0,
    cut: 0,
    packed: 0,
    total: 0,
    coefficient: 0,
    coefficientComplete: true,
    recordCount: 0,
  };
}

function addRecord(totals, record) {
  totals.machineCut += record.machineCut;
  totals.manualCut += record.manualCut;
  totals.cut += record.cut;
  totals.packed += record.packed;
  totals.total += record.total;
  totals.recordCount += 1;
  if (record.coefficient === null || record.coefficient === undefined)
    totals.coefficientComplete = false;
  else totals.coefficient += record.coefficient;
}

function finalizeTotals(totals) {
  return {
    machineCut: totals.machineCut,
    manualCut: totals.manualCut,
    cut: totals.cut,
    packed: totals.packed,
    total: totals.total,
    coefficient: totals.coefficientComplete ? totals.coefficient : null,
    recordCount: totals.recordCount,
  };
}

export function reconcileAssemblySources({
  fboRecords,
  assemblyRecords,
  fboStatus,
  assemblyStatus,
  crosswalk = FBO_ASSEMBLY_EMPLOYEE_CROSSWALK,
  startDate,
  endDate,
}) {
  const inPeriod = (record) =>
    record.date >= startDate && record.date <= endDate;
  const fboPeriod = fboRecords.filter(inPeriod);
  const assemblyPeriod = assemblyRecords.filter(inPeriod);
  const { fboToAssembly, assemblyToFbo } = mappingIndex(crosswalk);

  // FBO's legacy roster appends a numeric employee label (for example,
  // "Арина 8"), while Assembly stores the same employee's plain name. Join
  // only exact, one-to-one name matches in this reporting period. Ambiguous
  // names remain separate and continue to require review.
  const fboNamesByKey = new Map();
  const assemblyIdsByKey = new Map();
  fboPeriod.forEach((record) => {
    const key = employeeNameKey(record.employee);
    const names = fboNamesByKey.get(key) || new Set();
    names.add(record.employee);
    fboNamesByKey.set(key, names);
  });
  assemblyPeriod.forEach((record) => {
    const key = employeeNameKey(record.employee);
    const ids = assemblyIdsByKey.get(key) || new Set();
    ids.add(record.employeeId);
    assemblyIdsByKey.set(key, ids);
  });
  for (const [key, names] of fboNamesByKey) {
    const ids = assemblyIdsByKey.get(key);
    if (names.size !== 1 || ids?.size !== 1) continue;
    const [fboName] = names;
    const [employeeId] = ids;
    if (
      fboToAssembly.has(fboName) ||
      assemblyToFbo.has(employeeId) ||
      !employeeId
    )
      continue;
    fboToAssembly.set(fboName, employeeId);
    assemblyToFbo.set(employeeId, fboName);
  }

  const fbo = fboPeriod.map((record) => {
    const employeeId = fboToAssembly.get(record.employee) || null;
    return {
      ...record,
      sourceKind: "fbo",
      sourceEmployee: record.employee,
      employeeId,
      identityKey: employeeId
        ? `assembly:${employeeId}`
        : `fbo:${record.employee}`,
      mappingStatus: employeeId ? "confirmed" : "unmapped",
      reconciliationStatus: "clear",
      reconciliationReason: "",
    };
  });
  const assembly = assemblyPeriod.map((record) => ({
    ...record,
    identityKey: `assembly:${record.employeeId}`,
    mappingStatus: assemblyToFbo.has(record.employeeId)
      ? "confirmed"
      : "unmapped",
    reconciliationStatus: "clear",
    reconciliationReason: "",
  }));

  const byDate = new Map();
  [...fbo, ...assembly].filter(hasWork).forEach((record) => {
    const list = byDate.get(record.date) || [];
    list.push(record);
    byDate.set(record.date, list);
  });
  const unresolvedFboNames = new Set();
  const unresolvedAssemblyIds = new Set();
  const conflicts = [];

  for (const [date, records] of byDate) {
    const fboDay = records.filter((record) => record.sourceKind === "fbo");
    const assemblyDay = records.filter(
      (record) => record.sourceKind === "assembly",
    );
    const sourcesAvailable =
      fboStatus === "available" && assemblyStatus === "available";
    if (!sourcesAvailable) {
      records.forEach((record) => {
        record.reconciliationStatus = "unknown";
        record.reconciliationReason = "source_unavailable";
      });
      continue;
    }
    if (!fboDay.length || !assemblyDay.length) continue;

    const missingNames = fboDay.filter((record) => !record.employeeId);
    const missingIds = assemblyDay.filter(
      (record) => !assemblyToFbo.has(record.employeeId),
    );
    if (missingNames.length || missingIds.length) {
      missingNames.forEach((record) => {
        unresolvedFboNames.add(record.employee);
        record.reconciliationStatus = "needs_review";
        record.reconciliationReason = "employee_mapping_required";
      });
      missingIds.forEach((record) => {
        unresolvedAssemblyIds.add(record.employeeId);
        record.reconciliationStatus = "needs_review";
        record.reconciliationReason = "employee_mapping_required";
      });
    }

    const conflicted = new Set();
    const mappedFboDay = fboDay.filter((record) => record.employeeId);
    const mappedAssemblyDay = assemblyDay.filter((record) =>
      assemblyToFbo.has(record.employeeId),
    );
    for (const fboRecord of mappedFboDay) {
      for (const assemblyRecord of mappedAssemblyDay) {
        if (
          fboRecord.employeeId === assemblyRecord.employeeId &&
          overlapPossible(fboRecord, assemblyRecord)
        ) {
          conflicted.add(fboRecord);
          conflicted.add(assemblyRecord);
          conflicts.push({
            date,
            employeeId: fboRecord.employeeId,
            fboName: fboToAssembly.get(fboRecord.employeeId),
            employee: assemblyRecord.employee,
            fboQuantity: fboRecord.total,
            assemblyQuantity: assemblyRecord.total,
            reason: "same employee, day, operation family and product type",
          });
        }
      }
    }
    conflicted.forEach((record) => {
      record.reconciliationStatus = "needs_review";
      record.reconciliationReason = "possible_aggregate_overlap";
    });
  }

  const sourceTotals = { fbo: emptyTotals(), assembly: emptyTotals() };
  [...fbo, ...assembly].forEach((record) =>
    addRecord(sourceTotals[record.sourceKind], record),
  );
  const approvedRecords = [...fbo, ...assembly].filter(
    (record) => record.reconciliationStatus === "clear" && hasWork(record),
  );
  const approved = emptyTotals();
  approvedRecords.forEach((record) => addRecord(approved, record));
  const hasUnresolved = [...fbo, ...assembly].some(
    (record) => record.reconciliationStatus !== "clear" && hasWork(record),
  );
  const sourceMissing =
    fboStatus !== "available" || assemblyStatus !== "available";
  const reconciliationStatus = sourceMissing
    ? "unknown"
    : hasUnresolved
      ? "needs_review"
      : "clear";

  return {
    fboRecords: fbo,
    assemblyRecords: assembly,
    status: reconciliationStatus,
    message:
      reconciliationStatus === "clear"
        ? "Источники за выбранный период сопоставлены; возможные совпадения не найдены."
        : sourceMissing
          ? "Один из источников недоступен. Общий KPI за этот период нельзя подтвердить."
          : "Есть активная работа из обоих источников без подтверждённого сопоставления или с возможным пересечением; спорные суммы исключены из общего KPI.",
    pendingMappings: {
      fboNames: [...unresolvedFboNames].sort((a, b) =>
        a.localeCompare(b, "ru-RU"),
      ),
      assemblyEmployeeIds: [...unresolvedAssemblyIds].sort(),
    },
    conflicts,
    sourceTotals: {
      fbo: finalizeTotals(sourceTotals.fbo),
      assembly: finalizeTotals(sourceTotals.assembly),
    },
    approvedTotals: approved.recordCount > 0 ? finalizeTotals(approved) : null,
    approvedRecordCount: approved.recordCount,
    startDate,
    endDate,
  };
}
