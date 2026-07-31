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
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
import { escapeHtml, normalizeText } from "../lib/email-format.js";
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";

export const GLASSES_WALKTHROUGH_FORWARD_JOB = "glasses_walkthrough_forward";

/** TROCK Scope signs at most this many parts per `/clips/:id/parts` call (upload-service.ts,
 *  MAX_PARTS_PER_SIGN_REQUEST) — batch our part-number requests to respect it. */
const MAX_PARTS_PER_SIGN_REQUEST = 100;

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

type PoolLike = Queryable & {
  connect?: () => Promise<Queryable & { release: () => void }>;
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

// ── Dead-letter alert ──────────────────────────────────────────────────────────────────────────────
//
// The estimator's phone said "uploaded" and was telling the truth — the walk is durably filed in the
// project folder (the write in glasses-walkthrough-service.ts already committed before this job's row
// ever existed). But if the forward above dead-letters — either immediately via `deadJob(...)` on a
// config error, or by exhausting job_queue's maxAttempts (10, see the insert in
// glasses-walkthrough-service.ts) on repeated transient failures — NO scope is ever generated and,
// until now, nothing told anyone. A site visit is not repeatable, so this has to be a loud, one-time
// email, not a line in a log nobody tails.
//
// PATTERN: mirrors runRfpBidBoardCreateDeadLetterSweep / runRfpVoteInvitationDeadLetterSweep
// (rfp-bidboard-create.ts / rfp-vote-invitation.ts) — the established dead-letter precedent in this
// codebase — NOT a new mechanism. A periodic sweep (wired into worker/src/index.ts's existing 60s
// dead-letter-sweep interval) claims `status = 'dead'` rows of this job_type via a tri-state
// payload marker (`alertSent`: unset -> 'claimed' -> 'true'), written INSIDE the same per-row
// transaction as the "do the work" step (the send), so a throw ANYWHERE in that row's handling rolls
// the claim back too and the row stays retryable on the next sweep tick — never silently stranded at
// 'claimed'. Both dead-letter paths land here identically: the queue writes 'dead' the same way whether
// the handler returned deadJob(...) on attempt 1 or threw on its 10th — this sweep can't tell them apart
// from job_queue's status/columns alone, so the email states BOTH the attempt count and an inference
// ("failed immediately" vs "exhausted N retries") so a reader isn't left guessing.
//
// Because this runs entirely AFTER the job already reached its terminal 'dead' state — never inside
// handleGlassesWalkthroughForward's own retry path — it structurally cannot fail the forward job any
// further. The per-row try/catch additionally ensures a mail-provider failure (or anything else) here is
// logged and swallowed, never thrown out of this function: worker/src/index.ts still wraps the call in
// its own try/catch as a second layer, matching every sibling sweep.
//
// TOKEN SAFETY: this sweep never reads TROCK_SCOPE_SERVICE_TOKEN — it only ever surfaces `last_error`,
// the text job_queue already stored (deadJob()'s config-error messages name the missing env var, never
// its value; every other failure message here is built from TROCK Scope's own HTTP response). Not
// reading the token at all is the guarantee that this alert can never leak it, careless message or not.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEV_FALLBACK_NODE_ENVS = new Set(["development", "test"]);

/** Non-production fallback recipient so local/dev runs don't require configuring the env var. A
 *  misconfigured production worker (NODE_ENV unset or non-canonical) intentionally does NOT fall back —
 *  see resolveGlassesWalkthroughForwardAlertRecipients. */
export const DEFAULT_NON_PROD_GLASSES_WALKTHROUGH_FORWARD_ALERT_RECIPIENT = "adnaan.iqbal@gmail.com";

/**
 * Comma-list parser + resolver for GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS, mirroring
 * resolveWonMetricDecreaseRecipients (won-metric-reduction-alert.ts) and resolveRfpReviewerEmails
 * (shared/src/lib/rfpReviewerEmails.ts) — the established `<DOMAIN>_EMAIL_RECIPIENTS` convention for a
 * worker-only operational alert. Trims, lower-cases, validates, and de-dupes; an unset/empty var in any
 * context other than dev/test resolves to [] so the sweep fails loudly (throws, retried next tick) rather
 * than silently going dark in production.
 */
export function resolveGlassesWalkthroughForwardAlertRecipients(env: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>();
  const recipients: string[] = [];
  const configured = String(env.GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS ?? "").trim();
  const source = configured
    ? configured.split(",")
    : typeof env.NODE_ENV === "string" && DEV_FALLBACK_NODE_ENVS.has(env.NODE_ENV)
      ? [DEFAULT_NON_PROD_GLASSES_WALKTHROUGH_FORWARD_ALERT_RECIPIENT]
      : [];
  for (const raw of source) {
    const email = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    recipients.push(email);
  }
  return recipients;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Best-effort "<number> — <name>" deal label for the alert, so the reader isn't staring at a bare UUID.
 *  Never throws — a schema-name that fails the safety check, a deleted deal, or any query error all just
 *  fall back to null (the caller renders "Deal <dealId>" instead). Runs OUTSIDE the sweep's per-row
 *  transaction (via the top-level `db`, not the transactional `client`) so a failure here can never abort
 *  that transaction — Postgres marks a transaction unusable after ANY statement error inside it. */
async function resolveGlassesWalkthroughDealLabel(
  db: Queryable,
  officeSlug: string,
  dealId: string
): Promise<string | null> {
  if (!/^[a-z][a-z0-9_]*$/.test(officeSlug)) return null;
  const schema = quoteIdent(`office_${officeSlug}`);
  const result = await db.query(
    `SELECT name, deal_number, project_number FROM ${schema}.deals WHERE id = $1::uuid LIMIT 1`,
    [dealId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const number = normalizeText(row.project_number) ?? normalizeText(row.deal_number);
  const name = normalizeText(row.name);
  if (number && name) return `${number} — ${name}`;
  return name ?? number ?? null;
}

function formatCapturedAtForAlert(iso: string | null): string {
  if (!iso) return "(not recorded)";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export interface GlassesWalkthroughForwardAlertInput {
  jobId: string | number;
  dealId: string;
  dealLabel: string | null;
  title: string;
  siteLabel: string | null;
  capturedAt: string | null;
  officeSlug: string;
  officeId: string | null;
  artifactCount: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  frontendUrl: string;
}

/** Pure email renderer — kept separate from sending so it is unit-testable without a transport,
 *  mirroring renderHeartbeatEmail / renderDeadLetterEmail (bid-board-sync-heartbeat.ts). */
export function buildGlassesWalkthroughForwardAlertEmail(input: GlassesWalkthroughForwardAlertInput) {
  const officeParam = input.officeId ? `?officeId=${encodeURIComponent(input.officeId)}` : "";
  const dealUrl = `${input.frontendUrl.replace(/\/+$/, "")}/deals/${encodeURIComponent(input.dealId)}${officeParam}`;
  const safeDealUrl = escapeHtml(dealUrl);
  const dealDisplay = input.dealLabel ?? `Deal ${input.dealId}`;
  const capturedAtText = formatCapturedAtForAlert(input.capturedAt);
  const immediateFailure = input.attempts < input.maxAttempts;
  const attemptsText = immediateFailure
    ? `Failed immediately, without retrying (attempt 1 of ${input.maxAttempts}) — this is almost always a ` +
      `deploy-config problem (TROCK Scope's URL or service token), not a transient outage.`
    : `Exhausted all ${input.attempts} of ${input.maxAttempts} retry attempts.`;
  const errorText = normalizeText(input.lastError) ?? "(no error message captured)";
  const artifactsText = `${input.artifactCount} artifact${input.artifactCount === 1 ? "" : "s"} filed`;

  const subject = `TROCK Scope forward permanently failed — ${input.title}`;

  const rows: Array<[string, string]> = [
    ["Deal", dealDisplay],
    ["Walk", input.title],
    ...(input.siteLabel ? ([["Site", input.siteLabel]] as Array<[string, string]>) : []),
    ["Captured at", capturedAtText],
    ["Office", input.officeSlug],
    ["Filed as", artifactsText],
    ["Attempts", attemptsText],
    ["Job queue id", String(input.jobId)],
  ];
  const htmlRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;vertical-align:top;">${escapeHtml(value)}</td>
        </tr>`
    )
    .join("");

  const whatToDo =
    `This job will NOT retry automatically. Once the cause above is fixed, an engineer can reset ` +
    `job_queue row ${input.jobId} (job_type = glasses_walkthrough_forward) back to 'pending' to retry — ` +
    `the forward is idempotent (it checkpoints the created TROCK Scope walkthrough, and TROCK Scope itself ` +
    `rejects duplicate clip bytes), so retrying will not create duplicate scope data or duplicate uploads.`;

  const text = [
    `A glasses-walkthrough recording was never sent to TROCK Scope for scope extraction, and it will not ` +
      `retry automatically. The walk itself is safely filed in the project folder — the crew can already see ` +
      `it — but no scope was ever generated from it.`,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    `Error: ${errorText}`,
    "",
    whatToDo,
    "",
    `Open the deal: ${dealUrl}`,
  ].join("\n");

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>TROCK Scope Forward Failed</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #fecaca;">
          <tr><td style="background-color:#b91c1c;height:4px;line-height:4px;font-size:4px;mso-line-height-rule:exactly;">&nbsp;</td></tr>
          <tr><td align="center" style="padding:28px 24px 8px 24px;"><img src="${TROCK_LOGO_EMAIL_URL}" alt="T Rock Construction" width="220" height="246" style="display:block;width:220px;height:246px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" /></td></tr>
          <tr><td align="center" style="padding:4px 24px 0 24px;"><h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:26px;color:#991b1b;font-weight:bold;">TROCK Scope forward permanently failed</h1></td></tr>
          <tr><td align="center" style="padding:6px 24px 16px 24px;"><p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#334155;">The walk is safely filed in the project folder, but no scope was ever generated from it, and this will not retry automatically.</p></td></tr>
          <tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e2e8f0;">${htmlRows}</table></td></tr>
          <tr><td style="padding:16px 28px 0 28px;">
            <p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#64748b;font-weight:bold;">Error</p>
            <pre style="margin:0;padding:10px 12px;background-color:#fef2f2;border:1px solid #fecaca;border-radius:4px;color:#7f1d1d;font-family:'SFMono-Regular',Consolas,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(errorText)}</pre>
          </td></tr>
          <tr><td align="center" style="padding:24px 24px 8px 24px;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeDealUrl}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="9%" stroke="f" fillcolor="#b91c1c"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">Open deal in CRM</center></v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-- -->
            <a href="${safeDealUrl}" style="display:inline-block;background-color:#b91c1c;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;line-height:44px;text-align:center;text-decoration:none;width:240px;border-radius:4px;">Open deal in CRM</a>
            <!--<![endif]-->
          </td></tr>
          <tr><td style="padding:16px 28px 24px 28px;"><p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#64748b;">${escapeHtml(whatToDo)}</p></td></tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html, text, dealUrl };
}

export type GlassesWalkthroughForwardAlertSendEmail = (
  to: string | string[],
  subject: string,
  html: string,
  options: { text: string; idempotencyKey: string }
) => Promise<SendSystemEmailResult>;

/**
 * Dead-letter alert sweep for glasses_walkthrough_forward. See the block comment above for the full
 * rationale and how this mirrors runRfpBidBoardCreateDeadLetterSweep / runRfpVoteInvitationDeadLetterSweep.
 * Returns the count of dead jobs alerted on this sweep (0 when nothing eligible was found).
 */
export async function runGlassesWalkthroughForwardDeadLetterSweep(
  deps: {
    db?: PoolLike;
    sendEmail?: GlassesWalkthroughForwardAlertSendEmail;
    env?: NodeJS.ProcessEnv;
    limit?: number;
    logger?: Pick<Console, "log" | "warn" | "error">;
  } = {}
): Promise<number> {
  const db = deps.db ?? (pool as unknown as PoolLike);
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? console;
  const limit = deps.limit ?? 25;
  const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
  const client: Queryable & { release?: () => void } = db.connect ? await db.connect() : db;
  let handled = 0;

  try {
    // Candidate dead rows. This SELECT only READS + briefly locks (FOR UPDATE SKIP LOCKED); it does NOT
    // write the 'claimed' marker — that happens per-row inside the transaction below, so a later throw
    // rolls it back too (mirrors runRfpBidBoardCreateDeadLetterSweep's finding #4).
    const result = await client.query(
      `SELECT id, payload, office_id, last_error, attempts, max_attempts
         FROM public.job_queue
        WHERE status = 'dead'
          AND job_type = 'glasses_walkthrough_forward'
          AND (payload->>'alertSent' IS NULL OR payload->>'alertSent' IN ('false', 'claimed'))
        ORDER BY id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit]
    );

    for (const job of result.rows) {
      try {
        await client.query("BEGIN");
        // Re-lock the row inside the txn and re-check it's still unclaimed, so a concurrent sweep tick
        // can't double-alert: FOR UPDATE SKIP LOCKED returns 0 rows if another tick holds the row, and the
        // WHERE excludes it once that tick has committed alertSent='true'.
        const locked = await client.query(
          `SELECT id
             FROM public.job_queue
            WHERE id = $1
              AND status = 'dead'
              AND (payload->>'alertSent' IS NULL OR payload->>'alertSent' IN ('false', 'claimed'))
            FOR UPDATE SKIP LOCKED`,
          [job.id]
        );
        if (locked.rows.length === 0) {
          await client.query("ROLLBACK");
          continue;
        }
        // Claim marker — written in the SAME transaction as the send below. A throw before COMMIT rolls
        // this back too, leaving the row unclaimed + retryable for the next sweep instead of stuck 'claimed'.
        await client.query(
          "UPDATE public.job_queue SET payload = jsonb_set(payload, '{alertSent}', '\"claimed\"'::jsonb, true) WHERE id = $1",
          [job.id]
        );

        const payload = (job.payload ?? {}) as Record<string, unknown>;
        const dealId = normalizeText(payload.dealId as unknown);
        const title = normalizeText(payload.title as unknown) ?? "(untitled walk)";
        const siteLabel = normalizeText(payload.siteLabel as unknown);
        const capturedAt = normalizeText(payload.capturedAt as unknown);
        const officeSlug = normalizeText(payload.officeSlug as unknown);
        const artifactCount = Array.isArray(payload.artifacts) ? payload.artifacts.length : 0;

        // Best-effort deal label enrichment via the TOP-LEVEL db (not the per-row `client`) — see the
        // function doc for why this must run outside the transaction. Never blocks the alert.
        let dealLabel: string | null = null;
        if (dealId && officeSlug) {
          try {
            dealLabel = await resolveGlassesWalkthroughDealLabel(db, officeSlug, dealId);
          } catch (err) {
            logger.warn(
              `[Worker:glasses_walkthrough_forward] Could not resolve a deal label for the dead-letter alert (job ${job.id}); continuing with the raw id`,
              { dealId, officeSlug, err }
            );
          }
        }

        const email = buildGlassesWalkthroughForwardAlertEmail({
          jobId: job.id,
          dealId: dealId ?? "(unknown)",
          dealLabel,
          title,
          siteLabel,
          capturedAt,
          officeSlug: officeSlug ?? "(unknown)",
          officeId: job.office_id ?? null,
          artifactCount,
          attempts: Number(job.attempts) || 0,
          maxAttempts: Number(job.max_attempts) || 0,
          lastError: job.last_error ?? null,
          frontendUrl: resolveFrontendUrl(env),
        });

        const recipients = resolveGlassesWalkthroughForwardAlertRecipients(env);
        if (recipients.length === 0) {
          // Fail loudly rather than silently going dark: this throws, the per-row catch below logs it and
          // ROLLBACKs (undoing the claim), and the row is retried on the NEXT sweep tick — so once the env
          // var is configured, the backlog alerts within one cycle instead of being lost.
          throw new Error(
            "GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS is not configured — cannot alert on a permanently-failed glasses-walkthrough forward"
          );
        }

        const sendResult = await sendEmail(recipients, email.subject, email.html, {
          text: email.text,
          // Stable per-job key: an at-least-once re-send after an uncertain marker write dedupes provider-
          // side, mirroring the bid-board heartbeat's dead-letter batch key.
          idempotencyKey: `glasses-walkthrough-forward-dead-${job.id}`,
        });
        if (!sendResult.success) {
          throw new Error("Email provider returned unsuccessful result");
        }

        await client.query(
          "UPDATE public.job_queue SET payload = jsonb_set(payload, '{alertSent}', 'true'::jsonb, true) WHERE id = $1",
          [job.id]
        );
        await client.query("COMMIT");
        handled += 1;
        logger.log(
          `[Worker:glasses_walkthrough_forward] Alerted on permanently-failed forward (job ${job.id}, deal ${dealId ?? "unknown"})`
        );
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        logger.error(`[Worker:glasses_walkthrough_forward] Failed to alert on dead job ${job.id}`, err);
      }
    }

    return handled;
  } finally {
    if ("release" in client && typeof client.release === "function") {
      client.release();
    }
  }
}
