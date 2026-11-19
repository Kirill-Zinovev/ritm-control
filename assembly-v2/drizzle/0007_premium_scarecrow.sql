ALTER TABLE `av2_ritm_links` ADD `issues` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER av2_work_source_guard BEFORE INSERT ON av2_work
WHEN coalesce((SELECT source_active FROM av2_positions WHERE id=NEW.position_id),0)=0
BEGIN SELECT RAISE(ABORT,'ASSEMBLY_POSITION_NOT_READY'); END;
--> statement-breakpoint
CREATE TRIGGER av2_allocation_source_guard BEFORE INSERT ON av2_allocations
WHEN EXISTS(SELECT 1 FROM av2_positions WHERE id=NEW.position_id AND (source_active=0 OR ready=0))
BEGIN SELECT RAISE(ABORT,'ASSEMBLY_POSITION_NOT_READY'); END;
