import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createClient } from "redis";
import { WebSocket } from "ws";
import { RealtimeMetrics } from "../src/domain.js";
import { RedisTicketRepository } from "../src/tickets.js";
import { attachRealtimeServer } from "../src/websocket.js";
import { committedEvent } from "./fixtures.js";

const redisUrl = process.env.TEST_REDIS_URL;
async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 2_000,
) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
test(
  "WebSocket ticket replay, authorization, fan-out, and revocation",
  {
    skip: redisUrl ? false : "TEST_REDIS_URL is not configured",
    timeout: 15_000,
  },
  async (context) => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test server address unavailable");
    const port = address.port;
    const tickets = new RedisTicketRepository(redisUrl);
    let allowed = true;
    const metrics = new RealtimeMetrics();
    const realtime = await attachRealtimeServer(server, {
      tickets,
      authorize: async () => allowed,
      metrics,
      redisUrl: redisUrl!,
      maxSubscriptions: 1,
      heartbeatMs: 50,
      idleMs: 2_000,
    });
    const ticket = await tickets.create("subject");
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/realtime?ticket=${ticket}`,
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

    socket.send(
      JSON.stringify({
        schema: "algaguard.websocket.subscribe",
        schemaVersion: "1.0.0",
        requestId: "10000000-0000-4000-8000-000000000002",
        subscriptions: [
          {
            resourceType: "organization",
            resourceId: committedEvent.organizationId,
            events: ["telemetry.updated"],
          },
        ],
      }),
    );
    const [limitAckBytes] = (await once(socket, "message")) as [Buffer];
    const limitAck = JSON.parse(limitAckBytes.toString()) as {
      accepted: unknown[];
      rejected: unknown[];
    };
    assert.equal(limitAck.accepted.length, 0);
    assert.equal(limitAck.rejected.length, 1);

    const publisher = createClient({ url: redisUrl! });
    await publisher.connect();
    const { organizationId: _organizationId, ...missingOrganization } =
      committedEvent;
    await publisher.publish(
      "algaguard.live",
      JSON.stringify(missingOrganization),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(metrics.render(), /algaguard_realtime_invalid_events_total 1/);
    const nextMessage = once(socket, "message");
    await publisher.publish("algaguard.live", JSON.stringify(committedEvent));
    const [eventBytes] = (await nextMessage) as [Buffer];
    const delivered = JSON.parse(eventBytes.toString()) as Record<
      string,
      unknown
    >;
    assert.equal(
      delivered.schema,
      "urn:algaguard:schema:websocket:telemetry-updated:v1-1",
    );
    assert.equal(delivered.schemaVersion, "1.1.0");
    assert.equal(delivered.deviceUuid, committedEvent.deviceUuid);
    assert.equal(delivered.deviceId, "AG-000001");
    assert.equal(delivered.organizationId, committedEvent.organizationId);

    const replay = new WebSocket(
      `ws://127.0.0.1:${port}/realtime?ticket=${ticket}`,
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

test(
  "ownership transfer reauthorizes before delivery and routes only to the new owner",
  {
    skip: redisUrl ? false : "TEST_REDIS_URL is not configured",
    timeout: 15_000,
  },
  async (context) => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test server address unavailable");
    const port = address.port;
    const tickets = new RedisTicketRepository(redisUrl);
    const organizationA = committedEvent.organizationId;
    const organizationB = "60000000-0000-4000-8000-000000000002";
    let owner = organizationA;
    const subjectOrganizations: Record<string, string> = {
      "user-a": organizationA,
      "user-b": organizationB,
    };
    const realtime = await attachRealtimeServer(server, {
      tickets,
      authorize: async (subjectId, resourceType, resourceId) => {
        const subjectOrganization = subjectOrganizations[subjectId];
        if (resourceType === "device") return subjectOrganization === owner;
        if (resourceType === "organization")
          return resourceId === subjectOrganization;
        return false;
      },
      metrics: new RealtimeMetrics(),
      redisUrl: redisUrl!,
      heartbeatMs: 5_000,
      idleMs: 10_000,
    });
    const sockets = new Set<WebSocket>();
    let publisher: ReturnType<typeof createClient> | undefined;
    context.after(async () => {
      for (const socket of sockets) socket.terminate();
      if (publisher?.isOpen)
        await within(publisher.quit(), "publisher shutdown");
      await within(realtime.close(), "realtime shutdown");
      await within(tickets.close(), "ticket shutdown");
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    });

    async function subscribe(subjectId: string) {
      const ticket = await tickets.create(subjectId);
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/realtime?ticket=${ticket}`,
      );
      sockets.add(socket);
      await within(once(socket, "open"), `${subjectId} socket open`);
      socket.send(
        JSON.stringify({
          schema: "algaguard.websocket.subscribe",
          schemaVersion: "1.0.0",
          requestId:
            subjectId === "user-a"
              ? "10000000-0000-4000-8000-000000000011"
              : "10000000-0000-4000-8000-000000000012",
          subscriptions: [
            {
              resourceType: "device",
              resourceId: committedEvent.deviceUuid,
              events: ["telemetry.updated"],
            },
          ],
        }),
      );
      const [ack] = (await within(
        once(socket, "message"),
        `${subjectId} subscription acknowledgement`,
      )) as [Buffer];
      assert.equal(JSON.parse(ack.toString()).accepted.length, 1);
      return socket;
    }

    const userA = await subscribe("user-a");
    owner = organizationB;
    publisher = createClient({ url: redisUrl! });
    await within(publisher.connect(), "publisher connection");
    const leaked = Promise.race([
      once(userA, "message").then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    await publisher.publish(
      "algaguard.live",
      JSON.stringify({
        ...committedEvent,
        organizationId: organizationB,
        ownershipVersion: "2",
      }),
    );
    assert.equal(await leaked, false);

    const userB = await subscribe("user-b");
    const delivered = once(userB, "message");
    await publisher.publish(
      "algaguard.live",
      JSON.stringify({
        ...committedEvent,
        eventId: "30000000-0000-4000-8000-000000000002",
        organizationId: organizationB,
        ownershipVersion: "2",
      }),
    );
    const [bytes] = (await within(
      delivered,
      "new-owner telemetry delivery",
    )) as [Buffer];
    assert.equal(
      (JSON.parse(bytes.toString()) as { organizationId: string })
        .organizationId,
      organizationB,
    );
  },
);
