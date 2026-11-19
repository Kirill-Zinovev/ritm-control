# Xerox routing consistency

The owner confirmed that print extension `X` is reserved for Xerox in the box department. The catalog machine remains authoritative; contradictory inputs must be explicitly skipped rather than silently rewritten or routed into roll printing.

`shared/productionRouting.js` owns the shared check. Automatic supply creation/append and stocks call it through `routeSupplyLines`. Single and bulk department moves enforce the same invariant before preparing any write. A valid Xerox/box/X record retains its source quantity. Non-X extensions preserve existing routing. The preview displays the actual extension in either department, including the conflicting extension next to its explanation.

For CT0001.A7333, the owner separately approved correcting one catalog input on 13 November 2026: WB!M1482 from 2-GO to XEROX. OZON!O929 is a lookup of that WB column and was not overwritten. A local cell-level backup retains the old value and format. No existing production row, allocation, work log, shipment, stock quantity or history is moved by this correction. Previously displayed previews must be checked again; execution revalidates the current routing before writing.

OZON-only articles remain valid without corresponding WB rows. The verified catalog label `УФ белый` is accepted as the existing white-UV roll machine, alongside `УФ бел.`. KT0028.A7387 has two OZON rows with that same machine and one CPB extension; they do not create two production positions. WT0013.A0214 has the valid OZON 2-GO machine. Its two extension entries conflicted (CPB/CBI); the owner confirmed CBI and separately approved replacing only `расширения!B15` with CBI on 13 November. The second CBI entry, formatting and all production work remain intact. Different extensions continue to block routing instead of silently choosing the first one.

Regression coverage: `tests/production-xerox-routing.test.mjs`, existing supply, stock-planning and department-move suites. Live mutation is limited to those two explicitly approved catalog cells; all code-path mutation tests use synthetic storage/inputs.
