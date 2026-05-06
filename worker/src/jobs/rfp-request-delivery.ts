import crypto from "node:crypto";
import { pool } from "../db.js";

export interface RfpRequestDeliveryPayload {
  dealId: string;
  syncHubUrl: string;
  body: Record<string, unknown>;
  dealHandled?: boolean;
}

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

type PoolLike = Queryable & {
  connect?: () => Promise<Queryable & { release: () => void }>;
};

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
  body: Record<string, any>
) {
  await db.query(
    `UPDATE ${quoteIdent(schemaName)}.deals
        SET rfp_approval_request_id = $1,
            rfp_approval_token = $2,
            rfp_approval_status = 'pending',
            rfp_conflict_reason = NULL,
            rfp_conflict_with = NULL,
            rfp_last_attempt_error = NULL,
            updated_at = NOW()
      WHERE id = $3`,
    [body.requestId ?? body.id ?? null, body.token ?? null, dealId]
  );
}

async function updateDealConflict(
  db: Queryable,
  schemaName: string,
  dealId: string,
  body: Record<string, any>
) {
  await db.query(
    `UPDATE ${quoteIdent(schemaName)}.deals
        SET rfp_approval_status = 'conflict',
            rfp_conflict_reason = $1,
            rfp_conflict_with = $2::jsonb,
            rfp_last_attempt_error = NULL,
            updated_at = NOW()
      WHERE id = $3`,
    [body.error ?? "conflict", JSON.stringify(body.conflict ?? body), dealId]
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
    await updateDealPending(db, schemaName, payload.dealId, responseBody);
    if (response.status === 200) {
      console.info(`[Worker:rfp_request_delivery] Idempotent replay accepted for deal ${payload.dealId}`);
    }
    return;
  }

  if (response.status === 409) {
    await updateDealConflict(db, schemaName, payload.dealId, responseBody);
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
