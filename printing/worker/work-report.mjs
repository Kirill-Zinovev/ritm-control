import { timingSafeEqual } from 'node:crypto';
import { json } from './http.mjs';

const pageSize = 250;
const finishedOrdinal = Number.MAX_SAFE_INTEGER;

function authorized(request, key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return false;
  const supplied = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  return !!supplied && timingSafeEqual(Buffer.from(supplied), Buffer.from(key));
}

function cursor(url, name, fallback) {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function workEvent(row) {
  const fact = JSON.parse(row.fact);
  return {
      id: row.id + ':' + row.ordinal,
      receiptId: row.id,
      at: row.at,
      supplyId: row.supplyId,
      supplyName: row.supplyName,
      department: row.department,
      rowId: row.rowId || null,
      article: fact.article,
      operation: fact.operation,
      employee: fact.employee,
      pieces: fact.pieces,
      area: fact.area > 0 ? fact.area : null,
      sheets: fact.sheets,
      rollId: fact.rollId ?? null,
      rollName: fact.rollName || '',
      ...(fact.correction === true ? { correction: true, before: fact.before, after: fact.after } : {}),
  };
}

function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) return null;
  const start = new Date(month + '-01T00:00:00+03:00');
  const next = new Date(month + '-15T12:00:00Z');
  next.setUTCMonth(next.getUTCMonth() + 1, 1);
  const end = new Date(next.toISOString().slice(0, 10) + 'T00:00:00+03:00');
  return [start.toISOString(), end.toISOString()];
}

// Reporting reads the committed journal. Imported SQLite rehearsal receipts and
// the quantities seeded into printing_positions are not new production work.
export async function printingWorkReport(db, request, key) {
  if (request.method !== 'GET' || !authorized(request, key)) return json({ message: 'Маршрут недоступен.' }, 404);
  const url = new URL(request.url);
  const bounds = monthBounds(url.searchParams.get('month'));
  if (!bounds) return json({ message: 'Укажите месяц журнала.' }, 400);
  const after = (url.searchParams.get('after') ?? '0:0').match(/^(\d+):(\d+)$/)?.slice(1).map(Number);
  const revision = await db.prepare(`
    SELECT COALESCE(MAX(rowid), 0) AS watermark,
      (SELECT ready FROM printing_import WHERE singleton=1) AS ready
    FROM printing_receipts`).first();
  if (revision.ready !== 1) return json({ message: 'Перенос базы ещё не подтверждён.' }, 503);
  const through = cursor(url, 'through', revision.watermark);
  if (!after?.every(Number.isSafeInteger) || through === null || after[0] > through || through > revision.watermark)
    return json({ message: 'Некорректная позиция в журнале.' }, 400);

  const { results } = await db.prepare(`
    SELECT r.rowid AS sequence, CAST(f.key AS INTEGER) AS ordinal,
      r.id, r.recorded_at AS at, r.supply_id AS supplyId, f.value AS fact,
      s.department, s.name AS supplyName,
      CASE
        WHEN json_extract(r.payload,'$[1]')='correct' THEN json_extract(r.payload,'$[2][0].rowId')
        WHEN s.department='box' THEN json_extract(r.payload,'$[1].rowId')
        ELSE json_extract(r.payload,'$[3]['||f.key||'].rowId')
      END AS rowId
    FROM printing_receipts r JOIN printing_supplies s ON s.id=r.supply_id
    JOIN json_each(r.facts) f
    WHERE r.rowid>=? AND r.rowid<=? AND r.commit_token<>'sqlite-import'
      AND (r.rowid>? OR CAST(f.key AS INTEGER)>?)
      AND r.recorded_at>=? AND r.recorded_at<?
      AND json_extract(f.value,'$.operation') IN ('print','cut')
    ORDER BY r.rowid, CAST(f.key AS INTEGER) LIMIT ?`).bind(after[0], through, ...after, ...bounds, pageSize + 1).all();
  const page = results.slice(0, pageSize);
  const complete = results.length <= pageSize;
  const next = complete ? through + ':' + finishedOrdinal : page.at(-1).sequence + ':' + page.at(-1).ordinal;
  return json({ schemaVersion: 1, through, next, complete, work: page.map(workEvent) });
}
