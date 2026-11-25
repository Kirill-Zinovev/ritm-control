CREATE VIEW av2_carton_merge_splits AS
SELECT entity_id id,
  json_extract("before",'$.id') parent_id,
  json_extract("before",'$.qty') previous_qty,
  json_extract("after",'$.rootId') root_id,
  json_extract("after",'$.qty') qty,
  json_extract(evidence,'$.from') source_carton_id,
  json_extract(evidence,'$.to') target_carton_id,
  json_extract(evidence,'$.legacy') legacy
FROM av2_quality_repairs WHERE kind='carton.merge.split';
--> statement-breakpoint
CREATE TRIGGER av2_allocation_merge_split BEFORE INSERT ON av2_allocations
WHEN EXISTS(SELECT 1 FROM av2_carton_merge_splits WHERE id=NEW.id AND legacy=0)
BEGIN
  SELECT RAISE(ABORT,'ASSEMBLY_INVALID_ALLOCATION') WHERE NOT EXISTS (
    SELECT 1 FROM av2_carton_merge_splits split
    JOIN av2_allocations parent ON parent.id=split.parent_id
    JOIN av2_cartons source ON source.id=parent.carton_id
    JOIN av2_cartons target ON target.id=NEW.carton_id
    JOIN av2_carton_city_scopes source_scope ON source_scope.id=source.id
    JOIN av2_carton_city_scopes target_scope ON target_scope.id=target.id
    WHERE split.id=NEW.id AND split.legacy=0
      AND split.source_carton_id=source.id AND split.target_carton_id=target.id
      AND source.id<>target.id AND source.state='open' AND target.state='open'
      AND source.dispatch_id IS NULL AND target.dispatch_id IS NULL
      AND source.market=target.market AND source.store=target.store
      AND source.store GLOB '[1-9]*' AND source.store NOT GLOB '*[^0-9]*'
      AND (source.destination=target.destination OR
        (source_scope.city_key IS NOT NULL AND source_scope.city_key=target_scope.city_key))
      AND parent.removed_at IS NULL AND NEW.removed_at IS NULL
      AND parent.position_id=NEW.position_id AND parent.units_per_box=NEW.units_per_box
      AND parent.created_at=NEW.created_at AND parent.actor=NEW.actor
      AND parent.qty=split.previous_qty AND NEW.qty=split.qty AND NEW.qty>0 AND NEW.qty<parent.qty
  );
  UPDATE av2_allocations SET qty=qty-NEW.qty
  WHERE id=(SELECT parent_id FROM av2_carton_merge_splits WHERE id=NEW.id AND legacy=0);
END;
--> statement-breakpoint
DROP TRIGGER av2_allocation_commit_guard;
--> statement-breakpoint
CREATE TRIGGER av2_allocation_commit_guard BEFORE INSERT ON av2_allocations
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
  SELECT RAISE(ABORT,'ASSEMBLY_CARTON_FULL') WHERE
    coalesce((SELECT sum(a.qty*1.0/a.units_per_box) FROM av2_allocations a WHERE a.carton_id=NEW.carton_id AND a.removed_at IS NULL),0)
      + NEW.qty*1.0/NEW.units_per_box > 1.000000001;
END;
--> statement-breakpoint
DROP TRIGGER av2_allocation_source_guard;
--> statement-breakpoint
CREATE TRIGGER av2_allocation_source_guard BEFORE INSERT ON av2_allocations
WHEN EXISTS(SELECT 1 FROM av2_positions WHERE id=NEW.position_id AND (source_active=0 OR ready=0))
  AND NOT EXISTS(SELECT 1 FROM av2_carton_merge_splits WHERE id=NEW.id AND legacy=0)
BEGIN SELECT RAISE(ABORT,'ASSEMBLY_POSITION_NOT_READY'); END;
--> statement-breakpoint
DROP TRIGGER av2_allocation_legacy_capacity_guard;
--> statement-breakpoint
CREATE TRIGGER av2_allocation_legacy_capacity_guard BEFORE INSERT ON av2_allocations
WHEN NOT EXISTS(SELECT 1 FROM av2_carton_merge_splits WHERE id=NEW.id AND legacy=0)
BEGIN
  SELECT RAISE(ABORT,'ASSEMBLY_CARTON_FULL') WHERE EXISTS(
    SELECT 1 FROM av2_legacy_allocations WHERE carton_id=NEW.carton_id AND removed_at IS NULL AND units_per_box IS NULL
  ) OR coalesce((SELECT sum(qty*1.0/units_per_box) FROM av2_all_allocations WHERE carton_id=NEW.carton_id AND removed_at IS NULL),0)
    + NEW.qty*1.0/NEW.units_per_box>1.000000001;
END;
