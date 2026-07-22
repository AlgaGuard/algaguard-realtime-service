import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { attachRealtimeServer } from "./websocket.js";
const config = loadConfig();
const server = buildApp().listen(config.PORT, () => {
  process.stdout.write(
    JSON.stringify({
      level: "info",
      service: "algaguard-realtime-service",
      message: "listening",
      port: config.PORT,
    }) + "\n",
  );
});
const realtime = await attachRealtimeServer(server);
async function shutdown(signal: string) {
  process.stdout.write(
    JSON.stringify({
      level: "info",
      service: "algaguard-realtime-service",
      message: "shutdown",
      signal,
    }) + "\n",
  );
  await realtime.close();
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
