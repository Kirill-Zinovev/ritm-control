import { nextFastCheckDelay, nextScheduledCheck } from "./schedule.js";
process.umask(0o077);
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { IncidentStore } from "./store.js";
import { TableDoctor } from "./doctorService.js";
import { TestRepairService } from "./testRepair.js";
import { TestSheetsWriter } from "./testSheetsWriter.js";
import {
  ProductionRepairService,
  ProductionSheetsWriter,
} from "./productionRepair.js";
import { SourceRecoveryService } from "./sourceRecovery.js";
import {
  RollSupplyManagementService,
  RollSupplySheetsWriter,
} from "./rollSupply.js";
import { Monitor } from "./monitor.js";
import { createAgentServer } from "./server.js";
import { flushTelegram } from "./telegram.js";
import { RITMAssistant } from "./assistant.js";
import { TelegramAssistant } from "./telegramAssistant.js";
import { LocalSecretStore } from "./secretStore.js";

const config = loadConfig(),
  store = new IncidentStore(config.dbPath),
  owner = randomUUID();
if (!store.acquire(owner)) {
  store.close();
  throw new Error(
    "Другой процесс агента уже владеет этой базой; повторите запуск после истечения аренды (90 секунд).",
  );
}
store.setMonitoringScope(config.doctorDocuments, config.sources);
store.recoverNotifications();
const controller = new AbortController(),
  doctor = new TableDoctor(store, config),
  monitor = new Monitor(store, config, { googleReader: doctor.reader });
// The process owns the exclusive database lease above; only now is a persisted
// run from a dead prior agent safe to classify as interrupted.
doctor.recoverInterruptedRun();
const productionWriter = config.productionRepairEnabled
  ? new ProductionSheetsWriter({
      credentialsFile: config.productionWriterCredentialsFile,
      writerEmail: config.productionWriterEmail,
    })
  : null;
const repair = config.testWriterCredentialsFile
  ? new TestRepairService(store, config, {
      reader: doctor.reader,
      writer: new TestSheetsWriter({
        credentialsFile: config.testWriterCredentialsFile,
      }),
      doctor,
    })
  : productionWriter
    ? new ProductionRepairService(store, config, {
        reader: doctor.reader,
        writer: productionWriter,
        doctor,
      })
    : null;
const sourceRecovery = productionWriter
  ? new SourceRecoveryService(store, config, {
      reader: doctor.reader,
      writer: productionWriter,
      doctor,
    })
  : null;
