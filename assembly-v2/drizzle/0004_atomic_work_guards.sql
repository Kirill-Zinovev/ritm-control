-- Validate mutable domain state at commit, including concurrent collectors.
-- Existing revision guard remains unchanged for manager/lifecycle commands.
CREATE TRIGGER av2_work_commit_guard BEFORE INSERT ON av2_work
BEGIN
  SELECT RAISE(ABORT,'ASSEMBLY_EMPLOYEE_INACTIVE') WHERE NOT EXISTS
    (SELECT 1 FROM av2_employees e WHERE e.id=NEW.employee_id AND e.active=1);
  SELECT RAISE(ABORT,'ASSEMBLY_POSITION_NOT_READY') WHERE NOT EXISTS
    (SELECT 1 FROM av2_positions p WHERE p.id=NEW.position_id AND p.supply_id=NEW.supply_id AND p.ready=1);
END;
--> statement-breakpoint
CREATE TRIGGER av2_allocation_commit_guard BEFORE INSERT ON av2_allocations
BEGIN
  SELECT RAISE(ABORT,'ASSEMBLY_CARTON_UNAVAILABLE') WHERE NOT EXISTS
    (SELECT 1 FROM av2_cartons c WHERE c.id=NEW.carton_id AND c.state='open' AND c.dispatch_id IS NULL);
  SELECT RAISE(ABORT,'ASSEMBLY_CARTON_SCOPE') WHERE NOT EXISTS
    (SELECT 1 FROM av2_positions p JOIN av2_supplies s ON s.id=p.supply_id JOIN av2_cartons c ON c.id=NEW.carton_id
      WHERE p.id=NEW.position_id AND c.market=s.market AND c.store=s.store AND c.destination=s.destination);
  SELECT RAISE(ABORT,'ASSEMBLY_NORM_CHANGED') WHERE NOT EXISTS
    (SELECT 1 FROM av2_positions p WHERE p.id=NEW.position_id AND p.units_per_box>0 AND p.units_per_box=NEW.units_per_box);
  SELECT RAISE(ABORT,'ASSEMBLY_STOCK_INSUFFICIENT') WHERE NOT EXISTS
    (SELECT 1 FROM av2_position_totals t WHERE t.position_id=NEW.position_id AND t.packing-t.boxed>=NEW.qty);
  SELECT RAISE(ABORT,'ASSEMBLY_CARTON_FULL') WHERE
    coalesce((SELECT sum(a.qty*1.0/a.units_per_box) FROM av2_allocations a WHERE a.carton_id=NEW.carton_id AND a.removed_at IS NULL),0)
      + NEW.qty*1.0/NEW.units_per_box > 1.000000001;
END;
