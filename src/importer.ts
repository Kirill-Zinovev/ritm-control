import type { Dataset, Kind, Operation } from "./model";
type Mapping = Record<string, string>;
export const importFields: Record<
  Kind,
  { key: string; label: string; required?: boolean }[]
> = {
  assembly: [
    { key: "id", label: "ID операции", required: true },
    { key: "employee", label: "Сотрудник", required: true },
    { key: "date", label: "Дата", required: true },
    { key: "article", label: "Артикул", required: true },
    { key: "operation", label: "Операция", required: true },
    { key: "quantity", label: "Выполненное количество", required: true },
    { key: "norm", label: "Норма", required: true },
  ],
  printing: [
    { key: "id", label: "Уникальный ID рулона", required: true },
    { key: "employee", label: "Сотрудник", required: true },
    { key: "date", label: "Дата завершения", required: true },
    { key: "article", label: "Артикул", required: true },
    { key: "quantity", label: "Количество", required: true },
    { key: "area", label: "Площадь, м²", required: true },
    { key: "site", label: "Участок", required: true },
  ],
  stock: [
    { key: "article", label: "Артикул", required: true },
    { key: "cell", label: "Ячейка хранения", required: true },
    { key: "quantity", label: "Остаток", required: true },
    { key: "date", label: "Дата выгрузки", required: true },
  ],
};
function number(raw: string, label: string, row: number, positive = false) {
  const n = Number(
    raw
      .trim()
      .replace(/[\s\u00a0]/g, "")
      .replace(",", "."),
  );
  if (!raw.trim() || !Number.isFinite(n) || (positive ? n <= 0 : n < 0))
    throw new Error(
      `Строка ${row}: «${label}» должно быть ${positive ? "больше нуля" : "неотрицательным числом"}.`,
    );
  return n;
}
function date(raw: string, row: number) {
  let value = raw.trim();
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (match) value = `${match[3]}-${match[2]}-${match[1]}`;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(new Date(value + "T12:00:00Z").valueOf()) ||
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw new Error(
      `Строка ${row}: дата должна быть ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.`,
    );
  return value;
}
export function importRows(
  base: Dataset,
  kind: Kind,
  rows: Record<string, string>[],
  mapping: Mapping,
): Dataset {
  if (!rows.length) throw new Error("В файле нет строк с данными.");
  for (const f of importFields[kind])
    if (f.required && !mapping[f.key])
      throw new Error(`Выбери столбец «${f.label}».`);
  const data = structuredClone(base);
  const ids = new Set<string>();
  const get = (r: Record<string, string>, key: string, index: number) => {
    const value = String(r[mapping[key]] ?? "").trim();
    if (!value)
      throw new Error(
        `Строка ${index + 2}: поле «${importFields[kind].find((f) => f.key === key)?.label || key}» пустое.`,
      );
    return value;
  };
  const employee = (name: string) => {
    const normalized = name.replace(/\s+/g, " ").trim();
    let e = data.employees.find((e) => e.name === normalized);
    if (!e) {
      e = { id: "imp-" + normalized, name: normalized };
      data.employees.push(e);
    }
    return e.id;
  };
  if (kind === "assembly")
    data.work = rows.map((r, i) => {
      const id = get(r, "id", i);
      if (ids.has(id))
        throw new Error(`Строка ${i + 2}: повторяется ID операции ${id}.`);
      ids.add(id);
      const operation = get(r, "operation", i) as Operation;
      if (!["Резка", "Ручная работа", "Упаковка"].includes(operation))
        throw new Error(
          `Строка ${i + 2}: неизвестная операция «${operation}». Используй Резка, Ручная работа или Упаковка.`,
        );
      return {
        id,
        employee: employee(get(r, "employee", i)),
        date: date(get(r, "date", i), i + 2),
        time: "",
        article: get(r, "article", i).toUpperCase(),
        operation,
        quantity: number(get(r, "quantity", i), "количество", i + 2),
        norm: number(get(r, "norm", i), "норма", i + 2, true),
        source: "Импорт CSV · сборка",
      };
    });
  if (kind === "printing")
    data.rolls = rows.map((r, i) => {
      const id = get(r, "id", i);
      if (ids.has(id))
        throw new Error(`Строка ${i + 2}: повторяется ID рулона ${id}.`);
      ids.add(id);
      return {
        id,
        employee: employee(get(r, "employee", i)),
        date: date(get(r, "date", i), i + 2),
        time: "",
        article: get(r, "article", i).toUpperCase(),
        quantity: number(get(r, "quantity", i), "количество", i + 2),
        area: number(get(r, "area", i), "площадь", i + 2),
        site: get(r, "site", i),
        source: "Импорт CSV · печать",
      };
    });
  if (kind === "stock")
    data.stock = rows.map((r, i) => ({
      article: get(r, "article", i).toUpperCase(),
      cell: get(r, "cell", i),
      quantity: number(get(r, "quantity", i), "остаток", i + 2),
      date: date(get(r, "date", i), i + 2),
    }));
  if (kind === "assembly") data.shifts = [];
  return data;
}
