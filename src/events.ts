import { z } from "zod";

const decimalSequence = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const extensionMap = z.record(z.string(), z.unknown());
const parameterValues = z
  .object({
    temperatureC: z.number().optional(),
    ph: z.number().min(0).max(14).optional(),
    lightLux: z.number().min(0).optional(),
    nutrientPercent: z.number().min(0).max(100).optional(),
    batteryPercent: z.number().min(0).max(100).optional(),
    batteryVoltageV: z.number().min(0).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "values must not be empty");
const telemetrySample = z
  .object({
    sequence: decimalSequence,
    observedAt: z.string().datetime().optional(),
    timestampQuality: z.enum(["NTP_SYNCED", "RTC_HOLDOVER", "UNSYNCED"]),
    uptimeMs: decimalSequence,
    values: parameterValues,
    qualityFlags: z
      .array(
        z.enum([
          "REAL",
          "DEGRADED",
          "SIMULATED",
          "SENSOR_UNAVAILABLE",
          "OUT_OF_EXPECTED_RANGE",
          "CLOCK_UNSYNCED",
          "SD_RECOVERED",
          "ESTIMATED",
        ]),
      )
      .max(6)
      .optional(),
    simulationScenario: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    extensions: extensionMap.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.timestampQuality === "UNSYNCED" && value.observedAt) {
      context.addIssue({
        code: "custom",
        message: "UNSYNCED samples omit observedAt",
      });
    }
    if (value.timestampQuality !== "UNSYNCED" && !value.observedAt) {
      context.addIssue({
        code: "custom",
        message: "synchronized samples require observedAt",
      });
    }
    if (
      value.qualityFlags?.includes("SIMULATED") &&
      !value.simulationScenario
    ) {
      context.addIssue({
        code: "custom",
        message: "simulated samples require simulationScenario",
      });
    }
  });

export const telemetryCommittedSchema = z
  .object({
    schema: z.literal("urn:algaguard:schema:internal:telemetry-committed:v1"),
    schemaVersion: z.literal("1.0.0"),
    eventId: z.string().uuid(),
    eventType: z.literal("telemetry.committed"),
    occurredAt: z.string().datetime().regex(/Z$/),
    organizationId: z.string().uuid(),
    deviceUuid: z.string().uuid(),
    deviceId: z.string().regex(/^AG-[0-9]{6}$/),
    ownershipVersion: z.string().regex(/^[1-9][0-9]{0,19}$/),
    batchId: z.string().uuid(),
    firstSequence: decimalSequence,
    lastSequence: decimalSequence,
    sampleCount: z.number().int().min(1).max(120),
    payload: z
      .object({
        sample: telemetrySample,
        activeProfile: z
          .object({
            profileId: z.string().uuid(),
            profileVersion: z
              .string()
              .regex(
                /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
              ),
          })
          .strict()
          .optional(),
      })
      .strict(),
    correlationId: z.string().uuid().optional(),
    extensions: extensionMap.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (BigInt(value.firstSequence) > BigInt(value.lastSequence)) {
      context.addIssue({ code: "custom", message: "invalid sequence range" });
    }
    if (value.payload.sample.sequence !== value.lastSequence) {
      context.addIssue({
        code: "custom",
        message: "payload sample must be the last committed sequence",
      });
    }
  });

export type TelemetryCommittedEvent = z.infer<typeof telemetryCommittedSchema>;

export function toTelemetryUpdated(event: TelemetryCommittedEvent) {
  return {
    schema: "urn:algaguard:schema:websocket:telemetry-updated:v1-1" as const,
    schemaVersion: "1.1.0" as const,
    eventId: event.eventId,
    eventType: "telemetry.updated" as const,
    occurredAt: event.occurredAt,
    organizationId: event.organizationId,
    deviceUuid: event.deviceUuid,
    deviceId: event.deviceId,
    sequence: event.lastSequence,
    payload: event.payload,
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    ...(event.extensions ? { extensions: event.extensions } : {}),
  };
}
