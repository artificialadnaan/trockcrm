/**
 * Boot-time verification that credential-backed integrations actually WORK, not merely that a key is set.
 *
 * WHY THIS EXISTS, with the numbers. On 2026-09-18 a photo-delivery investigation turned up two silent
 * integration failures that had been running for months:
 *
 *   - `GOOGLE_GEOCODING_API_KEY` was set and rejected on every call. Google's own answer was
 *     `REQUEST_DENIED — "The provided API key is invalid."` Of 37,320 field photos captured since June,
 *     28,412 carried GPS coordinates and exactly **2** were ever reverse-geocoded. Every other photo
 *     displays the project's address as though it were the photo's location.
 *   - `MAPBOX_TOKEN` was set on no service at all, so property forward-geocoding was dead too:
 *     **1,073 properties, 0 with a latitude.**
 *
 * Neither surfaced, and the reason is the shape worth remembering. Both call sites are best-effort and
 * catch their own failures — correctly, since a photo upload must not fail because a map provider is
 * down. `isGoogleGeocodingConfigured()` then answered the question "is the variable present?" while
 * reading like "is geocoding working?". A present-but-invalid credential is indistinguishable from a
 * working one from inside the process, and the fallback (substituting the deal's address) produces
 * output that looks entirely plausible. There was nothing to notice.
 *
 * So this probe deliberately reports THREE states, not two. "Not configured" is a deployment choice and
 * says so quietly; "configured but REJECTED" is the dangerous one and gets the provider's own words in
 * the log, because that is the state that otherwise looks healthy forever.
 *
 * Advisory only, exactly like warnIfPdftoppmMissing: it never throws and never blocks boot. A map
 * provider being unreachable must not stop the API from accepting photos.
 */

export type CredentialProbeState = "verified" | "rejected" | "not-configured" | "unreachable";

export interface CredentialProbeResult {
  integration: string;
  state: CredentialProbeState;
  /** The provider's own explanation when it rejected us — the single most useful thing in the log. */
  detail?: string;
}

/** Bounded so a hanging provider cannot delay boot. Advisory work gets a short leash. */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Reverse-geocode a fixed point and classify the answer.
 *
 * A REAL request is the whole point: the failure being guarded against is a credential that exists and
 * is refused, which no amount of inspecting the string can detect. The coordinates are a constant
 * (Dallas City Hall) so the probe is cacheable by the provider and costs nothing meaningful.
 */
export async function probeGoogleGeocoding(deps: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<CredentialProbeResult> {
  const integration = "google-geocoding";
  const apiKey = (deps.apiKey ?? process.env.GOOGLE_GEOCODING_API_KEY)?.trim();
  if (!apiKey) return { integration, state: "not-configured" };

  const doFetch = deps.fetchImpl ?? fetch;
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("latlng", "32.7767,-96.7970");
  url.searchParams.set("key", apiKey);

  try {
    const response = await doFetch(url.toString(), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    // Google answers 200 with a `status` field even when it refuses, so the HTTP code alone is not the
    // verdict — reading only response.ok is how a REQUEST_DENIED reads as success.
    const body = (await response.json()) as { status?: string; error_message?: string };
    if (body.status === "OK" || body.status === "ZERO_RESULTS") {
      return { integration, state: "verified" };
    }
    return {
      integration,
      state: "rejected",
      detail: `${body.status ?? `HTTP ${response.status}`}${body.error_message ? ` — ${body.error_message}` : ""}`,
    };
  } catch (err) {
    // Network/timeout is NOT the same as a bad credential and must not be reported as one: a transient
    // outage at boot would otherwise send someone hunting for a key that is perfectly fine.
    return { integration, state: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
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
  const token = (deps.token ?? process.env.MAPBOX_TOKEN)?.trim();
  if (!token) return { integration, state: "not-configured" };

  const doFetch = deps.fetchImpl ?? fetch;
  const url = new URL("https://api.mapbox.com/search/geocode/v6/reverse");
  url.searchParams.set("longitude", "-96.7970");
  url.searchParams.set("latitude", "32.7767");
  url.searchParams.set("permanent", "true");
  url.searchParams.set("access_token", token);

  try {
    const response = await doFetch(url.toString(), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (response.ok) return { integration, state: "verified" };
    // 401/403 here is the credential; anything else is the service.
    const text = await response.text().catch(() => "");
    const detail = `HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`;
    return {
      integration,
      state: response.status === 401 || response.status === 403 ? "rejected" : "unreachable",
      detail,
    };
  } catch (err) {
    return { integration, state: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
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
      // THE case this file was written for. It is the one that looks healthy from the inside.
      log.error(
        `${tag}: credential is SET BUT REJECTED by the provider (${result.detail ?? "no detail"}). ` +
        "Dependent features will fail silently on every call and degrade to fallbacks that look " +
        "plausible. This does not self-heal — replace the credential.",
      );
      break;
    case "unreachable":
      log.warn(`${tag}: could not be verified at boot (${result.detail ?? "no detail"}). Probe only; retrying is not automatic.`);
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
