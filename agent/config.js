import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_DOCTOR_DOCUMENTS,
  validateDoctorDocuments,
} from "./doctorRegistry.js";
import { DEMO_DOCUMENT } from "./doctorDemo.js";
import { DEFAULT_SOURCES, validateRegistry } from "./registry.js";
function number(env, key, fallback, min, max) {
  const n =
    env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error("Invalid configuration: " + key);
  return n;
}
export function loadConfig(env = process.env) {
  const dataDir = path.resolve(
    env.RITM_DATA_DIR ||
      path.join(
        env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
        "RITMIntelligence",
      ),
  );
  const apiBase = env.RITM_BASE_URL || "";
  if (apiBase) {
    const u = new URL(apiBase);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !["https:", "http:"].includes(u.protocol) ||
      (u.protocol === "http:" &&
        !["127.0.0.1", "localhost"].includes(u.hostname))
    )
      throw new Error(
        "RITM_BASE_URL must be HTTPS or local loopback, without credentials or query",
      );
  }
  const port = number(env, "RITM_AGENT_PORT", 4318, 1024, 65535);
  const allowedOrigins = [
    "http://127.0.0.1:" + port,
    "http://localhost:" + port,
  ];
  if (env.RITM_DEV_ORIGIN) {
    const u = new URL(env.RITM_DEV_ORIGIN);
    if (
      u.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(u.hostname) ||
      u.origin !== env.RITM_DEV_ORIGIN
    )
      throw new Error("Dev origin must be a loopback origin");
    allowedOrigins.push(u.origin);
  }
  if (env.RITM_PUBLIC_ORIGIN) {
    const u = new URL(env.RITM_PUBLIC_ORIGIN);
    if (
      u.protocol !== "https:" ||
      u.origin !== env.RITM_PUBLIC_ORIGIN ||
      u.username ||
      u.password
    )
      throw new Error("Public origin must be an exact HTTPS origin");
    allowedOrigins.push(u.origin);
  }
  function secretFile(name) {
    if (!env[name]) return "";
    const filename = fs.realpathSync(path.resolve(env[name])),
      root = fs.realpathSync(process.cwd());
    if (filename.toLowerCase().startsWith(root.toLowerCase() + path.sep))
      throw new Error("Secret files must be outside repository");
    if (fs.statSync(filename).size > 8192)
      throw new Error("Invalid secret file size");
    return fs.readFileSync(filename, "utf8").trim();
  }
  const sources = validateRegistry(
    env.RITM_SOURCE_REGISTRY
      ? JSON.parse(
          fs.readFileSync(path.resolve(env.RITM_SOURCE_REGISTRY), "utf8"),
        )
      : DEFAULT_SOURCES,
  );
  const doctorDocuments = validateDoctorDocuments(
    env.RITM_DOCTOR_REGISTRY
      ? JSON.parse(
          fs
            .readFileSync(path.resolve(env.RITM_DOCTOR_REGISTRY), "utf8")
            .replace(/^\uFEFF/, ""),
        )
      : DEFAULT_DOCTOR_DOCUMENTS,
  );
  if (env.RITM_DOCTOR_DEMO_ENABLED === "true")
    doctorDocuments.push(validateDoctorDocuments([DEMO_DOCUMENT])[0]);
  return {
    doctorDocuments,
    googleCredentialsFile: env.RITM_GOOGLE_CREDENTIALS_FILE || "",
    doctorDemoEnabled: env.RITM_DOCTOR_DEMO_ENABLED === "true",
    dataDir,
    dbPath: path.join(dataDir, "intelligence.sqlite"),
    port,
    allowedOrigins,
    intervalMs:
      number(env, "RITM_CHECK_INTERVAL_SECONDS", 600, 60, 86400) * 1000,
    timeoutMs: number(env, "RITM_REQUEST_TIMEOUT_SECONDS", 25, 1, 120) * 1000,
    retries: number(env, "RITM_REQUEST_RETRIES", 2, 0, 5),
    googleMinIntervalMs: number(
      env,
      "RITM_GOOGLE_MIN_INTERVAL_MS",
      2000,
      1000,
      60000,
    ),
    slowApiMs: number(env, "RITM_SLOW_API_MS", 5000, 100, 120000),
    snapshotMaxAgeMs:
      number(env, "RITM_SNAPSHOT_MAX_AGE_SECONDS", 1200, 60, 86400) * 1000,
    apiBase: apiBase ? new URL(apiBase).origin : "",
    sources,
    ownerToken: env.RITM_OWNER_TOKEN || secretFile("RITM_OWNER_TOKEN_FILE"),
    publicOrigin: env.RITM_PUBLIC_ORIGIN || "",
    apiRateLimit: number(env, "RITM_API_RATE_LIMIT", 180, 60, 600),
    telegram: {
      enabled: env.RITM_TELEGRAM_ENABLED === "true",
      token:
        env.RITM_TELEGRAM_BOT_TOKEN || secretFile("RITM_TELEGRAM_TOKEN_FILE"),
      chatId: env.RITM_TELEGRAM_OWNER_CHAT_ID || "",
    },
    model: env.RITM_AI_MODEL || null,
    llmEnabled: false,
    staticDir: path.resolve("dist/client"),
  };
}
export function publicConfig(config) {
  return {
    permissionLevel: 1,
    writesEnabled: false,
    intervalSeconds: config.intervalMs / 1000,
    apiBase: config.apiBase || null,
    model: config.model,
    llm: "not_configured",
    telegram:
      config.telegram.enabled && config.telegram.token && config.telegram.chatId
        ? "configured"
        : "not_configured",
    formulaAccess: config.googleCredentialsFile
      ? "awaiting_verification"
      : "not_configured",
    doctorDocuments: (config.doctorDocuments || []).map((d) => ({
      id: d.id,
      name: d.name,
      department: d.department,
      enabled: d.enabled,
      demonstration: d.adapter === "fixture",
      sheets: d.sheets.length,
    })),
    doctorDemoEnabled: !!config.doctorDemoEnabled,
    deployment: config.publicOrigin ? "private_https_proxy" : "local",
    sources: config.sources,
    snapshotMaxAgeSeconds: config.snapshotMaxAgeMs / 1000,
  };
}
