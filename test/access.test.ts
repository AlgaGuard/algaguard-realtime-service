import assert from "node:assert/strict";
import test from "node:test";
import { createSubscriptionAuthorizer } from "../src/access.js";

test("subscription decisions send UUID resources and event types with service auth", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{
    url: string;
    authorization: string | undefined;
    body: string | undefined;
  }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      authorization: (init?.headers as Record<string, string> | undefined)
        ?.authorization,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (
      url ===
      "http://keycloak:8080/realms/algaguard/protocol/openid-connect/token"
    ) {
      return new Response(
        JSON.stringify({ access_token: "realtime-token", expires_in: 60 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ allowed: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const authorize = createSubscriptionAuthorizer({
      SERVICE_CLIENT_SECRET: "test-only-secret",
      ACCESS_SERVICE_URL: "http://access.test",
      KEYCLOAK_ISSUER: "https://dev.algaguard.example/auth/realms/algaguard",
      KEYCLOAK_TOKEN_URL:
        "http://keycloak:8080/realms/algaguard/protocol/openid-connect/token",
    });
    const deviceUuid = "20000000-0000-4000-8000-000000000001";
    assert.equal(
      await authorize("user-a", "device", deviceUuid, ["telemetry.updated"]),
      true,
    );
    assert.equal(
      calls[0]!.url,
      "http://keycloak:8080/realms/algaguard/protocol/openid-connect/token",
    );
    assert.equal(calls[1]!.authorization, "Bearer realtime-token");
    assert.deepEqual(JSON.parse(calls[1]!.body ?? "{}"), {
      subjectId: "user-a",
      action: "subscription.read",
      resourceType: "device",
      resourceId: deviceUuid,
      eventTypes: ["telemetry.updated"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
