// Operator-only check: OAuth and permissions; NEVER writes a Google cell.
import { ProductionSheetsWriter } from "../agent/productionRepair.js";
import { PRODUCTION_DOCTOR_DOCUMENTS } from "../agent/productionRegistry.js";
try {
  const writer = new ProductionSheetsWriter({
    credentialsFile: process.argv[2],
    writerEmail: process.argv[3],
  });
  const access = [];
  for (const doc of PRODUCTION_DOCTOR_DOCUMENTS) {
    const tab = doc.sheets[0];
    try {
      const result = await writer.verifyIsolation({
        documentId: doc.documentId,
        sheetId: tab.gid,
        sheet: tab.name,
        cell: "A1",
      });
      access.push({ name: doc.name, canEdit: result.canEdit });
    } catch (e) {
      const nextStep =
        e.code === "writer_document_not_found" ||
        e.code === "writer_sheets_forbidden"
          ? `Если ID документа верный, добавь ${writerEmail} в доступ к этому документу с ролью «Редактор». Это не меняет доступ сотрудников.`
          : e.code === "sheets_api_disabled"
            ? "Включи Google Sheets API в проекте ritm-intelligence и повтори запуск."
            : "Проверь статус Google API и повтори запуск позже.";
      throw Object.assign(
        new Error(
          `Документ «${doc.name}»: ${e.code ? e.message : "Google API не подтвердил доступ аккаунта записи"}. ${nextStep}`,
        ),
        { writerCheckReported: true },
      );
    }
  }
  const verified = access.filter((item) => item.canEdit === true).length;
  const unverified = access.length - verified;
  process.stdout.write(
    `OAuth и доступ к документам через Google API подтверждены: ${access.length}. Право записи проверено Drive API: ${verified}/${access.length}. Не проверено заранее: ${unverified}. В этих случаях точечную запись проверит Sheets API только после подтверждения в AI Center. Записей Google: 0.\n`,
  );
} catch (e) {
  process.stderr.write(
    (e.writerCheckReported
      ? e.message
      : e.code
        ? e.message
        : "Не удалось получить проверку прав Google Drive") + "\n",
  );
  process.exitCode = 1;
}
