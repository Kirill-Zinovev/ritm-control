import {
  dispatchHistoryPageSize, type DispatchHistoryDetail, type DispatchHistoryEntry, type DispatchHistoryPage,
} from "../shared/dispatch-history";
import type { Dispatch, ExportSnapshot } from "../shared/model";
import { ozonArticle, type OzonComposition, type OzonLabels } from "../shared/ozon-shipment";
import type { SqlStore } from "./database";

const archiveStates = "d.state in ('sent','canceled')";
const cartonIds = "coalesce(d.carton_ids,(select json_group_array(c.id) from av2_cartons c where c.dispatch_id=d.id))";
const dispatchColumns = "d.id,d.label,d.market,d.store,d.destination,d.state,d.created_at,d.sent_at,coalesce(d.qty,0) qty";
function historyExports(singleDispatch = false) {
  return `
    left join (
      select dispatch_id,
        max(case when kind='ozon-composition' then rowid end) composition_row,
        max(case when kind='ozon-labels' then rowid end) labels_row,
        max(case when kind in ('account','template') then rowid end) saved_row
      from av2_exports ${singleDispatch ? "where dispatch_id=?" : ""} group by dispatch_id
    ) latest on latest.dispatch_id=d.id
    left join av2_exports composition on d.market='OZON' and composition.rowid=latest.composition_row
    left join av2_exports labels on composition.id is not null and labels.rowid=latest.labels_row
    left join av2_exports saved on d.sent_payload is null and composition.id is null and saved.rowid=latest.saved_row
  `;
}

export async function readDispatchHistoryPage(store: SqlStore, page: number, query?: string): Promise<DispatchHistoryPage> {
  if (query) return searchDispatchHistory(store, page, query);
  const [rows, totals] = await store.readBatch([
    {
      sql: `select ${dispatchColumns},json_array_length(${cartonIds}) carton_count,
        (select json_group_array(label) from (
          select c.label from json_each(${cartonIds}) ids join av2_cartons c on c.id=ids.value
          order by cast(ids.key as integer) limit 3
        )) carton_labels
        from av2_dispatches d where ${archiveStates}
        order by coalesce(d.sent_at,d.created_at) desc,d.id desc limit ? offset ?`,
      args: [dispatchHistoryPageSize, page * dispatchHistoryPageSize],
    },
    { sql: "select count(*) total from av2_dispatches d where " + archiveStates, args: [] },
  ]);
  const entries = rows as (Omit<DispatchHistoryEntry, "cartonLabels"> & { cartonLabels: string })[];
  return {
    entries: entries.map((entry) => ({ ...entry, cartonLabels: JSON.parse(entry.cartonLabels) as string[] })),
    total: Number(totals[0].total),
  };
}

function literalSearchPattern(query: string) {
  // SQLite's built-in case-insensitive comparison covers ASCII only.
  return Array.from(query, (char) => {
    if ("[*?".includes(char)) return `[${char}]`;
    const lower = char.toLocaleLowerCase("ru-RU");
    const upper = char.toLocaleUpperCase("ru-RU");
    return lower === upper ? char : `[${lower}${upper}]`;
  }).join("");
}

