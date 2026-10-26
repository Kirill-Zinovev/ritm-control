CREATE TABLE `cloud_bridge_nonces` (
	`id` text PRIMARY KEY NOT NULL,
	`bridge_id` text NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cloud_bridge_nonce_expiry` ON `cloud_bridge_nonces` (`seen_at`);