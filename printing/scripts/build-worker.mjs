import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'vite';

await build({
  configFile: false,
  build: {
    ssr: 'worker/index.mjs',
    outDir: 'dist/server',
    target: 'es2022',
    rollupOptions: { output: { entryFileNames: 'index.js' } },
  },
});
mkdirSync('dist/.openai', { recursive: true });
copyFileSync('.openai/hosting.json', 'dist/.openai/hosting.json');
