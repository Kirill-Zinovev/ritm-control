import JsBarcode from "jsbarcode";

type WbLabelProduct = {
  article: string;
  barcode: string;
  packaging: string;
  store: string;
};

// Keep the same WB canvas and Code 128 sizing used by the Assembly catalog editor.
export async function generateArkadyWbLabel(
  product: WbLabelProduct,
): Promise<Blob> {
  const barcode = product.barcode.trim();
  const article = product.article.trim();
  const packaging = product.packaging.trim();
  const store = product.store.trim();
  if (!article || !packaging || !store || !barcode) {
    throw new Error(
      "Для этикетки нужны штрихкод, артикул, упаковка и магазин.",
    );
  }
  if (!/^\d{6,30}$/.test(barcode)) {
    throw new Error(
      "Для этикетки WB 58 × 40 мм укажите штрихкод из 6–30 цифр.",
    );
  }

  const canvas = document.createElement("canvas");
  const width = 696;
  const height = 480;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("В браузере недоступна генерация изображения.");

  const bars = document.createElement("canvas");
  const options = {
    format: "CODE128",
    displayValue: false,
    margin: 0,
    height: 208,
  };
  try {
    JsBarcode(bars, barcode, { ...options, width: 1 });
  } catch {
    throw new Error("Штрихкод не прошёл проверку. Сверьте его с карточкой WB.");
  }
  const moduleWidth = Math.min(8, Math.floor(width / (bars.width + 20)));
  if (moduleWidth < 4) {
    throw new Error("Штрихкод слишком длинный для этикетки 58 × 40 мм.");
  }
  JsBarcode(bars, barcode, { ...options, width: moduleWidth });

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000";
  const padding = 36;
  const textWidth = width - padding * 2;
  ctx.drawImage(bars, Math.floor((width - bars.width) / 2), 30);
  ctx.textAlign = "center";
  ctx.font = "50px Arial";
  ctx.fillText(barcode, width / 2, 282, textWidth);
  ctx.textAlign = "left";
  ctx.font = "42px Arial";
  ctx.fillText(`Артикул: ${article}`, padding, 352, textWidth);
  ctx.fillText(`Размер: ${packaging} (${store})`, padding, 422, textWidth);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Не удалось создать PNG этикетки.")),
      "image/png",
    );
  });
}
