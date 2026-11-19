CREATE TRIGGER av2_command_revision_guard BEFORE INSERT ON av2_commands
WHEN NEW.expected_revision <> coalesce((SELECT revision FROM av2_meta WHERE id=1),0)
BEGIN SELECT RAISE(ABORT,'ASSEMBLY_REVISION_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER av2_work_quantity BEFORE INSERT ON av2_work
WHEN NEW.qty <= 0 OR NEW.operation NOT IN ('cut','assembly','packing')
BEGIN SELECT RAISE(ABORT,'ASSEMBLY_INVALID_WORK'); END;
--> statement-breakpoint
CREATE TRIGGER av2_allocation_quantity BEFORE INSERT ON av2_allocations
WHEN NEW.qty <= 0 OR NEW.units_per_box <= 0
BEGIN SELECT RAISE(ABORT,'ASSEMBLY_INVALID_ALLOCATION'); END;
--> statement-breakpoint
CREATE TRIGGER av2_export_immutable_update BEFORE UPDATE ON av2_exports
BEGIN SELECT RAISE(ABORT,'ASSEMBLY_IMMUTABLE_EXPORT'); END;
--> statement-breakpoint
CREATE TRIGGER av2_export_immutable_delete BEFORE DELETE ON av2_exports
BEGIN SELECT RAISE(ABORT,'ASSEMBLY_IMMUTABLE_EXPORT'); END;
