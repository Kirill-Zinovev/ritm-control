CREATE TABLE `av2_warehouse_work` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`product_type` text NOT NULL,
	`norm` text,
	`coefficient` text,
	`created_at` text NOT NULL,
	`actor` text NOT NULL,
	`canceled_at` text,
	`cancel_reason` text,
	`cancel_actor` text,
	FOREIGN KEY (`receipt_id`) REFERENCES `av2_warehouse_receipts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_warehouse_work_receipt` ON `av2_warehouse_work` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `av2_warehouse_work_recent` ON `av2_warehouse_work` (`created_at`);--> statement-breakpoint
ALTER TABLE `av2_warehouse_receipts` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `av2_warehouse_receipts` ADD `void_reason` text;