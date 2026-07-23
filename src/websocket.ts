import type { Server } from "node:http";
import { createClient } from "redis";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type { SubscriptionAuthorizer } from "./access.js";
import {
  BoundedQueue,
  ConnectionLimiter,
  RealtimeMetrics,
  SubscriptionStore,
} from "./domain.js";
import type { TicketRepository } from "./tickets.js";
import { telemetryCommittedSchema, toTelemetryUpdated } from "./events.js";

const eventType = z.enum([
  "telemetry.updated",
  "device.health.updated",
  "device.status.changed",
  "alert.created",
  "alert.updated",
  "command.status.changed",
  "profile.configuration.changed",
  "profile.configuration.applied",
  "ota.status.changed",
  "system.notification",
]);
const subscription = z
  .object({
    resourceType: z.enum(["organization", "device", "current-user"]),
    resourceId: z.string().uuid().optional(),
    events: z
      .array(eventType)
      .min(1)
      .refine((value) => new Set(value).size === value.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.resourceType === "current-user" && value.resourceId)
      context.addIssue({
        code: "custom",
        message: "current-user omits resourceId",
      });
    if (value.resourceType !== "current-user" && !value.resourceId)
      context.addIssue({ code: "custom", message: "resourceId is required" });
  });
const subscribeMessage = z
  .object({
    schema: z.literal("algaguard.websocket.subscribe"),
    schemaVersion: z.literal("1.0.0"),
    requestId: z.string().uuid(),
    subscriptions: z.array(subscription).min(1).max(50),
  })
  .strict();
const unsubscribeMessage = z
  .object({
    schema: z.literal("algaguard.websocket.unsubscribe"),
    schemaVersion: z.literal("1.0.0"),
    requestId: z.string().uuid(),
    subscriptionIds: z
      .array(z.string().uuid())
      .min(1)
      .refine((value) => new Set(value).size === value.length),
  })
  .strict();
const pingMessage = z
  .object({
    schema: z.literal("algaguard.websocket.ping"),
    schemaVersion: z.literal("1.0.0"),
    requestId: z.string().uuid(),
    sentAt: z.string().datetime(),
  })
  .strict();

interface ClientContext {
  socket: WebSocket;
  subscriptions: SubscriptionStore;
  queue: BoundedQueue<string>;
  alive: boolean;
  lastActivity: number;
  messages: number;
  resetAt: number;
}

async function matches(
  context: ClientContext,
  event: ReturnType<typeof toTelemetryUpdated>,
) {
  return context.subscriptions.hasAuthorizedMatch(
    (value) =>
      value.events.includes(event.eventType) &&
      ((value.resourceType === "device" &&
        value.resourceId === event.deviceUuid) ||
        (value.resourceType === "organization" &&
          value.resourceId === event.organizationId)),
  );
}

