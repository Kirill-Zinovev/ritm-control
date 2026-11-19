# Manager panel redesign — 17 November 2026

Approved references: five PNG mockups in the generated_images folder for conversation 01a1d378-a5d0-7dc2-9ce2-95b6e364e5d8, respectively exec-972f56bc (catalog), exec-ab18af62 (cartons), exec-2a3f8e78 (work), exec-51ab1104 (warehouse), exec-8f2de455 (setup).

Implemented in the existing app; no new production seed data. Manager-only stylesheet is scoped to .manager-app. Collector source, its CSS and work/warehouse dialogs are unchanged. CartonDetails defaults to its existing modal; the owner list explicitly opts into inline details.

Visual review at 1488x1058 compared all five references with local screenshots. White/blue shell, horizontal navigation, compact filters, selectable carton table and adjacent detail, inline catalog editor with persistent save footer, employee work journal and expandable calculation, city stock exports and selection footer match the approved structure. Actual source data and supported file formats replace illustrative mockup data. Connection state is evidence-based; an unconfigured service is amber, not a false green confirmation.

Fixed during QA: mobile page overflow from absolutely positioned sr-only labels; product-image grid overlap; save footer disappearing below long catalog forms; stale editor fetch after card switching; dirty-form protection when opening another editor; coefficient emphasis applied to the correct column. A carton label action prints internal carton identification, explicitly distinguished from a marketplace shipping label.

Desktop and 390x844 browser passes: all five routes render; no page exceptions or horizontal document overflow. Tables can scroll within their own container. Catalog forms retain every existing production, image, label and history field. Added separate manager login and owner password settings after the owner's follow-up approval.

Interaction checks on isolated SQLite only: edit/save/reopen/restore catalog; unsaved-change protection; saved history and norms; selected-carton Excel reopened with ExcelJS (Короба, Состав, Сводка, Параметры выгрузки), stock unchanged after download; city filter; carton label popup; close-review cancel; actual work cancellation. Local manager password creation, input clearing, invalid login, desktop/mobile login layout checked.

Runtime checks: TypeScript and production build; 124 tests, including manager hash/cookie/revocation/rate-limit and direct Worker authorization; local Cloudflare D1 emulation of snapshots, history media and cross-source allocation. No test production mutations.

Legacy baseline note: npm run verify:legacy references a November 9 checkout and reports its historical Code.gs hash already differs. This task did not edit that file. Current live Apps Script HEAD equals deployed version 114 for Code.js, Index.html and WarehouseManual.js, backed up separately. Retirement is separately authorized: only the worker UI and 10 worker write entrypoints change, while signed doPost, synchronization and spreadsheet contents remain intact.

Evidence screenshots and browser action scripts are local operational artifacts under the user's Temp folder. Live deployment checks are recorded separately; local checks are not proof of production publication.

Production follow-up: catalog, work and setup use a three-query directory snapshot instead of loading every carton and allocation. Manager polling is 30 seconds; collector polling remains 5 seconds. 125 isolated tests and typecheck passed; five desktop/mobile tabs passed browser checks. Live D1 overload observed during the initial release is being checked again after this reduction.

Root cause identified in read queries: LEFT JOIN of the resolved UNION catalog materialized all imported entries. Exact indexed position lookup preserves managed/reference precedence and photo/kind overrides. Large local catalog (7,859 source rows): snapshot 770ms -> 5ms, history 460ms -> 3ms. This is a local benchmark, not a production latency guarantee. 127 isolated tests pass, including lookup equivalence and full warehouse export past 30 receipt rows.
Warehouse reserve tab reuses existing warehouse actions, filters open/closed boxes and exports selected complete compositions atomically without modifying stock or work. Desktop/mobile browser verification passed. Collector default rendering is unchanged.

Follow-up: reserve export now supports all cartons (or current filters) and explicit multi-selection across pages. Select-page and clear-selection controls added. Direction carton export also supports all filtered cartons and mixed-scope selections; preparing a dispatch still requires compatible scope. Local browser downloaded and reopened both all-carton and two-selected-carton Excel files successfully. Original legacy UI deployed as retired version 115; archived data readback verified, all 90 sheets unchanged.
