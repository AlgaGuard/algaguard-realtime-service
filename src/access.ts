export type SubscriptionAuthorizer = (
  subjectId: string,
  resourceType: "organization" | "device" | "current-user",
  resourceId?: string,
  events?: string[],
) => Promise<boolean>;
let cachedToken: { value: string; expiresAt: number } | undefined;
async function serviceToken(environment: NodeJS.ProcessEnv) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 10_000)
    return cachedToken.value;
  const issuer =
    environment.KEYCLOAK_ISSUER ?? "http://keycloak:8080/realms/algaguard";
  if (!environment.SERVICE_CLIENT_SECRET)
    throw new Error("SERVICE_CLIENT_SECRET is required");
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
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
