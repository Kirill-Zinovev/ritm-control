import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const cloudState = sqliteTable("cloud_state", { key: text("key").primaryKey(), value: text("value").notNull(), updatedAt: integer("updated_at").notNull() });
export const cloudOperations = sqliteTable("cloud_operations", { kind: text("kind").notNull(), id: text("id").notNull(), payload: text("payload").notNull(), createdAt: text("created_at").notNull(), ordinal: integer("ordinal").notNull().default(0) }, (table) => [primaryKey({ columns: [table.kind, table.id] })]);
export const cloudTransferPreviews = sqliteTable("cloud_transfer_previews", { id: text("id").primaryKey(), expiresAt: integer("expires_at").notNull(), payload: text("payload").notNull() });
export const cloudSyncEvents = sqliteTable("cloud_sync_events", { id: text("id").primaryKey(), action: text("action").notNull(), createdAt: integer("created_at").notNull(), attempts: integer("attempts").notNull().default(0), nextAttemptAt: integer("next_attempt_at").notNull(), deliveredAt: integer("delivered_at"), lastError: text("last_error"), payload: text("payload"), outcome: text("outcome"), receipt: text("receipt") }, (table) => [index("cloud_sync_due").on(table.deliveredAt, table.nextAttemptAt)]);
export const cloudLeases = sqliteTable("cloud_leases", { name: text("name").primaryKey(), owner: text("owner").notNull(), expiresAt: integer("expires_at").notNull(), fence: integer("fence").notNull() });
export const cloudAudit = sqliteTable("cloud_audit", { id: text("id").primaryKey(), at: integer("at").notNull(), type: text("type").notNull(), message: text("message").notNull(), incidentId: text("incident_id") }, (table) => [index("cloud_audit_at").on(table.at)]);
export const cloudSnapshots = sqliteTable("cloud_snapshots", { kind: text("kind").primaryKey(), generation: text("generation").notNull(), updatedAt: integer("updated_at").notNull(), chunks: integer("chunks").notNull(), digest: text("digest").notNull() });
export const cloudSnapshotChunks = sqliteTable("cloud_snapshot_chunks", { kind: text("kind").notNull(), generation: text("generation").notNull(), ordinal: integer("ordinal").notNull(), payload: text("payload").notNull() }, (table) => [primaryKey({ columns: [table.kind, table.generation, table.ordinal] })]);
export const cloudImports = sqliteTable("cloud_imports", { id: text("id").primaryKey(), sourceDigest: text("source_digest").notNull(), importedAt: integer("imported_at").notNull(), manifest: text("manifest").notNull() }, (table) => [uniqueIndex("cloud_import_digest").on(table.sourceDigest)]);
export const cloudBridgeNonces = sqliteTable("cloud_bridge_nonces", { id: text("id").primaryKey(), bridgeId: text("bridge_id").notNull(), seenAt: integer("seen_at").notNull() }, (table) => [index("cloud_bridge_nonce_expiry").on(table.seenAt)]);
export const ritmManagerUsers = sqliteTable("ritm_manager_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  pinSalt: text("pin_salt").notNull(),
  pinHash: text("pin_hash").notNull(),
  mustChangePin: integer("must_change_pin").notNull().default(1),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  createdBy: text("created_by"),
  lastLoginAt: integer("last_login_at"),
});
export const ritmManagerSessions = sqliteTable("ritm_manager_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => ritmManagerUsers.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
}, (table) => [index("ritm_manager_sessions_user").on(table.userId), index("ritm_manager_sessions_expiry").on(table.expiresAt)]);
export const ritmManagerLoginLimits = sqliteTable("ritm_manager_login_limits", {
  username: text("username").primaryKey(),
  windowStartedAt: integer("window_started_at").notNull(),
  failureCount: integer("failure_count").notNull().default(0),
  lockedUntil: integer("locked_until").notNull().default(0),
});