export async function attachRealtimeServer(
  server: Server,
  dependencies: {
    tickets: TicketRepository;
    authorize: SubscriptionAuthorizer;
    metrics: RealtimeMetrics;
    redisUrl: string;
    heartbeatMs?: number;
    idleMs?: number;
  },
) {
  const wss = new WebSocketServer({
    server,
    path: "/realtime",
    maxPayload: 256 * 1024,
  });
  const clients = new Set<ClientContext>();
  const limiter = new ConnectionLimiter();
  const subscriber = createClient({ url: dependencies.redisUrl });
  subscriber.on("reconnecting", () =>
    dependencies.metrics.add("redis_reconnects_total"),
  );
  await subscriber.connect();

  function enqueue(context: ClientContext, value: string) {
    if (
      context.socket.bufferedAmount > 512 * 1024 ||
      !context.queue.push(value)
    ) {
      dependencies.metrics.add("slow_client_closures_total");
      context.socket.close(4408, "slow client");
      return;
    }
    dependencies.metrics.set("queue_depth", Math.max(context.queue.length, 0));
    const next = context.queue.shift();
    if (next && context.socket.readyState === WebSocket.OPEN) {
      context.socket.send(next);
      dependencies.metrics.add("messages_sent_total");
      dependencies.metrics.set("queue_depth", context.queue.length);
    }
  }

  await subscriber.subscribe("algaguard.live", (raw) => {
    let input: unknown;
    try {
      input = JSON.parse(raw) as unknown;
    } catch {
      dependencies.metrics.add("invalid_events_total");
      return;
    }
    const parsed = telemetryCommittedSchema.safeParse(input);
    if (!parsed.success) {
      dependencies.metrics.add("invalid_events_total");
      return;
    }
    const event = toTelemetryUpdated(parsed.data);
    const encoded = JSON.stringify(event);
    void (async () => {
      for (const context of clients)
        if (await matches(context, event)) enqueue(context, encoded);
    })();
  });

  wss.on("connection", (socket, request) => {
    const bufferedMessages: RawData[] = [];
    const bufferMessage = (raw: RawData) => {
      if (bufferedMessages.length >= 50) {
        socket.close(4429, "message rate limit");
        return;
      }
      bufferedMessages.push(raw);
    };
    socket.on("message", bufferMessage);
    void (async () => {
      const address = request.socket.remoteAddress ?? "unknown";
      if (!limiter.take(address))
        return socket.close(4429, "connection rate limit");
      const ticket =
        new URL(request.url ?? "/", "http://localhost").searchParams.get(
          "ticket",
        ) ?? "";
      const subjectId = await dependencies.tickets.consume(ticket);
      if (!subjectId) {
        dependencies.metrics.add("auth_failures_total");
        dependencies.metrics.add("ticket_replay_total");
        return socket.close(4401, "invalid ticket");
      }
      const authorize = async (
        resourceType: "organization" | "device" | "current-user",
        resourceId?: string,
        events?: string[],
      ) => {
        const started = Date.now();
        try {
          return await dependencies.authorize(
            subjectId,
            resourceType,
            resourceId,
            events,
          );
        } finally {
          dependencies.metrics.add("authorization_requests_total");
          dependencies.metrics.add(
            "authorization_latency_ms_total",
            Date.now() - started,
          );
        }
      };
      const context: ClientContext = {
        socket,
        subscriptions: new SubscriptionStore(authorize, 50),
        queue: new BoundedQueue(100),
        alive: true,
        lastActivity: Date.now(),
        messages: 0,
        resetAt: Date.now() + 60_000,
      };
      clients.add(context);
      dependencies.metrics.set("active_connections", clients.size);
      socket.on("pong", () => {
        context.alive = true;
        context.lastActivity = Date.now();
      });
      const handleMessage = (raw: RawData) => {
        void (async () => {
          const now = Date.now();
          context.lastActivity = now;
          if (now >= context.resetAt) {
            context.messages = 0;
            context.resetAt = now + 60_000;
          }
          context.messages += 1;
          if (context.messages > 120)
            return socket.close(4429, "message rate limit");
          try {
            const value = JSON.parse(raw.toString()) as unknown;
            const ping = pingMessage.safeParse(value);
            if (ping.success)
              return enqueue(
                context,
                JSON.stringify({
                  schema: "algaguard.websocket.pong",
                  schemaVersion: "1.0.0",
                  requestId: ping.data.requestId,
                  receivedAt: new Date().toISOString(),
                }),
              );
            const remove = unsubscribeMessage.safeParse(value);
            if (remove.success) {
              context.subscriptions.remove(remove.data.subscriptionIds);
              return enqueue(
                context,
                JSON.stringify({
                  schema: "urn:algaguard:schema:websocket:subscription-ack:v1",
                  schemaVersion: "1.0.0",
                  requestId: remove.data.requestId,
                  acknowledgedAt: new Date().toISOString(),
                  accepted: [],
                  rejected: [],
                }),
              );
            }
            const add = subscribeMessage.parse(value);
            const accepted = [];
            const rejected = [];
            for (const requested of add.subscriptions) {
              const stored = await context.subscriptions.add({
                resourceType: requested.resourceType,
                ...(requested.resourceId
                  ? { resourceId: requested.resourceId }
                  : {}),
                events: requested.events,
              });
              if (stored) {
                dependencies.metrics.add("subscriptions_total");
                accepted.push({
                  subscriptionId: stored.id,
                  resourceType: stored.resourceType,
                  ...(stored.resourceId
                    ? { resourceId: stored.resourceId }
                    : {}),
                  events: stored.events,
                });
              } else {
                dependencies.metrics.add("rejected_subscriptions_total");
                rejected.push({
                  code: "SUBSCRIPTION_FORBIDDEN",
                  message: "Subscription is not authorized or limit reached",
                  retryable: false,
                });
              }
            }
            enqueue(
              context,
              JSON.stringify({
                schema: "urn:algaguard:schema:websocket:subscription-ack:v1",
                schemaVersion: "1.0.0",
                requestId: add.requestId,
                acknowledgedAt: new Date().toISOString(),
                accepted,
                rejected,
              }),
            );
          } catch {
            socket.close(4400, "invalid message");
          }
        })();
      };
      socket.off("message", bufferMessage);
      socket.on("message", handleMessage);
      for (const raw of bufferedMessages) handleMessage(raw);
      socket.on("close", () => {
        clients.delete(context);
        dependencies.metrics.set("active_connections", clients.size);
      });
    })().catch(() => socket.close(1011, "dependency failure"));
  });

  const heartbeat = setInterval(() => {
    for (const context of clients) {
      if (
        !context.alive ||
        Date.now() - context.lastActivity > (dependencies.idleMs ?? 90_000)
      ) {
        context.socket.terminate();
        continue;
      }
      context.alive = false;
      context.socket.ping();
      void context.subscriptions.stillAuthorized().then((allowed) => {
        if (!allowed) context.socket.close(4403, "access revoked");
      });
    }
  }, dependencies.heartbeatMs ?? 30_000);
  heartbeat.unref();
  return {
    wss,
    async close() {
      clearInterval(heartbeat);
      for (const context of clients)
        context.socket.close(1001, "server shutdown");
      await subscriber.quit();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
