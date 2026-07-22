import test from "node:test";
import assert from "node:assert/strict";
import { BoundedQueue, SubscriptionStore, TicketStore } from "../src/domain.js";
test("ticket is short-lived and consumed atomically once", () => {
  const store = new TicketStore();
  const ticket = store.create("subject", 10);
  assert.equal(store.consume(ticket), "subject");
  assert.equal(store.consume(ticket), undefined);
});
test("subscriptions require authorization and revocation removes active subscription", async () => {
  const store = new SubscriptionStore(async (_type, id) => id === "allowed");
  assert.equal(
    await store.add({
      resourceType: "device",
      resourceId: "denied",
      events: ["telemetry.updated"],
    }),
    undefined,
  );
  const accepted = await store.add({
    resourceType: "device",
    resourceId: "allowed",
    events: ["telemetry.updated"],
  });
  assert.ok(accepted);
  store.revoke("allowed");
  assert.equal(store.subscriptions.size, 0);
});
test("bounded queue rejects slow client overflow", () => {
  const queue = new BoundedQueue<number>(1);
  assert.equal(queue.push(1), true);
  assert.equal(queue.push(2), false);
});
