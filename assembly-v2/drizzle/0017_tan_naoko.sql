CREATE TABLE `av2_catalog_references` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`source_entry_id` text NOT NULL,
	`market` text NOT NULL,
	`store` text NOT NULL,
	`sku` text NOT NULL,
	`search` text NOT NULL,
	`machine` text NOT NULL,
	`review` integer NOT NULL,
	`data` text NOT NULL,
	`evidence` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `av2_catalog_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_catalog_reference_version` ON `av2_catalog_references` (`import_id`,`entry_id`);--> statement-breakpoint
CREATE TABLE `av2_quality_repairs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`evidence` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `av2_quality_repair_entity` ON `av2_quality_repairs` (`kind`,`entity_id`);--> statement-breakpoint
ALTER TABLE `av2_supplies` ADD `is_demo` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE VIEW av2_resolved_catalog_entries AS
SELECT id,import_id,entry_id,market,store,sku,search,machine,review,data FROM av2_catalog_entries
UNION ALL
SELECT r.id,r.import_id,r.entry_id,r.market,r.store,r.sku,r.search,r.machine,r.review,r.data
FROM av2_catalog_references r
WHERE NOT EXISTS (
 SELECT 1 FROM av2_catalog_aliases a
 WHERE a.import_id=r.import_id AND a.market=r.market
 AND a.alias IN (SELECT value FROM json_each(r.data,'$.aliases'))
);
--> statement-breakpoint
CREATE VIEW av2_resolved_catalog_aliases AS
SELECT id,import_id,market,store,alias,entry_id,is_primary FROM av2_catalog_aliases
UNION ALL
SELECT r.id||':'||j.key,r.import_id,r.market,r.store,j.value,r.entry_id,(j.value=r.sku)
FROM av2_catalog_references r
JOIN av2_resolved_catalog_entries e ON e.id=r.id
JOIN json_each(r.data,'$.aliases') j;
--> statement-breakpoint
CREATE VIEW av2_production_cartons AS
SELECT c.* FROM av2_cartons c
WHERE NOT EXISTS (
 SELECT 1 FROM av2_supplies s WHERE s.is_demo=1
 AND s.market=c.market AND s.store=c.store AND s.destination=c.destination
)
AND NOT EXISTS (
 SELECT 1 FROM av2_quality_repairs r WHERE r.kind='carton.test' AND r.entity_id=c.id
);
--> statement-breakpoint
CREATE TRIGGER av2_quality_audit_immutable_update BEFORE UPDATE ON av2_quality_repairs
BEGIN SELECT RAISE(ABORT,'ASSEMBLY_IMMUTABLE_REPAIR'); END;
--> statement-breakpoint
CREATE TRIGGER av2_quality_audit_immutable_delete BEFORE DELETE ON av2_quality_repairs
BEGIN SELECT RAISE(ABORT,'ASSEMBLY_IMMUTABLE_REPAIR'); END;
