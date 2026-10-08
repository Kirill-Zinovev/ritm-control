import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import worker from "./worker/index.js";

export default defineConfig({
  esbuild: { tsconfigRaw: { compilerOptions: { jsx: "automatic" } } },
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    proxy: {
      "/api/intelligence": {
        target: "http://127.0.0.1:4318",
        changeOrigin: true,
      },
    },
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [
    react(),
    {
      name: "ritm-printing-api",
      configureServer(server) {
        server.middlewares.use("/api/printing", async (req, res) => {
          try {
            const response = await worker.fetch(
              new Request("http://localhost/api/printing", {
                method: req.method || "GET",
              }),
              {},
            );
            res.statusCode = response.status;
            response.headers.forEach((v, k) => res.setHeader(k, v));
            res.end(await response.text());
          } catch {
            res.statusCode = 502;
            res.end(JSON.stringify({ ok: false, error: "source_unavailable" }));
          }
        });
        server.middlewares.use("/api/assembly", async (req, res) => {
          try {
            const query = new URL(req.url || "/", "http://localhost").search;
            const response = await worker.fetch(
              new Request("http://localhost/api/assembly" + query, {
                method: req.method || "GET",
              }),
              {},
            );
            res.statusCode = response.status;
            response.headers.forEach((v, k) => res.setHeader(k, v));
            res.end(await response.text());
          } catch {
            res.statusCode = 502;
            res.end(JSON.stringify({ ok: false, error: "source_unavailable" }));
          }
        });
      },
    },
  ],
});
