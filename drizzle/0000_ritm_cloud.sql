CREATE TABLE `cloud_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`incident_id` text
);
--> statement-breakpoint
CREATE INDEX `cloud_audit_at` ON `cloud_audit` (`at`);--> statement-breakpoint
CREATE TABLE `cloud_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`source_digest` text NOT NULL,
	`imported_at` integer NOT NULL,
	`manifest` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_import_digest` ON `cloud_imports` (`source_digest`);--> statement-breakpoint
CREATE TABLE `cloud_leases` (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL,
	`fence` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloud_operations` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
CREATE TABLE `cloud_snapshot_chunks` (
	`kind` text NOT NULL,
	`generation` text NOT NULL,
	`ordinal` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`kind`, `generation`, `ordinal`)
);
--> statement-breakpoint
CREATE TABLE `cloud_snapshots` (
	`kind` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`updated_at` integer NOT NULL,
	`chunks` integer NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloud_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloud_sync_events` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`delivered_at` integer,
	`last_error` text,
	`payload` text,
	`outcome` text,
	`receipt` text
);
--> statement-breakpoint
CREATE INDEX `cloud_sync_due` ON `cloud_sync_events` (`delivered_at`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `cloud_transfer_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`payload` text NOT NULL
);
