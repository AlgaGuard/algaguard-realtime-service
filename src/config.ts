import { z } from "zod";

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    REDIS_URL: z.string().url(),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    HTTP_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(32 * 1_024),
    WS_MAX_MESSAGE_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1_048_576)
      .default(256 * 1_024),
    WS_MAX_SUBSCRIPTIONS: z.coerce.number().int().min(1).max(50).default(50),
    WS_OUTBOUND_QUEUE_MAX: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(100),
    WS_CONNECTIONS_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(20),
    WS_MESSAGES_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(120),
    WS_HEARTBEAT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(30_000),
    WS_IDLE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(90_000),
    WS_BACKPRESSURE_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(4_194_304)
      .default(512 * 1_024),
    WS_PREAUTH_BUFFER_MESSAGES: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50),
    ALGAGUARD_ENABLE_FCM: z.enum(["0", "1"]).default("0"),
    FCM_PROJECT_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).max(128).optional(),
    ),
    FCM_CLIENT_EMAIL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().email().optional(),
    ),
    FCM_PRIVATE_KEY_PKCS8_BASE64: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(64).optional(),
    ),
    FCM_TOKEN_WRAPPING_KEY_BASE64: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(43).max(48).optional(),
    ),
    PROFILE_SERVICE_URL: z
      .string()
      .url()
      .default("http://profile-service:3000"),
    PUSH_REGISTRATION_TTL_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(90),
  })
  .superRefine((value, context) => {
    if (value.WS_IDLE_TIMEOUT_MS < value.WS_HEARTBEAT_MS * 2)
      context.addIssue({
        code: "custom",
        path: ["WS_IDLE_TIMEOUT_MS"],
        message: "must be at least twice WS_HEARTBEAT_MS",
      });
    if (value.ALGAGUARD_ENABLE_FCM === "1") {
      for (const key of [
        "FCM_PROJECT_ID",
        "FCM_CLIENT_EMAIL",
        "FCM_PRIVATE_KEY_PKCS8_BASE64",
        "FCM_TOKEN_WRAPPING_KEY_BASE64",
      ] as const) {
        if (!value[key])
          context.addIssue({
            code: "custom",
            path: [key],
            message: "is required when FCM is enabled",
          });
      }
      if (
        value.FCM_TOKEN_WRAPPING_KEY_BASE64 &&
        Buffer.from(value.FCM_TOKEN_WRAPPING_KEY_BASE64, "base64").length !== 32
      )
        context.addIssue({
          code: "custom",
          path: ["FCM_TOKEN_WRAPPING_KEY_BASE64"],
          message: "must decode to exactly 32 bytes",
        });
      if (value.FCM_PRIVATE_KEY_PKCS8_BASE64) {
        const decoded = Buffer.from(
          value.FCM_PRIVATE_KEY_PKCS8_BASE64,
          "base64",
        ).toString("utf8");
        if (!decoded.includes("-----BEGIN PRIVATE KEY-----"))
          context.addIssue({
            code: "custom",
            path: ["FCM_PRIVATE_KEY_PKCS8_BASE64"],
            message: "must contain a base64-encoded PKCS8 private key",
          });
      }
    }
  });
export type ServiceConfig = z.infer<typeof environmentSchema>;
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  return environmentSchema.parse(environment);
}
