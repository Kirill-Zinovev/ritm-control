import test from "node:test";
import assert from "node:assert/strict";
import { supplyMarketplace } from "../src/liveSupplyMarketplace";

test("supply marketplace is inferred from a delimited marketplace name", () => {
  assert.equal(supplyMarketplace("WB тестовая"), "WB");
  assert.equal(supplyMarketplace("OZON МОСКВА 10_10"), "Ozon");
  assert.equal(supplyMarketplace("Wildberries Казань"), "WB");
});

test("unknown or conflicting supply names do not get a guessed marketplace", () => {
  assert.equal(supplyMarketplace("Поставка тестовая"), null);
  assert.equal(supplyMarketplace("WB OZON тестовая"), null);
  assert.equal(supplyMarketplace("SUPERWB поставка"), null);
});
