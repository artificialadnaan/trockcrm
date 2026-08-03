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
// IDEMPOTENCY ACROSS RETRIES: TROCK Scope's `POST /walkthroughs` has no idempotency key of its own, AND no
// way to look a walkthrough up by anything but its own uuid — so this job can never ask, after the fact,
// "did my last create land?". Retries are made safe instead by a two-phase marker in this job's OWN
// `job_queue.payload` (`jsonb_set` keyed on `job_type` + `payload->>'walkId'`, the same technique
// `runRfpRequestDeadLetterSweep` (rfp-request-delivery.ts) uses to mark dead rows handled):
//
//   1. BEFORE the create call goes out, `scopeCreatePendingRef` is written — "a create with this external
//      ref is in flight and its outcome is unknown". Writing it AFTER the call, or not at all, is the
//      obvious shape and it is exactly what breaks: a worker that dies — or whose checkpoint write fails —
//      in the window between a successful create and the returned id landing in the payload is redelivered
//      the ORIGINAL payload and creates a SECOND walkthrough. That is a second transcription and a second
//      Anthropic scope extraction, both billed, both wrong, and nothing anywhere says so.
//   2. On success, `scopeWalkthroughId` replaces the marker in ONE statement, so no reader ever sees a
//      payload carrying both. A later attempt of the same row reads the id back and reuses the existing
//      remote walkthrough instead of creating another.
//   3. The marker is CLEARED — leaving the row plainly retryable — only on positive evidence that no remote
//      walkthrough exists: TROCK Scope answered with a non-2xx, or the connection was never established.
//      Both are today's EXPECTED failures (TROCK Scope is not deployed at all → ECONNREFUSED, and has no
//      machine-auth middleware → 401), so treating them as "unknown" would dead-letter every single walk on
//      attempt 2 and make this fix worse than the bug it closes.
//   4. Every OTHER failure — socket lost mid-flight, a 2xx whose body carries no readable id, an outright
//      crash — leaves the marker set, and the NEXT attempt dead-letters with reconciliation instructions
//      rather than creating a second walkthrough. A dead letter a human clears in a minute beats a silent
//      duplicate, and the walk itself is durably filed in the project folder either way, so nothing the
//      crew can see is ever at risk.
//
// A deterministic `externalRef` (`deriveScopeWalkthroughExternalRef`) is sent with every create, and TROCK
// Scope now HONOURS it: the column carries a unique index, and a repeat create answers 201 with the
// EXISTING walkthrough (`deduplicated: true`) instead of inserting a second one. It was inert when the
// scheme above was written — that route copied a fixed set of body fields and dropped the rest — so two
// things that used to be free no longer are:
//   • the ref is a function of the (walk, DEAL) pair, never the walk alone. A ref two deals share is no
//     longer a wasted field, it is deal B's clips uploading into deal A's remote walkthrough. Read the doc
//     on `deriveScopeWalkthroughExternalRef` before changing its shape.
//   • a 201 is no longer proof that THIS attempt inserted the row, and nothing below assumes it is: the
//     deduplicated answer names the walkthrough this delivery already owns, which is exactly what the
//     checkpoint wants to store either way. What this DOES depend on is the dedupe answering 201 and not
//     409 — `createScopeWalkthrough` reads a 4xx as "refused before it created anything", so a ref
//     conflict reported as 409 would clear the marker and retry forever against a row that already exists.
// Step 4's dead letter also stops being a guess: the ref it prints is stored on the remote row, so "did my
// create land?" is now answerable. It is still a dead letter rather than an automatic re-create — see
// `buildUnconfirmedCreateDeadLetterMessage` for why that is deliberate.
//
// Per-CLIP retries are simpler: TROCK Scope's own checksum uniqueness constraint
// (clips_walkthrough_checksum_key) rejects a second copy of identical bytes inside one walkthrough as
// `duplicate_bytes` (409), which `completeClip` below treats as a non-fatal terminal outcome — so
// re-uploading a clip that fully landed on a prior attempt is at worst a wasted upload, never duplicate
// scope data.
import { deadJob, type JobHandlerResult } from "../queue.js";
import { pool } from "../db.js";
import { getObjectRangeBuffer, R2_RANGE_READ_TIMEOUT_MS } from "../lib/r2-client.js";
import { sendSystemEmailWithMetadata, type SendSystemEmailResult } from "../lib/system-email.js";
import { escapeHtml, normalizeText } from "../lib/email-format.js";
import { resolveFrontendUrl, TROCK_LOGO_EMAIL_URL } from "./project-number-email.js";
import { timedPoolClientQuery, type TimedPoolLike } from "../lib/timed-pool-query.js";

export const GLASSES_WALKTHROUGH_FORWARD_JOB = "glasses_walkthrough_forward";

/** TROCK Scope signs at most this many parts per `/clips/:id/parts` call (upload-service.ts,
 *  MAX_PARTS_PER_SIGN_REQUEST) — batch our part-number requests to respect it. */
const MAX_PARTS_PER_SIGN_REQUEST = 100;

/**
 * Wall-clock ceilings on every outbound request. `fetch` has NO default timeout, and this job runs on a
 * dedicated poller with a reentrancy guard and a concurrency of 1 (queue.ts,
 * pollGlassesWalkthroughForwardJobs) — so one TROCK Scope (or R2) socket that is accepted and then goes
 * quiet does not merely lose this walk, it holds that guard for the life of the process and every LATER
 * walkthrough forward goes unclaimed until someone restarts the worker. The values are deliberately
 * generous: they exist to bound a hang, not to police latency, and a premature abort is expensive
 * (see the marker handling in createScopeWalkthrough — a timeout is an UNKNOWN create outcome).
 */
export interface ScopeTimeouts {
  /** Control-plane JSON calls (create / begin-clip / sign-parts): a row insert and some presigning. */
  requestMs: number;
  /** `/complete` is not a row lookup — TROCK Scope finalizes the R2 multipart upload and then checksums
   *  the ASSEMBLED object (upload-service.ts, completeClipUpload), which scales with the clip, not the
   *  request. A multi-GB video legitimately keeps this one open for many minutes. */
  completeMs: number;
  /** One presigned part PUT — at most TROCK Scope's 32MiB PART_SIZE_BYTES, over the worker's own link. */
  partPutMs: number;
  /** The SOURCE side of that same part: one ranged read of our own R2 object. Declared here with the other
   *  three because a forward is a round trip, and a ceiling on three of its four legs bounds nothing —
   *  the poller is held just as long by a stalled read as by a stalled write, and R2 is not more reliable
   *  inbound than outbound. Enforced inside `getObjectRangeBuffer`, which owns both the request and the
   *  drain of its body (the fetch-based legs above can bound themselves with an AbortSignal; the SDK read
   *  cannot). */
  sourceReadMs: number;
}

const DEFAULT_SCOPE_TIMEOUTS: ScopeTimeouts = {
  requestMs: 60_000,
  completeMs: 15 * 60_000,
  partPutMs: 10 * 60_000,
  sourceReadMs: R2_RANGE_READ_TIMEOUT_MS,
};

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

