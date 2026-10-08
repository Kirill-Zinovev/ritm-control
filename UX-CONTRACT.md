# RITM behavior contract

Language ru-RU, domain timezone Europe/Moscow. Production dates use Europe/Moscow. Visual contract: DESIGN.md.

## Canonical UI Map

| Capability     | Canonical owner                         | Source of truth               | Allowed variants                   | Verification                             |
| -------------- | --------------------------------------- | ----------------------------- | ---------------------------------- | ---------------------------------------- |
| Select/Listbox | Native select in shared shell/Field     | This contract                 | native; OS-owned popup             | Type check; browser verification pending |
| Date           | Native input[type=date] in Field/header | This contract                 | native; OS-owned calendar          | Type check; browser verification pending |
| Form           | Field, shared validation functions      | src/model.ts, src/importer.ts | supply, source, import             | domain tests                             |
| Scrollbar      | Global src/styles.css                   | DESIGN.md                     | horizontal table overflow          | static check; browser pending            |
| Toast          | App toast-region                        | This contract                 | info, success                      | SSR; browser pending                     |
| CRUD           | App draft/import functions              | src/model.ts                  | create draft, replace CSV snapshot | domain tests                             |

## Data ownership

Production APIs read the approved Google Sheets sources. Demo and imported data remain disjoint. Local drafts and imported CSV snapshots belong to the browser. The independent Intelligence agent stores incidents, history and verified snapshots in SQLite outside the repository. Its API requires owner authentication; the owner key is masked and never stored in browser storage. Stage 2 supports service-account Google OAuth with spreadsheets.readonly; no production writes are implemented. Formula access requires local Google credentials and approved source rules. Source links alone are not authentication.

## Navigation

Navigation uses semantic links and persists the active page in URL `page`. List selection/search are transient local review state; no business data in URL. Search has an immediate clear control. Tables have pagination and sort controls where useful. After creation return to supplies with the new supply selected. Cancelling a dirty card asks whether to discard through an app-owned dialog.

## Feedback and recovery

CSV validation is all-or-nothing: duplicate roll/operation IDs, invalid dates, missing fields and invalid quantities block replacement. Retry keeps file and mappings. Reimport replaces a source snapshot; it never adds the same rows twice. Summary FBO coefficients are not imported as additional work operations. Frozen per-operation norms are needed in the export. Imported monthly mean stays unknown without shift records.

## States

Missing/empty/no-results are different from numeric zero. A zero is confirmed by work records or known closed shifts. Current day's goal status is progress. Future days don't contribute. Reserve is limited to free stock, repeats are idempotent, and reserved stock does not increase packing progress. Source shipments and real operations require an explicit relation before joining; the prototype does not invent this join.

## Accessibility

Native buttons/links/fields, associated labels/errors, visible focus, textual status, reduced motion, semantic tables, accessible modal from Radix, Escape/focus trap/restoration. Full left navigation remains visible on workstation monitors. Keyboard and browser verification results are recorded in verification.md.

## Intelligence states and permissions

AI Center uses real read-only monitoring results. Failed checks retain verified snapshots with an explicit stale notice; absent snapshots produce unavailable states, not zero KPIs. Partial source data cannot establish a productivity decline. A missing weekend entry is unknown work, not zero. Table Doctor checks authorized formulas when configured. Pending templates are review-only. Chat and production repairs remain unavailable. Demonstration fixtures are clearly labelled and explicitly enabled.

Incident filters are transient local state. DataTable uses controlled server pagination for incidents/history and local pagination elsewhere. Login uses an expiring HttpOnly SameSite=Strict cookie. Cross-origin private access and production modification endpoints are forbidden. Authenticated local incident requests/ignore and manual scans are allowed; only the explicitly enabled demo endpoint changes a local fixture. A closed incident means it was absent on a later successful check; it is not an agent repair. See docs/RITM-INTELLIGENCE-ARCHITECTURE.md and docs/TABLE-DOCTOR.md.
