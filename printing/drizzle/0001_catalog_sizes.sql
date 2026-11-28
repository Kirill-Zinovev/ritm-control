ALTER TABLE printing_catalog_cards ADD COLUMN size TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE printing_catalog_sync ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1;
