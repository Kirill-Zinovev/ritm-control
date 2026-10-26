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
  success: "#007653"
  success-bg: "#e5f6ef"
  warning: "#9a6200"
  warning-bg: "#fff2d9"
  danger: "#ae3131"
typography:
  body:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "14px"
    lineHeight: "1.5"
  heading:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "34px"
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

## Overview

Product/admin register. Audience: production manager coordinating WB/Ozon goods, assembly staff and printing sites. Approved visual direction (2026-10-20): a light RITM SaaS/ERP system with a white navigation rail, a slightly deeper slate-blue ambient page background, white operational surfaces, clear compact data tables, blue primary actions and restrained teal status accents. Operational numbers always lead to their source records. Preserve real data, routes and business behavior during visual changes.

Marketplace colors are scoped to the currently selected shipment only: Ozon uses a soft blue hero, Wildberries uses a purple hero. The global shell, other pages and shared components remain RITM-neutral. Unknown marketplace uses the neutral RITM theme. Do not add routes or marketplace screens that the application does not already support.

The owner reaffirmed the illustrated reference on 2026-10-20: a plain colored strip is insufficient. `src/ShipmentHero.tsx` and `src/shipmentHero.css` own the shared live/preview banner, with a readable heading and source link, marketplace tile, decorative 3D composition on the right, existing actions, and a separate white metrics strip below. Ozon artwork contains kraft parcels, label rolls and tickets; WB artwork contains berry parcels, a garment and shopping bag. Optimized decorative WebP assets live in `public/images/` (under 65 KB each). No KPI, label content or status is baked into the artwork; actual supply facts remain rendered text.

## Colors

Owner-approved on 2026-10-20 after the local 1920×1080 review: all existing RITM sections use `RitmBackdrop` via the shared `app--atmosphere` shell. The decorative component uses static CSS lighting plus inline SVG glass prisms, outside document flow and pointer/accessibility hit testing. `--ritm-backdrop-base: #D7E4F2`, `--ritm-backdrop-light: #E6EFF8`, `--ritm-backdrop-depth: #C0D5EB`, and `--ritm-backdrop-shadow: #B6CDE6` are owned by `src/styles.css`; SVG lighting remains local decorative material. Geometry is hidden at 950px and below, with a simple gradient retained. No animation or external asset is required. Existing panel geometry and marketplace hero artwork are preserved. Publication is authorized. The existing global `--page-background` remains the fallback for surfaces outside the shared RITM shell.

Canonical runtime owner is `src/styles.css`, with this document mirroring shared values. `colors.primary` maps to `--primary`; navigation to `--nav`; text to `--text`; background to `--bg`; all other color keys map to matching CSS variables. Shared primitives consume those variables. Primary `#2563EB`; navigation/surface `#FFFFFF`; text `#10213A`; muted text `#50627A`; background `#E7EDF5`; border `#E3EAF2`; teal accent `#12B8A6`. `--page-background` composes the base and restrained blue/teal glows; both the live application and design preview consume this same token. The owner requested this slightly darker canvas so white cards stand apart, while retaining a light theme. Secondary text was darkened with it for readable contrast (5.29:1 against the base). Green means a reached goal or completed work, amber means current below-goal output or missing information. Color never replaces a textual state.

## Typography

Segoe UI includes Cyrillic and is installed on the user's Windows device. Arial is the cross-platform fallback. Numbers use tabular numerals. Headings 34px, section titles 21px, table content 13px. No font fetch is required. Body token maps to `--font-body`, root size and line-height.

## Layout

Sidebar 220px, content padding 32px, section gap 18px. Full left navigation remains visible on workstation monitors. On narrow screens, all navigation links stay available in a horizontally scrollable top navigation row. Content panels may stack and tables keep their own visible horizontal scrolling. No page-height constraints inherited from tables. Tables are paginated at 10/20/50 rows.

## Elevation & Depth

Operational surfaces use a fine border, 15px radius and a very soft shadow. Table contents stay on white/light surfaces for legibility. Avoid decorative treatments behind dense data.

## Shapes

Control radius 9px maps to `--radius`; panel radius 15px maps to `--panel-radius`. Soft panel elevation maps to `--shadow-soft` and `--shadow-hover`. Initial avatars are text labels. The RITM wordmark is editable typography, not a simulated raster logo.

## Components

Canonical owners: `src/ui.tsx` for Button, Field, Search, DataTable, Modal, Notice, Progress; global styles for typography, tokens and scrollbar. Icons: Lucide stroke icons matching the reference outline family, selected after Phosphor was unavailable locally. Modal uses Radix Dialog. Native date/select popup geometry is intentionally platform-owned.

## Do's and Don'ts

Show demo/imported state on production screens. AI Center has its own authenticated local-agent state and never displays simulated incidents. Never claim a Google link is an established connection. Do not average printing/cutting/packing percentages. Missing work is not a zero unless a completed working shift is known. Warehouse rows are finished goods, grouped by article. Reserved goods are not packed goods. No hourly printing KPI without hours, no completion forecast without capacity data.

## AI Center

Use the existing shell, colors, typography and src/ui.tsx primitives. Reuse DataTable with a controlled server-pagination variant, Radix Modal for incident details and Field for owner login and filters. Agent states are real, unknown or explicitly not configured. No redesign of existing ERP sections.
