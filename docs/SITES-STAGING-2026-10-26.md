# Isolated Sites staging — 2026-10-26

The owner explicitly approved a separate closed test Site. This is not a production cutover.

- Site: `https://ritm-staging-20261026.zinovevkirill234.chatgpt.site/?page=production`
- Project: `appgprj_6adef14d992c8191b693b16ba6a1a9dc`
- Separate source checkout: `C:\workspace\ritm-sites-staging-20261026`
- Source commit: `f2c819d3bd11419a5008252b1bd4ba7b357b05de`
- Saved version: `appgprj_6adef14d992c8191b693b16ba6a1a9dc~appgver_ba55d20070e88191bdf5f5eb26897342`
- Successful deployment after owner configuration: `appgdep_6adef3b8de4481919886dbf415f0ea5d`, environment revision 2.
- Access: custom owner-only policy, no external visitors. The site's actual owner visitor ID was obtained from its authenticated identity response and stored in a secret runtime allowlist. Account IDs were not substituted for visitor IDs.

## Isolation

This checkout is a sanitized archive of migration commit 7af57f3 with an independent Git repository and manifest. Its build uses the staging-only `worker/staging.js` entrypoint. Do not copy that build entrypoint into the production cutover.

`validateStaging` requires exact synthetic resource IDs, the synthetic mode flag, writes explicitly disabled and an empty synthetic Google-reader object. Real/unknown IDs, Google writer/reader credentials, Assembly receiver URL, sync secret, bridge secret and cutover ID are rejected. All source/OAuth/webhook requests from cloud API are routed to a rejecting fetcher. No real data import is permitted. Management POST routes are disabled. Only the bounded synthetic seed endpoint can populate the staging database after its explicit test approval and authentication.

The Stage has its own D1 binding with all ten schema tables. Hosted migrations were applied by Sites. No production spreadsheet or snapshot contents were uploaded. Seeded data is one fabricated three-article supply (shops 1 and 2), including a 110% packing example; employee history is empty. The template descriptor names visible in filters are static source definitions, not fetched production contents.

Native Sites runtime secrets hold the temporary scoped test maintenance credential. It was generated in memory, not committed or placed in source, frontend or logs. Its plaintext is not recoverable from this document; rotate only the staging credential if future verification requires a fresh service session.

## Checks

- Local staging guard and actual Workers/D1 tests: 2/2 passed, zero external requests.
- TypeScript and full client/server build passed; existing bundle-size warning remains.
- Hosted service status: HTTP 200, writes disabled, network forbidden.
- Hosted synthetic import: HTTP 200, 2 persisted snapshots; observed request time 1156 ms.
- Repeated same import: HTTP 200, `repeated:true`, original receipt retained; 114 ms.
- Hosted status after import: ready, writes still disabled; 160 ms.
- Management create attempt: HTTP 403 `staging_write_forbidden`; 71 ms.
- These are single smoke-test timings, not p50/p95 or production performance claims.
- Native read-only D1 inspection independently confirmed exactly one `cloud_imports` record with two snapshot receipts.
- The built-in browser initially failed the ChatGPT login (`invalid_auth_step`). The owner completed login manually. The authenticated identity response then confirmed `authorized:true` after staging-only allowlist configuration and redeployment of the same saved source version.
- Browser verification: production screen rendered the synthetic 1200 plan / 800 packed / 400 remaining; shop 2 filter narrowed this to one 200-piece article; update retained the same persisted data; 110% and +50 over-plan remained visible. AI Center displayed the local-only panel. Production screen console had no warnings/errors.
- Ignored screenshot: `.checks/sites-staging-20261026.png`.

## Preserved production

Read-only `get_site` confirmed the existing management project `appgprj_6ac6187dc23881918cdefb7a80f20654` remains version 12. Its environment, audience, source, deployment and schedules were not changed. Running local RITM, working Google Sheets and collector Assembly were not changed.

## Remaining work before production migration

This verifies private Sites delivery, trusted owner access and isolated persistence only. It does not verify real Google-source access, the unattended scheduler, actual employee reporting, production writes or end-to-end Assembly delivery in the cloud. Those still need bounded tests against separately approved resources, fresh cutover export/reconciliation and a rollback plan. Production publication/switch still requires the owner's separate explicit confirmation.
