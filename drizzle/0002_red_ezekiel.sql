CREATE TABLE `ritm_manager_login_limits` (
	`username` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ritm_manager_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `ritm_manager_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ritm_manager_sessions_user` ON `ritm_manager_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `ritm_manager_sessions_expiry` ON `ritm_manager_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `ritm_manager_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`pin_salt` text NOT NULL,
	`pin_hash` text NOT NULL,
	`must_change_pin` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ritm_manager_users_username_unique` ON `ritm_manager_users` (`username`);