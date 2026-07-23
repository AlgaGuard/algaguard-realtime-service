import test from "node:test";
import assert from "node:assert/strict";
import {
  BoundedQueue,
  ConnectionLimiter,
  RealtimeMetrics,
  SubscriptionStore,
} from "../src/domain.js";

test("subscriptions require authorization, enforce a maximum, and detect revocation", async () => {
  let allowed = true;
  const store = new SubscriptionStore(async () => allowed, 1);
  assert.ok(
    await store.add({
      resourceType: "device",
      resourceId: "20000000-0000-4000-8000-000000000001",
      events: ["telemetry.updated"],
    }),
  );
  assert.equal(
    await store.add({
      resourceType: "current-user",
      events: ["system.notification"],
    }),
    undefined,
  );
  allowed = false;
  assert.equal(await store.stillAuthorized(), false);
});

test("bounded queue and connection limiter reject overload", () => {
  const queue = new BoundedQueue<number>(1);
  assert.equal(queue.push(1), true);
  assert.equal(queue.push(2), false);
  const limiter = new ConnectionLimiter(1, 1000);
  assert.equal(limiter.take("address", 0), true);
  assert.equal(limiter.take("address", 1), false);
  assert.equal(limiter.take("address", 1001), true);
});

test("required realtime metrics are rendered", () => {
  const metrics = new RealtimeMetrics();
  metrics.add("auth_failures_total");
  metrics.set("active_connections", 2);
  assert.match(metrics.render(), /algaguard_realtime_active_connections 2/);
  assert.match(metrics.render(), /algaguard_realtime_auth_failures_total 1/);
});
