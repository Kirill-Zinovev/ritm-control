# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Workstation layout

RITM is used only on workstation monitors. Keep the full navigation permanently visible on the left; do not collapse it into a mobile menu. This is a user requirement from 2026-10-07.

## Printing data

Printing reads the seasonal red-building spreadsheet on the server. Each of the 11 registered working tabs is a separate delivery. Employee aliases: п = Павел, д = Дмитрий, а = Андрей. Planned area comes from J and planned pieces from O. Printing KPI uses only unique attributable records from «Журнал выпуска»: operation D = «Печать», production date B, employee C, quantity J, and output area L. «Выпуск по дням» is a QUERY summary of the same journal. Do not add _SYSTEM_ROLLS completions or replace journal areas with recalculated roll areas. The record timestamp M is not the production date. This source choice is a user requirement from 2026-10-07. Include rows hidden by filters. New supply tabs must be registered in worker/printing.js. Poll while the page is open every 5 minutes and retain the previous successful result after a read error.

## Employee profiles

Design decision from 2026-10-08: clicking an assembler opens the selected first mock's right-side drawer; clicking a printer opens the selected second mock's full employee profile.
Use only source-backed daily output in both calendars. A blank date means the source has no entry and does not prove the person was absent. Assembler coefficients are summed from daily FBO records; printer area comes only from unique attributable rows in the printing journal.
## FBO dashboard coefficients

The visible «По дням · Дашборд» tab (gid 605337763) is an additional source for daily assembler coefficients and its «Командный» row. On 2026-10-08, the dashboard showed dates 2026-10-01 through 2026-10-21. All 64 employee/date values that overlapped «История производства» matched within 0.00001; 39 were nonzero. The «Командный» value matches the unweighted average of employees with a nonzero coefficient for that day. Do not add dashboard values to history totals: this is a cross-check/summary, while «История производства» remains the full-detail source for cut/pack quantities, work types, longer history, and precise coefficients.
