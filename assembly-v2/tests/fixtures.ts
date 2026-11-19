import type { Snapshot, SupplyImport } from "../shared/model";
import type { Database } from "../server/api";
export const fixture: SupplyImport = {
  externalId: "TEST-RITM-ROLL-01",
  title: "ТЕСТ · Москва · Магазин 1",
  market: "OZON",
  store: "1",
  destination: "Тестовый склад Москва",
  sourceVersion: 1,
  positions: [
    {
      externalId: "TEST-RITM-ROLL-01|uid:roll-1|DEMO-101",
      sku: "ДЕМО-101",
      name: "Наклейки на контейнеры · А5",
      barcode: "0012345678901",
      department: "Рулонная печать",
      plan: 500,
      unitsPerBox: 100,
      ready: true,
      cutOperation: "cut",
    },
    {
      externalId: "TEST-RITM-ROLL-01|uid:box-1|DEMO-102",
      sku: "ДЕМО-102",
      name: "Набор декоративных наклеек",
      barcode: "0012345678902",
      department: "Бокс",
      plan: 240,
      unitsPerBox: 200,
      ready: true,
      cutOperation: "assembly",
    },
    {
      externalId: "TEST-RITM-ROLL-01|uid:box-2|DEMO-103",
      sku: "ДЕМО-103",
      name: "Этикетки для органайзеров",
      barcode: "0012345678903",
      department: "Бокс",
      plan: 180,
      unitsPerBox: null,
      ready: false,
      cutOperation: "assembly",
    },
  ],
};
export async function bootstrap(db: Database) {
  const cmd = (
    action: string,
    payload: Record<string, unknown>,
    key = crypto.randomUUID(),
  ) => db.command(action, payload, key, "test-owner");
  await cmd("employee.create", { name: "Тест: Иван" });
  await cmd("employee.create", { name: "Тест: Ольга" });
  await cmd("supply.import", fixture as unknown as Record<string, unknown>);
  const state = (await db.snapshot(null)) as Snapshot;
  return {
    cmd,
    state,
    supply: state.supplies[0],
    a: state.positions[0],
    b: state.positions[1],
    employee: state.employees[0],
  };
}
