import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import { createSign } from "node:crypto";
export const SHEETS_READ_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets.readonly";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
export class SheetsAccessError extends Error {
  constructor(code, status = null) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export class GoogleSheetsReader {
  constructor({
    credentialsFile = "",
    fetcher = fetch,
    timeoutMs = 25000,
    retries = 2,
    now = () => Date.now(),
  } = {}) {
    this.credentialsFile = credentialsFile;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.now = now;
    this.cached = null;
    this.pending = null;
  }
  get configured() {
    return !!this.credentialsFile;
  }
  async request(url, options) {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const response = await this.fetcher(url, options);
        if (
          response.ok ||
          ![429, 500, 502, 503, 504].includes(response.status) ||
          attempt === this.retries
        )
          return response;
      } catch (error) {
        if (options.signal?.aborted || attempt === this.retries)
          throw new SheetsAccessError("network_unavailable");
      }
      await delay(250 * 2 ** attempt, undefined, { signal: options.signal });
    }
  }
  async accessToken(signal) {
    if (!this.configured) throw new SheetsAccessError("not_configured");
    if (this.cached && this.cached.expires > this.now() + 60000)
      return this.cached.token;
    if (this.pending) return this.pending;
    this.pending = this.mint(signal);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  async mint(signal) {
    let filename, root;
    try {
      filename = fs.realpathSync(path.resolve(this.credentialsFile));
      root = fs.realpathSync(process.cwd());
    } catch {
      throw new SheetsAccessError("credentials_unreadable");
    }
    const folded = filename.toLowerCase(),
      repo = root.toLowerCase();
    if (folded === repo || folded.startsWith(repo + path.sep))
      throw new SheetsAccessError("credentials_must_be_outside_repository");
    let key;
    try {
      key = JSON.parse(
        fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""),
      );
    } catch {
      throw new SheetsAccessError("credentials_unreadable");
    }
    if (
      key.type !== "service_account" ||
      !key.client_email ||
      !key.private_key ||
      (key.token_uri && key.token_uri !== tokenEndpoint)
    )
      throw new SheetsAccessError("invalid_service_account");
    const base64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url"),
      seconds = Math.floor(this.now() / 1000);
    const data =
      base64({ alg: "RS256", typ: "JWT" }) +
      "." +
      base64({
        iss: key.client_email,
        scope: SHEETS_READ_SCOPE,
        aud: tokenEndpoint,
        iat: seconds,
        exp: seconds + 3600,
      });
    let signature;
    try {
      signature = createSign("RSA-SHA256")
        .update(data)
        .sign(key.private_key, "base64url");
    } catch {
      throw new SheetsAccessError("invalid_private_key");
    }
    const response = await this.fetcher(tokenEndpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: data + "." + signature,
      }).toString(),
      signal: AbortSignal.any(
        [signal, AbortSignal.timeout(this.timeoutMs)].filter(Boolean),
      ),
    });
    if (!response.ok)
      throw new SheetsAccessError("authorization_failed", response.status);
    const value = await response.json();
    if (
      typeof value.access_token !== "string" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in < 60 ||
      (value.scope &&
        value.scope.split(" ").some((s) => s !== SHEETS_READ_SCOPE))
    )
      throw new SheetsAccessError("invalid_token_response");
    this.cached = {
      token: value.access_token,
      expires: this.now() + value.expires_in * 1000,
    };
    return this.cached.token;
  }
  async get(documentId, params, signal) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(documentId))
      throw new SheetsAccessError("invalid_document");
    const token = await this.accessToken(signal),
      url = new URL(
        "https://sheets.googleapis.com/v4/spreadsheets/" + documentId,
      );
    for (const [k, values] of Object.entries(params))
      for (const v of Array.isArray(values) ? values : [values])
        url.searchParams.append(k, v);
    const response = await this.fetcher(url, {
      method: "GET",
      redirect: "error",
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.any(
        [signal, AbortSignal.timeout(this.timeoutMs)].filter(Boolean),
      ),
    });
    if (!response.ok) {
      if (response.status === 401) this.cached = null;
      throw new SheetsAccessError("sheets_unavailable", response.status);
    }
    const text = await response.text();
    if (text.length > 12000000)
      throw new SheetsAccessError("response_too_large");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new SheetsAccessError("invalid_sheets_response");
    }
    if (value.spreadsheetId !== documentId || !Array.isArray(value.sheets))
      throw new SheetsAccessError("invalid_sheets_response");
    return value;
  }
  metadata(id, signal) {
    return this.get(
      id,
      {
        fields:
          "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),merges),namedRanges",
      },
      signal,
    );
  }
  grid(id, ranges, signal) {
    if (
      !Array.isArray(ranges) ||
      !ranges.length ||
      ranges.length > 30 ||
      ranges.some(
        (r) =>
          !/^'(?:[^']|'')+'![A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*$/.test(r),
      )
    )
      throw new SheetsAccessError("bounded_ranges_required");
    return this.get(
      id,
      {
        ranges,
        fields:
          "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue))))",
      },
      signal,
    );
  }
}