/** `connect` is REQUIRED, not optional. The dead-letter sweep runs BEGIN / claim UPDATE / send / COMMIT
 *  as one transaction, which is only a transaction at all if every statement rides the SAME connection —
 *  and a bare `query` on a pool gives no such guarantee (pg hands out whichever connection is free, so a
 *  ROLLBACK can land on a connection that never saw the BEGIN). Falling back to `db.query` therefore did
 *  not degrade gracefully; it ran a transaction-shaped sequence with none of a transaction's properties. */
type PoolLike = Queryable & {
  /** `release` takes the error argument pg actually defines. It is not decoration: a truthy argument is the
   *  only way to tell the pool to DISCARD a connection instead of handing it to the next caller, which is
   *  what the enrichment read below depends on when its deadline fires. */
  connect: () => Promise<Queryable & { release: (err?: any) => void }>;
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
  /** The INTENT marker, written before the create call and cleared the moment its outcome is known (see
   *  the IDEMPOTENCY block at the top of this file). Present on delivery ⇒ an earlier attempt sent a
   *  create whose outcome this job never learned ⇒ retrying would risk a duplicate, so it dead-letters. */
  scopeCreatePendingRef?: string;
}

/**
 * The one stable, client-supplied handle for this delivery, identical on every attempt of it. Namespaced
 * because TROCK Scope takes refs from more than one upstream.
 *
 * A pure function of (walkId, dealId), never walkId alone — the same pair the R2 keys, the payload
 * checkpoint writes and the ingress enqueue-dedupe are all scoped by, and for the same reason: walkId is
 * minted on the PHONE and identifies a physical walk, not a piece of work. The supported correction/reuse
 * flows re-file ONE walk against a SECOND deal (a mis-tagged walk moved to the right job; a recovered
 * orphan whose deal a human supplies at recovery time), which is two deliveries and must be two remote
 * walkthroughs. Derived from walkId alone it is ONE string, and now that TROCK Scope persists this column
 * under a unique index and answers a repeat create with the EXISTING walkthrough, that one string means
 * deal B's clips upload into deal A's walkthrough — a walkthrough whose `dealUuid` still names A. Nothing
 * fails: trockcrm files B correctly and the extracted scope comes back attached to a job it does not
 * describe, for an estimator to read as if it did.
 *
 * COMPOSED, not digested, unlike the analogous deal-scoping on the CRM side
 * (`deriveGlassesWalkthroughClientUploadId`, glasses-walkthrough-service.ts). That one digests because its
 * destination is `files.client_upload_id`, a varchar(64) that a dealId + a key cannot fit; here the
 * destination is a text column with no width to fight, and the ref's readability is load-bearing — it is
 * what `buildUnconfirmedCreateDeadLetterMessage` prints and what a human reconciling an unresolved create
 * types into TROCK Scope. A digest would make that message unusable to buy nothing.
 *
 * Both components are percent-encoded so the PAIR is recoverable from the joined string, i.e. so no two
 * pairs can produce one ref. That cannot happen today — walkId is free-form caller text (up to 100 chars,
 * no charset rule) but dealId reaches this payload only after being written to `files.deal_id`, a uuid
 * column, so the last `:deal:` in a raw join is always the separator. Encoded anyway, and for the reason
 * `deriveGlassesWalkthroughArtifactR2Key` gives for encoding its server-supplied components: a uniqueness
 * property that holds because of a column type three modules away is not one this function's next caller
 * can see, and the failure it protects against is silent cross-deal aliasing, which is precisely what this
 * derivation exists to end. encodeURIComponent is the identity over UUIDs and over every walkId mobile
 * mints, so nothing about the readable shape changes.
 */
export function deriveScopeWalkthroughExternalRef(walkId: string, dealId: string): string {
  return `trockcrm:glasses-walkthrough:${encodeURIComponent(walkId)}:deal:${encodeURIComponent(dealId)}`;
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
  timeouts: ScopeTimeouts;
}

/**
 * Our OWN abort fired. Kept as its own type because the one thing that must never happen is for it to be
 * mistaken for the connect-phase failures below: those PROVE the request was never processed, whereas a
 * timeout says only that we stopped waiting. Carries no `cause` on purpose — the underlying rejection is
 * the only object in this file with a reference to the request (and therefore to the Authorization
 * header), so dropping it is what keeps TROCK_SCOPE_SERVICE_TOKEN out of `last_error`.
 */
class ScopeRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeRequestTimeoutError";
  }
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
 *   3. LANDED — no longer a follow-up. `POST /walkthroughs` persists `externalRef` under a unique index and
 *      answers a repeat create with the EXISTING walkthrough (201, `deduplicated: true`) rather than a
 *      second row or a 409. The duplicate-walkthrough hazard this job's pre-create marker was carrying
 *      alone is therefore now caught on both sides. Kept in this list because the shape of what landed is
 *      what the ref's derivation has to keep faith with: it deduplicates on the ref ALONE, so the ref — not
 *      `dealUuid`, which that route only stores — is the whole of the identity, which is why
 *      `deriveScopeWalkthroughExternalRef` must scope it to the deal.
 *   4. dedupe `POST /walkthroughs/:id/clips` the same way, on a per-artifact ref (this job already has a
 *      stable one per artifact — `idempotencyKey`). This is the CHEAP fix for re-uploads on a partial
 *      failure: today a retry of a walk whose LAST clip failed re-sends every earlier clip in full, and
 *      only learns they were duplicates after the bytes have all moved — completeClipUpload computes the
 *      checksum from the ASSEMBLED object, so `duplicate_bytes` arrives at `/complete`, not before. That
 *      is correct but not free. Answering "already have this clip" at begin-clip would cost zero bytes,
 *      and — unlike a per-artifact checkpoint in this job's payload — it would still hold if the queue
 *      row were rebuilt or the walk re-enqueued. Deliberately NOT worked around locally: a second
 *      payload-marker scheme would double the crash-window surface this file already reasons about, to
 *      save bandwidth on a retry path, on a service that has never once accepted a request.
 */
