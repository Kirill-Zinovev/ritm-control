CREATE TABLE `av2_ritm_links` (
	`shipment_id` text PRIMARY KEY NOT NULL,
	`source_revision` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`payload` text NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `av2_ritm_sync` (
	`id` integer PRIMARY KEY NOT NULL,
	`checked_at` integer DEFAULT 0 NOT NULL,
	`source_revision` integer DEFAULT 0 NOT NULL,
	`source_at` text,
	`status` text DEFAULT 'waiting' NOT NULL,
	`report` text DEFAULT '{}' NOT NULL,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `av2_supplies` ADD `origin_shipment_id` text;--> statement-breakpoint
ALTER TABLE `av2_supplies` ADD `source_active` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `av2_positions` ADD `source_active` integer DEFAULT 1 NOT NULL;