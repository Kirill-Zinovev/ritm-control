# Verification — 2026-10-07

- `npm run typecheck`: passed, no TypeScript errors.
- `npm run test:domain`: 8 tests passed. Includes daily coefficient math, unknown versus confirmed zero, weekend/future exclusion, warehouse grouping, idempotent reservations, roll square-meter total, atomic import replacement, duplicate ID rejection, invalid date/norm rejection and CSV quoting.
- `npm run build`: passed. React production assets and required Sites worker metadata emitted. Config uses Vite native config loader because this Windows sandbox prevents esbuild ancestor directory discovery.
- `npm run test:sites`: 4 tests passed.
- `npm run format:check`: passed.
- `node scripts/check-render.mjs`: all 7 pages passed server rendering. This is not browser verification.
- DESIGN.md official linter: zero errors; non-blocking orphan-token warnings. Canonical mapping documented.
- `audit_project.py --mode strict`: blocked; installed Python alias cannot start in this session. Not claimed as passed.
- Browser QA (2026-10-07): local preview opened. Mobile menu and supplies navigation were verified at the narrow responsive layout; see design-qa.md. Full keyboard, console, and visual comparison remain pending.
- Local preview server is running on port 4173; mobile navigation and supplies layout were visually checked.

Real Google Sheets automatic reading and cross-table shipment joins are not implemented. User CSV import is available; sources remain honest about their connection state. This is a frontend prototype for review, not yet a multi-user ERP.

- Responsive fix: supply grid children now have a zero minimum width, and the mobile grid has a zero-minimum track to prevent the detail table from widening the page. Rebuilt and visually rechecked the supplies page.
