---
version: alpha
colors:
  primary: "#2563eb"
  navigation: "#ffffff"
  text: "#10213a"
  muted: "#50627a"
  border: "#e3eaf2"
  background: "#e7edf5"
  surface: "#ffffff"
  success: "#0b7350"
  success-bg: "#e8f7f0"
  warning: "#8a510c"
  warning-bg: "#fff5e5"
  danger: "#b53a42"
  danger-bg: "#fff0f0"
typography:
  body:
    fontFamily: '"Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif'
    fontSize: "14px"
    lineHeight: "1.5"
  heading:
    fontFamily: '"Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif'
    fontSize: "36px"
    lineHeight: "1.15"
rounded:
  control: "9px"
  panel: "15px"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
components:
  button:
    rounded: "control"
    typography: "body"
    backgroundColor: "primary"
    textColor: "surface"
---

# RITM

### Arkady notification cards (approved 2026-11-13)

Stock completion represents one entire uploaded list. Show one green completion card only when every member has both printing and cutting confirmed, even across roll/box. List the articles and quantities on separate lines under their department, then link only the participating stock tabs. Keep separate uploads on the same sheet independent. Preserve the existing supply notification policy.

Bitrix notifications use a complete PNG card generated inside the Worker, with the photographic bright-green olive branch, navy RITM wordmark, department totals and manager/praise. Blue means assignment, amber urgent/reminder, and a visible green check means combined print-and-cut completion. Supply creation and append stay distinct; stock cards name articles and quantities in pieces. The subject (especially «Запасы · Срочные 2 этаж») is a full-width contrasting panel, never a tiny badge. At 1000px export width, use Golos Text OFL glyph artwork: 50px headings, 36px bold subject/department/quantity, 32px body, 42px totals and 28px secondary notes. This type addition applies only to generated notification artwork, not application typography. The system font stack and every app screen remain unchanged.

`worker/cloud/arkadyCards.js` owns shared content and the native caption; `arkadyCardImage.js` owns image layout, glyph-mask compositing and PNG encoding. Versioned public render assets contain only licensed glyph masks and decoration. The production card itself never gets a public URL: a single `imbot.v2.File.upload` sends its bytes and clickable caption to the configured chat in one message. Normal captions are one short row of source links; the subject stays prominent in the image and is not repeated below. Keep the approved text sizes, tighten vertical gaps, and align department counts on the same row when they fit. Large stock uploads show at most six article rows in the image, retain exact full totals, explicitly point to the complete list in the same caption, and never emit per-article messages. Unsupported historical records keep their existing text. Preparation failure can fall back to native ATTACH before sending; ambiguous file delivery must never trigger another send. After a confirmed message ID, one best-effort `Chat.Message.update` with `urlPreview: N` removes the large Sheets link preview. Cosmetic failure does not reverse the sent receipt or cause another upload. Preserve the existing readiness, queue IDs and phrase cursors. Never imply packing or shipping from print/cut completion.

The supplies workspace defaults to the approved direction view (marketplace and city), with store tabs and source-job progress. Keep the light navigation, blue selection, green machine-cut, cyan manual-cut and purple packing accents. Opening a source job returns to its existing controls. Assembly uses compact product rows and explicit work, label, history and carton actions; detailed workers and records stay collapsed until requested. Carton quantity and the primary placement action remain visible in a bottom dock.

## Overview

### Roll sidebar (approved 2026-11-12)

`apps-script/stock-gateway/RollsV2Panel.html` owns the shared 320px Google Sheets roll workspace in both production and stock books. Use the approved first mock's white surface, navy heading, cobalt selection, pale blue plan/area pair, restrained green allocation feedback and separate piece progress for printing/cutting. Keep the article unbroken where space permits. A focused roll has one work form; multiple sheet rows automatically reveal the second mock's searchable, paginated bulk list and checkboxes. The primary save stays in a fixed bottom dock; the document is the only vertical scroller. History, corrections, old readiness controls and KPI audit remain under explicit disclosures. Use the documented system font stack and 12px minimum helper text, with 14px controls, 17px section titles and 23–24px primary data. Native selects and numeric inputs retain platform-owned behavior. No separate web app or decorative artwork is needed for this narrow operational sidebar.

Product/admin register. Audience: production manager coordinating WB/Ozon goods, assembly staff and printing sites. Approved visual direction (2026-10-20): a light RITM SaaS/ERP system with a white navigation rail, a slightly deeper slate-blue ambient page background, white operational surfaces, clear compact data tables, blue primary actions and restrained teal status accents. Operational numbers always lead to their source records. Preserve real data, routes and business behavior during visual changes.

Owner-confirmed design system direction (2026-10-26): retain the approved light RITM palette and atmospheric background. Borrow the restraint, information hierarchy, precise controls and keyboard feedback associated with Linear, Vercel and Raycast; do not imitate their dark themes or turn operational pages into marketing layouts. Keep Russian/Cyrillic-first system typography, source-backed figures, existing routes, icons, business rules and component anatomy. This system is a visual layer only.

