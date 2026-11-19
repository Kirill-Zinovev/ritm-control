# Warehouse production jobs in Assembly

The owner approved a separate «Запасы» navigation entry on 2026-11-12. It reads only «Запасы склад» from the configured stock box and roll books. «Срочные 2 этаж» is excluded. This replaces the former exclusion of warehouse production jobs from Assembly; ordinary supplies keep their current grouping and controls.

`GET /api/assembly-stocks` is an authenticated, read-only projection. Assembly uses its existing signed reverse channel. Source document IDs are server configuration, never client input. Missing or ambiguous article, quantity, UID, archive or source data fails closed.

The canonical virtual shipment is `RITM-STOCK-WAREHOUSE`, direction `ROLL` for existing journal compatibility. Positions retain department, book, sheet, source UID and article. Increasing an existing plan retains its position; readding an archived article with a new UID starts a separate job. The production close archive keeps closed print/cut jobs available to collectors, with one position during the temporary current/archive overlap. No production row or work event is copied or changed by reading.

The light Assembly navigation, article search, filters, completed-items view, work modal, cancellation and idempotency are reused. A green stock navigation mark and explicit production department/readiness labels distinguish these jobs. Unknown production readiness is shown as unconfirmed. Product photos, names and norms use only OZON references. A failed refresh preserves the established read-only error/retry behavior.

Collector work uses the same named WorkLog and correction ledger. RITM accepts only this exact additional shipment ID; saved quantities and coefficients enter the existing reconciliation. No historical coefficients are recomputed. Journal rows with duplicate event/idempotency identities remain unconfirmed rather than counted twice.

All placement for these jobs goes to the current warehouse carton for the confirmed catalog store and marketplace, through the existing durable stock split operation. The employee is mandatory. Different stores remain separate. Retrying the same placement key does not create another allocation. The existing «На склад» view, manual new carton and close actions remain available. Ordinary-supply excess routing is unchanged.

Verification uses isolated sheet fixtures and a headless browser with mocked mutations. Production checks are read-only; no fabricated work or cartons may be written to the working journals.

## Verified delivery, 2026-11-12

- Published Assembly version 109 and RITM's signed stock endpoint. A headless read of the working Assembly displayed 28 unique jobs: 3 box and 25 roll jobs, 5,500 pieces in total. All 28 had catalog photos; the WorkLog read was confirmed. No production rows, work or cartons were added by verification.
- 196 focused Assembly/stock/roll-panel tests passed, plus 60 Sites tests, TypeScript checking and the production build. Separate cloud/WorkLog/bridge tests (31) and cloud-worker/manager-session tests (6) passed. Four stock workflows also passed against the actual Assembly-live source with isolated workbook IDs. Headless stock placement and roll recovery used mocked writes only.
- Roll panel transport version `2026-11-12.2` was installed and reread in both the main and stock roll script projects. Only `RollsV2Panel` and `RollsV2PanelApi` changed there. Transient Google reads back off, keep the last card, and retry without replaying writes. Permanent validation failures stay explicit. Small labels and low-contrast helper text were made readable without changing the layout or writer functions.
- Exact per-user Google execution logs could not be inspected: the Apps Script Processes API returned 403 for insufficient OAuth scopes. Read-failure recovery was verified with injected INTERNAL/server failures; this does not prove the underlying Google service error cannot recur for that user.

Changed source files:

- `apps-script/assembly/Code.gs`, `apps-script/assembly/Index.html`
- `apps-script/assembly-live/Code.gs`, `apps-script/assembly-live/Index.html`
- `worker/cloud/assemblyStock.js`, `worker/cloud/runtime.js`, `worker/cloud/bridge.js`
- `worker/assemblyWorkLog.js`, `worker/warehouseCartons.js`
- `apps-script/stock-gateway/RollsV2Panel.html`, `apps-script/stock-gateway/RollsV2PanelApi.gs`
- `scripts/patch-roll-panel-transport.mjs`
- `tests/assembly-stock.test.mjs`, `tests/assembly-supply-sync.test.mjs`, `tests/assembly.test.mjs`, `tests/cloud-bridge.test.mjs`, `tests/stock-roll-panel-resilience.test.mjs`
- `docs/assembly-warehouse-stock.md`
