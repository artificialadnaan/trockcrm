/**
 * Bounded fetch for an image that lives outside R2.
 *
 * CompanyCam-style imports store a plain CDN URL and no r2Key. Every other surface serves those URLs
 * (resolvePhotoDisplayUrls), but the report pipeline accepted only `data:` URLs — so an external-only photo
 * was skipped by the vision pass and drawn as "Image unavailable" in the PDF, and an all-external selection
 * failed the whole run. This is what lets both paths read them.
 *
 * The URL comes from our own database, written by an importer — not from the request — but this is still
 * the server making an outbound request to an address it did not choose, so it is deliberately narrow:
 *
 *   * https and data: only. Any other scheme (file:, ftp:, gopher:) is refused outright, and the scheme is
 *     re-checked AFTER redirects, so a redirect cannot downgrade the request or walk it onto another
 *     protocol.
 *   * A hard byte cap enforced WHILE STREAMING. Content-Length is honoured when the server declares one,
 *     but a server that omits or understates it cannot get past the cap either: the body is read chunk by
 *     chunk and the download is cancelled the moment the total exceeds it. Buffering first and measuring
 *     afterwards would let an unbounded response allocate hundreds of megabytes inside the serialized
 *     report worker before anything rejected it — the exact failure the cap exists to prevent.
 *   * A wall-clock timeout, so a hung CDN cannot stall a render that holds decoded bitmaps in memory.
 *
 * Failures are CLASSIFIED rather than flattened to null. A photo that can never be read (bad scheme, 404,
 * too large) is a property of the object and the caller should degrade to a placeholder; a timeout or a 5xx
 * is a property of the moment, and the AI path must fail the run rather than publish a report whose
 * findings sit beside an "Image unavailable" panel. That is the same distinction r2-client already draws
 * between ObjectTooLargeError/not-found and a storage outage.
 */

/** Long enough for a slow CDN, short enough that a hung one cannot pin a render. */
const EXTERNAL_FETCH_TIMEOUT_MS = 15_000;

export type ExternalImage = { buffer: Buffer; contentType?: string };

export type ExternalImageResult =
  | { status: "ok"; image: ExternalImage }
  /** Permanent for this object: no retry will change it. Degrade to a placeholder. */
  | { status: "unusable" }
  /** Transient: the object is probably fine, this attempt was not. Strict callers must fail. */
  | { status: "unavailable" };

const UNUSABLE = { status: "unusable" } as const;
const UNAVAILABLE = { status: "unavailable" } as const;

function isAllowedUrl(raw: string): boolean {
  if (raw.startsWith("data:image/")) return true;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

/** 5xx and 429 are worth another attempt later; every other rejection is about this object. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Read the body without ever holding more than the cap.
 *
 * Returns null once the running total passes maxBytes, cancelling the download so the rest is never
 * transferred. Throws only on a genuine stream error, which the caller classifies as transient.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Buffer | null> {
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

export async function fetchBoundedExternalImage(
  url: string | null | undefined,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalImageResult> {
  // No url at all is not a failure to report — the photo simply has no external copy.
  if (!url || !isAllowedUrl(url)) return UNUSABLE;

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS) });
  } catch {
    // Timeout, DNS failure, connection reset — the object may be perfectly fine.
    return UNAVAILABLE;
  }

  if (!response.ok) return isTransientStatus(response.status) ? UNAVAILABLE : UNUSABLE;
  // Re-check after redirects: `response.url` is the FINAL url, so a 302 onto http:// or another scheme is
  // refused here even though the original passed.
  if (response.url && !isAllowedUrl(response.url)) return UNUSABLE;

  // Cheap early-out when the server is honest about the size; the streaming cap below is what actually
  // holds when it is not.
  const declared = Number(response.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return UNUSABLE;

  let buffer: Buffer | null;
  try {
    buffer = await readBounded(response, maxBytes);
  } catch {
    // The connection died partway through the body.
    return UNAVAILABLE;
  }
  if (!buffer || buffer.byteLength === 0) return UNUSABLE;

  return { status: "ok", image: { buffer, contentType: response.headers?.get?.("content-type") ?? undefined } };
}
