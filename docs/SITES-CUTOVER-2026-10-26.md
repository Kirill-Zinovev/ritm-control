# RITM management cloud cutover — 2026-10-26

The owner explicitly requested the full management migration, preserving collector Assembly and keeping AI Center local. The owner later requested completing server checks without further browser control; no further Computer Use was performed after that request.

## Live result

- Existing management address: `https://ritm-erp.zinovevkirill234.chatgpt.site`.
- Existing project: `appgprj_6ac6187dc23881918cdefb7a80f20654`; its public shell audience was preserved. Working APIs require a trusted Sites visitor ID on the explicit owner allowlist or the separately scoped signed local bridge.
- Saved/deployed version: **18**.
- Saved version ID: `appgprj_6ac6187dc23881918cdefb7a80f20654~appgver_b7947b43be088191aee48f611962c9f7`.
- Successful final deployment: `appgdep_6adeffbe851c81919f141048f4243630`.
- Source commit in the Site repository: `70aca501e400c2570ff4ab2f7cf0fc69465e130f6`.
- Runtime environment revision: **3**. Cloud writes enabled; migration import disabled and its temporary token removed.
- Collector Assembly URL/code/deployment were not changed. No synthetic work events or supplies were written to working Sheets. Assembly `Code.gs` hashes matched between active and migration checkouts.
- AI Center, its monitoring and its SQLite history remain local.

## State preservation

The authenticated existing local agent was stopped/restarted through its existing Scheduled Task and maintenance procedure. The replacement process was verified against the actual listener on port 4318. The restart took an online backup before stopping the old actor, verified database integrity and compared prior historical rows. No missing/changed history, incidents, protected formulas, immutable formula versions, repair requests or source-recovery records were found. Active repair/recovery queues were zero. The real local AI write-start count remained unchanged.

Local supply writers and the old local Assembly outbox are disabled in bridge mode. Authenticated local management calls now reach the cloud journal. AI repairs touching the cloud-managed printing documents use the shared fenced lease and persistent uncertainty marker. Local source/registry monitoring continues; the verified local registry again contains one managed supply and its box link. Current local SQLite quick_check is `ok`.

The final import came from the consistent pre-stop backup, not a moving live database:

`%LOCALAPPDATA%/RITMIntelligence-Preview/backups/before-formula-intelligence-20261026-065014.sqlite`

Private export/backup directory: `%LOCALAPPDATA%/RITMCloudMigration/20261026-final/`.

Final import digest: `beded68dffaa121f53797e19f5f5cc02dac57ab1613fd5c7b63c046659f1a0bf`.

The server read back and compared all imported records and receipts before marking migrationReady:

| Item | Count |
| --- | ---: |
| Production operations | 9 |
| Legacy roll operations | 28 |
| Sync events and their existing delivery state | 41 |
| Transfer previews | 1 |
| Initial source snapshots | 2 |

All manager operations were settled before enabling the cloud actor; pending deliveries were zero. One historical uncertain repair for an unrelated test document was preserved, not replayed or cleared. A durable cutover receipt binds the final import digest to the confirmed disabled local supply actor.

Source/config backups: `%LOCALAPPDATA%/RITMCloudMigration/20261026-cutover-source/`. Existing local uncommitted user work was backed up and retained. Local static assets were updated additively; previous hashed assets were not deleted, and the previous client directory was copied to the protected backup. The local bridge secret inherits the protected owner secret file ACL. No credentials were committed or placed in client builds/schedule prompts.

## Hosted verification and resolved incompatibilities

The first hosted real-source checks exposed Workers-specific transport incompatibilities that synthetic fetch mocks had not reproduced: native fetch receiver binding and unsupported `redirect:error`. The reader/writer/queue now invoke callbacks without rebinding the receiver. Cloud transport uses manual redirects and explicitly rejects unexpected redirects, preserving the security boundary. Fresh-source checks also refuse to label internally stale/incomplete results as freshly verified. Prior verified snapshots remain marked stale on failure.

The final hosted checks returned:

- `/api/roll-supplies/status`: cloud mode, available true.
- `/api/printing`: 899 positions, packing available, stale false, refreshFailed false, quality valid and invalidRecords 0.
- `/api/assembly`: 8 current employee rows, 636 history rows, stale false, refreshFailed false, quality valid and invalidRecords 0.
- The same cloud state was verified through authenticated localhost:4318 requests.
- Post-enable server maintenance succeeded: deliverySkipped false, queue configured, pending 0; both sources refreshed successfully. Total observed single-run request time was approximately 16.9 seconds. This is not a p50/p95 claim.
- No fake production creation was used to test the writer. Creation/append/delete and sync correctness were covered by isolated shared-domain regression tests; the live writer uses the existing separate production credential and approved document allowlist.
- Pre-existing catalog coverage remains partial: 358 positions matched a shop, 43 had no confirmed match. Migration did not invent or edit those source values.

Verification: 30 cloud/transport/cutover/recovery checks passed in the final source package, plus 58 shared supply/transfer/sync regressions. Earlier UI/source calculation tests passed 48/48, and local repair/source-recovery tests passed 44/44. TypeScript and client/Worker build passed; the existing large-bundle warning remains.

## Background refresh

Sites rejected the requested five-minute cloud-task cadence: its task scheduler allows at most one run per hour. An enabled hourly task was saved instead, linked to this Site:

- Name: `Обновлять RITM`.
- ID: `Automation_99238afb89808191a9985be6700ee37a`.
- Timezone: Europe/Moscow, hourly from 10:15.
- Action: call the Site's owner-authorized `ritm_refresh` MCP tool once. It runs the same server maintenance function verified above; it does not create supplies or modify norms, WorkLog or cartons.

The Site MCP plugin was already installed; no second plugin was created. The scheduler's first actual tool execution was not independently confirmed in the available task surface. Do not equate an enabled saved task or MCP discovery requests with a successful scheduled refresh. Manual/background server access and persistence were verified separately. Open-page polling/manual refresh remain independent of the hourly schedule; data requests refresh snapshots after their five-minute freshness window.

## Recovery without losing post-cutover operations

`GET /api/cloud/export` is owner/bridge protected and exports only the operational state, receipts, source identities and snapshots, never runtime credentials or local AI state. The export takes the production lease for a consistent journal read and carries a verified digest. A post-cutover export was downloaded to the private backup directory as `cloud-after-cutover.json`, validated against the import schema and digest, and retained all 9 + 28 operations, 41 events and both fresh snapshots. Its digest is `4f2594c4e4ed295ac18556c7c6088cdecb3b9871e8bbd0f3789da055919fe072`.

For any future rollback, first disable cloud writes, reconcile in-flight writes, and obtain a fresh cloud export. Keep D1 and its journal intact. Reverting to a compatible saved cloud version preserves D1 operations. Do not re-enable the pre-cutover local writer against an old SQLite snapshot: operations accepted after cutover must be merged and verified by ID and content first. The collector app does not need to switch during this procedure.
