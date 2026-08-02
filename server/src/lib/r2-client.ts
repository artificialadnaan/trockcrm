import {
  S3Client,
  PutObjectCommand,
  PutBucketCorsCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRESIGNED_URL_EXPIRY_SECONDS } from "../modules/files/file-constants.js";

let _client: S3Client | null = null;

const LEGACY_R2_CORS_ALLOWED_ORIGINS = [
  "https://frontend-production-bcab.up.railway.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

function normalizeOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

function getR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME || "trock-crm-files";

  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

/**
 * Check if R2 is configured. Returns false in dev mode when env vars are missing.
 */
export function isR2Configured(): boolean {
  const { accountId, accessKeyId, secretAccessKey } = getR2Config();
  return !!(accountId && accessKeyId && secretAccessKey);
}

/**
 * Get the singleton S3 client for R2.
 * Throws if R2 env vars are not configured.
 */
function getClient(): S3Client {
  if (_client) return _client;

  const { accountId, accessKeyId, secretAccessKey } = getR2Config();

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY."
    );
  }

  _client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return _client;
}

function getBucket(): string {
  return getR2Config().bucketName;
}

export function getAllowedR2CorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.R2_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const fieldOrigins = [
    normalizeOrigin(env.FIELD_APP_URL),
    normalizeOrigin(env.RAILWAY_SERVICE_TROCKCRM_FIELD_URL),
  ].filter((origin): origin is string => Boolean(origin));

  if (configured?.length) {
    return Array.from(new Set([...fieldOrigins, ...configured]));
  }

  const frontendUrl = env.FRONTEND_URL?.trim();
  return Array.from(new Set([
    ...fieldOrigins,
    ...(frontendUrl ? [frontendUrl] : []),
    ...LEGACY_R2_CORS_ALLOWED_ORIGINS,
  ]));
}

/**
 * Generate a presigned PUT URL for direct browser upload to R2.
 *
 * @param r2Key   - Full object key (e.g. "office_dallas/deals/TR-2026-0142/photos/file.jpg")
 * @param mimeType - Content-Type for the upload
 * @param _maxSizeBytes - Maximum allowed file size (validated server-side, not signed)
 * @param expiresInSeconds - How long the signature stays usable. Defaults to PRESIGNED_URL_EXPIRY_SECONDS,
 *   which is what every caller that omits it keeps getting — this parameter is purely additive and changes
 *   no existing call site's behavior.
 *
 *   Worth overriding when the URL is a WRITE capability whose destination becomes immutable later. This
 *   function hands out a signature, and a signature cannot be recalled: any database rule that decides
 *   "these bytes are now frozen" is evaluated HERE, at mint time, and stops binding the moment the URL is
 *   in someone's hands. So for those callers the expiry is not a convenience setting, it is the width of
 *   the window in which the freeze can still be undone. See GLASSES_WALKTHROUGH_PRESIGN_EXPIRY_SECONDS
 *   (walkthrough-capture/glasses-walkthrough-service.ts) for the worked example.
 *
 *   The 30-minute default is sized for a BROWSER upload — a human picking a file out of a dialog after the
 *   URL was fetched. It is not sized for the transfer itself: R2 checks expiry when the PUT is
 *   authenticated, not when its body finishes, so a shorter value bounds how long a client may WAIT before
 *   starting, never how long it may take to upload. (Nothing here could bound the latter anyway — a 2 GiB
 *   artifact over a field LTE link already runs well past 30 minutes under the current default.)
 * @returns Presigned URL valid for `expiresInSeconds`
 */
export async function generateUploadUrl(
  r2Key: string,
  mimeType: string,
  _maxSizeBytes: number,
  expiresInSeconds: number = PRESIGNED_URL_EXPIRY_SECONDS
): Promise<{ uploadUrl: string; r2Key: string; expiresIn: number }> {
  const client = getClient();
  const bucket = getBucket();

  // NOTE: Do NOT include ContentLength in the presigned PutObjectCommand.
  // Browsers cannot set the Content-Length header on XHR/fetch uploads —
  // the browser calculates it automatically. Including it in the signed
  // headers causes a SignatureDoesNotMatch error.
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: r2Key,
    ContentType: mimeType,
  });

  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: expiresInSeconds,
  });

  // Echo back the value actually SIGNED, never the module default — a caller that asked for a short-lived
  // capability and was told 1800 would compute its own deadline from a number the signature disagrees with.
  return {
    uploadUrl,
    r2Key,
    expiresIn: expiresInSeconds,
  };
}

