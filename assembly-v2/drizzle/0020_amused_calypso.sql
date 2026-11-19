CREATE TABLE `av2_stock_cut_work` (
	`id` text PRIMARY KEY NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`store` text NOT NULL,
	`employee_id` text NOT NULL,
	`employee` text NOT NULL,
	`operation` text NOT NULL,
	`qty` integer NOT NULL,
	`catalog_import_id` text NOT NULL,
	`product_type` text NOT NULL,
	`norm` text,
	`coefficient` text,
	`created_at` text NOT NULL,
	`actor` text NOT NULL,
	`canceled_at` text,
	`cancel_reason` text,
	`cancel_actor` text,
	FOREIGN KEY (`employee_id`) REFERENCES `av2_employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `av2_stock_cut_recent` ON `av2_stock_cut_work` (`created_at`);