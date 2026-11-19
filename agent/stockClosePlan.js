// Completion is for the current aggregate row, not an individual addition.
// Construct a guard from a fresh source snapshot before any archive/write.
const value = cell => cell?.effectiveValue?.stringValue ?? cell?.userEnteredValue?.stringValue ?? '';
const articleKey = text => String(text || '').trim().toUpperCase().replace(/\(OZ\)$/u,'').trim();
export function stockClosePlan({entry, snapshot, readiness}) {
  if (!entry || !snapshot || !entry.uid || !['box','roll'].includes(entry.department) || !['urgent','warehouse'].includes(entry.destination) || snapshot.sheetId !== entry.sheetId)
    throw new Error('Не подтверждена исходная строка задания.');
  const matches=snapshot.rows.filter(row=>articleKey(row.article)===articleKey(entry.article));
  if(matches.length!==1 || matches[0].row!==entry.row) throw new Error('Строка задания изменилась или артикул повторяется. Обновите данные.');
  const current=matches[0], uid=String(value(snapshot.data[current.row-1]?.values?.[29])).trim();
  if(uid!==entry.uid || !Number.isSafeInteger(current.quantity) || current.quantity<=0) throw new Error('Идентификатор или план задания изменился.');
  if(readiness?.print!=='done' || readiness?.cut!=='done') throw new Error('Печать и порезка ещё не подтверждены.');
  return {department:entry.department,destination:entry.destination,sheetId:entry.sheetId,row:current.row,uid,article:current.article,quantity:current.quantity};
}
