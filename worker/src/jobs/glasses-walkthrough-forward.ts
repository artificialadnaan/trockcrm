// Forwards one filed glasses-walkthrough to TROCK Scope, via its presigned-R2-multipart ingest API
// (server/src/routes/walkthroughs.ts in the trock-scope repo — NOT a simple POST).
//
// This is the second half of the glasses-walkthrough seam. The FIRST half
// (server/src/modules/walkthrough-capture/glasses-walkthrough-service.ts, in the trockcrm API) writes
// the `files` rows the crew sees in the project folder and enqueues exactly one `job_queue` row of this
// type per walk. That write already SUCCEEDED and is durable by the time this handler ever runs — TROCK
// Scope being unreachable can only fail THIS job, on its own retry schedule (job_queue's standard
// exponential backoff, worker/src/queue.ts), and can never take the filed copy down with it.
//
// AUTH: a shared service token (TROCK_SCOPE_SERVICE_TOKEN), presented as a bearer token, per
// TROCK_SCOPE_BASE_URL. TROCK Scope does not yet accept this — see the module-level comment on
// `scopeRequest` for exactly what has to land on that side.
//
// IDEMPOTENCY ACROSS RETRIES: TROCK Scope's `POST /walkthroughs` has no idempotency key of its own, so
// naively re-running this handler on every retry would create a SECOND walkthrough (and re-upload every
// clip into it) each time a later step fails. Once this handler successfully creates the remote
// walkthrough, its id is checkpointed BACK into this job's own `job_queue.payload` (a `jsonb_set` update
// keyed on `job_type` + `payload->>'walkId'`, the same technique `runRfpRequestDeadLetterSweep`
// (rfp-request-delivery.ts) uses to mark dead rows handled) — so a later attempt of the SAME job reads
// it back and reuses the existing remote walkthrough instead of creating another. Per-CLIP retries are
// simpler: TROCK Scope's own checksum uniqueness constraint (clips_walkthrough_checksum_key) rejects a
// second copy of identical bytes inside one walkthrough as `duplicate_bytes` (409), which
// `completeClip` below treats as a non-fatal terminal outcome — so re-uploading a clip that fully landed
// on a prior attempt is at worst a wasted upload, never duplicate scope data.
import { deadJob, type JobHandlerResult } from "../queue.js";
import { pool } from "../db.js";
import { getObjectRangeBuffer } from "../lib/r2-client.js";

export const GLASSES_WALKTHROUGH_FORWARD_JOB = "glasses_walkthrough_forward";

/** TROCK Scope signs at most this many parts per `/clips/:id/parts` call (upload-service.ts,
 *  MAX_PARTS_PER_SIGN_REQUEST) — batch our part-number requests to respect it. */
const MAX_PARTS_PER_SIGN_REQUEST = 100;

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

interface JobArtifact {
  fileId: string;
  idempotencyKey: string;
  kind: "video" | "audio" | "photo";
  r2Key: string;
  mimeType: string;
  originalFilename: string;
  fileSizeBytes: number;
  capturedAtMs: number | null;
}

interface JobPayload {
  walkId: string;
  dealId: string;
  projectId: string | null;
  title: string;
  siteLabel: string | null;
  capturedAt: string;
  capturedByUserId: string;
  officeSlug: string;
  artifacts: JobArtifact[];
  /** The checkpoint: set once TROCK Scope's walkthrough has actually been created, so a retry of this
   *  same job row reuses it instead of creating a second one. */
  scopeWalkthroughId?: string;
}

function assertPayload(payload: unknown): JobPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid glasses_walkthrough_forward payload");
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.walkId !== "string" || !p.walkId) throw new Error("payload missing walkId");
  if (typeof p.dealId !== "string" || !p.dealId) throw new Error("payload missing dealId");
  if (typeof p.title !== "string") throw new Error("payload missing title");
  if (!Array.isArray(p.artifacts) || p.artifacts.length === 0) {
    throw new Error("payload missing artifacts");
  }
  for (const entry of p.artifacts) {
    if (!entry || typeof entry !== "object") throw new Error("invalid artifact entry in payload");
    const a = entry as Record<string, unknown>;
    if (
      typeof a.fileId !== "string" ||
      typeof a.idempotencyKey !== "string" ||
      typeof a.r2Key !== "string" ||
      typeof a.mimeType !== "string" ||
      typeof a.originalFilename !== "string" ||
      typeof a.fileSizeBytes !== "number"
    ) {
      throw new Error("invalid artifact entry fields in payload");
    }
  }
  return payload as JobPayload;
}

interface ScopeDeps {
  baseUrl: string;
  token: string;
  fetchImpl: typeof fetch;
}

