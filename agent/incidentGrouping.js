function sameRowReferences(formula, row) {
  const expression = String(formula || "").replace(/"(?:[^"]|"")*"/g, ""),
    columns = new Set();
  for (const match of expression.matchAll(
    /(^|[^A-Z0-9_!])\$?([A-Z]{1,3})\$?(\d+)(?![A-Z0-9_])/gi,
  ))
    if (Number(match[3]) === row) columns.add(match[2].toUpperCase());
  return columns;
}

function lookupRoot(incident) {
  if (
    incident.type !== "calculation_error" ||
    incident.monitorStatus !== "open" ||
    !incident.rowContext?.cells
  )
    return null;
  const match = String(incident.cell || "").match(/^([A-Z]{1,3})(\d+)$/),
    row = Number(match?.[2]),
    key = incident.rowContext.cells.E?.value,
    message = incident.observed?.message || "",
    missing = message.match(
      /^Did not find value ['"](.+)['"] in VLOOKUP evaluation\.$/,
    );
  if (!match || !missing || !key || String(key).trim() !== missing[1].trim())
    return null;
  const references = sameRowReferences(incident.observed?.formula, row),
    rootColumn = [...references].find((column) => {
      const dependency = incident.rowContext.cells[column];
      return (
        dependency?.error &&
        dependency.formula &&
        /\bVLOOKUP\s*\(/i.test(dependency.formula)
      );
    });
  if (!rootColumn) return null;
  return {
    key: [incident.sourceId, incident.sheet, row, rootColumn, String(key)].join(
      "\u001f",
    ),
    row,
    rootColumn,
    rootCell: rootColumn + row,
    productKey: String(key),
    lookupFormula: incident.rowContext.cells[rootColumn].formula,
    lookupSheet:
      incident.rowContext.cells[rootColumn].formula.match(/'([^']+)'!/)?.[1] ||
      "справочнике",
    message,
  };
}

function cellUrl(url, cell) {
  if (!url) return null;
  return url.replace(/&range=[^&]*/, "") + "&range=" + encodeURIComponent(cell);
}

/**
 * Merge only calculation-error symptoms with an explicit shared VLOOKUP root.
 * Independent errors (for example, a DIV/0 in another formula) stay separate.
 */
export function groupActiveIncidents(incidents) {
  const groups = new Map();
  for (const incident of incidents) {
    const root = lookupRoot(incident);
    if (!root) continue;
    const group = groups.get(root.key) || { root, incidents: [] };
    group.incidents.push(incident);
    groups.set(root.key, group);
  }
  const byId = new Map();
  for (const { root, incidents: members } of groups.values()) {
    if (members.length < 2) continue;
    const affectedCells = members
        .map((item) => ({
          gid: item.gid,
          sheet: item.sheet,
          cell: item.cell,
          error: item.observed?.error || "N_A",
          url: cellUrl(item.sourceUrl, item.cell),
        }))
        .sort((a, b) => a.cell.localeCompare(b.cell, "en")),
      rootCauseGroup = {
        rootCell: root.rootCell,
        productKey: root.productKey,
        lookupSheet: root.lookupSheet,
        lookupFormula: root.lookupFormula,
        affectedCells,
        count: affectedCells.length,
      },
      ids = new Set(members.map((item) => item.id));
    for (const item of members) {
      byId.set(item.id, {
        ...item,
        groupedRootCause: rootCauseGroup,
        relatedIncidentIds: [...ids].filter((id) => id !== item.id),
        relatedIncidentCount: members.length,
        sourceUrl: cellUrl(item.sourceUrl, root.rootCell),
        cause: `По артикулу ${root.productKey} поиск в ${root.rootCell} не нашёл запись в листе «${root.lookupSheet}». Эта общая ошибка передалась в ${affectedCells.map((cell) => cell.cell).join(" и ")}.`,
        recommendation: `Проверьте наличие артикула ${root.productKey} в листе «${root.lookupSheet}». Формулы в ${affectedCells.map((cell) => cell.cell).join(" и ")} совпадают с наблюдаемыми зависимостями; переписывать их не предлагается.`,
        impact:
          "Ошибка поиска и затронутые расчёты подтверждены; размер влияния на KPI не измерен.",
      });
    }
  }
  const emitted = new Set(),
    result = [];
  for (const incident of incidents) {
    const grouped = byId.get(incident.id);
    if (!grouped) {
      result.push(incident);
      continue;
    }
    const ids = [incident.id, ...(grouped.relatedIncidentIds || [])].sort();
    const groupKey = ids.join("\u001f");
    if (emitted.has(groupKey)) continue;
    emitted.add(groupKey);
    const primary = membersInOriginalOrder(incidents, ids)[0];
    result.push(byId.get(primary.id));
  }
  return result;
}

function membersInOriginalOrder(incidents, ids) {
  const wanted = new Set(ids);
  return incidents.filter((incident) => wanted.has(incident.id));
}
