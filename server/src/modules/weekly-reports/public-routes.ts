import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pool } from "../../db.js";
import { weeklyReportPublicLimiter } from "../../middleware/rate-limit.js";
import { generateEvidenceJpeg, isHeicOrHeif, withHeicDecodePermit } from "../../lib/image-thumbnail.js";
import {
  buildContentDisposition,
  getObjectBuffer,
  getObjectStream,
  putObject,
  isR2Configured,
  ObjectTooLargeError,
} from "../../lib/r2-client.js";
import { WEEKLY_REPORT_SUPERSEDED_NOTICE } from "./pdf.js";
import { withWeeklyReportOfficeClient } from "./office-connection.js";
import {
  loadWeeklyReportPdfSource,
  resolveArtifactKey,
  weeklyReportPdfFilename,
  type WeeklyReportPdfSource,
} from "./pdf-service.js";
import {
  renderWeeklyReportUnavailableHtml,
  renderWeeklyReportViewerHtml,
  type WeeklyReportUnavailableReason,
} from "./public-viewer.js";
import {
  isWeeklyReportShareableStatus,
  resolveWeeklyReportToken,
  type WeeklyReportTokenRow,
} from "./tokens-service.js";
import type { QueryExecutor } from "./projects-service.js";

// `/wr/:token` — the client's link. Served by the API service, NOT the SPA, because the constraint
// documented in public-share-url.ts applies here too: the page must be same-origin with /api so the photo
// bytes it loads need no CORS entry and no client host-mapping. The field host serves the field app and has
// no such route; overloading FRONTEND_URL drags CORS in.
//
// Everything here is unauthenticated and reachable by anyone holding the URL, so:
//   • the token SHAPE is checked before any query runs (tokens-service),
//   • the report's STATUS is re-checked on every request, not merely when the link was minted,
//   • the router is IP rate-limited before it can reach the database or R2,
//   • X-Robots-Tag: noindex is set on EVERY response, HTML and bytes alike,
//   • nothing reaches the shared JSON error handler — the reader is a client, and a client gets a page.

export const weeklyReportPublicRoutes = Router();

/**
 * Ceiling on a single photo read + re-encoded for the viewer.
 *
 * Matches the public photo proxy's cap and exists for the same reason: uploads have no size limit, so
 * without it an unauthenticated GET can make the API buffer and decode an arbitrarily large original.
 * getObjectBuffer enforces it against the GET's Content-Length and aborts the stream, so an oversized
 * object is never fully read.
 */
const MAX_PHOTO_SOURCE_BYTES = 40 * 1024 * 1024;
/** Sharp on a retina phone at full container width, without shipping a 12-megapixel original. */
const VIEWER_PHOTO_MAX_EDGE = 1400;

/**
 * How long the derived-photo cache lookup may take before the request gives up on it and generates live.
 *
 * Deliberately a small fraction of VIEWER_PHOTO_TIMEOUT_MS: the lookup is an optimisation, and the budget
 * it is allowed to spend has to be small enough that losing all of it still leaves time to do the real
 * work. Sharing the request's whole deadline let a stalled lookup turn an available photo into a 504.
 */
const VIEWER_DERIVED_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * How long the detached cache WRITE may run before it is abandoned.
 *
 * Longer than the lookup, because a write moves bytes and nobody is waiting on it; bounded all the same,
 * because an unbounded detached promise is a pending socket the process never reclaims.
 */
const VIEWER_DERIVED_WRITE_TIMEOUT_MS = 30_000;

/**
 * Ceiling on ONE photo request, covering the HEIC permit wait, the R2 read and the re-encode together.
 *
 * A page of twenty HEIC photos fires twenty parallel requests at this route, and every HEIC decode in the
 * process queues on ONE permit (image-thumbnail.ts). Without a deadline the twentieth waits for the other
 * nineteen decodes however long they take, holding a socket the whole time — and the queue it is sitting in
 * is shared with the field scorecard and AI-report renders, so an unauthenticated page can hold those up
 * too. Generous enough that a legitimately slow decode still succeeds; finite so the queue always drains.
 */
