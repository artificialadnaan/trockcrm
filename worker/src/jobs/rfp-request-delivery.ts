import crypto from "node:crypto";
import { pool } from "../db.js";
import type { RfpRequestDeliveryPayload } from "@trock-crm/shared/types";
export type { RfpRequestDeliveryPayload } from "@trock-crm/shared/types";

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

type PoolLike = Queryable & {
  connect?: () => Promise<Queryable & { release: () => void }>;
};

/**
 * Advisory-lock namespace shared with "Move back to Opportunity"'s job cancellation, so a cancellation
 * and a send-authorization for the same deal serialize instead of racing. Distinct from the commission
 * lock namespace: these are different invariants and must not block each other.
 */
export const DEAL_RFP_DELIVERY_LOCK_NAMESPACE = "deal_rfp_delivery:";

type OfficeSchemaOptions = {
  requireActive?: boolean;
};

function assertPayload(payload: any): asserts payload is RfpRequestDeliveryPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid RFP delivery payload");
  }
  if (typeof payload.dealId !== "string" || typeof payload.syncHubUrl !== "string") {
    throw new Error("RFP delivery payload is missing dealId or syncHubUrl");
  }
  if (!payload.body || typeof payload.body !== "object") {
    throw new Error("RFP delivery payload is missing body");
  }
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function resolveOfficeSchema(
  db: Queryable,
  officeId: string | null,
  options: OfficeSchemaOptions = {}
): Promise<string> {
  if (!officeId) {
    throw new Error("RFP delivery job is missing officeId");
  }
  const requireActive = options.requireActive ?? true;
  const result = await db.query(
    `SELECT slug FROM public.offices WHERE id = $1${requireActive ? " AND is_active = true" : ""}`,
    [officeId]
  );
  const slug = result.rows[0]?.slug;
  if (typeof slug !== "string" || !/^[a-z][a-z0-9_]*$/.test(slug)) {
    throw new Error(`Unable to resolve ${requireActive ? "active " : ""}office schema for officeId=${officeId}`);
  }
  return `office_${slug}`;
}

function signBody(rawBody: string, secret: string): string {
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return `sha256=${digest}`;
}

async function updateDealPending(
  db: Queryable,
  schemaName: string,
  dealId: string,
  body: Record<string, any>,
  roundEventId: string | null
) {
  await db.query(
    `UPDATE ${quoteIdent(schemaName)}.deals
        SET rfp_approval_request_id = $1,
            rfp_approval_token = $2,
            rfp_approval_status = 'pending',
            rfp_conflict_reason = NULL,
            rfp_conflict_with = NULL,
            rfp_last_attempt_error = NULL,
            -- Start the new RFP cycle with CLEAN override-review state. A re-opened deal carries the prior
            -- cycle's rfp_override_* fields, and a stale 'denial_reconfirmed' makes reconfirmRfpDecline's guard
            -- match 0 rows -> it silently SUPPRESSES the new cycle's re-confirm + email (#651); a stale
            -- 'override_approved' was the #653 risk. The prior cycle's decisions remain in deal_history +
            -- audit_log, so clearing the LIVE fields loses no history.
            rfp_override_decision = NULL,
            rfp_override_reviewed_at = NULL,
            rfp_override_reviewed_by = NULL,
            rfp_override_note = NULL,
            rfp_override_state = NULL,
            rfp_override_error = NULL,
            updated_at = NOW()
      WHERE id = $3
        -- ROUND GUARD, two predicates that do different jobs.
        --
        -- (1) STATUS: this job writes back BY DEAL ID from a payload snapshot, so a delivery already in
        -- flight would repopulate an RFP cycle since cleared by "Move back to Opportunity" — and a
        -- non-null status is what re-arms the bid-board-created resurrection guard.
        --
        -- (2) ROUND IDENTITY: status alone is not identity. A move-back FOLLOWED BY a fresh trigger puts
        -- the NEW round back into pending_outbox, so a stale response would satisfy the status predicate
        -- and overwrite the new round's request id/token with the old one's. rfp_bidboard_create already
        -- binds its recheck this way; this mirrors it. FAIL-OPEN when either side is unknown (a payload
        -- with no parseable sourceEventId, or a deal with no round stamped): an over-eager guard here
        -- would silently stop every delivery, which is far worse than the drift it prevents.
        AND rfp_approval_status IN ('pending_outbox', 'pending')
        AND ($4::text IS NULL OR rfp_approval_request_event_id IS NULL
             OR rfp_approval_request_event_id::text = $4::text)`,
    [body.requestId ?? body.id ?? null, body.token ?? null, dealId, roundEventId]
  );
}

