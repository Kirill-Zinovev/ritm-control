// Dependency-free Cloudflare/Node renderer. Only public, versioned glyph masks
// and the decorative branch are cached. Generated business cards stay in memory
// and go directly to Bitrix, never into a public URL or another rendering service.
import { arkadyCardContent, arkadyCardCaption } from "./arkadyCards.js";

const ASSET_ORIGIN = "https://ritm-erp.zinovevkirill234.chatgpt.site";
const cache = new WeakMap();
const WIDTH = 1000,
  MAX_HEIGHT = 2000,
  MAX_ROWS = 16;
const COLORS = {
  ink: "#14213a",
  muted: "#50627a",
  blue: "#2563eb",
  green: "#19872a",
  amber: "#a75b09",
  line: "#dfe7ef",
  box: "#ef8420",
  roll: "#258af1",
};
const fmt = (value) => new Intl.NumberFormat("ru-RU").format(value);
const plural = (value) =>
  `${fmt(value)} ${value % 100 >= 11 && value % 100 <= 14 ? "артикулов" : value % 10 === 1 ? "артикул" : value % 10 >= 2 && value % 10 <= 4 ? "артикула" : "артикулов"}`;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

async function streamBytes(stream, limit) {
  const reader = stream.getReader(),
    chunks = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > limit) throw Error("card_asset_too_large");
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function loadArkadyRenderAssets(assets) {
  if (!assets?.fetch) throw Error("card_assets_unavailable");
  if (cache.has(assets)) return cache.get(assets);
  const pending = (async () => {
    const read = async (path, limit) => {
      const response = await assets.fetch(
        new Request(ASSET_ORIGIN + path, { signal: AbortSignal.timeout(5000) }),
      );
      if (!response.ok) throw Error("card_asset_missing");
      return streamBytes(response.body, limit);
    };
    const [json, data] = await Promise.all([
      read("/images/arkady-render-assets-v1.json", 500000),
      read("/images/arkady-render-assets-v1.bin", 800000),
    ]);
    const metadata = JSON.parse(new TextDecoder().decode(json));
    if (
      metadata.version !== 1 ||
      !Number.isSafeInteger(metadata.rawBytes) ||
      metadata.rawBytes > 8000000
    )
      throw Error("card_asset_invalid");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    if (
      Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("") !==
      metadata.sha256
    )
      throw Error("card_asset_revision_mismatch");
    const bytes = await streamBytes(
      new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate")),
      metadata.rawBytes,
    );
    if (bytes.length !== metadata.rawBytes)
      throw Error("card_asset_incomplete");
    for (const font of Object.values(metadata.fonts))
      for (const glyph of Object.values(font.glyphs)) {
        if (
          glyph.offset < 0 ||
          glyph.width > 150 ||
          glyph.height > 100 ||
          glyph.offset + glyph.width * glyph.height > bytes.length
        )
          throw Error("card_glyph_invalid");
      }
    return { ...metadata, bytes };
  })();
  cache.set(assets, pending);
  try {
    return await pending;
  } catch (error) {
    cache.delete(assets);
    throw error;
  }
}

