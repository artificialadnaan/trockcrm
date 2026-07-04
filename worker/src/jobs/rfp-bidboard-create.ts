import crypto from "node:crypto";
import { pool } from "../db.js";
import type { RfpRequestDeliveryPayload } from "@trock-crm/shared/types";

export const RFP_BIDBOARD_CREATE_JOB = "rfp_bidboard_create";

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

type PoolLike = Queryable & {
  connect?: () => Promise<Queryable & { release: () => void }>;
};

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function resolveOfficeSchema(db: Queryable, officeId: string | null): Promise<string> {
  if (!officeId) {
    throw new Error("rfp_bidboard_create dead-letter sweep is missing officeId");
  }
  // requireActive:false — a dead job for a since-deactivated office still needs its deal marked.
  const result = await db.query(`SELECT slug FROM public.offices WHERE id = $1`, [officeId]);
  const slug = result.rows[0]?.slug;
  if (typeof slug !== "string" || !/^[a-z][a-z0-9_]*$/.test(slug)) {
    throw new Error(`Unable to resolve office schema for officeId=${officeId}`);
  }
  return `office_${slug}`;
}

function signBody(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function assertPayload(payload: any): asserts payload is RfpRequestDeliveryPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid rfp_bidboard_create payload");
  }
  if (typeof payload.dealId !== "string" || typeof payload.syncHubUrl !== "string") {
    throw new Error("rfp_bidboard_create payload is missing dealId or syncHubUrl");
  }
  if (!payload.body || typeof payload.body !== "object") {
    throw new Error("rfp_bidboard_create payload is missing body");
  }
}

/**
 * GO delivery: HMAC-POST the normalized deal body (+ decision:'approved') to SyncHub's create-from-rfp
 * endpoint. Mirrors rfp-request-delivery.ts's signing (SYNCHUB_SHARED_SECRET == SyncHub's
 * RFP_REQUEST_SYNC_SECRET). Writes no deal state — SyncHub returns 202 and the deal advances later via the
 * bid-board-created callback. A non-2xx throws so the generic queue runner retries (maxAttempts=8).
 */
