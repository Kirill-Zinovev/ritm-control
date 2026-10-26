import { loadConfig } from "./config.js";
const c = loadConfig();
try {
  const response = await fetch(
    "http://127.0.0.1:" + c.port + "/api/intelligence/status",
    {
      headers: { authorization: "Bearer " + c.ownerToken },
      signal: AbortSignal.timeout(5000),
    },
  );
  const state = await response.json();
  process.exitCode =
    response.ok &&
    state.agent?.status === "running" &&
    Date.now() - Date.parse(state.agent.heartbeatAt) < 90000
      ? 0
      : 1;
} catch {
  process.exitCode = 1;
}