/**
 * Build a safe Content-Disposition header for a presigned GET.
 * Emits BOTH an ASCII `filename=` fallback (control chars stripped, quotes/backslash/non-ASCII → "_",
 * matching public-photo-tokens' sanitizeFilename) AND an RFC 5987 `filename*=UTF-8''<pct-encoded>` for
 * modern clients. Prevents header injection / breakage from real filenames now flowing through
 * files.displayName.
 */
export function buildContentDisposition(
  disposition: "attachment" | "inline",
  filename: string,
): string {
  const stripped = filename.replace(/[\x00-\x1f\x7f]/g, "");
  const asciiFallback = stripped
    .replace(/["\\]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim() || "download";
  const encoded = encodeURIComponent(stripped).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  // Only emit filename* when there is a usable name. For a blank/whitespace-only stripped value it would be
  // empty and, since clients PREFER filename* over filename, they'd get a blank name — fall back to the
  // ASCII "download" instead.
  const filenameStar = stripped.trim().length > 0 ? `; filename*=UTF-8''${encoded}` : "";
  return `${disposition}; filename="${asciiFallback}"${filenameStar}`;
}

/**
 * Generate a presigned GET URL for file download / preview.
 *
 * @param r2Key - Full object key
 * @param expiresIn - URL validity in seconds (default 1 hour)
 * @param filename - Optional Content-Disposition filename for download
 * @returns Presigned download URL
 */
export async function generateDownloadUrl(
  r2Key: string,
  expiresIn: number = 3600,
  filename?: string,
  disposition: "inline" | "attachment" = "attachment"
): Promise<string> {
  const client = getClient();
  const bucket = getBucket();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: r2Key,
    ...(filename
      ? { ResponseContentDisposition: buildContentDisposition(disposition, filename) }
      : {}),
  });

  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Check if an object exists in R2.
 */
export async function objectExists(r2Key: string): Promise<boolean> {
  const client = getClient();
  const bucket = getBucket();

  try {
    await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: r2Key })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * HEAD an R2 object and return its metadata.
 * Used by confirmUpload() to verify the object was actually written to R2
 * and that Content-Type / Content-Length match the declared values.
 */
export async function headObject(
  r2Key: string
): Promise<{ contentType?: string; contentLength?: number } | null> {
  try {
    return await headObjectStrict(r2Key);
  } catch {
    // Backward-compatible best-effort HEAD used by existing callers.
    return null;
  }
}

export function isR2ObjectNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.$metadata?.httpStatusCode === 404 || value.name === "NotFound" || value.name === "NoSuchKey";
}

/**
 * HEAD that distinguishes a genuinely absent object from an R2/network/auth failure. Repair paths use this
 * so a storage outage returns a retryable error instead of launching an expensive regeneration stampede.
 */
export async function headObjectStrict(
  r2Key: string
): Promise<{ contentType?: string; contentLength?: number } | null> {
  const client = getClient();
  const bucket = getBucket();

  try {
    const resp = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: r2Key })
    );
    return {
      contentType: resp.ContentType,
      contentLength: resp.ContentLength,
    };
  } catch (error) {
    if (isR2ObjectNotFoundError(error)) return null;
    throw error;
  }
}

// Thrown by getObjectBuffer when an object exceeds the caller's maxBytes — distinct from a real R2
// failure so callers can map it (e.g. 422) without masking storage/network outages (which propagate).
export class ObjectTooLargeError extends Error {
  constructor(public readonly r2Key: string, public readonly limit: number) {
    super(`R2 object ${r2Key} exceeds ${limit} bytes`);
    this.name = "ObjectTooLargeError";
  }
}

