import { digest } from "../shared/catalog";
import type { Carton, Dispatch } from "../shared/model";
import {
  isOzonCargoCode, ozonArticle, ozonBoxLimit, ozonCartonKey, ozonGroupBoxLimit,
  parseOzonCartonNumbers, summarizeOzonProducts,
  type OzonBatch, type OzonBatchSummary, type OzonBox, type OzonComposition,
  type OzonLabels, type OzonPreview, type OzonPreviewGroup,
} from "../shared/ozon-shipment";
import { warehouseCity } from "../shared/warehouse-filter";
import type { SqlStore, Statement } from "./database";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

function shipmentScope(box: Carton) {
  const area = warehouseCity(box);
  const city = area.key.startsWith("destination:")
    ? box.destination.replace(/^\s*ozon\s+/iu, "")
        .replace(/(?:\s*[(,·-]?\s*)(?:\d+\s*(?:-?\s*й\s*)?магазин|магазин\s*\d+)\s*\)?/giu, " ")
        .replace(/\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/gu, " ")
        .replace(/\s+/gu, " ").trim()
    : area.label;
  const cluster = area.key === "MOSCOW" ? "Москва, МО и Дальние регионы"
    : area.key === "SPB" ? "Санкт-Петербург и СЗО" : city;
  return { key: JSON.stringify([box.store, ozonCartonKey(city)]), store: box.store, city, cluster };
}

function cartonIssue(box: Carton) {
  if (box.market !== "OZON") return "Короб другого маркетплейса";
  if (box.dispatchState === "sent") return "Короб уже отправлен";
  if (box.dispatchId) return "Короб в подготовленной отгрузке";
  if (!/^[1-9]\d*$/u.test(box.store)) return "Магазин не подтверждён";
  if (!shipmentScope(box).city) return "Направление не указано";
  if (box.qty < 1) return "Короб пуст";
  if (box.items.some((item) => !item.sku.trim() || !Number.isSafeInteger(item.qty) || item.qty < 1))
    return "Проверьте артикулы и количество";
  return "";
}

function freezeBox(box: Carton): OzonBox {
  return {
    id: box.id, label: box.label, qty: box.qty,
    products: summarizeOzonProducts([{
      id: box.id, label: box.label, qty: box.qty,
      products: box.items.map((item) => ({ sku: item.sku.trim(), name: item.name, qty: item.qty })),
    }]),
  };
}

function proof(box: Carton) {
  const items = box.items.map(({ id, sku, qty }) => [id, sku, qty]);
  return digest(JSON.stringify([box.state, box.label, box.market, box.store, box.destination, items]));
}

function contents(boxes: OzonBox[]) {
  return JSON.stringify(boxes.map((box) => [
    box.id, box.label, summarizeOzonProducts([box], ozonArticle).map(({ sku, qty }) => [sku, qty]),
  ]));
}

const compositionKind = "ozon-composition";
const labelsKind = "ozon-labels";
const latestComposition = "e.rowid in (select max(rowid) from av2_exports where kind='ozon-composition' group by dispatch_id)";

