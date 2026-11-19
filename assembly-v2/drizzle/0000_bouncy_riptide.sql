CREATE TABLE `av2_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `av2_employees` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `av2_supplies` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`market` text NOT NULL,
	`store` text NOT NULL,
	`destination` text NOT NULL,
	`source_version` integer NOT NULL,
	`source_payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_supplies_external_id_unique` ON `av2_supplies` (`external_id`);--> statement-breakpoint
CREATE TABLE `av2_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`supply_id` text NOT NULL,
	`external_id` text NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`barcode` text NOT NULL,
	`department` text NOT NULL,
	`plan` integer NOT NULL,
	`units_per_box` integer,
	`ready` integer NOT NULL,
	`cut_operation` text NOT NULL,
	FOREIGN KEY (`supply_id`) REFERENCES `av2_supplies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_position_source` ON `av2_positions` (`supply_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `av2_positions_supply` ON `av2_positions` (`supply_id`);--> statement-breakpoint
CREATE TABLE `av2_work` (
	`id` text PRIMARY KEY NOT NULL,
	`position_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`employee_name` text NOT NULL,
	`operation` text NOT NULL,
	`qty` integer NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`position_id`) REFERENCES `av2_positions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `av2_employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `av2_work_position` ON `av2_work` (`position_id`,`operation`);--> statement-breakpoint
CREATE INDEX `av2_work_recent` ON `av2_work` (`created_at`);--> statement-breakpoint
CREATE TABLE `av2_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_id`) REFERENCES `av2_work`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_corrections_work_id_unique` ON `av2_corrections` (`work_id`);--> statement-breakpoint
CREATE TABLE `av2_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`market` text NOT NULL,
	`store` text NOT NULL,
	`destination` text NOT NULL,
	`state` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE TABLE `av2_cartons` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`market` text NOT NULL,
	`store` text NOT NULL,
	`destination` text NOT NULL,
	`state` text NOT NULL,
	`dispatch_id` text,
	`created_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`dispatch_id`) REFERENCES `av2_dispatches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `av2_cartons_current` ON `av2_cartons` (`dispatch_id`,`state`);--> statement-breakpoint
CREATE TABLE `av2_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`carton_id` text NOT NULL,
	`position_id` text NOT NULL,
	`qty` integer NOT NULL,
	`units_per_box` integer NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text,
	`removal_reason` text,
	`actor` text NOT NULL,
	FOREIGN KEY (`carton_id`) REFERENCES `av2_cartons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`position_id`) REFERENCES `av2_positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `av2_allocations_position` ON `av2_allocations` (`position_id`,`removed_at`);--> statement-breakpoint
CREATE INDEX `av2_allocations_carton` ON `av2_allocations` (`carton_id`,`removed_at`);--> statement-breakpoint
CREATE TABLE `av2_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`dispatch_id`) REFERENCES `av2_dispatches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `av2_exports_created` ON `av2_exports` (`created_at`);--> statement-breakpoint
CREATE TABLE `av2_commands` (
	`key` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`payload` text NOT NULL,
	`result` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
