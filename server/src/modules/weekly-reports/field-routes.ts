// The T-Rock Cam half of Weekly Reports, mounted under /api/field/weekly-reports.
//
// WHY A SECOND ROUTER RATHER THAN OPENING THE CRM ONE. The two surfaces authenticate differently and
// carry different blast radii, not different logic. A field session is a `surface: "field"` JWT that the
// CRM mount rejects outright (#722), and the CRM router is gated to admin/director/rep precisely because
// its dashboard, settings and setup endpoints expose the whole office. So this file is routing and
// authentication only: every handler calls the SAME service function the CRM router calls, and every
// authorisation decision is made inside those services against `trock_super_user_id` /
// `trock_pm_user_id`. Duplicating a rule here would create exactly the divergence the design set out to
// avoid — the PM can review on either surface, so a gate that exists on one and not the other is a gate.
//
// The one thing this file adds is presigned image URLs. The services deal in file ids because the PDF
// renderer and the public viewer resolve their own; a phone needs a URL it can put in an <Image>.

import { Router, type Request } from "express";
import { businessToday } from "../../lib/period.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  weeklyReportDictationDailyLimiter,
  weeklyReportDictationLimiter,
} from "../../middleware/rate-limit.js";
import { requireFieldContractor } from "../../middleware/field-auth.js";
import { tenantMiddleware } from "../../middleware/tenant.js";
import { resolvePhotoDisplayUrls } from "../files/service.js";
import { listWeeklyReportAssignments } from "./assignments-service.js";
import { formatWeeklyReportDictation } from "./dictation-service.js";
import {
  createWeeklyReportDraft,
  getWeeklyReportForActor,
  listWeeklyReportPhotoCandidates,
  replaceWeeklyReportPhotos,
  transitionWeeklyReport,
  updateWeeklyReportContent,
  type WeeklyReportActor,
} from "./reports-service.js";
import {
  buildWeeklyReportSendDraft,
  createWeeklyReportCorrection,
  remintWeeklyReportShareLink,
  retryWeeklyReportSend,
  sendWeeklyReport,
} from "./send-service.js";
import { assertClientLinksAreConfigured, weeklyReportShareUrl } from "./tokens-service.js";
import { toFieldWeeklyReportProject, type QueryExecutor } from "./projects-service.js";

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Dictation — registered ABOVE the router-wide middleware ON PURPOSE
// ---------------------------------------------------------------------------

/**
 * Clean up a dictated transcript into report bullets.
 *
 * MOUNTED BEFORE `router.use(requireFieldContractor, tenantMiddleware)` BELOW, AND THAT ORDERING IS LOAD
 * BEARING. Express matches layers in registration order, so a POST here is answered by this handler and
 * never reaches the router-wide middleware. That is the point: this endpoint reads and writes no rows,
 * and the pass behind it waits on a model call. Under the shared middleware it would hold a pooled
 * Postgres connection open inside a transaction for the whole round trip — the exact shape of the
 * pool-saturation outage this API has already had once, bought for nothing. It keeps
 * `requireFieldContractor` explicitly, so it is authenticated exactly like every route below it, and it
 * is the SAME arrangement the field photo-transcription endpoint already uses one layer up.
 *
 * If you add another route above the `router.use` line, give it `requireFieldContractor` too — the router
 * mount does not supply it up here.
 *
 * The response is an ADDITION the app appends to whatever the superintendent has already written; it is
 * never given, and can never return, the existing section. `existingChars` is a count used only to size
 * the remaining room. See dictation-service.ts for why that split matters.
 */
