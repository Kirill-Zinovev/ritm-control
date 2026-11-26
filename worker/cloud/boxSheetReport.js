import { readBoxSheetReport } from "../../agent/boxSheetReport.js";

const cacheKey = "printing-box-sheet-report";
const freshFor = 8000;

export async function readLiveBoxSheetReport(reader, spreadsheetId, store) {
  const view = (state, snapshot) => ({
    ok: true,
    state,
    checkedAt: snapshot ? new Date(snapshot.at).toISOString() : null,
    report: snapshot?.value ?? null,
  });
  const isFresh = snapshot => snapshot && store.now() - snapshot.at < freshFor;
  if (!spreadsheetId) return view("stale", null);

  let previous = await store.snapshot(cacheKey).catch(() => null);
  if (isFresh(previous)) return view("ready", previous);

  let lease;
  try {
    lease = await store.acquire(cacheKey, 18000);
    previous = await store.snapshot(cacheKey).catch(() => previous);
    if (isFresh(previous)) return view("ready", previous);

    const value = await readBoxSheetReport(reader, spreadsheetId, AbortSignal.timeout(12000));
    const at = store.now();
    await store.saveSnapshot(cacheKey, value, lease, at);
    return view("ready", { at, value });
  } catch (error) {
    return view(error?.code === "cloud_operation_busy" ? "syncing" : "stale", previous);
  } finally {
    if (lease) await store.release(lease).catch(() => {});
  }
}