async function updateDealConflict(
  db: Queryable,
  schemaName: string,
  dealId: string,
  body: Record<string, any>,
  roundEventId: string | null
) {
  await db.query(
    `UPDATE ${quoteIdent(schemaName)}.deals
        SET rfp_approval_status = 'conflict',
            rfp_conflict_reason = $1,
            rfp_conflict_with = $2::jsonb,
            rfp_last_attempt_error = NULL,
            updated_at = NOW()
      WHERE id = $3
        -- Same two-part round guard as the success path: a conflict verdict must neither resurrect a
        -- cleared cycle nor mark a DIFFERENT, later round conflicted.
        AND rfp_approval_status IN ('pending_outbox', 'pending')
        AND ($4::text IS NULL OR rfp_approval_request_event_id IS NULL
             OR rfp_approval_request_event_id::text = $4::text)`,
    [body.error ?? "conflict", JSON.stringify(body.conflict ?? body), dealId, roundEventId]
  );
}

async function parseResponseBody(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function handleRfpRequestDelivery(
  payload: unknown,
  officeId: string | null,
  deps: {
    db?: PoolLike;
    fetchImpl?: typeof fetch;
    secret?: string;
  } = {}
): Promise<void> {
  assertPayload(payload);
  const db = deps.db ?? pool;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const secret = deps.secret ?? process.env.SYNCHUB_SHARED_SECRET;
  if (!secret) {
    throw new Error("SYNCHUB_SHARED_SECRET is not configured for RFP request delivery");
  }

  const schemaName = await resolveOfficeSchema(db, officeId);

  // The round this job was built for. Mirrors rfp_bidboard_create's binding; null when the payload
  // predates the format or is malformed, in which case every round check below fails OPEN.
  const roundEventId =
    /^crm:deal-stage:opportunity:(.+)$/.exec(String((payload.body as any)?.sourceEventId ?? ""))?.[1] ??
    null;

  // AUTHORIZE THE SEND under the deal's advisory lock, then POST outside it.
  //
  // The write-back guards below stop a stale delivery from corrupting the deal, but only declining to
  // send stops an ORPHAN RFP submission being created in SyncHub for a cancelled cycle — one the
  // operator would have to chase down externally. "Move back to Opportunity" cancels still-queued jobs
  // inside its own transaction; this covers the job it could not reach because this worker had already
  // claimed it.
  //
  // Taking the SAME deal-scoped advisory lock that action holds is what makes the check meaningful
  // rather than advisory: an unlocked read could observe `pending_outbox` a microsecond before the
  // move-back commits and send anyway. Serialising on the lock means we either read the pre-move state
  // and send while the move-back waits, or we wait and then read the cleared cycle and skip. Held only
  // across the read — a database transaction must not span an outbound HTTP call.
  const authClient: Queryable & { release?: () => void } = db.connect ? await db.connect() : db;
  let authorized = true;
  let observedStatus: string | null = null;
  let observedRound: string | null = null;
  try {
    await authClient.query("BEGIN");
    await authClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${DEAL_RFP_DELIVERY_LOCK_NAMESPACE}${payload.dealId}`,
    ]);
    const current = await authClient.query(
      `SELECT rfp_approval_status, rfp_approval_request_event_id
         FROM ${quoteIdent(schemaName)}.deals WHERE id = $1`,
      [payload.dealId]
    );
    if (current.rows.length > 0) {
      observedStatus = current.rows[0].rfp_approval_status ?? null;
      observedRound = current.rows[0].rfp_approval_request_event_id ?? null;
      const awaiting = observedStatus === "pending_outbox" || observedStatus === "pending";
      // Fail-open on an unknown round, exactly as the SQL guards do.
      const sameRound = roundEventId == null || observedRound == null || observedRound === roundEventId;
      authorized = awaiting && sameRound;
    }
    await authClient.query("COMMIT");
  } catch (err) {
    // Fail OPEN on a recheck error (DB blip / schema resolve), matching rfp_bidboard_create: better to
    // attempt a legitimate send, since the write-back guards still reject a stale response.
    await authClient.query("ROLLBACK").catch(() => {});
    console.warn(
      `[Worker:rfp_request_delivery] Pre-send recheck failed for deal ${payload.dealId}; proceeding (write-back guards still apply):`,
      err
    );
  } finally {
    authClient.release?.();
  }

  if (!authorized) {
    console.info(
      `[Worker:rfp_request_delivery] Skipping delivery for deal ${payload.dealId}: no longer awaiting THIS round (status=${observedStatus ?? "cleared"}, round=${observedRound ?? "null"} vs payload=${roundEventId ?? "null"})`
    );
    return;
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
    throw new Error(`RFP delivery network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const responseBody = await parseResponseBody(response);

  if (response.status === 201 || response.status === 200) {
    await updateDealPending(db, schemaName, payload.dealId, responseBody, roundEventId);
    if (response.status === 200) {
      console.info(`[Worker:rfp_request_delivery] Idempotent replay accepted for deal ${payload.dealId}`);
    }
    return;
  }

  if (response.status === 409) {
    await updateDealConflict(db, schemaName, payload.dealId, responseBody, roundEventId);
    return;
  }

  throw new Error(
    `RFP delivery failed with ${response.status}: ${responseBody.error ?? responseBody.message ?? response.statusText}`
  );
}

export async function runRfpRequestDeadLetterSweep(
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
    const result = await client.query(
      `WITH claimed AS (
         SELECT id
           FROM public.job_queue
          WHERE status = 'dead'
            AND job_type = 'rfp_request_delivery'
            AND (payload->>'dealHandled' IS NULL OR payload->>'dealHandled' = 'false')
          ORDER BY id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE public.job_queue
          SET payload = jsonb_set(payload, '{dealHandled}', '"claimed"'::jsonb, true)
         FROM claimed
        WHERE public.job_queue.id = claimed.id
        RETURNING public.job_queue.id,
                  public.job_queue.payload,
                  public.job_queue.office_id,
                  public.job_queue.last_error`,
      [limit]
    );

    for (const job of result.rows) {
      try {
        await client.query("BEGIN");
        const payload = job.payload as RfpRequestDeliveryPayload;
        if (!payload?.dealId) {
          await client.query(
            "UPDATE public.job_queue SET payload = jsonb_set(payload, '{dealHandled}', 'true'::jsonb, true) WHERE id = $1",
            [job.id]
          );
          await client.query("COMMIT");
          continue;
        }

        const schemaName = await resolveOfficeSchema(client, job.office_id, { requireActive: false });
        await client.query(
          `UPDATE ${quoteIdent(schemaName)}.deals
              SET rfp_approval_status = 'send_failed',
                  rfp_last_attempt_error = $1,
                  updated_at = NOW()
            WHERE id = $2`,
          [job.last_error ?? "RFP delivery exhausted retries", payload.dealId]
        );
        await client.query(
          "UPDATE public.job_queue SET payload = jsonb_set(payload, '{dealHandled}', 'true'::jsonb, true) WHERE id = $1",
          [job.id]
        );
        await client.query("COMMIT");
        handled += 1;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[Worker:rfp_request_delivery] Failed to handle dead RFP delivery job ${job.id}`, err);
      }
    }

    return handled;
  } catch (err) {
    throw err;
  } finally {
    if ("release" in client && typeof client.release === "function") {
      client.release();
    }
  }
}
