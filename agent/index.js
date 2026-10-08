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
import { Monitor } from "./monitor.js";
import { createAgentServer } from "./server.js";
import { flushTelegram } from "./telegram.js";

const config = loadConfig(),
  store = new IncidentStore(config.dbPath),
  owner = randomUUID();
if (!store.acquire(owner)) {
  store.close();
  throw new Error(
    "Другой процесс агента уже владеет этой базой; повторите запуск после истечения аренды (90 секунд).",
  );
}
store.recoverNotifications();
const controller = new AbortController(),
  monitor = new Monitor(store, config),
  doctor = new TableDoctor(store, config);
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
  current,
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
    await Promise.all([
      monitor.run(controller.signal),
      doctor.run(controller.signal),
    ]);
    const notificationState = await flushTelegram(store, config.telegram, {
      signal: controller.signal,
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
async function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(pulse);
  clearTimeout(timer);
  controller.abort();
  if (current) await current;
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
  store.close();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
  if (!process.argv.includes("--once")) {
    server = createAgentServer(store, config, {
      doctor,
      signal: controller.signal,
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", resolve);
    });
    console.log(
      "RITM Intelligence: http://127.0.0.1:" +
        config.port +
        "/?page=intelligence (только чтение)",
    );
  }
  async function loop() {
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
      store.meta(
        "nextCheckAt",
        new Date(Date.now() + config.intervalMs).toISOString(),
      );
      heartbeat();
      timer = setTimeout(() => void loop(), config.intervalMs);
    }
  }
  await loop();
} catch (error) {
  await stop();
  throw error;
}
