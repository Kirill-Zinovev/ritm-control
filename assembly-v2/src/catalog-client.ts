import type { CatalogBundle } from "../shared/catalog";
export async function catalogRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(value.error ?? "Не удалось загрузить справочник.");
  return value;
}
export async function uploadCatalog(
  bundle: CatalogBundle,
  files: File[],
  progress: (text: string) => void,
): Promise<void> {
  // Each retry carries the exact same import/chunk identity. Already accepted chunks are skipped.
  const started = await catalogRequest<{ received: string[] }>(
    "/api/catalog/import/start",
    { id: bundle.id, manifest: bundle.manifest },
  );
  const received = new Set(started.received);
  for (const source of bundle.manifest.sources) {
    const file = files.find(
      (f) => f.name === source.name && f.size === source.bytes,
    );
    if (!file) throw new Error(`Выберите исходный файл «${source.name}».`);
    progress(`Сохраняем исходный файл: ${source.name}`);
    const response = await fetch(
      `/api/catalog/source?import=${bundle.id}&role=${source.role}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      },
    );
    if (!response.ok)
      throw new Error(
        (await response.json()).error ?? "Исходный Excel не сохранён.",
      );
  }
  let done = 0;
  for (const chunk of bundle.chunks) {
    done++;
    progress(`Переносим справочник: пакет ${done} из ${bundle.chunks.length}`);
    if (received.has(`${chunk.meta.kind}:${chunk.meta.part}`)) continue;
    for (let attempt = 0; ; attempt++) {
      try {
        await catalogRequest("/api/catalog/import/chunk", {
          id: bundle.id,
          kind: chunk.meta.kind,
          part: chunk.meta.part,
          data: chunk.data,
        });
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
    }
  }
  progress("Проверяем полноту и включаем новую версию справочника…");
  await catalogRequest("/api/catalog/import/activate", { id: bundle.id });
}
export const catalogPhotoUrl = (
  importId: string,
  id: string,
  index = 0,
): string =>
  `/api/catalog/photo?import=${encodeURIComponent(importId)}&id=${encodeURIComponent(id)}&index=${index}`;
export const sourcePhotoUrl = (source: string): string =>
  `/api/catalog/photo?source=${encodeURIComponent(source)}`;
