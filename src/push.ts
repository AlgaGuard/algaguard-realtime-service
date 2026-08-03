import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { createClient, type RedisClientType } from "redis";
import { z } from "zod";
import type { SubscriptionAuthorizer } from "./access.js";
import { serviceToken } from "./access.js";
import type { AlertRepository } from "./alerts.js";
import type { RealtimeMetrics } from "./domain.js";
import type { TelemetryCommittedEvent } from "./events.js";

export interface PushRegistration {
  id: string;
  subjectId: string;
  installationId: string;
  registrationToken: string;
}

export interface PushRegistrationRepository {
  register(input: Omit<PushRegistration, "id">): Promise<void>;
  unregister(subjectId: string, installationId: string): Promise<void>;
  list(): Promise<PushRegistration[]>;
  remove(id: string): Promise<void>;
  transitionAlert(key: string, next: string): Promise<string | undefined>;
  close(): Promise<void>;
}

type StoredRegistration = Omit<PushRegistration, "registrationToken"> & {
  nonce: string;
  ciphertext: string;
  tag: string;
};

export class RedisPushRegistrationRepository implements PushRegistrationRepository {
  private readonly redis: RedisClientType;
  private readonly key: Buffer;
  private connecting?: Promise<unknown>;

  constructor(
    url: string,
    wrappingKeyBase64: string,
    private readonly ttlSeconds = 90 * 24 * 60 * 60,
  ) {
    this.redis = createClient({ url });
    this.key = Buffer.from(wrappingKeyBase64, "base64");
    if (this.key.length !== 32)
      throw new Error("FCM token wrapping key must decode to 32 bytes");
  }

  private async ready() {
    if (!this.redis.isOpen) this.connecting ??= this.redis.connect();
    await this.connecting;
  }

  private id(subjectId: string, installationId: string) {
    return createHash("sha256")
      .update(`${subjectId}:${installationId}`)
      .digest("hex");
  }

  private encrypt(
    subjectId: string,
    installationId: string,
    registrationToken: string,
  ) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`${subjectId}:${installationId}`, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(registrationToken, "utf8"),
      cipher.final(),
    ]);
    return {
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  private decrypt(value: StoredRegistration) {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(value.nonce, "base64"),
    );
    decipher.setAAD(
      Buffer.from(`${value.subjectId}:${value.installationId}`, "utf8"),
    );
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  async register(input: Omit<PushRegistration, "id">) {
    await this.ready();
    const id = this.id(input.subjectId, input.installationId);
    const value: StoredRegistration = {
      id,
      subjectId: input.subjectId,
      installationId: input.installationId,
      ...this.encrypt(
        input.subjectId,
        input.installationId,
        input.registrationToken,
      ),
    };
    await this.redis
      .multi()
      .set(`realtime:push:${id}`, JSON.stringify(value), {
        EX: this.ttlSeconds,
      })
      .sAdd("realtime:push:index", id)
      .exec();
  }

  async unregister(subjectId: string, installationId: string) {
    await this.remove(this.id(subjectId, installationId));
  }

  async list() {
    await this.ready();
    const ids = (await this.redis.sMembers("realtime:push:index")).slice(
      0,
      1_000,
    );
    if (ids.length === 0) return [];
    const values = await this.redis.mGet(
      ids.map((id) => `realtime:push:${id}`),
    );
    const missing: string[] = [];
    const registrations: PushRegistration[] = [];
    for (let index = 0; index < ids.length; index += 1) {
      const raw = values[index];
      if (!raw) {
        missing.push(ids[index]!);
        continue;
      }
      try {
        const stored = JSON.parse(raw) as StoredRegistration;
        registrations.push({
          id: stored.id,
          subjectId: stored.subjectId,
          installationId: stored.installationId,
          registrationToken: this.decrypt(stored),
        });
      } catch {
        missing.push(ids[index]!);
      }
    }
    if (missing.length > 0)
      await this.redis.sRem("realtime:push:index", missing);
    return registrations;
  }

  async remove(id: string) {
    await this.ready();
    await this.redis
      .multi()
      .del(`realtime:push:${id}`)
      .sRem("realtime:push:index", id)
      .exec();
  }

  async transitionAlert(key: string, next: string) {
    await this.ready();
    return (
      (await this.redis.set(`realtime:alert:${key}`, next, {
        EX: 7 * 24 * 60 * 60,
        GET: true,
      })) ?? undefined
    );
  }

  async close() {
    this.key.fill(0);
    if (this.redis.isOpen) await this.redis.quit();
  }
}

