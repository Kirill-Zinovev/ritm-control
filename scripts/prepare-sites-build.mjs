#!/usr/bin/env node
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker", "sites.js");
const hosting = path.join(root, ".openai", "hosting.json");

for (const file of [index, worker, hosting]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
const result = await build({
  entryPoints: [worker],
  outfile: path.join(dist, "server", "index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:workers"],
  target: "es2022",
  metafile: true,
  plugins: [{
    name: "ritm-cloud-runtime",
    setup(builder) {
      builder.onResolve({ filter: /privateGoogleConfig\.js$/ }, () => ({ path: path.join(root, "worker/cloud/privateGoogleConfig.js") }));
      builder.onResolve({ filter: /^node:crypto$/ }, () => ({ path: path.join(root, "worker/cloud/crypto.js") }));
      builder.onResolve({ filter: /^node:/ }, (args) => ({ errors: [{ text: `Unsupported local dependency in cloud runtime: ${args.path}` }] }));
    },
  }],
});
mkdirSync(path.join(root, ".checks"), { recursive: true });
writeFileSync(path.join(root, ".checks", "sites-bundle-inputs.json"), JSON.stringify(result.metafile, null, 2));
copyFileSync(hosting, path.join(dist, ".openai", "hosting.json"));

console.log(
  "Prepared Sites build: dist/server/index.js and dist/.openai/hosting.json",
);
