# Machine workload design QA

final result: passed

## Visual truth and evidence

- Selected design: last approved shipment-centered mock, `C:/Users/Пользователь/.codex/generated_images/01a1249a-9743-73c0-864a-535405b3cd5f/exec-9e37b7c2-34ab-40b4-9ff5-6456b0b0a067.png` (1586×986).
- Implementation: `http://127.0.0.1:4322/machine-workload-preview.html`, same real component as `/?page=machines`, explicitly synthetic data.
- Desktop: `artifacts/machine-workload/desktop-final.jpg`, viewport 1586×986 CSS pixels, 1576×980 captured image after platform scrollbars; density 1. Source/implementation normalized in `comparison.jpg` and shipment-lane crops in `comparison-detail.jpg`.
- Drilldown: `artifacts/machine-workload/article-detail.jpg`.
- Responsive: `artifacts/machine-workload/mobile-final.jpg` (390×844 viewport) and `intermediate.jpg` (1024×900 viewport).

## Findings and fixes

- [P2, fixed] Initial toolbar and test controls displaced shipment content. Test scenario controls are now opt-in in the isolated entry. The main toolbar is compact; advanced filters open from a labelled button. The final pass puts shipment cards directly after source status.
- [P2, fixed] Initial mobile shipment selector shrank to a caret. Explicit mobile flex bases now give both selects full width; observed widths 320px each, document scrollWidth/clientWidth both 380px.
- [P2, fixed] Nested station drilldown was too narrow. Expanding a machine gives the department full shipment width, with article-table scrolling contained in its wrapper. No document overflow at desktop, intermediate or mobile.
- [P2, fixed] Station and department typography was weaker than the reference. Supply titles are now 23px, department titles 19px, machine/quantity rows 16px; the existing Cyrillic system font and RITM shell are preserved.
- [P2, fixed] The isolated entry re-created a React root during hot updates. HMR disposal now unmounts its root. A fresh load has no new console errors.

## Required fidelity surfaces

- Typography: readable Cyrillic, clear 42/23/19/16 hierarchy, tabular quantity values, long titles wrap. Secondary helpers remain subordinate.
- Spacing/layout: approved sidebar, two department lanes inside each canonical shipment, right machine overview, compact toolbar, appropriate stacking at smaller widths. Advanced article tables scroll independently.
- Colors/tokens: established RITM blue/white/light canvas preserved. Ozon #005BFF and WB #CB11AB stay local to marketplace badges; warm box tint denotes department, not WB branding.
- Images/icons: existing approved RITM wordmark/backdrop and Lucide icon family reused. No new decorative raster asset is needed. Source-backed photo URLs render with explicit image dimensions and a truthful missing-photo fallback.
- Copy/content: printing quantities are labelled as printing, not overall shipment completion. Unknown/partial values remain unknown. No machine speed, norm, ETA or inferred machine power/running state is shown. Demo quantities are explicitly labelled and use synthetic SKUs.

## Interaction and integrity checks

Verified through Browser: shipment/machine view switch, machine article disclosure, marketplace filter, article search, sidebar machine selection, new synthetic shipment appearance, removal, selected-supply filter reset after removal, unknown-machine grouping and retaining the previous snapshot during an error. Printing/cutting stay separate. Document width equals scroll width at checked sizes; mobile tables scroll inside their wrapper.

Domain suite: 42 tests passed. Source/catalog/production-supply suites: 47 tests passed before the final additive formula-error fallback test; that additional focused test is included for final source checking. These are isolated synthetic tests, with no production Sheets writes. The real local route was opened and shows truthful loading/empty/error states when a working source is unavailable.

## Intentional differences and remaining limits

The existing RITM shell/font/backdrop stays authoritative. The generated mock's ambiguous “В работе/Свободен” and “Общий прогресс” wording is replaced by source-backed printing readiness and remaining quantities. Counts use actual loaded rows, never the mock's invented article counts. Additional user-requested filters are in the advanced panel. No P0/P1/P2 visual or interaction issue remains in the implemented scope.

Live creation/deletion writes were not exercised for QA. This feature derives from the existing confirmed lifecycle; a production source refresh remains the live data validation step. Embedded Google Sheets images absent from a values response remain unavailable unless a photo URL is provided. Other browser sessions adopt shipment changes on their next manual/visible-tab five-minute refresh.

## Follow-up polish

- [P3] The mock has a slightly different wordmark and line-icon shape; the existing approved product assets are intentionally reused.
- [P3] Whole-application JavaScript chunk sizes are existing build warnings and outside this screen's visual scope.