const secretStore = new LocalSecretStore(config.dataDir);
const localSecrets = await secretStore.read();
config.assistant = {
  provider: localSecrets.provider || "openai",
  model: localSecrets.model || process.env.RITM_AI_MODEL || (localSecrets.provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini"),
  apiKey: localSecrets.llmApiKeys?.[localSecrets.provider || "openai"] || localSecrets.llmApiKey || "",
  spendLimitUsd: Number(localSecrets.spendLimitUsd) || 5,
  dailyRequestLimit: Number(localSecrets.dailyRequestLimit) || 50,
};
if (localSecrets.llmApiKey && !localSecrets.llmApiKeys?.openai) {
  localSecrets.llmApiKeys ||= {};
  localSecrets.llmApiKeys.openai = localSecrets.llmApiKey;
}
if (!config.telegram.token) config.telegram.token = localSecrets.telegramToken || "";
const assistant = new RITMAssistant({ store, config, doctor, sourceRecovery });
assistant.attachProductionRepair(repair);
const savedTelegramOwner = store.db.prepare("SELECT chat_id FROM assistant_owner WHERE id=1").get();
if (savedTelegramOwner) config.telegram.chatId = savedTelegramOwner.chat_id;
const telegramAssistant = new TelegramAssistant({ assistant, store });
if (config.telegram.token && !process.argv.includes("--once")) await telegramAssistant.setToken(config.telegram.token);
assistant.recoverCheckSubscriptions();
const rollSupplyService = new RollSupplyManagementService(store, {
  writer: productionWriter
    ? new RollSupplySheetsWriter({ credentialWriter: productionWriter })
    : null,
  refresh: async () => {
    const source = config.sources.find(
      (item) => item.adapter === "printing" && item.enabled,
    );
    if (!source) throw new Error("Printing monitor is not configured");
    const result = await monitor.source(source, controller.signal);
    if (!result.ok || result.partial)
      throw new Error("Printing snapshot could not be refreshed cleanly");
    return result;
  },
});
mkdirSync(config.dataDir, { recursive: true });
const logPath = path.join(config.dataDir, "agent.log");
function log(event) {
  if (existsSync(logPath) && statSync(logPath).size > 5_000_000)
    renameSync(logPath, logPath + ".previous");
  appendFileSync(
    logPath,
    JSON.stringify({ at: new Date().toISOString(), event }) + "\n",
  );
}
let server,
  timer,
  fastTimer,
  current,
  fastCurrent,
  stopped = false;
function heartbeat() {
  if (!store.acquire(owner)) {
    void stop();
    return;
  }
  store.meta("agent", {
    status: "running",
    pid: process.pid,
    heartbeatAt: new Date().toISOString(),
    nextCheckAt: store.meta("nextCheckAt"),
  });
}
const pulse = setInterval(heartbeat, 10000);
heartbeat();
store.log("agent_started", "Локальный агент запущен в режиме только чтение");
log("agent_started");
async function tick() {
  try {
    await rollSupplyService.syncRegisteredSheets();
    await Promise.all([
      monitor.run(controller.signal),
      doctor.run(controller.signal),
    ]);
    const notificationState = await flushTelegram(store, config.telegram, {
      signal: controller.signal,
      telegramAssistant,
    });
    store.meta("notifications", notificationState);
    log("check_completed");
  } catch {
    if (!controller.signal.aborted) {
      store.log(
        "agent_error",
        "Внутренняя ошибка проверки; следующая попытка запланирована",
      );
      log("check_error");
    }
  }
}
function scheduleFast(delayMs) {
  clearTimeout(fastTimer);
  if (!stopped)
    fastTimer = setTimeout(() => void fastLoop(), Math.max(0, delayMs));
}
async function fastLoop() {
  if (stopped || !doctor) return;
  const started = Date.now();
  fastCurrent = doctor.runFast(controller.signal);
  let nextDelay = config.fastCheckIntervalMs;
  try {
    const result = await fastCurrent;
    const notificationState = await flushTelegram(store, config.telegram, {
      signal: controller.signal,
      telegramAssistant,
    });
    store.meta("notifications", notificationState);
    store.meta("doctorFastCheck", result);
    log("fast_check_completed");
    nextDelay = nextFastCheckDelay(
      started,
      Date.now(),
      config.fastCheckIntervalMs,
    );
  } catch {
    if (!controller.signal.aborted) {
      store.log("doctor_fast_error", "Ошибка быстрой проверки");
      log("fast_check_error");
    }
  } finally {
    fastCurrent = null;
    scheduleFast(nextDelay);
  }
}
async function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(pulse);
  clearTimeout(timer);
  clearTimeout(fastTimer);
  controller.abort();
  if (current) await current;
  if (fastCurrent) await fastCurrent;
  if (doctor.current) await doctor.current;
  store.meta("agent", {
    status: "stopped",
    heartbeatAt: new Date().toISOString(),
  });
  store.log("agent_stopped", "Локальный агент остановлен");
  log("agent_stopped");
  store.release(owner);
  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections();
    server.closeAllConnections();
    await closed;
  }
  await telegramAssistant.stop();
  store.close();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
  if (!process.argv.includes("--once")) {
    server = createAgentServer(store, config, {
      doctor,
      repair,
      sourceRecovery,
      rollSupplyService,
      assistant,
      secretStore,
      telegramAssistant,
      refreshPrinting: async () => {
        const source = config.sources.find(
          (item) => item.adapter === "printing" && item.enabled,
        );
        return source ? monitor.source(source, controller.signal) : { ok: false };
      },
      signal: controller.signal,
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", resolve);
    });
    if (repair?.production) repair.startQueue();
    console.log(
      "RITM Intelligence: http://127.0.0.1:" +
        config.port +
        "/?page=intelligence (только чтение)",
    );
  }
  async function loop() {
    const cycleStartedAt = Date.now();
    current = tick();
    await current;
    current = null;
    if (process.argv.includes("--once")) {
      const state = store.overview();
      console.log(
        JSON.stringify({
          sources: config.sources.filter((s) => s.enabled).length,
          checks: state.checks.map((c) => ({
            name: c.name,
            status: c.status,
            records: c.records,
            issues: c.issueCount,
          })),
          activeIncidents: state.active,
        }),
      );
      await stop();
      return;
    }
    if (!stopped) {
      const nextAt = nextScheduledCheck(
        cycleStartedAt,
        Date.now(),
        config.intervalMs,
      );
      store.meta("nextCheckAt", new Date(nextAt).toISOString());
      heartbeat();
      timer = setTimeout(() => void loop(), Math.max(0, nextAt - Date.now()));
    }
  }
  scheduleFast(1000);
  await loop();
} catch (error) {
  await stop();
  throw error;
}
