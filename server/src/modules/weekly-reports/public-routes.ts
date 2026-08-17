import { Router, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pool } from "../../db.js";
import { weeklyReportPublicLimiter } from "../../middleware/rate-limit.js";
import { generateEvidenceJpeg } from "../../lib/image-thumbnail.js";
import {
  buildContentDisposition,
  getObjectBuffer,
  getObjectStream,
  isR2Configured,
  ObjectTooLargeError,
} from "../../lib/r2-client.js";
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
        // A correction clones the report to a new version and stamps superseded_by_id on the original. The
        // original link keeps resolving — a client who bookmarked it must never hit a 404 — but it says so
        // rather than presenting superseded content as current.
        supersededNotice: source.supersededById
          ? "A newer version of this report has since been issued. Please refer to the most recent email."
          : null,
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
    // download their report. The exposure is bounded on three sides: a SENT report is immutable, so its
    // artifact stays current after the first render; the single-flight coalescer collapses concurrent
    // requests for the same generation into one render; and the router's IP rate limit caps how often a
    // link holder can ask at all.
    const r2Key = await resolveArtifactKey(token.officeSlug, source);

    // STREAMED, never presigned. A presigned R2 URL embeds the object key, which carries the deal number —
    // an internal identifier this surface has no reason to hand a client. Same reasoning as the public
    // photo proxy.
    const object = await getObjectStream(r2Key);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", buildContentDisposition("attachment", weeklyReportPdfFilename(source.view)));
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // pipeline rather than a hand-rolled write/drain loop: it propagates a source error and destroys both
    // ends, where an awaited "drain" that never arrives would hang the request until the socket timed out.
    await pipeline(Readable.from(object.stream), res);
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
    if (!UUID_PATTERN.test(fileId) || !isR2Configured()) {
      res.status(404).end();
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
    if (!photo?.r2_key || !isWeeklyReportShareableStatus(photo.status)) {
      res.status(404).end();
      return;
    }

    let buffer: Buffer;
    try {
      ({ buffer } = await getObjectBuffer(photo.r2_key, { maxBytes: MAX_PHOTO_SOURCE_BYTES }));
    } catch (error) {
      if (error instanceof ObjectTooLargeError) {
        res.status(404).end();
        return;
      }
      throw error;
    }

    // ALWAYS re-encoded, never proxied raw. The re-encode is what strips EXIF — including the GPS
    // coordinates a phone writes into every jobsite photo — and it is also what makes a HEIC or WebP
    // original viewable in a client's browser at all. A decode failure 404s rather than falling back to the
    // original bytes, which would defeat the stripping it is the fallback for.
    let jpeg: Buffer;
    try {
      jpeg = await generateEvidenceJpeg(buffer, photo.mime_type, { maxEdge: VIEWER_PHOTO_MAX_EDGE, quality: 78 });
    } catch {
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
