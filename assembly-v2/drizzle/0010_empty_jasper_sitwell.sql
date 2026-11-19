CREATE TABLE `av2_warehouse_cartons` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`market` text NOT NULL,
	`store` text NOT NULL,
	`state` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_warehouse_cartons_label_unique` ON `av2_warehouse_cartons` (`label`);--> statement-breakpoint
CREATE INDEX `av2_warehouse_current` ON `av2_warehouse_cartons` (`market`,`store`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `av2_warehouse_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`carton_id` text NOT NULL,
	`position_id` text,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`search` text NOT NULL,
	`qty` integer NOT NULL,
	`catalog_import_id` text,
	`photo_id` text,
	`employee_id` text NOT NULL,
	`employee` text NOT NULL,
	`supply` text NOT NULL,
	`comment` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`carton_id`) REFERENCES `av2_warehouse_cartons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`position_id`) REFERENCES `av2_positions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `av2_employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `av2_warehouse_receipt_carton` ON `av2_warehouse_receipts` (`carton_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `av2_warehouse_receipt_position` ON `av2_warehouse_receipts` (`position_id`);