Owner-approved addition (2026-11-07): visible green olive branches frame the shared RITM workspace across its sections, with a larger sprig at the upper right and a complementary accent at the bottom of the navigation where space permits. Shipment banners also retain visible leaves. Decoration must not block controls or obscure operational data; scale it down on narrow screens and omit it in print and forced-color modes.

Marketplace colors are scoped to the currently selected shipment only: Ozon uses a soft blue hero, Wildberries uses a purple hero. The global shell, other pages and shared components remain RITM-neutral. Unknown marketplace uses the neutral RITM theme. Do not add routes or marketplace screens that the application does not already support.

The owner reaffirmed the illustrated reference on 2026-10-20: a plain colored strip is insufficient. `src/ShipmentHero.tsx` and `src/shipmentHero.css` own the shared live/preview banner, with a readable heading and source link, marketplace tile, decorative 3D composition on the right, existing actions, and a separate white metrics strip below. Ozon artwork contains kraft parcels, label rolls and tickets; WB artwork contains berry parcels, a garment and shopping bag. Optimized decorative WebP assets live in `public/images/` (under 65 KB each). No KPI, label content or status is baked into the artwork; actual supply facts remain rendered text.

## Colors

Owner-approved on 2026-10-20 after the local 1920×1080 review: all existing RITM sections use `RitmBackdrop` via the shared `app--atmosphere` shell. The decorative component uses static CSS lighting plus inline SVG glass prisms, outside document flow and pointer/accessibility hit testing. `--ritm-backdrop-base: #D7E4F2`, `--ritm-backdrop-light: #E6EFF8`, `--ritm-backdrop-depth: #C0D5EB`, and `--ritm-backdrop-shadow: #B6CDE6` are owned by `src/styles.css`; SVG lighting remains local decorative material. Geometry is hidden at 950px and below, with a simple gradient retained. No animation or external asset is required. Existing panel geometry and marketplace hero artwork are preserved. Publication is authorized. The existing global `--page-background` remains the fallback for surfaces outside the shared RITM shell.

Canonical runtime owner is `src/styles.css`, with this document mirroring shared values. `colors.primary` maps to `--primary`; navigation to `--nav`; text to `--text`; background to `--bg`; all other color keys map to matching CSS variables. Shared primitives consume those variables. Primary `#2563EB`; navigation/surface `#FFFFFF`; text `#10213A`; muted text `#50627A`; background `#E7EDF5`; border `#E3EAF2`; teal accent `#12B8A6`. `--page-background` composes the base and restrained blue/teal glows; both the live application and design preview consume this same token. The owner requested this slightly darker canvas so white cards stand apart, while retaining a light theme. Secondary text was darkened with it for readable contrast (5.29:1 against the base). Green means a reached goal or completed work, amber means current below-goal output or missing information. Color never replaces a textual state.

## Typography

Use `"Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif`; this gives the installed Windows interface a clean variable face, keeps Cyrillic coverage, and does not fetch a remote font. Body is 14px/1.5, controls and table text 14px, compact labels/status chips 13px and headings 36px/23px/15px. Use tabular numerals for quantities, rates, dates and identifiers. Avoid tight letter spacing on data. Runtime tokens are `--font-body`, `--font-size-*`, root line-height and component-specific table scale.

## Design system tokens

Canonical token owner is `src/styles.css`. Keep semantic names and the existing compatibility tokens together so page CSS can adopt them without changing behavior. The core palette is primary blue `#2563EB`, ink `#10213A`, readable slate `#50627A`, white surfaces, canvas `#E7EDF5`, and restrained RITM teal `#12B8A6`. Success `#0B7350`, warning `#8A510C`, danger `#B53A42`; pair each status color with its pale semantic surface and a written label. Ozon blue and WB purple remain scoped to marketplace indicators.

Use the 4/8px rhythm (`--space-1` through `--space-8`), 6px compact chips, 9px controls, 15px panels and 16px dialogs. Keep borders crisp and shadows low contrast; elevation communicates layering, not decoration. Motion is 140–180ms, limited to color, shadow and small pressed feedback. `prefers-reduced-motion` remains authoritative. Focus is a visible 3px RITM-blue ring and cannot rely on color alone for status.

Shared controls live in `src/ui.tsx` and use the existing Radix Dialog / Lucide foundation. Extend those primitives and CSS tokens before creating parallel controls. Do not initialize shadcn or add a second component library to this Vite project; reuse its accessible composition patterns. No external font import, orange global CTA, glass blur, or `transition: all`.

## Layout

Sidebar 220px, content padding 32px, section gap 18px. Full left navigation remains visible on workstation monitors. On narrow screens, all navigation links stay available in a horizontally scrollable top navigation row. Content panels may stack and tables keep their own visible horizontal scrolling. No page-height constraints inherited from tables. Tables are paginated at 10/20/50 rows.

