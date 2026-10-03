import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { z } from "zod";
import { createAuthenticator, type Authenticator } from "./auth.js";
import type { OrganizationPushNotifier } from "./push.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(here, "..", "proto", "realtime_service.proto");

function grpcErrorFor(message: string, code: grpc.status): grpc.ServiceError {
  return Object.assign(new Error(message), {
    code,
    name: "DOMAIN_ERROR",
    details: message,
    metadata: new grpc.Metadata(),
  });
}

export interface GrpcServerDependencies {
  organizationNotifier?: Pick<OrganizationPushNotifier, "deviceUnpaired">;
  authenticate?: Authenticator;
}

export function buildGrpcServer(dependencies: GrpcServerDependencies) {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(PROTO_PATH)],
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const authenticate = dependencies.authenticate ?? createAuthenticator();
  const { organizationNotifier } = dependencies;

  const server = new grpc.Server();

  server.addService(
    proto.algaguard.realtime.v1.DeviceNotificationService.service,
    {
      async deviceUnpaired(
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>,
      ) {
        try {
          const [authorization] = call.metadata.get("authorization");
          const principal = await authenticate(
            typeof authorization === "string" ? authorization : undefined,
          );
          if (!principal.service) {
            callback(
              grpcErrorFor(
                "Service token required",
                grpc.status.PERMISSION_DENIED,
              ),
            );
            return;
          }
          if (!organizationNotifier) {
            callback(null, {});
            return;
          }
          const organizationId = z
            .string()
            .uuid()
            .parse(call.request.organizationId);
          const eventId = z.string().uuid().parse(call.request.eventId);
          await organizationNotifier.deviceUnpaired(organizationId, eventId);
          callback(null, {});
        } catch (error) {
          callback(
            grpcErrorFor(
              error instanceof Error ? error.message : "Internal error",
              grpc.status.INVALID_ARGUMENT,
            ),
          );
        }
      },
    },
  );

  return server;
}
