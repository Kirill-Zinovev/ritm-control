import fs from "node:fs";
import path from "node:path";

const configPath = process.env.RITM_PRIVATE_CONFIG_PATH
  ? path.resolve(process.env.RITM_PRIVATE_CONFIG_PATH)
  : path.resolve(process.cwd(), "intelligence.local.json");

let localGoogleSources = {};
try {
  const parsed = JSON.parse(
    fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""),
  );
  localGoogleSources = parsed.googleSources || {};
} catch (error) {
  if (error?.code !== "ENOENT") throw new Error("Invalid local RITM private configuration");
}

const validDocumentId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(value)
    ? value
    : "";

export function privateGoogleSource(key) {
  const envName =
    "RITM_GOOGLE_" +
    key.replace(/[A-Z]/g, (letter) => "_" + letter).toUpperCase();
  return validDocumentId(process.env[envName] || localGoogleSources[key]);
}

export function privateGoogleUrl(key) {
  const value = process.env.RITM_ASSEMBLY_WEB_APP_URL || localGoogleSources[key];
  if (
    typeof value !== "string" ||
    !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,100}\/exec$/.test(
      value,
    )
  )
    return "";
  return value;
}

export function privateTestWriterEmail() {
  const value = localGoogleSources.testWriterEmail;
  return typeof value === "string" && /^[^\s@]+@[^\s@]+$/.test(value) ? value : "";
}

export function protectedProductionDocumentIds() {
  const ids = localGoogleSources.protectedProductionDocumentIds;
  return Array.isArray(ids) ? [...new Set(ids.map(validDocumentId).filter(Boolean))] : [];
}
