import crypto from "node:crypto";
import express, { Router } from "express";
import { and, eq } from "drizzle-orm";
import { deals, users } from "@trock-crm/shared/schema";
import { pool } from "../../db.js";
import { runInOfficeTransaction, type FieldOffice } from "../field/cross-office.js";
import { createWalkthroughContactSheetStore } from "./walkthrough-contact-sheet-store.js";
import { ingestWalkthrough } from "./walkthrough-ingress-service.js";

/**
 * The ONE door a machine may use to file walkthrough scope into estimating.
 *
 * WHY THIS EXISTS AT ALL. `POST /api/deals/:id/estimating/walkthrough-extractions` is the finished
 * receiving end, and it is mounted on `tenantRouter` — behind `authMiddleware`, per-user rate limiting
 * and tenant resolution from `req.user.activeOfficeId`. Every one of those assumes a logged-in human,
 * and the CRM's only pre-existing machine paths are the HMAC-signed integration routes mounted before
 * `express.json()` (Procore, SyncHub, bid-board). There was no way for TROCK Scope to knock, which is
 * why the exporter could not be built at all. This is that door, shaped like the ones already here.
 *
 * SIGNED, NOT BEARER. An HMAC over the raw body is what `bid-board-sync` and the internal RFP routes
 * use, and it is strictly better than a shared token for a body this consequential: it proves the
 * SENDER and that the bytes were not altered on the way. Same `express.raw` + timing-safe compare
 * shape, so there is one convention here rather than two.
 *
 * WHAT IT DELIBERATELY DOES NOT ACCEPT:
 *   - an R2 KEY. The ingress derives the contact sheet's key from walkthrough identity precisely so a
 *     caller cannot name an object; accepting one here would reintroduce the confused-deputy read the
 *     receiver refuses by construction.
 *   - an ACTOR it has not proved. `userId` is the CRM user who captured the walk, and it is checked
 *     against `public.users` before anything is written. A machine may file work ON BEHALF OF a person;
 *     it may not invent one.
 *   - a DEAL outside the office it named. The tenant schema comes from `officeSlug`, and the deal is
 *     re-read inside that schema — so a deal id from another office resolves to nothing rather than to
 *     someone else's deal.
 */
export const scopeIngestRoutes = Router();

/** Same shape the sibling integration routes verify with: `sha256=<hex>` over the exact bytes. */
function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = process.env.TROCK_SCOPE_INGEST_SECRET;
  // An unset secret refuses everything. It must never mean "no signature required": that would turn a
  // forgotten environment variable into an open write endpoint on the estimating pipeline.
  if (!secret || !signatureHeader) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signatureHeader.replace(/^sha256=/, "");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    // Non-hex or wrong-length input reaches here. Refused, not thrown.
    return false;
  }
}

async function resolveOfficeBySlug(slug: string): Promise<FieldOffice | null> {
  const { rows } = await pool.query<{ id: string; slug: string }>(
    "SELECT id, slug FROM public.offices WHERE slug = $1 AND is_active = true LIMIT 1",
    [slug]
  );
  return rows[0] ?? null;
}

scopeIngestRoutes.post(
  "/walkthrough-extractions",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res, next) => {
    try {
      const rawBody = req.body as Buffer;
      if (!verifySignature(rawBody, req.headers["x-trock-scope-signature"] as string | undefined)) {
        // Uniform 401 with no detail: which half was wrong is not a machine's business to learn.
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
      } catch {
        res.status(400).json({ error: "Body is not valid JSON" });
        return;
      }

      const officeSlug = typeof body.officeSlug === "string" ? body.officeSlug.trim() : "";
      const dealId = typeof body.dealId === "string" ? body.dealId.trim() : "";
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      if (!officeSlug || !dealId || !userId) {
        res.status(400).json({ error: "officeSlug, dealId and userId are required" });
        return;
      }

      const office = await resolveOfficeBySlug(officeSlug);
      if (!office) {
        // 404 rather than 403: an inactive or unknown office is not a permission answer, and saying
        // which offices exist is not something an unauthenticated-by-person caller should learn.
        res.status(404).json({ error: "Unknown office" });
        return;
      }

      const result = await runInOfficeTransaction(office, userId, async (officeDb) => {
        // THE ACTOR IS PROVED, not accepted. `files.uploaded_by` and the source document's uploader are
        // both stamped from this id, so an unverified value would put a person's name on a machine's
        // work — or a name that does not exist on a row with a foreign key that does.
        const [actor] = await officeDb
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, userId), eq(users.isActive, true)))
          .limit(1);
        if (!actor) return { status: 404 as const, error: "Unknown or inactive user" };

        // Re-read INSIDE the office schema. A deal id from another office finds nothing here, which is
        // what keeps `officeSlug` from being a way to reach across tenants.
        const [deal] = await officeDb
          .select({ id: deals.id })
          .from(deals)
          .where(eq(deals.id, dealId))
          .limit(1);
        if (!deal) return { status: 404 as const, error: "Deal not found in this office" };

        const ingested = await ingestWalkthrough({
          tenantDb: officeDb as never,
          // Re-validated by the ingress itself; this route does not pre-empt that. The two fields it
          // does pin are the ones a caller must not choose: the deal it just proved, and the actor.
          payload: { ...body, dealId, userId } as never,
          contactSheetStore: createWalkthroughContactSheetStore(),
        });
        return { status: 201 as const, ingested };
      });

      if ("error" in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.status(201).json(result.ingested);
    } catch (err) {
      next(err);
    }
  }
);
