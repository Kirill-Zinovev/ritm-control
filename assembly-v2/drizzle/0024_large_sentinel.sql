CREATE TABLE `av2_catalog_products` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`market` text NOT NULL,
	`store` text NOT NULL,
	`sku` text NOT NULL,
	`search` text NOT NULL,
	`machine` text NOT NULL,
	`review` integer NOT NULL,
	`data` text NOT NULL,
	`revision` integer NOT NULL,
	`actor` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `av2_catalog_product_scope` ON `av2_catalog_products` (`market`,`store`,`sku`);--> statement-breakpoint
CREATE TABLE `av2_catalog_media` (
	`sha256` text PRIMARY KEY NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` text NOT NULL
);

--> statement-breakpoint
DROP VIEW av2_resolved_catalog_aliases;
--> statement-breakpoint
DROP VIEW av2_resolved_catalog_entries;
--> statement-breakpoint
CREATE VIEW av2_imported_catalog_entries AS
SELECT id,import_id,entry_id,market,store,sku,search,machine,review,data FROM av2_catalog_entries
UNION ALL
SELECT r.id,r.import_id,r.entry_id,r.market,r.store,r.sku,r.search,r.machine,r.review,r.data
FROM av2_catalog_references r
WHERE NOT EXISTS (SELECT 1 FROM av2_catalog_aliases a WHERE a.import_id=r.import_id AND a.market=r.market
AND a.alias IN (SELECT value FROM json_each(r.data,'$.aliases')));
--> statement-breakpoint
CREATE VIEW av2_resolved_catalog_entries AS
SELECT b.id,b.import_id,b.entry_id,b.market,b.store,b.sku,
coalesce(p.search,b.search) search,coalesce(p.machine,b.machine) machine,coalesce(p.review,b.review) review,coalesce(p.data,b.data) data
FROM av2_imported_catalog_entries b LEFT JOIN av2_catalog_products p ON p.entry_id=b.entry_id
UNION ALL
SELECT 'managed:'||p.entry_id,i.id,p.entry_id,p.market,p.store,p.sku,p.search,p.machine,p.review,p.data
FROM av2_catalog_products p CROSS JOIN av2_catalog_imports i
WHERE NOT EXISTS (SELECT 1 FROM av2_imported_catalog_entries b WHERE b.import_id=i.id AND b.entry_id=p.entry_id);
--> statement-breakpoint
CREATE VIEW av2_resolved_catalog_aliases AS
SELECT a.id,a.import_id,a.market,a.store,a.alias,a.entry_id,a.is_primary FROM av2_catalog_aliases a
WHERE NOT EXISTS(SELECT 1 FROM av2_catalog_products p WHERE p.entry_id=a.entry_id)
UNION ALL
SELECT r.id||':'||j.key,r.import_id,r.market,r.store,j.value,r.entry_id,(j.value=r.sku)
FROM av2_catalog_references r JOIN av2_imported_catalog_entries e ON e.id=r.id JOIN json_each(r.data,'$.aliases') j
WHERE NOT EXISTS(SELECT 1 FROM av2_catalog_products p WHERE p.entry_id=r.entry_id)
UNION ALL
SELECT 'managed:'||p.entry_id||':'||j.key,m.active_catalog_id,p.market,p.store,j.value,p.entry_id,(j.value=p.sku)
FROM av2_catalog_products p JOIN av2_meta m ON m.id=1 AND m.active_catalog_id IS NOT NULL JOIN json_each(p.data,'$.aliases') j;
