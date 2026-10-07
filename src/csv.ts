function parse<T extends Record<string, string>>(
  input: string,
  _options?: unknown,
) {
  const text = input.replace(/^\ufeff/, "");
  const first = text.split(/\r?\n/)[0];
  const delimiter =
    (first.match(/;/g) || []).length > (first.match(/,/g) || []).length
      ? ";"
      : first.includes("\t")
        ? "\t"
        : ",";
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const errors: { message: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === '"' && !field && !closed) {
      quoted = true;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      closed = false;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((v) => v.trim())) records.push(row);
      row = [];
      field = "";
      closed = false;
      continue;
    }
    if (closed && c.trim())
      errors.push({ message: "Символы после закрывающей кавычки." });
    field += c;
  }
  if (quoted) errors.push({ message: "Незакрытые кавычки." });
  row.push(field);
  if (row.some((v) => v.trim())) records.push(row);
  const fields = (records.shift() || []).map((s) => s.trim());
  if (fields.some((h) => !h) || new Set(fields).size !== fields.length)
    errors.push({ message: "Пустые или повторяющиеся заголовки." });
  const data = records.map((values) => {
    if (values.length !== fields.length)
      errors.push({ message: "Количество полей не совпадает с заголовками." });
    return Object.fromEntries(fields.map((h, i) => [h, values[i] || ""])) as T;
  });
  return { data, errors, meta: { fields } };
}
export default { parse };
