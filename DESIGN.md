---
version: alpha
colors:
  primary: "#008260"
  navigation: "#142638"
  text: "#14253b"
  muted: "#6b7c91"
  border: "#e1e7ed"
  background: "#f8fafb"
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
  control: "6px"
  panel: "8px"
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

Product/admin register. Audience: production manager coordinating WB/Ozon goods, assembly staff and printing sites. Visual targets are the four most recent detailed generated mockups in this conversation: overview, assembly, printing, supplies. Keep their navy sidebar and light working surface. Signature: operational numbers always lead to their source records. Initial release reads data; task dispatch is a later phase.

## Colors

Canonical runtime owner is `src/styles.css`, with this document mirroring shared values. `colors.primary` maps to `--primary`; navigation to `--nav`; text to `--text`; background to `--bg`; all other color keys map to matching CSS variables. Shared primitives consume those variables. Green means a reached goal or completed work, amber means current below-goal output or missing information. Color never replaces a textual state.

## Typography

Segoe UI includes Cyrillic and is installed on the user's Windows device. Arial is the cross-platform fallback. Numbers use tabular numerals. Headings 34px, section titles 21px, table content 13px. No font fetch is required. Body token maps to `--font-body`, root size and line-height.

## Layout

Sidebar 220px, content padding 32px, section gap 18px. RITM is a workstation application: full left navigation remains visible on monitors. Content panels may stack and tables keep their own visible horizontal scrolling. No page-height constraints inherited from tables. Tables are paginated at 10/20/50 rows.

## Elevation & Depth

Content panels are flat with fine borders. Shadows are reserved for modals and notifications.

## Shapes

Control radius 6px maps to `--radius`; panel radius 8px. Initial avatars are text labels. The RITM wordmark is editable typography, not a simulated raster logo.

## Components

Canonical owners: `src/ui.tsx` for Button, Field, Search, DataTable, Modal, Notice, Progress; global styles for typography, tokens and scrollbar. Icons: Lucide stroke icons matching the reference outline family, selected after Phosphor was unavailable locally. Modal uses Radix Dialog. Native date/select popup geometry is intentionally platform-owned.

## Do's and Don'ts

Show demo/imported state on production screens. AI Center has its own authenticated local-agent state and never displays simulated incidents. Never claim a Google link is an established connection. Do not average printing/cutting/packing percentages. Missing work is not a zero unless a completed working shift is known. Warehouse rows are finished goods, grouped by article. Reserved goods are not packed goods. No hourly printing KPI without hours, no completion forecast without capacity data.

## AI Center

Use the existing shell, colors, typography and src/ui.tsx primitives. Reuse DataTable with a controlled server-pagination variant, Radix Modal for incident details and Field for owner login and filters. Agent states are real, unknown or explicitly not configured. No redesign of existing ERP sections.
