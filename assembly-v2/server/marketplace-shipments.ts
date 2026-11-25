import { digest, spreadsheetError } from "../shared/catalog";
import type { Carton, Dispatch, Market } from "../shared/model";
import {
  isOzonCargoCode, ozonArticle, ozonBoxLimit, ozonCartonKey, ozonGroupBoxLimit,
  parseOzonCartonNumbers, summarizeOzonProducts,
  type OzonBatch, type OzonBatchSummary, type OzonBox, type OzonComposition,
  type OzonLabels, type OzonPreview, type OzonPreviewGroup,
} from "../shared/ozon-shipment";
import { warehouseCity } from "../shared/warehouse-filter";
import { validateWbCartonCodes, wbCodesForBoxes, type WbCartonCode } from "../shared/wb-shipment";
import type { SqlStore, Statement } from "./database";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

function shipmentScope(box: Carton) {
  if (box.market === "WB") {
    const cluster = box.destination.trim();
    return { key: JSON.stringify([box.store, cluster]), store: box.store, city: warehouseCity(box).label, cluster };
  }
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

function cartonIssue(box: Carton, market: Market) {
  if (box.market !== market) return "Короб другого маркетплейса";
  if (box.dispatchState === "sent") return "Короб уже отправлен";
  if (box.dispatchId) return "Короб в подготовленной отгрузке";
  if (!/^[1-9]\d*$/u.test(box.store)) return "Магазин не подтверждён";
  if (!shipmentScope(box).cluster) return "Направление не указано";
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

function contents(boxes: OzonBox[], article: (sku: string) => string) {
  return JSON.stringify(boxes.map((box) => [
    box.id, box.label, summarizeOzonProducts([box], article).map(({ sku, qty }) => [sku, qty]),
  ]));
}

function productBarcodes(boxes: Carton[], article: (sku: string) => string, market: Market) {
  const barcodes = new Map<string, Set<string>>();
  for (const box of boxes) for (const item of box.items) {
    const barcode = item.barcode.trim();
    if (!barcode || (market === "WB" && spreadsheetError(barcode))) continue;
    const sku = article(item.sku.trim());
    const values = barcodes.get(sku) ?? new Set<string>();
    values.add(barcode);
    barcodes.set(sku, values);
  }
  return [...barcodes].flatMap(([sku, values]) => [...values].map((barcode) => ({ sku, barcode })));
}

function generateWbCode() {
  const entropy = crypto.getRandomValues(new Uint8Array(16));
  return "RITM" + Array.from(entropy, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function marketplaceShipments(store: SqlStore, loadCartons: (ids: string[]) => Promise<Carton[]>, market: Market) {
  const prefix = market === "WB" ? "wb" : "ozon";
  const article = market === "WB" ? (sku: string) => sku : ozonArticle;
  const compositionKind = prefix + "-composition";
  const labelsKind = prefix + "-labels";
  const latestComposition = `e.rowid in (select max(rowid) from av2_exports where kind='${compositionKind}' group by dispatch_id)`;

  function hasSavedContents(saved: OzonComposition, boxes: Carton[], dispatchId: string) {
    return boxes.length === saved.boxes.length &&
      boxes.every((box) => box.market === market && box.dispatchId === dispatchId && box.state === "closed") &&
      contents(boxes.map(freezeBox), article) === contents(saved.boxes, article);
  }

  async function preview(input: string): Promise<OzonPreview> {
    const numbers = parseOzonCartonNumbers(input);
    const wanted = new Set(numbers);
    const matches = new Map<string, string[]>();
    const rows = await store.all<{ id: string; label: string; market: Market; dispatchState: string | null }>(
      "select c.id,c.label,c.market,d.state dispatch_state from av2_production_cartons c left join av2_dispatches d on d.id=c.dispatch_id",
    );
    const sent = new Set<string>();
    const otherMarkets = new Set<string>();
    for (const row of rows) {
      const key = ozonCartonKey(row.label);
      if (!wanted.has(key)) continue;
      if (market === "WB" && row.market !== market) {
        otherMarkets.add(key);
        continue;
      }
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
      const reason = box ? cartonIssue(box, market) : matched && matched.length > 1
        ? "Найдено несколько коробов с этим номером"
        : sent.has(label) ? "Короб уже отправлен" : otherMarkets.has(label) ? "Короб другого маркетплейса" : "Короб не найден";
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
        sum(case when exists(select 1 from av2_exports l where l.dispatch_id=e.dispatch_id and l.kind='${labelsKind}')
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
        and x.kind='${labelsKind}' order by x.rowid desc limit 1)
      where ${latestComposition} and json_extract(e.payload,'$.batchId')=?
      order by d.created_at,d.label,e.rowid`, [batchId]);
    if (!rows.length) return null;
    const groups: OzonBatch["groups"] = rows.map((row) => {
      const saved = JSON.parse(row.composition) as OzonComposition;
      const dispatch: Dispatch = {
        id: row.dispatchId, label: row.label, state: row.state, market,
        store: row.store, destination: saved.cluster, createdAt: row.createdAt, sentAt: row.sentAt,
        qty: row.qty, cartonIds: saved.boxes.map((box) => box.id),
      };
      const labels = row.labelId && row.labelPayload
        ? { ...JSON.parse(row.labelPayload), id: row.labelId } as OzonLabels
        : null;
      return { ...saved, dispatch, labels };
    });
    if (market === "WB") {
      const drafts = groups.filter((group) => group.dispatch.state === "draft");
      const current = new Map((await loadCartons(drafts.flatMap((group) => group.dispatch.cartonIds))).map((box) => [box.id, box]));
      for (const group of groups) {
        if (group.dispatch.state === "draft") {
          const boxes = group.boxes.map(({ id }) => current.get(id)).filter((box): box is Carton => !!box);
          group.compositionChanged = !hasSavedContents(group, boxes, group.dispatch.id);
          if (!group.compositionChanged) group.products = productBarcodes(boxes, article, market);
        } else if (group.labels) {
          group.products = group.labels.products;
        }
      }
    }
    return { id: batchId, groups };
  }

  async function splitDeparture(draftId: string, sentId: string, selected: ReadonlySet<string>, remaining: string[],
    actor: string, now: string): Promise<Statement[]> {
    const [row] = await store.all<{ composition: string; labels: string | null }>(`
      select e.payload composition,(select payload from av2_exports where dispatch_id=e.dispatch_id
        and kind='${labelsKind}' order by rowid desc limit 1) labels
      from av2_exports e where e.dispatch_id=? and e.kind='${compositionKind}' order by e.rowid desc limit 1
    `, [draftId]);
    if (!row) return [];
    const composition = JSON.parse(row.composition) as OzonComposition;
    const labels = row.labels ? JSON.parse(row.labels) as OzonLabels : null;
    const expected = new Set([...selected, ...remaining]);
    check(composition.boxes.length === expected.size && new Set(composition.boxes.map((box) => box.id)).size === expected.size &&
      composition.boxes.every((box) => expected.has(box.id)) && (!labels || labels.codes.length === composition.boxes.length),
      `Список коробов и ШК ${market === "WB" ? "WB" : "Ozon"} расходится с подготовкой. Проверьте пары грузомест.`);
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
        const keep = (_: unknown, index: number) => selected.has(composition.boxes[index].id) === isSent;
        const codes = labels.codes.filter(keep);
        append(dispatchId, labelsKind, {
          codes, products: labels.products,
          ...(market === "WB" ? { cartonIds: boxes.map((box) => box.id), printCodes: labels.printCodes?.filter(keep) } : {}),
        });
      }
    }
    return statements;
  }

  async function plan(action: string, payload: Record<string, unknown>, actor: string, revision: number, now: string) {
    const statements: Statement[] = [];
    const add = (sql: string, ...args: Statement["args"]) => statements.push({ sql, args });
    if (action === prefix + ".prepare") {
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
        const issue = cartonIssue(box, market);
        check(!issue, box.label + " · " + issue);
        check(await proof(box) === row.proof, box.label + " · состав или статус изменился. Проверьте список заново.");
        const scope = shipmentScope(box);
        const cluster = market === "WB" ? scope.cluster : row.cluster.trim();
        const key = market === "WB" ? scope.key : JSON.stringify([box.store, ozonCartonKey(cluster)]);
        const group = groups.get(key) ?? { store: box.store, cities: new Set<string>(), cluster, boxes: [] };
        group.cities.add(scope.city);
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
          ...(market === "WB" ? { products: productBarcodes(group.boxes, article, market) } : {}),
        };
        add("insert into av2_dispatches(id,label,market,store,destination,state,actor,created_at,carton_ids,qty) values(?,?,?,?,?,'draft',?,?,?,?)",
          dispatchId, label, market, group.store, group.cluster, actor, now, boxIds,
          group.boxes.reduce((quantity, box) => quantity + box.qty, 0));
        add("update av2_cartons set closed_at=case when state='open' then ? else closed_at end,state='closed',dispatch_id=? where id in (select value from json_each(?))",
          now, dispatchId, boxIds);
        add("insert into av2_exports(id,dispatch_id,kind,payload,actor,created_at) values(?,?,?,?,?,?)",
          crypto.randomUUID(), dispatchId, compositionKind, JSON.stringify(saved), actor, now);
      }
      return { statements, result: { batchId } };
    }

    const generate = market === "WB" && action === "wb.generate";
    check(action === prefix + ".assign" || generate, "Неизвестная операция отгрузки.");
    const dispatchId = payload.dispatchId;
    check(typeof dispatchId === "string" && dispatchId.length > 0 && dispatchId.length <= 160, "Проверьте отгрузку.");
    const [row] = await store.all<{ composition: string; labelId: string | null; labelPayload: string | null; state: Dispatch["state"] }>(`
      select e.payload composition,d.state,l.id label_id,l.payload label_payload
      from av2_exports e join av2_dispatches d on d.id=e.dispatch_id
      left join av2_exports l on l.id=(select x.id from av2_exports x where x.dispatch_id=d.id
        and x.kind='${labelsKind}' order by x.rowid desc limit 1)
      where e.kind='${compositionKind}' and d.id=? and d.market=? order by e.rowid desc limit 1`, [dispatchId, market]);
    check(row?.state === "draft", "Штрихкоды можно назначить только подготовленной отгрузке.");
    check(row.labelId === (payload.previousLabelId ?? null), "Штрихкоды уже обновились. Откройте отгрузку заново.");
    const saved = JSON.parse(row.composition) as OzonComposition;
    let codes: string[];
    let printCodes: OzonLabels["printCodes"];
    if (market === "WB") {
      const previous = row.labelId && row.labelPayload
        ? { ...JSON.parse(row.labelPayload), id: row.labelId } as OzonLabels : null;
      let entries: WbCartonCode[];
      if (generate) {
        check(!previous, "Коды коробов уже сохранены. Откройте пары.");
        entries = saved.boxes.map(() => ({ code: generateWbCode(), printCode: null }));
      } else {
        check(Array.isArray(payload.entries) && payload.entries.length <= ozonGroupBoxLimit, "Загрузите список кодов WB.");
        entries = wbCodesForBoxes(payload.entries as WbCartonCode[], payload.replaceCodes === true ? null : previous, saved.boxes.length);
      }
      validateWbCartonCodes(entries, saved.boxes.length);
      codes = entries.map((entry) => entry.code);
      printCodes = entries.map((entry) => entry.printCode);
      const [claimed] = await store.all<{ value: string }>(`
        with candidate as (select upper(json_extract(value,'$.code')) code,json_extract(value,'$.printCode') qr from json_each(?))
        select code.value from av2_exports e join json_each(e.payload,'$.codes') code
        where e.kind='wb-labels' and e.dispatch_id<>? and (
          upper(code.value) in (select code from candidate)
          or json_extract(e.payload,'$.printCodes[' || code.key || ']') in (select qr from candidate where qr is not null)
        ) limit 1`, [JSON.stringify(entries), dispatchId]);
      check(!claimed, "ШК короба " + (claimed?.value ?? "") + " или его QR уже сохранялся в другой отгрузке WB.");
    } else {
      codes = payload.codes as string[];
      check(Array.isArray(codes) && codes.length > 0 && codes.length <= ozonGroupBoxLimit &&
        codes.every((code) => typeof code === "string" && isOzonCargoCode(code)) &&
        new Set(codes).size === codes.length, "Проверьте список уникальных штрихкодов Ozon.");
      check(codes.length === saved.boxes.length, "Количество штрихкодов и коробов должно совпадать.");
      const [claimed] = await store.all<{ value: string }>(`
        select code.value from av2_exports e join av2_dispatches d on d.id=e.dispatch_id
        join json_each(e.payload,'$.codes') code
        where e.kind='ozon-labels' and d.id<>? and d.state<>'canceled' and
          e.id=(select x.id from av2_exports x where x.dispatch_id=d.id and x.kind='ozon-labels' order by x.rowid desc limit 1)
          and code.value in (select value from json_each(?)) limit 1`, [dispatchId, JSON.stringify(codes)]);
      check(!claimed, "Штрихкод " + (claimed?.value ?? "") + " уже связан с другой отгрузкой.");
    }

    const current = new Map((await loadCartons(saved.boxes.map((box) => box.id))).map((box) => [box.id, box]));
    const boxes = saved.boxes.map(({ id }) => {
      const box = current.get(id);
      check(box?.dispatchId === dispatchId && box.state === "closed", "Список коробов изменился. Проверьте отгрузку.");
      return box;
    });
    check(hasSavedContents(saved, boxes, dispatchId),
      `Состав или артикулы изменились. Проверьте заявку ${market === "WB" ? "WB" : "Ozon"} и подготовьте её заново.`);
    const products = productBarcodes(boxes, article, market);
    const labelId = crypto.randomUUID();
    add("insert into av2_exports(id,dispatch_id,kind,payload,actor,created_at) values(?,?,?,?,?,?)",
      labelId, dispatchId, labelsKind, JSON.stringify({ codes, products, printCodes }), actor, now);
    return { statements, result: { batchId: saved.batchId, labelId } };
  }

  return { preview, list, batch, plan, splitDeparture };
}
