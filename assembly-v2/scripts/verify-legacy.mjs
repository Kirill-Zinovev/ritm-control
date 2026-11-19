import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const baseline = JSON.parse(
  (await readFile("legacy-baseline.json", "utf8")).replace(/^\uFEFF/, ""),
);
for (const row of baseline) {
  const current = createHash("sha256")
    .update(await readFile(row.Path))
    .digest("hex")
    .toUpperCase();
  if (current !== row.Hash)
    throw new Error(`Рабочий файл изменился: ${row.Path}`);
}
process.stdout.write(
  `Рабочая версия: ${baseline.length} контрольных файлов не изменены.\n`,
);
