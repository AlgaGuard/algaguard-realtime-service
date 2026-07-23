import { randomBytes } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
export interface TicketRepository {
  create(subjectId: string, ttlSeconds?: number): Promise<string>;
  consume(ticket: string): Promise<string | undefined>;
  health(): Promise<void>;
  close(): Promise<void>;
}
export class RedisTicketRepository implements TicketRepository {
  private readonly redis: RedisClientType;
  private connecting?: Promise<unknown>;
  constructor(url = process.env.REDIS_URL) {
    if (!url) throw new Error("REDIS_URL is required");
    this.redis = createClient({ url });
  }
  private async ready() {
    if (!this.redis.isOpen) this.connecting ??= this.redis.connect();
    await this.connecting;
  }
  async create(subjectId: string, ttlSeconds = 30) {
    await this.ready();
    for (;;) {
      const ticket = randomBytes(24).toString("base64url");
      if (
        await this.redis.set(`realtime:ticket:${ticket}`, subjectId, {
          EX: ttlSeconds,
          NX: true,
        })
      )
        return ticket;
    }
  }
  async consume(ticket: string) {
    await this.ready();
    return (await this.redis.getDel(`realtime:ticket:${ticket}`)) ?? undefined;
  }
  async health() {
    await this.ready();
    await this.redis.ping();
  }
  async close() {
    if (this.redis.isOpen) await this.redis.quit();
  }
}
