---
version: alpha
colors:
  primary: "#2663eb"
  background: "#f3f6fb"
  surface: "#ffffff"
  text: "#172e49"
  muted: "#60718a"
  control-border: "#7f8fa3"
  border: "#dce5f0"
  success: "#197354"
  danger: "#af3646"
typography:
  manager:
    fontFamily: "Inter, Segoe UI, sans-serif"
    fontSize: "14px"
    lineHeight: "1.45"
  body:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "14px"
    lineHeight: "1.45"
  data:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "17px"
    lineHeight: "1.45"
rounded:
  control: "9px"
  panel: "12px"
spacing:
  base: "8px"
  panel: "16px"
components:
  button:
    rounded: "9px"
---

## Overview

Product register: warehouse work, Russian locale, Moscow business time. Current explicit user decision (2026-11-13): preserve the EXISTING Assembly design and workflow, replace only its data/backend layer, and place supplies on the LEFT (latest correction). The previously proposed permanent work editor was rejected. The primary reference is the final compact workspace in `apps-script/assembly-live/Index.html`, not the earlier concept images. `docs/legacy-design-source.json` records its hash; `docs/legacy-reference-desktop.jpg` shows a local, test-data rendering of the unmodified source. This task never writes or deploys the legacy app.

## Colors

The collector uses the original white surfaces, cool #f5f7fb canvas, #172f46 text, #2775e8 actions and separate green/blue/purple operation bars. Original gradients, shadows and the embedded leaf illustration are copied, because the user explicitly requested this existing design. `src/legacy.css` is a scoped copy of the original source; `src/legacy-adapter.css` owns only the left-side placement and adaptation to shared React primitives. Manager screens continue to consume the `src/styles.css` tokens listed above. No remote fonts or invented product imagery.

## Typography

Collector: Segoe UI, Arial, sans-serif, exactly as the original source. Body 13px, original compact labels and progress values, 15–16px product codes, 25–32px headings. Manager screens retain Inter, Segoe UI, sans-serif at 14px. Tabular numerals and Cyrillic throughout. Arial is the intentional legacy fallback, not a new font choice.

## Layout

Full-width old workspace: compact article rows with three distinct operation columns and one primary action, expandable details/history, standalone work modal, right-side carton drawer with a fixed quantity/save footer. Supply sidebar on the LEFT, 270px (235px below 1500px); below 760px supplies occupy the original horizontal mobile strip. Collector loads 60 positions, then explicit “Показать ещё”; warehouse paginates at 30. Forms use the existing 46px controls. Extra owner review screens stay under the sidebar's “Управление”. The previous top navigation and permanent right-hand work form are absent from the collector.

## Elevation & Depth

Keep the original subtle borders, selected-row blue outlines, panel shadows and gradients. Native dialogs own overlays, focus trap and return focus. Visible keyboard focus is retained.

## Shapes

9px controls, 12px panels, 7px status indicators. Global visible scrollbar tokens.

## Components

Stock forms reveal the optional second operation through a compact “+ Добавить операцию” button. Its operation, employee and separate quantity share a three-column grid inside a subtle canvas panel; narrow screens stack the fields. The remove action belongs in that panel's header. No checkbox receives the form-wide text-input width rule.

The collector's carton drawer retains the original two tabs: «Короба направления» and «На склад». Warehouse receipts reuse the legacy manual-warehouse grid, photo/name/quantity rows and current-carton heading. The warehouse tab owns the full drawer scroller and has no placement footer. Its forms, selectors and feedback use shared ui.tsx and DraftGuard. No new visual tokens are introduced.

`CartonProduct` is the shared content row for carton previews and details: a fixed 48×56 thumbnail from ProductPhoto, clear article, two-line product name, muted supply and a compact blue quantity badge. It uses the existing blue/white legacy palette and retains the current drawer and table geometry.

Collector carton details keep the same padded modal surface as the original Assembly. Drawer header/body rules target their direct children so an inner details dialog cannot lose its spacing. Quantity inputs use the shared `.field` skin. Operational carton contents show article, product, supply and quantity; canonical source IDs remain in audit/export data.

`src/ui.tsx` owns Button, Field, NativeSelect, Dialog (including work and carton drawer variants), Search, Empty, Pagination and Status. `useWorkspace` owns requests, refresh and notifications. `shared/assembly.ts` preserves old completed-product and progress semantics. Scoped legacy tokens cannot affect manager screens. Runtime legacy values come from the single copied stylesheet; adapter rules consume them. See UX-CONTRACT.md for behavior.

Catalog management reuses the manager shell and controls, with a native table (30 rows), small fixed product photographs and a read-only source/detail dialog. `ProductPhoto` owns lazy image loading and the fixed-size failure placeholder in both catalog and collector. `product-photo.css` owns shared image geometry; legacy `.photo` retains collector dimensions. The catalog uses the existing canvas/surface/blue/green/muted/border tokens; no new theme or collector navigation layout is introduced. Photo and import parsing failures never block recording work.

## Do's and Don'ts

Product labels reuse the old expanded-row «Этикетка» action and «В печать» checkbox. `LabelDialog` uses the shared Dialog/Field/Button and original `.label-modal` preview/copies/batch styles. `label-print.ts` owns the single-page-per-copy print view; only the original image is printed, after successful decoding. No production operation is performed by printing. Market and the exact normalized article select an immutable original from the new storage; conflicting originals remain visibly blocked.

Keep names and quantities visible. Do not confuse work with allocating stock, closing cartons with sending, or downloading an export with physical shipment. The separate test environment is explicitly labelled. Never present test fixtures as production records.

## Accessibility refinement

Intentional deviation from the prototype: muted text uses #60718a (4.59:1 on the canvas, 4.97:1 on white); control borders use #7f8fa3 (3.05:1 on the canvas, 3.30:1 on white). Placeholder opacity is 1. Card borders remain light. The selected navigation item has a blue inset indicator. All tokens are owned by src/styles.css and mirrored here.

