import crypto from "crypto";
import express, { Router } from "express";
import { pool } from "../../db.js";
import {
  acceptBidBoardIngestion,
  readInboxStatusByKey,
  computeIdempotencyKey,
  resolveIngestOfficeSlug,
  countPayloadRows,
} from "./inbox.js";

export const bidBoardSyncRoutes = Router();

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = process.env.BID_BOARD_SYNC_SECRET;
  if (!secret || !signatureHeader) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signatureHeader.replace(/^sha256=/, "");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    return false;
  }
}

// Durably ACCEPT an ingestion request and return 202 immediately. The full import runs asynchronously in
// the worker (job_type 'bid_board_ingest'), so a slow import can no longer hold the HTTP request open long
// enough for Railway's edge to synthesize a 502. Idempotent: retries / concurrent duplicates of the same
// signed body collapse to one logical ingestion (keyed by office_slug + sha256(body)).
bidBoardSyncRoutes.post(
  "/ingest",
  express.raw({ type: "application/json", limit: "25mb" }),
  async (req, res, next) => {
    try {
      const rawBody = req.body as Buffer;
      const signature = req.headers["x-bid-board-sync-signature"] as string | undefined;

      if (!verifySignature(rawBody, signature)) {
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

      // Absent office → 'dallas' (matches the importer's legacy normalizeOfficeSlug default, so a signed
      // sender that omits the office keeps ingesting); a present-but-schema-unsafe slug is still rejected.
      const officeSlug = resolveIngestOfficeSlug(payload);
      if (!officeSlug) {
        res.status(400).json({ error: "Invalid office_slug" });
        return;
      }

      const idempotencyKey = computeIdempotencyKey(rawBody);
      const sourceFilename =
        (typeof payload?.provenance?.sourceFilename === "string" && payload.provenance.sourceFilename) ||
        (typeof payload?.provenance?.source_filename === "string" && payload.provenance.source_filename) ||
        null;

      const result = await acceptBidBoardIngestion(pool, {
        officeSlug,
        payload,
        payloadHash: idempotencyKey,
        // Sheets-aware count (mirrors the importer's extractRows) so row_count + logs reflect the real size.
        rowCount: countPayloadRows(payload),
        sourceFilename,
      });

      // 202 Accepted: durably queued (or already queued/processing/finished for this exact payload).
      res.status(202).json({
        accepted: true,
        jobId: result.inboxId,
        idempotencyKey: result.idempotencyKey,
        status: result.status,
        duplicate: result.duplicate,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Signed status probe. Lets SyncHub resolve an ambiguous gateway response (e.g. a 502) WITHOUT re-sending
// the full payload: given the office + idempotency key, it reports whether the ingestion is queued,
// processing, succeeded, failed, or unknown (never seen). Same HMAC scheme as /ingest.
bidBoardSyncRoutes.post(
  "/ingest/status",
  express.raw({ type: "application/json", limit: "64kb" }),
  async (req, res, next) => {
    try {
      const rawBody = req.body as Buffer;
      const signature = req.headers["x-bid-board-sync-signature"] as string | undefined;

      if (!verifySignature(rawBody, signature)) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      let body: any;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        res.status(400).json({ error: "Invalid JSON" });
        return;
      }

      // Resolve the office the SAME way /ingest did (absent → 'dallas'), so a probe for a legacy no-office
      // payload finds the row it was keyed under; a present-but-invalid slug still 400s.
      const officeSlug = resolveIngestOfficeSlug(body);
      const idempotencyKey =
        typeof body?.idempotency_key === "string"
          ? body.idempotency_key
          : typeof body?.idempotencyKey === "string"
          ? body.idempotencyKey
          : null;

      if (!officeSlug || !idempotencyKey) {
        res.status(400).json({ error: "Missing or invalid office_slug / idempotency_key" });
        return;
      }

      const row = await readInboxStatusByKey(pool, officeSlug, idempotencyKey);

      if (!row) {
        res.status(200).json({ status: "unknown", idempotencyKey });
        return;
      }

      res.status(200).json({
        status: row.status,
        jobId: row.id,
        idempotencyKey,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        runId: row.run_id ?? undefined,
        warningsCount: row.warnings_count ?? undefined,
        lastError: row.last_error ?? undefined,
        queuedAt: row.queued_at,
        startedAt: row.started_at ?? undefined,
        finishedAt: row.finished_at ?? undefined,
        updatedAt: row.updated_at,
      });
    } catch (err) {
      next(err);
    }
  }
);
