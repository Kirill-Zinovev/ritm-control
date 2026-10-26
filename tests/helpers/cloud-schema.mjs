import { readFileSync } from "node:fs";
export function cloudSchemaStatements() {
  const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  return journal.entries.flatMap((entry) => readFileSync(new URL("../../drizzle/" + entry.tag + ".sql", import.meta.url), "utf8").split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean));
}