/**
 * REQUIRED trock-scope follow-up (out of scope for this repo): `createRequireUser`
 * (server/src/middleware/require-user.ts) only accepts the `scope_session` cookie today — there is no
 * bearer/service-token path at all. This client sends `Authorization: Bearer <TROCK_SCOPE_SERVICE_TOKEN>`
 * on every call and needs a matching middleware on that side that:
 *   1. accepts the bearer token (constant-time compare against its own copy of the shared secret), and
 *   2. populates `req.user` (or an equivalent) for the walkthrough router, which currently reads
 *      `req.user!.id` directly as `capturedBy` on `POST /walkthroughs` (routes/walkthroughs.ts:128) — a
 *      machine caller has no session user, so either that route needs to accept a trusted `capturedBy`
 *      field in the body for service-authenticated requests, or the machine-auth middleware needs to
 *      resolve `capturedByUserId` (trockcrm's real actor id, sent below) to a real or synthetic
 *      trock-scope user. This client already sends the estimator's trockcrm user id as `capturedBy` in
 *      the walkthrough-create body in anticipation of whichever shape is chosen; today TROCK Scope
 *      ignores it and would 401 the request outright with no machine-auth middleware in place.
 */
async function scopeRequest(
  deps: ScopeDeps,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, any> }> {
  const response = await deps.fetchImpl(`${deps.baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${deps.token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, any> = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: response.status, json };
}

async function createScopeWalkthrough(
  deps: ScopeDeps,
  payload: JobPayload
): Promise<{ id: string }> {
  const { status, json } = await scopeRequest(deps, "POST", "/api/walkthroughs", {
    title: payload.title,
    siteLabel: payload.siteLabel,
    dealUuid: payload.dealId,
    officeSlug: payload.officeSlug,
    capturedBy: payload.capturedByUserId,
  });
  const id = json?.walkthrough?.id;
  if (status !== 201 || typeof id !== "string") {
    throw new Error(`TROCK Scope walkthrough create failed: ${status} ${JSON.stringify(json)}`);
  }
  return { id };
}

interface BeginClipResult {
  clipId: string;
  uploadId: string;
  partSize: number;
  partCount: number;
}

async function beginClip(deps: ScopeDeps, walkthroughId: string, artifact: JobArtifact): Promise<BeginClipResult> {
  const { status, json } = await scopeRequest(deps, "POST", `/api/walkthroughs/${walkthroughId}/clips`, {
    originalFilename: artifact.originalFilename,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.fileSizeBytes,
    // capturedAt/capturedAtSource deliberately omitted: TROCK Scope only accepts a client-declared
    // "manual" wall-clock timestamp, and all we have is a walk-relative offset (capturedAtMs), not an
    // absolute time. Left at the default ("upload_order"); TROCK Scope's own worker later derives the
    // real per-clip timeline from the media's embedded exif/container metadata.
  });
  if (status !== 201) {
    throw new Error(`TROCK Scope begin-clip failed for artifact ${artifact.idempotencyKey}: ${status} ${JSON.stringify(json)}`);
  }
  return {
    clipId: json.clipId,
    uploadId: json.uploadId,
    partSize: json.partSize,
    partCount: json.partCount,
  };
}

async function signParts(
  deps: ScopeDeps,
  walkthroughId: string,
  clipId: string,
  partNumbers: number[]
): Promise<Array<{ partNumber: number; url: string }>> {
  const signed: Array<{ partNumber: number; url: string }> = [];
  for (let i = 0; i < partNumbers.length; i += MAX_PARTS_PER_SIGN_REQUEST) {
    const batch = partNumbers.slice(i, i + MAX_PARTS_PER_SIGN_REQUEST);
    const { status, json } = await scopeRequest(deps, "POST", `/api/walkthroughs/${walkthroughId}/clips/${clipId}/parts`, {
      partNumbers: batch,
    });
    if (status !== 200 || !Array.isArray(json.parts)) {
      throw new Error(`TROCK Scope sign-parts failed for clip ${clipId}: ${status} ${JSON.stringify(json)}`);
    }
    signed.push(...json.parts);
  }
  return signed;
}

async function completeClip(
  deps: ScopeDeps,
  walkthroughId: string,
  clipId: string,
  parts: Array<{ partNumber: number; etag: string }>
): Promise<{ outcome: "uploaded" | "duplicate_bytes" }> {
  const { status, json } = await scopeRequest(deps, "POST", `/api/walkthroughs/${walkthroughId}/clips/${clipId}/complete`, {
    parts,
  });
  // 409 duplicate_bytes is documented by TROCK Scope as "the request was understood and refused" — a
  // terminal, non-fatal outcome (see completeClipUpload's own comment in trock-scope), most often this
  // exact clip's bytes having already landed under this walkthrough on a prior attempt of this job.
  if (status === 200 || status === 409) {
    return { outcome: json.outcome === "duplicate_bytes" ? "duplicate_bytes" : "uploaded" };
  }
  throw new Error(`TROCK Scope complete-clip failed for clip ${clipId}: ${status} ${JSON.stringify(json)}`);
}

async function uploadClip(
  deps: ScopeDeps,
  walkthroughId: string,
  artifact: JobArtifact,
  downloadRange: (r2Key: string, start: number, end: number) => Promise<Buffer>
): Promise<void> {
  const begin = await beginClip(deps, walkthroughId, artifact);
  const partNumbers = Array.from({ length: begin.partCount }, (_, index) => index + 1);
  const signedParts = await signParts(deps, walkthroughId, begin.clipId, partNumbers);

  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  for (const part of signedParts) {
    const startByte = (part.partNumber - 1) * begin.partSize;
    const endByte = Math.min(startByte + begin.partSize, artifact.fileSizeBytes) - 1;
    // Ranged read of OUR OWN R2 object, one part at a time — bounds memory to one part (32MiB, TROCK
    // Scope's PART_SIZE_BYTES) regardless of how large the whole clip is, instead of buffering an
    // entire multi-GB video in the worker's process.
    const chunk = await downloadRange(artifact.r2Key, startByte, endByte);
    // A known TS 5.7+ / @types/node friction point: `BodyInit` wants an `ArrayBufferView<ArrayBuffer>`,
    // and both `Buffer` and a fresh `Uint8Array` are typed `<ArrayBufferLike>` here, so neither satisfies
    // it structurally even though a Buffer is exactly what Node's fetch accepts (and sends) at runtime.
    // The cast is a type-level workaround only; no behavioral change.
    const putResponse = await deps.fetchImpl(part.url, { method: "PUT", body: chunk as unknown as BodyInit });
    if (!putResponse.ok) {
      throw new Error(
        `Uploading part ${part.partNumber} of clip ${begin.clipId} (artifact ${artifact.idempotencyKey}) failed: ${putResponse.status}`
      );
    }
    const etag = putResponse.headers.get("etag");
    if (!etag) {
      throw new Error(`R2 returned no ETag for part ${part.partNumber} of clip ${begin.clipId}`);
    }
    completedParts.push({ partNumber: part.partNumber, etag });
  }

  await completeClip(deps, walkthroughId, begin.clipId, completedParts);
}

async function checkpointScopeWalkthroughId(db: Queryable, walkId: string, scopeWalkthroughId: string): Promise<void> {
  await db.query(
    `UPDATE public.job_queue
        SET payload = jsonb_set(payload, '{scopeWalkthroughId}', to_jsonb($1::text), true)
      WHERE job_type = $2
        AND payload ->> 'walkId' = $3`,
    [scopeWalkthroughId, GLASSES_WALKTHROUGH_FORWARD_JOB, walkId]
  );
}

export async function handleGlassesWalkthroughForward(
  payload: unknown,
  _officeId: string | null,
  deps: {
    db?: Queryable;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    token?: string;
    downloadRange?: (r2Key: string, start: number, end: number) => Promise<Buffer>;
  } = {}
): Promise<JobHandlerResult> {
  const p = assertPayload(payload);
  const db = deps.db ?? (pool as unknown as Queryable);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const baseUrl = deps.baseUrl ?? process.env.TROCK_SCOPE_BASE_URL;
  const token = deps.token ?? process.env.TROCK_SCOPE_SERVICE_TOKEN;

  if (!baseUrl) {
    // Fail loudly and clearly, per the auth-config contract: an unset service token/base URL is a
    // deploy-config error, not "TROCK Scope is down" — dead-letter immediately rather than burning the
    // retry budget on a call that can never succeed until an operator fixes the environment.
    return deadJob("TROCK_SCOPE_BASE_URL is not configured for glasses_walkthrough_forward.");
  }
  if (!token) {
    return deadJob("TROCK_SCOPE_SERVICE_TOKEN is not configured for glasses_walkthrough_forward.");
  }

  const scopeDeps: ScopeDeps = { baseUrl: baseUrl.replace(/\/+$/, ""), token, fetchImpl };
  const downloadRange = deps.downloadRange ?? getObjectRangeBuffer;

  let scopeWalkthroughId = p.scopeWalkthroughId;
  if (!scopeWalkthroughId) {
    const created = await createScopeWalkthrough(scopeDeps, p);
    scopeWalkthroughId = created.id;
    await checkpointScopeWalkthroughId(db, p.walkId, scopeWalkthroughId);
  }

  for (const artifact of p.artifacts) {
    await uploadClip(scopeDeps, scopeWalkthroughId, artifact, downloadRange);
  }
}
