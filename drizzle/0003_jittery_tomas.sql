CREATE TABLE `assembly_v2_supply_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`shipment_id` text,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`delivered_at` integer,
	`last_error` text,
	`receipt` text
);
--> statement-breakpoint
CREATE INDEX `assembly_v2_supply_due` ON `assembly_v2_supply_deliveries` (`delivered_at`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `assembly_v2_work_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`event_id` text NOT NULL,
	`payload` text NOT NULL,
	`hash` text NOT NULL,
	`received_at` integer NOT NULL
);

--> statement-breakpoint
CREATE TRIGGER assembly_v2_event_immutable BEFORE UPDATE ON assembly_v2_work_events
WHEN OLD.hash<>NEW.hash OR OLD.id<>NEW.id OR OLD.kind<>NEW.kind OR OLD.event_id<>NEW.event_id
BEGIN SELECT RAISE(ABORT,'ASSEMBLY_V2_EVENT_CONFLICT'); END;