async function scopeRequest(
  deps: ScopeDeps,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs: number = deps.timeouts.requestMs
): Promise<{ status: number; json: Record<string, any> }> {
  // The signal covers the BODY read as well as the headers: `fetch` resolves the moment response headers
  // arrive, so bounding only the call would still leave a stalled `response.text()` hanging the poller.
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await deps.fetchImpl(`${deps.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
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
  } catch (err) {
    // Re-shaped ONLY when our own signal fired. Anything else (a connect refusal, a socket reset) has to
    // reach the caller unchanged, because its error CODE is what the created/not-created classification
    // reads. Method + path only in the message — never the headers, never the body.
    if (signal.aborted) {
      throw new ScopeRequestTimeoutError(
        `TROCK Scope did not answer within ${timeoutMs}ms for ${method} ${path}, so the request was abandoned.`
      );
    }
    throw err;
  }
}

/**
 * Positive evidence that TROCK Scope did NOT create a walkthrough for this request. Only this error type
 * is safe to treat as "nothing happened remotely", which is what lets the caller clear the pre-create
 * marker and leave the job on its normal retry schedule. Every other failure — including a plain `Error`
 * out of this same function — means the outcome is UNKNOWN and the marker must survive.
 */
class ScopeWalkthroughNotCreatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeWalkthroughNotCreatedError";
  }
}

/** Node/undici error codes that mean the TCP/TLS connection to TROCK Scope was never established, so not
 *  one request byte can have been processed. Deliberately narrow: ECONNRESET / EPIPE / ETIMEDOUT /
 *  UND_ERR_SOCKET / UND_ERR_HEADERS_TIMEOUT are all EXCLUDED because each can fire after the server
 *  already handled the request and only the response was lost — for those, "the call failed" emphatically
 *  does not imply "nothing was created". */
const NEVER_DELIVERED_ERROR_CODES = new Set([
  "ECONNREFUSED", // nothing accepted the connection — TROCK Scope isn't deployed yet, today's normal case
  "ENOTFOUND", // DNS never resolved the host (a wrong/blank TROCK_SCOPE_BASE_URL)
  "EAI_AGAIN", // the DNS lookup itself failed
  "UND_ERR_CONNECT_TIMEOUT", // undici gave up before the connection came up
]);

/** Every error code reachable from a fetch rejection. `fetch` reports a bare `TypeError: fetch failed` and
 *  hides the real reason under `cause`; when a host resolves to several addresses and all of them fail,
 *  undici raises an `AggregateError` whose `errors` hold one code each. Reads codes ONLY — never the
 *  request, its headers or its body — which is the structural guarantee that this path cannot surface
 *  TROCK_SCOPE_SERVICE_TOKEN into a retry log or `last_error`. */
function collectNetworkErrorCodes(err: unknown, depth = 0): string[] {
  if (!err || typeof err !== "object" || depth > 4) return [];
  const node = err as { code?: unknown; cause?: unknown; errors?: unknown };
  const codes: string[] = [];
  if (typeof node.code === "string") codes.push(node.code);
  if (Array.isArray(node.errors)) {
    for (const nested of node.errors) codes.push(...collectNetworkErrorCodes(nested, depth + 1));
  }
  codes.push(...collectNetworkErrorCodes(node.cause, depth + 1));
  return codes;
}

/** True only when EVERY leg of the failure was a connect-phase refusal. `every` (not `some`) on purpose:
 *  a mixed AggregateError where one address refused and another died mid-flight is still ambiguous, and
 *  ambiguity has to fall on the "we don't know" side. An error carrying no code at all is also unknown. */
function isNeverDeliveredNetworkFailure(err: unknown): boolean {
  // A timeout WE imposed is the ambiguous case by definition: the connection was established, the request
  // was written, and all we know is that no answer came back before we stopped waiting — TROCK Scope may
  // well have committed the insert and lost the response. Checked explicitly rather than left to fall out
  // of "carries no error code", so that hanging a `cause` off ScopeRequestTimeoutError later cannot
  // quietly reclassify a timed-out create as "nothing was created" and unblock a duplicate.
  if (err instanceof ScopeRequestTimeoutError) return false;
  const codes = collectNetworkErrorCodes(err);
  return codes.length > 0 && codes.every((code) => NEVER_DELIVERED_ERROR_CODES.has(code));
}

async function createScopeWalkthrough(
  deps: ScopeDeps,
  payload: JobPayload,
  externalRef: string
): Promise<{ id: string }> {
  let status: number;
  let json: Record<string, any>;
  try {
    ({ status, json } = await scopeRequest(deps, "POST", "/api/walkthroughs", {
      title: payload.title,
      siteLabel: payload.siteLabel,
      dealUuid: payload.dealId,
      officeSlug: payload.officeSlug,
      capturedBy: payload.capturedByUserId,
      // The dedupe key TROCK Scope actually deduplicates on — not a hint. A repeat create under this ref
      // returns the walkthrough it already has, `dealUuid` and all, so this field decides which remote
      // walkthrough this delivery's clips land in. `dealUuid` above does NOT: it is stored, never matched.
      externalRef,
    }));
  } catch (err) {
    // No HTTP response at all. `fetch` resolves as soon as response HEADERS arrive, so a rejection here
    // usually — but not always — means the request never got processed. Only the connect-phase codes
    // PROVE it; anything else has to be reported as unknown so the caller keeps its pre-create marker.
    if (isNeverDeliveredNetworkFailure(err)) {
      throw new ScopeWalkthroughNotCreatedError(
        `TROCK Scope walkthrough create was never delivered (${collectNetworkErrorCodes(err).join("/")}) — ` +
          `no remote walkthrough was created.`
      );
    }
    throw err;
  }

  const id = json?.walkthrough?.id;
  if (status === 201 && typeof id === "string") {
    return { id };
  }
  if (status >= 200 && status < 300) {
    // A success status we cannot read an id out of is the one case where "the create threw" absolutely
    // does NOT imply "nothing was created" — TROCK Scope answers 201 only after its INSERT returns, so a
    // row almost certainly exists under an id we just failed to parse. Plain Error ⇒ outcome unknown ⇒ the
    // marker stays and the next attempt reconciles rather than creating a duplicate.
    throw new Error(
      `TROCK Scope walkthrough create returned ${status} with no usable walkthrough id: ${JSON.stringify(json)}`
    );
  }
  // TROCK Scope answered and refused BEFORE inserting anything. Its create route inserts and THEN replies
  // 201, so a 4xx came off the validation/auth path with no row behind it — safe to retry, and it must be,
  // because a 401 is exactly what every one of these calls gets until machine auth lands on that side.
  //
  // 4xx only, deliberately. A 5xx is NOT the same claim: 502/503/504 are the statuses a reverse proxy
  // invents when the app behind it never answered, which happens just as readily AFTER a successful INSERT
  // (response lost, gateway timed out mid-reply) as before one. Reading those as "nothing was created"
  // clears the marker and hands the next attempt a clean slate to create a duplicate walkthrough and a
  // second billed extraction — precisely the outcome this checkpoint exists to prevent. Everything at 5xx
  // and above is therefore reported as UNKNOWN (plain Error), which keeps the marker and routes the retry
  // into reconciliation instead.
  if (status >= 400 && status < 500) {
    throw new ScopeWalkthroughNotCreatedError(
      `TROCK Scope walkthrough create was refused before it created anything: ${status} ${JSON.stringify(json)}`
    );
  }
  throw new Error(
    `TROCK Scope walkthrough create failed with ${status}, which does not prove whether a walkthrough was ` +
      `created (a gateway can emit this after the insert committed): ${JSON.stringify(json)}`
  );
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
    // "manual" wall-clock timestamp, and this artifact's capturedAtMs (an absolute epoch-ms timestamp —
    // see the type doc on GlassesWalkthroughArtifactInput.capturedAtMs in glasses-walkthrough-service.ts)
    // is not threaded on to TROCK Scope's API. Left at the default ("upload_order"); TROCK Scope's own
    // worker later derives the real per-clip timeline from the media's embedded exif/container metadata.
  });
  if (status !== 201) {
    throw new Error(`TROCK Scope begin-clip failed for artifact ${artifact.idempotencyKey}: ${status} ${JSON.stringify(json)}`);
  }
  // A 201 is not the same claim as "a usable plan". Every field below is load-bearing arithmetic for the
  // rest of this upload, and each one fails SILENTLY rather than loudly if it is taken on faith:
  //   • partCount absent  → `Array.from({ length: undefined })` is EMPTY, so the part loop runs zero
  //     times and `/complete` goes out with `parts: []` — a finished clip that received no bytes, and a
  //     job that reports success.
  //   • partSize absent   → every byte range is NaN, `expectedBytes <= 0` is false for NaN, and the R2
  //     read is asked for `bytes=NaN-NaN`.
  //   • clipId/uploadId not strings → spliced straight into the clip URL path, where "null" or "7"
  //     addresses some other clip (or nothing) instead of failing here.
  // The plan is TROCK Scope's own output, so this should never fire — which is exactly why it must not be
  // the thing standing between a truncated upload and a green job.
  const { clipId, uploadId, partSize, partCount } = json ?? {};
  if (
    typeof clipId !== "string" ||
    !clipId ||
    typeof uploadId !== "string" ||
    !uploadId ||
    !Number.isInteger(partSize) ||
    partSize <= 0 ||
    !Number.isInteger(partCount) ||
    partCount <= 0
  ) {
    throw new Error(
      `TROCK Scope begin-clip returned an unusable upload plan for artifact ${artifact.idempotencyKey}: ` +
        `${JSON.stringify(json)}`
    );
  }
  // Well-formed is not the same claim as SUFFICIENT, and the difference is the one failure above that
  // still reports success. The checks above reject a plan that is malformed; this one rejects a plan that
  // is merely too small — positive integers, every part signed, every part uploaded, and `/complete`
  // finalizing a multipart assembled from a PREFIX of the object. Nothing downstream can see it: each
  // range below is clamped to the artifact, so every part is exactly the length it claims to be and the
  // per-part length check passes on all of them. The walk forwards "successfully" and its video simply
  // stops partway, which yields a confidently partial scope — the same class of harm as a zero-byte clip,
  // minus the one symptom (a length mismatch) that makes a zero-byte clip catchable.
  //
  // The arithmetic is on the TOTAL — `partSize × partCount ≥ fileSizeBytes` — because coverage is the only
  // thing a per-part rule cannot express:
  //   • `>=`, not `===`: the FINAL part is legitimately short whenever the object is not an exact multiple
  //     of partSize, which is nearly always. Demanding exact arithmetic would reject every normal walk.
  //   • the overshoot direction is a DIFFERENT fault and is deliberately not folded in here: a plan with
  //     enough parts that one BEGINS at or past EOF is caught per-part in `uploadClip`, before that part is
  //     read, and reads as "the plan disagrees about where the object ends" rather than "the plan stops
  //     short of it". Merging them would give a human one message for two opposite corrections.
  //   • S3's 5MiB floor on every non-final part is NOT enforced here even though a plan can violate it. It
  //     is TROCK Scope's PART_SIZE_BYTES (32MiB) that the floor constrains, not this client's reads — and,
  //     decisively, violating it fails LOUDLY: S3 rejects the finalize with EntityTooSmall, the job throws,
  //     the queue retries. Only the uncovered tail fails quietly, and quiet is the whole reason this guard
  //     exists.
  // Thrown, not `deadJob(...)`: TROCK Scope re-derives this plan from the size we declare on every
  // begin-clip, so the next attempt gets a fresh one — this belongs on the retry schedule, not in the
  // permanent lane.
  const plannedBytes = partSize * partCount;
  if (plannedBytes < artifact.fileSizeBytes) {
    throw new Error(
      `TROCK Scope's part plan for clip ${clipId} (artifact ${artifact.idempotencyKey}) covers only ` +
        `${plannedBytes} of the artifact's ${artifact.fileSizeBytes} bytes ` +
        `(${partCount} part${partCount === 1 ? "" : "s"} × ${partSize}), so the last ` +
        `${artifact.fileSizeBytes - plannedBytes} bytes would never be uploaded and completing this clip ` +
        `would finalize a truncated recording.`
    );
  }
  return { clipId, uploadId, partSize, partCount };
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
    // A part this batch asked for and did not get back is NOT visible downstream: the caller uploads the
    // parts it was handed and `/complete` declares the multipart finished from exactly those, so S3
    // assembles a clip missing its middle and the job reports success. Reconciling the response against
    // the REQUEST here names the offending part number while the batch is still in hand — the alternative
    // is a "part N failed" style error minutes and gigabytes later, or no error at all.
    const urlByPartNumber = new Map<number, string>();
    for (const entry of json.parts) {
      if (!entry || typeof entry !== "object") continue;
      const { partNumber, url } = entry as { partNumber?: unknown; url?: unknown };
      if (typeof partNumber === "number" && typeof url === "string" && url) {
        urlByPartNumber.set(partNumber, url);
      }
    }
    const missing = batch.filter((partNumber) => !urlByPartNumber.has(partNumber));
    if (missing.length > 0) {
      throw new Error(
        `TROCK Scope did not sign part${missing.length === 1 ? "" : "s"} ${missing.join(", ")} of clip ` +
          `${clipId} (asked for ${batch.length} part${batch.length === 1 ? "" : "s"} starting at ${batch[0]}).`
      );
    }
    // Pushed in REQUEST order, and only the parts requested: response order is not guaranteed, and an
    // unsolicited extra part number would address a byte range outside the plan we sized the reads from.
    for (const partNumber of batch) {
      signed.push({ partNumber, url: urlByPartNumber.get(partNumber)! });
    }
  }
  return signed;
}

