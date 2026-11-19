CREATE TABLE `ritm_warehouse_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	`carton_count` integer NOT NULL,
	`quantity` integer NOT NULL,
	`payload` text NOT NULL
);
