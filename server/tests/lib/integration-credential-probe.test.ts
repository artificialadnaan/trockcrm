import { describe, expect, it, vi } from "vitest";
import {
  probeGoogleGeocoding,
  probeMapbox,
  reportProbe,
  sanitizeCredential,
  type CredentialProbeResult,
} from "../../src/lib/integration-credential-probe.js";

/**
 * The case this probe exists for is the one that looked healthy for four months: a credential that is
 * PRESENT and REFUSED. Google answers such a request with **HTTP 200** and a `status` of REQUEST_DENIED,
 * so any check that reads `response.ok` — the obvious thing to write — reports success.
 *
 * The real cause was narrower still, and these tests encode it: the key was VALID, and the stored
 * variable had a `"› "` prefix. Two consequences drive the assertions below.
 *   - The probe must send the credential VERBATIM. Trimming would test a string production never sends,
 *     and `trim()` does not remove `"›"` anyway, so a trimming probe reports this incident as verified.
 *   - A rejection must distinguish "this credential is dead" from "this variable is dirty", because the
 *     repairs are completely different.
 *
 * Every status class is asserted separately because telling them apart IS the feature: "not configured"
 * is a deployment choice, "unreachable" is a transient nobody should chase a key over, and "rejected"
 * is the only one that needs a human.
 */

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** The exact value the probe put on the wire, decoded back out of the query string. */
function sentKey(fetchImpl: unknown, call = 0): string | null {
  const url = String((fetchImpl as { mock: { calls: string[][] } }).mock.calls[call][0]);
  return new URL(url).searchParams.get("key");
}

const GOOGLE_OK = { status: "OK", results: [{ formatted_address: "Dallas, TX" }] };

