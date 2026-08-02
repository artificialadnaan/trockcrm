import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

let _client: S3Client | null = null;

function getR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME || "trock-crm-files";

  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

/**
 * Check if R2 is configured. Returns false when env vars are missing.
 */
export function isR2Configured(): boolean {
  const { accountId, accessKeyId, secretAccessKey } = getR2Config();
  return !!(accountId && accessKeyId && secretAccessKey);
}

/**
 * Get the singleton S3 client for R2.
 * Throws if R2 env vars are not configured.
 */
export function getR2Client(): S3Client {
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

/**
 * Get the R2 bucket name from env or default.
 */
export function getR2Bucket(): string {
  return getR2Config().bucketName;
}

/**
 * Fetch an object from R2 and return its body as a Buffer.
 * Returns null if the object is not found or R2 is not configured.
 */
export async function getObjectBuffer(r2Key: string): Promise<Buffer | null> {
  if (!isR2Configured()) {
    console.log("[R2:worker] R2 not configured -- skipping object fetch");
    return null;
  }

  const client = getR2Client();
  const bucket = getR2Bucket();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: r2Key,
    })
  );

  if (!response.Body) {
    return null;
  }

  // Convert the readable stream to a Buffer
  const chunks: Uint8Array[] = [];
  const reader = response.Body as AsyncIterable<Uint8Array>;
  for await (const chunk of reader) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch ONE byte range of an object (inclusive `endByte`, HTTP Range semantics). Used by
 * glasses-walkthrough-forward.ts to relay a clip to TROCK Scope's multipart upload one 32MiB part at a
 * time instead of buffering an entire (potentially multi-GB) video/audio file in the worker's memory.
 *
 * ALL-OR-NOTHING, unlike `getObjectBuffer` above, and deliberately so. That function's leniency is safe
 * because its miss is `null`: the return type is `Buffer | null`, so the compiler makes every caller
 * unwrap it, and none of them can relay it onward. A short Buffer has no such type — it is
 * indistinguishable from real bytes — and this function's one caller writes what it gets straight back
 * out at a presigned R2 part URL, which accepts zero bytes, answers 200 and hands back an ETag. A worker
 * missing R2 credentials therefore used to forward a single-part clip to TROCK Scope as ZERO BYTES and
 * report success: a walk that looks filed, never retries, never alerts, and bills a transcription that
 * yields a confidently empty scope. Strictly worse than a failed job.
 *
 * Nothing dev-facing is lost by throwing. The local-dev affordance for an unconfigured R2 lives in the
 * API's own client (generateMockUploadUrl / generateMockDownloadUrl and the /api/files/dev-* routes);
 * this module has none, and the only caller dead-letters on an unset TROCK_SCOPE_BASE_URL /
 * TROCK_SCOPE_SERVICE_TOKEN long before it reaches R2. The unconfigured path is thus reachable only from
 * a deploy that has TROCK Scope wired up and R2 not — a broken environment, never a laptop.
 *
 * The length check catches what a credential check cannot: R2 clamps a range to the object's real end, so
 * a `files` row overstating fileSizeBytes yields a SHORT part, and S3 multipart accepts an undersized
 * FINAL part — that one completes "successfully" as a silently truncated recording.
 */
export async function getObjectRangeBuffer(r2Key: string, startByte: number, endByteInclusive: number): Promise<Buffer> {
  const expectedBytes = endByteInclusive - startByte + 1;

  if (!isR2Configured()) {
    // Names the env vars, never their values: this text reaches job_queue.last_error and from there the
    // dead-letter alert email a human reads.
    throw new Error(
      `R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) — cannot read bytes ` +
        `${startByte}-${endByteInclusive} of ${r2Key}.`
    );
  }

  const client = getR2Client();
  const bucket = getR2Bucket();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: r2Key,
      Range: `bytes=${startByte}-${endByteInclusive}`,
    })
  );

  if (!response.Body) {
    throw new Error(`R2 returned no body for bytes ${startByte}-${endByteInclusive} of ${r2Key}.`);
  }

  const chunks: Uint8Array[] = [];
  const reader = response.Body as AsyncIterable<Uint8Array>;
  for await (const chunk of reader) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length !== expectedBytes) {
    // Also the only guard against a Range header R2 rejected as unparseable: S3 answers those by ignoring
    // the header and returning the WHOLE object, which is a length mismatch in the other direction.
    throw new Error(
      `R2 returned ${buffer.length} bytes for the ${expectedBytes}-byte range ${startByte}-${endByteInclusive} of ${r2Key}.`
    );
  }
  return buffer;
}
