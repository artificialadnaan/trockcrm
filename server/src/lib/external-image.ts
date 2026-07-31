import { lookup } from "node:dns/promises";
import net from "node:net";

/**
 * Bounded fetch for an image that lives outside R2.
 *
 * CompanyCam-style imports store a plain CDN URL and no r2Key. Every other surface serves those URLs
 * (resolvePhotoDisplayUrls), but the report pipeline accepted only `data:` URLs — so an external-only photo
 * was skipped by the vision pass and drawn as "Image unavailable" in the PDF, and an all-external selection
 * failed the whole run. This is what lets both paths read them.
 *
 * The URL comes from our own database, written by an importer — not from the request — but this is still
 * the server issuing an outbound request to an address it did not choose, so it is deliberately narrow:
 *
 *   * https and data: only.
 *   * The DESTINATION must be public. An https URL pointed at loopback, link-local (including the cloud
 *     metadata endpoint at 169.254.169.254), or RFC1918 space is refused before any connection is made —
 *     a scheme check alone would have turned report generation into a request against internal
 *     infrastructure.
 *   * Redirects are followed MANUALLY, and every hop is re-validated before it is requested. `redirect:
 *     "follow"` was not enough: fetch completes the redirect first and only then exposes `response.url`, so
 *     the disallowed request has already happened by the time it can be inspected.
 *   * A hard byte cap enforced WHILE STREAMING. Content-Length is honoured when declared, but a server that
 *     omits or understates it cannot get past the cap either — the body is read chunk by chunk and the
 *     download cancelled the moment the total exceeds it. Buffering first and measuring afterwards would
 *     let an unbounded response allocate hundreds of megabytes inside the serialized report worker.
 *   * A wall-clock timeout, so a hung CDN cannot stall a render that holds decoded bitmaps in memory.
 *
 * Failures are CLASSIFIED rather than flattened to null. A photo that can never be read (bad scheme,
 * private destination, 404, too large) is a property of the object and the caller should degrade to a
 * placeholder; a timeout or a 5xx is a property of the moment, and the AI path must fail the run rather
 * than publish a report whose findings sit beside an "Image unavailable" panel. Same distinction
 * r2-client draws between ObjectTooLargeError/not-found and a storage outage.
 *
 * RESIDUAL RISK, stated rather than papered over: the destination is validated by resolving the hostname,
 * then fetch resolves it again to connect. A DNS entry that changes between those two lookups (rebinding)
 * is not covered. Closing that needs a dispatcher that pins the checked IP for the connection; it is not
 * done here because these URLs come from our own importers rather than from user input.
 */

/** Long enough for a slow CDN, short enough that a hung one cannot pin a render. */
const EXTERNAL_FETCH_TIMEOUT_MS = 15_000;
/** CDNs redirect (region, signed-url handoff); an unbounded chain is a way to burn the timeout budget. */
const MAX_REDIRECTS = 3;

export type ExternalImage = { buffer: Buffer; contentType?: string };

export type ExternalImageResult =
  | { status: "ok"; image: ExternalImage }
  /** Permanent for this object: no retry will change it. Degrade to a placeholder. */
  | { status: "unusable" }
  /** Transient: the object is probably fine, this attempt was not. Strict callers must fail. */
  | { status: "unavailable" };

const UNUSABLE = { status: "unusable" } as const;
const UNAVAILABLE = { status: "unavailable" } as const;

/** Loopback, link-local, RFC1918, CGNAT, multicast/reserved — anything not routable on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. the cloud metadata endpoint
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const address = ip.toLowerCase();
    if (address === "::1" || address === "::") return true;
    if (address.startsWith("fc") || address.startsWith("fd")) return true; // unique-local
    if (address.startsWith("fe80")) return true; // link-local
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // unparseable — refuse rather than guess
}

function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

/** Every address the hostname resolves to must be public; a single private answer refuses the whole host. */
async function hasPublicDestination(raw: string): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (net.isIP(hostname)) return !isPrivateAddress(hostname);
  try {
    const resolved = await lookup(hostname, { all: true });
    return resolved.length > 0 && resolved.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

/** 5xx and 429 are worth another attempt later; every other rejection is about this object. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
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

async function finish(response: Response, maxBytes: number): Promise<ExternalImageResult> {
  if (!response.ok) return isTransientStatus(response.status) ? UNAVAILABLE : UNUSABLE;

  // Cheap early-out when the server is honest about the size; the streaming cap is what holds when it is not.
  const declared = Number(response.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return UNUSABLE;

  let buffer: Buffer | null;
  try {
    buffer = await readBounded(response, maxBytes);
  } catch {
    return UNAVAILABLE; // the connection died partway through the body
  }
  if (!buffer || buffer.byteLength === 0) return UNUSABLE;

  return { status: "ok", image: { buffer, contentType: response.headers?.get?.("content-type") ?? undefined } };
}

export async function fetchBoundedExternalImage(
  url: string | null | undefined,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalImageResult> {
  // No url at all is not a failure to report — the photo simply has no external copy.
  if (!url) return UNUSABLE;

  // Inline data, already in hand: no network, so none of the destination rules apply.
  if (url.startsWith("data:image/")) {
    try {
      return await finish(await fetchImpl(url, { signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS) }), maxBytes);
    } catch {
      return UNUSABLE; // a malformed data: url is permanent, not transient
    }
  }

  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Re-validated on EVERY hop, before the request is issued rather than after it completes.
    if (!isHttpsUrl(target)) return UNUSABLE;
    if (!(await hasPublicDestination(target))) return UNUSABLE;

    let response: Response;
    try {
      response = await fetchImpl(target, {
        redirect: "manual", // we follow them ourselves so each hop can be checked first
        signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
      });
    } catch {
      return UNAVAILABLE; // timeout, DNS failure, connection reset
    }

    if (!isRedirect(response.status)) return finish(response, maxBytes);

    const location = response.headers?.get?.("location");
    if (!location) return UNUSABLE;
    try {
      target = new URL(location, target).toString();
    } catch {
      return UNUSABLE;
    }
  }
  return UNUSABLE; // redirect chain too long
}
