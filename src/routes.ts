import { Router } from "express";
import { createAuthenticator, type Authenticator } from "./auth.js";
import type { RealtimeMetrics } from "./domain.js";
import type { TicketRepository } from "./tickets.js";
export function createRouter(
  tickets: TicketRepository,
  metrics: RealtimeMetrics,
  authenticate: Authenticator = createAuthenticator(),
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
  return router;
}
