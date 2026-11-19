// Stable link to the original receipt keeps one work record when stock is split.
export const receiptRoot = (alias = "r") => `coalesce((select json_extract(q."after",'$.rootReceiptId') from av2_quality_repairs q where q.kind='warehouse.split.receipt' and q.entity_id=${alias}.id),${alias}.id)`;
export const warehouseWorkQty = (work = "w", receipt = "r") => `coalesce((select json_extract(q."after",'$.qty') from av2_quality_repairs q where q.kind='warehouse.split.work' and q.entity_id=${work}.id),${receipt}.qty)`;
