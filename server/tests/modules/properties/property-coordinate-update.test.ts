import { describe, expect, it } from "vitest";
import { buildPropertyUpdatePatch } from "../../../src/modules/properties/service.js";

/**
 * Coordinates on the EDIT path.
 *
 * A geocode belongs to a specific street line, so editing the address invalidates it — a corrected or
 * relocated property that keeps its old point goes on matching field captures at a place it no longer
 * is. But clearing without a way to write them back is its own trap: PATCH is the only editing path,
 * and until now it could not set lat/lng at all, so an edited property became permanently
 * address-only with no recovery.
 */
describe("buildPropertyUpdatePatch — coordinates", () => {
  it("accepts a coordinate pair", () => {
    const patch = buildPropertyUpdatePatch({ lat: 21.3069, lng: -157.8583 });
    expect(patch.lat).toBe("21.3069");
    expect(patch.lng).toBe("-157.8583");
  });

  it("degrades a blank or unusable coordinate to null instead of storing zero", () => {
    // Number("") is 0 — the equator. A coordinate that is present, plausible to the database, and
    // matches nothing is worse than an absent one, because nothing looks wrong.
    expect(buildPropertyUpdatePatch({ lat: "" }).lat).toBeNull();
    expect(buildPropertyUpdatePatch({ lat: "   " }).lat).toBeNull();
    expect(buildPropertyUpdatePatch({ lat: 120 }).lat).toBeNull();
    expect(buildPropertyUpdatePatch({ lng: 200 }).lng).toBeNull();
    expect(buildPropertyUpdatePatch({ lat: "abc" }).lat).toBeNull();
  });

  it("leaves coordinates untouched when the request does not mention them", () => {
    // hasOwnProperty, not truthiness — otherwise an explicit null could never be written.
    const patch = buildPropertyUpdatePatch({ buildYear: 1998 });
    expect("lat" in patch).toBe(false);
    expect("lng" in patch).toBe(false);
  });

  it("allows an explicit null to clear them", () => {
    expect(buildPropertyUpdatePatch({ lat: null, lng: null }).lat).toBeNull();
  });
});

describe("buildPropertyUpdatePatch — coordinate types and zero", () => {
  it("keeps a legitimate 0,0 rather than treating it as absent", () => {
    // The exact edge the null-island guard could swallow: 0 is falsy, and a truthiness check here
    // would silently discard a real (if unlikely) equatorial coordinate.
    const patch = buildPropertyUpdatePatch({ lat: 0, lng: 0 });
    expect(patch.lat).toBe("0");
    expect(patch.lng).toBe("0");
  });

  it("rejects types that Number() would happily coerce", () => {
    // Number(true) is 1 and Number([5]) is 5, so a malformed body could store a plausible-looking
    // coordinate nobody typed. Only a number or a numeric string is a coordinate.
    expect(buildPropertyUpdatePatch({ lat: true as unknown as number, lng: 1 }).lat).toBeNull();
    expect(buildPropertyUpdatePatch({ lat: [5] as unknown as number, lng: 1 }).lat).toBeNull();
    expect(buildPropertyUpdatePatch({ lat: {} as unknown as number, lng: 1 }).lat).toBeNull();
  });
});
