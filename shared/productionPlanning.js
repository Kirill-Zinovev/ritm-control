// Planning metadata only. This module never changes production quantities.
export const RESOURCE_IDS = [
  "2-go",
  "uv",
  "uv-white",
  "uv-double",
  "uv-flatbed",
  "dtf",
  "xerox",
  "cut-roll",
  "cut-box",
  "packing",
];
export function validateDeadlines(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) => !["readyAt", "packingAt", "shipAt"].includes(k),
    )
  )
    throw new Error("Проверьте даты готовности и отгрузки.");
  const result = {};
  for (const key of ["readyAt", "packingAt", "shipAt"]) {
    if (key === "packingAt" && !Object.hasOwn(value, key)) continue;
    const v = value[key];
    if (v === "" || v === null || v === undefined) {
      result[key] = null;
      continue;
    }
    if (
      typeof v !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        v,
      ) ||
      !Number.isFinite(Date.parse(v)) ||
      Date.parse(v) < Date.UTC(2020, 0, 1) ||
      Date.parse(v) > Date.UTC(2100, 0, 1)
    )
      throw new Error("Укажите дату и время с часовым поясом.");
    const [year, month, day] = v.slice(0, 10).split("-").map(Number);
    if (
      new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day ||
      Number(v.slice(11, 13)) > 23 ||
      Number(v.slice(14, 16)) > 59
    )
      throw new Error("Такой даты или времени нет в календаре.");
    result[key] = new Date(v).toISOString();
  }
  if (result.readyAt && result.shipAt && result.readyAt > result.shipAt)
    throw new Error(
      "Готовность печати и порезки должна быть не позже отгрузки.",
    );
  if (result.packingAt && result.readyAt && result.packingAt < result.readyAt)
    throw new Error(
      "Срок упаковки должен быть не раньше готовности печати и порезки.",
    );
  if (result.packingAt && result.shipAt && result.packingAt > result.shipAt)
    throw new Error("Упаковка должна быть готова не позже отгрузки.");
  return result;
}
export function validateResources(value) {
  if (!Array.isArray(value) || value.length > RESOURCE_IDS.length)
    throw new Error("Проверьте список участков.");
  const seen = new Set();
  return value.map((r) => {
    if (
      !r ||
      !RESOURCE_IDS.includes(r.id) ||
      seen.has(r.id) ||
      Object.keys(r).some(
        (k) =>
          !["id", "rate", "rateMode", "unit", "days", "start", "end"].includes(
            k,
          ),
      )
    )
      throw new Error("Неизвестный или повторный участок.");
    seen.add(r.id);
    if (
      !Number.isFinite(r.rate) ||
      (r.rateMode === "auto" ? r.rate < 0 : r.rate <= 0) ||
      r.rate > 1e7 ||
      (r.rateMode !== undefined && !["manual", "auto"].includes(r.rateMode)) ||
      !(
        r.id === "packing"
          ? ["pieces"]
          : ["pieces", "area", ...(r.id === "xerox" ? ["sheets"] : [])]
      ).includes(r.unit)
    )
      throw new Error("Укажите положительную скорость и единицу участка.");
    if (
      !Array.isArray(r.days) ||
      !r.days.length ||
      r.days.length > 7 ||
      new Set(r.days).size !== r.days.length ||
      r.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    )
      throw new Error("Выберите рабочие дни.");
    if (
      !Number.isInteger(r.start) ||
      !Number.isInteger(r.end) ||
      r.start < 0 ||
      r.end > 1440 ||
      r.start >= r.end
    )
      throw new Error(
        "Укажите начало и конец смены в пределах суток. Для ночной смены разделите работу на дневные окна.",
      );
    return {
      id: r.id,
      rate: r.rate,
      ...(r.rateMode ? { rateMode: r.rateMode } : {}),
      unit: r.unit,
      days: [...r.days].sort(),
      start: r.start,
      end: r.end,
    };
  });
}
export const emptyPlanning = () => ({
  revision: 0,
  resources: [],
  deadlines: {},
  updatedAt: null,
  updatedBy: null,
});
