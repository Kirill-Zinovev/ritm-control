CREATE TABLE `av2_catalog_kind_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`market` text NOT NULL,
	`store` text NOT NULL,
	`sku` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_catalog_kind_scope` ON `av2_catalog_kind_overrides` (`market`,`store`,`sku`);