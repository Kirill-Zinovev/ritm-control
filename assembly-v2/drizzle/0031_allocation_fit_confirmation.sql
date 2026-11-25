-- Install both replacements before retiring the previous guards.
CREATE TRIGGER av2_allocation_placement_guard BEFORE INSERT ON av2_allocations
WHEN NOT EXISTS(SELECT 1 FROM av2_carton_merge_splits WHERE id=NEW.id AND legacy=0)
BEGIN
  SELECT RAISE(ABORT,'ASSEMBLY_CARTON_UNAVAILABLE') WHERE NOT EXISTS
    (SELECT 1 FROM av2_cartons c WHERE c.id=NEW.carton_id AND c.state='open' AND c.dispatch_id IS NULL);
  SELECT RAISE(ABORT,'ASSEMBLY_CARTON_SCOPE') WHERE NOT EXISTS
    (SELECT 1 FROM av2_positions p JOIN av2_supply_city_scopes s ON s.id=p.supply_id JOIN av2_carton_city_scopes c ON c.id=NEW.carton_id
      WHERE p.id=NEW.position_id AND c.market=s.market AND c.store=s.store AND (c.destination=s.destination OR
    (s.store GLOB '[1-9]*' AND s.store NOT GLOB '*[^0-9]*' AND c.city_key IS NOT NULL AND c.city_key=s.city_key)));
  SELECT RAISE(ABORT,'ASSEMBLY_NORM_CHANGED') WHERE NOT EXISTS
    (SELECT 1 FROM av2_positions p WHERE p.id=NEW.position_id AND p.units_per_box>0 AND p.units_per_box=NEW.units_per_box);
  SELECT RAISE(ABORT,'ASSEMBLY_STOCK_INSUFFICIENT') WHERE NOT EXISTS
    (SELECT 1 FROM av2_position_totals t WHERE t.position_id=NEW.position_id AND t.packing-t.boxed>=NEW.qty);
END;
--> statement-breakpoint
CREATE TRIGGER av2_allocation_capacity_guard BEFORE INSERT ON av2_allocations
WHEN NOT EXISTS(SELECT 1 FROM av2_carton_merge_splits WHERE id=NEW.id AND legacy=0)
BEGIN
  SELECT RAISE(ABORT,'ASSEMBLY_CARTON_FULL') WHERE EXISTS(
    SELECT 1 FROM av2_legacy_allocations WHERE carton_id=NEW.carton_id AND removed_at IS NULL AND units_per_box IS NULL
  ) OR (
    coalesce((SELECT sum(qty*1.0/units_per_box) FROM av2_all_allocations WHERE carton_id=NEW.carton_id AND removed_at IS NULL),0)
      + NEW.qty*1.0/NEW.units_per_box>1.000000001
    AND NOT EXISTS(
      SELECT 1 FROM av2_quality_repairs r WHERE r.kind='allocation.fit-confirmed' AND r.entity_id=NEW.id
        AND r.actor=NEW.actor AND r.created_at=NEW.created_at
        AND json_extract(r."after",'$.cartonId')=NEW.carton_id AND json_extract(r."after",'$.positionId')=NEW.position_id
        AND json_extract(r."after",'$.qty')=NEW.qty AND json_extract(r."after",'$.unitsPerBox')=NEW.units_per_box
    )
  );
END;
--> statement-breakpoint
DROP TRIGGER av2_allocation_commit_guard;
--> statement-breakpoint
DROP TRIGGER av2_allocation_legacy_capacity_guard;
