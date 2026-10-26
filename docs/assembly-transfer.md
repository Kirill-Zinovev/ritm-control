# Explicit Assembly transfer — release 2026-10-21

The owner selected roll printing and box production as sources. `agent/assemblyTransfer.js` accepts only a read-only Sheets reader and the existing signed Assembly outbox. It cannot write to production sources. Source IDs are allowlisted; E4/O4 headers, visible sheet identity, quantities, UIDs and shared RITM manifests are validated.

The owner reviews exact selected SKUs and source quantities. An expiring SQLite preview captures source fingerprints. Confirmation rereads every source before enqueue. Apps Script validates the signed request, acquires the existing sync lease, rechecks fingerprints and writes only marked derived Assembly tabs. Shared managed supplies retain their existing complete identity; unlinked sources retain stable roll or box provenance and union previously selected positions. No WorkLog, cancellation or carton records are rewritten.

The durable queue distinguishes transfer requests from coalesced reconcile events. Successful receipts are persisted; a changed source yields a terminal conflict; unavailable sources and unknown delivery results retry the same event identity. Apps Script saves bounded receipts for idempotency. Normal reconciliation refreshes transferred subsets without silently importing additional rows.

## Verification

- Typecheck passed.
- Existing domain, Sites, Intelligence and Assembly suites passed.
- Focused transfer/service/queue/Apps Script checks: 123 passed, 0 failed, including bounded source ranges and legacy sheets without AC.
- Frontend production build succeeded in an isolated temporary output directory because the live agent serves the repository's `dist/client`; active assets were not overwritten. Existing large-chunk warnings remain.
- Strict UI audit: 8 pre-existing findings in untouched AICenter, TelegramMiniApp, DiagnosticReview and shared Button detection; no finding in the new transfer component. Audit JSON: `%TEMP%/ritm-transfer-audit.json`.
- Browser checks on the isolated fixture: selection, invalid quantity, empty search, clear, retained selection, subset transfer, receipt, linked two-department review, stale-source rejection, native select, 390px layout with local table scrolling and no document overflow. The fixture uses synthetic data only.

## Release record

Assembly version 43 was published by updating the existing deployment, preserving its URL. The frontend production bundle was built into `dist/client` and the existing `RITM Intelligence` scheduled task relaunched the agent. Process start was confirmed at 11:38 Moscow time; `/api/assembly-transfers/sources` is mounted and retains owner authentication (401 in an unauthenticated verification browser), and the supplies page serves the new transfer button. The Apps Script web app returned HTTP 200 and the existing deployment listing reported version 43. Production source sheets and the Assembly mirror were not changed for verification. A real transfer requires the owner to sign in to the local AI Center first; no real transfer was submitted.
