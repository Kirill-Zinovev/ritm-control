// Refresh ahead of the five-minute write guard. A cached snapshot can already
// be several minutes old when first displayed.
export function printingRefreshDelay(snapshotAt, now = Date.now()) {
  const timestamp = Date.parse(snapshotAt);
  return Number.isFinite(timestamp) ? Math.max(1000, timestamp + 290000 - now) : null;
}

export function printingSnapshotTime(snapshotAt) {
  const timestamp = Date.parse(snapshotAt);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(timestamp) + ' МСК';
}