describe("probeGoogleGeocoding", () => {
  it("reports REJECTED for a 200 response carrying REQUEST_DENIED — the real production failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: "REQUEST_DENIED", error_message: "The provided API key is invalid. " }),
    ) as unknown as typeof fetch;

    const result = await probeGoogleGeocoding({ apiKey: "bad-key", fetchImpl });

    expect(result.state).toBe("rejected");
    // The provider's own words reach the log; without them the operator is guessing between an expired
    // key, a disabled API, missing billing, and an IP restriction.
    expect(result.detail).toContain("REQUEST_DENIED");
    expect(result.detail).toContain("The provided API key is invalid.");
  });

  it("does NOT treat a 200 as success on its own", async () => {
    // Guarding the guard: a `response.ok`-based implementation passes this input, and that is precisely
    // the bug. Asserting the state rather than just "no throw" is what distinguishes them.
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: "REQUEST_DENIED" })) as unknown as typeof fetch;
    expect((await probeGoogleGeocoding({ apiKey: "bad-key", fetchImpl })).state).not.toBe("verified");
  });

  it("reports VERIFIED on OK, and on ZERO_RESULTS — the credential worked, the point just matched nothing", async () => {
    const ok = vi.fn(async () => jsonResponse(200, GOOGLE_OK)) as unknown as typeof fetch;
    expect((await probeGoogleGeocoding({ apiKey: "good", fetchImpl: ok })).state).toBe("verified");
    const zero = vi.fn(async () => jsonResponse(200, { status: "ZERO_RESULTS" })) as unknown as typeof fetch;
    expect((await probeGoogleGeocoding({ apiKey: "good", fetchImpl: zero })).state).toBe("verified");
  });

  it("does NOT call a quota or transient status a rejected credential", async () => {
    // `OVER_QUERY_LIMIT` is already a quota WARNING in the real geocoder (server/src/lib/geocoding.ts),
    // and `UNKNOWN_ERROR` is documented as retryable. Reporting either at error level as "replace the
    // credential" would send someone after a key that is perfectly fine.
    for (const status of ["OVER_QUERY_LIMIT", "UNKNOWN_ERROR"]) {
      const fetchImpl = vi.fn(async () => jsonResponse(200, { status })) as unknown as typeof fetch;
      const result = await probeGoogleGeocoding({ apiKey: "good", fetchImpl });
      expect(result.state, status).toBe("unreachable");
      expect(result.detail, status).toContain(status);
    }
  });

  it("DOES treat OVER_DAILY_LIMIT as rejected — Google returns it for missing billing and dead keys", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: "OVER_DAILY_LIMIT" })) as unknown as typeof fetch;
    expect((await probeGoogleGeocoding({ apiKey: "k", fetchImpl })).state).toBe("rejected");
  });

  it("treats an unrecognised status as unreachable rather than asserting a rejection it cannot support", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: "SOME_NEW_STATUS" })) as unknown as typeof fetch;
    const result = await probeGoogleGeocoding({ apiKey: "k", fetchImpl });
    expect(result.state).toBe("unreachable");
    expect(result.detail).toContain("SOME_NEW_STATUS");
  });

  it("reports NOT-CONFIGURED for an absent or whitespace-only key, without calling out", async () => {
    // Mirrors isGoogleGeocodingConfigured(), which decides presence on the TRIMMED value.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await probeGoogleGeocoding({ apiKey: undefined, fetchImpl })).state).toBe("not-configured");
    expect((await probeGoogleGeocoding({ apiKey: "   ", fetchImpl })).state).toBe("not-configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports UNREACHABLE, not rejected, when the network fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;
    const result = await probeGoogleGeocoding({ apiKey: "good", fetchImpl });
    expect(result.state).toBe("unreachable");
    expect(result.detail).toContain("ETIMEDOUT");
  });

  it("sends the credential VERBATIM, not trimmed — production does not trim it either", async () => {
    // The real call site passes process.env.GOOGLE_GEOCODING_API_KEY straight to Google while only the
    // PRESENCE check trims. A probe that trims tests a string production never sends, and would report
    // a whitespace-padded secret as healthy while every real request failed.
    const padded = "  AIzaPADDED  ";
    const fetchImpl = vi.fn(async () => jsonResponse(200, GOOGLE_OK)) as unknown as typeof fetch;
    await probeGoogleGeocoding({ apiKey: padded, fetchImpl });
    expect(sentKey(fetchImpl)).toBe(padded);
    expect(String((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0])).toContain("latlng=32.7767");
  });

  it("identifies a CORRUPTED VARIABLE holding a VALID key — the actual production incident", async () => {
    // Production stored "› AIza…": 41 characters where a Google key is 39, from a paste out of
    // formatted text. Google refused it with the same REQUEST_DENIED an expired key produces, which is
    // what made the investigation reach for a new credential instead of reading the value.
    const stored = "› AIzaSyREALKEYLOOKALIKE0000000000000000";
    const clean = "AIzaSyREALKEYLOOKALIKE0000000000000000";
    const fetchImpl = vi.fn(async (input: string) =>
      new URL(String(input)).searchParams.get("key") === clean
        ? jsonResponse(200, GOOGLE_OK)
        : jsonResponse(200, { status: "REQUEST_DENIED", error_message: "The provided API key is invalid. " }),
    ) as unknown as typeof fetch;

    const result = await probeGoogleGeocoding({ apiKey: stored, fetchImpl });

    expect(result.state).toBe("rejected");
    // The distinction that matters: the credential is good, so the repair is editing the variable.
    expect(result.sanitizedWouldVerify).toBe(true);
    expect(sentKey(fetchImpl, 0)).toBe(stored);
    expect(sentKey(fetchImpl, 1)).toBe(clean);
  });

  it("does NOT claim a dirty variable when the sanitized credential is ALSO refused", async () => {
    // A genuinely dead key that happens to be padded must still read as a dead key, or the probe would
    // talk an operator out of replacing a credential that really does need replacing.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: "REQUEST_DENIED", error_message: "invalid" }),
    ) as unknown as typeof fetch;
    const result = await probeGoogleGeocoding({ apiKey: "› AIzaDEAD", fetchImpl });
    expect(result.state).toBe("rejected");
    expect(result.sanitizedWouldVerify).toBeUndefined();
  });

  it("does not spend a second request when the value is already clean", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: "REQUEST_DENIED" })) as unknown as typeof fetch;
    await probeGoogleGeocoding({ apiKey: "AIzaCLEAN", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("sanitizeCredential", () => {
  it("strips the junk trim() misses, and keeps characters that are legal inside credentials", () => {
    expect(sanitizeCredential("› AIzaABC")).toBe("AIzaABC");
    expect(sanitizeCredential('  "AIzaABC"\n')).toBe("AIzaABC");
    // `trim()` alone leaves the angle quote in place — that is why this helper exists at all.
    expect("› AIzaABC".trim()).not.toBe("AIzaABC");
    // Hyphen and underscore are legal in Google keys and Mapbox tokens; stripping them would corrupt a
    // perfectly good credential and produce a misleading "dirty variable" verdict.
    expect(sanitizeCredential("pk.eyJ_abc-def")).toBe("pk.eyJ_abc-def");
    expect(sanitizeCredential("AIza_abc-")).toBe("AIza_abc-");
  });
});

describe("probeMapbox", () => {
  it("reports NOT-CONFIGURED when no token is set — the production state that killed property geocoding", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    // 1,073 properties, 0 with a latitude, because MAPBOX_TOKEN was set on no service at all.
    expect((await probeMapbox({ token: undefined, fetchImpl })).state).toBe("not-configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports REJECTED on 401/403 and UNREACHABLE on a server error", async () => {
    const make = (status: number) =>
      vi.fn(async () => ({ ok: false, status, text: async () => "nope" }) as unknown as Response) as unknown as typeof fetch;
    expect((await probeMapbox({ token: "t", fetchImpl: make(401) })).state).toBe("rejected");
    expect((await probeMapbox({ token: "t", fetchImpl: make(403) })).state).toBe("rejected");
    // A 500 is the service, not the credential, and must not be reported as one.
    expect((await probeMapbox({ token: "t", fetchImpl: make(500) })).state).toBe("unreachable");
  });

  it("probes the PERMANENT endpoint, matching the call sites that store results", async () => {
    // Mapbox ties result storage to the permanent endpoint. Probing the non-permanent one could pass
    // while every storing call is refused — the same false assurance this file exists to remove.
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }) as unknown as Response) as unknown as typeof fetch;
    await probeMapbox({ token: "t", fetchImpl });
    const url = String((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(url).toContain("permanent=true");
    expect(url).toContain("geocode/v6/reverse");
  });

  it("sends the token verbatim and flags a dirty variable holding a good token", async () => {
    const stored = "› pk.eyJGOOD";
    const fetchImpl = vi.fn(async (input: string) =>
      new URL(String(input)).searchParams.get("access_token") === "pk.eyJGOOD"
        ? ({ ok: true, status: 200, text: async () => "" } as unknown as Response)
        : ({ ok: false, status: 401, text: async () => "Not Authorized" } as unknown as Response),
    ) as unknown as typeof fetch;

    const result = await probeMapbox({ token: stored, fetchImpl });

    expect(result.state).toBe("rejected");
    expect(result.sanitizedWouldVerify).toBe(true);
    const firstUrl = new URL(String((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]));
    expect(firstUrl.searchParams.get("access_token")).toBe(stored);
  });
});

describe("reportProbe", () => {
  const logger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it("logs REJECTED at error level and says it will not self-heal", () => {
    const log = logger();
    reportProbe({ integration: "google-geocoding", state: "rejected", detail: "REQUEST_DENIED" }, log);
    expect(log.error).toHaveBeenCalledTimes(1);
    const message = String(log.error.mock.calls[0][0]);
    expect(message).toContain("SET BUT REJECTED");
    expect(message).toContain("REQUEST_DENIED");
    // The operator needs to know the state is permanent; "will fail silently" is the part that got
    // missed for four months.
    expect(message).toContain("silently");
  });

  it("tells the operator to EDIT THE VARIABLE, not replace the key, when the credential is valid", () => {
    const log = logger();
    reportProbe(
      { integration: "google-geocoding", state: "rejected", detail: "REQUEST_DENIED", sanitizedWouldVerify: true },
      log,
    );
    expect(log.error).toHaveBeenCalledTimes(1);
    const message = String(log.error.mock.calls[0][0]);
    expect(message).toContain("credential is VALID");
    expect(message).toContain("corrupted");
    // Getting this wrong costs a key rotation that fixes nothing, so the advice must be unambiguous.
    expect(message).toContain("do NOT issue a new one");
    expect(message).not.toContain("does not self-heal");
  });

  it("keeps NOT-CONFIGURED quiet — an unset credential is a choice, not an incident", () => {
    const log = logger();
    reportProbe({ integration: "mapbox-geocoding", state: "not-configured" }, log);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledTimes(1);
  });

  it("logs UNREACHABLE as a warning that explicitly is not a credential verdict", () => {
    const log = logger();
    reportProbe({ integration: "google-geocoding", state: "unreachable", detail: "ETIMEDOUT" }, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    expect(String(log.warn.mock.calls[0][0])).toContain("NOT evidence of a bad credential");
  });

  it("logs VERIFIED at info", () => {
    const log = logger();
    reportProbe({ integration: "google-geocoding", state: "verified" } as CredentialProbeResult, log);
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });
});