async function completeClip(
  deps: ScopeDeps,
  walkthroughId: string,
  clipId: string,
  parts: Array<{ partNumber: number; etag: string }>
): Promise<{ outcome: "uploaded" | "duplicate_bytes" }> {
  const { status, json } = await scopeRequest(
    deps,
    "POST",
    `/api/walkthroughs/${walkthroughId}/clips/${clipId}/complete`,
    { parts },
    // Its own, much larger budget: this call is where TROCK Scope assembles the multipart object at R2 and
    // checksums it end to end, so its duration tracks the clip's size. The control-plane ceiling would
    // abort a perfectly healthy finalize of a multi-GB video.
    deps.timeouts.completeMs
  );
  if (status === 200) {
    return { outcome: "uploaded" };
  }
  // 409 is ONLY a non-fatal terminal outcome when TROCK Scope reports duplicate_bytes — "the request was
  // understood and refused" because this exact clip's bytes already landed under this walkthrough on a
  // prior attempt of this job (see completeClipUpload's own comment in trock-scope). Any OTHER 409 (a
  // different conflict, a malformed-parts rejection, etc.) is a real failure: falling through to "uploaded"
  // would let the artifact loop move on, the job complete successfully, and the clip silently never land in
  // TROCK Scope with no retry. So every non-duplicate_bytes 409 — and every other status — throws.
  if (status === 409 && json.outcome === "duplicate_bytes") {
    return { outcome: "duplicate_bytes" };
  }
  throw new Error(`TROCK Scope complete-clip failed for clip ${clipId}: ${status} ${JSON.stringify(json)}`);
}

