import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const client = "dist/client";
const html = readFileSync(path.join(client, "index.html"), "utf8");
const jsAsset = html.match(/src="([^"]+\.js)"/)?.[1];
const cssAsset = html.match(/href="([^"]+\.css)"/)?.[1];
if (!jsAsset || !cssAsset) {
  throw new Error(
    "Could not find the built JavaScript and CSS assets in index.html",
  );
}
const js = readFileSync(
  path.join(client, "assets", path.basename(jsAsset)),
  "utf8",
).replace(/<\/script/gi, "<\\/script");
const css = readFileSync(
  path.join(client, "assets", path.basename(cssAsset)),
  "utf8",
);
writeFileSync(
  "../ritm-preview.html",
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RITM · Производственный кабинет</title><style>${css}</style></head><body><div id="root"></div><script type="module">${js}</script></body></html>`,
);
console.log("Created standalone React preview: ritm-preview.html");