const VIEWER_PHOTO_TIMEOUT_MS = 20_000;
/**
 * Ceiling on streaming one stored PDF out of R2.
 *
 * Same reasoning one layer up: this route is unauthenticated, the S3 client carries no request timeout, and
 * a GET that R2 accepts and then stalls mid-body holds the request and its socket with nothing able to
 * abort it. Wider than the photo budget because a photo sheet report is several megabytes.
 */
const PDF_STREAM_TIMEOUT_MS = 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** public.weekly_report_tokens is schema-qualified and needs no tenant search_path, so it reads off the pool. */
const publicDb = pool as unknown as QueryExecutor;

// BEFORE the rate limiter, so a 429 carries the same headers every other response on this mount does. A
// limiter registered first answers without ever reaching the middleware below it.
weeklyReportPublicRoutes.use((_req, res, next) => {
  // On the bytes as well as the HTML: a PDF and a JPEG carry no meta tag to hold this, and a crawler that
  // reaches a forwarded link must not put a client's construction schedule into a search index.
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
weeklyReportPublicRoutes.use(weeklyReportPublicLimiter);

/**
 * Reject as soon as `signal` fires, whatever `work` is still waiting on.
 *
 * Needed because the HEIC permit queue is not cancellable and must not be made so — the field scorecard and
 * AI-report renders depend on its current behaviour. This does not shorten the queue; it releases the
 * REQUEST from it. The abandoned work stays attached (so a later rejection is never unhandled) and, because
 * the deadline is re-checked the moment the permit is granted, an abandoned waiter gives it back rather
 * than fetching and decoding for a reader who has gone.
 *
 * Exported for test: its failure mode — an abandoned promise whose later rejection nothing is listening for
 * — takes the process down, and it does so long after the request that started it was answered.
 */
export function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    // ATTACHED FIRST, before the aborted check, and that order is the whole point. The early-return branch
    // below used to come first, so a signal already aborted on entry rejected and left `work` with no
    // handler at all — the unhandled rejection this function exists to prevent, produced by the function
    // itself. Settling twice is a no-op on a promise, so nothing else has to change: whichever of the two
    // gets there first wins and the other is ignored.
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function sendHtml(res: Response, status: number, html: string) {
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // No caching at all: a revoked link must stop working immediately, and a shared proxy holding a client's
  // report is exactly the exposure the expiry/revocation model exists to bound.
  res.setHeader("Cache-Control", "no-store, private");
  res.end(html);
}

/** HTTP status per reason. 410 for a link that WAS valid, 404 for one that never was, 503 for our fault. */
const UNAVAILABLE_STATUS: Record<WeeklyReportUnavailableReason, number> = {
  expired: 410,
  revoked: 410,
  withdrawn: 409,
  unavailable: 503,
  unknown: 404,
};

async function lookupUserEmail(userId: string): Promise<string | null> {
  const result = await pool.query("SELECT email FROM public.users WHERE id = $1::uuid AND is_active = true LIMIT 1", [
    userId,
  ]);
  return result.rows[0]?.email ?? null;
}

/**
 * The dead-link page, resolved as far as the token allows.
 *
 * A token that still names a report gets the T-Rock PM looked up and printed — which is the entire point of
 * the page. An unknown token names nothing, and inventing a support address would be worse than admitting
 * we cannot say who to ask.
 *
 * The property name is printed for `expired` and `withdrawn` but NOT for `revoked`. Revocation is the
 * remedy for a link that reached the wrong person; continuing to tell that person which property the report
 * covered would undo half of what revoking it was for.
 */
async function sendUnavailable(
  res: Response,
  reason: WeeklyReportUnavailableReason,
  token: WeeklyReportTokenRow | null,
) {
  let contact: { name: string | null; email: string | null } | null = null;
  let propertyName: string | null = null;
  if (token) {
    try {
      const resolved = await withWeeklyReportOfficeClient(token.officeSlug, {}, (client) =>
        loadWeeklyReportPdfSource(client, token.weeklyReportId),
      );
      if (resolved) {
        if (reason !== "revoked") propertyName = resolved.view.pdf.propertyName;
        // The PM's CURRENT email, looked up by the snapshotted user id rather than snapshotted itself. The
        // snapshot preserves what the client was TOLD; this line exists so they can reach somebody, and an
        // address that stopped working helps nobody.
        const email = resolved.view.trockPm.userId ? await lookupUserEmail(resolved.view.trockPm.userId) : null;
        contact = { name: resolved.view.trockPm.name, email };
      }
    } catch (error) {
      // Best effort by design: this page's job is to be friendly, and a database hiccup must not turn it
      // back into the failure it exists to replace.
      console.warn("[weekly-report-viewer] could not resolve the contact for a dead link", {
        tokenId: token.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  sendHtml(res, UNAVAILABLE_STATUS[reason], renderWeeklyReportUnavailableHtml({ reason, contact, propertyName }));
}

/**
 * Resolve the path token, answering the dead-link page for anything that is not live.
 *
 * A THROW is reported as `unavailable` (503), not as "not found". Telling somebody holding a perfectly good
 * link that it does not exist, because our database was briefly unreachable, sends them chasing the PM for
 * a replacement that will behave exactly the same way.
 */
async function requireLiveToken(req: Request, res: Response): Promise<WeeklyReportTokenRow | null> {
  try {
    const resolution = await resolveWeeklyReportToken(publicDb, String(req.params.token ?? ""));
    if (resolution.status === "active") return resolution.token;
    await sendUnavailable(res, resolution.status, resolution.token);
    return null;
  } catch (error) {
    console.error("[weekly-report-viewer] token lookup failed", error);
    await sendUnavailable(res, "unavailable", null);
    return null;
  }
}

/**
 * Load the report behind a live token, refusing anything a client must not see.
 *
 * THE STATUS RE-CHECK IS THE POINT. A link is minted for an approved report, but `approved` is not
 * terminal: the assigned superintendent may move it back to `pending_review` on their own and then rewrite
 * the narrative and swap the photos. A report in that state also has no snapshot, so this page renders it
 * LIVE — meaning a check performed only at mint time leaves the client's link streaming unreviewed edits as
 * they are typed. Re-checking here is what keeps the PM gate a gate.
 */
async function loadShareableReport(
  res: Response,
  token: WeeklyReportTokenRow,
): Promise<WeeklyReportPdfSource | null> {
  const source = await withWeeklyReportOfficeClient(token.officeSlug, {}, (client) =>
    loadWeeklyReportPdfSource(client, token.weeklyReportId),
  );
  // A live token whose report is gone — the deal was permanently deleted and cascaded it away. There is no
  // PM left to name, so this is the generic page rather than the "ask your PM" one.
  if (!source) {
    await sendUnavailable(res, "unknown", null);
    return null;
  }
  if (!isWeeklyReportShareableStatus(source.view.status)) {
    await sendUnavailable(res, "withdrawn", token);
    return null;
  }
  return source;
}

weeklyReportPublicRoutes.get("/:token", async (req, res) => {
  try {
    const token = await requireLiveToken(req, res);
    if (!token) return;
    const source = await loadShareableReport(res, token);
    if (!source) return;
    const rawToken = String(req.params.token);

    sendHtml(
      res,
      200,
      renderWeeklyReportViewerHtml({
        view: source.view,
        photoUrl: (fileId) => `/wr/${encodeURIComponent(rawToken)}/photos/${encodeURIComponent(fileId)}`,
        pdfUrl: `/wr/${encodeURIComponent(rawToken)}/pdf`,
        // The same sentence the PDF prints, from the same constant — see WEEKLY_REPORT_SUPERSEDED_NOTICE.
        supersededNotice: source.view.pdf.superseded ? WEEKLY_REPORT_SUPERSEDED_NOTICE : null,
      }),
    );
  } catch (error) {
    console.error("[weekly-report-viewer] failed to render the report page", error);
    // The friendly page, not a 500 body. Whatever broke on our side, the reader is a client holding a link.
    await sendUnavailable(res, "unavailable", null);
  }
});

weeklyReportPublicRoutes.get("/:token/pdf", async (req, res) => {
  try {
    const token = await requireLiveToken(req, res);
    if (!token) return;
    if (!isR2Configured()) {
      await sendUnavailable(res, "unavailable", token);
      return;
    }
    const source = await loadShareableReport(res, token);
    if (!source) return;

    // This CAN render on an anonymous request, which is a deliberate trade rather than an oversight. A
    // client whose PDF is missing (the send job failed, or the renderer was upgraded) must still be able to
    // download their report. The exposure is bounded on three sides: the artifact is CACHED for every
    // shareable status, approved as well as sent, so a link holder can only cause a render when the report
    // has actually changed since the last one; the single-flight coalescer collapses concurrent requests
    // for the same generation into one render; and the router's IP rate limit caps how often a link holder
    // can ask at all. Caching approved reports is not an optimisation — without it every request on this
    // route rendered again and uploaded another content-addressed object that nothing ever deletes.
    const r2Key = await resolveArtifactKey(token.officeSlug, source);

    // STREAMED, never presigned. A presigned R2 URL embeds the object key, which carries the deal number —
    // an internal identifier this surface has no reason to hand a client. Same reasoning as the public
    // photo proxy.
    //
    // On a deadline covering BOTH halves. R2 can answer the GET promptly and then stall mid-body, which is
    // the shape that pins a request and its socket open indefinitely, so the signal goes to the request and
    // to the pipe that drains it.
    const deadline = AbortSignal.timeout(PDF_STREAM_TIMEOUT_MS);
    const object = await getObjectStream(r2Key, { signal: deadline });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", buildContentDisposition("attachment", weeklyReportPdfFilename(source.view)));
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // pipeline rather than a hand-rolled write/drain loop: it propagates a source error and destroys both
    // ends, where an awaited "drain" that never arrives would hang the request until the socket timed out.
    await pipeline(Readable.from(object.stream), res, { signal: deadline });
  } catch (error) {
    if (res.headersSent) {
      // Bytes are already on the wire, so the status cannot change — abort rather than append an HTML page
      // to a half-written PDF.
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    console.error("[weekly-report-viewer] failed to serve the report PDF", error);
    await sendUnavailable(res, "unavailable", null);
  }
});

/**
 * One photo's bytes.
 *
 * Answers a bare status rather than the dead-link HTML on every failure: this URL only ever appears in an
 * `<img>`, and a styled 410 page delivered into an image tag is just a broken image with a page's worth of
 * bytes attached.
 */
weeklyReportPublicRoutes.get("/:token/photos/:fileId", async (req, res) => {
  try {
    const resolution = await resolveWeeklyReportToken(publicDb, String(req.params.token ?? ""));
    if (resolution.status !== "active") {
      res.status(resolution.status === "unknown" ? 404 : 410).end();
      return;
    }
    const token = resolution.token;
    const fileId = String(req.params.fileId ?? "");
    // Shape-gated before the query, exactly as the token is. Binding a non-UUID to `$2::uuid` raises 22P02,
    // which costs a pooled connection and a BEGIN/ROLLBACK per request and surfaces as a 500 — on a route
    // anyone can call up to the rate limit.
    //
    // PERMANENT, so it is the one failure on this route that may be cached: no id of this shape will ever
    // name a photo.
    if (!UUID_PATTERN.test(fileId)) {
      res.status(404).end();
      return;
    }
    // Storage being unconfigured is OUR outage, not a missing photo — 503 and no-store, so a reader whose
    // page loaded during a bad deploy is not left with the broken image frozen in their browser.
    if (!isR2Configured()) {
      res.setHeader("Cache-Control", "no-store, private");
      res.status(503).end();
      return;
    }

    // Scoped to THIS report's selection, so a file id guessed from anywhere else in the office 404s.
    const photo = await withWeeklyReportOfficeClient(token.officeSlug, {}, async (client) => {
      const result = await client.query(
        `SELECT f.r2_key, f.mime_type, wr.status
           FROM weekly_report_photos wrp
           JOIN weekly_reports wr ON wr.id = wrp.weekly_report_id
           JOIN files f ON f.id = wrp.file_id
          WHERE wrp.weekly_report_id = $1::uuid
            AND wrp.file_id = $2::uuid
            AND wr.is_active
            AND f.is_active = true
            AND f.deleted_at IS NULL
          LIMIT 1`,
        [token.weeklyReportId, fileId],
      );
      return result.rows[0] ?? null;
    });
    // Same status gate as the page: a report pulled back for rework must not keep serving its photos either.
    //
    // no-store on the FAILURE, because this 404 is TRANSIENT. An already-open page lazy-loading a photo
    // during a rework window gets it, and a bare 404 with no cache directive is heuristically cacheable
    // — so the image would stay broken for that reader even after the PM re-approves and the page
    // itself started working again.
    if (!photo?.r2_key || !isWeeklyReportShareableStatus(photo.status)) {
      res.setHeader("Cache-Control", "no-store, private");
      res.status(404).end();
      return;
    }

    // ONE deadline over everything that follows — the permit wait, the R2 read and the decode.
    const deadline = AbortSignal.timeout(VIEWER_PHOTO_TIMEOUT_MS);

    /**
     * THE DERIVED JPEG, CACHED IN R2.
     *
     * Measured before this existed: the bytes leaving the server were fine — a 4032x3024 camera original
     * comes out of the resize at roughly 180 kB. What was slow was that EVERY REQUEST redid the work to
     * produce them: a 3.5 MB GET from R2, a full sharp decode of a 12-megapixel image, a resize and a
     * re-encode. With `max-age=300` on the response, a client scrolling a report re-triggered the whole
     * pipeline every five minutes, per photo. A three-photo report is ~10 MB of R2 reads and three
     * twelve-megapixel decodes to put 540 kB on the page.
     *
     * The derived key is content-addressed on the SOURCE KEY and the render settings, so a caption edit
     * does not invalidate it and a change to `VIEWER_PHOTO_MAX_EDGE` or the quality does — the same
     * property the PDF artifact's generation gives it, reached more cheaply because a photo has no
     * database row of its own to version.
     *
     * The cache is a pure accelerator: a miss, a read failure or an unconfigured bucket all fall through
     * to generating it live. Nothing here may turn a slow photo into a broken one.
     */
    const derivedKey = `derived/weekly-report-viewer/${createHash("sha256")
      .update(`${photo.r2_key}|${VIEWER_PHOTO_MAX_EDGE}|78|v1`)
      .digest("hex")}.jpg`;

    // ITS OWN SHORT BUDGET, not the request's whole deadline.
    //
    // Sharing `deadline` made the accelerator able to cause the failure it exists to prevent: a derived
    // read that stalls consumes all twenty seconds, and the live path then hits an already-aborted signal
    // and answers 504 — turning a photo that was perfectly available into an error, and only for readers
    // unlucky enough to hit a slow lookup. A cache miss must cost a lookup, never the request.
    //
    // Generous enough that an ordinary hit on a ~180 kB object always lands, short enough that a stall
    // leaves nearly the whole deadline for generating live.
    const cached = await getObjectBuffer(derivedKey, {
      maxBytes: MAX_PHOTO_SOURCE_BYTES,
      signal: AbortSignal.timeout(VIEWER_DERIVED_LOOKUP_TIMEOUT_MS),
    }).catch(() => null);

    if (cached?.buffer) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // The SAME short private TTL as the live path. The cache changes what the server does, never how
      // long a revoked link keeps working — that bound belongs to the token, not to the bytes.
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(cached.buffer);
      return;
    }

    /** null means "this object cannot be turned into a picture", which is a 404. Anything else throws. */
    const transcode = async (heicDecodePermit?: symbol): Promise<Buffer | null> => {
      // Queued behind the permit past the deadline: hand it straight back rather than starting a fetch
      // nobody is waiting on any more.
      deadline.throwIfAborted();
      let buffer: Buffer;
      try {
        ({ buffer } = await getObjectBuffer(photo.r2_key, {
          maxBytes: MAX_PHOTO_SOURCE_BYTES,
          signal: deadline,
        }));
      } catch (error) {
        if (error instanceof ObjectTooLargeError) return null;
        throw error;
      }
      // ALWAYS re-encoded, never proxied raw. The re-encode is what strips EXIF — including the GPS
      // coordinates a phone writes into every jobsite photo — and it is also what makes a HEIC or WebP
      // original viewable in a client's browser at all. A decode failure 404s rather than falling back to
      // the original bytes, which would defeat the stripping it is the fallback for.
      try {
        return await generateEvidenceJpeg(buffer, photo.mime_type, {
          maxEdge: VIEWER_PHOTO_MAX_EDGE,
          quality: 78,
          heicDecodePermit,
        });
      } catch {
        return null;
      }
    };

    // THE PERMIT IS TAKEN BEFORE THE R2 GET, not around the decode — the rule image-thumbnail.ts states
    // and the scorecard resolver follows. generateEvidenceJpeg would otherwise acquire it for us, but only
    // AFTER this request had already pulled up to 40 MB of original into memory: twenty HEIC photos on one
    // client page would then hold twenty source buffers while queuing on a semaphore that admits one.
    let jpeg: Buffer | null;
    try {
      jpeg = await withDeadline(
        isHeicOrHeif(photo.mime_type) ? withHeicDecodePermit(transcode) : transcode(),
        deadline,
      );
    } catch (error) {
      if (!deadline.aborted) throw error;
      // Gave up rather than queued forever. no-store for the same reason as every other transient failure
      // here, and 504 rather than 404 because the photo is fine and the next request will very likely get it.
      res.setHeader("Cache-Control", "no-store, private");
      res.status(504).end();
      return;
    }
    if (!jpeg) {
      // Oversized original or bytes sharp cannot decode. no-store because a decode failure is not reliably
      // permanent — sharp fails transiently under memory pressure, and a cached 404 would freeze the broken
      // image in this reader's browser long after the process recovered.
      res.setHeader("Cache-Control", "no-store, private");
      res.status(404).end();
      return;
    }

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Short PRIVATE cache: a page of photos is re-requested on every scroll and refresh, but a revoked link
    // must stop serving within minutes rather than days.
    res.setHeader("Cache-Control", "private, max-age=300");
    res.end(jpeg);

    // Stored AFTER `res.end`, which is what actually keeps the reader out of it: the response has already
    // gone, so this PUT cannot delay them however slow the bucket is. `void` and `.catch` are belt to that
    // braces — they stop an unhandled rejection, and they stop a storage failure turning a photo the
    // reader can already see into an error. The next request simply regenerates, as it did before this
    // cache existed.
    //
    // (Written as `void` rather than `await` for readability only. Both behave identically here BECAUSE
    // of the ordering above — worth saying, because the difference looks load-bearing and is not.)
    // BOUNDED. A detached promise with no deadline is one R2 can leave pending forever if it accepts the
    // request and then stalls — and every cache miss adds another, so a bad afternoon accumulates pending
    // uploads and their sockets long after the responses that spawned them completed. Its OWN signal, not
    // the request's: the response has already gone, so the request deadline may well be spent.
    void putObject(derivedKey, jpeg, "image/jpeg", {
      signal: AbortSignal.timeout(VIEWER_DERIVED_WRITE_TIMEOUT_MS),
    }).catch((error) => {
      console.warn("[weekly-report-viewer] could not cache a derived photo", { derivedKey, error });
    });
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    console.error("[weekly-report-viewer] failed to serve a report photo", error);
    res.status(500).end();
  }
});

// Anything else under /wr is a mistyped link, and it must NOT fall through to the SPA — which would answer
// index.html for a URL the CRM has no route for, leaving the client staring at a login screen.
weeklyReportPublicRoutes.use(async (_req, res) => {
  await sendUnavailable(res, "unknown", null);
});
