# Forecast/calendar and next-assignment joke verification

## Findings and changes

The live planning record contains no resource capacities. The new OZON Moscow 13.11.2026 (store 1) supply has readiness 2026-11-18 16:00 Moscow and shipping 2026-11-23 15:00 Moscow; their stored UTC instants are correct. A numerical ETA cannot be computed without real rates and work windows. No sample capacities were saved to production.

Bounded, read-only Google Sheets inspection found newly created roll rows with an explicit full remaining-print quantity and blank status/progress/date/roll cells. The source reader now emits forecast-only zero facts for this guarded case with a RITM-generated UUID. Legacy rows, missing headers, errors, partial remaining quantities and any work evidence stay unknown. The ordinary readiness response and all source cells remain unchanged. Explicit null planning facts remain unknown, and Xerox physical-sheet conversion still uses multiplicity.

Resource settings show all inputs before activation, with a clear enable instruction. The calendar includes pending resources even without configuration; setup controls are owner-only. Opening a supply in the calendar selects its forecast completion or saved deadline date. Filters still affect only the displayed rows, not competing production capacity. Missing and inconsistent quantity messages are distinguished.

The owner-requested phrase "Задание в деле. Кофе — по желанию, мастерство — обязательно!" is configured for one new verified assignment. A durable claim is written alongside that notification, so delivery retries, old callbacks, disabled notifications and unrelated reminders/completions cannot consume or repeat it. Normal humor settings are preserved. No test assignment or chat message was created.

## Files

- `worker/printing.js`: guarded fresh-order forecast facts.
- `src/productionForecastData.ts`, `src/productionForecastModel.ts`: explicit facts and diagnostics.
- `src/ProductionForecast.tsx`, `src/ProductionForecast.css`: setup and calendar behavior.
- `worker/cloud/bitrixNotifications.js`, `worker/cloud/services.js`: one-time assignment phrase.
- `tests/printing.test.mjs`, `tests/production-forecast.test.ts`, `tests/bitrix-notifications.test.mjs`: regression coverage.
- `UX-CONTRACT.md` and this verification record.

## Verification

- Related Arkady/Bitrix, Sites, printing, stock authorization and Assembly API tests: 136 passed.
- Domain tests: 63 passed, including source-fact conversion, shared scheduling, deadlines, work windows and large deterministic queues.
- Compiled Worker API tests: 5 passed, including owner/manager authorization, D1 settings persistence, origin checks and revision-conflict protection, without Google traffic.
- TypeScript and production build: passed. Existing large-chunk build warning remains.
- Isolated headless Chromium: actual calendar/settings components, missing-resource lanes, visible disabled fields, enable/edit/save, deadline focus, week/today navigation, no body overflow and no page errors. All API and external requests were blocked; zero production requests. User mouse and browser sessions were untouched.
- Screenshots visually inspected. No live production quantities, work history, resource settings or shared-chat messages changed during verification.

Packing remains explicitly outside this forecast phase. Real capacities must be entered by the owner before the app can estimate unfinished work. Historical or inconsistent source rows intentionally remain unknown. The wider intelligence suite has pre-existing fixture/configuration failures recorded in `arkady-compact-catalog-verification-20261113.md`; this change does not claim to resolve them.
