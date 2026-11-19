CREATE TABLE `av2_label_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`manifest` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`actor` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_label_active` ON `av2_label_imports` (`state`) WHERE "av2_label_imports"."state" = 'active';--> statement-breakpoint
CREATE TABLE `av2_label_files` (
	`sha256` text PRIMARY KEY NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `av2_label_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`part` integer NOT NULL,
	`digest` text NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_label_chunk_part` ON `av2_label_chunks` (`import_id`,`part`);--> statement-breakpoint
CREATE TABLE `av2_label_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`market` text NOT NULL,
	`sku` text NOT NULL,
	`status` text NOT NULL,
	`sha256` text,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_label_match` ON `av2_label_entries` (`import_id`,`market`,`sku`);--> statement-breakpoint
CREATE INDEX `av2_label_image` ON `av2_label_entries` (`import_id`,`sha256`);