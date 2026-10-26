# Sites migration continuation — 2026-10-26

Scope remains unchanged: management RITM is being prepared for PC-independent hosting; Assembly stays on its current application; AI Center remains local. Production switch/publication still requires explicit owner confirmation. This document supersedes the unfinished bridge checklist in the October 24 checkpoint, not its production safety requirements.

## Completed in the isolated migration worktree

- Connected the optional signed cloud bridge to the local server startup. No running agent was restarted and bridge mode is not enabled in production.
- Generated `drizzle/0001_cloud_bridge.sql` for nonce replay prevention; the initial migration is unchanged.
- Local AI repairs renew the shared fenced lease immediately before each external write. A failed renewal prevents sending the write. One repair cannot reuse a lease for another document.
- Cloud repair acquisition refuses unresolved supply operations. Expired leases leave a durable repair marker; a conflicting cloud write remains blocked until a verified result or confirmed non-write is reconciled.
- Corrected classification of source-recovery results: `already_restored` and explicit `write_rejected` retain their actual outcomes. Acknowledged but unverified writes remain uncertain.
- Cloud AI Center shows a local-only explanation and local link. It does not mount the local monitoring/login workflow. The local version keeps its existing screen.
- Test commands use explicit synthetic source configuration. An old source-recovery fixture now resolves its synthetic document from the same test registry as the tested writer rather than a mismatching hard-coded ID. Production approval rules were not loosened.

## Verification

| Check | Result |
| --- | --- |
| Cloud and bridge tests, including local Workers/D1 | 24/24 |
| Shared supply, transfer and sync regressions | 58/58 |
| Local repair and source-recovery regressions | 44/44 |
| Sites shell, printing and employee/source calculations | 48/48 |
| TypeScript | Passed |
| Frontend and Sites Worker build | Passed; existing chunk-size warning |

Bridge checks include signature binding to body/method/query, replay and expiry rejection, route restrictions, no blind write retry after a lost response, owner session/origin/proxy guards on the local API, pending cloud-operation refusal, lease expiry/recovery and revalidation before each write. These are local isolated tests, not evidence of hosted production performance.

Browser QA used an isolated server on port 5199 with only synthetic `/api/runtime` and explicit unavailable responses for other APIs. Confirmed the AI Center message and local link, preserved navigation and the production screen's unavailable-source state. No runtime console warnings/errors on the AI Center screen. This preview never queried working sources. The temporary server is stopped after QA.

## Fresh copied-state parity

Private backup/export location (outside Git): `%LOCALAPPDATA%/RITMCloudMigration/20261026-resume/`.

Digest: `e1d4f63e27812a06d2cd3fb428d717651756f245d7c88f80fd800415c24f6c40`.

The read-only SQLite source was backed up online and passed its integrity check. Import into isolated Miniflare/D1 retained 9 production operations, 28 legacy roll operations, 41 sync events, 1 transfer preview and 2 exact snapshot digests. Derived Assembly box links matched the unchanged original service. No external requests; writes disabled. One historical pending repair remains preserved. This is a rehearsal snapshot; eventual cutover still needs a fresh export and reconciliation.

## Read-only hosted state checked this turn

The existing management Site remains version 12, public audience, owned by the caller. Its runtime environment has revision 0 and no variables. No linked automations exist. No hosted secrets, source versions, audience settings, schedules or deployments were changed.

## Remaining gates

1. Isolated hosted verification on Sites, including trusted visitor identity and Google access with explicit approved resource bindings. Local Miniflare does not prove the hosted configuration.
2. Store credentials only in native Sites runtime secrets; no credentials in source, browser, schedule prompts or artifacts. Keep cloud writes disabled until cutover is approved and recorded.
3. Validate the intended unattended maintenance caller and persisted readback before creating a linked refresh/outbox schedule. A configured endpoint or saved schedule alone is insufficient proof.
4. Inspect and reconcile pending manager operations; prepare a fresh final export and verify exact IDs, payloads, snapshots and source links.
5. Obtain owner approval before changing the existing published management Site or switching the management writer. Preserve local AI Center and existing Assembly. Rollback must retain operations accepted after switching.

Production Sheets, Assembly code/deployment, local runtime configuration and the running local agent were not changed.