## Elevation & Depth

Operational surfaces use a fine border, 15px radius and a very soft shadow. Table contents stay on white/light surfaces for legibility. Avoid decorative treatments behind dense data. Hover and focus states must not shift table rows or change page geometry.

## Shapes

Control radius 9px maps to `--radius`; panel radius 15px maps to `--panel-radius`. Soft panel elevation maps to `--shadow-soft` and `--shadow-hover`. Initial avatars are text labels. The RITM wordmark is editable typography, not a simulated raster logo.

## Components

Canonical owners: `src/ui.tsx` for Button, Field, Search, DataTable, Modal, Notice, Progress; global styles for typography, tokens and scrollbar. Icons: Lucide stroke icons matching the reference outline family, selected after Phosphor was unavailable locally. Modal uses Radix Dialog. Native date/select popup geometry is intentionally platform-owned.

## Do's and Don'ts

Show demo/imported state on production screens. AI Center has its own authenticated local-agent state and never displays simulated incidents. Never claim a Google link is an established connection. Do not average printing/cutting/packing percentages. Missing work is not a zero unless a completed working shift is known. Warehouse rows are finished goods, grouped by article. Reserved goods are not packed goods. No hourly printing KPI without hours, no completion forecast without capacity data.

## AI Center

Use the existing shell, colors, typography and src/ui.tsx primitives. Reuse DataTable with a controlled server-pagination variant, Radix Modal for incident details and Field for owner login and filters. Agent states are real, unknown or explicitly not configured. No redesign of existing ERP sections.

## Assembly by destination and store (owner-approved, 2026-11-10)

The independent Assembly application keeps its light blue sidebar, native selectors, white article surfaces, blue actions and bright olive decoration. Its sidebar lists marketplace/city/catalog-store groups rather than machine-specific production jobs. Keep source job names available under a disclosure and on each article. The default tab is «В работе»; «Готовые» and «Все» retain access to completed records. Show a direct «Записать работу» action. The work dialog has employee, operation chips backed by the existing native operation select, quantity, remaining/after-save feedback and collapsed norm details. The carton drawer has a product selector across the current group, searchable shared cartons, composition, available quantity, an all-available shortcut, fill preview and a persistent submit footer. Retain excess-to-warehouse, labels, corrections and locked-source indicators. Main RITM directions are a separate design concept pending approval.

## Assembly warehouse surplus (2026-11-11)

The carton drawer separates «Короба направления» and the «На склад» ledger. Its explicit «Добавить готовый товар на склад» disclosure accepts independent finished-goods receipts, with an optional source-backed catalog card. Use one scrolling content region and a fixed placement footer; carton lists and expanded compositions have no nested vertical scrolling. Opening an open carton's composition selects it, and the same number appears in the selection check, border and footer. A warehouse placement requires the employee's declared name, using the existing employee directory. Preserve unknown historical authors explicitly and display timestamps in Europe/Moscow. RITM Warehouse exposes the same surplus in its own «На склад» view, separate from shipment dispatch totals and production reserve assignments.

Warehouse stock rows show product photos and names beside the article, quantity and original sender/time. Search filters the loaded snapshot locally by carton number, article or product name; a carton-number match shows its complete composition. Missing images use a stable placeholder and missing product details never hide physical stock.

## Production planning (approved 2026-11-12)

Keep Current Workload intact and add Forecast Deadlines within the same route. Match the approved light RITM forecast list, right detail drawer and weekly calendar. Reuse the same canonical UI, typography, olive decoration and marketplace colors. Readiness and shipping are separate Moscow timestamps; neither is auto-filled. Explain the bottleneck with source-backed work and queue, not employee blame. Use explicit states on time / at risk (under two elapsed hours of slack) / late / insufficient data / no deadline / confirmed done. Never invent an old completion timestamp. Configuration is an owner-only form with units, rate and weekly daily work window; allow pieces or area, and physical sheets only on Xerox printing. Settings start empty. The model currently excludes overnight windows, holiday exceptions and machine breakdowns. Present that limitation close to the settings and the forecast. List/calendar filters affect presentation only, never remove competing work from the scheduling calculation.

### Supply calendar (approved visual, 2026-11-14)

The supply calendar shows print, cutting and Assembly packing together. Use blue, green and violet; a saturated progress bar shows the confirmed aggregate fact in its own column, and pale bars show calculated future work. Do not draw historic bars on dates that are not supported by timestamps. Label the current-time line and both production and packing deadline markers; show the shipping date in the supply and its detail panel. Show calculated speed, bottleneck and slack only when supported, and keep incomplete queue segments marked as provisional with an actionable explanation. An absent deadline or quantity remains explicitly unknown. The existing machine calendar, filters and deadline editor stay available.
