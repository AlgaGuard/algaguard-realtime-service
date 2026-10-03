import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  createServiceTokenProvider,
  metadataWithServiceToken,
} from "./grpc-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ACCESS_PROTO_PATH = path.resolve(
  here,
  "..",
  "proto",
  "access_service.proto",
);
const RESOURCE_TYPE_NUMBER: Record<
  "organization" | "device" | "current-user",
  number
> = {
  organization: 1,
  device: 2,
  "current-user": 6,
};

export type SubscriptionAuthorizer = (
  subjectId: string,
  resourceType: "organization" | "device" | "current-user",
  resourceId?: string,
  events?: string[],
) => Promise<boolean>;
let cachedToken: { value: string; expiresAt: number } | undefined;
export async function serviceToken(environment: NodeJS.ProcessEnv) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 10_000)
    return cachedToken.value;
  const issuer =
    environment.KEYCLOAK_ISSUER ?? "http://keycloak:8080/realms/algaguard";
  const tokenUrl =
    environment.KEYCLOAK_TOKEN_URL ?? `${issuer}/protocol/openid-connect/token`;
  if (!environment.SERVICE_CLIENT_SECRET)
    throw new Error("SERVICE_CLIENT_SECRET is required");
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: environment.SERVICE_CLIENT_ID ?? "algaguard-realtime-service",
      client_secret: environment.SERVICE_CLIENT_SECRET,
    }),
  });
  if (!response.ok) throw new Error("Realtime service authentication failed");
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) throw new Error("Service token response invalid");
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 30) * 1000,
  };
  return cachedToken.value;
}
export function createSubscriptionAuthorizer(
  environment: NodeJS.ProcessEnv = process.env,
): SubscriptionAuthorizer {
  const base = environment.ACCESS_SERVICE_URL ?? "http://access-service:3000";
  return async (subjectId, resourceType, resourceId, events) => {
    const response = await fetch(`${base}/v1/internal/authorizations/decide`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await serviceToken(environment)}`,
      },
      body: JSON.stringify({
        subjectId,
        action: "subscription.read",
        resourceType,
        ...(resourceId ? { resourceId } : {}),
        ...(events ? { eventTypes: events } : {}),
      }),
    });
    if (!response.ok)
      throw new Error(`Access authorization failed with ${response.status}`);
    return Boolean(((await response.json()) as { allowed?: boolean }).allowed);
  };
}

export function createGrpcSubscriptionAuthorizer(
  address: string,
  environment: NodeJS.ProcessEnv = process.env,
  tokenProvider = createServiceTokenProvider(environment),
): SubscriptionAuthorizer {
  const packageDefinition = protoLoader.loadSync(ACCESS_PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(ACCESS_PROTO_PATH)],
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const client = new proto.algaguard.access.v1.AuthorizationService(
    address,
    grpc.credentials.createInsecure(),
  );
  return async (subjectId, resourceType, resourceId) => {
    const metadata = await metadataWithServiceToken(tokenProvider);
    const response = await new Promise<any>((resolve, reject) => {
      client.decide(
        {
          subjectId,
          action: "subscription.read",
          resourceType: RESOURCE_TYPE_NUMBER[resourceType],
          ...(resourceId ? { resourceId } : {}),
        },
        metadata,
        (error: grpc.ServiceError, value: unknown) =>
          error ? reject(error) : resolve(value),
      );
    }).catch(() => undefined);
    return Boolean(response?.allowed);
  };
}
