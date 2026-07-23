import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createClient } from "redis";
import { WebSocket } from "ws";
import { RealtimeMetrics } from "../src/domain.js";
import { RedisTicketRepository } from "../src/tickets.js";
import { attachRealtimeServer } from "../src/websocket.js";

const redisUrl = process.env.TEST_REDIS_URL;
test(
  "WebSocket ticket replay, authorization, fan-out, and revocation",
  { skip: redisUrl ? false : "TEST_REDIS_URL is not configured" },
  async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test server address unavailable");
    const tickets = new RedisTicketRepository(redisUrl);
    let allowed = true;
    const metrics = new RealtimeMetrics();
    const realtime = await attachRealtimeServer(server, {
      tickets,
      authorize: async () => allowed,
      metrics,
      redisUrl: redisUrl!,
      heartbeatMs: 50,
      idleMs: 2_000,
    });
    const ticket = await tickets.create("subject");
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/realtime?ticket=${ticket}`,
    );
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        schema: "algaguard.websocket.subscribe",
        schemaVersion: "1.0.0",
        requestId: "10000000-0000-4000-8000-000000000001",
        subscriptions: [
          {
            resourceType: "device",
            resourceId: "20000000-0000-4000-8000-000000000001",
            events: ["telemetry.updated"],
          },
        ],
      }),
    );
    const [ackBytes] = (await once(socket, "message")) as [Buffer];
    const ack = JSON.parse(ackBytes.toString()) as { accepted: unknown[] };
    assert.equal(ack.accepted.length, 1);

    const publisher = createClient({ url: redisUrl! });
    await publisher.connect();
    const nextMessage = once(socket, "message");
    await publisher.publish(
      "algaguard.live",
      JSON.stringify({
        schema: "urn:algaguard:schema:websocket:telemetry-updated:v1",
        schemaVersion: "1.0.0",
        eventId: "30000000-0000-4000-8000-000000000001",
        eventType: "telemetry.updated",
        occurredAt: "2026-07-23T00:00:00Z",
        deviceId: "20000000-0000-4000-8000-000000000001",
        payload: {},
      }),
    );
    const [eventBytes] = (await nextMessage) as [Buffer];
    assert.match(eventBytes.toString(), /telemetry.updated/);

    const replay = new WebSocket(
      `ws://127.0.0.1:${address.port}/realtime?ticket=${ticket}`,
    );
    const [replayCode] = (await once(replay, "close")) as [number];
    assert.equal(replayCode, 4401);
    allowed = false;
    const [revokedCode] = (await once(socket, "close")) as [number];
    assert.equal(revokedCode, 4403);
    await publisher.quit();
    await realtime.close();
    await tickets.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.match(metrics.render(), /algaguard_realtime_ticket_replay_total 1/);
  },
);
