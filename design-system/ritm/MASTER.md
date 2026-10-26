# RITM Design System

> Visual foundation for the existing RITM workstation ERP. The runtime source of truth is `src/styles.css`; `DESIGN.md` records approved product context. Page-specific styles may extend this system but must not redefine its global palette or typography.

## Product direction

Keep the established light RITM interface: white navigation, a calm blue-gray canvas with the approved atmospheric lighting, and white operational surfaces. Add the precision and restraint associated with Linear, Vercel and Raycast through clear hierarchy, consistent controls, quiet borders, readable typography and purposeful states. This is not a dark-theme or marketing-page redesign.

The application serves production managers and warehouse staff. Operational facts, article identifiers, statuses, filters and source links take priority over decoration. Preserve existing layout, Russian labels, business behavior, page routes and marketplace distinctions. Visual work must not alter calculations, API calls, records or access control.

## Color

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Primary action | `--primary` | `#2563EB` | Main actions, active navigation, links and focus |
| Primary hover | `--primary-hover` | `#1D4ED8` | Hover on primary action |
| Primary pressed | `--primary-pressed` | `#1E40AF` | Optional pressed state |
| Primary soft | `--primary-soft` | `#EDF4FF` | Selected rows and quiet blue surfaces |
| Main text | `--text` | `#10213A` | Titles, data and controls |
| Secondary text | `--muted` | `#50627A` | Supporting text; readable on white and canvas |
| Canvas | `--bg` | `#E7EDF5` | Fallback application background |
| White surfaces | `--surface`, `--surface-raised` | `#FFFFFF` | Panels, menus, dialogs and tables |
| Soft surface | `--surface-muted` | `#F3F7FB` | Table heads and quiet grouped content |
| Hover surface | `--surface-hover` | `#F6F9FD` | Neutral interactive hover |
| Border | `--border` | `#E3EAF2` | Default separators and control edges |
| Strong border | `--border-strong` | `#CBD8E7` | Emphasis when hierarchy needs an edge |
| RITM teal | `--ritm-teal` | `#12B8A6` | Wordmark accent and restrained identity detail |
| Success | `--success` | `#0B7350` | Completed or confirmed; pair with `--success-bg` |
| Warning | `--warning` | `#8A510C` | Delayed, incomplete or attention needed; pair with `--warning-bg` |
| Danger | `--danger` | `#B53A42` | Errors and destructive actions; pair with `--danger-bg` |
| Information | `--info` | `#315B8C` | Informational status on `--info-bg` |

The background glow is the approved RITM backdrop and remains subtle. Ozon blue and Wildberries purple apply only to marketplace markers or the selected supply hero. Never use marketplace colors as global action colors. Do not use color alone to communicate a status. Keep normal text contrast at or above 4.5:1 wherever possible; status pairings in the shared system exceed that target.

## Typography

Use `"Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif`. This keeps Cyrillic coverage and uses local system fonts without a network request.

| Token | Value | Role |
| --- | --- | --- |
| `--font-size-xs` | `13px` | Helper copy and compact status details |
| `--font-size-sm` | `14px` | Buttons, tables and secondary controls |
| `--font-size-body` | `14px` | Default body and form controls |
| `--font-size-lg` | `16px` | Emphasized body copy |
| `--font-size-section` | `23px` | Section headings |
| `--font-size-page` | `36px` | Page titles |

Use 1.5 body line height, firm but restrained heading weights, and tabular numerals for counts, quantities, coefficients and dates. Keep long article codes on one line only where the table scrolls horizontally; otherwise allow safe wrapping. Avoid all-caps labels, tight tracking in data, decorative display faces and per-page font overrides.

## Spacing, shape and elevation

Use the 4px rhythm: `--space-1: 4px`, `--space-2: 8px`, `--space-3: 12px`, `--space-4: 16px`, `--space-5: 20px`, `--space-6: 24px`, `--space-8: 32px`. Dense operational tables can use smaller cell padding but should stay comfortably scannable.

| Element | Token | Value |
| --- | --- | --- |
| Compact chip | `--radius-sm` | `6px` |
| Input and button | `--radius` | `9px` |
| Panel | `--panel-radius` | `15px` |
| Dialog | `--dialog-radius` | `16px` |

Use a fine border and low-contrast shadow to separate surfaces. Save `--shadow-hover` for genuinely clickable cards. Do not add blur, glass, floating gradients or movement behind dense operational data.

## Components and interaction

- Reuse `src/ui.tsx` primitives: Button, Field, Search, DataTable, Modal, Notice and Progress. The project uses Radix Dialog and Lucide icons; reuse its current accessible composition instead of adding another component library.
- Primary buttons use RITM blue and white text; secondary buttons use a white surface and fine border. Keep a minimum 40px control height for shared buttons.
- Inputs and search use a 9px radius, 14px body type, a clear border, and an unmistakable focus state. Shared buttons and tables use 14px text; compact status chips and helper labels use 13px.
- Panels use white surfaces, 15px radius, quiet border and soft elevation. Dense data remains on calm flat surfaces.
- Tables use tabular numbers, readable column labels, row separators, and their own horizontal scrolling when needed. Do not clip important values.
- Notices use semantic foreground/background pairs and concise text; success, warning and error must have distinct labels/icons.
- Focus uses a visible 3px RITM-blue outline. Preserve keyboard navigation and focus visibility in dialogs and scrolling regions.
- Motion is limited to 140–180ms color, border, shadow and small press feedback. Avoid layout shifts, `transition: all`, reveal animations and parallax. Honor `prefers-reduced-motion`.

## Responsive behavior

Preserve the established workstation layout and all existing navigation. At narrower widths, retain readable controls, stack summary cards where appropriate, and allow data tables to scroll inside their own region. Do not create page-wide horizontal scrolling. Check the real page at 1440px, 768px and 375px; preserve the workstation-first navigation requirement in `AGENTS.md`.

## Do not

- Do not change domain logic, calculations, API behavior, stored data, permissions or routes in a visual-system task.
- Do not replace the approved light RITM direction with a dark SaaS theme.
- Do not use orange as the global CTA, marketing hero patterns, an external font import, emoji icons, excessive gradients or glass blur.
- Do not introduce shadcn initialization, a new CSS framework or a second icon/component library into this existing Vite application.
- Do not call synthetic demo figures live production facts; preserve their demo/stale labels.

## Local review checklist

- [ ] `npm run typecheck` and `npm run build` pass.
- [ ] Inspect the local preview in @Browser at 1440px, 768px and 375px.
- [ ] Confirm no new horizontal page overflow, clipped controls or obscured focus.
- [ ] Check the AX tree and visible focus styling for shared controls.
- [ ] Verify reduced-motion behavior and status contrast.
- [ ] Confirm production integrations and business logic were not changed.
- [ ] Keep this work local unless publication is separately requested.
