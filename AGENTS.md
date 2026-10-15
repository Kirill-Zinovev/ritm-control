# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Workstation layout

RITM is used only on workstation monitors. Keep the full navigation permanently visible on the left; do not collapse it into a mobile menu. This is a user requirement from 2026-10-07.

## Printing data

Printing reads the seasonal red-building spreadsheet on the server. Each of the 11 registered working tabs is a separate delivery. Employee aliases: п = Павел, д = Дмитрий, а = Андрей. Planned area comes from J and planned pieces from O. Printing KPI uses only unique attributable records from «Журнал выпуска»: operation D = «Печать», production date B, employee C, quantity J, and output area L. «Выпуск по дням» is a QUERY summary of the same journal. Do not add \_SYSTEM_ROLLS completions or replace journal areas with recalculated roll areas. The record timestamp M is not the production date. This source choice is a user requirement from 2026-10-07. Include rows hidden by filters. New supply tabs must be registered in worker/printing.js. Poll while the page is open every 5 minutes and retain the previous successful result after a read error.

The owner confirmed that «Лукман» is a roll cutter. Accept this name only for «Резка» journal entries, include valid cutting records in separate cutting totals, and never count those records as printing output or a printer profile.

For «OZON РУЛОННАЯ ПЕЧАТЬ» order rows, column E («Артикул») alone determines whether a row is active. If E is empty, calculation errors anywhere in the configured row context are expected and must not create incidents, even when another cell such as O is populated. If E contains an article, report calculation errors in the row context, including column F. Keep formula-change checks governed by their own approved rules.

## Employee profiles

Design decision from 2026-10-08: clicking an assembler opens the selected first mock's right-side drawer; clicking a printer opens the selected second mock's full employee profile.
Use only source-backed daily output in both calendars. A blank date means the source has no entry and does not prove the person was absent. Assembler coefficients are summed from daily FBO records; printer area comes only from unique attributable rows in the printing journal.

## FBO dashboard coefficients

The visible «По дням · Дашборд» tab (gid 605337763) is an additional source for daily assembler coefficients and its «Командный» row. On 2026-10-08, the dashboard showed dates 2026-10-01 through 2026-10-21. All 64 employee/date values that overlapped «История производства» matched within 0.00001; 39 were nonzero. The «Командный» value matches the unweighted average of employees with a nonzero coefficient for that day. Do not add dashboard values to history totals: this is a cross-check/summary, while «История производства» remains the full-detail source for cut/pack quantities, work types, longer history, and precise coefficients.

## RITM Intelligence

Stage 1 is read-only. Never modify production Google Sheets, norms, salaries, business logic or deploy production automatically. Keep local-agent secrets and SQLite outside Git. Private monitoring API requires owner authentication; no unauthenticated public repair or private-data endpoints. Use existing printing journal semantics and source-backed FBO coefficients. Missing records are not zero KPI; preserve verified snapshots with stale labels after read failures. No demo incidents, invented causes or unmeasured performance gains. Formula and LLM analysis remain explicitly not configured in stage 1.

## Table Doctor — stage 2 (2026-10-08)

Production Google Sheets remain read-only, including Telegram. Owner actions only create local repair requests or ignore incidents. Approved templates and explicit exceptions determine confirmed violations; pending templates require owner review. Do not infer broken formulas from neighboring cells. The user authorized a clearly labelled local fixture demonstration; never mix fixture findings or KPIs with actual production. Enable it only using RITM_DOCTOR_DEMO_ENABLED=true. Google credentials must remain outside the repository. Keep Worker routing and production KPI calculation intact.

## Approved monitoring scope and browser (2026-10-09)

Table Doctor read-only monitoring now covers four documents/ten tabs: FBO (gid 0 and 605337763); OZON First Shop document 1YTQQ1Mg9kVv7EOQiN6wOvkvnHvsiXcwbhYOERUPy8rQ (gid 1580315960, 1335787439); seasonal printing (gid 437912546, 725126844, 572942359); and OZON РУЛОННАЯ ПЕЧАТЬ (gid 119710351, 126956215, 2053830156). Keep the new workbook read-only and its planned-area formula pending until the owner approves its exact template. Keep full KPI dependency reads unchanged. Excluded open incidents become out_of_scope, never fixed; preserve SQLite history. New business checks must remain pending previews until explicit owner approval. Do not treat displayed errors or absent days as proven formula damage. Query summaries and value journals do not use supply J4 templates.

