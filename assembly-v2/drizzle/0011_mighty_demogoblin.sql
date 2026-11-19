CREATE TABLE `av2_legacy_records` (
	`kind` text NOT NULL,
	`source_id` text NOT NULL,
	`hash` text NOT NULL,
	`data` text NOT NULL,
	`captured_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_legacy_record_key` ON `av2_legacy_records` (`kind`,`source_id`);--> statement-breakpoint
CREATE TABLE `av2_legacy_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_hash` text NOT NULL,
	`state` text NOT NULL,
	`report` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `av2_legacy_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`carton_id` text NOT NULL,
	`position_id` text NOT NULL,
	`qty` integer NOT NULL,
	`units_per_box` integer,
	`created_at` text NOT NULL,
	`removed_at` text,
	`removal_reason` text,
	`actor` text NOT NULL,
	FOREIGN KEY (`carton_id`) REFERENCES `av2_cartons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`position_id`) REFERENCES `av2_positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `av2_legacy_allocation_carton` ON `av2_legacy_allocations` (`carton_id`,`removed_at`);--> statement-breakpoint
CREATE INDEX `av2_legacy_allocation_position` ON `av2_legacy_allocations` (`position_id`,`removed_at`);--> statement-breakpoint
CREATE TABLE `av2_ritm_work_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `av2_ritm_work_due` ON `av2_ritm_work_outbox` (`delivered_at`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `av2_work` ADD `legacy_event_id` text;--> statement-breakpoint
ALTER TABLE `av2_work` ADD `norm` text;--> statement-breakpoint
ALTER TABLE `av2_work` ADD `coefficient` text;
--> statement-breakpoint
CREATE VIEW av2_all_allocations AS
SELECT id,carton_id,position_id,qty,units_per_box,created_at,removed_at,removal_reason,actor,0 legacy FROM av2_allocations
UNION ALL SELECT id,carton_id,position_id,qty,units_per_box,created_at,removed_at,removal_reason,actor,1 legacy FROM av2_legacy_allocations;
--> statement-breakpoint
CREATE TRIGGER av2_allocation_legacy_capacity_guard BEFORE INSERT ON av2_allocations
BEGIN
 SELECT RAISE(ABORT,'ASSEMBLY_CARTON_FULL') WHERE EXISTS(SELECT 1 FROM av2_legacy_allocations WHERE carton_id=NEW.carton_id AND removed_at IS NULL AND units_per_box IS NULL)
 OR coalesce((SELECT sum(qty*1.0/units_per_box) FROM av2_all_allocations WHERE carton_id=NEW.carton_id AND removed_at IS NULL),0)+NEW.qty*1.0/NEW.units_per_box>1.000000001;
END;
