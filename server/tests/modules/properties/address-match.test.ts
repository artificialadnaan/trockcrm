import { describe, expect, it } from "vitest";
import {
  addressKeysMatch,
  compareAddressKeys,
  localityContradicts,
  matchProperties,
  normalizeAddressKey,
  splitUnit,
} from "../../../src/modules/properties/match-service.js";

/**
 * Address matching decides whether field prospecting FIXES the duplicate-property problem or multiplies
 * it. ~94 duplicate groups already exist, and a rep who logs the same building twice a week would add
 * to them at door-knock frequency.
 *
 * Two failure directions, and they are NOT symmetric:
 *   - MISSING a match creates a duplicate. Visible, annoying, fixable by a merge.
 *   - FALSE match silently folds two real buildings into one record. Invisible, and it corrupts every
 *     deal, activity and contact hanging off both.
 * So the suffix table stays small and unit/suite markers are preserved.
 */
describe("normalizeAddressKey", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeAddressKey("  1420   Bishop St.  ")).toBe("1420 bishop street");
    expect(normalizeAddressKey("1420 BISHOP ST")).toBe("1420 bishop street");
  });

  it("expands the abbreviation that actually causes duplicates", () => {
    // "1420 Bishop Street" and "1420 Bishop St" are the same building, four characters apart. That gap
    // is how a large share of the existing duplicate groups were made.
    expect(normalizeAddressKey("1420 Bishop Street")).toBe(normalizeAddressKey("1420 Bishop St"));
    expect(normalizeAddressKey("55 Grand Ave")).toBe(normalizeAddressKey("55 Grand Avenue"));
    expect(normalizeAddressKey("9 Lakeshore Blvd")).toBe(normalizeAddressKey("9 Lakeshore Boulevard"));
  });

  it("expands directionals, which appear on both sides of a street name", () => {
    expect(normalizeAddressKey("100 N Main St")).toBe(normalizeAddressKey("100 North Main Street"));
    expect(normalizeAddressKey("100 SW 3rd Ave")).toBe(normalizeAddressKey("100 Southwest 3rd Avenue"));
  });

  it("returns empty for nothing usable", () => {
    for (const value of [null, undefined, "", "   ", "!!!", 42 as unknown as string]) {
      expect(normalizeAddressKey(value)).toBe("");
    }
  });
});

describe("addressKeysMatch", () => {
  it("matches the same building written two ways", () => {
    expect(addressKeysMatch("1420 Bishop St.", "1420 bishop street")).toBe(true);
  });

  it("does NOT match two empty addresses", () => {
    // The dangerous default. Properties frequently have a null address, and treating "" === "" as a
    // match would offer every address-less property as the building the rep is standing at.
    expect(addressKeysMatch(null, null)).toBe(false);
    expect(addressKeysMatch("", "")).toBe(false);
    expect(addressKeysMatch("1420 Bishop St", null)).toBe(false);
    expect(addressKeysMatch("   ", "  ")).toBe(false);
  });

  it("keeps different suites apart", () => {
    // Different tenancies in one tower. Folding them would attach one tenant's deals to another's
    // record, which is the silent failure this whole file is arranged to avoid.
    expect(addressKeysMatch("1420 Bishop St Ste 200", "1420 Bishop St Ste 400")).toBe(false);
    expect(addressKeysMatch("1420 Bishop St #200", "1420 Bishop St #400")).toBe(false);
  });

  it("keeps different house numbers on the same street apart", () => {
    expect(addressKeysMatch("1420 Bishop St", "1422 Bishop St")).toBe(false);
  });

  it("keeps different streets sharing a house number apart", () => {
    // The SQL candidate query deliberately fetches these (same leading house number); this is the check
    // that drops them.
    expect(addressKeysMatch("1420 Bishop St", "1420 Grand Ave")).toBe(false);
  });

  it("does not fold a street whose NAME is a suffix word", () => {
    // "Park" is a street name here, not an abbreviation. A larger suffix table starts eating these.
    expect(addressKeysMatch("12 Park Street", "12 Park Avenue")).toBe(false);
  });
});

describe("matchProperties guards", () => {
  /**
   * The catastrophic case is not "no results" — it is ALL results.
   *
   * With neither a coordinate nor an address there is nothing to match on, and a query that falls
   * through to an unfiltered select would hand the field capture an arbitrary building and label it
   * "the property you're at". The rep taps it, and the visit is logged against the wrong record.
   */
  const neverCalled = {
    execute: () => {
      throw new Error("matchProperties queried the database with nothing to match on");
    },
  } as unknown as Parameters<typeof matchProperties>[0];

  it.each([
    ["nothing at all", {}],
    ["a blank address", { address: "   " }],
    ["an unusable address", { address: "!!!" }],
    ["half a coordinate", { lat: 21.3 }],
    ["the other half", { lng: -157.8 }],
    ["NaN coordinates", { lat: Number.NaN, lng: Number.NaN }],
    ["null coordinates", { lat: null, lng: null }],
    ["an out-of-range latitude", { lat: 120, lng: -157.8 }],
    ["an out-of-range longitude", { lat: 21.3, lng: 200 }],
  ])("returns [] and does not query for %s", async (_label, input) => {
    await expect(matchProperties(neverCalled, input)).resolves.toEqual([]);
  });
});

