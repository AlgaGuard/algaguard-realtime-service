import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { RealtimeMetrics } from "../src/domain.js";
import {
  MemoryPushRegistrationRepository,
  ThresholdPushProcessor,
  type AlertProfileResolver,
  type PushSender,
} from "../src/push.js";
import type { TicketRepository } from "../src/tickets.js";
import { telemetryCommittedSchema } from "../src/events.js";
import { committedEvent } from "./fixtures.js";

class MemoryTickets implements TicketRepository {
  async create() {
    return "ticket";
  }
  async consume() {
    return undefined;
  }
  async health() {}
  async close() {}
}

test("authenticated app installations register, rotate, and unregister", async () => {
  const registrations = new MemoryPushRegistrationRepository();
  const app = buildApp(
    new MemoryTickets(),
    new RealtimeMetrics(),
    async () => ({ subjectId: "current-user" }),
    32 * 1_024,
    registrations,
  );
  const installationId = "10000000-0000-4000-8000-000000000001";
  const first = "a".repeat(64);
  assert.equal(
    (
      await request(app)
        .put(`/v1/push/registrations/${installationId}`)
        .set("authorization", "Bearer redacted")
        .send({ platform: "ANDROID", registrationToken: first })
    ).status,
    204,
  );
  assert.equal((await registrations.list()).length, 1);
  assert.equal((await registrations.list())[0]?.registrationToken, first);

  const rotated = "b".repeat(64);
  await request(app)
    .put(`/v1/push/registrations/${installationId}`)
    .set("authorization", "Bearer redacted")
    .send({ platform: "ANDROID", registrationToken: rotated })
    .expect(204);
  assert.equal((await registrations.list()).length, 1);
  assert.equal((await registrations.list())[0]?.registrationToken, rotated);

  await request(app)
    .delete(`/v1/push/registrations/${installationId}`)
    .set("authorization", "Bearer redacted")
    .expect(204);
  assert.equal((await registrations.list()).length, 0);
});

test("threshold delivery occurs once per breach transition and honors access", async () => {
  const registrations = new MemoryPushRegistrationRepository();
  await registrations.register({
    subjectId: "allowed-user",
    installationId: "10000000-0000-4000-8000-000000000001",
    registrationToken: "allowed-".padEnd(64, "a"),
  });
  await registrations.register({
    subjectId: "other-organization-user",
    installationId: "20000000-0000-4000-8000-000000000002",
    registrationToken: "denied-".padEnd(64, "b"),
  });
  const profile: AlertProfileResolver = {
    async resolve() {
      return {
        profileId: "70000000-0000-4000-8000-000000000001",
        version: 1,
        configuration: {
          schema: "urn:algaguard:schema:profile:algae-thresholds:v1",
          parameters: {
            temperatureC: { minimum: 20, maximum: 30 },
            ph: { minimum: 6, maximum: 8 },
            lightLux: { minimum: 100, maximum: 1000 },
            nitrateMgL: { minimum: 1, maximum: 100 },
            phosphateMgL: { minimum: 1, maximum: 100 },
            potassiumMgL: { minimum: 1, maximum: 100 },
          },
        },
      };
    },
  };
  const sent: string[] = [];
  const sender: PushSender = {
    async send(token) {
      sent.push(token);
      return "SENT";
    },
  };
  const processor = new ThresholdPushProcessor(
    registrations,
    profile,
    async (subject) => subject === "allowed-user",
    sender,
    new RealtimeMetrics(),
  );
  const event = telemetryCommittedSchema.parse({
    ...committedEvent,
    payload: {
      sample: {
        ...committedEvent.payload.sample,
        values: { ph: 9 },
      },
    },
  });
  await processor.process(event);
  await processor.process(event);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /^allowed-/);

  await processor.process({
    ...event,
    payload: { sample: { ...event.payload.sample, values: { ph: 7 } } },
  });
  await processor.process(event);
  assert.equal(sent.length, 2);
});

test("FCM startup configuration is disabled by default and fail-closed", async () => {
  const { loadConfig } = await import("../src/config.js");
  assert.equal(
    loadConfig({ REDIS_URL: "redis://localhost:6379" }).ALGAGUARD_ENABLE_FCM,
    "0",
  );
  assert.throws(() =>
    loadConfig({
      REDIS_URL: "redis://localhost:6379",
      ALGAGUARD_ENABLE_FCM: "1",
    }),
  );
});