// AFTER `requireFieldContractor`, which is what makes the limiter's per-USER key readable and keeps an
// unauthenticated flood from consuming anyone's bucket. This is the one authenticated route in the app
// that spends money per call — see weeklyReportDictationLimiter for the sizing and why it is not keyed by
// IP like its siblings.
router.post(
  "/dictation",
  requireFieldContractor,
  weeklyReportDictationLimiter,
  weeklyReportDictationDailyLimiter,
  async (req, res, next) => {
    try {
      // Passed through UNCOERCED so the service's own type and length checks stay reachable: substituting
      // "" for a malformed transcript would answer 200 with an empty addition and look like a clean
      // dictation that simply heard nothing.
      const result = await formatWeeklyReportDictation({
        transcript: req.body?.transcript,
        existingChars: req.body?.existingChars,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// Every route needs a field session AND an office-bound transaction. tenantMiddleware pins the search_path
// to the user's ACTIVE office (the `x-office-id` header requireFieldContractor already validated) and
// hands back both a drizzle handle and the raw PoolClient the weekly-report services are written against.
//
// Note this is single-office, unlike the field photo routes' cross-office fan-out. A weekly report is
// authored by a named superintendent against a setup row a PM created in one office; there is no
// "browse every office's projects" case to serve, and fanning out would mean resolving which office owns
// a report before every mutation for no reachable benefit.
router.use(requireFieldContractor, tenantMiddleware);

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AppError(400, `${label} must be a valid UUID`);
  }
  return value;
}

/**
 * The acting user, as the services understand one.
 *
 * `role` here is the EFFECTIVE role requireFieldContractor resolved (including an office-scoped
 * override), which is what decides whether admin/director powers apply. Reading `req.user.role` instead
 * would use the home-office role and could grant elevation in an office where the user has none.
 */
function actorFrom(req: Request): WeeklyReportActor {
  const user = req.fieldUser;
  if (!user?.id) throw new AppError(401, "Authentication required");
  return { id: user.id, role: String(user.role ?? "") };
}

/** "Today" in the OFFICE's timezone. A crew in Dallas is not on the server's UTC clock. */
function asOfFrom(): string {
  return businessToday();
}

/**
 * The office this request is scoped to, which the send flow needs and the authoring flow does not.
 *
 * `activeOfficeId` is set by requireFieldContractor (it validates the `x-office-id` header against
 * `user_office_access` before writing it), and `officeSlug` by tenantMiddleware. Both are already the
 * values the search_path was pinned to, so the token row and the job row cannot be written against a
 * different office than the one whose report was just read. Absent means the request never went through
 * the mount's own middleware, which is a wiring bug rather than a user error.
 */
function officeContextFrom(req: Request): { slug: string; tenantId: string } {
  const slug = req.officeSlug;
  const tenantId = req.user?.activeOfficeId;
  if (!slug || !tenantId) throw new AppError(400, "Office context not available");
  return { slug, tenantId };
}

/**
 * Presign a thumbnail + full-size URL for each file id, in ONE query.
 *
 * A per-photo `getFileDownloadUrl` would issue a SELECT each; the picker's window is 14 days of a jobsite
 * and routinely holds a hundred photos, and req.tenantClient is a single connection so those SELECTs
 * serialise. Presigning is a local HMAC operation, so the batched read is the only real cost.
 */
async function resolvePhotoUrls(
  client: QueryExecutor,
  fileIds: string[],
): Promise<Map<string, { thumbnailUrl: string | null; fullUrl: string | null }>> {
  const urls = new Map<string, { thumbnailUrl: string | null; fullUrl: string | null }>();
  if (fileIds.length === 0) return urls;

  const result = await client.query(
    `SELECT id, r2_key, thumbnail_r2_key, external_url, external_thumbnail_url,
            display_name, file_extension
       FROM files
      WHERE id = ANY($1::uuid[])`,
    [fileIds],
  );
  for (const row of result.rows) {
    // A single unresolvable photo must not fail the whole picker — it renders as a placeholder tile,
    // which is what the grid already does for a null url.
    try {
      urls.set(
        row.id,
        await resolvePhotoDisplayUrls({
          r2Key: row.r2_key,
          thumbnailR2Key: row.thumbnail_r2_key,
          externalUrl: row.external_url,
          externalThumbnailUrl: row.external_thumbnail_url,
          displayName: row.display_name,
          fileExtension: row.file_extension,
        }),
      );
    } catch {
      urls.set(row.id, { thumbnailUrl: null, fullUrl: null });
    }
  }
  return urls;
}

/**
 * Applied to EVERY `report` this mount answers with, including the send, retry and correction responses.
 *
 * The uniform shape is the point: a client that has to remember which endpoints presign and which return
 * bare file ids will eventually render an empty grid on the one it forgot. It runs inside the request
 * transaction, so on the send path a failure here rolls the send back — which is the safe direction, and
 * the only one available: after the commit the email is queued and nothing can recall it.
 */
async function withPhotoUrls<T extends { fileId: string }>(
  client: QueryExecutor,
  photos: T[],
): Promise<Array<T & { thumbnailUrl: string | null; fullUrl: string | null }>> {
  const urls = await resolvePhotoUrls(client, photos.map((photo) => photo.fileId));
  return photos.map((photo) => ({
    ...photo,
    thumbnailUrl: urls.get(photo.fileId)?.thumbnailUrl ?? null,
    fullUrl: urls.get(photo.fileId)?.fullUrl ?? null,
  }));
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

// Everything the Reports tab needs in one round trip: the projects this user owes reports on, anything
// sitting in their PM queue, and any week they SENT that has not reached the client. One call rather than
// three because the hub renders them together and a jobsite LTE connection makes every extra request a
// chance to show half a screen.
//
// `undeliveredSends` is additive, and had to be: `mobile/` has no OTA, so this response is read today by
// builds that will never be updated. An unknown key is ignored by every one of them; a `sent` row pushed
// into `pendingReview` would not have been.
router.get("/assignments", async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    const data = await listWeeklyReportAssignments(req.tenantClient!, {
      userId: actor.id,
      role: actor.role,
      asOf: asOfFrom(),
    });
    await req.commitTransaction!();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

// Start (or recover) the week's draft. Idempotent on clientSubmissionId, which the phone stamps once when
// the local draft is created and reuses on every retry — so a submit that times out on the way back does
// not produce a second report for the week. 200 on a retry, 201 on a genuine create, matching the field
// capture convention so the app can tell them apart without parsing the body.
router.post("/reports", async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    const { report, created } = await createWeeklyReportDraft(
      req.tenantClient!,
      {
        clientSubmissionId: requireUuid(req.body?.clientSubmissionId, "clientSubmissionId"),
        weeklyReportProjectId: requireUuid(req.body?.weeklyReportProjectId, "weeklyReportProjectId"),
        weekOf: String(req.body?.weekOf ?? ""),
      },
      actor,
    );
    await req.commitTransaction!();
    res.status(created ? 201 : 200).json({ report });
  } catch (error) {
    next(error);
  }
});

router.get("/reports/:id", async (req, res, next) => {
  try {
    const { report, project, permissions } = await getWeeklyReportForActor(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      actorFrom(req),
    );
    const photos = await withPhotoUrls(req.tenantClient!, report.photos);
    await req.commitTransaction!();
    res.json({
      report: { ...report, photos },
      project: toFieldWeeklyReportProject(project),
      permissions,
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/reports/:id", async (req, res, next) => {
  try {
    const report = await updateWeeklyReportContent(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      req.body ?? {},
      actorFrom(req),
    );
    await req.commitTransaction!();
    res.json({ report });
  } catch (error) {
    next(error);
  }
});

// The picker's candidate set. Authorised FIRST — listWeeklyReportPhotoCandidates has no view check of its
// own (the CRM router's role gate stood in for one), and without this any field user could enumerate a
// project's photo descriptions by report id.
router.get("/reports/:id/photo-candidates", async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, "id");
    await getWeeklyReportForActor(req.tenantClient!, id, actorFrom(req));
    const candidates = await listWeeklyReportPhotoCandidates(req.tenantClient!, id);
    const photos = await withPhotoUrls(req.tenantClient!, candidates.photos);
    await req.commitTransaction!();
    // `total` is the whole candidate set; `photos` is the capped slice of it. The app compares the two
    // and says what it is not showing rather than presenting a truncated fortnight as the fortnight.
    res.json({ photos, total: candidates.total });
  } catch (error) {
    next(error);
  }
});

router.put("/reports/:id/photos", async (req, res, next) => {
  try {
    // Passed through UNCOERCED so the service's own Array.isArray check stays reachable: substituting []
    // for a malformed payload would answer 200 and silently delete every photo on the report.
    const report = await replaceWeeklyReportPhotos(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      req.body?.photos,
      actorFrom(req),
    );
    const photos = await withPhotoUrls(req.tenantClient!, report.photos);
    await req.commitTransaction!();
    res.json({ report: { ...report, photos } });
  } catch (error) {
    next(error);
  }
});

// Submit for review / approve / bounce back. The PM gate lives in canTransitionAs, not here — a
// superintendent posting `{"to":"approved"}` from a patched build is refused by the service.
router.post("/reports/:id/transition", async (req, res, next) => {
  try {
    // `sent` is NOT reachable here, and this refusal SURVIVES the send flow shipping.
    //
    // It used to be a 409 saying sending was "not available in the app yet". That was the deferral. The
    // send flow now exists below, so the sentence changed — but the guard did not, because what it stops
    // was never about the feature being unfinished. `canTransitionAs` grants `sent` to PM powers, so a PM
    // reaching it THROUGH THIS ENDPOINT would stamp sent_by/sent_at and freeze the header snapshot with no
    // email composed, no token minted and no delivery queued: the week stops being owed, the board reads
    // "Sent", and the client has nothing.
    //
    // Nothing cleans that up. The row is immutable (`canEditWeeklyReport` is false at `sent`), and
    // `retryWeeklyReportSend` refuses it outright — it has no `send_request` to replay, which is exactly
    // the "there is no send on this report to retry" case. A correction IS still possible, so the WEEK is
    // recoverable, but the row is not: it sits on the board for the 26-week lookback as a send that never
    // delivered and can never be retried, and the correction goes out as a first copy because no earlier
    // version ever reached the client — which is true, and is the giveaway that the first "send" was not
    // one.
    //
    // Sending is POST /reports/:id/send, which does the transition, the snapshot, the token and the queued
    // delivery in ONE transaction. Same wording and same reason as the CRM router's guard (routes.ts).
    if (req.body?.to === "sent") {
      throw new AppError(400, "Use the send endpoint to send a report to the client");
    }
    const report = await transitionWeeklyReport(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      req.body?.to,
      actorFrom(req),
    );
    await req.commitTransaction!();
    res.json({ report });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Send + corrections — THE ASSIGNED PM's, on the surface the assigned PM uses
// ---------------------------------------------------------------------------

// WHY THESE ARE HERE AND NOT ON THE CRM ROUTER.
//
// The person who should send a weekly report is the assigned PM, and until now they were the one person
// who could not. The CRM's send is gated `admin | director` (`requireWeeklyReportSender`), while
// `ASSIGNABLE_ROLES` — who may hold the PM slot at all — is field_contractor/construction/admin/director.
// Intersect those and `canPublishWeeklyReport`'s assigned-PM arm could only ever fire for somebody who was
// already leadership; a `construction` PM, which is the ordinary case, got 403 at the router before any
// permission logic ran.
//
// The fix is NOT to widen the CRM router. That router is the office-wide leadership board, the client
// contact book and the dismissal ledger, and admitting `construction` there would hand every
// superintendent in the office the whole surface — on top of a known open question about the construction
// role's CRM boundary. So the capability goes where the PM already authenticates, on a mount that carries
// nothing but their own reports.
//
// AUTHORISATION IS THE SERVICE'S, NOT THIS FILE'S. There is no role gate below, deliberately: every one of
// these four handlers reaches a send-service.ts function that calls `canPublishWeeklyReport` itself, under
// FOR UPDATE on both the report and its setup row. That is what makes the answer the same whichever
// surface asks, and it is why a superintendent is refused even though they authenticate here perfectly
// well — /api/field admits every field user in the company, so a router-level gate would be the only
// thing standing between any of them and any project's client contacts.

/**
 * The send modal, COMPOSED SERVER-SIDE and returned as data.
 *
 * The same draft the CRM's dialog renders, from the same endpoint's service, so "the modal is identical on
 * both surfaces" is a fact about there being one composer rather than a promise two clients keep. It
 * carries the client's addresses and the PM's phone number, which is why it takes the publication gate
 * rather than the weaker read gate the rest of this file uses.
 *
 * IT RETURNS NO SHARE URL, for a sent report or any other — see buildWeeklyReportSendDraft. The raw token
 * is handed back exactly once, by the send itself.
 */
router.get("/reports/:id/send-draft", async (req, res, next) => {
  try {
    const draft = await buildWeeklyReportSendDraft(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      actorFrom(req),
    );
    await req.commitTransaction!();
    res.json({ draft });
  } catch (error) {
    next(error);
  }
});

/**
 * Send the report to the client.
 *
 * Everything below the commit is a queued job. What happens INSIDE the transaction is the part that must
 * be atomic: the `approved -> sent` transition, the frozen header snapshot, the minted 180-day token and
 * the job row that will deliver it. Splitting the token mint out of that transaction — minting it after
 * the commit, say, to answer faster — would let a report reach `sent` with no link for its email to point
 * at, which nothing reconciles.
 *
 * `shareUrl` IS THE ONLY TIME THE RAW TOKEN EXISTS. public.weekly_report_tokens stores a SHA-256 hash, so
 * this response is unreproducible: the app must show it and must NOT write it to the draft store, a log or
 * crash telemetry.
 *
 * AND LOSING IT IS SURVIVABLE, WHICH IS WHY THAT IS ACCEPTABLE — but not from this surface. `POST
 * /reports/:id/share-link` mints a fresh one and is on the CRM router, behind that router's
 * admin/director/rep gate, so the `construction` PM sending here cannot reach it: somebody in leadership
 * mints the replacement. Deliberately NOT mirrored onto this mount in this change. The four endpoints
 * below are the send; adding a fifth that hands out durable unauthenticated client credentials is a
 * separate decision with its own blast radius, and the client already has their link — it is in the email
 * this call queues. What the PM loses is only their own copy of it.
 */
router.post("/reports/:id/send", async (req, res, next) => {
  try {
    // CHECKED BEFORE ANYTHING IS MINTED, and it matters more from a phone than from the CRM: a PM sending
    // on a jobsite has no way to notice that the link they just emailed points at a host that does not
    // serve /wr. Nothing downstream of the commit can stop the email, so a warning after it could only
    // describe a client link that had already gone out.
    assertClientLinksAreConfigured();
    const office = officeContextFrom(req);
    const { report, shareUrl } = await sendWeeklyReport(req.tenantClient!, {
      reportId: requireUuid(req.params.id, "id"),
      office: { tenantId: office.tenantId, slug: office.slug },
      actor: actorFrom(req),
      payload: req.body ?? {},
      shareUrlFor: (rawToken) => weeklyReportShareUrl(req, rawToken),
    });
    const photos = await withPhotoUrls(req.tenantClient!, report.photos);
    await req.commitTransaction!();
    res.status(202).json({ report: { ...report, photos }, shareUrl });
  } catch (error) {
    next(error);
  }
});

/**
 * Mint a fresh client link for a report this PM already sent.
 *
 * #17. The send screen shows the link exactly once and says so; only a SHA-256 hash is stored, so nothing
 * can hand the original back. Until now the only way to get another was `POST /reports/:id/share-link` on
 * the CRM router, behind its admin/director/rep gate — which a `construction` PM cannot reach. A field PM
 * who closed the screen had to ask a director for a link to a report they wrote and sent themselves.
 *
 * The gate is `canPublishWeeklyReport`, enforced in the service and shared with the CRM route, so the two
 * surfaces cannot answer "who may mint a client credential" differently.
 */
router.post("/reports/:id/share-link", async (req, res, next) => {
  try {
    // Same reasoning as the field send: from a jobsite there is no way to notice that a link points at a
    // host which does not serve /wr, and the PM is about to hand this to somebody.
    assertClientLinksAreConfigured();
    const office = officeContextFrom(req);
    const { url, token } = await remintWeeklyReportShareLink(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      actorFrom(req),
      { tenantId: office.tenantId, slug: office.slug },
      (rawToken) => weeklyReportShareUrl(req, rawToken),
    );
    await req.commitTransaction!();
    // 201 and the raw URL, returned EXACTLY ONCE, exactly as the CRM route does.
    res.status(201).json({ url, token });
  } catch (error) {
    next(error);
  }
});

/**
 * Queue the same message again for a send that has not reached the client.
 *
 * `acknowledgeDuplicateRisk` is the caller confirming they understand that past the provider's 24-hour
 * idempotency window a replay is a genuinely second email, not a no-op. Default false: silence must mean
 * the safe answer, on this surface as much as on the CRM's.
 *
 * REACHED FROM THE APP, by the assigned PM, on `/(app)/reports/delivery/[reportId]`. The week gets there
 * from `undeliveredSends` on the hub feed, which is the list `assignments-service.ts` added for exactly
 * this: a `sent` week leaves the review queue, so before it existed nothing in T-Rock Cam could show a
 * failed send at all. The phone asks for the acknowledgement with its own confirmation before it sets the
 * flag — but this route trusts none of that, which is the point of the flag being a request field rather
 * than a client-side rule.
 */
router.post("/reports/:id/send/retry", async (req, res, next) => {
  try {
    const office = officeContextFrom(req);
    const report = await retryWeeklyReportSend(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      actorFrom(req),
      { tenantId: office.tenantId, slug: office.slug },
      { acknowledgeDuplicateRisk: req.body?.acknowledgeDuplicateRisk === true },
    );
    const photos = await withPhotoUrls(req.tenantClient!, report.photos);
    await req.commitTransaction!();
    res.status(202).json({ report: { ...report, photos } });
  } catch (error) {
    next(error);
  }
});

/**
 * Clone a sent report to the next version so it can be corrected.
 *
 * Answers 201 with the new report. It is NOT sent by this call and it does NOT supersede the original yet
 * — a correction the PM abandons half-written must not put "a newer version was issued" in front of a
 * client with nothing behind it.
 *
 * This is what makes `sent` survivable from the app — a sent report is immutable for everyone, leadership
 * included, so a correction is the only move after a wrong figure goes out.
 *
 * REACHED FROM THE APP, same screen as the retry above, and deliberately as the SECOND control rather than
 * the first. A PM staring at a failed send reaches for the most prominent button on the row, and a
 * correction is not how a failed delivery is fixed: it makes a v2, takes the failure off the board, and
 * leaves the client with nothing at all if the PM is pulled away before finishing it. The refusal when a
 * newer version already exists is the server's (`Version N … already exists`) and the app shows that
 * sentence verbatim rather than pre-empting it — it names the version to work on, which is what the PM
 * actually wants, and the app has no honest way to know about a v2 it was never told about.
 */
router.post("/reports/:id/correction", async (req, res, next) => {
  try {
    const correction = await createWeeklyReportCorrection(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      actorFrom(req),
    );
    const photos = await withPhotoUrls(req.tenantClient!, correction.photos);
    await req.commitTransaction!();
    res.status(201).json({ report: { ...correction, photos } });
  } catch (error) {
    next(error);
  }
});

export const weeklyReportFieldRoutes = router;
