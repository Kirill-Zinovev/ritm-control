// Maintainer-only asset compiler. The production Worker needs neither a browser,
// a font engine, a native module nor a third-party rendering service.
// node scripts/generate-arkady-render-assets.mjs <GolosText.ttf> <playwright-module>
import fs from "node:fs";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const [fontFile, browserModule] = process.argv.slice(2);
if (!fontFile || !browserModule)
  throw Error(
    "Pass the OFL Golos Text font and an installed Playwright module.",
  );
const { chromium } = await import(pathToFileURL(browserModule));
const font = fs.readFileSync(fontFile),
  header = fs.readFileSync(
    new URL("../public/images/arkady-notification-v2.png", import.meta.url),
  ),
  avatar = fs.readFileSync(new URL("../public/help/arkady.webp", import.meta.url));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  await page.setContent(
    '<!doctype html><meta charset="utf-8"><canvas></canvas>',
  );
  const result = await page.evaluate(
    async ({ font, header, avatar }) => {
      const face = new FontFace(
        "ArkadyGolos",
        `url(data:font/ttf;base64,${font})`,
        { weight: "100 900" },
      );
      await face.load();
      document.fonts.add(face);
      const characters = [
        ...new Set([
          ...Array.from({ length: 95 }, (_, i) => String.fromCodePoint(32 + i)),
          ...Array.from({ length: 256 }, (_, i) =>
            String.fromCodePoint(0x400 + i),
          ),
          ..."–—·№↗…×²«»‑\u00a0✓!",
        ]),
      ];
      const styles = {
        small: [28, 500],
        body: [32, 500],
        strong: [36, 700],
        section: [36, 700],
        total: [42, 700],
        heading: [50, 700],
        brand: [58, 800],
      };
      const chunks = [],
        fonts = {};
      let offset = 0;
      for (const [key, [size, weight]] of Object.entries(styles)) {
        const glyphs = {};
        for (const char of characters) {
          const canvas = document.createElement("canvas"),
            ctx = canvas.getContext("2d");
          ctx.font = `${weight} ${size}px ArkadyGolos`;
          const advance = ctx.measureText(char).width;
          canvas.width = Math.ceil(advance) + 6;
          canvas.height = Math.ceil(size * 1.5) + 6;
          ctx.font = `${weight} ${size}px ArkadyGolos`;
          ctx.fillStyle = "#000";
          ctx.fillText(char, 3, size + 3);
          const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data,
            alpha = new Uint8Array(canvas.width * canvas.height);
          for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
          glyphs[char] = {
            width: canvas.width,
            height: canvas.height,
            advance,
            offset,
          };
          chunks.push(alpha);
          offset += alpha.length;
        }
        fonts[key] = { size, glyphs };
      }
      const image = new Image();
      image.src = `data:image/png;base64,${header}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 160;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 320, 160);
      ctx.drawImage(image, image.width - 1200, 0, 1200, 600, 0, 0, 320, 160);
      const branch = new Uint8Array(ctx.getImageData(0, 0, 320, 160).data),
        branchOffset = offset;
      chunks.push(branch);
      offset += branch.length;
      image.src = `data:image/webp;base64,${avatar}`;
      await image.decode();
      canvas.width = 54;
      canvas.height = 54;
      ctx.beginPath();
      ctx.roundRect(0, 0, 54, 54, 17);
      ctx.clip();
      ctx.drawImage(image, 0, 0, 54, 54);
      ctx.strokeStyle = "#92baff9c";
      ctx.lineWidth = 2;
      ctx.stroke();
      const avatarPixels = new Uint8Array(ctx.getImageData(0, 0, 54, 54).data),
        avatarOffset = offset;
      chunks.push(avatarPixels);
      offset += avatarPixels.length;
      const bytes = new Uint8Array(offset);
      let cursor = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, cursor);
        cursor += chunk.length;
      }
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return {
        metadata: {
          version: 1,
          fontFamily: "Golos Text",
          fonts,
          branch: { width: 320, height: 160, offset: branchOffset },
          avatar: { width: 54, height: 54, offset: avatarOffset },
          rawBytes: offset,
        },
        data: btoa(binary),
      };
    },
    { font: font.toString("base64"), header: header.toString("base64"), avatar: avatar.toString("base64") },
  );
  const data = deflateSync(Buffer.from(result.data, "base64"), { level: 9 });
  result.metadata.sha256 = createHash("sha256").update(data).digest("hex");
  result.metadata.fontSource =
    "https://github.com/google/fonts/tree/main/ofl/golostext";
  result.metadata.fontSha256 = createHash("sha256").update(font).digest("hex");
  fs.writeFileSync(
    new URL("../public/images/arkady-render-assets-v1.json", import.meta.url),
    JSON.stringify(result.metadata),
  );
  fs.writeFileSync(
    new URL("../public/images/arkady-render-assets-v1.bin", import.meta.url),
    data,
  );
  console.log(
    JSON.stringify({
      compressedBytes: data.length,
      rawBytes: result.metadata.rawBytes,
      fonts: Object.keys(result.metadata.fonts),
      externalRequests: 0,
    }),
  );
} finally {
  await browser.close();
}
