// Completion is for the current aggregate row, not an individual addition.
// Construct a guard from a fresh source snapshot before any archive/write.
const value = cell => cell?.effectiveValue?.stringValue ?? cell?.userEnteredValue?.stringValue ?? '';
export const stockArticleKey = text => String(text || '').trim().toUpperCase().replace(/\(OZ\)$/u,'').trim();
export const stockRowUid = (snapshot, row) => String(value(snapshot.data[row-1]?.values?.[29])).trim();

export function stockClosePlan({entry, snapshot, readiness}) {
  if (!entry || !snapshot || !entry.uid || !['box','roll'].includes(entry.department) || !['urgent','warehouse'].includes(entry.destination) || snapshot.sheetId !== entry.sheetId)
    throw new Error('Не подтверждена исходная строка задания.');
  const matches=snapshot.rows.filter(row=>stockArticleKey(row.article)===stockArticleKey(entry.article));
  if(matches.length!==1 || matches[0].row!==entry.row) throw new Error('Строка задания изменилась или артикул повторяется. Обновите данные.');
  const current=matches[0], uid=stockRowUid(snapshot,current.row);
  if(uid!==entry.uid || !Number.isSafeInteger(current.quantity) || current.quantity<=0) throw new Error('Идентификатор или план задания изменился.');
  if(snapshot.rows.some(row=>row.row!==current.row && stockRowUid(snapshot,row.row)===uid)) throw new Error('Идентификатор задания встречается в нескольких строках.');
  if(readiness?.print!=='done' || readiness?.cut!=='done') throw new Error('Печать и порезка ещё не подтверждены.');
  return {department:entry.department,destination:entry.destination,sheetId:entry.sheetId,row:current.row,uid,article:current.article,quantity:current.quantity};
}