export async function getObjectBuffer(
  r2Key: string,
  opts?: { maxBytes?: number; signal?: AbortSignal }
): Promise<{ buffer: Buffer; contentType?: string; contentLength?: number }> {
  const client = getClient();
  const bucket = getBucket();
  // The signal reaches BOTH halves of the read. Passing it only to send() bounds the request but not the
  // body: R2 can return headers promptly and then stall mid-stream, which is the shape that hangs a caller
  // indefinitely. The chunk loop below re-checks it, and the stream is destroyed rather than left open.
  const resp = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: r2Key }),
    opts?.signal ? { abortSignal: opts.signal } : undefined
  );
  const max = opts?.maxBytes;
  const stream = resp.Body as (AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void }) | undefined;
  if (!stream) throw new Error(`R2 object ${r2Key} has no body`);
  // Reject before reading the body when the server-reported size already exceeds the cap. GET returns
  // Content-Length even where a separate HEAD is unavailable, so this guard holds without one. Destroy
  // the live response stream first — leaving an unread body open can exhaust sockets on repeat hits.
  if (max != null && resp.ContentLength != null && resp.ContentLength > max) {
    stream.destroy?.();
    throw new ObjectTooLargeError(r2Key, max);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    // Checked per chunk, so a body that stalls or trickles is bounded by the caller's deadline rather than
    // running until the socket happens to time out.
    if (opts?.signal?.aborted) {
      stream.destroy?.();
      throw new Error(`R2 read of ${r2Key} was aborted`);
    }
    total += chunk.byteLength;
    // Abort BEFORE accumulating past the cap, defending against an absent/under-reported Content-Length.
    if (max != null && total > max) {
      stream.destroy?.();
      throw new ObjectTooLargeError(r2Key, max);
    }
    chunks.push(chunk);
  }
  return {
    buffer: Buffer.concat(chunks),
    contentType: resp.ContentType,
    contentLength: resp.ContentLength,
  };
}

/**
 * Streams an R2 object without buffering it into memory. Returns the raw body stream plus metadata.
 * Use this (over getObjectBuffer) when proxying potentially large objects to an HTTP response.
 */
export async function getObjectStream(
  r2Key: string
): Promise<{ stream: AsyncIterable<Uint8Array>; contentType?: string; contentLength?: number }> {
  const client = getClient();
  const bucket = getBucket();
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: r2Key }));
  const stream = resp.Body as AsyncIterable<Uint8Array> | undefined;
  if (!stream) throw new Error(`R2 object ${r2Key} has no body`);
  return { stream, contentType: resp.ContentType, contentLength: resp.ContentLength };
}

/**
 * Delete an object from R2 (soft-delete in DB, hard-delete in R2).
 * Used for cleanup of orphaned uploads or permanent deletions.
 */
export async function deleteObject(r2Key: string): Promise<void> {
  const client = getClient();
  const bucket = getBucket();

  await client.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: r2Key })
  );
}

/**
 * Upload a buffer directly to R2 from the server.
 * Used for server-side imports (e.g. CompanyCam photo sync).
 */
export async function putObject(
  r2Key: string,
  body: Buffer | Uint8Array,
  mimeType: string,
  /**
   * Bounds the upload. An accepted-then-stalled PUT hangs exactly as a stalled GET does, and callers that
   * run on a single-in-flight poller cannot afford either.
   */
  opts?: { signal?: AbortSignal }
): Promise<void> {
  const client = getClient();
  const bucket = getBucket();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: r2Key,
      Body: body,
      ContentType: mimeType,
    }),
    opts?.signal ? { abortSignal: opts.signal } : undefined
  );
}

/**
 * Configure CORS on the R2 bucket to allow browser uploads via presigned URLs.
 * Called once on server startup. Idempotent — safe to call multiple times.
 */
export async function configureR2Cors(allowedOrigins: string[]): Promise<void> {
  if (!isR2Configured()) return;

  const client = getClient();
  const bucket = getBucket();

  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedHeaders: ["*"],
              AllowedMethods: ["GET", "PUT", "HEAD"],
              AllowedOrigins: allowedOrigins,
              ExposeHeaders: ["ETag", "Content-Length"],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      })
    );
    console.log(`[R2] CORS configured for bucket "${bucket}" — origins: ${allowedOrigins.join(", ")}`);
  } catch (err) {
    console.error("[R2] Failed to configure CORS:", err);
  }
}

/**
 * Dev mode: generate a mock presigned URL when R2 is not configured.
 * Returns a localhost URL so the upload flow can be tested locally.
 */
export function generateMockUploadUrl(r2Key: string): {
  uploadUrl: string;
  r2Key: string;
  expiresIn: number;
} {
  return {
    uploadUrl: `http://localhost:3001/api/files/dev-upload?key=${encodeURIComponent(r2Key)}`,
    r2Key,
    expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
  };
}

/**
 * Dev mode: generate a mock download URL. Encodes the resolved disposition so callers/tests can assert
 * what the real presign WOULD carry (real presigns embed it in a signed ResponseContentDisposition).
 */
export function generateMockDownloadUrl(
  r2Key: string,
  disposition: "inline" | "attachment" = "attachment"
): string {
  return `http://localhost:3001/api/files/dev-download?key=${encodeURIComponent(r2Key)}&disposition=${disposition}`;
}
