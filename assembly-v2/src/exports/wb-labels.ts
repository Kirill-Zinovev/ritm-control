import { PDFDocument, grayscale } from "pdf-lib";
import qrcode from "qrcode-generator";
import type { OzonGroup } from "../../shared/ozon-shipment";
import { isWbPrintCode } from "../../shared/wb-shipment";

const mm = (value: number) => value * 72 / 25.4;

function labelCaption(box: string, code: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 320;
  const context = canvas.getContext("2d");
  if (!context) throw Error("Не удалось подготовить подписи этикеток.");
  const lines = code.match(/.{1,14}/gu) ?? [];
  const gap = Math.min(32, 245 / Math.max(1, lines.length));
  const start = (canvas.height - (52 + gap * lines.length)) / 2;
  context.fillStyle = "#000";
  context.textBaseline = "top";
  context.font = "bold 45px Arial, sans-serif";
  context.fillText(box, 0, start, canvas.width);
  context.font = `${Math.min(26, gap - 4)}px Arial, sans-serif`;
  lines.forEach((line, index) => context.fillText(line, 0, start + 52 + gap * index, canvas.width));
  return canvas.toDataURL("image/png");
}

export async function wbLabelsPdf(group: OzonGroup) {
  const labels = group.labels;
  if (!labels || labels.printCodes?.length !== group.boxes.length || !labels.printCodes.every(isWbPrintCode))
    throw Error("Сначала загрузите QR для всех коробов из файла WB.");
  const pdf = await PDFDocument.create();
  pdf.setTitle("QR коробов WB");
  for (const [index, value] of labels.printCodes.entries()) {
    const qr = qrcode(0, "M");
    qr.addData(value, "Byte");
    qr.make();
    const page = pdf.addPage([mm(58), mm(40)]);
    const size = qr.getModuleCount();
    const step = mm(32) / (size + 8);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (qr.isDark(row, col)) page.drawRectangle({
          x: mm(2) + (col + 4) * step, y: mm(4) + (size + 3 - row) * step,
          width: step, height: step, color: grayscale(0),
        });
      }
    }
    const caption = await pdf.embedPng(labelCaption(group.boxes[index].label, labels.codes[index]));
    page.drawImage(caption, { x: mm(35), y: mm(4), width: mm(21), height: mm(32) });
  }
  return pdf.save();
}

export async function downloadWbLabels(group: OzonGroup) {
  const bytes = await wbLabelsPdf(group);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `WB — Этикетки коробов — ${group.dispatch.label}.pdf`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
