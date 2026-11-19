/** @param {unknown} value */
export function warehouseNumberKey(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
}

// Similar-looking Latin and Cyrillic characters can be typed in either layout.
// Callers must reject multiple physical cartons with the same visual key.
const LOOKALIKES = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };
/** @param {unknown} value */
export function warehouseVisualNumberKey(value) {
  return warehouseNumberKey(value).toLocaleUpperCase("ru-RU").replace(/[ABCEHKMOPTXY]/g, character => LOOKALIKES[character]);
}
