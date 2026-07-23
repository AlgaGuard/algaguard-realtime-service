import { randomUUID } from "node:crypto";
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
      events?: string[],
    ) => Promise<boolean>,
    private readonly maximum = 50,
  ) {}
  async add(input: Omit<Subscription, "id">) {
    if (this.subscriptions.size >= this.maximum) return undefined;
    if (
      !(await this.authorize(
        input.resourceType,
        input.resourceId,
        input.events,
      ))
    )
      return undefined;
    const value = { ...input, id: randomUUID() };
    this.subscriptions.set(value.id, value);
    return value;
  }
  remove(ids: string[]) {
    for (const id of ids) this.subscriptions.delete(id);
  }
  revoke(resourceId: string) {
    for (const [id, value] of this.subscriptions)
      if (value.resourceId === resourceId) this.subscriptions.delete(id);
  }
  async stillAuthorized() {
    let allAllowed = true;
    for (const [id, value] of this.subscriptions)
      if (
        !(await this.authorize(
          value.resourceType,
          value.resourceId,
          value.events,
        ))
      ) {
        this.subscriptions.delete(id);
        allAllowed = false;
      }
    return allAllowed;
  }
  async hasAuthorizedMatch(predicate: (value: Subscription) => boolean) {
    for (const [id, value] of this.subscriptions) {
      if (!predicate(value)) continue;
      if (
        !(await this.authorize(
          value.resourceType,
          value.resourceId,
          value.events,
        ))
      ) {
        this.subscriptions.delete(id);
        continue;
      }
      return true;
    }
    return false;
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
  get length() {
    return this.values.length;
  }
}
export class ConnectionLimiter {
  private readonly values = new Map<
    string,
    { count: number; resetAt: number }
  >();
  constructor(
    private readonly maximum = 20,
    private readonly windowMs = 60_000,
  ) {}
  take(key: string, now = Date.now()) {
    const current = this.values.get(key);
    if (!current || current.resetAt <= now) {
      this.values.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= this.maximum;
  }
}
export class RealtimeMetrics {
  private values = {
    active_connections: 0,
    auth_failures_total: 0,
    ticket_replay_total: 0,
    subscriptions_total: 0,
    rejected_subscriptions_total: 0,
    messages_sent_total: 0,
    slow_client_closures_total: 0,
    queue_depth: 0,
    redis_reconnects_total: 0,
    authorization_latency_ms_total: 0,
    authorization_requests_total: 0,
    invalid_events_total: 0,
  };
  add(name: keyof RealtimeMetrics["values"], amount = 1) {
    this.values[name] += amount;
  }
  set(name: "active_connections" | "queue_depth", value: number) {
    this.values[name] = value;
  }
  render() {
    return `${Object.entries(this.values)
      .map(([name, value]) => `algaguard_realtime_${name} ${value}`)
      .join("\n")}\n`;
  }
}
