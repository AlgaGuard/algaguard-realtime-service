import { Router } from "express";
import { z } from "zod";
import { createTicket } from "./tickets.js";
export const router = Router();
router.post("/tickets", async (request, response) => {
  const input = z.object({ subjectId: z.string().min(1) }).parse(request.body);
  response.status(201).json({
    ticket: await createTicket(input.subjectId),
    expiresInSeconds: 30,
    oneTime: true,
  });
});
