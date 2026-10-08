# Design QA

- Source visual truth: the four most recent detailed RITM mockups in the conversation (overview, assembly, printing, supplies).
- Intended viewports: desktop 1600 x 1200; narrow fallback 390px.
- Source image dimensions: conversation display; no original files are available in the project folder.
- Browser preview opened on 2026-10-07 at `http://127.0.0.1:4173/`.
- Mobile navigation: at a narrow responsive viewport (667px screenshot), the Menu control appears, opens a drawer with all seven destinations and the active item highlighted, and exposes its expanded state. Selecting Supplies changes the route and closes the drawer.
- Mobile supplies layout: the first browser screenshot showed page-level horizontal overflow, with supply cards extending beyond the viewport. `src/styles.css` now sets `min-width: 0` on supply layout children and uses a zero-minimum mobile grid track. After rebuilding, the two-column supply list fits the viewport and the page-level horizontal scrollbar is gone.
- Routes visually inspected: overview, assembly, and supplies. The other pages are covered by server-render checks but have not been visually compared in the browser.
- Full comparison against mockups, dialog flows, CSV import wizard, keyboard-only traversal, and browser console remain pending. No claim of 1:1 fidelity is made.

- Employee profiles follow the two selected conversation mocks: assembler opens a right-side drawer; printer opens a full profile.
- Local preview smoke checks returned HTTP 200 for the app and both APIs. FBO returned 8 selected-period rows and 486 daily entries; printing returned 46 journal events, 624 supplies, and 0 source issues.
- Typecheck, worker/domain tests, production build, and whitespace validation pass.
- Visual comparison and interaction QA for the new profiles remain unavailable because this session has no configured browser tool or agent-browser executable.

final result: blocked