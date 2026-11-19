import JsBarcode from 'jsbarcode';
import { missingLabelFields, type LabelProduct } from '../shared/product-label-fields';

const pixelsPerMm = 12;
const width = 58 * pixelsPerMm;
const height = 40 * pixelsPerMm;

function linesThatFit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let remaining = text.trim().replace(/\s+/g, ' ');
  while (remaining && lines.length < maxLines) {
    if (ctx.measureText(remaining).width <= maxWidth) {
      lines.push(remaining);
      break;
    }
    const last = lines.length === maxLines - 1;
    const suffix = last ? '…' : '';
    let end = remaining.length - 1;
    while (end > 1 && ctx.measureText(remaining.slice(0, end) + suffix).width > maxWidth) end--;
    const space = remaining.lastIndexOf(' ', end);
    if (!last && space > 0) end = space;
    lines.push(remaining.slice(0, end).trimEnd() + suffix);
    remaining = remaining.slice(end).trimStart();
  }
  return lines;
}

export async function generateProductLabel(product: LabelProduct): Promise<Blob> {
  const missing = missingLabelFields(product);
  if (missing.length) throw new Error(`Для генерации заполните: ${missing.join(', ')}.`);
  const barcode = product.barcode.trim();
  const ozon = product.market === 'OZON';
  if (!ozon && !/^[A-Za-z0-9/*+@%&$!=(){}\[\]-]{1,30}$/.test(barcode)) {
    throw new Error('Не удалось использовать штрихкод WB. Проверьте его в карточке маркетплейса или загрузите готовую этикетку.');
  }
  const ean = ozon && /^\d{13}$/.test(barcode) ? 'EAN13' : ozon && /^\d{8}$/.test(barcode) ? 'EAN8' : null;
  if (ozon && !ean && !/^OZN\d{9,10}$/.test(barcode)) {
    throw new Error('Для Ozon укажите штрихкод OZN или EAN из карточки маркетплейса либо загрузите готовую этикетку.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('В браузере недоступна генерация изображения.');

  const bars = document.createElement('canvas');
  const options = { format: ean ?? 'CODE128', displayValue: false, margin: 0, height: 208 };
  try {
    JsBarcode(bars, barcode, { ...options, width: 1 });
  } catch {
    throw new Error('Штрихкод не прошёл проверку. Сверьте его с карточкой маркетплейса.');
  }
  // Keep bars on whole pixels and retain at least ten modules of white space on each side.
  const moduleWidth = Math.min(8, Math.floor(width / (bars.width + 20)));
  if (moduleWidth < 4) {
    throw new Error('Штрихкод слишком длинный для этикетки 58 × 40 мм. Загрузите готовую этикетку.');
  }
  JsBarcode(bars, barcode, { ...options, width: moduleWidth });

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000';
  const padding = 36;
  const textWidth = width - padding * 2;
  ctx.drawImage(bars, Math.floor((width - bars.width) / 2), 30);
  ctx.textAlign = 'center';
  ctx.font = '50px Arial';
  ctx.fillText(barcode, width / 2, 282, textWidth);

  const shop = `(${product.store.trim()})`;
  const sku = `Артикул: ${product.sku.trim()}`;
  ctx.textAlign = 'left';
  if (ozon) {
    ctx.font = '29px Arial';
    linesThatFit(ctx, product.name, textWidth, 3).forEach((line, index) => ctx.fillText(line, padding, 322 + index * 36));
    ctx.fillText(sku, padding, 436, textWidth - 74);
    ctx.textAlign = 'right';
    ctx.font = 'bold 29px Arial';
    ctx.fillText(shop, width - padding, 436, 64);
  } else {
    ctx.font = '42px Arial';
    ctx.fillText(sku, padding, 352, textWidth);
    ctx.fillText(`Размер: ${product.packaging.trim()} ${shop}`, padding, 422, textWidth);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось создать PNG этикетки.')), 'image/png');
  });
}
