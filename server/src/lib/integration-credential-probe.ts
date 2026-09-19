/**
 * Boot-time verification that credential-backed integrations actually WORK, not merely that a key is set.
 *
 * WHY THIS EXISTS, with the numbers. On 2026-09-18 a photo-delivery investigation turned up two silent
 * integration failures that had been running for months:
 *
 *   - `GOOGLE_GEOCODING_API_KEY` was set and rejected on every call. Of 37,320 field photos captured
 *     since June, 28,412 carried GPS coordinates and exactly **2** were ever reverse-geocoded. Every
 *     other photo displays the project's address as though it were the photo's location.
 *   - `MAPBOX_TOKEN` was set on no service at all, so property forward-geocoding was dead too:
 *     **1,073 properties, 0 with a latitude.**
 *
 * The Google cause is the one worth internalising. The KEY WAS VALID. The stored variable had a stray
 * `"› "` (a right angle quote and a space) glued to the front of it, from a paste out of formatted
 * text — 41 characters where a Google key is 39. Google answered the malformed key with
 * `REQUEST_DENIED — "The provided API key is invalid."`, which reads exactly like an expired credential
 * and sent the investigation toward "get a new key" instead of "look at the value".
 *
 * Neither failure surfaced, and the reason is a shape worth remembering. Both call sites are best-effort
 * and catch their own failures — correctly, since a photo upload must not fail because a map provider is
 * down. `isGoogleGeocodingConfigured()` then answered "is the variable present?" while reading like "is
 * geocoding working?". A present-but-refused credential is indistinguishable from a working one from
 * inside the process, and the fallback (substituting the deal's address) produces output that looks
 * entirely plausible. There was nothing to notice.
 *
 * So this probe reports FOUR states rather than two, and it draws two distinctions that the obvious
 * implementation misses:
 *
 *   1. It sends the credential VERBATIM, exactly as the real call sites do. Trimming here would test a
 *      string production never sends — and would have reported this very incident as "verified".
 *   2. On a rejection it re-probes a sanitized copy. If that copy verifies, the credential is fine and
 *      the VARIABLE is corrupted, which is a completely different repair. That is not hypothetical: it
 *      is what was actually wrong.
 *
 * Advisory only, exactly like warnIfPdftoppmMissing: it never throws and never blocks boot. A map
 * provider being unreachable must not stop the API from accepting photos.
 */

export type CredentialProbeState = "verified" | "rejected" | "not-configured" | "unreachable";

export interface CredentialProbeResult {
  integration: string;
  state: CredentialProbeState;
  /** The provider's own explanation when it refused us — the single most useful thing in the log. */
  detail?: string;
  /**
   * Set when the STORED value is refused but a sanitized copy of it verifies. That means the credential
   * itself is good and the environment variable carries junk, so the repair is editing the variable —
   * NOT obtaining a new credential.
   */
  sanitizedWouldVerify?: boolean;
}

/** Bounded so a hanging provider cannot delay boot. Advisory work gets a short leash. */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Statuses that mean a human must change something before anything works again: the key is wrong, the
 * API is not enabled for it, or billing is off. `OVER_DAILY_LIMIT` belongs here rather than with the
 * transient failures because Google returns it for a missing payment method and self-imposed caps too.
 */
const GOOGLE_DENIAL_STATUSES = new Set(["REQUEST_DENIED", "OVER_DAILY_LIMIT"]);

/**
 * Strip leading/trailing characters that cannot be part of a credential.
 *
 * Deliberately wider than `trim()`: the real incident was a `"› "` prefix, which `trim()` leaves in
 * place. `-` and `_` are preserved because they are legal inside Google keys and Mapbox tokens.
 */
export function sanitizeCredential(value: string): string {
  return value.replace(/^[^A-Za-z0-9_-]+/, "").replace(/[^A-Za-z0-9_-]+$/, "");
}

interface GoogleGeocodeBody {
  status?: string;
  error_message?: string;
}

function googleUrl(apiKey: string): string {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  // A constant (Dallas City Hall) so the provider can cache it and it costs nothing meaningful.
  url.searchParams.set("latlng", "32.7767,-96.7970");
  url.searchParams.set("key", apiKey);
  return url.toString();
}

/**
 * Reverse-geocode a fixed point with the credential and classify the answer.
 *
 * A REAL request is the whole point: the failure being guarded against is a credential that exists and
 * is refused, which no amount of inspecting the string can detect.
 */
