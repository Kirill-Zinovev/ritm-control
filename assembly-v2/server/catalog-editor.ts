import { labelArticle } from "../shared/labels";
import { catalogDetail, catalogEntryWithStore, catalogLabelTargets, requireCatalog as check, selectableCatalog } from './catalog-store';
import { catalogKey, digest, photoAllowed } from '../shared/catalog';
import { isCatalogMedia, productFields, type ManagedProduct } from '../shared/catalog-editor';
import type { SqlStore, Statement } from './database';
import { labelInputKey, missingLabelFields } from '../shared/product-label-fields';
import { qualityPlan } from './quality';

const q = (sql: string, ...args: (string | number | null)[]): Statement => ({ sql, args });
const clean = (v: unknown, max = 1000): string => {
  check(typeof v === 'string' && v.length <= max, 'Проверьте текстовые поля карточки.');
  return v.trim();
};

type LabelAttachment = {
  id: string;
  sha256: string;
  inputKey: string;
  revision: number;
};

const cardSearch = (product: ManagedProduct) => catalogKey(
  [product.sku, ...product.aliases, product.name, product.barcode, product.kind, product.machine].join(' '),
);
export function saveCard(product: ManagedProduct, actor: string, now: string) {
  return q(`insert into av2_catalog_products(entry_id,market,store,sku,search,machine,review,data,revision,actor,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,?) on conflict(entry_id) do update set search=excluded.search,machine=excluded.machine,
    review=excluded.review,data=excluded.data,revision=excluded.revision,actor=excluded.actor,updated_at=excluded.updated_at`,
    product.id, product.market, product.store, product.sku, cardSearch(product), product.machine, product.issues.length ? 1 : 0,
    JSON.stringify(product), product.editRevision ?? 0, actor, now);
}

export function catalogEditAudit(
  before: ManagedProduct | null, product: ManagedProduct, actor: string, now: string, evidence: string,
) {
  return q('insert into av2_quality_repairs(id,kind,entity_id,"before","after",evidence,actor,created_at) values(?,?,?,?,?,?,?,?)',
    crypto.randomUUID(), 'catalog.edit', product.id + ':' + product.editRevision,
    JSON.stringify(before), JSON.stringify(product), evidence, actor, now);
}

