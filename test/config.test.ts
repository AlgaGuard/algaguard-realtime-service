import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("transport configuration has bounded conservative defaults", () => {
  const config = loadConfig({ REDIS_URL: "redis://localhost:6379" });
  assert.equal(config.HTTP_BODY_LIMIT_BYTES, 32 * 1_024);
  assert.equal(config.WS_MAX_MESSAGE_BYTES, 256 * 1_024);
  assert.equal(config.WS_MAX_SUBSCRIPTIONS, 50);
  assert.equal(config.WS_OUTBOUND_QUEUE_MAX, 100);
  assert.equal(config.WS_CONNECTIONS_PER_MINUTE, 20);
  assert.equal(config.WS_MESSAGES_PER_MINUTE, 120);
  assert.equal(config.WS_HEARTBEAT_MS, 30_000);
  assert.equal(config.WS_IDLE_TIMEOUT_MS, 90_000);
  assert.equal(config.WS_BACKPRESSURE_BYTES, 512 * 1_024);
  assert.equal(config.WS_PREAUTH_BUFFER_MESSAGES, 50);
});

test("transport configuration accepts valid overrides", () => {
  const config = loadConfig({
    REDIS_URL: "redis://localhost:6379",
    HTTP_BODY_LIMIT_BYTES: "4096",
    WS_MAX_MESSAGE_BYTES: "8192",
    WS_MAX_SUBSCRIPTIONS: "10",
    WS_OUTBOUND_QUEUE_MAX: "20",
    WS_CONNECTIONS_PER_MINUTE: "30",
    WS_MESSAGES_PER_MINUTE: "300",
    WS_HEARTBEAT_MS: "5000",
    WS_IDLE_TIMEOUT_MS: "15000",
    WS_BACKPRESSURE_BYTES: "16384",
    WS_PREAUTH_BUFFER_MESSAGES: "5",
  });
  assert.equal(config.HTTP_BODY_LIMIT_BYTES, 4096);
  assert.equal(config.WS_MAX_MESSAGE_BYTES, 8192);
  assert.equal(config.WS_MAX_SUBSCRIPTIONS, 10);
  assert.equal(config.WS_HEARTBEAT_MS, 5000);
});

test("transport configuration rejects unsafe values and timeout coupling", () => {
  assert.throws(() =>
    loadConfig({
      REDIS_URL: "redis://localhost:6379",
      WS_MAX_SUBSCRIPTIONS: "51",
    }),
  );
  assert.throws(() =>
    loadConfig({
      REDIS_URL: "redis://localhost:6379",
      WS_HEARTBEAT_MS: "30000",
      WS_IDLE_TIMEOUT_MS: "50000",
    }),
  );
});
