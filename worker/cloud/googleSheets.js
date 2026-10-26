import { CloudError } from "./access.js";
import { sourceIds, sourceId } from "./config.js";
import { cloudFetch } from "./fetch.js";

const tokenUrl = "https://oauth2.googleapis.com/token";
const readScope = "https://www.googleapis.com/auth/spreadsheets.readonly";
const writeScope = "https://www.googleapis.com/auth/spreadsheets";
const bytes = (value) => new TextEncoder().encode(value);
const base64url = (value) => {
  const array = value instanceof Uint8Array ? value : bytes(JSON.stringify(value));
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

export class CloudSheetsReader {
  constructor(bindings, { writer = false, fetcher = fetch, now = Date.now, beforeWrite = null } = {}) {
    this.bindings = bindings;
    this.writer = writer;
    this.fetcher = (...args) => cloudFetch(fetcher,...args);
    this.now = now;
    this.beforeWrite = beforeWrite;
    this.allowed = new Set(sourceIds(bindings));
    this.metrics = { readRequests: 0, writeRequests: 0, oauthRequests: 0 };
    this.cached = null;
    this.pending = null;
  }
  get configured() { return !!this.bindings[this.writer ? "RITM_GOOGLE_WRITER_JSON" : "RITM_GOOGLE_READER_JSON"] && this.allowed.size > 0; }
  async token(signal) { return this.accessToken(signal); }
  async accessToken(signal) {
    if (this.cached?.expires > this.now() + 60000) return this.cached.token;
    if (this.pending) return this.pending;
    this.pending = this.mint(signal);
    try { return await this.pending; } finally { this.pending = null; }
  }
  async mint(signal) {
    let account;
    try { account = JSON.parse(this.bindings[this.writer ? "RITM_GOOGLE_WRITER_JSON" : "RITM_GOOGLE_READER_JSON"] || ""); }
    catch { throw new CloudError("google_not_configured", "Подключение Google Sheets ещё не настроено."); }
    if (account.type !== "service_account" || !/^[^\s@]+@[^\s@]+$/.test(account.client_email || "") || !account.private_key || (account.token_uri && account.token_uri !== tokenUrl))
      throw new CloudError("google_credentials_invalid", "Не удалось подтвердить подключение Google Sheets.");
    const pem = account.private_key.replace(/-----[^-]+-----|\s/g, "");
    let key;
    try { key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]); }
    catch { throw new CloudError("google_credentials_invalid", "Не удалось подтвердить подключение Google Sheets."); }
    const seconds = Math.floor(this.now() / 1000);
    const unsigned = base64url({ alg: "RS256", typ: "JWT" }) + "." + base64url({ iss: account.client_email, scope: this.writer ? writeScope : readScope, aud: tokenUrl, iat: seconds, exp: seconds + 3600 });
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, bytes(unsigned));
    this.metrics.oauthRequests++;
    const response = await this.fetcher(tokenUrl, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + base64url(new Uint8Array(signature)) }), signal: signal || AbortSignal.timeout(25000) });
    if (!response.ok) throw new CloudError("google_authorization_failed", "Google не подтвердил доступ к таблицам.");
    const value = await response.json();
    if (typeof value.access_token !== "string" || !Number.isFinite(value.expires_in) || value.expires_in < 60 || (value.scope && value.scope !== (this.writer ? writeScope : readScope)))
      throw new CloudError("google_authorization_failed", "Google не подтвердил доступ к таблицам.");
    this.cached = { token: value.access_token, expires: this.now() + value.expires_in * 1000 };
    return value.access_token;
  }
  checkDocument(id) {
    if (this.writer && id === sourceId(this.bindings, "photosId")) throw new CloudError("source_read_only", "Справочник фотографий доступен только для чтения.", 403);
    if (!this.allowed.has(id)) throw new CloudError("source_not_allowed", "Этот источник не разрешён для облачного RITM.", 403);
  }
  async authenticatedFetch(input, init = {}) {
    const url = new URL(input);
    const match = url.hostname === "docs.google.com" && url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)\/(?:export|gviz\/tq)$/);
    if (!match || url.protocol !== "https:" || url.username || url.password || (init.method && init.method !== "GET"))
      throw new CloudError("source_url_rejected", "Адрес источника не разрешён.", 403);
    this.checkDocument(match[1]);
    const headers = new Headers(init.headers);
    headers.set("authorization", "Bearer " + await this.accessToken(init.signal));
    this.metrics.readRequests++;
    const response = await this.fetcher(url.href, { ...init, headers, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = new URL(response.headers.get("location") || "", url);
      if (target.protocol !== "https:" || target.username || target.password || !(target.hostname === "googleusercontent.com" || target.hostname.endsWith(".googleusercontent.com")))
        throw new CloudError("source_redirect_rejected", "Не удалось подтвердить ответ источника.");
      return this.fetcher(target.href, { method: "GET", redirect: "error", signal: init.signal });
    }
    return response;
  }
  async request(url, { method = "GET", body, write = false, signal } = {}) {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/v4\/spreadsheets\/([A-Za-z0-9_-]+)(?:[/:]|$)/);
    if (parsed.protocol !== "https:" || parsed.hostname !== "sheets.googleapis.com" || parsed.username || parsed.password || !match)
      throw new CloudError("sheets_url_rejected", "Запрос к таблице не разрешён.", 403);
    this.checkDocument(match[1]);
    if (write || method !== "GET") {
      if (!this.writer || typeof this.beforeWrite !== "function") throw new CloudError("cloud_write_disabled", "Запись в рабочие таблицы пока не включена.", 403);
      await this.beforeWrite(match[1]);
    }
    const token = await this.accessToken(signal);
    const response = await this.fetcher(parsed.href, { method, redirect: "error", headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal || AbortSignal.timeout(25000) });
    this.metrics[write ? "writeRequests" : "readRequests"]++;
    if (!response.ok) throw new CloudError("sheets_unavailable", "Google Sheets не подтвердил запрос.");
    return response;
  }
  async get(id, params, signal) {
    this.checkDocument(id);
    const url = new URL("https://sheets.googleapis.com/v4/spreadsheets/" + id);
    url.searchParams.set("prettyPrint", "false");
    for (const [key, values] of Object.entries(params)) for (const value of Array.isArray(values) ? values : [values]) url.searchParams.append(key, value);
    const response = await this.request(url.href, { signal });
    const text = await response.text();
    if (text.length > 12000000) throw new CloudError("source_too_large", "Ответ таблицы превышает разрешённый объём.");
    const value = JSON.parse(text);
    if (value.spreadsheetId !== id || !Array.isArray(value.sheets)) throw new CloudError("source_mismatch", "Google вернул другой документ.");
    return value;
  }
  async metadata(id, signal) {
    const value = await this.get(id, { fields: "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)),merges),namedRanges" }, signal);
    for (const sheet of value.sheets) sheet.merges ||= [];
    return value;
  }
  grid(id, ranges, signal) {
    if (!Array.isArray(ranges) || !ranges.length || ranges.length > 30 || ranges.some((range) => !/^'(?:[^']|'')+'![A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*$/.test(range)))
      throw new CloudError("bounded_ranges_required", "Нужен точный диапазон таблицы.", 400);
    return this.get(id, { ranges, fields: "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),merges,data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue))))" }, signal);
  }
}
