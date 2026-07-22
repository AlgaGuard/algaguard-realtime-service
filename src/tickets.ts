import { randomBytes } from "node:crypto";
import { createClient } from "redis";

const redis = createClient({
  url: process.env.REDIS_URL ?? "redis://redis:6379",
});
let connecting: Promise<unknown> | undefined;
async function ready() {
  if (!redis.isOpen) connecting ??= redis.connect();
  await connecting;
}

export async function createTicket(subjectId: string) {
  await ready();
  const ticket = randomBytes(24).toString("base64url");
  await redis.set(`realtime:ticket:${ticket}`, subjectId, { EX: 30, NX: true });
  return ticket;
}

export async function consumeTicket(ticket: string) {
  await ready();
  return redis.getDel(`realtime:ticket:${ticket}`);
}
