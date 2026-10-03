import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { buildGrpcServer } from "../src/grpc-server.js";
import type { Authenticator } from "../src/auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(here, "..", "proto", "realtime_service.proto");

const authenticate: Authenticator = async (authorization) => {
  const subjectId = authorization?.replace("Bearer ", "") || "anonymous";
  return { subjectId, service: subjectId === "service" };
};

async function startServer(organizationNotifier?: {
  deviceUnpaired(organizationId: string, eventId: string): Promise<void>;
}) {
  const server = buildGrpcServer({
    ...(organizationNotifier ? { organizationNotifier } : {}),
    authenticate,
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
    );
  });
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(PROTO_PATH)],
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const client = new proto.algaguard.realtime.v1.DeviceNotificationService(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
  );
  return {
    client,
    stop: () =>
      new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
}

function metadataFor(bearer: string) {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${bearer}`);
  return metadata;
}

test("DeviceUnpaired requires a service principal", async () => {
  const { client, stop } = await startServer();
  try {
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          client.deviceUnpaired(
            { organizationId: randomUUID(), eventId: randomUUID() },
            metadataFor("user"),
            (error: grpc.ServiceError, response: unknown) =>
              error ? reject(error) : resolve(response),
          );
        }),
      (error: grpc.ServiceError) => {
        assert.equal(error.code, grpc.status.PERMISSION_DENIED);
        return true;
      },
    );
  } finally {
    await stop();
  }
});

test("DeviceUnpaired calls the organization notifier for a service caller", async () => {
  const calls: { organizationId: string; eventId: string }[] = [];
  const { client, stop } = await startServer({
    async deviceUnpaired(organizationId, eventId) {
      calls.push({ organizationId, eventId });
    },
  });
  try {
    const organizationId = randomUUID();
    const eventId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      client.deviceUnpaired(
        { organizationId, eventId },
        metadataFor("service"),
        (error: grpc.ServiceError) => (error ? reject(error) : resolve()),
      );
    });
    assert.deepEqual(calls[0], { organizationId, eventId });
  } finally {
    await stop();
  }
});