describe("compareAddressKeys — suite handling", () => {
  /**
   * The case a review caught and my own docblock got wrong.
   *
   * A legacy property stores the tenancy ("1420 Bishop St Ste 200") with NULL coordinates; a reverse
   * geocode returns the building ("1420 Bishop St"). Exact comparison rejects the pair, and distance
   * cannot rescue it — the stored row has no point. The comment claimed distance covered this; it
   * cannot, precisely for the uncoordinated rows where it matters most, so the capture would report
   * "nothing here" and mint a duplicate of a property sitting right in front of the rep.
   */
  it("matches a building-level address against a stored suite, as BASE not exact", () => {
    expect(compareAddressKeys("1420 Bishop St", "1420 Bishop St Ste 200")).toBe("base");
    expect(compareAddressKeys("1420 Bishop St Ste 200", "1420 Bishop St")).toBe("base");
  });

  it("still refuses to fold two DIFFERENT suites", () => {
    // The asymmetry that governs this whole file: a miss costs a duplicate, a false match corrupts two
    // tenancies' records at once.
    expect(compareAddressKeys("1420 Bishop St Ste 200", "1420 Bishop St Ste 400")).toBeNull();
    expect(compareAddressKeys("1420 Bishop St Unit A", "1420 Bishop St Unit B")).toBeNull();
  });

  it("reports an identical line as exact", () => {
    expect(compareAddressKeys("1420 Bishop St Ste 200", "1420 bishop street ste 200")).toBe("exact");
    expect(compareAddressKeys("1420 Bishop St", "1420 bishop street")).toBe("exact");
  });

  it("does not treat a different building as a base match", () => {
    expect(compareAddressKeys("1420 Bishop St Ste 200", "1422 Bishop St")).toBeNull();
  });

  it("does not strip a leading token that happens to be a unit word", () => {
    // splitUnit scans from index 1, so a street literally named "Unit" cannot swallow the house number.
    expect(splitUnit("100 unit 5").base).toBe("100");
  });
});

describe("localityContradicts", () => {
  /**
   * "100 Main St" exists in every city in the country. Without this, an office spanning two of them
   * matches every copy — and those remote matches OUTRANK genuine proximity hits, so they can fill the
   * candidate list and stop the capture ever offering "add new" for the building underfoot.
   */
  it("rejects a same-street match in a different city or state", () => {
    expect(localityContradicts({ city: "Dallas" }, { city: "Austin" })).toBe(true);
    expect(localityContradicts({ state: "TX" }, { state: "HI" })).toBe(true);
  });

  it("allows a match when either side is silent", () => {
    // Legacy rows routinely have a null city. Requiring equality would drop exactly the uncoordinated
    // properties this matcher exists to find — "cannot disprove", not "must agree".
    expect(localityContradicts({ city: "Dallas" }, { city: null })).toBe(false);
    expect(localityContradicts({}, { city: "Austin", state: "TX" })).toBe(false);
    expect(localityContradicts({ city: "  " }, { city: "Austin" })).toBe(false);
  });

  it("ignores case and padding", () => {
    expect(localityContradicts({ city: " dallas " }, { city: "Dallas" })).toBe(false);
    expect(localityContradicts({ state: "tx" }, { state: "TX" })).toBe(false);
  });
});

describe("position-aware suffix expansion", () => {
  /**
   * "St" is Street at the end of a line and Saint anywhere else.
   *
   * Expanding it everywhere turned "1 St Charles Ave" into "1 street charles avenue", so an
   * uncoordinated legacy row spelling the same building "1 Saint Charles Avenue" was rejected and a
   * duplicate created. A silent false negative — the rep sees "nothing here" and has no reason to doubt it.
   */
  it("reads St as Saint inside a street name", () => {
    expect(compareAddressKeys("1 St Charles Ave", "1 Saint Charles Avenue")).toBe("exact");
  });

  it("still reads St as Street in the type position", () => {
    expect(compareAddressKeys("1420 Bishop St", "1420 Bishop Street")).toBe("exact");
  });

  it("handles both at once", () => {
    expect(compareAddressKeys("1 St Charles St", "1 Saint Charles Street")).toBe("exact");
  });

  it("expands directionals wherever they sit", () => {
    expect(compareAddressKeys("100 N Main St", "100 North Main Street")).toBe("exact");
    expect(compareAddressKeys("100 Main St N", "100 Main Street North")).toBe("exact");
  });
});

