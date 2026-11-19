import { parseCatalog } from "../shared/catalog-excel";
self.onmessage = async (
  event: MessageEvent<{
    base: { name: string; bytes: Uint8Array };
    photos: { name: string; bytes: Uint8Array };
  }>,
) => {
  try {
    const { base, photos } = event.data;
    const bundle = await parseCatalog(base, photos, (text) =>
      self.postMessage({ progress: text }),
    );
    self.postMessage({ bundle });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error ? error.message : "Не удалось прочитать Excel.",
    });
  }
};