export async function catalogAttachLabelsPlan(store: SqlStore, payload: Record<string, unknown>, actor: string, now: string) {
  const { importId, entries } = payload;
  check(typeof importId === 'string' && Array.isArray(entries) && entries.length >= 1 && entries.length <= 12,
    'Выберите от 1 до 12 карточек для этикеток.');
  const records = entries as LabelAttachment[];
  check(records.every(e => e && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 1500 &&
    typeof e.sha256 === 'string' && /^[a-f0-9]{64}$/.test(e.sha256) &&
    typeof e.inputKey === 'string' && e.inputKey.length <= 10000 &&
    Number.isSafeInteger(e.revision) && e.revision >= 0) &&
    new Set(records.map(e => e.id)).size === records.length, 'Проверьте карточки и файлы этикеток.');
  const [meta] = await store.all<{activeCatalogId: string | null}>('select active_catalog_id from av2_meta where id=1');
  check(meta?.activeCatalogId === importId, 'Версия справочника изменилась. Обновите страницу.');
  const targets = new Map((await catalogLabelTargets(store, importId, records.map(e => e.id))).map(row => [row.entryId, row]));
  const uploaded = new Set((await store.all<{sha256: string}>(
    "select sha256 from av2_catalog_media where mime_type='image/png' and sha256 in (select value from json_each(?))",
    [JSON.stringify(records.map(e => e.sha256))],
  )).map(file => file.sha256));
  const statements: Statement[] = [];
  const attached: string[] = [], skipped: {id: string; reason: string}[] = [];
  for (const { id, sha256, revision, inputKey } of records) {
    const row = targets.get(id);
    const before = row && JSON.parse(row.data) as ManagedProduct;
    const reason = !row || !before ? 'Карточка не найдена' :
      before.labelSha || !row.needsLabel ? 'В карточке уже есть этикетка' :
      revision !== (before.editRevision ?? 0) || inputKey !== labelInputKey(before) ? 'Карточка изменилась' :
      missingLabelFields(before).length ? 'Не хватает данных для этикетки' :
      !uploaded.has(sha256) ? 'PNG не загружен' : '';
    if (reason || !row || !before) {
      skipped.push({ id, reason });
      continue;
    }
    const updated = { ...before, labelSha: sha256, editRevision: revision + 1, updatedAt: now };
    statements.push(
      q(`insert into av2_catalog_products(entry_id,market,store,sku,search,machine,review,data,revision,actor,updated_at)
        values(?,?,?,?,?,?,?,?,?,?,?) on conflict(entry_id) do update set
          data=excluded.data,revision=excluded.revision,actor=excluded.actor,updated_at=excluded.updated_at`,
        id, before.market, before.store, before.sku, row.search, before.machine, row.review, JSON.stringify(updated), revision + 1, actor, now),
      q(`insert into av2_quality_repairs(id,kind,entity_id,before,after,evidence,actor,created_at) values(?,'catalog.edit',?,?,?,?,?,?)`,
        crypto.randomUUID(), id + ':' + (revision + 1), row.data, JSON.stringify(updated), 'Этикетка сгенерирована из данных карточки', actor, now),
    );
    attached.push(id);
  }
  return { statements, result: { attached, skipped } };
}
export async function catalogSavePlan(store: SqlStore, payload: Record<string, unknown>, actor: string, now: string) {
  const [meta] = await store.all<{ activeCatalogId: string | null }>('select active_catalog_id from av2_meta where id=1');
  check(meta?.activeCatalogId && payload.importId === meta.activeCatalogId, 'Версия справочника изменилась. Обновите страницу.');
  const input = payload.product as ManagedProduct;
  check(input && typeof input === 'object', 'Заполните карточку товара.');
  check(input.market === 'OZON' || input.market === 'WB', 'Выберите маркетплейс.');
  const sku = catalogKey(clean(input.sku, 300)), shop = clean(input.store, 100);
  check(sku && shop, 'Укажите артикул и магазин.');
  const entryId = JSON.stringify([input.market, shop, sku]);
  check(!payload.id || typeof payload.id === 'string', 'Карточка не найдена. Обновите справочник.');
  const sourceId = payload.id ? String(payload.id) : entryId;
  const before = await catalogDetail(store, meta.activeCatalogId, sourceId) as (ManagedProduct | null);
  check(payload.create ? !before : !!before, payload.create ? 'Такой товар уже есть. Откройте его карточку.' : 'Карточка не найдена. Обновите справочник.');
  check(payload.revision === (before?.editRevision || 0), 'Карточка изменена в другом окне. Обновите её перед сохранением.');
  const identityChanged = sourceId !== entryId;
  const sameScope = before?.market === input.market && before.store === shop;
  const assigningStore = identityChanged && before?.store === '' && before.market === input.market && before.sku === sku;
  if (identityChanged) {
    check(before && !payload.create, 'Карточка не найдена. Обновите справочник.');
    check(shop === before.store || shop === '1' || shop === '2', 'Выберите магазин 1 или 2.');
    const existing = await store.all(`select entry_id from ${selectableCatalog} where import_id=? and entry_id=?`, [meta.activeCatalogId, entryId]);
    check(!existing.length, 'Карточка с таким артикулом уже есть в этом магазине. Откройте её для сверки.');
  }
  const [previousTarget] = identityChanged || payload.create
    ? await store.all<{revision:number}>('select revision from av2_catalog_products where entry_id=?', [entryId]) : [];
  const fields = Object.fromEntries(productFields.map(([key]) => [
    key, key === 'printExtension' ? clean(input[key] ?? before?.[key] ?? '', 32).toUpperCase() : clean(input[key], 4000),
  ]));
  check(/^[\p{L}\p{N}._-]*$/u.test(fields.printExtension), 'Проверьте расширение печати.');
  check(fields.name || assigningStore && !before?.name, 'Укажите название товара.');
  const units = input.unitsPerBox;
  check(units === null || Number.isSafeInteger(units) && units > 0 && units <= 10000000, 'Вместимость короба: целое число больше нуля.');
  check(units === null || fields.boxType || assigningStore && units === before?.unitsPerBox && !before.boxType, 'Для вместимости укажите тип короба.');
  for (const field of ['sheetsPerUnit', 'rollMultiplicity', 'xeroxMultiplicity'] as const) {
    const value = fields[field];
    check(!value || assigningStore && value === before?.[field] || Number(value.replace(',', '.')) > 0 && Number(value.replace(',', '.')) <= 10000000, 'Листы и кратность должны быть положительными числами.');
  }
  check(Array.isArray(input.aliases) && input.aliases.length <= 100 && input.aliases.every(a => typeof a === 'string' && a.length <= 300), 'Проверьте связанные артикулы.');
  const previousSku = identityChanged && sameScope ? before.sku : '';
  const aliases = [...new Set([sku, labelArticle(sku,input.market), previousSku, labelArticle(previousSku,input.market), ...input.aliases.map(catalogKey)].filter(Boolean))];
  const newAliases = identityChanged ? aliases : aliases.filter(a => !before?.aliases.includes(a));
  if (newAliases.length) {
    const conflicts = await store.all<{ alias: string }>(`select alias from av2_resolved_catalog_aliases
      where import_id=? and market=? and store=? and entry_id not in (?,?) and alias in(select value from json_each(?)) limit 1`,
      [meta.activeCatalogId, input.market, shop, entryId, sourceId, JSON.stringify(newAliases)]);
    check(!conflicts.length, `Артикул ${conflicts[0]?.alias || ''} уже связан с другим товаром этого магазина.`);
  }
  const workNorms: ManagedProduct['workNorms'] = {};
  for (const op of ['cut', 'assembly', 'packing'] as const) {
    const value = input.workNorms?.[op] ?? null;
    check(value === null || typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10000000, 'Норма за смену должна быть больше нуля.');
    workNorms[op] = value;
  }
  const photoUrl = clean(input.photoUrl ?? '', 2048) || null;
  check(!photoUrl || photoAllowed(photoUrl) || isCatalogMedia(photoUrl), 'Загрузите фото файлом или укажите ссылку на фото WB.');
  const labelSha = identityChanged && input.labelSha === before?.labelSha ? null : input.labelSha ?? null;
  check(labelSha === null || typeof labelSha === 'string' && /^[a-f0-9]{64}$/.test(labelSha), 'Проверьте файл этикетки.');
  const hashes = [...new Set([isCatalogMedia(photoUrl || '') ? photoUrl!.split('=')[1] : null, labelSha].filter((s): s is string => !!s))];
  if (hashes.length) {
    const media = await store.all<{ sha256: string }>('select sha256 from av2_catalog_media where sha256 in(select value from json_each(?))', [JSON.stringify(hashes)]);
    check(media.length === hashes.length, 'Сначала дождитесь загрузки фото и этикетки.');
  }
  const assigned = assigningStore && before ? catalogEntryWithStore(before, shop) : null;
  const assignment = assigned && before ? await qualityPlan(store, 'quality.assignCatalogStore', {
    importId: meta.activeCatalogId, entryId: sourceId, store: shop,
    sourceRowsDigest: await digest(JSON.stringify(before.rows)), reason: 'Магазин указан в карточке товара',
  }, actor, now) : null;
  const product: ManagedProduct = {
    ...before, ...fields, id: entryId, market: input.market, store: shop, sku, aliases,
    unitsPerBox: units, capacitySource: assigned && units === assigned.unitsPerBox ? assigned.capacitySource : units === null ? 'review' : 'user',
    photoId: before?.photoId || null, photoUrl, labelSha, workNorms,
    issues: assigned?.issues ?? (units === null ? ['Вместимость короба не задана'] : []),
    rows: before?.rows || [], sheetCountSourceError: undefined,
    editRevision: Math.max(before?.editRevision ?? 0, previousTarget?.revision ?? 0) + 1, updatedAt: now,
  } as ManagedProduct;
  const search = cardSearch(product);
  const matches = `select p.id from av2_positions p join av2_supplies s on s.id=p.supply_id
    where s.market=? and s.store=? and (p.catalog_entry_id in (?,?) or upper(p.sku) in(select value from json_each(?)))`;
  const matchArgs = [input.market, shop, entryId, sameScope || assigningStore ? sourceId : entryId, JSON.stringify(aliases)];
  const [count] = await store.all<{ n: number }>(`select count(*) n from av2_positions where id in(${matches})`, matchArgs);
  const statements: Statement[] = [
    ...(assignment?.statements ?? []),
    ...(identityChanged && before && !assigningStore
      ? [saveCard({ ...before, aliases: [], retiredIdentity: true }, actor, now)]
      : []),
    saveCard(product, actor, now),
    catalogEditAudit(before, product, actor, now, 'Редактор справочника'),
    q(`update av2_positions set name=?,barcode=?,units_per_box=?,catalog_import_id=?,catalog_entry_id=? where id in(${matches})`,
      product.name, product.barcode, units, meta.activeCatalogId, entryId, ...matchArgs),
  ];
  // Recalculate capacity only for cartons not reserved/sent. Quantities and work are immutable here.
  if (identityChanged || units !== before?.unitsPerBox) for (const table of ['av2_allocations', 'av2_legacy_allocations'])
    statements.push(q(`update ${table} set units_per_box=? where removed_at is null and position_id in(${matches})
      and carton_id in(select id from av2_cartons where dispatch_id is null)`, units, ...matchArgs));
  statements.push(q(`update av2_warehouse_receipts set name=?,search=? where voided_at is null and upper(sku) in(select value from json_each(?))
    and carton_id in(select id from av2_warehouse_cartons where market=? and store=?)`, product.name, search, JSON.stringify(aliases), input.market, shop));
  return { statements, result: { entryId, revision: product.editRevision, updatedPositions: count.n } };
}
