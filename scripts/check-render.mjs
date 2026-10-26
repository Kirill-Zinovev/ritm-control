import { build } from "vite";
import react from "@vitejs/plugin-react";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { writeFileSync, mkdirSync } from "node:fs";
await build({
  configFile: false,
  plugins: [react()],
  esbuild: { tsconfigRaw: { compilerOptions: { jsx: "automatic" } } },
  build: { ssr: "src/App.tsx", outDir: ".checks/ssr", minify: false },
});
const { App } = await import("../.checks/ssr/App.js");
const pages = {
  overview: "Обзор производства",
  assembly: "Сборщики",
  printing: "Печать",
  production: "Производство",
  stock: "Склад",
  supplies: "Поставки",
  sources: "Источники данных",
  intelligence: "AI Center",
};
mkdirSync(".checks/render", { recursive: true });
for (const [page, title] of Object.entries(pages)) {
  globalThis.location = new URL("http://localhost:4173/?page=" + page);
  const html = renderToStaticMarkup(createElement(App));
  if (!html.includes("<h1>" + title + "</h1>") || !html.includes("sidebar"))
    throw new Error("Invalid page: " + page);
  if (page === "intelligence" && html.includes("Демо-данные"))
    throw new Error("AI Center must not render demo monitoring");
  writeFileSync(".checks/render/" + page + ".html", html);
  console.log("SSR passed:", page, html.length + " bytes");
}