export class MemoryPushRegistrationRepository implements PushRegistrationRepository {
  readonly registrations = new Map<string, PushRegistration>();
  readonly alerts = new Map<string, string>();
  async register(input: Omit<PushRegistration, "id">) {
    const id = createHash("sha256")
      .update(`${input.subjectId}:${input.installationId}`)
      .digest("hex");
    this.registrations.set(id, { id, ...input });
  }
  async unregister(subjectId: string, installationId: string) {
    for (const [id, value] of this.registrations)
      if (
        value.subjectId === subjectId &&
        value.installationId === installationId
      )
        this.registrations.delete(id);
  }
  async list() {
    return [...this.registrations.values()];
  }
  async remove(id: string) {
    this.registrations.delete(id);
  }
  async transitionAlert(key: string, next: string) {
    const previous = this.alerts.get(key);
    this.alerts.set(key, next);
    return previous;
  }
  async close() {}
}

const thresholdBounds = z
  .object({ min: z.number().optional(), max: z.number().optional() })
  .strict();
const thresholds = z
  .object({
    temperatureC: thresholdBounds.optional(),
    ph: thresholdBounds.optional(),
    lightLux: thresholdBounds.optional(),
    nitrateMgL: thresholdBounds.optional(),
    phosphateMgL: thresholdBounds.optional(),
    potassiumMgL: thresholdBounds.optional(),
  })
  .strict();

const alertProfile = z
  .object({
    profileId: z.string().uuid(),
    version: z.number().int().positive(),
    configuration: z
      .object({
        status: z.string().optional(),
        thresholds: thresholds.default({}),
      })
      .strict(),
  })
  .strict();

export type AlertProfile = z.infer<typeof alertProfile>;

export interface AlertProfileResolver {
  resolve(
    deviceId: string,
    organizationId: string,
  ): Promise<AlertProfile | undefined>;
}

export class ProfileThresholdClient implements AlertProfileResolver {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async resolve(deviceId: string, organizationId: string) {
    const base =
      this.environment.PROFILE_SERVICE_URL ?? "http://profile-service:3000";
    const url = new URL(
      `/v1/internal/devices/${encodeURIComponent(deviceId)}/alert-profile`,
      base,
    );
    url.searchParams.set("organizationId", organizationId);
    const response = await this.fetcher(url, {
      headers: {
        authorization: `Bearer ${await serviceToken(this.environment)}`,
      },
    });
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(`Alert profile lookup failed with ${response.status}`);
    return alertProfile.parse(await response.json());
  }
}

export interface PushSender {
  send(
    registrationToken: string,
    parameter: string,
  ): Promise<"SENT" | "UNREGISTERED">;
  sendDeviceUnpaired?(
    registrationToken: string,
  ): Promise<"SENT" | "UNREGISTERED">;
}

export class FcmHttpV1Sender implements PushSender {
  private cached?: { token: string; expiresAt: number };
  private signingKey?: Awaited<ReturnType<typeof importPKCS8>>;

  constructor(
    private readonly projectId: string,
    private readonly clientEmail: string,
    private readonly privateKeyPkcs8Base64: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async accessToken() {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000)
      return this.cached.token;
    this.signingKey ??= await importPKCS8(
      Buffer.from(this.privateKeyPkcs8Base64, "base64").toString("utf8"),
      "RS256",
    );
    const now = Math.floor(Date.now() / 1_000);
    const assertion = await new SignJWT({
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.clientEmail)
      .setSubject(this.clientEmail)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now)
      .setExpirationTime(now + 3_600)
      .sign(this.signingKey);
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) throw new Error("FCM authorization failed");
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) throw new Error("FCM authorization was invalid");
    this.cached = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3_600) * 1_000,
    };
    return this.cached.token;
  }

  async send(registrationToken: string, parameter: string) {
    return this.sendMessage(registrationToken, {
      title: "AlgaGuard threshold alert",
      body: "A reading is outside the assigned algae profile range.",
      data: { type: "THRESHOLD_ALERT", parameter },
    });
  }

  async sendDeviceUnpaired(registrationToken: string) {
    return this.sendMessage(registrationToken, {
      title: "AlgaGuard device unpaired",
      body: "This device is no longer associated with your organization.",
      data: { type: "DEVICE_UNPAIRED" },
    });
  }

  private async sendMessage(
    registrationToken: string,
    value: { title: string; body: string; data: Record<string, string> },
  ) {
    const response = await this.fetcher(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: registrationToken,
            notification: { title: value.title, body: value.body },
            data: value.data,
            android: { priority: "HIGH" },
          },
        }),
      },
    );
    if (response.ok) return "SENT" as const;
    if (response.status === 404) return "UNREGISTERED" as const;
    throw new Error(`FCM delivery failed with ${response.status}`);
  }
}

