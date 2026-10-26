# RITM Sites migration — paused checkpoint, 2026-10-24

The owner requested saving progress and continuing later. Stop feature work at this checkpoint. This is a work-in-progress snapshot, **not a deployment-ready release**.

## Confirmed scope

- Move the production/supplies/employee reporting management RITM to Sites so it works with the working PC switched off.
- Assembly for collectors stays on its existing Apps Script application and URL. Preserve its code, employee workflow, WorkLog, carton contents, numbering and saved coefficients.
- The owner explicitly deferred **AI Center** migration. It stays local, including its database, monitoring and existing history.
- The local RITM should continue to work. The in-progress design sends local management requests to the same cloud operation journal; it must not create a second independent Google writer. Local AI Center repairs against cloud-managed printing documents require coordination with that same cloud writer lease.
- Do not switch or publish until the prepared version has been verified and the owner has separately approved the production switch.

## Source locations

- Active local project: `C:\workspace\ritm-fbo-redesign`; original working changes and running agent were preserved.
- Isolated migration worktree: `C:\workspace\ritm-sites-cloud-migration`.
- Migration branch: `codex/sites-cloud-migration`.
- Base commit: `12bcaaac10a393e46fc5ed07fdc6b7571fa8fc06`.
- The isolated copy includes all working changes present at the start, including ProductionDashboard and the latest supplies design.
- Existing Sites target is the same project declared by `.openai/hosting.json`: RITM — управление производством, `https://ritm-erp.zinovevkirill234.chatgpt.site`.
- Hosted version remains **12**, published 2026-10-08 11:49 MSK from commit `5f18a7b4754411c8148a703ff53c86f2ec0b12ad`.

## Implemented and verified before the most recent bridge draft

- Separate `worker/sites.js` entrypoint. The existing local worker entrypoint stays available.
- Cloud configuration reads Sites bindings instead of `intelligence.local.json`. Bundling rejects remaining `node:*` dependencies; shared hashes/HMAC use a portable adapter backed by `@noble/hashes`.
- Existing production routing, Google write/readback rules and signed Assembly event protocol are reused. Supply persistence is isolated behind `agent/supplyPersistence.js`.
- D1 schema and Drizzle-generated migration cover registry state, operation history, previews, sync outbox, fenced leases, audit and chunked verified snapshots.
- Cloud write state is fail-closed. It requires explicit cutover configuration, a matching cutover receipt, a verified migration and separate writer credentials. Writes to the catalog and Assembly WorkLog through the production writer are forbidden.
- The request journal is checkpointed before Google writes. Uncertain results retain the same operation ID and require verification.
- Private migration export makes an online SQLite backup, then reads that consistent copy. No credentials or runtime data are stored in the repository.
- Import is resumable/idempotent and verifies IDs, payloads, event records and snapshot digests. It preserves the original snapshot time and never marks an old snapshot freshly read.
- Owner authorization uses trusted Sites identity headers and an explicit allowlist; a public Site does not imply public data access. A cloud sign-in notice was added without replacing the RITM shell.

## Verification evidence

The last completed cloud suite passed **17/17** checks, including an actual local Workers/Miniflare runtime with D1. Shared supply/transfer/sync regressions passed **58/58**. Client+server Sites build and TypeScript checks passed. The frontend retains its existing large-chunk warning.

Commands used:

```text
npm run test:cloud
npm run test:migration-domain
npm run typecheck
node scripts/verify-sites-migration.mjs <private operational-state.json> <unchanged baseline repository>
```

Actual copied operational data was imported into an isolated local Workers/D1 instance and compared with the baseline:

| Data | Preserved |
| --- | ---: |
| Production operations | 9 |
| Legacy roll operations | 28 |
| Assembly sync events | 41 |
| Saved transfer previews | 1 |
| Source snapshots equal by digest | 2 |
| Derived roll/box links equal to baseline | 1 |
| External network requests during parity check | 0 |

