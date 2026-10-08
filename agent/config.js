import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
  const sources = validateRegistry(
    env.RITM_SOURCE_REGISTRY
      ? JSON.parse(
          fs.readFileSync(path.resolve(env.RITM_SOURCE_REGISTRY), "utf8"),
        )
      : DEFAULT_SOURCES,
  );
  return {
    dataDir,
    dbPath: path.join(dataDir, "intelligence.sqlite"),
    port,
    allowedOrigins,
    intervalMs:
      number(env, "RITM_CHECK_INTERVAL_SECONDS", 600, 60, 86400) * 1000,
    timeoutMs: number(env, "RITM_REQUEST_TIMEOUT_SECONDS", 25, 1, 120) * 1000,
    retries: number(env, "RITM_REQUEST_RETRIES", 2, 0, 5),
    slowApiMs: number(env, "RITM_SLOW_API_MS", 5000, 100, 120000),
    snapshotMaxAgeMs:
      number(env, "RITM_SNAPSHOT_MAX_AGE_SECONDS", 1200, 60, 86400) * 1000,
    apiBase: apiBase ? new URL(apiBase).origin : "",
    sources,
    ownerToken: env.RITM_OWNER_TOKEN || "",
    telegram: {
      enabled: env.RITM_TELEGRAM_ENABLED === "true",
      token: env.RITM_TELEGRAM_BOT_TOKEN || "",
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
    formulaAccess: "not_configured",
    deployment: "local",
    sources: config.sources,
    snapshotMaxAgeSeconds: config.snapshotMaxAgeMs / 1000,
  };
}
