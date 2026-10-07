import ts from "typescript";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
for (const file of [
  "src/model",
  "src/demo",
  "src/importer",
  "src/csv",
  "tests/domain.test",
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
  ["--test", ".checks/tests/domain.test.mjs"],
  {
    stdio: "inherit",
  },
);
process.exitCode = result.status ?? 1;
