import ExcelJS from "exceljs";
import {
  capacity,
  duplicateCapacity,
  catalogKey,
  catalogVersion,
  cleanCatalogText,
  digest,
  photoAllowed,
  spreadsheetError,
} from "./catalog";
import type {
  CatalogBundle,
  CatalogEntry,
  CatalogManifest,
  CatalogPhoto,
  CatalogRow,
  CatalogSource,
} from "./catalog";
import type { Market } from "./model";

const mappings: Record<Market, Record<string, string>> = {
  WB: {
    article: "A",
    alias: "B",
    barcode: "C",
    ozonBarcode: "D",
    name: "E",
    kind: "F",
    category: "G",
    printFolder: "H",
    department: "I",
    sheetsPerUnit: "J",
    size: "K",
    packaging: "L",
    machine: "M",
    boxType: "N",
    unitsPerBoxNumber: "O",
    unitsPerBoxText: "P",
    rollMultiplicity: "Q",
    xeroxMultiplicity: "R",
    photo: "S",
    store: "T",
  },
  OZON: {
    article: "A",
    alias: "B",
    name: "C",
    barcode: "D",
    kind: "E",
    sheetsPerUnit: "F",
    size: "G",
    packaging: "H",
    category: "I",
    printFolder: "J",
    boxType: "K",
    unitsPerBoxNumber: "L",
    unitsPerBoxText: "M",
    photo: "N",
    machine: "O",
    store: "P",
    rollMultiplicity: "Q",
    xeroxMultiplicity: "R",
  },
};
const expectedHeaders: Record<Market, string[]> = {
  WB: [
    "Артикул",
    "Артикул (oz)",
    "Баркод",
    "Баркод (OZ)",
    "Название",
    "Вид",
    "Вид товара",
    "Папка печати",
    "Кто печатает",
    "Кол-во листов",
    "Размер",
    "Упаковка",
    "Вид станка по умолчанию",
    "Тип короба",
    "Кол-во вида",
    "В коробке",
    "Кратность рулонная",
    "Кратность Xerox",
    "фото",
    "магазин",
  ],
  OZON: [
    "Артикул",
    "Артикул",
    "Наименование",
    "Баркод",
    "Вид",
    "Кол-во листов",
    "Размер",
    "Упаковка",
    "Вид товара",
    "Папка печати",
    "Тип короба",
    "Кол-во вида",
    "В коробке",
    "фото",
    "станок",
    "магазин",
    "Кратность рулонная",
    "Кратность Xerox",
  ],
};
// Formula results are read as data. Never execute source workbook formulas.
export function cellText(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? value.toFixed(0) : String(value);
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if ("formula" in value || "sharedFormula" in value)
    return cellText(value.result);
  if ("error" in value) return value.error;
  if ("richText" in value)
    return value.richText
      .map((v) => v.text)
      .join("")
      .trim();
  if ("text" in value) return String(value.text).trim();
  return "";
}
function urls(text: string): string[] {
  return [...new Set(text.split(/[;\s]+/).filter(photoAllowed))];
}
function consensus(rows: CatalogRow[], key: string): string {
  const values = [
    ...new Set(
      rows.map((r) => cleanCatalogText(r.raw[key] ?? "")).filter(Boolean),
    ),
  ];
  return values.length === 1 ? values[0] : "";
}
export async function parseCatalog(
  base: { name: string; bytes: Uint8Array },
  pictures: { name: string; bytes: Uint8Array },
  progress: (message: string) => void = () => {},
): Promise<CatalogBundle> {
  if (base.bytes.length > 12_000_000 || pictures.bytes.length > 12_000_000)
    throw new Error("Каждый Excel должен быть не больше 12 МБ.");
  const sources: CatalogSource[] = await Promise.all(
    [base, pictures].map(async (s, i) => ({
      role: i ? ("photos" as const) : ("base" as const),
      name: s.name,
      bytes: s.bytes.length,
      sha256: await digest(s.bytes),
    })),
  );
  progress("Читаем фотографии…");
  const photoBook = new ExcelJS.Workbook();
  await photoBook.xlsx.load(pictures.bytes as unknown as ExcelJS.Buffer);
  const sheet = photoBook.getWorksheet("Фото");
  if (!sheet || cellText(sheet.getCell("A1").value) !== "Артикул")
    throw new Error(
      "В файле фотографий нужен лист «Фото» с колонками Артикул, Магазин, Ссылки на фото, ссылка.",
    );
  const photoMap = new Map<string, CatalogPhoto>();
  sheet.eachRow((r, n) => {
    if (n === 1) return;
    const raw = [1, 2, 3, 4].map((c) => cellText(r.getCell(c).value));
    const sku = cleanCatalogText(raw[0]);
    if (!sku) return;
    const store = cleanCatalogText(raw[1]);
    const id = JSON.stringify([catalogKey(sku), store]);
    const p = photoMap.get(id) ?? {
      id,
      sku,
      store,
      primary: null,
      urls: [],
      sources: [],
    };
    const primary = urls(raw[3])[0] ?? urls(raw[2])[0] ?? null;
    if (p.primary && primary && p.primary !== primary)
      throw new Error(
        `Противоречивые основные фотографии: ${sku}, магазин ${store}.`,
      );
    p.primary ??= primary;
    p.urls = [...new Set([...p.urls, ...urls(raw[2]), ...urls(raw[3])])];
    p.sources.push({ sheet: "Фото", row: n, raw });
    photoMap.set(id, p);
  });
  const photos = [...photoMap.values()];
  // Photo-only articles are retained, including entries without a usable URL.
  const photoBySku = new Map<string, CatalogPhoto[]>();
  for (const p of photos)
    photoBySku.set(catalogKey(p.sku), [
      ...(photoBySku.get(catalogKey(p.sku)) ?? []),
      p,
    ]);
  progress("Читаем базу артикулов…");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(base.bytes as unknown as ExcelJS.Buffer);
  const groups = new Map<string, CatalogRow[]>();
  let sourceRows = 0;
  let capacityConflicts = 0;
  let userCorrections = 0;
  for (const market of ["WB", "OZON"] as const) {
    const s = book.getWorksheet(market);
    if (!s || cellText(s.getCell("A1").value) !== "Артикул")
      throw new Error(
        `В базе нужен лист «${market}» с исходным расположением столбцов.`,
      );
    expectedHeaders[market].forEach((header, index) => {
      if (
        catalogKey(cellText(s.getCell(1, index + 1).value)) !==
        catalogKey(header)
      )
        throw new Error(
          `В ${market} столбец ${index + 1} должен называться «${header}». Сохраните исходное расположение колонок.`,
        );
    });
    // Duplicate OZON headers A/B intentionally mapped by column, not name.
    for (const [key, col] of Object.entries(mappings[market])) {
      const header = cellText(s.getCell(`${col}1`).value);
      if (!header)
        throw new Error(`В ${market} отсутствует заголовок ${col} (${key}).`);
    }
    s.eachRow((r, n) => {
      if (n === 1) return;
      const raw = Object.fromEntries(
        Object.entries(mappings[market]).map(([k, c]) => [
          k,
          cellText(r.getCell(c).value),
        ]),
      );
      if (!cleanCatalogText(raw.article)) return;
      sourceRows++;
      const norm = capacity(raw, market);
      if (norm.conflict) capacityConflicts++;
      if (norm.source === "user") userCorrections++;
      const store = cleanCatalogText(raw.store);
      const id = JSON.stringify([market, store, catalogKey(raw.article)]);
      const rows = groups.get(id) ?? [];
      rows.push({
        sheet: market,
        row: n,
        raw,
        refs: Object.fromEntries(
          Object.entries(mappings[market]).map(([k, c]) => [
            k,
            `${market}!${c}${n}`,
          ]),
        ),
      });
      groups.set(id, rows);
    });
  }
  const entries: CatalogEntry[] = [];
  for (const [id, rows] of groups) {
    const market = rows[0].sheet;
    const sku = rows[0].raw.article;
    const store = cleanCatalogText(rows[0].raw.store);
    const aliases = [
      ...new Set(
        rows
          .flatMap((r) => [r.raw.article, cleanCatalogText(r.raw.alias)])
          .filter(Boolean)
          .map(catalogKey),
      ),
    ];
    const resolvedCapacity = duplicateCapacity(rows, market);
    const issues: string[] = [];
    if (rows.length > 1)
      issues.push(`Дубликаты: ${rows.length} исходных строк`);
    const unitsPerBox = resolvedCapacity.value;
    if (unitsPerBox === null)
      issues.push("Вместимость короба требует проверки");
    for (const key of [
      "name",
      "barcode",
      "kind",
      "category",
      "machine",
      "packaging",
      "size",
      "boxType",
      "sheetsPerUnit",
      "rollMultiplicity",
      "xeroxMultiplicity",
      "store",
    ]) {
      if (rows.some((r) => spreadsheetError(r.raw[key] ?? "")))
        issues.push(`Ошибка Excel: ${key}`);
      if (
        new Set(
          rows.map((r) => cleanCatalogText(r.raw[key] ?? "")).filter(Boolean),
        ).size > 1
      )
        issues.push(`Расхождение строк: ${key}`);
    }
    const direct = photoBySku.get(catalogKey(sku)) ?? [];
    const candidates = direct.length
      ? direct
      : aliases.flatMap((a) => photoBySku.get(a) ?? []);
    const scoped = candidates.filter((p) => store && p.store === store);
    const unique = [
      ...new Map(
        (scoped.length ? scoped : candidates).map((p) => [p.id, p]),
      ).values(),
    ];
    // An explicit article with one identical image across stores is safe to reuse;
    // conflicting store images remain unresolved. Store-specific product data never merges.
    const photo =
      new Set(unique.map((p) => p.primary)).size === 1 ? unique[0] : null;
    if (!photo?.primary) issues.push("Нет фотографии");
    const val = (k: string) => consensus(rows, k);
    for (const key of ["name", "barcode", "store", "machine"])
      if (!val(key)) issues.push(`Не заполнено поле: ${key}`);
    if (
      ["Бокс", "Рулонная печать", "Не найдено в базе"].includes(val("machine"))
    )
      issues.push(
        "Станок не определён: в Excel указан участок или ошибка поиска",
      );
    entries.push({
      id,
      market,
      store,
      sku,
      aliases,
      name: val("name"),
      barcode: val("barcode"),
      kind: val("kind"),
      category: val("category"),
      machine: val("machine"),
      packaging: val("packaging"),
      size: val("size"),
      sheetsPerUnit: val("sheetsPerUnit"),
      printFolder: val("printFolder"),
      catalogDepartment: val("department"),
      boxType: val("boxType"),
      unitsPerBox,
      rollMultiplicity: val("rollMultiplicity"),
      xeroxMultiplicity: val("xeroxMultiplicity"),
      capacitySource:
        unitsPerBox === null
          ? "review"
          : resolvedCapacity.source === "user"
            ? "user"
            : "consistent",
      photoId: photo?.primary ? photo.id : null,
      issues,
      rows,
    });
  }
  progress("Готовим проверяемые пакеты импорта…");
  const chunks: CatalogBundle["chunks"] = [];
  for (const [kind, items] of [
    ["entries", entries],
    ["photos", photos],
  ] as const) {
    for (let offset = 0; offset < items.length; offset += 50) {
      const data = JSON.stringify(items.slice(offset, offset + 50));
      chunks.push({
        meta: {
          kind,
          part: offset / 50,
          digest: await digest(data),
          count: Math.min(50, items.length - offset),
        },
        data,
      });
    }
  }
  const manifest: CatalogManifest = {
    version: catalogVersion,
    sources,
    entries: entries.length,
    photos: photos.length,
    sourceRows,
    capacityConflicts,
    userCorrections,
    chunks: chunks.map((c) => c.meta),
    decision:
      "OZON как ориентир; значения маркетплейсов раздельно. Только OZON SS0031.A7484(OZ), магазин 1: 700 шт., подтверждение пользователя 13.11.2026. Остальные расхождения отложены.",
  };
  return { id: await digest(JSON.stringify(manifest)), manifest, chunks };
}
