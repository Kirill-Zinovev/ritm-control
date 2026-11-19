import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { parseCatalog } from "../shared/catalog-excel";
const [base, photos, output] = process.argv.slice(2);
if (
  !base ||
  !photos ||
  !output ||
  !output.replaceAll("\\", "/").includes("/.local/")
)
  throw new Error("Передайте два Excel и выходной файл внутри .local/.");
const bundle = await parseCatalog(
  { name: basename(base), bytes: await readFile(base) },
  { name: basename(photos), bytes: await readFile(photos) },
  (m) => process.stdout.write(`${m}\n`),
);
await mkdir(
  output.slice(0, Math.max(output.lastIndexOf("/"), output.lastIndexOf("\\"))),
  { recursive: true },
);
await writeFile(output, JSON.stringify(bundle));
process.stdout.write(
  JSON.stringify({
    id: bundle.id,
    ...bundle.manifest,
    chunks: bundle.manifest.chunks.length,
  }) + "\n",
);
