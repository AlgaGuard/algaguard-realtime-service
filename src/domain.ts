import { randomBytes, randomUUID } from "node:crypto";
export class TicketStore {
  private readonly tickets = new Map<
    string,
    { subjectId: string; expiresAt: number }
  >();
  create(subjectId: string, ttlMs = 30_000) {
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { subjectId, expiresAt: Date.now() + ttlMs });
    return ticket;
  }
  consume(ticket: string, now = Date.now()) {
    const value = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return value && value.expiresAt > now ? value.subjectId : undefined;
  }
}
export interface Subscription {
  id: string;
  resourceType: "organization" | "device" | "current-user";
  resourceId?: string;
  events: string[];
}
export class SubscriptionStore {
  readonly subscriptions = new Map<string, Subscription>();
  constructor(
    private readonly authorize: (
      resourceType: Subscription["resourceType"],
      resourceId?: string,
    ) => Promise<boolean>,
  ) {}
  async add(input: Omit<Subscription, "id">) {
    if (!(await this.authorize(input.resourceType, input.resourceId)))
      return undefined;
    const value = { ...input, id: randomUUID() };
    this.subscriptions.set(value.id, value);
    return value;
  }
  revoke(resourceId: string) {
    for (const [id, value] of this.subscriptions)
      if (value.resourceId === resourceId) this.subscriptions.delete(id);
  }
}
export class BoundedQueue<T> {
  private readonly values: T[] = [];
  constructor(private readonly maximum: number) {}
  push(value: T) {
    if (this.values.length >= this.maximum) return false;
    this.values.push(value);
    return true;
  }
  shift() {
    return this.values.shift();
  }
}
export const ticketStore = new TicketStore();
