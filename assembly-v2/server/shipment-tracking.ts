import { digest } from "../shared/catalog";
import { ozonArticle } from "../shared/ozon-shipment";
import { equal } from "./access";
import { json } from "./api";
import type { SqlStore } from "./database";
import { returnedCarton } from "./dispatch-history";

export const shipmentTrackingPath = "/api/ozon-shipment-tracking";

type Departure = { dispatchId: string; label: string; store: string; destination: string; sentAt: string };
type Match = Departure & { sourceKey: string | null; title: string };
type Line = Departure & { sourceKey: string; supply: string | null; article: string; sent: number };

const boxId = "json_extract(box.value,'$.id')";
const supply = "nullif(trim(json_extract(item.value,'$.supply')),'')";
const supplyId = "nullif(trim(json_extract(item.value,'$.supplyId')),'')";
const externalId = "nullif(trim(json_extract(item.value,'$.externalSupplyId')),'')";

// Every line comes from the immutable composition saved at the confirmed departure.
// The history's return command identifies cartons that did not actually leave.
const confirmedLines = (where: string) => `
  select d.id dispatch_id,d.label,d.store,d.destination,d.sent_at,
    ${supply} supply,${externalId} external_id,
    coalesce('id:'||${supplyId},'external:'||${externalId},'name:'||${supply},'') source_key,
    trim(json_extract(item.value,'$.sku')) article,json_extract(item.value,'$.qty') sent
  from av2_dispatches d
  join json_each(case when json_valid(d.sent_payload) then d.sent_payload end,'$.cartons') box
  join json_each(case when box.type='object' then box.value end,'$.items') item
  where d.market='OZON' and d.state='sent' and d.sent_at is not null and item.type='object'
    and length(${boxId})>0 and not ${returnedCarton(boxId)}
    and length(trim(json_extract(item.value,'$.sku')))>0
    and json_type(item.value,'$.qty')='integer' and json_extract(item.value,'$.qty')>0 ${where}
`;

async function lookupId(dispatchId: string, sourceKey: string | null): Promise<string> {
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(dispatchId)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return sourceKey === null ? "d" + encoded : "s" + encoded + "_" + (await digest(sourceKey)).slice(0, 32);
}

function readLookupId(value: string): { dispatchId: string; sourceHash: string | null } | null {
  const match = /^(?:d([A-Za-z0-9_-]+)|s([A-Za-z0-9_-]+)_([0-9a-f]{32}))$/.exec(value);
  if (!match || value.length > 160) return null;
  try {
    const base64 = (match[1] ?? match[2]).replace(/-/g, "+").replace(/_/g, "/");
    const dispatchId = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
    return dispatchId ? { dispatchId, sourceHash: match[3] ?? null } : null;
  } catch {
    return null;
  }
}

function metadata(row: Departure, id: string, title: string) {
  return { id, store: row.store, title, destination: row.destination, sent_at: row.sentAt };
}

// SQLite lower() folds Latin ASCII. Fold Russian letters explicitly, in two
// expressions to stay within the SQL parser's nesting limit.
function lowerRussian(expression: string, letters: string): string {
  for (const letter of letters)
    expression = `replace(${expression},'${letter}','${letter.toLowerCase()}')`;
  return expression;
}

async function search(store: Pick<SqlStore, "all">, query: string) {
  const rows = await store.all<Match>(`
    with query(needle,external_id) as (values(?,?)),
    confirmed as (${confirmedLines("")}),
    names as (
      select distinct dispatch_id,label,store,destination,sent_at,source_key,supply candidate,external_id
      from confirmed
      union all
      select dispatch_id,label,store,destination,sent_at,null,label,null
      from confirmed group by dispatch_id
    ),
    partially_folded as (
      select *,${lowerRussian("lower(candidate)", "АБВГДЕЁЖЗИЙКЛМНОП")} folded_prefix
      from names
    ),
    folded as (
      select *,${lowerRussian("folded_prefix", "РСТУФХЦЧШЩЪЫЬЭЮЯ")} normalized_name
      from partially_folded
    ),
    matching as (
      select folded.*,
        case when normalized_name=query.needle or folded.external_id=query.external_id then 1 else 0 end exact
      from folded cross join query
      where instr(normalized_name,query.needle)>0 or folded.external_id=query.external_id
    ),
    matched_supplies as (
      select dispatch_id,label,store,destination,sent_at,source_key,coalesce(min(candidate),label) title,max(exact) exact
      from matching
      where source_key is not null
      group by dispatch_id,source_key
    )
    select * from matched_supplies
    union all
    select dispatch_id,label,store,destination,sent_at,source_key,label title,exact
    from matching
    where source_key is null
      and not exists (select 1 from matched_supplies where matched_supplies.dispatch_id=matching.dispatch_id)
    order by exact desc,sent_at desc,dispatch_id,source_key limit 100
  `, [query.toLowerCase(), query]);
  const results = await Promise.all(rows.map(async row => metadata(row, await lookupId(row.dispatchId, row.sourceKey), row.title)));
  return results.filter(row => row.id.length <= 160);
}

async function detail(
  store: Pick<SqlStore, "all">,
  lookup: { dispatchId: string; sourceHash: string | null },
  requestId: string,
) {
  const lines = await store.all<Line>(confirmedLines("and d.id=?"), [lookup.dispatchId]);
  let selected = lines;
  if (lookup.sourceHash !== null) {
    const keys = [...new Set(lines.map(line => line.sourceKey))];
    const ids = await Promise.all(keys.map(key => digest(key)));
    const key = keys[ids.findIndex(hash => hash.slice(0, 32) === lookup.sourceHash)];
    selected = lines.filter(line => line.sourceKey === key);
  }
  const first = selected[0];
  if (!first) return null;
  const articles = new Map<string, number>();
  for (const line of selected) {
    const article = ozonArticle(line.article).toUpperCase();
    const sent = (articles.get(article) ?? 0) + line.sent;
    if (!Number.isSafeInteger(sent)) throw new Error("Invalid departure quantity");
    articles.set(article, sent);
  }
  const title = lookup.sourceHash === null
    ? first.label
    : selected.flatMap(line => line.supply ? [line.supply] : []).sort()[0] ?? first.label;
  return {
    ...metadata(first, requestId, title),
    items: [...articles].sort(([a], [b]) => a.localeCompare(b)).map(([article, sent]) => ({ article, sent })),
  };
}

function reply(body: unknown, status = 200) {
  const response = json(body, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function shipmentTrackingApi(
  request: Request,
  tokenHash: string | undefined,
  store?: Pick<SqlStore, "all">,
) {
  if (request.method !== "GET") return reply({ error: "Недопустимый метод запроса." }, 405);
  const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token || !tokenHash || !/^[0-9a-f]{64}$/.test(tokenHash) || !equal(await digest(token), tokenHash))
    return reply({ error: "Служебный доступ не подтверждён." }, 401);
  if (!store) return reply({ error: "История выездов временно недоступна." }, 503);

  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim();
  const id = params.get("id");
  if ([...params].length !== 1 || (id === null && (!query || query.length > 160)))
    return reply({ error: "Укажите название или номер поставки." }, 400);
  try {
    if (id !== null) {
      const lookup = readLookupId(id);
      if (!lookup) return reply({ error: "Проверьте номер выезда." }, 400);
      const shipment = await detail(store, lookup, id);
      return shipment ? reply({ shipment }) : reply({ error: "Выезд не найден." }, 404);
    }
    return reply({ shipments: await search(store, query!) });
  } catch {
    return reply({ error: "Не удалось прочитать историю выездов." }, 503);
  }
}
