import express, { Router } from "express";
import { parseWeeklyReportDeliveryEvent } from "@trock-crm/shared/lib/weeklyReportDelivery";
import { weeklyReportDeliveryWebhookLimiter } from "../../middleware/rate-limit.js";
import { ingestWeeklyReportDeliveryEvent } from "./delivery-service.js";
import { verifyWeeklyReportWebhookSignature } from "./delivery-signature.js";

// POST /api/webhooks/resend — the mail provider telling us what happened AFTER we handed a message over.
//
// This is the endpoint that makes `send_delivered_at` stop being the last word. Until it existed, a weekly
// report addressed to a mistyped domain was accepted by the provider, hard-bounced a minute later, and
// read as delivered forever; the client never got their report and no surface anywhere said so.
//
// PUBLIC AND UNAUTHENTICATED, so three things are true of it that are not true of any CRM route:
//
//   • THE SIGNATURE IS THE ONLY GATE. Verified over the RAW BYTES, which is why this router is mounted
//     ahead of `express.json()` in app.ts and parses with `express.raw()` itself. Re-serialising a parsed
//     body to check a signature does not work — key order, number formatting and unicode escapes are all
//     free to differ — and a verifier that "mostly" works is one that fails open on the payloads that
//     differ, which is not a category anyone can enumerate.
//
//   • IT ANSWERS THE SAME THING TO EVERYTHING IT ACCEPTS. A signed request gets 202 whether it moved a
//     report, lost to a later verdict, named a delivery key this platform never minted, or was about an
//     email that has nothing to do with weekly reports. Distinguishing them would let anyone holding the
//     URL enumerate delivery keys, and a delivery key identifies a specific client's correspondence.
//
//   • THE PROVIDER IS THE RETRY MECHANISM. A 2xx means "do not send this again", so an UNEXPECTED failure
//     must reach the error handler as a 5xx and be re-delivered — not be swallowed into a cheerful 202.
//     The only deliberate non-2xx answers are a failed signature and a body that is not JSON.
//
// The webhook is configured per PROVIDER ACCOUNT, so every system email this company sends produces events
// here — scorecards, RFP notifications, project-number mail, all of it. The ordinary case is a payload with
// no weekly-report tag on it, which is why "not interesting" is a silent 202 rather than anything louder.

const router = Router();

/**
 * 1 MB. Comfortably above any event this provider emits (they are a few hundred bytes) and small enough
 * that an unauthenticated caller cannot make the process buffer something large before the signature —
 * which is the only work an attacker can force here — has even been looked at.
 */
const MAX_WEBHOOK_BODY = "1mb";

router.post(
  "/",
  weeklyReportDeliveryWebhookLimiter,
  express.raw({ type: () => true, limit: MAX_WEBHOOK_BODY }),
  async (req, res, next) => {
    try {
      // `type: () => true` above captures the bytes whatever Content-Type is claimed, so this is a Buffer
      // for any request with a body. Anything else cannot be signature-checked and is refused as unsigned
      // rather than waved through — a caller choosing an odd Content-Type to make the body arrive as `{}`
      // is the oldest way past a raw-body verifier.
      const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
      const verified = rawBody
        ? verifyWeeklyReportWebhookSignature({
            rawBody,
            headers: {
              id: req.headers["svix-id"],
              timestamp: req.headers["svix-timestamp"],
              signature: req.headers["svix-signature"],
            },
            secret: process.env.RESEND_WEBHOOK_SECRET,
          })
        : ({ ok: false, reason: "missing_headers" } as const);

      if (!verified.ok) {
        // The REASON is logged and never returned. "Your signature is wrong" versus "your timestamp is
        // stale" versus "we have no secret configured" is a free oracle for anyone probing the endpoint,
        // and the last of those would advertise a misconfiguration to the whole internet.
        console.warn("[WeeklyReportDelivery] Rejecting unverified webhook", { reason: verified.reason });
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody!.toString("utf8"));
      } catch {
        // Signed, so it IS the provider — but nothing here can act on bytes that are not JSON, and a 2xx
        // would tell them not to bother re-sending it.
        res.status(400).json({ error: "Invalid JSON" });
        return;
      }

      const event = parseWeeklyReportDeliveryEvent(payload);
      if (!event) {
        res.status(202).json({ status: "accepted" });
        return;
      }

      const result = await ingestWeeklyReportDeliveryEvent(event);
      // Logged at the level the outcome deserves: a bounce is the thing this endpoint exists to catch, and
      // it should be findable in the logs without a query. `unknown_key` is a warning rather than an error
      // because it is the EXPECTED state for every send made before this feature shipped — those messages
      // carry no delivery tag at all, so they never reach here, but a key registered and then hard-deleted
      // would, and it is not something anybody can act on.
      const line = {
        eventType: event.detail.eventType,
        status: event.status,
        outcome: result.outcome,
        officeSlug: result.target?.officeSlug ?? null,
        reportId: result.target?.weeklyReportId ?? null,
        bounceClass: event.detail.bounceClass,
      };
      if (result.outcome === "applied" && (event.status === "bounced" || event.status === "failed")) {
        console.error("[WeeklyReportDelivery] A client did NOT receive their weekly report", line);
      } else if (result.outcome === "unmatched" || result.outcome === "unknown_key") {
        console.warn("[WeeklyReportDelivery] Event did not resolve to a report", line);
      } else {
        console.log("[WeeklyReportDelivery] Recorded delivery event", line);
      }

      res.status(202).json({ status: "accepted" });
    } catch (err) {
      // Straight to the error handler, which answers 5xx — so the provider retries. Swallowing this would
      // lose the one copy of a fact nothing else in the platform can reconstruct.
      next(err);
    }
  },
);

export const weeklyReportDeliveryWebhookRoutes = router;
