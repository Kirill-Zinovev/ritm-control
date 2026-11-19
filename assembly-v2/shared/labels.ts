import type { Market } from "./model";

export const labelFileLimit = 2 * 1024 * 1024;
export const labelBatchLimit = 150;
export const labelCopyLimit = 1000;
export const labelArticle = (value: string, market: Market): string => {
  const sku = value.trim().toLocaleUpperCase("ru-RU");
  const suffix = market === "OZON" ? "(OZ)" : "(WB)";
  return sku.endsWith(suffix) ? sku.slice(0, -suffix.length).trim() : sku;
};
export const labelFileId = (value: string): boolean => /^[A-Za-z0-9_-]{10,100}$/.test(value);
export type LabelMime = "image/png" | "image/jpeg" | "image/webp";
export function labelMime(bytes: Uint8Array): LabelMime | null {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const ascii = (start: number, value: string) => [...value].every((v, i) => bytes[start + i] === v.charCodeAt(0));
  return ascii(0, "RIFF") && ascii(8, "WEBP") ? "image/webp" : null;
}
export type StoredLabelStatus = "found" | "conflict" | "file_unavailable" | "unsupported_format" | "file_too_large";
export interface LabelSourceRow {
  spreadsheetId: string;
  sheet: string;
  row: number;
  rawSku: string;
  fileId: string;
}
export interface LabelEntry {
  market: Market;
  sku: string;
  status: StoredLabelStatus;
  fileIds: string[];
  sha256: string | null;
  sources: LabelSourceRow[];
}
export interface LabelManifest {
  version: 1;
  sourceHash: string;
  capturedAt: string;
  entries: number;
  chunks: Array<{ sha256: string; count: number }>;
}
export type LabelStatus = StoredLabelStatus | "missing" | "barcode_only" | "not_configured";
export interface PrintableLabel {
  positionId: string;
  sku: string;
  name: string;
  market: Market;
  status: LabelStatus;
  imageUrl?: string;
  originalUrl?: string;
}
export const labelStatusText: Record<LabelStatus, string> = {
  found: "Этикетка найдена в базе",
  conflict: "Найдено несколько разных файлов. Нужна сверка.",
  file_unavailable: "Оригинал этикетки недоступен. Нужна проверка файла.",
  unsupported_format: "Формат оригинала не поддерживается для печати.",
  file_too_large: "Оригинал этикетки превышает допустимый размер.",
  missing: "Этикетка не найдена для этого артикула.",
  barcode_only: "Готовый файл не найден. В базе есть только штрихкод.",
  not_configured: "База этикеток ещё не подключена.",
};
export function validLabelCopies(value: string): boolean {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 999;
}
