import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FileStore } from "./catalog-api";
export function localFiles(directory: string): FileStore {
  const root = resolve(directory);
  const path = (key: string) => {
    const target = resolve(root, key);
    if (!target.startsWith(root + "/") && !target.startsWith(root + "\\"))
      throw new Error("Неверный путь файла.");
    return target;
  };
  return {
    async get(key) {
      try {
        const target = path(key);
        return {
          body: new Uint8Array(await readFile(target)),
          contentType: await readFile(target + ".type", "utf8"),
        };
      } catch {
        return null;
      }
    },
    async put(key, bytes, type) {
      const target = path(key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      await writeFile(target + ".type", type);
    },
  };
}