Open AI Center at Windows logon in a registered, verified Yandex Browser, maximized, independently of the background monitor. Never alter the default browser or open browser windows from the 600-second monitoring loop.

## Diagnostic decisions (2026-10-09)

Four baseline proposals have source-observed templates SUM(B:D), F*H*I\*O and SUM(G:J), plus journal/daily grouping. Never auto-approve them. Only an owner cookie session with exact Origin may approve a versioned diagnostic contract; approval does not grant Google write permission. Point exceptions require a reason, expiry and exact observation/evidence/rule-version scope; changed evidence invalidates them, other errors stay visible. Preserve incident IDs/history; exceptions and withdrawn rules are suspended, never described as repaired. Raise contract revision when its diagnostic semantics change. Treat the source's <=5 ready threshold and exact OFFSET references contextually; do not invent norms or infer duplicate article business intent. Keep 600-second full registered-area reads and production writer disabled.

## Formula Intelligence (2026-10-10)

Discover full grids on all ten monitored tabs using bounded sequential requests and metadata merges. Group formulas for owner review, but protect exact native formula addresses only after explicit version-bound bulk approval. Never infer an approved original from neighboring cells or unapproved snapshots. Preserve immutable compressed SQLite versions and business-rule decisions. Merge interiors, array spill results and manual gaps are not obligatory formulas. Show read formulas, protected addresses including damaged cells, actually checked addresses and unprotected formulas separately; never subtract protected addresses from native formula count. Source failure, incomplete read or changed merge geometry must not establish successful repair. Point exceptions bind content, merge geometry, baseline version, reason and expiry and remain revocable. Production writes stay disabled until the separate G247 end-to-end test and explicit production authorization. Read-only diagnostic approval grants no repair permission.

## AI Center workflow (2026-10-10)

Keep the default owner screen focused on table health, actionable problems and approvals. Primary navigation is Control Tables, History and Settings. Formula inventories, pending business rules, read/request counters and advanced audits belong in collapsed configuration, with bulk baseline setup first. Show all real incident kinds in the main attention list, including source/API failures; do not silently restrict it to formula diagnostics. Problem cards lead with address, observed input, expected formula, evidence confidence, impact and proposed action; technical IDs/context/history are expandable. Read-only repair requests must be labelled as requests, never imply that Google was edited. Owner requests a single understandable sequence: detection, notification, specific approval, verified repair; production writes stay gated by the separate safe repair test.

## Owner-confirmed production repair (2026-10-10, latest owner decision)

The owner explicitly waived the separate live G247 prerequisite and authorized implementing production repair on request. This supersedes earlier G247 gates above, but does NOT authorize any unspecified cell write. Reuse the existing proposal/confirmation/backup/audit engine. Production mode is opt-in, uses separate credentials outside Git, and accepts only approved Formula Intelligence addresses in the three documents/seven tabs. Proposal creation never writes. Execution requires an owner cookie, exact loopback Origin, immutable proposal version, exact confirmation and concurrent-editing acknowledgement. Re-read native content, merge geometry and baseline version, persist backup before writing one userEnteredValue, read back and rerun Table Doctor. Keep automatic writes/retries/rollback, public repair API and deployments disabled. Sheets pre-read plus write is not atomic; account-level Google access may exceed RITM's whitelist. Do not claim end-to-end production success until a specific owner-confirmed write is actually verified.

Preserve the existing HTTPS Tailscale read origin when enabling local repair. A ts.net hostname is compatibility configuration, not evidence of private-network isolation. Repair endpoints still require loopback Host, socket and Origin, and reject forwarded/proxy headers and remote requests. Do not enable Funnel or change Tailscale access as part of repair setup.

## Owner-confirmed source-data recovery (2026-10-12)

The owner authorizes implementing exact source-data recovery for confirmed `data_quality_root_cause` incidents. This is limited to source cells resolved by an enabled `dataQuality` rule in the approved three documents/seven tabs. The browser request must use an owner cookie and exact loopback Origin; client-supplied cell addresses and values are never accepted. One explicit owner action authorizes the exact source cell and candidate value. A prior value-only confirmation or local `repair_requests` row is evidence for the candidate, not write permission. Do not execute unrelated or merely pending requests.

