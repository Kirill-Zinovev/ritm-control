import ts from "typescript";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
for (const file of [
  "src/model",
  "src/demo",
  "src/importer",
  "src/csv",
  "src/supplySpreadsheet",
  "src/liveSupplyProgress",
  "src/liveSupplyMarketplace",
  "src/assemblyCoefficient",
  "tests/domain.test",
  "tests/supply-workflow.test",
  "tests/live-supply-progress.test",
  "tests/live-supply-marketplace.test",
  "tests/assembly-coefficient.test",
]) {
  mkdirSync(".checks/" + file.slice(0, file.lastIndexOf("/")), {
    recursive: true,
  });
  const source = readFileSync(file + ".ts", "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  writeFileSync(
    ".checks/" + file + ".mjs",
    result.replace(
      /from (["'])(\.[^"']+)\1/g,
      (_match, quote, path) => `from ${quote}${path}.mjs${quote}`,
    ),
  );
}
const result = spawnSync(
  process.execPath,
  [
    "--test",
    ".checks/tests/domain.test.mjs",
    ".checks/tests/supply-workflow.test.mjs",
    ".checks/tests/live-supply-progress.test.mjs",
    ".checks/tests/live-supply-marketplace.test.mjs",
    ".checks/tests/assembly-coefficient.test.mjs",
  ],
  {
    stdio: "inherit",
  },
);
process.exitCode = result.status ?? 1;
