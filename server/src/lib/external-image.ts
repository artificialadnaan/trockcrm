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
 *   * A hard byte cap, enforced twice: Content-Length is rejected before the body is read when the server
 *     declares one, and the downloaded length is rejected again afterwards for servers that lie or omit it.
 *   * A wall-clock timeout, so a hung CDN cannot stall a render that holds decoded bitmaps in memory.
 *
 * Returns null for anything unusable rather than throwing: callers already degrade a photo they cannot read
 * (placeholder in the PDF, skipped by the vision pass), and one bad CDN row must not cost the report.
 */

/** Long enough for a slow CDN, short enough that a hung one cannot pin a render. */
const EXTERNAL_FETCH_TIMEOUT_MS = 15_000;

export type ExternalImage = { buffer: Buffer; contentType?: string };

function isAllowedUrl(raw: string): boolean {
  if (raw.startsWith("data:image/")) return true;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchBoundedExternalImage(
  url: string | null | undefined,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalImage | null> {
  if (!url || !isAllowedUrl(url)) return null;

  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    // Re-check after redirects: `response.url` is the FINAL url, so a 302 onto http:// or another scheme is
    // refused here even though the original passed.
    if (response.url && !isAllowedUrl(response.url)) return null;

    const declared = Number(response.headers?.get?.("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) return null;
    if (buffer.byteLength === 0) return null;

    return { buffer, contentType: response.headers?.get?.("content-type") ?? undefined };
  } catch {
    // Timeout, DNS failure, connection reset, malformed body — all "no image", never fatal.
    return null;
  }
}
