import { mkdir } from "node:fs/promises";
import { openDatabase } from "../server/local-db";
import { bootstrap } from "../tests/fixtures";
import type { Snapshot } from "../shared/model";
await mkdir(".local", { recursive: true });
const db = await openDatabase(".local/assembly-preview.sqlite");
const initial = (await db.snapshot(null)) as Snapshot;
if (!initial.supplies.length) {
  const f = await bootstrap(db);
  const other = f.state.employees.find((e) => e.id !== f.employee.id)!;
  await f.cmd("work.save", {
    positionId: f.a.id,
    employeeId: f.employee.id,
    operation: "cut",
    qty: 350,
  });
  await f.cmd("work.save", {
    positionId: f.a.id,
    employeeId: other.id,
    operation: "packing",
    qty: 250,
  });
  for (let i = 0; i < 2; i++) {
    const r = await f.cmd("carton.create", { supplyId: f.supply.id });
    await f.cmd("allocation.add", {
      positionId: f.a.id,
      cartonId: r.cartonId,
      qty: 100,
    });
    if (i === 0) {
      const state = (await db.snapshot(f.supply.id)) as Snapshot;
      const b = state.cartons.find((b) => b.id === r.cartonId)!;
      await f.cmd("carton.close", {
        cartonId: b.id,
        items: b.items
          .map((i) => ({ id: i.id, qty: i.qty }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      });
    }
  }
  await f.cmd("work.save", {
    positionId: f.b.id,
    employeeId: f.employee.id,
    operation: "assembly",
    qty: 240,
  });
  await f.cmd("work.save", {
    positionId: f.b.id,
    employeeId: other.id,
    operation: "packing",
    qty: 120,
  });
  const r = await f.cmd("carton.create", { supplyId: f.supply.id });
  await f.cmd("allocation.add", {
    positionId: f.b.id,
    cartonId: r.cartonId,
    qty: 100,
  });
  process.stdout.write(
    "Локальная тестовая поставка создана. Рабочие данные не используются.\n",
  );
} else
  process.stdout.write(
    "Локальная база уже содержит данные; ничего не изменено.\n",
  );
db.sqlite.close();
