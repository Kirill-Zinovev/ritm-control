import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist/server", { recursive: true });
await build({
  entryPoints: ["server/worker.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: true,
});
await mkdir("dist/.openai", { recursive: true });
await cp(".openai/hosting.json", "dist/.openai/hosting.json");
