import { Router } from "express";
import { createAuthenticator, type Authenticator } from "./auth.js";
import type { RealtimeMetrics } from "./domain.js";
import type { TicketRepository } from "./tickets.js";
import type { PushRegistrationRepository } from "./push.js";
import { z } from "zod";
export function createRouter(
  tickets: TicketRepository,
  metrics: RealtimeMetrics,
  authenticate: Authenticator = createAuthenticator(),
  pushRegistrations?: PushRegistrationRepository,
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
  return router;
}