export class OrganizationPushNotifier {
  constructor(
    private readonly registrations: PushRegistrationRepository,
    private readonly authorize: SubscriptionAuthorizer,
    private readonly sender: PushSender,
    private readonly metrics: RealtimeMetrics,
  ) {}

  async deviceUnpaired(organizationId: string, eventId: string) {
    const recipients = await this.registrations.list();
    for (const registration of recipients) {
      if (
        !(await this.authorize(
          registration.subjectId,
          "organization",
          organizationId,
          ["system.notification"],
        ))
      )
        continue;
      const deliveryKey = createHash("sha256")
        .update(`device-unpaired:${eventId}:${registration.id}`)
        .digest("hex");
      const previous = await this.registrations.transitionAlert(
        deliveryKey,
        "PENDING",
      );
      if (previous === "PENDING" || previous === "SENT") continue;
      try {
        if (!this.sender.sendDeviceUnpaired)
          throw new Error("Device-unpair push delivery is unavailable");
        const result = await this.sender.sendDeviceUnpaired(
          registration.registrationToken,
        );
        if (result === "UNREGISTERED")
          await this.registrations.remove(registration.id);
        else {
          await this.registrations.transitionAlert(deliveryKey, "SENT");
          this.metrics.add("push_notifications_total");
        }
      } catch {
        await this.registrations.transitionAlert(deliveryKey, "FAILED");
        this.metrics.add("push_failures_total");
        throw new Error("Organization notification delivery failed");
      }
    }
  }
}

const labels: Record<string, string> = {
  temperatureC: "temperature",
  ph: "pH",
  lightLux: "light intensity",
  nitrateMgL: "nitrate",
  phosphateMgL: "phosphate",
  potassiumMgL: "potassium",
};

export class ThresholdPushProcessor {
  constructor(
    private readonly registrations: PushRegistrationRepository,
    private readonly profiles: AlertProfileResolver,
    private readonly authorize: SubscriptionAuthorizer,
    private readonly sender: PushSender | undefined,
    private readonly metrics: RealtimeMetrics,
    private readonly alerts?: AlertRepository,
  ) {}

  async process(event: TelemetryCommittedEvent) {
    const profile = await this.profiles.resolve(
      event.deviceId,
      event.organizationId,
    );
    if (!profile) return;
    const values = event.payload.sample.values;
    for (const [parameter, label] of Object.entries(labels)) {
      const value = values[parameter as keyof typeof values];
      if (typeof value !== "number") continue;
      const bounds =
        profile.configuration.thresholds[
          parameter as keyof typeof profile.configuration.thresholds
        ];
      if (!bounds || (bounds.min === undefined && bounds.max === undefined))
        continue;
      const next =
        bounds.min !== undefined && value < bounds.min
          ? "LOW"
          : bounds.max !== undefined && value > bounds.max
            ? "HIGH"
            : "OK";
      const key = createHash("sha256")
        .update(
          `${event.deviceUuid}:${profile.profileId}:${profile.version}:${parameter}`,
        )
        .digest("hex");
      const previous = await this.registrations.transitionAlert(key, next);
      if (next === "OK" || previous === next) continue;
      if (this.alerts) {
        try {
          await this.alerts.record({
            deviceUuid: event.deviceUuid,
            deviceId: event.deviceId,
            organizationId: event.organizationId,
            parameter,
            direction: next,
            value,
            minimum: bounds.min,
            maximum: bounds.max,
            profileId: profile.profileId,
            profileVersion: profile.version,
          });
        } catch {
          this.metrics.add("alert_persistence_failures_total");
        }
      }
      if (!this.sender) continue;
      const sender = this.sender;
      const recipients = await this.registrations.list();
      for (const registration of recipients) {
        if (
          !(await this.authorize(
            registration.subjectId,
            "organization",
            event.organizationId,
            ["alert.updated"],
          ))
        )
          continue;
        try {
          const result = await sender.send(
            registration.registrationToken,
            label,
          );
          if (result === "UNREGISTERED")
            await this.registrations.remove(registration.id);
          else this.metrics.add("push_notifications_total");
        } catch {
          this.metrics.add("push_failures_total");
        }
      }
    }
  }
}
