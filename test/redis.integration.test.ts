import test from "node:test";
import assert from "node:assert/strict";
import { RedisTicketRepository } from "../src/tickets.js";
const redisUrl = process.env.TEST_REDIS_URL;
test(
  "Redis ticket consume is atomic, one-time, and expiry-aware",
  { skip: redisUrl ? false : "TEST_REDIS_URL is not configured" },
  async () => {
    const tickets = new RedisTicketRepository(redisUrl);
    const ticket = await tickets.create("subject", 30);
    const values = await Promise.all([
      tickets.consume(ticket),
      tickets.consume(ticket),
    ]);
    assert.equal(values.filter(Boolean).length, 1);
    assert.equal(values.find(Boolean), "subject");
    const expired = await tickets.create("expired", 1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(await tickets.consume(expired), undefined);
    await tickets.close();
  },
);
