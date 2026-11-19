# Assembly v2: склад и выезд

`assemblyV2Transport.js` signs only the fixed Assembly origin and the declared warehouse/supply/work service routes. Each request signature includes method, exact path/query, timestamp, nonce and SHA-256 body. Assembly consumes nonces and rejects replay. Existing Sites service access stays separate from application authorization.

`assemblyV2Warehouse.js` reads all pages at one database revision, validates totals and keeps a previous snapshot with a stale marker after failure. Native direction cartons use transport IDs `av2:<local-id>`; copied cartons retain their original legacy IDs. Warehouse receipts are a separate stock list, without invented production supply identities.

Legacy comparison uses number, physical state, effective quantity and exact original supply/position/SKU lines. A fresh unchanged baseline can be served from v2 once verified against the old source. Source edits prefer old current data until reconciled; independent edits in both versions or duplicate numbers block sending. Native cartons do not require a successful Google refresh. Old-source dispatch tables and snapshots are preserved.

Sending rereads current data, checks the caller's fingerprint and closed status, then sends a signed command to the target. The target transaction creates a frozen departure and reserves the carton. Returning one carton detaches it while preserving the previous departure. A retry of the same command cannot create another departure. RITM invalidates its new-carton cache after acknowledgement.

`warehouseExports.js` stores the exact selected snapshot in `ritm_warehouse_exports`. A repeated key returns the same content; changed input with that key is rejected. History and operational backup retain snapshots. Marketplace workbooks use an uploaded empty template with explicit column mappings, validated empty data area, known identifiers and a preview. This does not claim compatibility with an unseen official template or assign marketplace handling-unit barcodes.

Supply delivery remains parallel: existing Apps Script queue is unchanged, v2 has its independent durable queue. Work retry also runs without a new supply, rate-limited once every 30 seconds while RITM is active. Pending work stays in target D1 if the network is unavailable.

No legacy Sheets, Apps Script, queue secrets or delivery receipts are written by this integration. Staff should record a physical result in one Assembly version; new work is not mirrored back into the old Google WorkLog.