export async function probeGoogleGeocoding(deps: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<CredentialProbeResult> {
  const integration = "google-geocoding";
  // Read the value VERBATIM. `isGoogleGeocodingConfigured()` trims only to decide presence, while the
  // request itself sends the raw string, so the probe has to mirror both halves of that split exactly.
  const raw = deps.apiKey ?? process.env.GOOGLE_GEOCODING_API_KEY ?? "";
  if (!raw.trim()) return { integration, state: "not-configured" };

  const doFetch = deps.fetchImpl ?? fetch;

  const attempt = async (key: string): Promise<CredentialProbeResult> => {
    try {
      const response = await doFetch(googleUrl(key), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      // Google answers 200 with a `status` field even when it refuses, so the HTTP code alone is not the
      // verdict — reading only response.ok is how a REQUEST_DENIED reads as success.
      const body = (await response.json()) as GoogleGeocodeBody;
      const status = body.status;
      if (status === "OK" || status === "ZERO_RESULTS") return { integration, state: "verified" };

      const detail = `${status ?? `HTTP ${response.status}`}${body.error_message ? ` — ${body.error_message.trim()}` : ""}`;
      if (status && GOOGLE_DENIAL_STATUSES.has(status)) {
        return { integration, state: "rejected", detail };
      }
      // EVERY other status is a provider condition, not a credential verdict — `OVER_QUERY_LIMIT` (a
      // quota warning the real geocoder already treats that way), `UNKNOWN_ERROR` (documented as
      // retryable), and anything Google adds later. Naming the status and staying on the cautious side
      // beats asserting a rejection we cannot support and sending someone after a working key.
      return { integration, state: "unreachable", detail };
    } catch (err) {
      // Network/timeout is NOT the same as a bad credential and must not be reported as one.
      return { integration, state: "unreachable", detail: err instanceof Error ? err.message : String(err) };
    }
  };

  const result = await attempt(raw);
  if (result.state !== "rejected") return result;

  // The credential was refused. Before telling anyone to replace it, find out whether the value is
  // merely dirty — that is the difference between a two-character edit and procuring a new key.
  const sanitized = sanitizeCredential(raw);
  if (!sanitized || sanitized === raw) return result;

  const sanitizedResult = await attempt(sanitized);
  if (sanitizedResult.state !== "verified") return result;
  return { ...result, sanitizedWouldVerify: true };
}

/**
 * The Mapbox token, verified against the v6 reverse endpoint the property path actually calls.
 *
 * `permanent=true` mirrors the real call sites, because Mapbox's terms tie result STORAGE to the
 * permanent endpoint — probing the non-permanent one could pass while the calls that store results are
 * refused, which is the same class of false assurance this whole file exists to remove.
 */
export async function probeMapbox(deps: {
  token?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<CredentialProbeResult> {
  const integration = "mapbox-geocoding";
  const raw = deps.token ?? process.env.MAPBOX_TOKEN ?? "";
  if (!raw.trim()) return { integration, state: "not-configured" };

  const doFetch = deps.fetchImpl ?? fetch;

  const attempt = async (token: string): Promise<CredentialProbeResult> => {
    const url = new URL("https://api.mapbox.com/search/geocode/v6/reverse");
    url.searchParams.set("longitude", "-96.7970");
    url.searchParams.set("latitude", "32.7767");
    url.searchParams.set("permanent", "true");
    url.searchParams.set("access_token", token);
    try {
      const response = await doFetch(url.toString(), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (response.ok) return { integration, state: "verified" };
      const text = await response.text().catch(() => "");
      const detail = `HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`;
      return {
        integration,
        // 401/403 is the credential; anything else is the service and must not be blamed on the token.
        state: response.status === 401 || response.status === 403 ? "rejected" : "unreachable",
        detail,
      };
    } catch (err) {
      return { integration, state: "unreachable", detail: err instanceof Error ? err.message : String(err) };
    }
  };

  const result = await attempt(raw);
  if (result.state !== "rejected") return result;

  const sanitized = sanitizeCredential(raw);
  if (!sanitized || sanitized === raw) return result;

  const sanitizedResult = await attempt(sanitized);
  if (sanitizedResult.state !== "verified") return result;
  return { ...result, sanitizedWouldVerify: true };
}

/** One line per integration, with severity matched to whether a human needs to act. */
export function reportProbe(
  result: CredentialProbeResult,
  log: Pick<Console, "log" | "warn" | "error"> = console,
): void {
  const tag = `[integration-probe] ${result.integration}`;
  switch (result.state) {
    case "verified":
      log.log(`${tag}: credential VERIFIED against the live provider.`);
      break;
    case "not-configured":
      // Quiet on purpose: an unset credential is a deployment choice, and the feature degrades openly.
      log.log(`${tag}: not configured — dependent features are disabled.`);
      break;
    case "rejected":
      if (result.sanitizedWouldVerify) {
        // The most actionable line this file can print, and the one the real incident needed: the key is
        // fine, the variable is dirty. Saying "replace the credential" here would send someone after a
        // new key for a value that only needs editing.
        log.error(
          `${tag}: the stored value is REJECTED but the SAME credential verifies once stray leading/` +
          `trailing characters are removed (${result.detail ?? "no detail"}). The credential is VALID — ` +
          "the environment variable is corrupted, most likely pasted from formatted text. Re-set the " +
          "variable to the bare credential; do NOT issue a new one.",
        );
        break;
      }
      // THE case this file was written for. It is the one that looks healthy from the inside.
      log.error(
        `${tag}: credential is SET BUT REJECTED by the provider (${result.detail ?? "no detail"}). ` +
        "Dependent features will fail silently on every call and degrade to fallbacks that look " +
        "plausible. This does not self-heal — an operator must fix the key, its API enablement, or billing.",
      );
      break;
    case "unreachable":
      log.warn(
        `${tag}: could not be verified at boot (${result.detail ?? "no detail"}). ` +
        "This is a provider/transient condition, NOT evidence of a bad credential. Probe only; retrying is not automatic.",
      );
      break;
  }
}

/**
 * Probe every credential-backed integration and report. Fire-and-forget from boot.
 *
 * Returns the results so a test (or a future status surface) can assert on them rather than scraping
 * log output.
 */
export async function verifyIntegrationCredentials(
  log: Pick<Console, "log" | "warn" | "error"> = console,
): Promise<CredentialProbeResult[]> {
  const results = await Promise.all([
    probeGoogleGeocoding().catch((err): CredentialProbeResult => ({
      integration: "google-geocoding",
      state: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
    })),
    probeMapbox().catch((err): CredentialProbeResult => ({
      integration: "mapbox-geocoding",
      state: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
    })),
  ]);
  for (const result of results) reportProbe(result, log);
  return results;
}