describe("hash-style units", () => {
  /**
   * "#200" is what people actually type, and stripping the hash to whitespace destroyed the unit:
   * "1420 Bishop St #200" became "1420 bishop street 200", which splitUnit cannot see. The suite case
   * was handled for the spelled-out markers and missed for the common one.
   */
  it("treats #200 as a unit, so a building-level geocode still matches", () => {
    expect(compareAddressKeys("1420 Bishop St #200", "1420 Bishop St")).toBe("base");
  });

  it("still keeps two different hash units apart", () => {
    expect(compareAddressKeys("1420 Bishop St #200", "1420 Bishop St #400")).toBeNull();
  });

  it("treats # and Ste as the same marker", () => {
    expect(compareAddressKeys("1420 Bishop St #200", "1420 Bishop St Ste 200")).toBe("exact");
  });
});

describe("localityContradicts — ZIP", () => {
  it("separates two same-street properties in one city but different ZIPs", () => {
    // City and state agree; only the postal area disproves it. A large city has several "100 Main St".
    expect(localityContradicts({ city: "Dallas", zip: "75201" }, { city: "Dallas", zip: "75204" })).toBe(true);
  });

  it("compares only the 5-digit prefix, so ZIP+4 does not create a false conflict", () => {
    expect(localityContradicts({ zip: "75201-1234" }, { zip: "75201" })).toBe(false);
  });

  it("stays silent when either ZIP is missing", () => {
    expect(localityContradicts({ zip: "75201" }, { zip: null })).toBe(false);
  });
});

describe("route-number addresses", () => {
  /**
   * "100 County Rd 123" — the street type is followed by a route number, so it is not the last token
   * and stayed unexpanded. An uncoordinated legacy row spelling it "100 County Road 123" was then
   * rejected, and a duplicate created.
   */
  it("expands a street type that precedes a route number", () => {
    expect(compareAddressKeys("100 County Rd 123", "100 County Road 123")).toBe("exact");
    expect(compareAddressKeys("55 State Hwy 7", "55 State Highway 7")).toBe("exact");
  });

  it("still keeps different route numbers apart", () => {
    expect(compareAddressKeys("100 County Rd 123", "100 County Rd 456")).toBeNull();
  });

  it("does not mistake a house number for a route number", () => {
    // "100 Main St" — the shift only fires when the token BEFORE the trailing number is a street type.
    expect(compareAddressKeys("100 Main St", "100 Main Street")).toBe("exact");
  });
});

describe("diacritics and single-letter street names", () => {
  /**
   * The punctuation strip turns anything outside [a-z0-9] into a space, so an accented letter was
   * DELETED rather than folded: "Cañon" became "ca on", two tokens matching nothing — least of all a
   * legacy row spelling it "Canon".
   */
  it("folds accents instead of splitting the word", () => {
    expect(compareAddressKeys("100 Cañon Rd", "100 Canon Road")).toBe("exact");
    expect(compareAddressKeys("5 Peña Blvd", "5 Pena Boulevard")).toBe("exact");
  });

  /**
   * "100 E St" is E Street — a real street in more than one US city — not "100 East St". Expanding the
   * lone letter merges two distinct addresses, and a false match is the one failure this file refuses
   * to trade for a missed one.
   */
  it("does not expand a single-letter street NAME into a directional", () => {
    expect(compareAddressKeys("100 E St", "100 East St")).toBeNull();
    expect(compareAddressKeys("100 E St", "100 E Street")).toBe("exact");
  });

  it("still expands a directional that precedes a real street name", () => {
    // The unambiguous case: something follows the directional, so it cannot be the name itself.
    expect(compareAddressKeys("100 N Main St", "100 North Main Street")).toBe("exact");
  });
});

describe("proximity must not overrule a known conflict", () => {
  /**
   * The hole under the whole design.
   *
   * compareAddressKeys correctly refuses to fold "Ste 200" into "Ste 400" — and distance then let them
   * through anyway, because two tenancies in one tower are metres apart. The weaker signal was undoing
   * the asymmetry the stronger one exists to protect.
   *
   * These assert the RULE via compareAddressKeys; matchProperties consumes it through addressesConflict.
   */
  it("keeps two explicit units distinct no matter how close they are", () => {
    expect(compareAddressKeys("1420 Bishop St Ste 200", "1420 Bishop St Ste 400")).toBeNull();
  });

  it("still says nothing when one side has no comparable address", () => {
    // A row with no address text cannot conflict — that is precisely when distance should decide.
    expect(compareAddressKeys("1420 Bishop St", null)).toBeNull();
    expect(normalizeAddressKey(null)).toBe("");
  });
});

describe("locality folds diacritics too", () => {
  it("does not treat San José and San Jose as different cities", () => {
    // Deleting the accent instead of folding it turned agreement into a CONTRADICTION — the worst
    // direction for a disproof rule to fail in, because it rejects correct matches.
    expect(localityContradicts({ city: "San José" }, { city: "San Jose" })).toBe(false);
  });
});

describe("single-letter street name without a house number", () => {
  it("does not expand a bare 'E St'", () => {
    // Keying the safeguard on index 1 assumed a house number came first, so this fell through and
    // merged with "East St" from the other direction.
    expect(compareAddressKeys("E St", "East St")).toBeNull();
    expect(compareAddressKeys("E St", "E Street")).toBe("exact");
  });
});