function cleanGlyphText(value, assets) {
  return Array.from(String(value || ""))
    .filter((char) => assets.fonts.body.glyphs[char] || /\s/.test(char))
    .join("");
}
function measure(value, font) {
  return Array.from(value).reduce(
    (sum, char) =>
      sum + (font.glyphs[char]?.advance || font.glyphs[" "].advance),
    0,
  );
}
function wrap(value, font, width) {
  const words = String(value || "").split(/\s+/),
    lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? line + " " + word : word;
    if (measure(candidate, font) <= width) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
    }
    for (const char of word) {
      if (line && measure(line + char, font) > width) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Layout and rendering share exact glyph advances; no guessed text widths or
// silent clipping. Returned semantic lines also support non-visual regression QA.
export function layoutArkadyCard(model, assets) {
  const commands = [],
    lines = [];
  let y = 20;
  const text = (value, x, top, style = "body", color = COLORS.ink) => {
    value = cleanGlyphText(value, assets);
    commands.push({ kind: "text", value, x, y: top, style, color });
    lines.push(value);
  };
  const block = (value, x, top, width, style = "body", color = COLORS.ink) => {
    const font = assets.fonts[style],
      rows = wrap(cleanGlyphText(value, assets), font, width),
      step = Math.ceil(font.size * 1.32);
    rows.forEach((row, i) => text(row, x, top + i * step, style, color));
    return rows.length * step;
  };
  const rect = (x, top, width, height, color, radius = 0) =>
    commands.push({ kind: "rect", x, y: top, width, height, color, radius });
  const icon = (name, x, top, color) =>
    commands.push({ kind: "icon", name, x, y: top, color });
  commands.push({ kind: "branch", x: WIDTH - 240, y: 0, scale: 0.75 });
  text("RITM", 32, y, "brand");
  text("/", 196, y, "brand", "#00a58e");
  y = 124;
  icon(
    model.done ? "check" : model.urgent ? "urgent" : "cube",
    32,
    y + 5,
    model.done ? COLORS.green : model.urgent ? COLORS.amber : COLORS.blue,
  );
  y += block(model.heading, 103, y, WIDTH - 140, "heading") + 8;
  if (model.done || model.type === "reminder")
    y += block(model.subtitle, 103, y, WIDTH - 140, "body", COLORS.muted) + 8;
  const subjectLines = wrap(
      cleanGlyphText(model.subject, assets),
      assets.fonts.strong,
      WIDTH - 104,
    ),
    subjectHeight = subjectLines.length * 47 + 18;
  rect(
    32,
    y,
    WIDTH - 64,
    subjectHeight,
    model.urgent ? "#fff1d9" : model.done ? "#e9f7e5" : "#edf3fb",
    14,
  );
  subjectLines.forEach((row, i) =>
    text(
      row,
      51,
      y + 10 + i * 47,
      "strong",
      model.urgent ? "#8b4e08" : COLORS.ink,
    ),
  );
  y += subjectHeight + 14;
  if (model.type === "task-reminder") {
    y += block(model.task, 38, y, WIDTH - 76, "section") + 8;
    if (model.note) y += block(model.note, 38, y, WIDTH - 76) + 8;
    if (model.selection) y += block(model.selection, 38, y, WIDTH - 76, "small") + 8;
    if (model.subtitle) y += block(model.subtitle, 38, y, WIDTH - 76, "small", COLORS.muted) + 8;
    return { width: WIDTH, height: y + 14, commands, lines, hiddenRows: 0, shownRows: [] };
  }
  let rowsRemaining=MAX_ROWS, hiddenRows = 0;
  const shownRows=[];
  for (const [sectionIndex,section] of model.sections.entries()) {
    rect(32, y, WIDTH - 64, 2, COLORS.line);
    y += 13;
    icon(
      section.department,
      34,
      y + 7,
      section.department === "box" ? COLORS.box : COLORS.roll,
    );
    text(section.label, 91, y, "section");
    if (model.done) {
      const badgeX = WIDTH - 167;
      rect(badgeX, y + 5, 132, 49, "#e3f7dc", 20);
      text("Готово", badgeX + 19, y + 7, "small", COLORS.green);
    }
    if (model.stock) {
      y += 50;
      const allocation=Math.max(1,Math.floor(rowsRemaining/(model.sections.length-sectionIndex)));
      const shown = section.entries.slice(0, allocation);
      rowsRemaining-=shown.length;
      shownRows.push(shown.length);
      for (const entry of shown) {
        const quantity = fmt(entry.quantity) + " шт.",
          right = WIDTH - 42 - measure(quantity, assets.fonts.strong);
        const height = block(
          entry.article,
          91,
          y,
          Math.max(200, right - 112),
          "body",
        );
        text(quantity, right, y, "strong");
        y += Math.max(48, height + 6);
        rect(91, y - 2, WIDTH - 133, 1, COLORS.line);
      }
      hiddenRows += section.entries.length - shown.length;
      if (section.entries.length > shown.length)
        y +=
          block(
            `Ещё ${plural(section.entries.length - shown.length)} — полный список по ссылке ниже`,
            91,
            y + 6,
            WIDTH - 135,
            "small",
            COLORS.muted,
          ) + 6;
    } else {
      shownRows.push(0);
      const quantity = `${section.articles === null ? "" : plural(section.articles) + " · "}${fmt(section.quantity)} шт.`,
        right = WIDTH - 42 - measure(quantity, assets.fonts.strong),
        labelRight = 91 + measure(section.label, assets.fonts.section);
      if (!model.done && right > labelRight + 24) {
        text(quantity, right, y, "strong");
        y += 50;
      } else {
        y += 50 + block(quantity, 91, y + 50, WIDTH - 130, "strong");
      }
    }
    y += 10;
  }
  const total = `${model.count === null ? "" : plural(model.count) + "   |   "}${fmt(model.quantity)} шт.`;
  const totalRows = wrap(total, assets.fonts.total, WIDTH - 108),
    totalHeight = totalRows.length * 56 + 14;
  rect(32, y, WIDTH - 64, totalHeight, model.done ? "#e3f8d9" : "#edf4ff", 14);
  totalRows.forEach((row, i) =>
    text(row, 52, y + 9 + i * 56, "total", model.done ? "#156c1a" : "#173e76"),
  );
  y += totalHeight + 8;
  if (model.manager)
    y +=
      block(
        `Добавил(а): ${model.manager}`,
        38,
        y,
        WIDTH - 76,
        "body",
        COLORS.muted,
      ) + 6;
  if (model.joke) {
    icon("smile", 34, y + 6, COLORS.green);
    y += block(model.joke, 87, y, WIDTH - 123, "body") + 8;
  }
  y += 14;
  if (y > MAX_HEIGHT) throw Error("card_layout_too_tall");
  return {
    width: WIDTH,
    height: y,
    commands,
    lines,
    hiddenRows,
    shownRows,
    subjectFontSize: assets.fonts.strong.size,
  };
}

function paint(layout, assets) {
  const { width, height } = layout,
    canvas = new Uint8Array(width * height * 3);
  canvas.fill(255);
  const pixel = (x, y, color, alpha = 255) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || x >= width || y < 0 || y >= height || !alpha) return;
    const index = (y * width + x) * 3,
      a = alpha / 255;
    for (let i = 0; i < 3; i++)
      canvas[index + i] = Math.round(
        color[i] * a + canvas[index + i] * (1 - a),
      );
  };
  const disc = (cx, cy, radius, color) => {
    for (
      let y = Math.floor(cy - radius - 1);
      y <= Math.ceil(cy + radius + 1);
      y++
    )
      for (
        let x = Math.floor(cx - radius - 1);
        x <= Math.ceil(cx + radius + 1);
        x++
      ) {
        const coverage = Math.max(
          0,
          Math.min(1, radius + 0.5 - Math.hypot(x - cx, y - cy)),
        );
        if (coverage) pixel(x, y, color, coverage * 255);
      }
  };
  const line = (x1, y1, x2, y2, color, thickness = 3) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
    for (let i = 0; i <= steps; i++)
      disc(
        x1 + ((x2 - x1) * i) / steps,
        y1 + ((y2 - y1) * i) / steps,
        thickness / 2,
        color,
      );
  };
  for (const command of layout.commands) {
    const { x, y } = command,
      color = rgb(command.color || COLORS.ink);
    if (command.kind === "rect") {
      const r = command.radius || 0,
        w = command.width,
        h = command.height;
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++) {
          const ex = Math.max(r - dx, dx - (w - 1 - r), 0),
            ey = Math.max(r - dy, dy - (h - 1 - r), 0);
          const alpha =
            ex && ey
              ? Math.max(0, Math.min(1, r + 0.5 - Math.hypot(ex, ey))) * 255
              : 255;
          pixel(x + dx, y + dy, color, alpha);
        }
    } else if (command.kind === "text") {
      let left = x;
      for (const char of command.value) {
        const glyph = assets.fonts[command.style].glyphs[char];
        if (!glyph) continue;
        for (let gy = 0; gy < glyph.height; gy++)
          for (let gx = 0; gx < glyph.width; gx++)
            pixel(
              left + gx - 3,
              y + gy - 3,
              color,
              assets.bytes[glyph.offset + gy * glyph.width + gx],
            );
        left += glyph.advance;
      }
    } else if (command.kind === "branch") {
      const branch = assets.branch, scale = command.scale || 1;
      for (let dy = 0; dy < Math.round(branch.height * scale); dy++)
        for (let dx = 0; dx < Math.round(branch.width * scale); dx++) {
          const index = branch.offset + (Math.floor(dy / scale) * branch.width + Math.floor(dx / scale)) * 4;
          pixel(
            x + dx,
            y + dy,
            assets.bytes.subarray(index, index + 3),
            assets.bytes[index + 3],
          );
        }
    } else if (command.kind === "icon") {
      const name = command.name;
      if (name === "check") {
        disc(x + 27, y + 27, 27, color);
        line(x + 13, y + 27, x + 24, y + 38, [255, 255, 255], 6);
        line(x + 24, y + 38, x + 44, y + 15, [255, 255, 255], 6);
      } else if (name === "urgent") {
        line(x + 27, y + 4, x + 4, y + 46, color, 4);
        line(x + 4, y + 46, x + 50, y + 46, color, 4);
        line(x + 50, y + 46, x + 27, y + 4, color, 4);
        line(x + 27, y + 18, x + 27, y + 30, color, 4);
        disc(x + 27, y + 38, 2.5, color);
      } else if (name === "smile") {
        disc(x + 18, y + 18, 18, color);
        disc(x + 18, y + 18, 15, [255, 255, 255]);
        disc(x + 12, y + 13, 1.7, color);
        disc(x + 24, y + 13, 1.7, color);
        line(x + 10, y + 22, x + 16, y + 26, color, 2);
        line(x + 16, y + 26, x + 22, y + 25, color, 2);
        line(x + 22, y + 25, x + 26, y + 21, color, 2);
      } else if (name === "roll") {
        for (let i = 0; i < 42; i++) {
          const angle = (i * Math.PI) / 20;
          disc(
            x + 12 + Math.cos(angle) * 10,
            y + 18 + Math.sin(angle) * 15,
            1.5,
            color,
          );
        }
        line(x + 12, y + 3, x + 37, y + 3, color);
        line(x + 12, y + 33, x + 37, y + 33, color);
        line(x + 37, y + 3, x + 43, y + 12, color);
        line(x + 43, y + 12, x + 43, y + 26, color);
        line(x + 43, y + 26, x + 37, y + 33, color);
      } else {
        const sx = x + 3,
          sy = y + 2;
        for (const [a, b, c, d] of [
          [20, 0, 40, 11],
          [40, 11, 40, 34],
          [40, 34, 20, 45],
          [20, 45, 0, 34],
          [0, 34, 0, 11],
          [0, 11, 20, 0],
          [0, 11, 20, 22],
          [20, 22, 40, 11],
          [20, 22, 20, 45],
        ])
          line(sx + a, sy + b, sx + c, sy + d, color, 2.5);
      }
    }
  }
  return canvas;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function chunk(name, data) {
  const output = new Uint8Array(data.length + 12),
    view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(new TextEncoder().encode(name), 4);
  output.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < output.length - 4; i++)
    crc = crcTable[(crc ^ output[i]) & 255] ^ (crc >>> 8);
  view.setUint32(output.length - 4, (crc ^ 0xffffffff) >>> 0);
  return output;
}
async function encodePng(pixels, width, height) {
  const stride = width * 3,
    raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let x = 0; x < stride; x++)
      raw[row + x + 1] =
        (pixels[y * stride + x] -
          (x < 3 ? 0 : pixels[y * stride + x - 3]) +
          256) &
        255;
  }
  const data = await streamBytes(
    new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
    6000000,
  );
  const ihdr = new Uint8Array(13),
    view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const pieces = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", data),
    chunk("IEND", new Uint8Array()),
  ];
  const output = new Uint8Array(
    pieces.reduce((sum, piece) => sum + piece.length, 0),
  );
  let at = 0;
  for (const piece of pieces) {
    output.set(piece, at);
    at += piece.length;
  }
  return output;
}

export async function renderArkadyCard(event, assetsBinding) {
  const model = arkadyCardContent(event);
  if (!model) return null;
  const assets = await loadArkadyRenderAssets(assetsBinding),
    layout = layoutArkadyCard(model, assets);
  const png = await encodePng(
    paint(layout, assets),
    layout.width,
    layout.height,
  );
  return {
    png,
    width: layout.width,
    height: layout.height,
    caption: arkadyCardCaption(model),
    layout,
    model,
  };
}

export function pngBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
