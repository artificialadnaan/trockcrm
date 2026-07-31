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

/**
 * The IANA IPv4 Special-Purpose Address Registry, in full.
 *
 * Enumerating "the private ones" by hand kept missing entries — 198.18.0.0/15 (benchmarking) is routed
 * internally in plenty of environments, and TEST-NET/6to4-relay/protocol-assignment blocks are no more
 * public than RFC1918 is. The registry is finite and stable, so the whole thing is listed rather than the
 * subset that happened to come to mind, and anything outside it is treated as global unicast.
 */
const IPV4_SPECIAL_USE: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],        // "this network"
  ["10.0.0.0", 8],       // RFC1918
  ["100.64.0.0", 10],    // CGNAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local, incl. the cloud metadata endpoint
  ["172.16.0.0", 12],    // RFC1918
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.88.99.0", 24],   // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16],   // RFC1918
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2
  ["203.0.113.0", 24],   // TEST-NET-3
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved, incl. 255.255.255.255
] as const;

function ipv4ToInt(ip: string): number | null {
  const octets = ip.split(".");
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    const part = Number(octet);
    if (!Number.isInteger(part) || part < 0 || part > 255) return null;
    value = ((value << 8) | part) >>> 0;
  }
  return value;
}

function isPrivateIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable — refuse rather than guess
  return IPV4_SPECIAL_USE.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
    const network = ipv4ToInt(base);
    return network !== null && ((value & mask) >>> 0) === ((network & mask) >>> 0);
  });
}

/**
 * Expand an IPv6 address to its eight 16-bit groups.
 *
 * Ranges have to be compared NUMERICALLY, not by string prefix. `new URL()` canonicalises, so the address
 * that actually reaches this function is often not the one that was written: `[::ffff:127.0.0.1]` arrives
 * as `::ffff:7f00:1`, which no dotted-decimal pattern matches. And a prefix test is the wrong shape anyway
 * — `fe80::/10` covers fe80 through febf, so `fe90::1` is link-local while not starting with "fe80".
 */
function ipv6Groups(address: string): number[] | null {
  let addr = address.split("%")[0].toLowerCase(); // drop any zone id
  // A trailing dotted-quad (::ffff:127.0.0.1) becomes two hex groups so one code path handles both forms.
  const embedded = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (embedded) {
    const octets = embedded[2].split(".").map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    addr = `${embedded[1]}${(((octets[0] << 8) | octets[1]) >>> 0).toString(16)}:${(((octets[2] << 8) | octets[3]) >>> 0).toString(16)}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (parts.length !== 8) return null;

  const groups = parts.map((part) => parseInt(part, 16));
  return groups.some((group) => !Number.isFinite(group) || group < 0 || group > 0xffff) ? null : groups;
}

/** Loopback, link-local, RFC1918, CGNAT, multicast/reserved — anything not routable on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) {
    const groups = ipv6Groups(ip);
    if (!groups) return true; // could not be parsed — refuse rather than guess
    if (groups.every((group) => group === 0)) return true; // ::
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
    // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible: judge the address they actually carry.
    const mappedPrefix = groups.slice(0, 5).every((group) => group === 0);
    if (mappedPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
      const [g6, g7] = [groups[6], groups[7]];
      return isPrivateIpv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
    }
    const first = groups[0];
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7  unique-local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated, still routable inside)
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8  multicast
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

/**
 * Decode a `data:image/...` URL, refusing an oversized one from its ENCODED length first.
 *
 * base64 carries 3 bytes per 4 characters, so the encoded length is a hard upper bound on the decoded
 * length — which means the oversize can be rejected without allocating the image at all. A percent-encoded
 * payload is likewise never shorter than what it decodes to.
 */
function decodeBoundedDataUrl(url: string, maxBytes: number): ExternalImageResult {
  const comma = url.indexOf(",");
  if (comma < 0) return UNUSABLE;
  const meta = url.slice(5, comma); // between "data:" and the comma
  const payload = url.slice(comma + 1);
  const isBase64 = /;base64$/i.test(meta);
  const contentType = meta.split(";")[0] || undefined;

  // Cheap upper bound, checked BEFORE decoding.
  const maxDecoded = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length;
  if (maxDecoded > maxBytes) return UNUSABLE;

  let buffer: Buffer;
  try {
    buffer = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "binary");
  } catch {
    return UNUSABLE; // a malformed data: url is permanent, not transient
  }
  if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) return UNUSABLE;
  return { status: "ok", image: { buffer, contentType } };
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

  // Inline data: no network, so none of the destination rules apply — but the cap still does. Decoded here
  // rather than handed to fetch, because fetch has to materialise the ENTIRE payload to build a Response
  // before anything could stream or measure it; an oversized value in the database would allocate in full
  // and exhaust the worker despite maxBytes. The encoded length bounds the decoded length, so the oversize
  // is caught before a single byte is decoded.
  if (url.startsWith("data:image/")) return decodeBoundedDataUrl(url, maxBytes);

  // ONE deadline for the whole fetch, not one per hop. A fresh timeout per request let a CDN that stalls
  // each redirect spend the full budget four times over — around a minute for a single photo, against a
  // documented 15-second bound. Photos are fetched sequentially, and the synchronous report path renders
  // inside its office transaction, so that multiplies into minutes of held worker and held connection.
  const deadlineAt = Date.now() + EXTERNAL_FETCH_TIMEOUT_MS;

  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Re-validated on EVERY hop, before the request is issued rather than after it completes.
    if (!isHttpsUrl(target)) return UNUSABLE;
    if (!(await hasPublicDestination(target))) return UNUSABLE;

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return UNAVAILABLE; // the budget went on earlier hops

    let response: Response;
    try {
      response = await fetchImpl(target, {
        redirect: "manual", // we follow them ourselves so each hop can be checked first
        signal: AbortSignal.timeout(remainingMs),
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
