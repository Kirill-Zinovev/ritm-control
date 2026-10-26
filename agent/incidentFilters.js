// Share document/sheet/type/priority/search semantics between counters and rows.
export function incidentBaseFilters({
  department = "",
  source = "",
  sheet = "",
  severity = "",
  kind = "",
  type = "",
  search = "",
  includeDemonstrations = true,
} = {}) {
  const clauses = [],
    params = [];
  for (const [name, value] of [
    ["department", department],
    ["sourceId", source],
    ["sheet", sheet],
    ["severity", severity],
    ["kind", kind],
    ["type", type],
  ]) {
    if (value) {
      clauses.push("json_extract(payload,'$." + name + "')=?");
      params.push(value);
    }
  }
  if (!includeDemonstrations)
    clauses.push("COALESCE(json_extract(payload,'$.demonstration'),0)=0");
  if (search) {
    clauses.push(
      "(instr(COALESCE(ritm_fold(json_extract(payload,'$.observed.productKey')),''),ritm_fold(?))>0 OR ritm_fold(COALESCE(json_extract(payload,'$.cell'),''))=ritm_fold(?) OR ritm_fold(COALESCE(json_extract(payload,'$.sourceCell'),''))=ritm_fold(?) OR instr(COALESCE(ritm_fold(json_extract(payload,'$.title')),''),ritm_fold(?))>0 OR instr(COALESCE(ritm_fold(json_extract(payload,'$.sourceName')),''),ritm_fold(?))>0 OR instr(COALESCE(ritm_fold(json_extract(payload,'$.sheet')),''),ritm_fold(?))>0)",
    );
    params.push(search, search, search, search, search, search);
  }
  return { clauses, params };
}
