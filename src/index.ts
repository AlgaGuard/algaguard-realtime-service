import * as grpc from "@grpc/grpc-js";
import { createGrpcSubscriptionAuthorizer } from "./access.js";
import { PostgresAlertRepository } from "./alerts.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { RealtimeMetrics } from "./domain.js";
import { createAuthenticator } from "./auth.js";
import { buildGrpcServer } from "./grpc-server.js";
import { RedisTicketRepository } from "./tickets.js";
import { attachRealtimeServer } from "./websocket.js";
import {
  FcmHttpV1Sender,
  GrpcProfileThresholdClient,
  MemoryPushRegistrationRepository,
  OrganizationPushNotifier,
  RedisPushRegistrationRepository,
  ThresholdPushProcessor,
} from "./push.js";
const config = loadConfig();
const tickets = new RedisTicketRepository(config.REDIS_URL);
const metrics = new RealtimeMetrics();
const alertRepository = new PostgresAlertRepository(config.DATABASE_URL);
const pushRegistrations =
  config.ALGAGUARD_ENABLE_FCM === "1"
    ? new RedisPushRegistrationRepository(
        config.REDIS_URL,
        config.FCM_TOKEN_WRAPPING_KEY_BASE64!,
        config.PUSH_REGISTRATION_TTL_DAYS * 24 * 60 * 60,
      )
    : undefined;
const subscriptionAuthorizer = createGrpcSubscriptionAuthorizer(
  config.ACCESS_SERVICE_GRPC_ADDRESS,
);
const fcmSender = pushRegistrations
  ? new FcmHttpV1Sender(
      config.FCM_PROJECT_ID!,
      config.FCM_CLIENT_EMAIL!,
      config.FCM_PRIVATE_KEY_PKCS8_BASE64!,
    )
  : undefined;
// Threshold evaluation and alert-history persistence always run; push
// delivery only happens once FCM is configured (fcmSender is set).
const alertProcessor = new ThresholdPushProcessor(
  pushRegistrations ?? new MemoryPushRegistrationRepository(),
  new GrpcProfileThresholdClient(config.PROFILE_SERVICE_GRPC_ADDRESS),
  subscriptionAuthorizer,
  fcmSender,
  metrics,
  alertRepository,
);
const organizationNotifier =
  pushRegistrations && fcmSender
    ? new OrganizationPushNotifier(
        pushRegistrations,
        subscriptionAuthorizer,
        fcmSender,
        metrics,
      )
    : undefined;
const server = buildApp(
  tickets,
  metrics,
  undefined,
  config.HTTP_BODY_LIMIT_BYTES,
  pushRegistrations,
  organizationNotifier,
  alertRepository,
  subscriptionAuthorizer,
).listen(config.PORT, () => {
  process.stdout.write(
    `${JSON.stringify({ level: "info", service: "algaguard-realtime-service", message: "listening", port: config.PORT })}\n`,
  );
});
const realtime = await attachRealtimeServer(server, {
  tickets,
  authorize: subscriptionAuthorizer,
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
  alertProcessor,
});
const grpcServer = buildGrpcServer({
  ...(organizationNotifier ? { organizationNotifier } : {}),
  authenticate: createAuthenticator(),
});
grpcServer.bindAsync(
  `0.0.0.0:${config.GRPC_PORT}`,
  grpc.ServerCredentials.createInsecure(),
  (error, port) => {
    if (error) throw error;
    process.stdout.write(
      `${JSON.stringify({ level: "info", service: "algaguard-realtime-service", message: "grpc listening", port })}\n`,
    );
  },
);
async function shutdown(signal: string) {
  process.stdout.write(
    `${JSON.stringify({ level: "info", service: "algaguard-realtime-service", message: "shutdown", signal })}\n`,
  );
  grpcServer.tryShutdown(() => {});
  await realtime.close();
  await tickets.close();
  await pushRegistrations?.close();
  await alertRepository.close();
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
