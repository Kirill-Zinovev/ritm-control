CREATE TABLE `av2_position_totals` (
	`position_id` text PRIMARY KEY NOT NULL,
	`cut` integer DEFAULT 0 NOT NULL,
	`assembly` integer DEFAULT 0 NOT NULL,
	`packing` integer DEFAULT 0 NOT NULL,
	`boxed` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`position_id`) REFERENCES `av2_positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `av2_team_totals` (
	`id` text PRIMARY KEY NOT NULL,
	`position_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`name` text NOT NULL,
	`cut` integer DEFAULT 0 NOT NULL,
	`assembly` integer DEFAULT 0 NOT NULL,
	`packing` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`position_id`) REFERENCES `av2_positions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `av2_employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_team_position_employee` ON `av2_team_totals` (`position_id`,`employee_id`);--> statement-breakpoint
ALTER TABLE `av2_work` ADD `supply_id` text REFERENCES av2_supplies(id);--> statement-breakpoint
CREATE INDEX `av2_work_supply_recent` ON `av2_work` (`supply_id`,`created_at`);