The source database was read-only. Full backup integrity check returned `ok`. The backup contains 30 tables (approximately 79 MB), preserving the local AI Center history independently of the operational import.

Private artifacts, outside all source checkouts:

```text
%LOCALAPPDATA%\RITMCloudMigration\20261024-164944\ritm-before-sites.sqlite
%LOCALAPPDATA%\RITMCloudMigration\20261024-164944\operational-state.json
%LOCALAPPDATA%\RITMCloudMigration\20261024-164944\inventory.json
```

The initial export captured one historical uncertain test-repair proposal against an unrelated document. It was preserved, not cleared or replayed. The exporter was subsequently improved to retain its target document ID so unrelated repairs do not globally block supply work. Generate a fresh export for the eventual cutover; do not deploy the initial stale export as the final state.

Ignored local evidence: `.checks/migration-parity.json` and `.checks/sites-bundle-inputs.json`.

## Most recent work is drafted, not yet verified

After the passing checks, work began on keeping local RITM usable while AI Center stays local:

- `agent/cloudBridge.js`: signed, bounded operational API proxy; registry mirror; deferred repair coordination.
- `worker/cloud/bridge.js`: scoped signatures, timestamps and nonce replay prevention.
- `worker/cloud/externalLease.js`: shared lease and durable uncertain-result marker for local AI Center writes to cloud-managed printing documents.
- Hooks in `agent/config.js`, `agent/server.js` and `agent/index.js` disable the independent local supply writer/outbox when bridge mode is enabled, preserve local monitoring, and proxy owner-authorized management requests.
- Cloud AI Center endpoints now explicitly state that AI Center remains local.

**These latest changes were not built or tested when the owner paused the task.** In particular:

1. `agent/index.js` still needs to pass `cloudBridge` into the `createAgentServer` options.
2. `db/schema.ts` includes `cloud_bridge_nonces`, but its next Drizzle migration has not been generated. Run `npm run db:generate -- --name=cloud_bridge` and review it; keep the already generated initial migration immutable.
3. Add nonce/signature/scope/replay tests and local-to-cloud proxy tests. Verify local cookie/origin/loopback write checks are preserved.
4. Thoroughly test local AI repair lease acquisition, heartbeat failure, verified release and uncertain recovery before enabling bridge mode. Confirm the actual local repair result shapes used by `localRepairOutcome`.
5. The cloud AI Center screen still needs a clear local-only panel/link rather than the local login/error flow. Do not migrate AI Center or copy its secrets to Sites.

## Remaining deployment work

- Complete the bridge work above and repeat the targeted checks after it.
- Configure cloud reader/writer identities, approved source bindings, owner identity allowlist, Assembly sync secret and scoped maintenance/bridge credentials using the native Sites secret configuration. Secret values must never be logged, committed or placed in frontend code. No cloud environment variables have been changed yet.
- Verify cloud reads against the exact approved Google documents; no writes or synthetic events in working Sheets.
- Configure durable background refresh/outbox retries so they work when all browsers and the PC are closed. The protected maintenance endpoint exists; no cloud schedule has been created.
- Prepare isolated hosted/staging checks and the owner review. No staging Site was created in this session.
- Final cutover must take a fresh online backup/export and reconcile in-flight manager operations/outbox before disabling only the old **supply** writer and enabling the cloud writer. Collectors continue using Assembly throughout. AI Center remains local and uses the shared lease for overlapping document repairs.
- Import the final state, verify row IDs/payloads/KPI snapshots/links, and obtain explicit production publication/switch approval. Preserve hosted v12 and an operation-safe rollback plan; rollback must not discard manager operations accepted after cutover.

## Production preservation

No working Sheets were modified, no Apps Script deployment was changed, no Site version was saved/deployed, no live environment variables were updated and the existing agent was not restarted. Assembly `Code.gs` is byte-identical; `Index.html` is identical after normalizing checkout line endings. All new external operations during tests were mocked or denied.
