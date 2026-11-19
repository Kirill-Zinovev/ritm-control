# Parallel Assembly operation

The owner authorized copying the current legacy ledger and connecting both Assembly versions to RITM on 14 November 2026. The old Sheets, Apps Script, delivery URL, signing key and delivery receipts remain outside the new channel.

## Data preservation

`legacy.restore` is available only behind the existing private Site access boundary. Batches retain the original source IDs, full source rows, workbook SHA-256 and a completion manifest. Production work comes from `WEB_APP_RITM`; seeded/test sources remain in the original private backup. WorkLogCorrections remain cancellations rather than deleted work. Repeating an unchanged row does not add quantities. An altered historical work event is rejected.

Native v2 work and cartons are preserved. Restoration temporarily satisfies the normal work-insert guards within one transaction, restoring the exact original readiness and employee-active flags before commit. Imported inactive supplies stay read-only. A row-to-UID alias is accepted only with the original physical sheet, row, article, department and canonical shipment as evidence.

Legacy carton contents use `av2_legacy_allocations` because missing capacity must remain null. `av2_all_allocations` supplies the same complete contents to stock checks, carton views and exports. Unknown capacity blocks further placement in that carton. Warehouse receipts do not create work. Original employee attribution, timestamps and manual receipts remain separate from production facts.

Shift norms come from the actual `нормы` sheet, not its seeded OperationNorms example. Machine cutting uses pieces × sheets per product / sheet norm; packing and manual cutting use pieces / shift norm. The effective piece norm and coefficient are frozen with each new work event. Existing unknown historical coefficients are never recalculated from today's catalog. A conflicting type or missing/error sheet count remains unknown and does not block quantity entry.

Sent statuses come from RITM's own dispatch ledger, independently of the old Sheets. Sent cartons stay out of the ready list. Preserved dispatch snapshots are used for historical exports. A sent carton without an original frozen snapshot cannot produce a purported historical export.

The private `/api/legacy/backup?sha256=...` GET/PUT route archives original files and verification artifacts in R2. PUT verifies SHA-256; GET allows an independent read-back check. Files are never public. Local operational artifacts stay in ignored `.local/`.

## Work delivery

Each native `work.save` and `work.cancel` transaction appends its stable ID to `av2_ritm_work_outbox`. Saving never waits for Google or RITM. The Worker drains the queue after commands and during visible revision checks; RITM's delivery/maintenance path also triggers a retry. Failures retain the same ID with backoff. Only a matching receipt marks delivery complete.

`POST /api/assembly-v2/events` is signed with the existing separate v2 key over method, path, timestamp, nonce and SHA-256 of the body. Legacy imports do not produce duplicate work in RITM. Cancellations are separate events and can refer to the original legacy event ID. A queue acknowledgement is not proof of physical shipment.

## Supply delivery and performance

RITM owns an independent durable supply outbox. A confirmed creation commits the new job with the production journal. The new queue cannot acknowledge or replace an old queue entry. It requires the persisted canonical shipment ID, source revision and position count in the target receipt. The existing maintenance workflow and ordinary RITM requests retry delivery; this is not a claim of a continuously running Worker timer.

Collector snapshots request only cartons in the selected marketplace/store/destination. Manager carton and dispatch screens explicitly load the full list. The original UI and left supply navigation remain in place.

## Verification and rollback

Use isolated SQL/runtime tests for create/save/cancel/failure/retry scenarios; never create fake production work. Before live import, archive the original workbook, native v2 facts, RITM dispatch snapshot, prepared batches and verification report. Compare original IDs, quantities, cancellations, physical contents, sent statuses and warehouse totals after import. Reopen the database and repeat the import to verify durability/idempotency.

An application rollback uses the previous saved Site version. It does not remove newly saved work or migrations. A data rollback requires a separately authorized, source-ID-specific reconciliation; never overwrite the whole live database with an older snapshot.