async function searchDispatchHistory(store: SqlStore, page: number, query: string): Promise<DispatchHistoryPage> {
  const literal = literalSearchPattern(query);
  const ozonBase = ozonArticle(query).slice(0, -4);
  const suffix = /^[0-9]{1,24}$/u.test(query) ? "*" + query : null;
  const sku = "trim(json_extract(item.value,'$.sku'))";
  const order = "exact desc,(state='sent') desc,coalesce(sent_at,created_at) desc,id desc,carton_label,carton_id";
  type Match = Omit<DispatchHistoryEntry, "cartonLabels" | "matchedCarton"> & {
    cartonId: string;
    cartonLabel: string;
    exact: number;
    ozonCode: string | null;
    articleQty: number | null;
  };
  const rows = await store.all<(Match | { id: null }) & { total: number }>(`
    with input(value,literal,suffix,ozon_base,ozon_length) as (values(?,?,?,?,?)),
    archived as (
      select ${dispatchColumns},json_array_length(${cartonIds}) carton_count,
        coalesce(
          nullif(coalesce(json_extract(d.sent_payload,'$.cartons'),
            case when saved.id is not null and d.carton_ids is not null then (
              select json_group_array(json(box.value)) from json_each(saved.payload,'$.cartons') box
              where json_extract(box.value,'$.id') in (select value from json_each(d.carton_ids))
            ) else json_extract(saved.payload,'$.cartons') end,
            json_extract(composition.payload,'$.boxes')),'[]'),
          (select json_group_array(json_object('id',c.id,'label',c.label))
           from json_each(${cartonIds}) ids join av2_cartons c on c.id=ids.value)
        ) cartons,
        composition.payload ozon_composition,labels.payload ozon_labels
      from av2_dispatches d
      ${historyExports()}
      where ${archiveStates}
    ), ozon_codes as (
      select a.id dispatch_id,json_extract(a.ozon_composition,'$.boxes[' || code.key || '].id') carton_id,
        code.value ozon_code
      from input cross join archived a join json_each(a.ozon_labels,'$.codes') code
      where input.suffix is not null and code.value glob input.suffix and code.type='text'
        and length(code.value) between 12 and 24 and code.value not glob '*[^0-9]*'
        and json_array_length(a.ozon_labels,'$.codes')=json_array_length(a.ozon_composition,'$.boxes')
    ), cartons as (
      select ${dispatchColumns},d.carton_count,json_extract(box.value,'$.id') carton_id,
        json_extract(box.value,'$.label') carton_label,c.ozon_code,
        (select sum(json_extract(item.value,'$.qty'))
         from json_each(coalesce(json_extract(box.value,'$.items'),json_extract(box.value,'$.products'))) item
         where ${sku} glob input.literal
           or (d.market='OZON' and input.ozon_length>0
               and substr(${sku},1,input.ozon_length) glob input.ozon_base
               and trim(replace(upper(substr(${sku},input.ozon_length+1)),'(OZ)',''))='')
        ) article_qty
      from archived d cross join input join json_each(d.cartons) box
      left join ozon_codes c on c.dispatch_id=d.id and c.carton_id=json_extract(box.value,'$.id')
    ), matches as (
      select cartons.*,coalesce(ozon_code=input.value or trim(carton_label) glob input.literal,0) exact
      from cartons cross join input
      where ozon_code is not null or article_qty>0 or carton_label glob ('*' || input.literal || '*')
    )
    select results.*,totals.total from (select count(*) total from matches) totals
    left join (
      select * from matches order by ${order} limit ? offset ?
    ) results on true
    order by ${order}
  `, [query, literal, suffix, literalSearchPattern(ozonBase), Array.from(ozonBase).length,
    dispatchHistoryPageSize, page * dispatchHistoryPageSize]);
  return {
    total: Number(rows[0].total),
    entries: rows.flatMap((row) => {
      if (row.id === null) return [];
      const { total, cartonId, cartonLabel, exact, ozonCode, articleQty, ...entry } = row;
      return [{
        ...entry,
        cartonLabels: [cartonLabel],
        matchedCarton: {
          id: cartonId, label: cartonLabel, exact: Boolean(exact),
          ozonCode: ozonCode ?? undefined,
          articleQty: articleQty && articleQty > 0 ? articleQty : undefined,
        },
      }];
    }),
  };
}

type HistoryRow = Omit<Dispatch, "cartonIds"> & {
  cartonIds: string;
  cartonLabels: string;
  sentPayload: string | null;
  savedPayload: string | null;
  savedAt: string | null;
  ozonComposition: string | null;
  ozonLabelPayload: string | null;
  ozonLabelId: string | null;
};

export async function readDispatchHistoryDetail(store: SqlStore, id: string): Promise<DispatchHistoryDetail | null> {
  const [row] = await store.all<HistoryRow>(`
    select ${dispatchColumns},${cartonIds} carton_ids,d.sent_payload,
      (select json_group_object(c.id,c.label)
       from json_each(${cartonIds}) ids join av2_cartons c on c.id=ids.value) carton_labels,
      saved.payload saved_payload,saved.created_at saved_at,composition.payload ozon_composition,
      labels.id ozon_label_id,labels.payload ozon_label_payload
    from av2_dispatches d
    ${historyExports(true)}
    where d.id=? and ${archiveStates}
  `, [id, id]);
  if (!row) return null;

  const { cartonIds: ids, cartonLabels, sentPayload, savedPayload, savedAt,
    ozonComposition, ozonLabelPayload, ozonLabelId, ...fields } = row;
  const dispatch: Dispatch = { ...fields, cartonIds: JSON.parse(ids) as string[] };
  const payload = sentPayload ?? savedPayload;
  const data = payload ? JSON.parse(payload) as ExportSnapshot["payload"] : null;
  const reserved = new Set(dispatch.cartonIds);
  const archive: DispatchHistoryDetail["archive"] = data ? {
    kind: sentPayload ? "departure" : "export",
    createdAt: (sentPayload ? dispatch.sentAt : savedAt) ?? dispatch.createdAt,
    payload: !sentPayload && reserved.size
      ? { ...data, cartons: data.cartons.filter((box) => reserved.has(box.id)) }
      : data,
  } : null;
  const labels = ozonLabelPayload && ozonLabelId
    ? { ...JSON.parse(ozonLabelPayload) as OzonLabels, id: ozonLabelId }
    : null;
  const ozon = ozonComposition
    ? { ...JSON.parse(ozonComposition) as OzonComposition, dispatch, labels }
    : null;
  return { dispatch, archive, ozon, cartonLabels: JSON.parse(cartonLabels) };
}