Before writing, require a recent complete successful source snapshot whose latest non-empty history entry matches the saved request and candidate; re-read the exact source cell, product key and dependent rows through the read-only Sheets reader; verify the source is still empty, dependency formulas are present and unchanged during the pre-write reread, and no repair operation is active. If the value is already present, do not write it again. If the cell contains another value, the request/snapshot is stale, permission is unverified, or validation/merge metadata cannot be proven safe, stop without writing. Use the separate production writer to send one `updateCells` request limited to `userEnteredValue` for that one cell. Save the owner, exact authorization, before value and source snapshot in SQLite before the API call. Never retry after an uncertain write result.

After the write, reread the source and every affected dependency cell, ensure their formulas are unchanged and the results are error-free, then run a complete Table Doctor read. Mark the incident as repaired by the agent only when that complete check confirms resolution; otherwise preserve the open incident and show the precise failure. Persist operation stages and before/after evidence in SQLite. Do not restart the main agent without separate owner permission.

## Exact recovery proposals (2026-10-12, latest owner decision)

The owner requests root-cause grouping and one clear approval followed by real verified repair, without a separate local-request step. Exact VLOOKUP uses its first matching catalog row, including duplicates; never substitute a later duplicate as proof of the original value. Read B/C dependencies even with an older external registry. Snapshot all keyed catalog rows so duplicate keys do not prevent same-cell history collection.

When no historical source value exists, allow the authenticated local owner to propose a text value for an open missing-source incident. This supersedes the prohibition on client-supplied values only for this proposal flow: the server derives the target exclusively from the registered rule, rereads it, checks validation and dependencies, and saves a versioned, expiring owner proposal. This proposal is neither historical evidence nor write permission. A separate single explicit action must approve the exact cell/value/version for writing; no client-supplied addresses are accepted. Historical source recovery keeps its snapshot proof requirements. Recheck first-match lookup selection immediately before writing.

Unprotected formula changes may be monitored against successful immutable versions during fast checks. They remain unapproved evidence and do not change formula_protected. A restoration proposal requires the exact native formula and merge geometry from a pre-incident immutable version. One explicit owner action may approve that particular historical candidate and its exact write; old value-only approvals do not authorize it. Keep all pre-read, backup, conflict, audit, result verification and no-retry safeguards. Never offer formula replacement for a calculation error when the formula matches its baseline.

## Owner-confirmed roll-printing supply deletion (2026-10-13)

Only separately registered supply tabs may be deleted from the supply screen; the registered `OZON МОСКВА 10_10` source template is never deletable there. Deletion requires an authenticated owner action that displays the exact tab title and sheet ID, asks the owner to type the exact title, and states that the tab and its contents will be permanently removed. Before the single `deleteSheet` request, verify writer access and reread the current spreadsheet metadata to match the registered sheet ID and exact title. Verify by rereading metadata that the same ID is gone; only then remove it from the local additional-sheet registry and refresh the read-only printing snapshot. If a write result is uncertain or readback fails, preserve a no-retry state and do not unregister the sheet until a later successful metadata read confirms that its ID is absent; that read-only proof may finalize the audited deletion without another write. Reconcile registered additional sheets against live Google metadata on monitoring cycles; remove an externally deleted sheet from the local registry only after a successful metadata read, and preserve the registry on API errors. Never delete tabs based on names alone or infer deletion from a failed CSV read.

## Owner-confirmed roll-printing supplies (2026-10-13)

The owner requested a working supplies screen backed by the `OZON РУЛОННАЯ ПЕЧАТЬ` workbook. All order tabs remain read-only during monitoring. Creating a supply requires one authenticated owner action that displays and confirms the exact destination tab name and complete article/quantity list. It duplicates only the registered `OZON МОСКВА 10_10` template, writes the requested articles to E, quantities to O and fresh unique service UIDs to AC, and clears copied article/quantity/UID inputs in unused rows of the new copy. Appending requires a separate owner action for one registered roll-printing tab; it fills the next prepared empty rows and never changes existing article/quantity rows or formula cells. A formula in any target field blocks the operation.

Use the existing production writer only when its owner configuration is enabled. Before the batch write, verify edit access, exact template/supply ID and title, input headers, prepared formula columns F/I/J, available capacity and current contents. Duplicate/update in one bounded Sheets batch; then read back the new values, unique UID and formulas. Refresh the read-only printing snapshot and register confirmed new tabs in `worker/printing.js` through the persisted additional-sheet registry. Persist each operation and its owner approval in SQLite. A duplicate operation ID is idempotent. If a write result is uncertain or readback fails, preserve the no-retry state; never replay the write or start another pending request automatically. This permission is limited to owner-confirmed roll-printing supply create/append actions and does not authorize other sheet writes, agent restarts, or arbitrary production repairs.
