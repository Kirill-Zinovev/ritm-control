import { sourceId } from "./config.js";
import { callAssemblyV2 } from "./assemblyV2Transport.js";
import { CloudSheetsReader } from "./googleSheets.js";

// The old workbook remains the authoritative archive. Read only the two
// identity columns, including their headers, in a single Sheets request.
export async function archivedPositionHasWork(reader, documentId, positionId) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${documentId}/values:batchGet`);
  const columns = [["WorkLog","F"],["CartonContents","E"]];
  for (const [sheet,col] of columns) url.searchParams.append("ranges",`'${sheet}'!${col}:${col}`);
  const response = await reader.request(url.href);
  const archive = await response.json();
  if (archive.spreadsheetId !== documentId || archive.valueRanges?.length !== columns.length)
    throw Error("archive_unconfirmed");
  let found = false;
  for (const [index,[sheet,col]] of columns.entries()) {
    const range = archive.valueRanges[index];
    const address = String(range.range).replaceAll("'", "");
    if (!new RegExp(`^${sheet}!${col}(?:1)?:${col}[0-9]*$`).test(address) ||
        !Array.isArray(range.values) || range.values[0]?.[0] !== "positionId")
      throw Error("archive_column_unconfirmed");
    if (range.values.some(row => row[0] === positionId)) found = true;
  }
  return found;
}

export async function deliverAssemblyOnlyRemoval(bindings, event, fetcher = fetch) {
  try {
    const reader = new CloudSheetsReader(bindings,{fetcher});
    if (await archivedPositionHasWork(reader,sourceId(bindings,"assemblyDatabaseId"),event.positionId)) return "rejected";
    const {eventId,shipmentId,itemId,positionId} = event;
    const response = await callAssemblyV2(bindings,"/api/ritm/remove-manual-item",{
      method:"POST",body:JSON.stringify({eventId,shipmentId,itemId,positionId}),fetcher,
    });
    if (!response.ok) return "pending";
    const receipt = await response.json();
    if (receipt.ok !== true || receipt.eventId !== eventId) return "pending";
    if (receipt.status === "synced") return "synced";
    return receipt.status === "rejected" && receipt.reason === "item_has_work" ? "rejected" : "pending";
  } catch { return "pending"; }
}