async function uploadClip(
  deps: ScopeDeps,
  walkthroughId: string,
  artifact: JobArtifact,
  downloadRange: (r2Key: string, start: number, end: number, timeoutMs: number) => Promise<Buffer>
): Promise<void> {
  const begin = await beginClip(deps, walkthroughId, artifact);
  const partNumbers = Array.from({ length: begin.partCount }, (_, index) => index + 1);
  const signedParts = await signParts(deps, walkthroughId, begin.clipId, partNumbers);

  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  for (const part of signedParts) {
    const startByte = (part.partNumber - 1) * begin.partSize;
    const endByte = Math.min(startByte + begin.partSize, artifact.fileSizeBytes) - 1;
    const expectedBytes = endByte - startByte + 1;
    // TROCK Scope computes partCount/partSize from the size WE declared, so a plan whose part begins at or
    // past EOF is a disagreement about the object, not a rounding detail. Checked before the read because
    // an empty range that "matches" an empty answer is the one way a zero-byte part would still satisfy
    // the length comparison below. Only the OVERSHOOT is visible from in here — the opposite disagreement,
    // a plan whose parts stop short of the object, produces nothing but well-formed full-length parts and
    // is therefore checked against the total in `beginClip` before any of this runs.
    if (expectedBytes <= 0) {
      throw new Error(
        `TROCK Scope's part plan for clip ${begin.clipId} (artifact ${artifact.idempotencyKey}) puts part ` +
          `${part.partNumber} outside the ${artifact.fileSizeBytes}-byte object (bytes ${startByte}-${endByte}).`
      );
    }
    // Ranged read of OUR OWN R2 object, one part at a time — bounds memory to one part (32MiB, TROCK
    // Scope's PART_SIZE_BYTES) regardless of how large the whole clip is, instead of buffering an
    // entire multi-GB video in the worker's process. Bounded in TIME as well as memory, and by the same
    // deadline the PUT below gets: this leg holds the dedicated poller's guard exactly as hard.
    const chunk = await downloadRange(artifact.r2Key, startByte, endByte, deps.timeouts.sourceReadMs);
    // Never PUT bytes we did not fully read. `downloadRange` is an injection seam and its production
    // default is a network read, so a short answer is possible from either side — and NOTHING downstream
    // can see it: the presigned part PUT below accepts zero bytes, answers 200 and returns an ETag, and
    // S3 multipart accepts an undersized FINAL part. A one-part clip would therefore complete as a
    // zero-byte recording and this job would report SUCCESS, which is worse than failing — the walk looks
    // filed, nothing retries, nothing alerts, and TROCK Scope bills a transcription of silence. A
    // multipart clip fares no better: every attempt re-uploads invalid parts until the retry budget is
    // gone. The byte count is the only place the two outcomes are still distinguishable.
    if (chunk.length !== expectedBytes) {
      throw new Error(
        `Refusing to upload part ${part.partNumber} of clip ${begin.clipId} (artifact ` +
          `${artifact.idempotencyKey}): read ${chunk.length} bytes for the ${expectedBytes}-byte range ` +
          `${startByte}-${endByte} of ${artifact.r2Key}.`
      );
    }
    // A known TS 5.7+ / @types/node friction point: `BodyInit` wants an `ArrayBufferView<ArrayBuffer>`,
    // and both `Buffer` and a fresh `Uint8Array` are typed `<ArrayBufferLike>` here, so neither satisfies
    // it structurally even though a Buffer is exactly what Node's fetch accepts (and sends) at runtime.
    // The cast is a type-level workaround only; no behavioral change.
    // Bounded like every TROCK Scope call, and for the same reason — this is the longest-lived request of
    // the whole forward and the likeliest to stall, and a hang here holds the dedicated poller's guard
    // just as effectively. The URL is presigned, so it is deliberately NOT in the error text: it embeds a
    // signature and carries no useful information a part number does not.
    const putSignal = AbortSignal.timeout(deps.timeouts.partPutMs);
    let putResponse: Response;
    try {
      putResponse = await deps.fetchImpl(part.url, {
        method: "PUT",
        body: chunk as unknown as BodyInit,
        signal: putSignal,
      });
    } catch (err) {
      if (putSignal.aborted) {
        throw new ScopeRequestTimeoutError(
          `R2 did not answer within ${deps.timeouts.partPutMs}ms for part ${part.partNumber} of clip ` +
            `${begin.clipId} (artifact ${artifact.idempotencyKey}), so the upload was abandoned.`
        );
      }
      throw err;
    }
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

/**
 * Phase 1 of the create checkpoint: record the INTENT to create, before the request goes out. Its failure
 * is a hard failure of the whole handler on purpose — if this write cannot land, the create must not
 * happen, because an unrecorded create is precisely the state this whole mechanism exists to prevent.
 * Losing an attempt is recoverable (the queue retries); an untracked remote walkthrough is not.
 *
 * "Cannot land" includes the quiet case: an UPDATE that matches zero rows SUCCEEDS. If the row this
 * payload was delivered from no longer answers to the key below — hand-edited during a reconciliation,
 * cleaned up, or delivered from anywhere but that row — the write returns without error and the marker
 * exists nowhere, so the create would go out with the entire duplicate-prevention scheme silently
 * disarmed. RETURNING turns that into the same hard failure as a broken connection.
 *
 * KEYED ON (walkId, dealId), never walkId alone. walkId is minted on the PHONE and nothing makes it
 * unique across deals — the ingress side already had to be corrected for exactly this
 * (findGlassesWalkthroughForwardJobState, and migration 0211's index on the pair). Keyed on walkId only,
 * the same walk completed against two deals makes all three statements below hit BOTH job rows: the
 * checkpoint hands deal B deal A's remote walkthrough id, so B's clips upload into A's walkthrough and
 * the scope comes back attached to the wrong job; the marker writes make B dead-letter over a create it
 * never sent, or clear B's marker under it and reopen the duplicate window.
 */
async function markScopeCreatePending(
  db: Queryable,
  walkId: string,
  dealId: string,
  externalRef: string
): Promise<void> {
  const result = await db.query(
    `UPDATE public.job_queue
        SET payload = jsonb_set(payload, '{scopeCreatePendingRef}', to_jsonb($1::text), true)
      WHERE job_type = $2
        AND payload ->> 'walkId' = $3
        AND payload ->> 'dealId' = $4
        AND status = 'processing'
      RETURNING id`,
    [externalRef, GLASSES_WALKTHROUGH_FORWARD_JOB, walkId, dealId]
  );
  if (!result?.rows?.length) {
    throw new Error(
      `Refusing to create a TROCK Scope walkthrough for walk ${walkId} on deal ${dealId}: the pending-create ` +
        `marker UPDATE matched no job_queue row (job_type = ${GLASSES_WALKTHROUGH_FORWARD_JOB}), so the create ` +
        `could not be recorded anywhere and a crash after it would be indistinguishable from one that never ran.`
    );
  }
}

/** Retract the intent marker once we have positive evidence no remote walkthrough was created, putting the
 *  row back in its "nothing has happened remotely yet" state so the queue's ordinary backoff applies. */
async function clearScopeCreatePending(db: Queryable, walkId: string, dealId: string): Promise<void> {
  await db.query(
    `UPDATE public.job_queue
        SET payload = payload - 'scopeCreatePendingRef'
      WHERE job_type = $1
        AND payload ->> 'walkId' = $2
        AND payload ->> 'dealId' = $3
        AND status = 'processing'`,
    [GLASSES_WALKTHROUGH_FORWARD_JOB, walkId, dealId]
  );
}

/** Phase 2: the id lands and the intent marker is dropped in the SAME statement. Two statements would
 *  leave a window in which the payload carries both, and a reader — the next attempt, or a human reading
 *  the row after a dead letter — could not tell a settled create from an unresolved one. */
async function checkpointScopeWalkthroughId(
  db: Queryable,
  walkId: string,
  dealId: string,
  scopeWalkthroughId: string
): Promise<void> {
  await db.query(
    `UPDATE public.job_queue
        SET payload = jsonb_set(payload, '{scopeWalkthroughId}', to_jsonb($1::text), true) - 'scopeCreatePendingRef'
      WHERE job_type = $2
        AND payload ->> 'walkId' = $3
        AND payload ->> 'dealId' = $4
        AND status = 'processing'`,
    [scopeWalkthroughId, GLASSES_WALKTHROUGH_FORWARD_JOB, walkId, dealId]
  );
}

/**
 * The dead letter for an unresolvable create. It is read by a human — via `last_error` and the alert email
 * built below — so it states what is unknown, why the job refuses to guess, and the two concrete moves that
 * resolve it either way.
 *
 * `externalRef` is the marker's STORED value, passed in by the caller, never re-derived here. That is the
 * whole point of the marker being a value rather than a flag: it is the ref that actually went out on the
 * wire, so it is the ref TROCK Scope stored if the create landed. Re-deriving would print today's shape for
 * a create sent under yesterday's and send the reader looking for a row that was never written that way.
 *
 * NOT resolved automatically, though it now could be. TROCK Scope deduplicates on this ref, so re-sending
 * the create would answer with the existing walkthrough if one landed and insert if none did — no
 * duplicate either way. It is left as a dead letter because that automation is a behaviour change with its
 * own failure modes (it must re-send the STORED ref, never a fresh one, and it silently un-does the one
 * place this seam deliberately stops and asks a human), and it belongs in a change of its own. What the
 * ref's new durability buys today is the instruction below: a lookup, not a hunt by deal and title.
 *
 * TOKEN SAFETY: built entirely from the job's own payload; it never reads TROCK_SCOPE_SERVICE_TOKEN, which
 * is what guarantees it cannot leak it.
 */
function buildUnconfirmedCreateDeadLetterMessage(payload: JobPayload, externalRef: string): string {
  return (
    `A TROCK Scope walkthrough create was already sent for walk ${payload.walkId} (external ref ` +
    `${externalRef}) and this job never learned whether it succeeded — the worker died, or its checkpoint ` +
    `write failed, inside that window. Retrying blind is what this job refuses to do on its own: it cannot ` +
    `tell "it was created" from "it was not", and the wrong guess is a SECOND walkthrough plus a second ` +
    `(billed) transcription and scope extraction. It stopped instead. TO RESOLVE: TROCK Scope stores that ` +
    `external ref on the walkthrough, so look for one carrying it (it belongs to deal ${payload.dealId}, ` +
    `titled "${payload.title}"). If one exists, set this job_queue row's payload.scopeWalkthroughId to its ` +
    `id; if none exists, remove payload.scopeCreatePendingRef. Then set status = 'pending' — the forward ` +
    `resumes safely either way (TROCK Scope's own checksum constraint already rejects duplicate clip ` +
    `bytes). The walk itself is durably filed in the project folder and the crew can already see it.`
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
    downloadRange?: (r2Key: string, start: number, end: number, timeoutMs: number) => Promise<Buffer>;
    /** Injection seam for the request ceilings, so a test can exercise the abort path in milliseconds
     *  rather than waiting out a production-sized budget. The queue never passes it. */
    timeouts?: Partial<ScopeTimeouts>;
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

  const scopeDeps: ScopeDeps = {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
    fetchImpl,
    timeouts: { ...DEFAULT_SCOPE_TIMEOUTS, ...deps.timeouts },
  };
  const downloadRange = deps.downloadRange ?? getObjectRangeBuffer;

  let scopeWalkthroughId = p.scopeWalkthroughId;
  if (!scopeWalkthroughId) {
    if (p.scopeCreatePendingRef) {
      // An earlier attempt sent a create and never recorded the answer. There is nothing to query and
      // nothing to infer, so this is where the design deliberately stops being automatic: dead-letter with
      // instructions rather than roll the dice. Immediate (not after burning the remaining attempts) —
      // another attempt cannot produce information this one lacks, and the alert sweep below turns the
      // dead row into a one-time email a human can act on.
      return deadJob(buildUnconfirmedCreateDeadLetterMessage(p, p.scopeCreatePendingRef));
    }

    const externalRef = deriveScopeWalkthroughExternalRef(p.walkId, p.dealId);
    // Intent BEFORE action. Everything after this line is covered: if the process dies at ANY point up to
    // the checkpoint below, the redelivered payload carries the marker and the branch above takes over.
    await markScopeCreatePending(db, p.walkId, p.dealId, externalRef);

    let created: { id: string };
    try {
      created = await createScopeWalkthrough(scopeDeps, p, externalRef);
    } catch (err) {
      if (err instanceof ScopeWalkthroughNotCreatedError) {
        // Proven not created ⇒ retract the marker so the queue's normal backoff applies instead of a dead
        // letter. Best-effort by necessity: if THIS write also fails the marker survives, and the next
        // attempt dead-letters on a create that never happened. That is the fail-CLOSED direction — a
        // spurious dead letter costs a human one minute; a missed one costs a duplicate scope extraction.
        await clearScopeCreatePending(db, p.walkId, p.dealId).catch((clearErr) => {
          console.warn(
            `[Worker:glasses_walkthrough_forward] Could not retract the pending-create marker for walk ${p.walkId}; ` +
              `the next attempt will dead-letter for manual reconciliation`,
            clearErr
          );
        });
      }
      throw err;
    }

    scopeWalkthroughId = created.id;
    await checkpointScopeWalkthroughId(db, p.walkId, p.dealId, scopeWalkthroughId);
  }

  for (const artifact of p.artifacts) {
    await uploadClip(scopeDeps, scopeWalkthroughId, artifact, downloadRange);
  }

  // The delivery has stopped. THIS is the only moment at which the row can safely be taken out of the
  // live unique index, and it is why the API no longer does it for a claimed row: marking a `processing`
  // row dead does not cancel this loop, it just lets a replacement be inserted alongside it.
  //
  // A completion that arrived mid-flight carrying artifacts this attempt was never given records them as
  // `pendingArtifacts` and changes nothing else (recordPendingArtifactsOnRunningForwardJob in
  // server/src/modules/walkthrough-capture/glasses-walkthrough-service.ts). Reading it back here turns
  // that into the supersede it always wanted to be, taken after the race it would have caused is over.
  const reconciliation = await supersedeSelfForPendingArtifacts(db, p.walkId, p.dealId);
  if (reconciliation) return deadJob(reconciliation);
}

/**
 * Fold `pendingArtifacts` into `artifacts` on this handler's own row and report that it happened, or null
 * when there is nothing to reconcile (overwhelmingly the common case — one SELECT-shaped UPDATE per
 * successful forward).
 *
 * Scoped to `status = 'processing'`, which is what makes it THIS handler's row: 0213's live partial unique
 * index permits at most one live forward per (walkId, dealId), and a replacement inserted by any other
 * path arrives `pending`. The same predicate guards the three checkpoint writes above, for the same
 * reason — before it, a handler whose row had been killed under it would write its checkpoints into
 * whatever row had taken its place.
 *
 * The union keeps existing entries verbatim and appends only genuinely new ones, matching the in-place
 * amend in the service exactly; the artifacts an operator sees on the dead row are therefore the complete
 * walk, and their job is `status = 'pending'` rather than reassembling a list by hand. `pendingArtifacts`
 * is dropped in the same statement so a reader cannot mistake a settled reconciliation for an open one.
 */
async function supersedeSelfForPendingArtifacts(
  db: Queryable,
  walkId: string,
  dealId: string
): Promise<string | null> {
  const result = await db.query(
    `UPDATE public.job_queue
        SET payload = jsonb_set(
              payload,
              '{artifacts}',
              (
                SELECT COALESCE(jsonb_agg(d.elem ORDER BY d.ord), '[]'::jsonb)
                FROM (
                  SELECT DISTINCT ON (t.elem ->> 'idempotencyKey') t.elem, t.ord
                  FROM jsonb_array_elements(
                    COALESCE(payload -> 'artifacts', '[]'::jsonb) || COALESCE(payload -> 'pendingArtifacts', '[]'::jsonb)
                  ) WITH ORDINALITY AS t(elem, ord)
                  ORDER BY t.elem ->> 'idempotencyKey', t.ord
                ) d
              ),
              true
            ) - 'pendingArtifacts'
      WHERE job_type = $1
        AND payload ->> 'walkId' = $2
        AND payload ->> 'dealId' = $3
        AND status = 'processing'
        AND payload ? 'pendingArtifacts'
      RETURNING jsonb_array_length(COALESCE(payload -> 'artifacts', '[]'::jsonb)) AS artifact_count`,
    [GLASSES_WALKTHROUGH_FORWARD_JOB, walkId, dealId]
  );
  if (!result?.rows?.length) return null;
  return buildPendingArtifactsDeadLetterMessage(walkId, dealId, Number(result.rows[0]?.artifact_count ?? 0));
}

/** The alert an operator receives when a walk grew while it was being forwarded. Same shape as the other
 *  dead letters here: what happened, why it stopped rather than guessing, and the one action that fixes
 *  it. */
function buildPendingArtifactsDeadLetterMessage(walkId: string, dealId: string, artifactCount: number): string {
  return (
    `Walk ${walkId} (deal ${dealId}) was forwarded to TROCK Scope, and then MORE artifacts were filed for ` +
    `the same walk while that forward was already running — a completion retry carrying files the running ` +
    `attempt had never been given. The clips this attempt delivered did reach TROCK Scope; the later ones ` +
    `did not, because a handler reads its artifact list once, when it claims the row, and no write can ` +
    `reach that snapshot. The row's payload now carries the COMPLETE list (${artifactCount} artifacts), ` +
    `so no reassembly is needed: set this row's status back to 'pending' to forward the whole walk again. ` +
    `TROCK Scope's own checksum constraint rejects clip bytes that already landed, so re-running is safe ` +
    `and will not duplicate the scope extraction.`
  );
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
 *  A schema-name that fails the safety check or a deleted deal both fall back to null (the caller renders
 *  "Deal <dealId>" instead); a query error propagates to the caller, which treats it the same way.
 *
 *  The `Queryable` it is handed must NOT be the sweep's transactional client: a failure on that connection
 *  would abort the row's open transaction, since Postgres marks a transaction unusable after ANY statement
 *  error inside it. The sweep passes a one-shot timed checkout instead (timedEnrichmentQueryable), which
 *  also gives the statement a deadline and a connection that gets destroyed if it blows through it. */
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
  // The REAL attempt, not a hardcoded 1. Stopping before the budget is spent does not imply stopping on
  // the first delivery: an unconfirmed-create dead letter (see buildUnconfirmedCreateDeadLetterMessage)
  // lands here on whatever attempt first read the marker back, and the config-error paths land here on
  // the first attempt AFTER a redeploy changed the environment. Printing "attempt 1" told the reader the
  // one thing that made those two impossible to tell apart from job_queue's own numbers.
  const attemptsText = immediateFailure
    ? `Failed immediately, without retrying (attempt ${input.attempts} of ${input.maxAttempts}) — this is ` +
      `almost always a deploy-config problem (TROCK Scope's URL or service token), not a transient outage.`
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
    `rejects duplicate clip bytes), so retrying will not create duplicate scope data or duplicate uploads. ` +
    `If the error above says a create outcome was never confirmed, do the one-time reconciliation step it ` +
    `spells out FIRST: that job stopped on purpose to avoid a duplicate walkthrough, and a bare status ` +
    `reset will simply — and correctly — stop again.`;

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
 * Wall-clock ceiling on the two network waits the sweep below performs while its per-row transaction is
 * OPEN — the alert send, and the best-effort deal-label lookup.
 *
 * Neither can be cancelled, but they are NOT the same problem, and the difference decides what "bounding"
 * has to mean for each:
 *
 *  • The SEND holds the transaction's client only for as long as the sweep is between BEGIN and COMMIT.
 *    Abandoning the wait unwinds to the per-row catch, which ROLLBACKs, breaks, and releases that client —
 *    so the scarce resource (a pool slot out of ten, plus this dead row's lock) really is freed on time.
 *    What keeps running is an HTTP request nobody is reading, and there is no way to stop it: resend 6.18.0
 *    takes no AbortSignal (`PostOptions` is `{ query, headers }`) and no fetch override (`ResendOptions` is
 *    `{ baseUrl, userAgent }`). It is bounded instead by undici's own header/body timeouts, and by the
 *    sweep's `break` — at most one orphan per 60-second tick, not one per row.
 *  • The deal-label LOOKUP is the case a raced deadline cannot fix, because the thing it pins is a pool
 *    connection pg checked out for the statement and will not give back until the statement settles. On the
 *    failure this ceiling exists for — a `deals` read blocked on a lock, socket perfectly healthy, so
 *    keepalive never evicts it — that is never. A deadline over a top-level `db.query` there changes who is
 *    waiting, not what is held; the slot stays gone, and the 60-second interval strands another next tick.
 *    So that read goes through `timedPoolClientQuery` (lib/timed-pool-query.ts), which owns an explicit
 *    client and DESTROYS it on timeout. This constant supplies its deadline; it does not supply its safety.
 *
 * This sweep is driven by a bare setInterval with NO reentrancy guard (index.ts), which is why "one stuck
 * connection" is the wrong unit for either of them: untreated, it is one more every 60 seconds until the
 * pool (max 10, db.ts) is gone and every unrelated worker job stops with it. An alert about a lost site
 * visit taking the queue down with it is worse than the silence it was written to end.
 *
 * Deliberately generous, like ScopeTimeouts above: it exists to bound a hang, not to police latency.
 */
const DEAD_LETTER_ALERT_STEP_TIMEOUT_MS = 30_000;

/** A step we stopped WAITING for — never a step that failed. The distinction is what the sweep acts on:
 *  a send that timed out says the provider is answering nobody, so the remaining dead rows would each pay
 *  the same ceiling to learn the same thing, on one shared connection. */
class DeadLetterAlertStepTimeout extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not answer within ${timeoutMs}ms — abandoned so the claim transaction could close`);
    this.name = "DeadLetterAlertStepTimeout";
  }
}

/** Race `work` against a deadline. The loser keeps running (nothing here is cancellable) — it is simply no
 *  longer between us and the COMMIT. `Promise.race` subscribes to both, so a late rejection from the
 *  abandoned side is still handled and can't surface as an unhandled rejection.
 *
 *  Correct ONLY where abandoning the wait actually frees what the wait was holding — i.e. the send, whose
 *  pooled client belongs to this function and is released as the throw unwinds. Do not reach for it to bound
 *  a query: a query's connection belongs to pg, and pg keeps it until the statement settles. */
function withAlertStepDeadline<T>(work: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadLetterAlertStepTimeout(label, timeoutMs)), timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** A one-shot `Queryable` whose single statement rides its own checked-out client, bounded by `timeoutMs`
 *  and DESTROYED if the clock wins. Handed to resolveGlassesWalkthroughDealLabel so the ceiling lives with
 *  the statement rather than around the call — the enrichment stays a plain function taking a Queryable, and
 *  every other caller (unit tests, the fake db) is unaffected. */
function timedEnrichmentQueryable(db: PoolLike, label: string, timeoutMs: number): Queryable {
  return {
    query: (sql, params) =>
      timedPoolClientQuery<{ rows: any[] }>(db as unknown as TimedPoolLike, sql, params as any[] | undefined, {
        timeoutMs,
        timeoutError: () => new DeadLetterAlertStepTimeout(label, timeoutMs),
      }),
  };
}

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
    /** Injection seam for the two in-transaction ceilings, so a stalled provider can be exercised in
     *  milliseconds instead of waiting out DEAD_LETTER_ALERT_STEP_TIMEOUT_MS. */
    stepTimeoutMs?: number;
  } = {}
): Promise<number> {
  const db = deps.db ?? (pool as unknown as PoolLike);
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? console;
  const limit = deps.limit ?? 25;
  const stepTimeoutMs = deps.stepTimeoutMs ?? DEAD_LETTER_ALERT_STEP_TIMEOUT_MS;
  const sendEmail = deps.sendEmail ?? sendSystemEmailWithMetadata;
  // Fail fast rather than degrade. The per-row work below is a transaction (BEGIN / claim UPDATE / send /
  // COMMIT-or-ROLLBACK) whose entire safety argument — a throw anywhere rolls the 'claimed' marker back
  // with it, so no row is ever stranded mid-claim — holds only if all four statements ride ONE connection.
  // The old `db.connect ? … : db` fallback ran them through the pool's convenience `query`, which is free
  // to pick a different connection per statement: the BEGIN opens a transaction on a connection nothing
  // else touches, the COMMIT/ROLLBACK lands somewhere else entirely, and the claim is neither atomic with
  // the send nor undone by its failure. An adapter that cannot check out a connection cannot run this
  // sweep at all, and saying so beats silently running it wrong.
  if (typeof db.connect !== "function") {
    throw new Error(
      "runGlassesWalkthroughForwardDeadLetterSweep needs a pool that can check out a single connection " +
        "(db.connect): its per-row claim and send are one transaction, which arbitrary pooled connections cannot honour."
    );
  }
  const client = await db.connect();
  let handled = 0;
  // Set once a deal-label lookup hits its ceiling, and never unset for the rest of this sweep. The read is
  // pure enrichment, so ONE row paying the ceiling is a reasonable price for a nicer email; twenty-five of
  // them is twelve minutes of the alert backlog waiting, and twenty-five connections opened only to be
  // destroyed, since an office schema that would not answer for the first row will not answer for the
  // twenty-fifth. Cost control, not safety — the destroy in timedPoolClientQuery is what keeps an abandoned
  // read from costing a pool slot, so a sweep that ignored this flag would be wasteful, not dangerous.
  // Unlike a send timeout this does not stop the sweep — every alert still goes out, by raw deal id.
  let dealLabelLookupAbandoned = false;

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

        // Best-effort deal label enrichment on its OWN checked-out connection, never the per-row `client` —
        // see the function doc for why this must run outside the transaction.
        //
        // Bounded AND destroyable, which are two different guarantees and only the second one was ever the
        // point. A read issued while THIS row's transaction is open holds the claim as long as a stalled
        // send would, so it needs a ceiling; but a ceiling raced against `db.query` would hand the wait back
        // and leave pg holding the connection for a statement nobody will ever read — the leak, relabelled.
        // timedEnrichmentQueryable owns the client and release(err)s it, so the abandoned slot is discarded
        // rather than stranded, and `dealLabelLookupAbandoned` below is a courtesy (don't re-pay 25 ceilings
        // for the same answer) instead of the only thing standing between us and an exhausted pool.
        //
        // The checkout itself is a bounded wait: an exhausted pool rejects the acquire after
        // connectionTimeoutMillis (db.ts) rather than queueing, and that rejection lands in the same catch.
        // Hitting either is treated like any other enrichment failure — it degrades the EMAIL (raw id
        // instead of a label), never the alert. An ops address that never hears about a lost site visit is
        // the failure this whole sweep exists to prevent.
        let dealLabel: string | null = null;
        if (dealId && officeSlug && !dealLabelLookupAbandoned) {
          try {
            dealLabel = await resolveGlassesWalkthroughDealLabel(
              timedEnrichmentQueryable(db, `deal-label lookup for job ${job.id}`, stepTimeoutMs),
              officeSlug,
              dealId
            );
          } catch (err) {
            if (err instanceof DeadLetterAlertStepTimeout) dealLabelLookupAbandoned = true;
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

        // THE unbounded await this transaction used to be built around. Resend's SDK awaits a plain fetch
        // with no deadline and takes no signal, so a provider that accepts the connection and then goes
        // quiet held this BEGIN open — and its pooled client, and this row's lock — for the life of the
        // process. Abandoning the wait is a throw like any other here: the per-row catch ROLLBACKs, so the
        // claim goes back with it and the row stays retryable rather than stranding at 'claimed'.
        //
        // The abandoned request may still land. That is what the stable per-job idempotency key below is
        // for: a re-send on a later tick is deduped provider-side, so at-least-once here is not two alerts.
        const sendResult = await withAlertStepDeadline(
          sendEmail(recipients, email.subject, email.html, {
            text: email.text,
            // Stable per-job key: an at-least-once re-send after an uncertain marker write dedupes provider-
            // side, mirroring the bid-board heartbeat's dead-letter batch key.
            idempotencyKey: `glasses-walkthrough-forward-dead-${job.id}`,
          }),
          `dead-letter alert send for job ${job.id}`,
          stepTimeoutMs
        );
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
        if (err instanceof DeadLetterAlertStepTimeout) {
          // Stop the SWEEP, not just this row. A step that hit the ceiling means the far end is answering
          // nobody, so every remaining candidate would spend the same ceiling to learn the same thing —
          // and this loop holds ONE checked-out connection for the sum of them (25 rows x 30s = twelve
          // minutes on a connection, while the interval that started us fires another sweep every 60s
          // regardless). Nothing is lost by stopping: the rows are untouched, still 'dead', still
          // unclaimed, and the next tick picks them up from the top.
          logger.warn(
            "[Worker:glasses_walkthrough_forward] Abandoning this sweep after a step timed out; the remaining " +
              "dead jobs stay unclaimed and are retried on the next tick"
          );
          break;
        }
      }
    }

    return handled;
  } finally {
    client.release();
  }
}