export function ozonShipments(store: SqlStore, loadCartons: (ids: string[]) => Promise<Carton[]>) {
  async function preview(input: string): Promise<OzonPreview> {
    const numbers = parseOzonCartonNumbers(input);
    const wanted = new Set(numbers);
    const matches = new Map<string, string[]>();
    const rows = await store.all<{ id: string; label: string; dispatchState: string | null }>(
      "select c.id,c.label,d.state dispatch_state from av2_production_cartons c left join av2_dispatches d on d.id=c.dispatch_id",
    );
    const sent = new Set<string>();
    for (const row of rows) {
      const key = ozonCartonKey(row.label);
      if (!wanted.has(key)) continue;
      if (row.dispatchState === "sent") sent.add(key);
      else {
        const ids = matches.get(key) ?? [];
        ids.push(row.id);
        matches.set(key, ids);
      }
    }
    const ids = [...matches.values()].filter((group) => group.length === 1).map(([id]) => id);
    const cartons = new Map((await loadCartons(ids)).map((box) => [box.id, box]));
    const groups = new Map<string, OzonPreviewGroup>();
    const issues: OzonPreview["issues"] = [];
    for (const label of numbers) {
      const matched = matches.get(label);
      const box = matched?.length === 1 ? cartons.get(matched[0]) : undefined;
      const reason = box ? cartonIssue(box) : matched && matched.length > 1
        ? "Найдено несколько коробов с этим номером"
        : sent.has(label) ? "Короб уже отправлен" : "Короб не найден";
      if (!box || reason) {
        issues.push({ label, reason });
        continue;
      }
      const scope = shipmentScope(box);
      const group = groups.get(scope.key) ?? { ...scope, boxes: [] };
      group.boxes.push({ id: box.id, label: box.label, qty: box.qty, state: box.state, proof: await proof(box) });
      groups.set(scope.key, group);
    }
    return { groups: [...groups.values()], issues };
  }

  function list() {
    return store.all<OzonBatchSummary>(`
      select json_extract(e.payload,'$.batchId') id,min(d.created_at) created_at,count(*) group_count,
        sum(json_array_length(e.payload,'$.boxes')) box_count,
        sum(case when exists(select 1 from av2_exports l where l.dispatch_id=e.dispatch_id and l.kind='ozon-labels')
          then json_array_length(e.payload,'$.boxes') else 0 end) label_count
      from av2_exports e join av2_dispatches d on d.id=e.dispatch_id
      where ${latestComposition}
      group by json_extract(e.payload,'$.batchId') order by created_at desc,id desc`);
  }

  async function batch(batchId: string): Promise<OzonBatch | null> {
    const rows = await store.all<{
      dispatchId: string; label: string; state: Dispatch["state"]; store: string; createdAt: string;
      sentAt: string | null; qty: number; composition: string; labelId: string | null; labelPayload: string | null;
    }>(`
      select d.id dispatch_id,d.label,d.state,d.store,d.created_at,d.sent_at,d.qty,
        e.payload composition,l.id label_id,l.payload label_payload
      from av2_exports e join av2_dispatches d on d.id=e.dispatch_id
      left join av2_exports l on l.id=(select x.id from av2_exports x where x.dispatch_id=d.id
        and x.kind='ozon-labels' order by x.rowid desc limit 1)
      where ${latestComposition} and json_extract(e.payload,'$.batchId')=?
      order by d.created_at,d.label,e.rowid`, [batchId]);
    if (!rows.length) return null;
    return { id: batchId, groups: rows.map((row) => {
      const saved = JSON.parse(row.composition) as OzonComposition;
      const dispatch: Dispatch = {
        id: row.dispatchId, label: row.label, state: row.state, market: "OZON",
        store: row.store, destination: saved.cluster, createdAt: row.createdAt, sentAt: row.sentAt,
        qty: row.qty, cartonIds: saved.boxes.map((box) => box.id),
      };
      const labels = row.labelId && row.labelPayload
        ? { ...JSON.parse(row.labelPayload), id: row.labelId } as OzonLabels
        : null;
      return { ...saved, dispatch, labels };
    }) };
  }

  async function splitDeparture(draftId: string, sentId: string, selected: ReadonlySet<string>, remaining: string[],
    actor: string, now: string): Promise<Statement[]> {
    const [row] = await store.all<{ composition: string; labels: string | null }>(`
      select e.payload composition,(select payload from av2_exports where dispatch_id=e.dispatch_id
        and kind='ozon-labels' order by rowid desc limit 1) labels
      from av2_exports e where e.dispatch_id=? and e.kind='ozon-composition' order by e.rowid desc limit 1
    `, [draftId]);
    if (!row) return [];
    const composition = JSON.parse(row.composition) as OzonComposition;
    const labels = row.labels ? JSON.parse(row.labels) as OzonLabels : null;
    const expected = new Set([...selected, ...remaining]);
    check(composition.boxes.length === expected.size && new Set(composition.boxes.map((box) => box.id)).size === expected.size &&
      composition.boxes.every((box) => expected.has(box.id)) && (!labels || labels.codes.length === composition.boxes.length),
      "Список коробов и ШК Ozon расходится с подготовкой. Проверьте пары грузомест.");
    const statements: Statement[] = [];
    const append = (dispatchId: string, kind: string, data: object) => statements.push({
      sql: "insert into av2_exports(id,dispatch_id,kind,payload,actor,created_at) values(?,?,?,?,?,?)",
      args: [crypto.randomUUID(), dispatchId, kind, JSON.stringify(data), actor, now],
    });
    for (const dispatchId of [sentId, draftId]) {
      const isSent = dispatchId === sentId;
      const boxes = composition.boxes.filter((box) => selected.has(box.id) === isSent);
      append(dispatchId, compositionKind, { ...composition, boxes });
      if (labels) {
        const codes = labels.codes.filter((_, index) => selected.has(composition.boxes[index].id) === isSent);
        append(dispatchId, labelsKind, { codes, products: labels.products });
      }
    }
    return statements;
  }

  async function plan(action: string, payload: Record<string, unknown>, actor: string, revision: number, now: string) {
    const statements: Statement[] = [];
    const add = (sql: string, ...args: Statement["args"]) => statements.push({ sql, args });
    if (action === "ozon.prepare") {
      type Requested = { id: string; proof: string; cluster: string };
      const requested = payload.boxes as Requested[];
      check(Array.isArray(requested) && requested.length > 0 && requested.length <= ozonBoxLimit &&
        requested.every((row) => typeof row?.id === "string" && row.id.length <= 160 &&
          typeof row.proof === "string" && typeof row.cluster === "string" &&
          row.cluster.trim().length > 0 && row.cluster.length <= 120) &&
        new Set(requested.map((row) => row.id)).size === requested.length,
        "Проверьте список коробов и названия кластеров.");
      const loaded = new Map((await loadCartons(requested.map((row) => row.id))).map((box) => [box.id, box]));
      const groups = new Map<string, { store: string; cities: Set<string>; cluster: string; boxes: Carton[] }>();
      for (const row of requested) {
        const box = loaded.get(row.id);
        check(box, "Короб не найден. Проверьте список заново.");
        const issue = cartonIssue(box);
        check(!issue, box.label + " · " + issue);
        check(await proof(box) === row.proof, box.label + " · состав или статус изменился. Проверьте список заново.");
        const cluster = row.cluster.trim();
        const key = JSON.stringify([box.store, ozonCartonKey(cluster)]);
        const group = groups.get(key) ?? { store: box.store, cities: new Set<string>(), cluster, boxes: [] };
        group.cities.add(shipmentScope(box).city);
        group.boxes.push(box);
        groups.set(key, group);
      }
      const batchId = crypto.randomUUID();
      let index = 0;
      for (const group of groups.values()) {
        check(group.boxes.length <= ozonGroupBoxLimit, group.cluster + " · максимум " + ozonGroupBoxLimit + " коробов на одну отгрузку.");
        const dispatchId = crypto.randomUUID();
        const boxIds = JSON.stringify(group.boxes.map((box) => box.id));
        const label = "ОТ-" + String(revision + 1).padStart(5, "0") + (groups.size > 1 ? "-" + ++index : "");
        const saved: OzonComposition = {
          batchId, cluster: group.cluster, city: [...group.cities].join(", "),
          boxes: group.boxes.map(freezeBox),
        };
        add("insert into av2_dispatches(id,label,market,store,destination,state,actor,created_at,carton_ids,qty) values(?,?,?,?,?,'draft',?,?,?,?)",
          dispatchId, label, "OZON", group.store, group.cluster, actor, now, boxIds,
          group.boxes.reduce((quantity, box) => quantity + box.qty, 0));
        add("update av2_cartons set closed_at=case when state='open' then ? else closed_at end,state='closed',dispatch_id=? where id in (select value from json_each(?))",
          now, dispatchId, boxIds);
        add("insert into av2_exports(id,dispatch_id,kind,payload,actor,created_at) values(?,?,?,?,?,?)",
          crypto.randomUUID(), dispatchId, compositionKind, JSON.stringify(saved), actor, now);
      }
      return { statements, result: { batchId } };
    }

    check(action === "ozon.assign", "Неизвестная операция Ozon.");
    const dispatchId = payload.dispatchId;
    const codes = payload.codes as string[];
    check(typeof dispatchId === "string" && dispatchId.length <= 160 && Array.isArray(codes) &&
      codes.length > 0 && codes.length <= ozonGroupBoxLimit &&
      codes.every((code) => typeof code === "string" && isOzonCargoCode(code)) &&
      new Set(codes).size === codes.length, "Проверьте список уникальных штрихкодов Ozon.");
    const [row] = await store.all<{ composition: string; labelId: string | null; state: Dispatch["state"] }>(`
      select e.payload composition,d.state,(select x.id from av2_exports x where x.dispatch_id=d.id
        and x.kind='ozon-labels' order by x.rowid desc limit 1) label_id
      from av2_exports e join av2_dispatches d on d.id=e.dispatch_id
      where e.kind='ozon-composition' and d.id=? order by e.rowid desc limit 1`, [dispatchId]);
    check(row?.state === "draft", "Штрихкоды можно назначить только подготовленной отгрузке Ozon.");
    check(row.labelId === (payload.previousLabelId ?? null), "Штрихкоды уже обновились. Откройте отгрузку заново.");
    const saved = JSON.parse(row.composition) as OzonComposition;
    check(codes.length === saved.boxes.length, "Количество штрихкодов и коробов должно совпадать.");
    const [claimed] = await store.all<{ value: string }>(`
      select code.value from av2_exports e join av2_dispatches d on d.id=e.dispatch_id
      join json_each(e.payload,'$.codes') code
      where e.kind='ozon-labels' and d.id<>? and d.state<>'canceled' and
        e.id=(select x.id from av2_exports x where x.dispatch_id=d.id and x.kind='ozon-labels' order by x.rowid desc limit 1)
        and code.value in (select value from json_each(?)) limit 1`, [dispatchId, JSON.stringify(codes)]);
    check(!claimed, "Штрихкод " + (claimed?.value ?? "") + " уже связан с другой отгрузкой.");

    const current = new Map((await loadCartons(saved.boxes.map((box) => box.id))).map((box) => [box.id, box]));
    const boxes = saved.boxes.map(({ id }) => {
      const box = current.get(id);
      check(box?.dispatchId === dispatchId && box.state === "closed", "Список коробов изменился. Проверьте отгрузку.");
      return box;
    });
    check(contents(boxes.map(freezeBox)) === contents(saved.boxes),
      "Состав или артикулы изменились. Проверьте заявку Ozon и подготовьте её заново.");
    const barcodes = new Map<string, Set<string>>();
    for (const box of boxes) for (const item of box.items) {
      const barcode = item.barcode.trim();
      if (barcode) {
        const sku = ozonArticle(item.sku);
        const values = barcodes.get(sku) ?? new Set<string>();
        values.add(barcode);
        barcodes.set(sku, values);
      }
    }
    const products = [...barcodes].flatMap(([sku, values]) => [...values].map((barcode) => ({ sku, barcode })));
    const labelId = crypto.randomUUID();
    add("insert into av2_exports(id,dispatch_id,kind,payload,actor,created_at) values(?,?,?,?,?,?)",
      labelId, dispatchId, labelsKind, JSON.stringify({ codes, products }), actor, now);
    return { statements, result: { batchId: saved.batchId, labelId } };
  }

  return { preview, list, batch, plan, splitDeparture };
}
