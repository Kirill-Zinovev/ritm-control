const {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} = require("drizzle-orm/sqlite-core");
const {sql}=require("drizzle-orm");
const managerAccess=sqliteTable("av2_manager_access",{
  id:integer("id").primaryKey(),salt:text("salt").notNull(),passwordHash:text("password_hash").notNull(),
  version:text("version").notNull(),updatedAt:text("updated_at").notNull(),updatedBy:text("updated_by").notNull(),
});
const managerAttempts=sqliteTable("av2_manager_attempts",{
  id:text("id").primaryKey(),window:integer("window").notNull(),attempts:integer("attempts").notNull(),
});
const meta = sqliteTable("av2_meta", {
  id: integer("id").primaryKey(),
  revision: integer("revision").notNull(),
  activeCatalogId: text("active_catalog_id"),
});
const shiftNorms = sqliteTable("av2_shift_norms", {
  typeKey: text("type_key").primaryKey(),
  data: text("data").notNull(),
  sourceHash: text("source_hash").notNull(),
  capturedAt: text("captured_at").notNull(),
});
const employees = sqliteTable("av2_employees", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: integer("active").notNull().default(1),
});
const supplies = sqliteTable("av2_supplies", {
  id: text("id").primaryKey(),
  externalId: text("external_id").notNull().unique(),
  originShipmentId: text("origin_shipment_id"),
  sourceActive: integer("source_active").notNull().default(1),
  isDemo: integer("is_demo").notNull().default(0),
  title: text("title").notNull(),
  market: text("market").notNull(),
  store: text("store").notNull(),
  destination: text("destination").notNull(),
  sourceVersion: integer("source_version").notNull(),
  sourcePayload: text("source_payload").notNull(),
  createdAt: text("created_at").notNull(),
});
const positions = sqliteTable(
  "av2_positions",
  {
    id: text("id").primaryKey(),
    supplyId: text("supply_id")
      .notNull()
      .references(() => supplies.id),
    externalId: text("external_id").notNull(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    barcode: text("barcode").notNull(),
    department: text("department").notNull(),
    plan: integer("plan").notNull(),
    unitsPerBox: integer("units_per_box"),
    ready: integer("ready").notNull(),
    cutOperation: text("cut_operation").notNull(),
    catalogImportId: text("catalog_import_id"),
    catalogEntryId: text("catalog_entry_id"),
    sourceActive: integer("source_active").notNull().default(1),
  },
  (table) => [
    uniqueIndex("av2_position_source").on(table.supplyId, table.externalId),
    index("av2_positions_supply").on(table.supplyId),
    index("av2_active_positions_sku").on(sql`${table.sku} collate nocase`).where(sql`${table.sourceActive} = 1`),
  ],
);
const work = sqliteTable(
  "av2_work",
  {
    id: text("id").primaryKey(),
    supplyId: text("supply_id").references(() => supplies.id),
    positionId: text("position_id")
      .notNull()
      .references(() => positions.id),
    employeeId: text("employee_id")
      .notNull()
      .references(() => employees.id),
    employeeName: text("employee_name").notNull(),
    operation: text("operation").notNull(),
    qty: integer("qty").notNull(),
    legacyEventId: text("legacy_event_id"),
    norm: text("norm"),
    coefficient: text("coefficient"),
    actor: text("actor").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("av2_work_position").on(table.positionId, table.operation),
    index("av2_work_recent").on(table.createdAt),
    index("av2_work_supply_recent").on(table.supplyId, table.createdAt),
    uniqueIndex("av2_work_legacy_event").on(table.legacyEventId),
  ],
);
const corrections = sqliteTable("av2_corrections", {
  id: text("id").primaryKey(),
  workId: text("work_id")
    .notNull()
    .unique()
    .references(() => work.id),
  reason: text("reason").notNull(),
  actor: text("actor").notNull(),
  createdAt: text("created_at").notNull(),
});
const dispatches = sqliteTable("av2_dispatches", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  market: text("market").notNull(),
  store: text("store").notNull(),
  destination: text("destination").notNull(),
  state: text("state").notNull(),
  actor: text("actor").notNull(),
  createdAt: text("created_at").notNull(),
  sentAt: text("sent_at"),
  sentPayload: text("sent_payload"),
  cartonIds: text("carton_ids"),
  qty: integer("qty"),
});
const cartons = sqliteTable(
  "av2_cartons",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    market: text("market").notNull(),
    store: text("store").notNull(),
    destination: text("destination").notNull(),
    state: text("state").notNull(),
    dispatchId: text("dispatch_id").references(() => dispatches.id),
    createdAt: text("created_at").notNull(),
    closedAt: text("closed_at"),
  },
  (table) => [
    index("av2_cartons_current").on(table.dispatchId, table.state),
    uniqueIndex("av2_cartons_label").on(table.label),
  ],
);
const allocations = sqliteTable(
  "av2_allocations",
  {
    id: text("id").primaryKey(),
    cartonId: text("carton_id")
      .notNull()
      .references(() => cartons.id),
    positionId: text("position_id")
      .notNull()
      .references(() => positions.id),
    qty: integer("qty").notNull(),
    unitsPerBox: integer("units_per_box").notNull(),
    createdAt: text("created_at").notNull(),
    removedAt: text("removed_at"),
    removalReason: text("removal_reason"),
    actor: text("actor").notNull(),
  },
  (table) => [
    index("av2_allocations_position").on(table.positionId, table.removedAt),
    index("av2_allocations_carton").on(table.cartonId, table.removedAt),
  ],
);
const exportSnapshots = sqliteTable(
  "av2_exports",
  {
    id: text("id").primaryKey(),
    dispatchId: text("dispatch_id")
      .notNull()
      .references(() => dispatches.id),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    actor: text("actor").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("av2_exports_created").on(table.createdAt)],
);
const commands = sqliteTable("av2_commands", {
  cartonId:text("carton_id").generatedAlwaysAs(sql`json_extract("payload", '$.cartonId')`,{mode:"virtual"}),
  key: text("key").primaryKey(),
  action: text("action").notNull(),
  payload: text("payload").notNull(),
  result: text("result").notNull(),
  expectedRevision: integer("expected_revision").notNull(),
  actor: text("actor").notNull(),
  createdAt: text("created_at").notNull(),
},t=>[index("av2_command_carton_lookup").on(t.action,t.cartonId)]);

