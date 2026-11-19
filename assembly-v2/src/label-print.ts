import { labelBatchLimit, labelCopyLimit, type PrintableLabel } from "../shared/labels";

export interface LabelPrintItem { label: PrintableLabel; copies: number }
export function validateLabelPrint(items: LabelPrintItem[], origin: string): void {
  if (!items.length || items.length > labelBatchLimit) throw new Error("Выберите от 1 до 150 этикеток.");
  let total = 0;
  for (const { label, copies } of items) {
    if (label.status !== "found" || !Number.isSafeInteger(copies) || copies < 1 || copies > 999) throw new Error("Проверьте оригиналы и количество копий.");
    const url = new URL(label.imageUrl || "", origin);
    if (url.origin !== origin || !(url.pathname === "/api/catalog/media" || (url.pathname === "/api/labels/image" && /^labels:[a-f0-9]{64}$/.test(url.searchParams.get("import") || ""))) || url.username || url.password || url.hash || !/^[a-f0-9]{64}$/.test(url.searchParams.get("sha256") || "")) throw new Error("Неверная ссылка на оригинал этикетки.");
    total += copies;
  }
  if (total > labelCopyLimit) throw new Error("Для одной печати выберите не более 1 000 копий.");
}

const printCss = `@page{size:auto;margin:0}html,body{width:100%;height:100%;margin:0;padding:0}.label-page{display:flex;justify-content:center;align-items:center;break-after:page;page-break-after:always;width:100%;height:100vh;min-height:0}.label-page:last-child{break-after:auto;page-break-after:auto}img{display:block;max-width:100vw;max-height:100vh;width:auto;height:auto;object-fit:contain}@media print{html,body{margin:0!important;padding:0!important}.label-page{break-inside:avoid;page-break-inside:avoid}}`;

export async function printLabelCopies(items: LabelPrintItem[]): Promise<void> {
  validateLabelPrint(items, location.origin);
  const popup = window.open("", "_blank");
  if (!popup) throw new Error("Разрешите всплывающее окно для диалога печати и повторите попытку.");
  try {
    popup.opener = null;
    const doc = popup.document;
    doc.open();
    doc.write('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Этикетки — Assembly</title></head><body></body></html>');
    doc.close();
    const style = doc.createElement("style");
    style.textContent = printCss;
    doc.head.append(style);
    const originals = await Promise.all(items.map(async ({ label }) => {
      const image = doc.createElement("img");
      image.alt = label.sku;
      image.src = new URL(label.imageUrl!, location.origin).href;
      image.referrerPolicy = "no-referrer";
      let timer = 0;
      try {
        await Promise.race([
          image.decode(),
          new Promise<never>((_, reject) => { timer = popup.setTimeout(() => reject(new Error("Оригинал этикетки не загрузился. Повторите попытку.")), 20000); }),
        ]);
      } finally { popup.clearTimeout(timer); }
      return image;
    }));
    items.forEach(({ copies }, index) => {
      for (let copy = 0; copy < copies; copy++) {
        const page = doc.createElement("div");
        page.className = "label-page";
        page.append(originals[index].cloneNode(true));
        doc.body.append(page);
      }
    });
    await Promise.all([...doc.images].map(image => image.decode()));
    if (popup.closed) throw new Error("Окно печати закрыто. Повторите попытку.");
    popup.focus();
    popup.print();
  } catch {
    popup.close();
    throw new Error("Не удалось подготовить оригиналы этикеток. Повторите попытку.");
  }
}
