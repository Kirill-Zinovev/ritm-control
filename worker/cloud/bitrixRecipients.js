import { CloudError } from "./access.js";

export function validBitrixRecipient(id) {
  return typeof id === "string" && /^[1-9]\d{0,15}$/u.test(id) &&
    Number.isSafeInteger(Number(id));
}

function employee(entry) {
  const id = String(entry?.ID ?? "");
  if (!validBitrixRecipient(id) ||
    (entry.ACTIVE !== true && entry.ACTIVE !== "Y") ||
    entry.USER_TYPE !== "employee") return null;
  const name = [entry.LAST_NAME, entry.NAME, entry.SECOND_NAME]
    .filter(value => typeof value === "string")
    .join(" ")
    .replace(/[\r\n\[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim().slice(0, 120);
  return name ? { id, name } : null;
}

async function employeesPage(config, fetcher, signal, start, id) {
  try {
    const response = await fetcher(config.RITM_BITRIX_WEBHOOK_URL + "user.get", {
      method: "POST",
      redirect: "manual",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filter: { ACTIVE: true, USER_TYPE: "employee", ...(id && { ID: Number(id) }) },
        select: ["ID", "NAME", "LAST_NAME", "SECOND_NAME", "ACTIVE", "USER_TYPE"],
        sort: "ID",
        order: "ASC",
        start,
      }),
    });
    const page = await response.json();
    if (!response.ok || page?.error || !Array.isArray(page?.result)) throw new Error("Directory unavailable");
    return page;
  } catch {
    throw new CloudError(
      "bitrix_directory_unavailable",
      "Не удалось проверить сотрудников Битрикс24. Проверьте подключение и право чтения справочника.",
      503,
    );
  }
}

export async function listBitrixRecipients(config, fetcher = fetch) {
  const signal = AbortSignal.timeout(15000);
  const directory = new Map();
  let start = 0;
  for (let count = 0; count < 20; count++) {
    const { result, next } = await employeesPage(config, fetcher, signal, start);
    for (const entry of result) {
      const person = employee(entry);
      if (person) directory.set(person.id, person);
    }
    if (next === undefined || next === null) {
      return [...directory.values()].sort((a, b) =>
        a.name.localeCompare(b.name, "ru-RU") || Number(a.id) - Number(b.id));
    }
    const offset = Number(next);
    if (!Number.isSafeInteger(offset) || offset <= start) break;
    start = offset;
  }
  throw new CloudError("bitrix_directory_incomplete", "Битрикс24 не подтвердил полный список сотрудников.", 503);
}

export async function readBitrixRecipient(config, id, fetcher = fetch) {
  if (!validBitrixRecipient(id)) return null;
  const { result, next } = await employeesPage(config, fetcher, AbortSignal.timeout(8000), 0, id);
  const rows = result.filter(row => String(row?.ID ?? "") === id);
  return rows.length === 1 && next == null ? employee(rows[0]) : null;
}
