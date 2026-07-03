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
  _officeId: string | null,
  deps: { fetchImpl?: typeof fetch; secret?: string } = {},
): Promise<void> {
  assertPayload(payload);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const secret = deps.secret ?? process.env.SYNCHUB_SHARED_SECRET;
  if (!secret) {
    throw new Error("SYNCHUB_SHARED_SECRET is not configured for rfp_bidboard_create delivery");
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
      `SELECT id, payload, office_id, last_error
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
                  -- Visible, recoverable state (finding #2): send_failed is the Pending-RFP attention status the
                  -- surface renders + offers Retry for — the SAME state the internal-rfp failed callback sets, so
                  -- both failure paths (SyncHub callback + this dead-letter sweep) converge on one recoverable status.
                  rfp_approval_status = 'send_failed',
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
              AND (
                rfp_override_state IS DISTINCT FROM 'failed'
                OR rfp_override_error IS DISTINCT FROM $1
                OR rfp_approval_status IS DISTINCT FROM 'send_failed'
              )`,
          [overrideError, payload.dealId]
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
