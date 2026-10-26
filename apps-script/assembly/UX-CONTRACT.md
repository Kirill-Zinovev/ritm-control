# RITM Assembly interaction contract

Locale ru-RU; dates Europe/Moscow. This existing Apps Script document is its own UI runtime; React/Radix primitives in the manager app cannot execute in its HTML service.

## Refresh and employee identity (19.10.2026)

The employee choice is stored in sessionStorage and in memory for the current tab. It survives a reload of that tab; changing the name in another tab never changes this tab's selection. It remains a convenience, not authentication.

Coworker updates use read-only getShipmentProgress without printing scans, product/label catalogs or reference norm loading. A changed composition/reference key requires a full snapshot. Version polling runs every 12–15 seconds with at most one request in flight. Background progress reads leave work controls enabled and defer responses while a work form is open. Each local mutation increments an epoch so a late read cannot roll back a save or resurrect a cancellation. Unavailable sources preserve the last successful data with an error banner.

The carton drawer has an explicit refresh action. Refresh invalidates a quote but preserves the entered quantity; uncertain writes must be reconciled first. A rejected placement exposes its original cause after checking the operation ID, and a new quote always restores the confirmation action label. Inline carton menus are positioned within the viewport and close on scroll/resize instead of being clipped by the list.

## Canonical UI Map

| Capability     | Canonical owner                    | Source of truth                   | Allowed variants                  | Verification            |
| -------------- | ---------------------------------- | --------------------------------- | --------------------------------- | ----------------------- |
| Select/Listbox | Native select in Index.html        | DESIGN.md                         | OS-owned popup                    | Local browser, keyboard |
| Form           | workForm, submitWork, sendWork     | Existing saveWork / getWorkStatus | One article-context modal         | Assembly contract tests |
| Scrollbar      | Global :root and universal rules   | DESIGN.md                         | Supply list, list-scroll, dialogs | Browser narrow widths   |
| Toast          | showToast and #toast               | This contract                     | Saved, error                      | Local browser           |
| CRUD           | Existing Google script RPC adapter | Code.gs                           | Append WorkLog/WorkLogCorrections/CartonContents; update carton occupancy in place | Assembly tests |

Supply selection/search/expansion are transient local state because the Web App is an Apps Script iframe; business identifiers are not exposed in URLs. Loading one supply is one getInitialData call. Counts in the sidebar reuse existing sync metadata, without additional Sheets reads. Search and opening details do not call the server. Images remain batched/lazy. Lists render 60 items at a time with explicit continuation and search across the entire snapshot.

Native dialog supplies focus trapping, inert background and Escape. Disclosure is a native button; focus moves to its replacement after a row update. Escape/backdrop never discards an uncertain write. Busy state disables form fields and submission. A 30-second missing response initiates getWorkStatus. Errors preserve the submitted payload; retry checks the same key first, and resends only the identical payload. Fields and closing stay locked until the uncertainty is resolved. Confirmed saves update one item. Choosing an employee remembers only an active employee ID as a convenience, not a security identity.

No data/unknown/zero are distinct. A missing operation route is not offered for cutting/assembly. Packing remains available without a known plan. Coefficients retain separate operation labels and frozen source norms. Histories never invent full event details from totals. Box writes are scoped to the selected supply, validate capacity and plan on the server, append one idempotent contents row, and update only the existing occupied/status cells; they never change WorkLog. Source failures retain the last snapshot with an error message. Errors are inline as well as a shared status toast.

Shift norm hints reuse FBO's cutting-sheet conversion and piece-based packaging/manual-work norms. Quantity entry remains in pieces. The form previews this entry's contribution without RPCs. For the selected employee, today's saved app contributions across supplies add to a shift total; the packaging guide is the selected type's full-shift norm times the unused fraction up to coefficient 1. It never limits saving or treats overtime as an error. This total is labelled as app work; external FBO records are not added. An unknown old coefficient makes the remaining shift unknown. Saved coefficients never change when type norms are edited, and mixed known/unknown item coefficients show `+ ?`. Display references may be cached for 60 seconds; the backend rereads norms on each save.

WorkLog remains append-only. An incorrect app-created event is cancelled by appending a `CANCEL` row to `WorkLogCorrections` with event ID, time, actor and required reason. Cancelled facts remain visible in item history but stop contributing to item progress, team totals and shift coefficients. Cancellation is idempotent; no WorkLog row is edited or deleted. The collector can re-enter the work under the correct employee or operation. Only `WEB_APP_RITM` and `WEB_APP_TEST` events expose this action; other-source facts are read-only.

The browser preview is local-only and uses synthetic records. No separate test/demo Web App is to be published. The local source is prepared for the existing main Apps Script once its project and backing spreadsheet IDs are verified. Before publishing, show the readiness report and obtain the owner's final approval. Never run production box or WorkLog writes as a test.
