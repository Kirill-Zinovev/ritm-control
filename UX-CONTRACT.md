# RITM behavior contract

Language ru-RU, domain timezone Europe/Moscow. Current sample date 2026-10-07. Visual contract: DESIGN.md.

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

This is a frontend prototype, not a shared production database. Demo data and user CSV data are disjoint. CSV snapshots, source URLs and real-data drafts are stored only in this browser; errors preserving storage must be reported. There is no Google OAuth, automatic sync, server history or external write. No credentials requested. Source links are configuration, not authentication.

## Navigation

Navigation uses semantic links and persists the active page in URL `page`. List selection/search are transient local review state; no business data in URL. Search has an immediate clear control. Tables have pagination and sort controls where useful. After creation return to supplies with the new supply selected. Cancelling a dirty card asks whether to discard through an app-owned dialog.

## Feedback and recovery

CSV validation is all-or-nothing: duplicate roll/operation IDs, invalid dates, missing fields and invalid quantities block replacement. Retry keeps file and mappings. Reimport replaces a source snapshot; it never adds the same rows twice. Summary FBO coefficients are not imported as additional work operations. Frozen per-operation norms are needed in the export. Imported monthly mean stays unknown without shift records.

## States

Missing/empty/no-results are different from numeric zero. A zero is confirmed by work records or known closed shifts. Current day's goal status is progress. Future days don't contribute. Reserve is limited to free stock, repeats are idempotent, and reserved stock does not increase packing progress. Source shipments and real operations require an explicit relation before joining; the prototype does not invent this join.

## Accessibility

Native buttons/links/fields, associated labels/errors, visible focus, textual status, reduced motion, semantic tables, accessible modal from Radix, Escape/focus trap/restoration. Sidebar uses a mobile toggle; visual and keyboard verification is pending because no browser is available in the current session.
