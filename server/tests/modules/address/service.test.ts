import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMapboxFeatures, suggestAddresses, MIN_QUERY_LENGTH } from "../../../src/modules/address/service.js";

const SAMPLE = {
  features: [
    {
      id: "addr.1",
      properties: {
        full_address: "2711 North Haskell Ave, Dallas, TX 75204, United States",
        name: "2711 North Haskell Ave",
        context: {
          place: { name: "Dallas" },
          region: { region_code: "TX", name: "Texas" },
          postcode: { name: "75204" },
        },
      },
    },
  ],
};

describe("parseMapboxFeatures", () => {
  it("maps a v6 feature to a trimmed AddressSuggestion", () => {
    expect(parseMapboxFeatures(SAMPLE)).toEqual([
      { id: "addr.1", label: "2711 North Haskell Ave, Dallas, TX 75204, United States",
        address: "2711 North Haskell Ave", city: "Dallas", state: "TX", zip: "75204" },
    ]);
  });

  it("tolerates partial context (missing postcode/region)", () => {
    const partial = { features: [{ id: "a", properties: { name: "1 Main St", context: { place: { name: "Austin" } } } }] };
    expect(parseMapboxFeatures(partial)).toEqual([
      { id: "a", label: "1 Main St", address: "1 Main St", city: "Austin", state: "", zip: "" },
    ]);
  });

  it("returns [] for empty/malformed input", () => {
    expect(parseMapboxFeatures({})).toEqual([]);
    expect(parseMapboxFeatures({ features: null } as never)).toEqual([]);
  });
});

describe("suggestAddresses (degrade)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.unstubAllEnvs(); });

  it("returns [] when MAPBOX_TOKEN is unset (no network call)", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "");
    const spy = vi.fn();
    globalThis.fetch = spy as never;
    expect(await suggestAddresses("2711 Haskell")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns [] when query is shorter than MIN_QUERY_LENGTH", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "pk.test");
    const spy = vi.fn();
    globalThis.fetch = spy as never;
    expect(await suggestAddresses("ab".slice(0, MIN_QUERY_LENGTH - 1))).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns [] on non-2xx from Mapbox", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "pk.test");
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429 })) as never;
    expect(await suggestAddresses("2711 Haskell")).toEqual([]);
  });

  it("parses suggestions on 2xx", async () => {
    vi.stubEnv("MAPBOX_TOKEN", "pk.test");
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => SAMPLE })) as never;
    const out = await suggestAddresses("2711 Haskell");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ address: "2711 North Haskell Ave", city: "Dallas", state: "TX", zip: "75204" });
  });
});
