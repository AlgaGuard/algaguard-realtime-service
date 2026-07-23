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
  })
  .superRefine((value, context) => {
    if (value.WS_IDLE_TIMEOUT_MS < value.WS_HEARTBEAT_MS * 2)
      context.addIssue({
        code: "custom",
        path: ["WS_IDLE_TIMEOUT_MS"],
        message: "must be at least twice WS_HEARTBEAT_MS",
      });
  });
export type ServiceConfig = z.infer<typeof environmentSchema>;
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  return environmentSchema.parse(environment);
}
