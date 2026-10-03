import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createGrpcSubscriptionAuthorizer } from "../src/access.js";
import { GrpcProfileThresholdClient } from "../src/push.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function loadProto(file: string) {
  const protoPath = path.resolve(here, "..", "proto", file);
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(protoPath)],
  });
  return grpc.loadPackageDefinition(packageDefinition) as any;
}

function withFakeTokenEndpoint(
  testFn: (environment: NodeJS.ProcessEnv) => Promise<void>,
) {
  return async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      if (String(input).includes("/protocol/openid-connect/token"))
        return new Response(
          JSON.stringify({ access_token: "fake-token", expires_in: 300 }),
          { status: 200 },
        );
      return originalFetch(input);
    }) as typeof fetch;
    try {
      await testFn({
        SERVICE_CLIENT_SECRET: "test-secret",
        SERVICE_CLIENT_ID: "algaguard-realtime-service",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
}

test(
  "createGrpcSubscriptionAuthorizer calls Decide with a service token",
  withFakeTokenEndpoint(async (environment) => {
    const proto = loadProto("access_service.proto");
    const received: any[] = [];
    const server = new grpc.Server();
    server.addService(proto.algaguard.access.v1.AuthorizationService.service, {
      decide(
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>,
      ) {
        received.push({
          request: call.request,
          authorization: call.metadata.get("authorization")[0],
        });
        callback(null, {
          allowed: true,
          reason: "",
          decidedAt: new Date().toISOString(),
          ttlSeconds: 5,
        });
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
      );
    });
    try {
      const authorize = createGrpcSubscriptionAuthorizer(
        `127.0.0.1:${port}`,
        environment,
      );
      const organizationId = randomUUID();
      const allowed = await authorize("owner", "organization", organizationId);
      assert.equal(allowed, true);
      assert.equal(received[0]?.authorization, "Bearer fake-token");
      assert.equal(received[0]?.request.action, "subscription.read");
      assert.equal(received[0]?.request.resourceType, 1); // organization
    } finally {
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    }
  }),
);

test(
  "GrpcProfileThresholdClient resolves an alert profile, and treats NOT_FOUND as no assignment",
  withFakeTokenEndpoint(async (environment) => {
    const proto = loadProto("profile_service.proto");
    const deviceId = "AG-000001";
    const organizationId = randomUUID();
    const server = new grpc.Server();
    server.addService(proto.algaguard.profile.v1.ProfileLookupService.service, {
      getAlertProfile(
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>,
      ) {
        if (call.request.deviceId !== deviceId) {
          callback(
            Object.assign(new Error("not found"), {
              code: grpc.status.NOT_FOUND,
            }),
          );
          return;
        }
        callback(null, {
          profileId: "11111111-1111-4111-8111-111111111111",
          version: 1,
          configurationJson: JSON.stringify({
            status: "active",
            thresholds: { ph: { min: 6, max: 8 } },
          }),
        });
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
      );
    });
    try {
      const client = new GrpcProfileThresholdClient(
        `127.0.0.1:${port}`,
        environment,
      );
      const resolved = await client.resolve(deviceId, organizationId);
      assert.equal(resolved?.profileId, "11111111-1111-4111-8111-111111111111");
      assert.equal(resolved?.configuration.thresholds.ph?.min, 6);

      const missing = await client.resolve("AG-999999", organizationId);
      assert.equal(missing, undefined);
    } finally {
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    }
  }),
);
