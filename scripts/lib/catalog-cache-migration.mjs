// Content-only migration. Callers must back up and reread every addressed cell
// before applying requests. It never changes plans, IDs, work logs or formatting.
const legacyReference = /(?:'Cache'|\bCache)!|(?:'БДО'|\bБДО)!/u;
const normalizeHeader = value => String(value || '').trim().toLocaleLowerCase('ru-RU');

export function catalogCacheFormula({ formula, department, row, column, header }) {
  if (!['roll', 'box'].includes(department) || !Number.isSafeInteger(row) || row < 1 || !Number.isSafeInteger(column) || column < 1)
    throw new TypeError('Unconfirmed cache migration address');
  if (!formula || !legacyReference.test(formula)) return formula;
  if (row < 5) throw new Error('Unexpected legacy cache reference in a header');
  if (/(?:'БДО'|\bБДО)!/u.test(formula)) {
    // Both imports have the same A:O schema and the same first source row.
    const result = formula.replace(/(?:'БДО'|\bБДО)!/gu, "'Cache FBO'!");
    if (legacyReference.test(result)) throw new Error('Mixed legacy cache reference');
    return result;
  }
  const lookup = /^=VLOOKUP\((?:\$?E:\$?E|\$?E\$?\d+);(?:'Cache'|Cache)!\$?([AB]):\$?([A-Z]+);(\d+);(?:0|FALSE)\)$/iu.exec(formula);
  if (!lookup) throw new Error('Unknown legacy Cache formula: ' + formula);
  const range = lookup[1].toUpperCase() + ':' + lookup[2].toUpperCase();
  const index = Number(lookup[3]), label = normalizeHeader(header);
  const sku = `REGEXREPLACE(UPPER(TRIM($E${row}));"\\(OZ\\)$";"")`;
  const fromFbo = (end, offset) => `=IF($E${row}="";"";VLOOKUP(${sku};'Cache FBO'!$B:$${end};${offset};FALSE))`;
  if (department === 'roll' && ((range === 'A:G' && index === 7) || (range === 'B:P' && index === 15)) && /кратность/u.test(label))
    return fromFbo('Q', 16);
  // FBO R contains pasted errors in the live catalog. Reuse the already
  // authorized layouts import, extended from B:L to B:Q without moving A:K.
  if (department === 'box' && ((range === 'B:Q' && index === 16) || (range === 'A:G' && index === 7)) && /кратность/u.test(label))
    return `=IF($E${row}="";"";VLOOKUP(${sku};'_RITM_МАКЕТЫ'!$A:$P;16;FALSE))`;
  if (department === 'roll' && range === 'A:D' && index === 4 && label === 'станок')
    return fromFbo('O', 14);
  if (department === 'roll' && range === 'A:U' && index === 21 && /наличие макета/u.test(label))
    return `=IF(E${row}="";"";IF(IFERROR('_RITM_МАКЕТЫ'!$A$1="Артикул";FALSE);IFNA(IF(VLOOKUP(TRIM(E${row});'_RITM_МАКЕТЫ'!$A$2:$K;11;FALSE)="Есть";"Есть";"Макет не готов");"Не в таблице макетов");"Проверить источник макетов"))`;
  throw new Error('Legacy Cache schema does not match the confirmed column: ' + header);
}

export function planCatalogCacheSheet(sheet, department) {
  const cells = new Map();
  for (const block of sheet.data || []) for (const [ri, record] of (block.rowData || []).entries())
    for (const [ci, cell] of (record.values || []).entries()) cells.set(`${ri + (block.startRow || 0) + 1}:${ci + (block.startColumn || 0) + 1}`, cell);
  const changes = [];
  for (const [address, cell] of cells) {
    const formula = cell.userEnteredValue?.formulaValue;
    if (!formula || !legacyReference.test(formula)) continue;
    const [row, column] = address.split(':').map(Number);
    const header = cells.get(`4:${column}`)?.userEnteredValue?.stringValue;
    const replacement = catalogCacheFormula({ formula, department, row, column, header });
    if (replacement !== formula) changes.push({ row, column, before: formula, after: replacement });
  }
  return { sheetId: sheet.properties.sheetId, title: sheet.properties.title, changes };
}

export function catalogCacheRequests(plan) {
  return plan.changes.map(change => ({ updateCells: {
    start: { sheetId: plan.sheetId, rowIndex: change.row - 1, columnIndex: change.column - 1 },
    rows: [{ values: [{ userEnteredValue: { formulaValue: change.after } }] }], fields: 'userEnteredValue',
  } }));
}

// Every supported per-row catalog formula addresses the SKU in E. Preserve
// fixed E$ references and string literals rather than using a generic digit swap.
export function shiftCatalogSkuRow(formula, delta) {
  return formula.split(/("(?:[^"]|"")*")/u).map((part, i) => i % 2 ? part
    : part.replace(/(\$?E)(\d+)\b/gu, (_, column, row) => column + (Number(row) + delta))).join('');
}

export function catalogCacheGroups(plan) {
  const changes=[...plan.changes].sort((a,b)=>a.column-b.column||a.row-b.row), groups=[];
  for(const change of changes){
    const prior=groups.at(-1),delta=prior?change.row-prior.startRow:0;
    if(prior&&prior.column===change.column&&prior.endRow===change.row-1
      &&shiftCatalogSkuRow(prior.before,delta)===change.before
      &&shiftCatalogSkuRow(prior.after,delta)===change.after) prior.endRow=change.row;
    else groups.push({sheetId:plan.sheetId,title:plan.title,column:change.column,startRow:change.row,endRow:change.row,before:change.before,after:change.after});
  }
  return groups;
}
