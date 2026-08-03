import { Router } from "express";
import { HttpError } from "./auth.js";
import { createAuthenticator, type Authenticator } from "./auth.js";
import type { RealtimeMetrics } from "./domain.js";
import type { TicketRepository } from "./tickets.js";
import type { PushRegistrationRepository } from "./push.js";
import type { OrganizationPushNotifier } from "./push.js";
import { z } from "zod";
export function createRouter(
  tickets: TicketRepository,
  metrics: RealtimeMetrics,
  authenticate: Authenticator = createAuthenticator(),
  pushRegistrations?: PushRegistrationRepository,
  organizationNotifier?: OrganizationPushNotifier,
) {
  const router = Router();
  router.post("/tickets", async (request, response) => {
    const principal = await authenticate(request.header("authorization"));
    response.status(201).json({
      ticket: await tickets.create(principal.subjectId),
      expiresInSeconds: 30,
      oneTime: true,
    });
  });
  router.get("/metrics", (_request, response) =>
    response.type("text/plain").send(metrics.render()),
  );
  if (pushRegistrations) {
    router.put(
      "/push/registrations/:installationId",
      async (request, response) => {
        const principal = await authenticate(request.header("authorization"));
        const installationId = z
          .string()
          .uuid()
          .parse(request.params.installationId);
        const input = z
          .object({
            platform: z.literal("ANDROID"),
            registrationToken: z.string().min(32).max(4_096).regex(/^\S+$/),
          })
          .strict()
          .parse(request.body);
        await pushRegistrations.register({
          subjectId: principal.subjectId,
          installationId,
          registrationToken: input.registrationToken,
        });
        response.status(204).end();
      },
    );
    router.delete(
      "/push/registrations/:installationId",
      async (request, response) => {
        const principal = await authenticate(request.header("authorization"));
        await pushRegistrations.unregister(
          principal.subjectId,
          z.string().uuid().parse(request.params.installationId),
        );
        response.status(204).end();
      },
    );
  }
  if (organizationNotifier) {
    router.post(
      "/internal/notifications/device-unpaired",
      async (request, response) => {
        const principal = await authenticate(request.header("authorization"));
        if (!principal.service)
          throw new HttpError(403, "Service token required");
        const input = z
          .object({
            organizationId: z.string().uuid(),
            eventId: z.string().uuid(),
          })
          .strict()
          .parse(request.body);
        await organizationNotifier.deviceUnpaired(
          input.organizationId,
          input.eventId,
        );
        response.status(204).end();
      },
    );
  }
  return router;
}
