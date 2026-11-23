import type { Env } from "./worker";

export const databaseBackupPath: string;
export function databaseBackup(
  request: Request,
  db: Env["DB"],
  application: "assembly",
  owner: boolean,
): Promise<Response>;