export async function handleRfpBidBoardCreate(
  payload: unknown,
  officeId: string | null,
  deps: { fetchImpl?: typeof fetch; secret?: string; db?: PoolLike } = {},
): Promise<void> {
  assertPayload(payload);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const secret = deps.secret ?? process.env.SYNCHUB_SHARED_SECRET;
  if (!secret) {
    throw new Error("SYNCHUB_SHARED_SECRET is not configured for rfp_bidboard_create delivery");
  }

  // finding: re-read the CURRENT deal before POSTing. The command's payload was built at approve time; if the deal
  // was soft-deleted or Returned to Opportunity since (cleared/re-triggered), posting would create an external Bid
  // Board project the bid-board-created callback (findDeal filters is_active=true) can never link/advance —
  // orphaning it. Skip the POST unless the deal is still ACTIVE and in a matching request-less create-in-flight
  // state: a 2/3-yes 'pending', or an override-approve 'declined'+'approving', with NO SyncHub request id. FAIL-OPEN
  // on a recheck error (DB blip / schema resolve) — better to attempt a legit GO; the callback's own status/round
  // guards still reject a stale/cancelled link.
  const db = deps.db ?? (pool as PoolLike);
  if (officeId && db) {
    try {
      const schemaName = await resolveOfficeSchema(db, officeId);
      const res = await db.query(
        `SELECT is_active, rfp_approval_status, rfp_approval_request_id, rfp_override_state, rfp_approval_request_event_id
           FROM ${quoteIdent(schemaName)}.deals WHERE id = $1`,
        [payload.dealId],
      );
      const deal = res.rows[0];
      // finding: bind the recheck to the CURRENT round. The payload's sourceEventId is crm:rfp-vote:approved:<round
      // event id>; if the deal was Returned to Opportunity and a FRESH round opened since this job was enqueued,
      // its rfp_approval_request_event_id differs — posting the OLD payload would create a project for the new
      // round's deal that the later callback reconciles against the fresh round. Require the event ids to match.
      const sourceEventId = String((payload.body as any)?.sourceEventId ?? "");
      const payloadRoundEventId = /^crm:rfp-vote:approved:(.+)$/.exec(sourceEventId)?.[1] ?? null;
      const stillCreatable =
        !!deal &&
        deal.is_active === true &&
        deal.rfp_approval_request_id == null &&
        payloadRoundEventId != null &&
        deal.rfp_approval_request_event_id === payloadRoundEventId &&
        (deal.rfp_approval_status === "pending" ||
          (deal.rfp_approval_status === "declined" && deal.rfp_override_state === "approving"));
      if (!stillCreatable) {
        console.warn(
          `[Worker:rfp_bidboard_create] Skipping create POST for deal ${payload.dealId}: no longer active / in a matching request-less create round (active=${deal?.is_active ?? "missing"}, status=${deal?.rfp_approval_status ?? "null"}, requestId=${deal?.rfp_approval_request_id ?? "null"}, round=${deal?.rfp_approval_request_event_id ?? "null"} vs payload=${payloadRoundEventId ?? "null"})`,
        );
        return;
      }
    } catch (err) {
      console.warn(
        `[Worker:rfp_bidboard_create] deal recheck failed for ${payload.dealId} (posting anyway): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const rawBody = JSON.stringify(payload.body);
  let response: Response;
  try {
    response = await fetchImpl(payload.syncHubUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rfp-request-signature": signBody(rawBody, secret),
      },
      body: rawBody,
    });
  } catch (err) {
    throw new Error(`rfp_bidboard_create network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (response.status === 200 || response.status === 201 || response.status === 202) {
    return;
  }
  const text = await response.text().catch(() => "");
  throw new Error(`rfp_bidboard_create failed with ${response.status}: ${text || response.statusText}`);
}

/**
 * Dead-letter backstop for rfp_bidboard_create. handleRfpBidBoardCreate writes NO deal state — on a 2xx the deal
 * advances later via the bid-board-created callback, and on a non-2xx it throws so the queue retries. But if
 * SyncHub keeps 500ing (or the secret/URL is misconfigured) the job eventually exhausts maxAttempts and the queue
 * marks it 'dead' — with nothing surfaced on the deal, a 2/3-approved voting deal (or an override-approve) would
 * sit forever with no failure the rep/reviewer can see. This sweep mirrors runRfpRequestDeadLetterSweep AND the
 * internal-rfp failed callback: it claims dead rows and stamps the SAME visible, recoverable failed marker the
 * failure callback sets — rfp_approval_status='send_failed' (the Pending-RFP attention status that
 * pendingRfpSubStateForStatus surfaces + offers Retry for) PLUS rfp_override_state='failed' + rfp_override_error
 * for the audit — scoped to a create-in-flight, request-less (voting-path) deal so it never clobbers an
 * already-approved deal or a re-confirmed denial. Because the marker is per-deal (no request id), it covers both
 * the request-less voting create and the override-approve.
 *
 * CLAIM IS SINGLE-TRANSACTION (finding #4): the batch SELECT below only reads + briefly locks; the 'claimed'
 * marker is written per-row INSIDE the same per-job transaction as the deal update, after re-locking the row with
 * FOR UPDATE SKIP LOCKED. So a throw anywhere in the per-job work (office-schema resolve, deal update) rolls the
 * 'claimed' write back too, leaving the row unclaimed (dealHandled null/false) and RETRYABLE for the next sweep —
 * never stranded permanently 'claimed'. The claim filter also treats a stray committed 'claimed' as retryable, so
 * any row left 'claimed' by an older build is recovered rather than filtered out forever.
 */
export async function runRfpBidBoardCreateDeadLetterSweep(
  deps: {
    db?: PoolLike;
    limit?: number;
  } = {}
): Promise<number> {
  const db = deps.db ?? pool;
  const limit = deps.limit ?? 25;
  const client: Queryable & { release?: () => void } = db.connect ? await db.connect() : db;
  let handled = 0;

  try {
    // Candidate dead rows. This SELECT only READS + briefly locks (FOR UPDATE SKIP LOCKED); it does NOT write the
    // 'claimed' marker. The claim is written per-row inside the transaction below so a later throw rolls it back.
    const result = await client.query(
      `SELECT id, payload, office_id, last_error, created_at
         FROM public.job_queue
        WHERE status = 'dead'
          AND job_type = 'rfp_bidboard_create'
          AND (payload->>'dealHandled' IS NULL
               OR payload->>'dealHandled' IN ('false', 'claimed'))
        ORDER BY id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit]
    );

    for (const job of result.rows) {
      try {
        await client.query("BEGIN");
        // Re-lock the row inside the txn and re-check it's still unclaimed, so a concurrent sweep tick can't
        // double-process it: FOR UPDATE SKIP LOCKED returns 0 rows if another tick holds the row, and the WHERE
        // excludes it once that tick has committed dealHandled='true'. Everything below shares THIS transaction.
        const locked = await client.query(
          `SELECT id
             FROM public.job_queue
            WHERE id = $1
              AND status = 'dead'
              AND (payload->>'dealHandled' IS NULL
                   OR payload->>'dealHandled' IN ('false', 'claimed'))
            FOR UPDATE SKIP LOCKED`,
          [job.id]
        );
        if (locked.rows.length === 0) {
          await client.query("ROLLBACK");
          continue;
        }
        // Claim marker — written in the SAME transaction as the deal update (finding #4). A throw before COMMIT
        // rolls this back too, leaving the row unclaimed + retryable for the next sweep instead of stuck 'claimed'.
        await client.query(
          "UPDATE public.job_queue SET payload = jsonb_set(payload, '{dealHandled}', '\"claimed\"'::jsonb, true) WHERE id = $1",
          [job.id]
        );

        const payload = job.payload as RfpRequestDeliveryPayload;
        if (!payload?.dealId) {
          await client.query(
            "UPDATE public.job_queue SET payload = jsonb_set(payload, '{dealHandled}', 'true'::jsonb, true) WHERE id = $1",
            [job.id]
          );
          await client.query("COMMIT");
          continue;
        }

        const schemaName = await resolveOfficeSchema(client, job.office_id);
        const overrideError = String(job.last_error ?? "Bid Board project creation exhausted retries").slice(0, 2000);
        await client.query(
          `UPDATE ${quoteIdent(schemaName)}.deals
              SET rfp_override_state = 'failed',
                  rfp_override_error = $1,
                  -- 2/3-YES sub-case (was 'pending') -> send_failed, the Pending-RFP attention status the surface
                  -- renders + offers Retry for (same as the internal-rfp failed callback). Override sub-case (was
                  -- 'declined' + 'approving') MUST STAY 'declined' (finding G4) so the /rfp-review buttons keep
                  -- working; /rfp-retry still recovers it via rfp_override_state='failed'. Both failure paths
                  -- (callback + this sweep) converge on the same per-sub-case status.
                  rfp_approval_status = CASE WHEN rfp_approval_status = 'pending' THEN 'send_failed' ELSE rfp_approval_status END,
                  -- finding W8: populate the visible send_failed reason (Pending-RFP + deal detail read
                  -- rfp_last_attempt_error) on the send_failed sub-case, mirroring the internal-rfp failed callback.
                  rfp_last_attempt_error = CASE WHEN rfp_approval_status = 'pending' THEN $1 ELSE rfp_last_attempt_error END,
                  updated_at = NOW()
            WHERE id = $2
              -- request-less (voting-path) only: every rfp_bidboard_create job is a voting 2/3-yes or a voting
              -- override-approve, both of which keep rfp_approval_request_id NULL (mirrors the failed callback).
              AND rfp_approval_request_id IS NULL
              -- never resurrect a failure onto a terminally re-confirmed denial
              AND rfp_override_decision IS DISTINCT FROM 'denial_reconfirmed'
              -- only a deal whose create was still in flight (mirrors the failure callback's guards): a 2/3-YES
              -- voting create (pending) or an override-approve (declined + 'approving'). Never overwrite a deal
              -- the callback already linked/approved.
              AND (
                rfp_approval_status = 'pending'
                OR (rfp_approval_status = 'declined' AND rfp_override_state = 'approving')
              )
              -- per-attempt freshness (finding F5): ignore a dead job from a PRIOR attempt. Each /rfp-retry
              -- stamps rfp_bidboard_attempt_at, so a dead job enqueued BEFORE the current attempt (its created_at
              -- < the stamp) is skipped and can't flip a fresh in-flight retry to send_failed. The first attempt
              -- has attempt_at NULL (exempt), so its own dead job still surfaces.
              AND (
                rfp_bidboard_attempt_at IS NULL
                OR $3::timestamptz >= rfp_bidboard_attempt_at
              )
              -- ...and the SAME freshness against rfp_override_reviewed_at (finding W3): the override-approve
              -- sub-case tracks its current attempt with reviewed_at (NOT the bidboard attempt column), so without
              -- this a dead job from a PRIOR override attempt (created_at < the bumped reviewed_at) — where
              -- attempt_at IS NULL and is exempt above — would still flip the fresh 'approving' retry to failed.
              AND (
                rfp_override_reviewed_at IS NULL
                OR $3::timestamptz >= rfp_override_reviewed_at
              )
              -- request-less CROSS-ROUND freshness (finding, mirror of the callback path's Y6/BC1): once a deal is
              -- Returned to Opportunity and a FRESH round opens, rfp_bidboard_attempt_at + rfp_override_reviewed_at
              -- are both NULL again, so an OLD round's dead job (enqueued BEFORE the new round opened) would slip
              -- past the per-attempt guards above and mark the fresh round send_failed. Require the dead job's
              -- created_at ($3) to be no older than the CURRENT round's open time. (request-less only — this branch
              -- already requires rfp_approval_request_id IS NULL, and a job always has a created_at.)
              AND (
                rfp_approval_requested_at IS NULL
                OR $3::timestamptz >= rfp_approval_requested_at
              )
              -- idempotency keyed on override_state/error only (NOT status), since the status transition now
              -- differs per sub-case (send_failed vs. kept 'declined') — override_state -> 'failed' already marks
              -- the first application. (finding G4)
              AND (
                rfp_override_state IS DISTINCT FROM 'failed'
                OR rfp_override_error IS DISTINCT FROM $1
              )`,
          [overrideError, payload.dealId, job.created_at]
        );
        await client.query(
          "UPDATE public.job_queue SET payload = jsonb_set(payload, '{dealHandled}', 'true'::jsonb, true) WHERE id = $1",
          [job.id]
        );
        await client.query("COMMIT");
        handled += 1;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[Worker:rfp_bidboard_create] Failed to handle dead Bid Board create job ${job.id}`, err);
      }
    }

    return handled;
  } finally {
    if ("release" in client && typeof client.release === "function") {
      client.release();
    }
  }
}