const positionTotals = sqliteTable("av2_position_totals", {
  positionId: text("position_id")
    .primaryKey()
    .references(() => positions.id),
  cut: integer("cut").notNull().default(0),
  assembly: integer("assembly").notNull().default(0),
  packing: integer("packing").notNull().default(0),
  boxed: integer("boxed").notNull().default(0),
});
const teamTotals = sqliteTable(
  "av2_team_totals",
  {
    id: text("id").primaryKey(),
    positionId: text("position_id")
      .notNull()
      .references(() => positions.id),
    employeeId: text("employee_id")
      .notNull()
      .references(() => employees.id),
    name: text("name").notNull(),
    cut: integer("cut").notNull().default(0),
    assembly: integer("assembly").notNull().default(0),
    packing: integer("packing").notNull().default(0),
  },
  (table) => [
    uniqueIndex("av2_team_position_employee").on(
      table.positionId,
      table.employeeId,
    ),
  ],
);
const catalogImports = sqliteTable("av2_catalog_imports", {
  id: text("id").primaryKey(),
  manifest: text("manifest").notNull(),
  state: text("state").notNull(),
  createdAt: text("created_at").notNull(),
  actor: text("actor").notNull(),
});
const catalogChunks = sqliteTable("av2_catalog_chunks", {
  id: text("id").primaryKey(),
  importId: text("import_id")
    .notNull()
    .references(() => catalogImports.id),
  kind: text("kind").notNull(),
  part: integer("part").notNull(),
  digest: text("digest").notNull(),
  count: integer("count").notNull(),
});
const catalogEntries = sqliteTable(
  "av2_catalog_entries",
  {
    id: text("id").primaryKey(),
    importId: text("import_id")
      .notNull()
      .references(() => catalogImports.id),
    entryId: text("entry_id").notNull(),
    market: text("market").notNull(),
    store: text("store").notNull(),
    sku: text("sku").notNull(),
    search: text("search").notNull(),
    machine: text("machine").notNull(),
    review: integer("review").notNull(),
    data: text("data").notNull(),
  },
  (t) => [
    uniqueIndex("av2_catalog_entry_version").on(t.importId, t.entryId),
    index("av2_catalog_filter").on(t.importId, t.market, t.store, t.sku),
    index("av2_catalog_machine").on(t.importId, t.machine),
  ],
);
const catalogAliases = sqliteTable(
  "av2_catalog_aliases",
  {
    id: text("id").primaryKey(),
    importId: text("import_id")
      .notNull()
      .references(() => catalogImports.id),
    market: text("market").notNull(),
    store: text("store").notNull(),
    alias: text("alias").notNull(),
    entryId: text("entry_id").notNull(),
    primary: integer("is_primary").notNull(),
  },
  (t) => [
    index("av2_catalog_alias_lookup").on(
      t.importId,
      t.market,
      t.store,
      t.alias,
    ),
  ],
);
const printExtensions = sqliteTable("av2_print_extensions", {
  sku: text("sku").primaryKey(),
  extension: text("extension").notNull(),
});
const catalogPhotos = sqliteTable(
  "av2_catalog_photos",
  {
    id: text("id").primaryKey(),
    importId: text("import_id")
      .notNull()
      .references(() => catalogImports.id),
    photoId: text("photo_id").notNull(),
    data: text("data").notNull(),
  },
  (t) => [uniqueIndex("av2_catalog_photo_version").on(t.importId, t.photoId)],
);
const catalogFiles = sqliteTable("av2_catalog_files", {
  id: text("id").primaryKey(),
  importId: text("import_id")
    .notNull()
    .references(() => catalogImports.id),
  role: text("role").notNull(),
  sha256: text("sha256").notNull(),
  bytes: integer("bytes").notNull(),
});
const photoCache = sqliteTable("av2_photo_cache", {
  id: text("id").primaryKey(),
});
const catalogReferences = sqliteTable("av2_catalog_references", {
  id: text("id").primaryKey(),
  importId: text("import_id").notNull().references(() => catalogImports.id),
  entryId: text("entry_id").notNull(),
  sourceEntryId: text("source_entry_id").notNull(),
  market: text("market").notNull(),
  store: text("store").notNull(),
  sku: text("sku").notNull(),
  search: text("search").notNull(),
  machine: text("machine").notNull(),
  review: integer("review").notNull(),
  data: text("data").notNull(),
  evidence: text("evidence").notNull(),
  actor: text("actor").notNull(),
  createdAt: text("created_at").notNull(),
}, t => [uniqueIndex("av2_catalog_reference_version").on(t.importId,t.entryId)]);
const qualityRepairs = sqliteTable("av2_quality_repairs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  entityId: text("entity_id").notNull(),
  before: text("before").notNull(),
  after: text("after").notNull(),
  evidence: text("evidence").notNull(),
  actor: text("actor").notNull(),
  createdAt: text("created_at").notNull(),
},t=>[uniqueIndex("av2_quality_repair_entity").on(t.kind,t.entityId)]);
const ritmLinks = sqliteTable("av2_ritm_links", {
  shipmentId: text("shipment_id").primaryKey(),
  sourceRevision: integer("source_revision").notNull(),
  fingerprint: text("fingerprint").notNull(),
  payload: text("payload").notNull(),
  seenAt: integer("seen_at").notNull(),
  issues: text("issues").notNull().default("[]"),
});
const ritmSync = sqliteTable("av2_ritm_sync", {
  id: integer("id").primaryKey(),
  checkedAt: integer("checked_at").notNull().default(0),
  sourceRevision: integer("source_revision").notNull().default(0),
  sourceAt: text("source_at"),
  status: text("status").notNull().default("waiting"),
  report: text("report").notNull().default("{}"),
  leaseId: text("lease_id"),
  leaseUntil: integer("lease_until").notNull().default(0),
});
const warehouseCartons = sqliteTable(
  "av2_warehouse_cartons",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull().unique(),
    market: text("market").notNull(),
    store: text("store").notNull(),
    state: text("state").notNull(),
    version: integer("version").notNull().default(0),
    createdAt: text("created_at").notNull(),
    closedAt: text("closed_at"),
  },
  (t) => [
    index("av2_warehouse_current").on(t.market, t.store, t.state, t.createdAt),
  ],
);
const warehouseReceipts = sqliteTable(
  "av2_warehouse_receipts",
  {
    id: text("id").primaryKey(),
    cartonId: text("carton_id")
      .notNull()
      .references(() => warehouseCartons.id),
    positionId: text("position_id").references(() => positions.id),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    search: text("search").notNull(),
    qty: integer("qty").notNull(),
    catalogImportId: text("catalog_import_id"),
    photoId: text("photo_id"),
    employeeId: text("employee_id")
      .notNull()
      .references(() => employees.id),
    employee: text("employee").notNull(),
    supply: text("supply").notNull(),
    comment: text("comment").notNull(),
    actor: text("actor").notNull(),
    createdAt: text("created_at").notNull(),
    voidedAt: text("voided_at"),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("av2_warehouse_receipt_carton").on(t.cartonId, t.createdAt),
    index("av2_warehouse_receipt_position").on(t.positionId),
  ],
);
module.exports = {
  catalogProducts: sqliteTable("av2_catalog_products", {
    entryId: text("entry_id").primaryKey(),
    market: text("market").notNull(), store: text("store").notNull(), sku: text("sku").notNull(),
    search: text("search").notNull(), machine: text("machine").notNull(), review: integer("review").notNull(),
    data: text("data").notNull(), revision: integer("revision").notNull(),
    actor: text("actor").notNull(), updatedAt: text("updated_at").notNull(),
  }, t => [index("av2_catalog_product_scope").on(t.market,t.store,t.sku)]),
  catalogMedia: sqliteTable("av2_catalog_media", {
    sha256: text("sha256").primaryKey(), mimeType: text("mime_type").notNull(),
    bytes: integer("bytes").notNull(), createdAt: text("created_at").notNull(),
  }),
  photoOverrides: sqliteTable("av2_photo_overrides", {
    sku: text("sku").primaryKey(),
    url: text("url").notNull(),
    actor: text("actor").notNull(),
    updatedAt: text("updated_at").notNull(),
  }),
  sourcePhotos: sqliteTable("av2_source_photos", {
    positionId: text("position_id").primaryKey(),
    shipmentId: text("shipment_id").notNull(),
    sku: text("sku").notNull(),
    url: text("url").notNull(),
    sourceRevision: integer("source_revision").notNull(),
  }),
  stockCutWork: sqliteTable("av2_stock_cut_work", {
    id: text("id").primaryKey(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    market: text("market").notNull(),
    store: text("store").notNull(),
    employeeId: text("employee_id").notNull().references(() => employees.id),
    employee: text("employee").notNull(),
    operation: text("operation").notNull(),
    qty: integer("qty").notNull(),
    catalogImportId: text("catalog_import_id").notNull(),
    productType: text("product_type").notNull(),
    norm: text("norm"),
    coefficient: text("coefficient"),
    createdAt: text("created_at").notNull(),
    actor: text("actor").notNull(),
    comment: text("comment").notNull().default(""),
    canceledAt: text("canceled_at"),
    cancelReason: text("cancel_reason"),
    cancelActor: text("cancel_actor"),
  }, t => [index("av2_stock_cut_recent").on(t.createdAt)]),
  warehouseWork: sqliteTable("av2_warehouse_work", {
    id: text("id").primaryKey(),
    receiptId: text("receipt_id").notNull().references(() => warehouseReceipts.id),
    productType: text("product_type").notNull(),
    norm: text("norm"),
    coefficient: text("coefficient"),
    createdAt: text("created_at").notNull(),
    actor: text("actor").notNull(),
    canceledAt: text("canceled_at"),
    cancelReason: text("cancel_reason"),
    cancelActor: text("cancel_actor"),
  }, t => [uniqueIndex("av2_warehouse_work_receipt").on(t.receiptId), index("av2_warehouse_work_recent").on(t.createdAt)]),
  labelImports: sqliteTable("av2_label_imports", {
    id: text("id").primaryKey(),
    manifest: text("manifest").notNull(),
    state: text("state").notNull(),
    createdAt: text("created_at").notNull(),
    actor: text("actor").notNull(),
  }, t => [uniqueIndex("av2_label_active").on(t.state).where(sql`${t.state} = 'active'`)]),
  labelFiles: sqliteTable("av2_label_files", {
    sha256: text("sha256").primaryKey(),
    mimeType: text("mime_type").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: text("created_at").notNull(),
  }),
  labelChunks: sqliteTable("av2_label_chunks", {
    id: text("id").primaryKey(),
    importId: text("import_id").notNull(),
    part: integer("part").notNull(),
    digest: text("digest").notNull(),
    count: integer("count").notNull(),
  }, t => [uniqueIndex("av2_label_chunk_part").on(t.importId,t.part)]),
  labelEntries: sqliteTable("av2_label_entries", {
    id: text("id").primaryKey(),
    importId: text("import_id").notNull(),
    market: text("market").notNull(),
    sku: text("sku").notNull(),
    status: text("status").notNull(),
    sha256: text("sha256"),
    data: text("data").notNull(),
  }, t => [uniqueIndex("av2_label_match").on(t.importId,t.market,t.sku),index("av2_label_image").on(t.importId,t.sha256)]),
  catalogKindOverrides: sqliteTable("av2_catalog_kind_overrides",{id:text("id").primaryKey(),market:text("market").notNull(),store:text("store").notNull(),sku:text("sku").notNull(),kind:text("kind").notNull(),reason:text("reason").notNull(),actor:text("actor").notNull(),createdAt:text("created_at").notNull()},t=>[uniqueIndex("av2_catalog_kind_scope").on(t.market,t.store,t.sku)]),
  serviceNonces: sqliteTable("av2_service_nonces", { id:text("id").primaryKey(),seenAt:integer("seen_at").notNull() }),
  shiftNorms,
  legacyRecords: sqliteTable(
    "av2_legacy_records",
    {
      kind: text("kind").notNull(),
      sourceId: text("source_id").notNull(),
      hash: text("hash").notNull(),
      data: text("data").notNull(),
      capturedAt: text("captured_at").notNull(),
    },
    (t) => [uniqueIndex("av2_legacy_record_key").on(t.kind, t.sourceId)],
  ),
  legacyRuns: sqliteTable("av2_legacy_runs", {
    id: text("id").primaryKey(),
    sourceHash: text("source_hash").notNull(),
    state: text("state").notNull(),
    report: text("report").notNull(),
    createdAt: text("created_at").notNull(),
  }),
  legacyAllocations: sqliteTable(
    "av2_legacy_allocations",
    {
      id: text("id").primaryKey(),
      cartonId: text("carton_id")
        .notNull()
        .references(() => cartons.id),
      positionId: text("position_id")
        .notNull()
        .references(() => positions.id),
      qty: integer("qty").notNull(),
      unitsPerBox: integer("units_per_box"),
      createdAt: text("created_at").notNull(),
      removedAt: text("removed_at"),
      removalReason: text("removal_reason"),
      actor: text("actor").notNull(),
    },
    (t) => [
      index("av2_legacy_allocation_carton").on(t.cartonId, t.removedAt),
      index("av2_legacy_allocation_position").on(t.positionId, t.removedAt),
    ],
  ),
  ritmWorkOutbox: sqliteTable(
    "av2_ritm_work_outbox",
    {
      id: text("id").primaryKey(),
      payload: text("payload").notNull(),
      createdAt: text("created_at").notNull(),
      deliveredAt: text("delivered_at"),
      attempts: integer("attempts").notNull().default(0),
      nextAttemptAt: integer("next_attempt_at").notNull().default(0),
      lastError: text("last_error"),
    },
    (t) => [index("av2_ritm_work_due").on(t.deliveredAt, t.nextAttemptAt)],
  ),
  warehouseCartons,
  warehouseReceipts,
  cartonNumberReservations: sqliteTable("av2_carton_number_reservations", {
    label: text("label").primaryKey(),
    source: text("source").notNull(),
  }),
  ritmLinks,
  ritmSync,
  meta,
  employees,
  supplies,
  positions,
  work,
  corrections,
  dispatches,
  cartons,
  allocations,
  exportSnapshots,
  commands,
  positionTotals,
  teamTotals,
  catalogImports,
  catalogChunks,
  catalogEntries,
  catalogAliases,
  catalogPhotos,
  printExtensions,
  catalogFiles,
  photoCache,
  catalogReferences,
  qualityRepairs,
  managerAccess,
  managerAttempts,
};
