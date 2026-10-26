import test from "node:test";
import assert from "node:assert/strict";
import { repairReadback, repairStatusMessage } from "../src/repairResult.ts";

test("repair UI renders pre-write refusal and queue waiting without pretending there is readback", () => {
  for (const result of [
    null,
    undefined,
    {},
    {
      at: "2026-10-13T06:16:31Z",
      errorCode: "repair_operation_conflict",
      message: "Другая операция выполняется",
    },
    {
      at: "2026-10-13T06:16:31Z",
      phase: "waiting_before_write",
      message: "В очереди",
    },
    { after: { cell: {} } },
  ])
    assert.equal(repairReadback(result), null);
});

test("repair UI preserves verified readback and failed postcheck readback", () => {
  const after = {
    cell: { formulaValue: "=C11/D11" },
    effective: { numberValue: 0 },
  };
  assert.equal(repairReadback({ at: "now", after }), after);
  assert.equal(
    repairReadback({ at: "now", after, errorCode: "postcheck_unavailable" }),
    after,
  );
});

test("pre-write queue conflict is clearly stopped and never presented as running", () => {
  const message = repairStatusMessage(
    {
      at: "2026-10-13T06:16:31Z",
      errorCode: "repair_operation_conflict",
      message: "Выполняется восстановление исходных данных; исправление формулы не запущено.",
    },
    "M315",
  );
  assert.match(message, /M315/);
  assert.match(message, /остановлена до записи/);
  assert.match(message, /Таблица не менялась/);
  assert.doesNotMatch(message, /Выполняется восстановление/);
});
