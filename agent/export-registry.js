import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SOURCES } from "./registry.js";
const target = process.argv[2];
if (!target)
  throw Error("Pass an output path for the complete default registry");
fs.writeFileSync(
  path.resolve(target),
  JSON.stringify(DEFAULT_SOURCES, null, 2) + "\n",
  { flag: "wx" },
);
console.log("Registry exported. Review new source rules before enabling them.");
