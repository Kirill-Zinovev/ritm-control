const path = require("node:path");
const cache = require("C:/Program Files/nodejs/node_modules/npm/node_modules/cacache");
const source = path.join(process.env.LOCALAPPDATA, "npm-cache", "_cacache");
const dest = path.join(process.cwd(), ".npm-cache", "_cacache");
const match =
  /radix-ui|lucide-react|typescript[\/-]|prettier|@types(?:%2f|\/)react|csstype|use-callback-ref|use-sidecar|react-remove-scroll|react-style-singleton|aria-hidden|detect-node-es|tslib|get-nonce|\/react(?:-dom)?(?:$|\/)|\/vite(?:$|\/)|plugin-react|babel|rollup|esbuild/;
(async () => {
  const entries = await cache.ls(source);
  let count = 0;
  for (const [key, info] of Object.entries(entries)) {
    if (key.startsWith("make-fetch-happen:") && match.test(key)) {
      try {
        const result = await cache.get(source, key);
        await cache.put(dest, key, result.data, { metadata: info.metadata });
        count++;
      } catch {}
    }
  }
  console.log("Prepared cached package entries:", count);
})();
