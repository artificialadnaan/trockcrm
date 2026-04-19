// server/src/modules/procore/webhook-routes.ts
// POST /api/webhooks/procore — public route (no JWT).
// Validates X-Procore-Signature HMAC-SHA256. Dedup via procore_webhook_log.

import { Router } from "express";
import express from "express";
import crypto from "crypto";
import { db } from "../../db.js";
import { procoreWebhookLog } from "@trock-crm/shared/schema";
import { and, eq, gt, sql } from "drizzle-orm";

const router = Router();

function verifyProcoreSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined
): boolean {
  const secret = process.env.PROCORE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[Procore:webhook] PROCORE_WEBHOOK_SECRET not set — rejecting");
    return false;
  }
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Use timingSafeEqual to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signatureHeader.replace(/^sha256=/, ""), "hex")
    );
  } catch {
    return false;
  }
}

// Raw body capture middleware (needed for HMAC verification)
// Applied only to this route — must be mounted BEFORE express.json() for this path
router.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res, next) => {
    try {
      const rawBody = req.body as Buffer;
      const signature = req.headers["x-procore-signature"] as string | undefined;

      if (!verifyProcoreSignature(rawBody, signature)) {
        console.warn("[Procore:webhook] Signature verification failed — rejecting");
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      let payload: any;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        res.status(400).json({ error: "Invalid JSON" });
        return;
      }

      const eventType: string = payload.event_type ?? payload.resource_name ?? "unknown";
      const resourceId: number = payload.id ?? payload.resource_id ?? 0;

      // Dedup check: same event_type + resource_id within 60 seconds
      const sixtySecondsAgo = new Date(Date.now() - 60_000);
      const [recentDuplicate] = await db
        .select({ id: procoreWebhookLog.id })
        .from(procoreWebhookLog)
        .where(
          and(
            eq(procoreWebhookLog.eventType, eventType),
            eq(procoreWebhookLog.resourceId, resourceId),
            gt(procoreWebhookLog.receivedAt, sixtySecondsAgo)
          )
        )
        .limit(1);

      if (recentDuplicate) {
        console.log(
          `[Procore:webhook] Duplicate event ${eventType}:${resourceId} within 60s — skipping`
        );
        res.json({ status: "duplicate_skipped" });
        return;
      }

      const logEntry = await db.transaction(async (tx) => {
        const [createdLogEntry] = await tx
          .insert(procoreWebhookLog)
          .values({
            eventType,
            resourceId,
            payload,
            processed: false,
          })
          .returning();

        await tx.execute(
          sql`INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
              VALUES ('procore_webhook', ${JSON.stringify({
                webhookLogId: createdLogEntry.id,
                eventType,
                resourceId,
                payload,
              })}::jsonb, NULL, 'pending', NOW())`
        );

        return createdLogEntry;
      });

      res.json({ status: "accepted", logId: logEntry.id });
    } catch (err) {
      next(err);
    }
  }
);

export const procoreWebhookRoutes = router;
