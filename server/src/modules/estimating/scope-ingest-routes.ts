import crypto from "node:crypto";
import express, { Router } from "express";
import { and, eq } from "drizzle-orm";
import { deals, users } from "@trock-crm/shared/schema";
import { pool } from "../../db.js";
import { runInOfficeAsUser, type FieldOffice } from "../field/cross-office.js";
import { createWalkthroughContactSheetStore } from "./walkthrough-contact-sheet-store.js";
import {
  ingestWalkthrough,
  validateWalkthroughIngressPayload,
  MAX_WALKTHROUGH_PAYLOAD_BYTES,
  MAX_WALKTHROUGH_TRANSPORT_BYTES,
} from "./walkthrough-ingress-service.js";

/**
 * Same shape as the three backfill scripts use. `dealId` and `userId` land on `uuid` columns, and a
 * non-UUID string passes every non-empty check above only to raise a Postgres `22P02` inside the office
 * transaction — a 500 for what is plainly a malformed request.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `public.offices.slug` is `varchar(100)`. Bounded and character-restricted here so nothing unstorable
 * — a NUL above all — is ever bound into the lookup query.
 */
const OFFICE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

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
  // The limit is the CONTRACT's, imported rather than restated — see MAX_WALKTHROUGH_PAYLOAD_BYTES.
  // A literal here is what let the door refuse payloads the validator next door called valid.
  express.raw({ type: "application/json", limit: MAX_WALKTHROUGH_TRANSPORT_BYTES }),
  async (req, res, next) => {
    try {
      // `express.raw({ type: "application/json" })` SKIPS parsing for any other content type — and for a
      // request with no Content-Type at all — leaving `req.body` as `undefined` (or `{}` once another
      // parser has run). The cast below does not create a Buffer, so `Hmac.update(undefined)` THREW and
      // reached the catch-all as a 500: an unsupported media type reported as a server fault, and one
      // trivially reachable without a signature.
      if (!Buffer.isBuffer(req.body)) {
        res.status(415).json({
          error: "Content-Type must be application/json; the body is read as raw bytes for signing.",
        });
        return;
      }
      const rawBody = req.body;
      if (!verifySignature(rawBody, req.headers["x-trock-scope-signature"] as string | undefined)) {
        // Uniform 401 with no detail: which half was wrong is not a machine's business to learn.
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        res.status(400).json({ error: "Body is not valid JSON" });
        return;
      }
      // `JSON.parse` returns valid JSON that is not an object for `null`, `[]`, `7` and `"x"`. Reading
      // `.officeSlug` off `null` THROWS, so the most trivial malformed body — four bytes — was the one
      // shape that reached the catch-all as a 500 instead of a 400.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        res.status(400).json({ error: "Body must be a JSON object" });
        return;
      }
      const body = parsed as Record<string, unknown>;

      const officeSlug = typeof body.officeSlug === "string" ? body.officeSlug.trim() : "";
      const dealId = typeof body.dealId === "string" ? body.dealId.trim() : "";
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      if (!officeSlug || !dealId || !userId) {
        res.status(400).json({ error: "officeSlug, dealId and userId are required" });
        return;
      }

      // `officeSlug` is NOT part of `validateWalkthroughIngressPayload`'s canonical shape, so the trim
      // above was its only check — and it reaches `resolveOfficeBySlug` as a bound text parameter.
      // Postgres cannot accept a NUL in a text parameter, so `"dal\u0000las"` passed every check here
      // and made the LOOKUP throw: a 500 for a malformed field. Checked against the column's own shape
      // (`offices.slug` is varchar(100)) rather than only for NUL, so the whole class is closed.
      if (!OFFICE_SLUG_RE.test(officeSlug)) {
        res.status(400).json({ error: "officeSlug must be a slug of up to 100 characters" });
        return;
      }
      if (!UUID_RE.test(dealId) || !UUID_RE.test(userId)) {
        res.status(400).json({ error: "dealId and userId must be UUIDs" });
        return;
      }

      // VALIDATE THE WHOLE BODY BEFORE TOUCHING A TENANT. The ingress validator is the contract, and it
      // is cheap and pure — running it first means a malformed export costs one office lookup fewer and,
      // more importantly, answers 400 with the offending field instead of failing partway through a
      // transaction. It is deliberately run AGAIN by `ingestWalkthrough` below: this call is a gate, not
      // a substitute, and the ingress must stay safe for callers that do not come through this door.

      try {
        validateWalkthroughIngressPayload({ ...body, dealId, userId });
      } catch (validationError) {
        next(validationError);
        return;
      }

      const office = await resolveOfficeBySlug(officeSlug);
      if (!office) {
        // 404 rather than 403: an inactive or unknown office is not a permission answer, and saying
        // which offices exist is not something an unauthenticated-by-person caller should learn.
        res.status(404).json({ error: "Unknown office" });
        return;
      }

      // NOT `runInOfficeTransaction`. `ingestWalkthrough` opens its own transaction, and drizzle cannot
      // see an ambient one opened by a raw `BEGIN` on the same client — so it would emit a nested BEGIN
      // (a no-op) and a real COMMIT that closed the wrapper's transaction early, leaving the wrapper's
      // atomicity guarantee false. The service owns the only transaction; this supplies the office
      // search_path and the actor the audit triggers read.
      //
      // The two checks below therefore run OUTSIDE that transaction. They are reads whose job is to
      // refuse a request, not to hold a state: the ingress re-reads the deal inside its own transaction,
      // and the actor is a foreign key the write would fail on regardless. What they buy is a clean
      // 404 instead of a constraint error.
      const result = await runInOfficeAsUser(office, userId, async (officeDb) => {
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
        // `isActive` is this schema's soft-delete marker, and every per-deal action route reaches a deal
        // through `getDealById`, which hides inactive ones. Without it a delayed or replayed export
        // lands a file, a source document, a parse run and extraction rows under a deal no CRM screen
        // will ever show — and answers 201, so the sender records it as filed.
        const [deal] = await officeDb
          .select({ id: deals.id })
          .from(deals)
          .where(and(eq(deals.id, dealId), eq(deals.isActive, true)))
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

/**
 * `entity.too.large`, answered as a 413 instead of a 500.
 *
 * Mounted with `.use()` and NOT inline in the `.post()` chain: Express's `Route.dispatch` SKIPS any
 * handler with arity > 3, so a four-argument function in a route chain is silently never called — it
 * does not error, it just does nothing, which is how the first attempt at this passed review-by-eye and
 * failed every test in the file. Router-level `.use` is where four-arity means "error handler".
 *
 * Scoped to THIS router so it cannot change how any other route reports a body-size failure.
 */
scopeIngestRoutes.use(
  (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && typeof err === "object" && (err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({
        error:
          `Body exceeds the ${MAX_WALKTHROUGH_TRANSPORT_BYTES}-byte transport ceiling. The CONTRACT ` +
          `limit is ${MAX_WALKTHROUGH_PAYLOAD_BYTES} bytes of canonical JSON (validated per payload, ` +
          `so a conforming export is never refused here for its formatting alone) — split the export ` +
          `by walkthrough.`,
      });
      return;
    }
    next(err);
  }
);
