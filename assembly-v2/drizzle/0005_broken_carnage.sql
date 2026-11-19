CREATE TABLE `av2_catalog_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`manifest` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`actor` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `av2_catalog_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`kind` text NOT NULL,
	`part` integer NOT NULL,
	`digest` text NOT NULL,
	`count` integer NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `av2_catalog_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `av2_catalog_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`market` text NOT NULL,
	`store` text NOT NULL,
	`sku` text NOT NULL,
	`search` text NOT NULL,
	`machine` text NOT NULL,
	`review` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `av2_catalog_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_catalog_entry_version` ON `av2_catalog_entries` (`import_id`,`entry_id`);--> statement-breakpoint
CREATE INDEX `av2_catalog_filter` ON `av2_catalog_entries` (`import_id`,`market`,`store`,`sku`);--> statement-breakpoint
CREATE INDEX `av2_catalog_machine` ON `av2_catalog_entries` (`import_id`,`machine`);--> statement-breakpoint
CREATE TABLE `av2_catalog_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`market` text NOT NULL,
	`store` text NOT NULL,
	`alias` text NOT NULL,
	`entry_id` text NOT NULL,
	`is_primary` integer NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `av2_catalog_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `av2_catalog_alias_lookup` ON `av2_catalog_aliases` (`import_id`,`market`,`store`,`alias`);--> statement-breakpoint
CREATE TABLE `av2_catalog_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `av2_catalog_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_catalog_photo_version` ON `av2_catalog_photos` (`import_id`,`photo_id`);--> statement-breakpoint
CREATE TABLE `av2_catalog_files` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`role` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `av2_catalog_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `av2_photo_cache` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE `av2_meta` ADD `active_catalog_id` text;--> statement-breakpoint
ALTER TABLE `av2_positions` ADD `catalog_import_id` text;--> statement-breakpoint
ALTER TABLE `av2_positions` ADD `catalog_entry_id` text;