import assert from "node:assert/strict";
import test from "node:test";
import type { LiveOrder } from "../src/livePrinting";
import {
  diagnoseArkadySupply,
  parseArkadyIntent,
} from "../src/arkadyAssistantData";

function position(fields: Partial<LiveOrder> = {}): LiveOrder {
  return {
    uid: "production-17",
    sheetId: 43,
    sheetName: "OZON Ярославль",
    sourceId: "roll-printing",
    row: 17,
    article: "PT0001.A0277",
    shop: "1",
    quantity: 15,
    plannedArea: 0,
    ...fields,
  };
}

test("Arkady distinguishes confirmed zero print from an unknown plan or amount", () => {
  const [waiting] = diagnoseArkadySupply([position({ printProgress: 0 })]);
  assert.equal(waiting.kind, "wait-for-print");
  assert.equal(waiting.detail, "Напечатано 0 из 15 шт.");
  assert.equal(waiting.remaining, 15);
  assert.deepEqual(waiting.position, {
    uid: "production-17",
    article: "PT0001.A0277",
    sheetId: 43,
    row: 17,
    sourceId: "roll-printing",
    store: "1",
  });
  const [unknown] = diagnoseArkadySupply([position()]);
  assert.equal(unknown.kind, "unknown-print");
  assert.equal(unknown.remaining, undefined);
  assert.equal(
    diagnoseArkadySupply([
      position({ quantity: 0, printProgress: 0, cutProgress: 0 }),
    ])[0].kind,
    "unknown-print",
  );
  assert.equal(
    diagnoseArkadySupply([position({ printProgress: 0, cutProgress: 3 })])[0]
      .kind,
    "unknown-print",
  );
});

test("Arkady uses established printing units and checks cutting separately", () => {
  const box = position({
    sourceId: "box-printing",
    machine: "XEROX",
    planningPrinted: 30,
    planningPhysicalUnits: true,
    sheetsInProduct: 4,
    multiplicity: 2,
  });
  assert.equal(diagnoseArkadySupply([box])[0].kind, "unknown-cut");
  const [cutting] = diagnoseArkadySupply([{ ...box, cutProgress: 9 }]);
  assert.equal(cutting.kind, "cutting");
  assert.equal(cutting.remaining, 6);
  assert.equal(
    diagnoseArkadySupply([position({ remainingPrint: 5 })])[0].remaining,
    5,
  );
});

test("an assembly lock explains pending packing and cannot invalidate confirmed completion", () => {
  const finishedPrinting = position({ printProgress: 15, cutProgress: 15 });
  assert.deepEqual(
    diagnoseArkadySupply([{ ...finishedPrinting, packed: 7 }], {
      lock: "closed",
    }).map((reason) => reason.kind),
    ["assembly-closed", "packing"],
  );
  assert.equal(
    diagnoseArkadySupply([{ ...finishedPrinting, packed: 15 }], {
      lock: "closed",
    })[0].kind,
    "complete",
  );
  assert.equal(
    diagnoseArkadySupply([{ ...finishedPrinting, packedConfirmed: 15 }])[0]
      .kind,
    "complete",
  );
  assert.equal(
    diagnoseArkadySupply([{ ...finishedPrinting, packedConfirmed: 7 }])[0]
      .remaining,
    undefined,
  );
  assert.equal(
    diagnoseArkadySupply([{ ...finishedPrinting, packed: 15 }], {
      packingAvailable: false,
    })[0].kind,
    "unknown-packing",
  );
});

test("a cached or partial composition cannot tell Arkady a shipment is complete", () => {
  const done = position({ printProgress: 15, cutProgress: 15, packed: 15 });
  assert.equal(diagnoseArkadySupply([done], { stale: true })[0].kind, "stale");
  assert.equal(
    diagnoseArkadySupply([done], { missingPositions: 2 })[0].kind,
    "missing-positions",
  );
  assert.equal(diagnoseArkadySupply([])[0].kind, "empty");
});

test("catalog diagnostics preserve a real issue and cannot assume an ambiguous store", () => {
  const reasons = diagnoseArkadySupply([
    position({
      printProgress: 0,
      machineIssue: "В каталоге указаны разные станки",
      shopCatalogStatus: "ambiguous",
    }),
  ]);
  assert.deepEqual(
    reasons.map((reason) => reason.kind),
    ["wait-for-print", "catalog-machine"],
  );
  assert.equal(reasons[1].detail, "В каталоге указаны разные станки");
  assert.equal(reasons[1].position?.store, undefined);
});

test("Arkady interprets known requests and only prepares exact supported catalog edits", () => {
  assert.deepEqual(
    parseArkadyIntent(
      "Аркадий, создай карточку WB QA0001.A0277, магазин 2, штрихкод 0460123456789",
    ),
    {
      type: "catalog-draft",
      market: "WB",
      article: "QA0001.A0277",
      store: "2",
      barcode: "0460123456789",
    },
  );
  assert.deepEqual(
    parseArkadyIntent("Аркадий, не создай карточку WB 0460123456789"),
    { type: "unsupported" },
  );
  assert.deepEqual(
    parseArkadyIntent("Создай карточку WB 0460123456789 или 0870123456789"),
    { type: "unsupported" },
  );
  assert.deepEqual(parseArkadyIntent("Подготовь черновик поставки"), {
    type: "supply-draft",
  });
  assert.deepEqual(parseArkadyIntent("Аркадий, что срочно?"), {
    type: "attention",
  });
  assert.deepEqual(parseArkadyIntent("Почему не напечатали pt0001.a0277?"), {
    type: "diagnosis",
    article: "PT0001.A0277",
  });
  assert.deepEqual(parseArkadyIntent("Проверь зависшую операцию"), {
    type: "operations",
  });
  assert.deepEqual(parseArkadyIntent("Дай сводку поставки"), {
    type: "summary",
  });
  assert.deepEqual(parseArkadyIntent("Покажи срок упаковки"), {
    type: "deadlines",
  });
  assert.deepEqual(parseArkadyIntent("Как округлить PT0001.A0277?"), {
    type: "routing",
    article: "PT0001.A0277",
  });
  assert.deepEqual(parseArkadyIntent("Почему зависла печать?"), {
    type: "diagnosis",
    article: undefined,
  });
  assert.deepEqual(parseArkadyIntent("Поставь для pt0001.a0277 кратность 10"), {
    type: "catalog",
    article: "PT0001.A0277",
    field: "multiplicity",
    value: "10",
  });
  assert.deepEqual(parseArkadyIntent("Поставь кратность 10 для pt0001.a0277"), {
    type: "catalog",
    article: "PT0001.A0277",
    field: "multiplicity",
    value: "10",
  });
  assert.deepEqual(parseArkadyIntent("Укажи станок 2-GO"), {
    type: "catalog",
    article: undefined,
    field: "machine",
    value: "2-GO",
  });
  assert.deepEqual(parseArkadyIntent("Какой станок у PT0001.A0277?"), {
    type: "catalog",
    article: "PT0001.A0277",
    field: "machine",
  });
  assert.deepEqual(
    parseArkadyIntent("Удали PT0001.A0277 и запиши в справочник"),
    { type: "unsupported" },
  );
  assert.deepEqual(
    parseArkadyIntent("Укажи PT0001.A0277 и KS0006.A7366 кратность 10"),
    { type: "unsupported" },
  );
});
