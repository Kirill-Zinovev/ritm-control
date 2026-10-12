// Dedicated test writer; production retains GoogleSheetsReader and read-only scope.
import fs from "node:fs";
import path from "node:path";
import { createSign } from "node:crypto";
export const TEST_TARGET = Object.freeze({
  documentId: "1U1Amv3-tYo8Ju8eL5T6Eu4T7-qsPm1WCfledNEeKvVg",
  sheetId: 231140854,
  sheet: "Проверка формулы",
  cell: "G247",
  formula: "=C247/D247",
  original: 150,
  result: 1.24,
});
export const TEST_WRITER_EMAIL =
  "ritm-test-writer@ritm-intelligence.iam.gserviceaccount.com";
export const TEST_WRITE_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly";
export const PRODUCTION_DOCUMENTS = Object.freeze([
  "1AuPraufSNHwEQHsVEwKR3dtiuEAqUgRrtZJDIQ9I5uo",
  "1eNdUuk-2l83Pgv95LyqYKuOOfhAsEMm5tKLbhWBJiC4",
]);
export class RepairError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export class TestSheetsWriter {
  constructor({
    credentialsFile,
    fetcher = fetch,
    now = () => Date.now(),
    timeoutMs = 25000,
    writerEmail = TEST_WRITER_EMAIL,
  }) {
    Object.assign(this, {
      credentialsFile,
      fetcher,
      now,
      timeoutMs,
      writerEmail,
    });
    this.cached = null;
    this.verifiedAt = null;
    this.metrics = { oauthRequests: 0, readRequests: 0, writeRequests: 0 };
  }
  credentials() {
    try {
      const filename = fs.realpathSync(this.credentialsFile);
      const repo = fs.realpathSync(process.cwd());
      const relative = path.relative(repo, filename);
      if (!relative.startsWith("..") && !path.isAbsolute(relative))
        throw new Error();
      const key = JSON.parse(
        fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""),
      );
      if (
        key.type !== "service_account" ||
        key.project_id !== "ritm-intelligence" ||
        key.client_email !== this.writerEmail ||
        !key.private_key ||
        (key.token_uri &&
          key.token_uri !== "https://oauth2.googleapis.com/token")
      )
        throw new Error();
      return key;
    } catch {
      throw new RepairError(
        "writer_credentials_invalid",
        "Некорректный отдельный ключ тестового аккаунта",
        503,
      );
    }
  }
  async token() {
    if (this.cached && this.cached.expires > this.now() + 60000)
      return this.cached.token;
    const key = this.credentials();
    const seconds = Math.floor(this.now() / 1000);
    const encode = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const assertion =
      encode({ alg: "RS256", typ: "JWT" }) +
      "." +
      encode({
        iss: key.client_email,
        scope: TEST_WRITE_SCOPE,
        aud: "https://oauth2.googleapis.com/token",
        iat: seconds,
        exp: seconds + 3600,
      });
    const signature = createSign("RSA-SHA256")
      .update(assertion)
      .sign(key.private_key, "base64url");
    this.metrics.oauthRequests++;
    let response;
    try {
      response = await this.fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: assertion + "." + signature,
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RepairError(
        "writer_oauth_unavailable",
        "OAuth тестового аккаунта недоступен",
        503,
      );
    }
    if (!response.ok)
      throw new RepairError(
        "writer_oauth_failed",
        "Не удалось авторизовать тестовый аккаунт",
        503,
      );
    const value = await response.json();
    if (
      typeof value.access_token !== "string" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in < 60 ||
      (value.scope &&
        value.scope
          .split(" ")
          .some((s) => !TEST_WRITE_SCOPE.split(" ").includes(s)))
    )
      throw new RepairError(
        "writer_token_invalid",
        "Некорректный ответ OAuth",
        503,
      );
    this.cached = {
      token: value.access_token,
      expires: this.now() + value.expires_in * 1000,
    };
    return this.cached.token;
  }
  async verifyIsolation() {
    const token = await this.token();
    this.verifiedAt = null;
    const capabilities = [];
    for (const id of [TEST_TARGET.documentId, ...PRODUCTION_DOCUMENTS]) {
      this.metrics.readRequests++;
      let response;
      try {
        response = await this.fetcher(
          "https://www.googleapis.com/drive/v3/files/" +
            id +
            "?fields=id,capabilities(canEdit)",
          {
            method: "GET",
            redirect: "error",
            headers: { authorization: "Bearer " + token },
            signal: AbortSignal.timeout(this.timeoutMs),
          },
        );
      } catch {
        throw new RepairError(
          "isolation_unverified",
          "Не удалось проверить права тестового аккаунта",
          503,
        );
      }
      if (id !== TEST_TARGET.documentId && response.status === 404) {
        capabilities.push({
          documentId: id,
          canEdit: false,
          access: "not_found",
        });
        continue;
      }
      if (!response.ok) {
        throw new RepairError(
          "drive_permission_audit_unavailable",
          "Проверка прав недоступна. Проверьте, что Google Drive API включён в проекте ritm-intelligence",
          503,
        );
      }
      const value = await response.json();
      if (value.id !== id || typeof value.capabilities?.canEdit !== "boolean")
        throw new RepairError(
          "isolation_unverified",
          "Google API не подтвердил эффективные права аккаунта",
          503,
        );
      capabilities.push({
        documentId: id,
        canEdit: value.capabilities.canEdit,
      });
      if (id === TEST_TARGET.documentId && !value.capabilities.canEdit)
        throw new RepairError(
          "test_document_unavailable",
          "Тестовый аккаунт не может редактировать тестовый документ",
          403,
        );
      if (id !== TEST_TARGET.documentId && value.capabilities.canEdit)
        throw new RepairError(
          "production_access_not_denied",
          "Изоляция не подтверждена: у тестового аккаунта есть право редактирования производства",
          403,
        );
    }
    this.verifiedAt = new Date(this.now()).toISOString();
    return {
      verifiedAt: this.verifiedAt,
      productionAccess: "write_denied",
      capabilities,
      ...this.metrics,
    };
  }
  async conditionalReplace(direction) {
    if (!["repair", "rollback"].includes(direction))
      throw new RepairError("invalid_direction", "Недопустимое изменение");
    if (!this.verifiedAt)
      throw new RepairError(
        "isolation_unverified",
        "Изоляция тестового аккаунта не проверена",
        403,
      );
    const token = await this.token();
    // Exact server-side match, ONE cell. Not typed CAS; dependencies remain unlocked.
    const request = {
      findReplace: {
        find: direction === "repair" ? "150" : TEST_TARGET.formula,
        replacement: direction === "repair" ? TEST_TARGET.formula : "150",
        matchCase: true,
        matchEntireCell: true,
        searchByRegex: false,
        includeFormulas: direction === "rollback",
        range: {
          sheetId: TEST_TARGET.sheetId,
          startRowIndex: 246,
          endRowIndex: 247,
          startColumnIndex: 6,
          endColumnIndex: 7,
        },
      },
    };
    this.metrics.writeRequests++;
    // NEVER retry: timeout can mean the write already happened.
    let response;
    try {
      response = await this.fetcher(
        "https://sheets.googleapis.com/v4/spreadsheets/" +
          TEST_TARGET.documentId +
          ":batchUpdate",
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ requests: [request] }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw new RepairError(
        "write_uncertain",
        "Результат записи неизвестен; автоматический повтор запрещён",
        503,
      );
    }
    if (!response.ok)
      throw new RepairError(
        "write_uncertain",
        "Запись не подтверждена Google API; повтор заблокирован",
        503,
      );
    let value;
    try {
      value = await response.json();
    } catch {
      throw new RepairError(
        "write_uncertain",
        "Ответ записи не подтверждён",
        503,
      );
    }
    const changed = value.replies?.[0]?.findReplace?.occurrencesChanged;
    if (changed === 0)
      throw new RepairError(
        "conditional_conflict",
        "Содержимое изменилось до записи: условная замена отменена",
      );
    if (changed !== 1 || value.spreadsheetId !== TEST_TARGET.documentId)
      throw new RepairError(
        "write_uncertain",
        "Неожиданный результат условной записи",
        503,
      );
    return { changed, ...this.metrics };
  }
}
