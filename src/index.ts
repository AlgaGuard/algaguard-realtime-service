import { createSubscriptionAuthorizer } from "./access.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { RealtimeMetrics } from "./domain.js";
import { RedisTicketRepository } from "./tickets.js";
import { attachRealtimeServer } from "./websocket.js";
const config = loadConfig();
const tickets = new RedisTicketRepository(config.REDIS_URL);
const metrics = new RealtimeMetrics();
const server = buildApp(
  tickets,
  metrics,
  undefined,
  config.HTTP_BODY_LIMIT_BYTES,
).listen(config.PORT, () => {
  process.stdout.write(
    `${JSON.stringify({ level: "info", service: "algaguard-realtime-service", message: "listening", port: config.PORT })}\n`,
  );
});
const realtime = await attachRealtimeServer(server, {
  tickets,
  authorize: createSubscriptionAuthorizer(),
  metrics,
  redisUrl: config.REDIS_URL,
  maxMessageBytes: config.WS_MAX_MESSAGE_BYTES,
  maxSubscriptions: config.WS_MAX_SUBSCRIPTIONS,
  outboundQueueMaximum: config.WS_OUTBOUND_QUEUE_MAX,
  connectionsPerMinute: config.WS_CONNECTIONS_PER_MINUTE,
  messagesPerMinute: config.WS_MESSAGES_PER_MINUTE,
  heartbeatMs: config.WS_HEARTBEAT_MS,
  idleMs: config.WS_IDLE_TIMEOUT_MS,
  backpressureBytes: config.WS_BACKPRESSURE_BYTES,
  preauthBufferMessages: config.WS_PREAUTH_BUFFER_MESSAGES,
});
async function shutdown(signal: string) {
  process.stdout.write(
    `${JSON.stringify({ level: "info", service: "algaguard-realtime-service", message: "shutdown", signal })}\n`,
  );
  await realtime.close();
  await tickets.close();
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
