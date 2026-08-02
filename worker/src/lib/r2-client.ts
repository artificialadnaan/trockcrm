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
 * Wall-clock ceiling on ONE ranged read — the request AND the drain of its body — when the caller does not
 * supply its own.
 *
 * Sized like the part PUT it feeds (glasses-walkthrough-forward.ts, `ScopeTimeouts.partPutMs`): the same
 * 32MiB moving the other direction over the same link, so anything that would trip this would already have
 * tripped that. It exists to bound a HANG, not to police latency — see `getObjectRangeBuffer` for what a
 * hang costs on the dedicated poller, and note that a premature abort here is cheap by comparison (the
 * part is re-read on the next attempt; nothing remote has been touched yet).
 */
export const R2_RANGE_READ_TIMEOUT_MS = 10 * 60_000;

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
 *
 * BOUNDED IN WALL-CLOCK, unlike every other read in this module, because of where its one caller runs. A
 * failure that REJECTS is ordinary here: the job throws, the queue retries it. The failure this bound is
 * for is the one that does not reject — a socket R2 accepts and then goes quiet on. The S3 client is
 * constructed with no `requestTimeout` and `client.send` carries no deadline of its own, so nothing else
 * in the stack ever ends that wait; and glasses-walkthrough-forward.ts is polled by a DEDICATED loop with
 * a reentrancy guard and a concurrency of 1 (queue.ts, pollGlassesWalkthroughForwardJobs). One stalled
 * read therefore does not merely lose its own walk — it holds that guard for the life of the process, and
 * every later walkthrough forward goes unclaimed until a human restarts the worker. It is the same hazard
 * the TROCK Scope request timeouts and the destination part-PUT timeout already cover, on the one leg of
 * the round trip that they do not reach.
 *
 * A blown deadline is deliberately a plain `Error`: the queue's contract is "throw ⇒ retry, deadJob(...) ⇒
 * permanent", and a stall is exactly the transient this job's 10 attempts exist for. The message is
 * likewise deliberately unlike the absence/short-read ones above — "we could not finish reading" must
 * never be filed as "the object isn't there" or "the file is smaller than declared", which are what a
 * human would go chasing instead.
 */
export async function getObjectRangeBuffer(
  r2Key: string,
  startByte: number,
  endByteInclusive: number,
  timeoutMs: number = R2_RANGE_READ_TIMEOUT_MS
): Promise<Buffer> {
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

  // ONE deadline spanning both phases, not a timeout per phase. `client.send` resolves the moment the
  // response headers arrive, so a per-request bound would leave the drain below — where the 32MiB actually
  // moves, and where a stall is likeliest — completely uncovered. Same reasoning as scopeRequest's signal
  // covering `response.text()` rather than only the fetch.
  const controller = new AbortController();
  let timedOut = false;
  // Set inside the read so the timer can tear down a stream the SDK has stopped tracking: `abortSignal` is
  // the SDK's handle on an in-flight REQUEST, and after `send` resolves the socket belongs to the body.
  // Aborting alone would reject this call and leak the connection for the rest of the process.
  let body: { destroy?: (error?: Error) => void } | undefined;
  const timeoutError = new Error(
    `R2 did not finish the ${expectedBytes}-byte range ${startByte}-${endByteInclusive} of ${r2Key} within ` +
      `${timeoutMs}ms, so the read was abandoned.`
  );
  let failDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => {
    failDeadline = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    body?.destroy?.(timeoutError);
    failDeadline(timeoutError);
  }, timeoutMs);

  const read = async (): Promise<Buffer> => {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: r2Key,
        Range: `bytes=${startByte}-${endByteInclusive}`,
      }),
      { abortSignal: controller.signal }
    );

    if (!response.Body) {
      throw new Error(`R2 returned no body for bytes ${startByte}-${endByteInclusive} of ${r2Key}.`);
    }

    body = response.Body as { destroy?: (error?: Error) => void };
    const chunks: Uint8Array[] = [];
    const reader = response.Body as AsyncIterable<Uint8Array>;
    for await (const chunk of reader) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };

  let buffer: Buffer;
  try {
    // RACED, not merely aborted. Both teardown levers are best-effort against the case that matters: an
    // async iterable that simply never yields again has nothing to reject, and `destroy` is not part of
    // AsyncIterable at all. Only the race guarantees this function returns — which is the whole point, since
    // the caller's problem is a promise that never settles, not one that settles badly.
    buffer = await Promise.race([read(), deadline]);
  } catch (err) {
    // The abort may surface first and in the SDK's own words ("Request aborted"), which says nothing about
    // a deadline and reads like someone cancelled the job. Once the timer has fired, the cause is known and
    // this is the only accurate account of it.
    throw timedOut ? timeoutError : err;
  } finally {
    clearTimeout(timer);
  }
  if (buffer.length !== expectedBytes) {
    // Also the only guard against a Range header R2 rejected as unparseable: S3 answers those by ignoring
    // the header and returning the WHOLE object, which is a length mismatch in the other direction.
    throw new Error(
      `R2 returned ${buffer.length} bytes for the ${expectedBytes}-byte range ${startByte}-${endByteInclusive} of ${r2Key}.`
    );
  }
  return buffer;
}
