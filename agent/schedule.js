export function nextScheduledCheck(startedAt, finishedAt, intervalMs) {
  let next = startedAt + intervalMs;
  while (next <= finishedAt) next += intervalMs;
  return next;
}

export function nextFastCheckDelay(startedAt, finishedAt, intervalMs) {
  const elapsed = Math.max(0, finishedAt - startedAt);
  return elapsed >= intervalMs
    ? intervalMs
    : Math.max(15000, intervalMs - elapsed);
}
