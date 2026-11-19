CREATE TABLE `av2_source_photos` (
	`position_id` text PRIMARY KEY NOT NULL,
	`shipment_id` text NOT NULL,
	`sku` text NOT NULL,
	`url` text NOT NULL,
	`source_revision` integer NOT NULL
);
