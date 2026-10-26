# Owner-confirmed source-data recovery

`SourceRecoveryService` restores a source value only from an open, confirmed
`data_quality_root_cause` incident and its current saved request. The owner action
is a single explicit write authorization; the earlier confirmation of a candidate
value alone never grants write permission. The local API accepts only the
incident ID. The service resolves the cell, sheet, document and value from the
SQLite incident/request and the enabled `dataQuality` registry rule.

Before the write, the service checks a recent complete source snapshot and its
latest known non-empty history value, confirms that the saved request and
incident generation still agree, checks that no other repair is active, verifies
the separate writer's Google Drive `canEdit` capability, and rereads the source
cell and dependent production rows. It writes one `userEnteredValue` with one
Google Sheets `updateCells` request. It does not retry an uncertain request.

After the API accepts the change, the service rereads the source and every
affected dependency row, checks the stored formulas and calculated results, then
runs a fresh, document-scoped Table Doctor check. `runDocument()` returns an
explicit `documentRun` result with `documentId`, `startedAt`, `at`, `status` and
`complete`; Source Recovery accepts only a fresh successful result for the same
document (with a compatibility check against a fresh per-document check record).
The service automatically completes the saved request and closes the incident
through the same SQLite transaction and audit event. It records the owner,
approval time, exact target/value, original and final cell states, dependency
results, API result, full-check time and duration for each stage in
`source_recovery_operations` and SQLite history. AI Center exposes stage timings
on the operation details.

If Google has acknowledged the write but readback, recalculation, full check or
finalization fails, the operation is `written_unverified` (“Записано, проверка
не завершена”), the request remains in review and automatic re-execution is
blocked. A restart while the operation is in `checking` recovers it to that same
state and records the interrupted stage. A restart while the writer call is
still in flight remains `uncertain`; it also blocks any retry until a separate
read-only reconciliation. Neither path sends another write. Bounded retries are
read-only checks for delayed Sheets recalculation and are measured as part of the
readback stage. An already-filled source is never overwritten; a conflicting
value, stale snapshot, API refusal or failed recalculation remains visible for
review. A rejected API write is marked blocked, while a transport failure with
an unknown outcome is marked uncertain.

The owner-only route is `POST /api/intelligence/formula-repair/source-recovery`
with `{ incidentId, explicitWriteApproval: true }`. It has the same local owner
cookie, loopback host/socket and exact loopback-Origin requirements as other
production repairs. Operation stages shown in AI Center are “Ожидает
подтверждения записи”, “Исправляется”, “Проверяется”, “Записано, проверка не
завершена” and “Исправлено”; failures show their stored cause and measured stage
durations.

Google Sheets does not offer an atomic compare-and-set for a single cell. The
service rereads immediately before writing and verifies afterward, but a separate
editor can still race within that short interval. No employee access settings are
changed.
