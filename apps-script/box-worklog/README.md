# Учёт работы бокса

Bound Apps Script for the existing box workbook. This replaces the old bound script at the owner's request. Never run both edit handlers.

- Only visible shipment tabs beginning with `OZON ` or `WB ` and having recognized article/plan headers are eligible. Bare OZON/WB and technical sheets are excluded.
- Separate journal spreadsheet: Журнал (append-only), _Позиции (hidden historical baseline), Сотрудники (independent list). Configure with `setupBoxWorklog`; add real employee names to Сотрудники column A, one per row. B FALSE disables a name; empty or TRUE enables it. C receives a stable ID automatically.
- AE defect sheets, AF surplus sheets, AG good printed sheets, AH good cut sheets. Existing Y:AB, service IDs, formulas, work history remain intact.
- AI is the work-start timestamp. Existing print/cut date headers receive dates of the latest active event. Legacy checkbox columns are hidden; their values remain automatically derived for RITM readers.
- Use the source `Кол-во листов` as physical sheets per kit. Plan sheets = plan kits × sheets per kit; never infer an imposition divisor from `Кратность`.
- Sheet dimensions are snapshotted when available; unknown area stays blank.
- Every employee operation and cancellation requires an enabled employee. Cancellation is a new event referencing the original, with a reason. No journal rows are deleted.
- Script lock + immutable request ID protect repeated submissions. Journal append precedes projections; retry with the same ID repairs projection only. Existing checkmarks are baselines without an invented employee.
- Opening the sidebar follows the current selection. Ordinary direct checkbox/summary edits are restored from a local projection guard and do not create work events. This is accidental-edit protection, not a security boundary against spreadsheet owners/editors.
- Selection changes use one RPC. Unchanged polling reads only the selected source range and revision, without opening the external journal or taking a writer lock. Card reads never rewrite source totals, dates or formatting; baseline persistence and projection occur on saving.
- Previously visited cards are cached for 60 seconds using source ID, journal ID, selected row contents and the event revision. Work writes invalidate cached cards through a new revision; manual refresh bypasses the cache. Save validation always rereads live data.
- Newly generated/copied supplies are initialized lazily when first opened in the panel, while generator initialization clears inherited AE:AH results.

Google's native spreadsheet sidebar is approximately 300px wide. The design uses one column and readable controls at this actual width.
