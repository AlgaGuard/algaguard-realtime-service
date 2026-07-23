import assert from "node:assert/strict";
import test from "node:test";
import { telemetryCommittedSchema, toTelemetryUpdated } from "../src/events.js";
import { committedEvent } from "./fixtures.js";

test("trusted committed telemetry transforms to compatible WebSocket v1.1", () => {
  const parsed = telemetryCommittedSchema.parse(committedEvent);
  assert.deepEqual(toTelemetryUpdated(parsed), {
    schema: "urn:algaguard:schema:websocket:telemetry-updated:v1-1",
    schemaVersion: "1.1.0",
    eventId: committedEvent.eventId,
    eventType: "telemetry.updated",
    occurredAt: committedEvent.occurredAt,
    organizationId: committedEvent.organizationId,
    deviceUuid: committedEvent.deviceUuid,
    deviceId: committedEvent.deviceId,
    sequence: "1",
    payload: committedEvent.payload,
    correlationId: committedEvent.correlationId,
  });
});

test("missing organization, malformed identities, and sequence mismatch are rejected", () => {
  const { organizationId: _organizationId, ...missingOrganization } =
    committedEvent;
  const invalid = [
    missingOrganization,
    { ...committedEvent, deviceUuid: "not-a-uuid" },
    { ...committedEvent, deviceId: "20000000-0000-4000-8000-000000000001" },
    {
      ...committedEvent,
      payload: {
        sample: { ...committedEvent.payload.sample, sequence: "2" },
      },
    },
    {
      ...committedEvent,
      schema: "urn:algaguard:schema:websocket:telemetry-updated:v1",
      eventType: "telemetry.updated",
    },
  ];
  for (const value of invalid) {
    assert.equal(telemetryCommittedSchema.safeParse(value).success, false);
  }
});
