import { describe, expect, it, vi } from "vitest";
import {
  probeGoogleGeocoding,
  probeMapbox,
  reportProbe,
  type CredentialProbeResult,
} from "../../src/lib/integration-credential-probe.js";

/**
 * The case this probe exists for is the one that looked healthy for four months: a credential that is
 * PRESENT and REFUSED. Google answers such a request with **HTTP 200** and a `status` of REQUEST_DENIED,
 * so any check that reads `response.ok` — the obvious thing to write — reports success. 37,320 field
 * photos went by with 2 ever geocoded on exactly that.
 *
 * Every state is asserted separately because the whole value of the probe is telling them apart:
 * "not configured" is a deployment choice, "unreachable" is a transient outage nobody should chase a key
 * over, and "rejected" is the one that needs a human.
 */

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("probeGoogleGeocoding", () => {
  it("reports REJECTED for a 200 response carrying REQUEST_DENIED — the real production failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        status: "REQUEST_DENIED",
        error_message: "The provided API key is invalid. ",
      }),
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
    const result = await probeGoogleGeocoding({ apiKey: "bad-key", fetchImpl });
    expect(result.state).not.toBe("verified");
  });

  it("reports VERIFIED on OK", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { status: "OK", results: [{ formatted_address: "Dallas, TX" }] }),
    ) as unknown as typeof fetch;
    expect((await probeGoogleGeocoding({ apiKey: "good", fetchImpl })).state).toBe("verified");
  });

  it("treats ZERO_RESULTS as verified — the credential worked, the coordinates just matched nothing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: "ZERO_RESULTS" })) as unknown as typeof fetch;
    expect((await probeGoogleGeocoding({ apiKey: "good", fetchImpl })).state).toBe("verified");
  });

  it("reports NOT-CONFIGURED for an absent or whitespace-only key, without calling out", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await probeGoogleGeocoding({ apiKey: undefined, fetchImpl })).state).toBe("not-configured");
    expect((await probeGoogleGeocoding({ apiKey: "   ", fetchImpl })).state).toBe("not-configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports UNREACHABLE, not rejected, when the network fails", async () => {
    // A boot-time outage must not send someone hunting for a key that is perfectly fine.
    const fetchImpl = vi.fn(async () => {
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;
    const result = await probeGoogleGeocoding({ apiKey: "good", fetchImpl });
    expect(result.state).toBe("unreachable");
    expect(result.detail).toContain("ETIMEDOUT");
  });

  it("sends the key and a real coordinate pair — a probe that requests nothing proves nothing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { status: "OK" })) as unknown as typeof fetch;
    await probeGoogleGeocoding({ apiKey: "sentinel-key", fetchImpl });
    const url = String((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(url).toContain("key=sentinel-key");
    expect(url).toContain("latlng=32.7767");
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
});

describe("reportProbe", () => {
  const logger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it("logs REJECTED at error level and says it will not self-heal", async () => {
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

  it("keeps NOT-CONFIGURED quiet — an unset credential is a choice, not an incident", () => {
    const log = logger();
    reportProbe({ integration: "mapbox-geocoding", state: "not-configured" }, log);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledTimes(1);
  });

  it("logs UNREACHABLE as a warning, distinctly from a rejection", () => {
    const log = logger();
    reportProbe({ integration: "google-geocoding", state: "unreachable", detail: "ETIMEDOUT" }, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs VERIFIED at info", () => {
    const log = logger();
    reportProbe({ integration: "google-geocoding", state: "verified" } as CredentialProbeResult, log);
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });
});
