import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { buildApp } from "../src/app.js";
import type { Authenticator } from "../src/auth.js";
import { RealtimeMetrics } from "../src/domain.js";
import type { TicketRepository } from "../src/tickets.js";

class MemoryTickets implements TicketRepository {
  values = new Map<string, string>();
  async create(subjectId: string) {
    const value = `ticket-${this.values.size}`;
    this.values.set(value, subjectId);
    return value;
  }
  async consume(ticket: string) {
    const value = this.values.get(ticket);
    this.values.delete(ticket);
    return value;
  }
  async health() {}
  async close() {}
}
const authenticate: Authenticator = async () => ({
  subjectId: "authenticated-user",
});
const app = () =>
  buildApp(new MemoryTickets(), new RealtimeMetrics(), authenticate);

test("liveness, readiness, and correlation middleware are available", async () => {
  const response = await request(app())
    .get("/health/live")
    .set("x-correlation-id", "test-correlation");
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-correlation-id"], "test-correlation");
  assert.equal((await request(app()).get("/health/ready")).status, 200);
});

test("ticket subject is derived from authentication and cannot be spoofed", async () => {
  const tickets = new MemoryTickets();
  const instance = buildApp(tickets, new RealtimeMetrics(), authenticate);
  const response = await request(instance)
    .post("/v1/tickets")
    .set("authorization", "Bearer user")
    .send({ subjectId: "attacker" });
  assert.equal(response.status, 201);
  assert.equal(
    await tickets.consume(response.body.ticket),
    "authenticated-user",
  );
});

test("unknown routes use problem details", async () => {
  const response = await request(app()).get("/missing");
  assert.equal(response.status, 404);
  assert.match(
    response.headers["content-type"] ?? "",
    /application\/problem\+json/,
  );
});
