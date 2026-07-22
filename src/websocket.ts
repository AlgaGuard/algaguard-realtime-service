import type { Server } from "node:http";
import { createClient } from "redis";
import { WebSocket, WebSocketServer } from "ws";
import { BoundedQueue, SubscriptionStore } from "./domain.js";
import { consumeTicket } from "./tickets.js";

interface ClientContext {
  socket: WebSocket;
  subscriptions: SubscriptionStore;
  alive: boolean;
  messages: number;
  resetAt: number;
}

async function authorize(
  subjectId: string,
  resourceType: "organization" | "device" | "current-user",
  resourceId?: string,
) {
  const response = await fetch(
    `${process.env.ACCESS_SERVICE_URL ?? "http://access-service:3000"}/v1/authorizations/subscriptions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectId, resourceType, resourceId }),
    },
  );
  if (!response.ok) return false;
  return Boolean(((await response.json()) as { allowed?: boolean }).allowed);
}

function matches(context: ClientContext, event: Record<string, unknown>) {
  return [...context.subscriptions.subscriptions.values()].some(
    (subscription) =>
      subscription.resourceType === "current-user" ||
      (subscription.resourceType === "device" &&
        subscription.resourceId === event.deviceId) ||
      (subscription.resourceType === "organization" &&
        subscription.resourceId === event.organizationId),
  );
}

export async function attachRealtimeServer(server: Server) {
  const wss = new WebSocketServer({
    server,
    path: "/realtime",
    maxPayload: 256 * 1024,
  });
  const clients = new Set<ClientContext>();
  const subscriber = createClient({
    url: process.env.REDIS_URL ?? "redis://redis:6379",
  });
  await subscriber.connect();
  await subscriber.subscribe("algaguard.live", (raw) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const context of clients) {
      if (
        context.socket.readyState !== WebSocket.OPEN ||
        !matches(context, event) ||
        context.socket.bufferedAmount > 512 * 1024
      ) {
        if (context.socket.bufferedAmount > 512 * 1024)
          context.socket.close(4408, "slow client");
        continue;
      }
      context.socket.send(raw);
    }
  });

  wss.on("connection", (socket, request) => {
    void (async () => {
      const ticket =
        new URL(request.url ?? "/", "http://localhost").searchParams.get(
          "ticket",
        ) ?? "";
      const subjectId = await consumeTicket(ticket);
      if (!subjectId) return socket.close(4401, "invalid ticket");
      const queue = new BoundedQueue<string>(100);
      const context: ClientContext = {
        socket,
        subscriptions: new SubscriptionStore((resourceType, resourceId) =>
          authorize(subjectId, resourceType, resourceId),
        ),
        alive: true,
        messages: 0,
        resetAt: Date.now() + 60_000,
      };
      clients.add(context);
      socket.on("pong", () => {
        context.alive = true;
      });
      socket.on("message", (raw) => {
        void (async () => {
          const now = Date.now();
          if (now >= context.resetAt) {
            context.messages = 0;
            context.resetAt = now + 60_000;
          }
          context.messages += 1;
          if (context.messages > 120) return socket.close(4408, "rate limit");
          try {
            const message = JSON.parse(raw.toString()) as {
              schema?: string;
              subscriptions?: Array<{
                resourceType: "organization" | "device" | "current-user";
                resourceId?: string;
                events: string[];
              }>;
            };
            if (message.schema === "algaguard.websocket.ping") {
              return socket.send(
                JSON.stringify({
                  schema: "algaguard.websocket.pong",
                  schemaVersion: "1.0.0",
                  receivedAt: new Date().toISOString(),
                }),
              );
            }
            const accepted = [];
            for (const subscription of message.subscriptions ?? []) {
              const value = await context.subscriptions.add(subscription);
              if (value) accepted.push(value);
            }
            if (!queue.push(JSON.stringify({ accepted })))
              return socket.close(4408, "slow client");
            socket.send(queue.shift()!);
          } catch {
            socket.close(4400, "invalid message");
          }
        })();
      });
      socket.on("close", () => clients.delete(context));
    })();
  });

  const heartbeat = setInterval(() => {
    for (const context of clients) {
      if (!context.alive) {
        context.socket.terminate();
        continue;
      }
      context.alive = false;
      context.socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  return {
    wss,
    async close() {
      clearInterval(heartbeat);
      await subscriber.quit();
      wss.close();
    },
  };
}
