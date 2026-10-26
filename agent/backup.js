import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
export async function backupDatabase(source, directory) {
  const root = fs.realpathSync(process.cwd());
  fs.mkdirSync(path.resolve(directory), { recursive: true, mode: 0o700 });
  const dir = fs.realpathSync(path.resolve(directory));
  if (
    dir.toLowerCase() === root.toLowerCase() ||
    dir.toLowerCase().startsWith(root.toLowerCase() + path.sep)
  )
    throw new Error("Backups must be outside Git");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filename = path.join(
    dir,
    "ritm-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      randomUUID() +
      ".sqlite",
  );
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, filename);
  } finally {
    db.close();
  }
  fs.chmodSync(filename, 0o600);
  const check = new DatabaseSync(filename, { readOnly: true });
  try {
    if (Object.values(check.prepare("PRAGMA quick_check").get())[0] !== "ok")
      throw new Error("Backup verification failed");
  } finally {
    check.close();
  }
  return filename;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.umask(0o077);
  if (!process.argv[2] || !process.argv[3])
    throw new Error("Specify database and private backup directory");
  await backupDatabase(path.resolve(process.argv[2]), process.argv[3]);
  console.log("Резервная копия создана; PRAGMA quick_check: ok");
}
