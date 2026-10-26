# Machine workload

`/?page=machines` reuses the printing snapshot and canonical shipment grouping. The new view adds no write endpoint, database schema, queue or independent shipment registry. The source loader exposes machine/photo/name fields and enriches missing values from the matching OZON or WB catalog in the existing batched read.

## Assignment and facts

- Roll: 2-GO, УФ, УФ белый (including punctuation variants), УФ двусторонний.
- Box: УФ-планшет, DTF, XEROX.
- Catalog equipment determines the workload display lane. A differing source lane is explicitly flagged; source jobs and source-specific print/cut calculations are never moved. Unknown and conflicting equipment remains unassigned.
- The matching marketplace catalog `Станок` takes priority over supply process labels. OZON reads only OZON; WB reads only WB. A missing/unavailable catalog preserves a precise source assignment, and conflicts remain unassigned. Product names and HTTPS photos are optional; embedded Sheets images that are absent from the values response cannot be manufactured as URLs.
- Printing totals use existing T/X and box R rules; cutting uses U / box S independently. No packaging quantity enters machine printing totals. Partial facts stay partial; over-plan quantities remain visible.
- The display reports remaining work, not machine power/running status or an ETA.

## Lifecycle

Create/append/delete continue through the existing confirmed supply workflow and refresh the shared snapshot. The screen derives its assignments from that snapshot on every update; it cannot retain separate orphan tasks. If the selected shipment disappears in a confirmed snapshot, the shipment filter resets. An unavailable read preserves previous facts and displays a warning, never simulates deletion. Existing deletion remains the department-aware source operation; deleting the final part removes the overall supply from active Assembly through the existing bridge. No historical WorkLog/KPI/carton events are deleted by this feature.

Refresh is the existing manual action or five-minute visible-tab polling. This is not a live machine telemetry stream. Other browser sessions see changes on their next source refresh.

## Local verification

`/machine-workload-preview.html` is an isolated Vite-only entry rendering the real component with synthetic data. Add `?scenarios=1` for local create/remove/unknown-machine/read-error scenarios. It imports no cloud authentication client or source reader and issues no production API request. The demo fixture is excluded from the production entry and build.

Domain tests cover canonical identity, assignments, unknowns, partial facts, quantities above plan and create/delete snapshots. Source tests cover header-based machine extraction, unchanged box readiness, marketplace scope, conflicts and safe photo URLs. The catalog reader retains strict workbook/range validation and uses one batch read of two ranges (WB A:T and OZON A:P).

