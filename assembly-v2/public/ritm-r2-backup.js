const prepare = document.getElementById("r2-prepare");
const status = document.getElementById("r2-status");
const download = document.getElementById("r2-file");
const base = new URL(location.pathname, location.origin);
const blockSize = 512;
const maxBytes = 384 * 1024 * 1024;
const encoder = new TextEncoder();
let downloadUrl;

async function request(url) {
  if (url.origin !== base.origin || url.pathname !== base.pathname) throw new Error("Неизвестный адрес выгрузки.");
  const response = await fetch(url, { cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error(`Выгрузка вернула ошибку HTTP ${response.status}.`);
  return response;
}

async function partLinks() {
  const seen = new Set();
  const links = [];
  let current = base;
  while (current) {
    if (seen.has(current.href)) throw new Error("Список частей повторился.");
    seen.add(current.href);
    const html = new DOMParser().parseFromString(await (await request(current)).text(), "text/html");
    const part = html.querySelector("[data-r2-part]")?.getAttribute("href");
    if (!part) throw new Error("На странице нет ссылки на часть архива.");
    links.push(new URL(part, current));
    const next = html.querySelector("[data-r2-next]")?.getAttribute("href");
    current = next ? new URL(next, current) : null;
  }
  return links;
}

function tarHeader(name, size) {
  const bytes = new Uint8Array(blockSize);
  const write = (value, start) => bytes.set(encoder.encode(value), start);
  const octal = (value, start, length) => write(value.toString(8).padStart(length - 1, "0") + "\0", start);
  write(name, 0);
  octal(0o600, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(Math.floor(Date.now() / 1000), 136, 12);
  bytes.fill(32, 148, 156);
  write("0", 156);
  write("ustar\0", 257);
  write("00", 263);
  write(bytes.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return bytes;
}

function tarEntry(name, blob) {
  const padding = (blockSize - blob.size % blockSize) % blockSize;
  return [tarHeader(name, blob.size), blob, new Uint8Array(padding)];
}

async function buildArchive() {
  status.textContent = "Читаю опись R2.";
  const inventoryUrl = new URL("?download=inventory", base);
  const inventory = await (await request(inventoryUrl)).blob();
  const lines = (await inventory.text()).trimEnd().split("\n");
  const receipt = JSON.parse(lines.at(-1) || "{}");
  if (!receipt.complete || lines.length !== receipt.count + 2) throw new Error("Опись R2 загрузилась не полностью.");
  if (receipt.bytes > maxBytes) throw new Error("Этот архив слишком большой для браузера. Скачайте его по частям.");

  status.textContent = `Объектов в описи ${receipt.count}. Собираю ссылки на части.`;
  const links = await partLinks();
  const files = new Array(links.length);
  let finished = 0;
  let next = 0;
  status.textContent = `Готово частей 0 из ${links.length}.`;
  async function readParts() {
    while (next < links.length) {
      const index = next++;
      const response = await request(links[index]);
      if (response.headers.get("content-type") !== "application/x-tar") throw new Error("Не удалось прочитать часть архива.");
      const file = await response.blob();
      const tail = new Uint8Array(await file.slice(-1024).arrayBuffer());
      if (file.size < 2048 || tail.length !== 1024 || tail.some(Boolean)) {
        throw new Error(`Часть ${index + 1} загрузилась не полностью.`);
      }
      files[index] = file;
      finished++;
      status.textContent = `Готово частей ${finished} из ${links.length}.`;
    }
  }
  const results = await Promise.allSettled(Array.from({ length: Math.min(links.length, 3) }, readParts));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;

  const archive = new Blob([
    ...tarEntry("r2-inventory.ndjson", inventory),
    ...files.flatMap((file, index) => tarEntry("parts/part-" + String(index + 1).padStart(4, "0") + ".tar", file)),
    new Uint8Array(1024),
  ], { type: "application/x-tar" });
  downloadUrl = URL.createObjectURL(archive);
  download.href = downloadUrl;
  download.download = "assembly-r2-" + new Date().toISOString().replace(/[:.]/g, "-") + ".tar";
  download.hidden = false;
  status.textContent = `Архив готов. Объектов ${receipt.count}, размер ${Math.ceil(archive.size / (1024 * 1024))} МБ.`;
}

prepare.hidden = false;
prepare.addEventListener("click", async () => {
  prepare.disabled = true;
  download.hidden = true;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  try {
    await buildArchive();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Не удалось собрать архив.";
  } finally {
    prepare.disabled = false;
  }
});
