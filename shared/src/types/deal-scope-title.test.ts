import { describe, expect, it } from "vitest";
import {
  DEAL_SCOPE_TITLE_MAX_LENGTH,
  deriveChangeOrderScopeTitle,
  validateDealScopeTitle,
} from "./deal-scope-title.js";

const AT_LIMIT = "A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH);
const OVER_LIMIT = "A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH + 1);

describe("validateDealScopeTitle", () => {
  it("accepts a real short title unchanged", () => {
    expect(validateDealScopeTitle("Balcony Repair")).toEqual({ ok: true, value: "Balcony Repair" });
  });

  it("trims BEFORE measuring, so padding cannot fail an otherwise-legal title", () => {
    expect(validateDealScopeTitle(`   ${AT_LIMIT}   `)).toEqual({ ok: true, value: AT_LIMIT });
  });

  it("treats null, undefined, empty and whitespace-only as UNSET (null), never as an empty string", () => {
    for (const blank of [null, undefined, "", "   ", "\t\n "]) {
      expect(validateDealScopeTitle(blank)).toEqual({ ok: true, value: null });
    }
  });

  it("rejects one character past the cap, naming the limit", () => {
    const result = validateDealScopeTitle(OVER_LIMIT);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty(
      "error",
      `scopeTitle must be ${DEAL_SCOPE_TITLE_MAX_LENGTH} characters or fewer`
    );
  });

  it("accepts exactly the cap — the boundary is inclusive on both sides of the API and the column", () => {
    expect(validateDealScopeTitle(AT_LIMIT)).toEqual({ ok: true, value: AT_LIMIT });
  });

  it("rejects a non-string instead of coercing it toward the column", () => {
    for (const bad of [42, true, {}, [], new Date()]) {
      expect(validateDealScopeTitle(bad).ok).toBe(false);
    }
  });

  it("honours an explicit maxLength, so a caller cannot silently disagree with the column", () => {
    expect(validateDealScopeTitle("abcdef", 5).ok).toBe(false);
    expect(validateDealScopeTitle("abcde", 5)).toEqual({ ok: true, value: "abcde" });
  });
});

describe("deriveChangeOrderScopeTitle — the SEED for a change-order child", () => {
  // The rule is settled by the production census recorded on the function, not by preference: of the 36
  // change-order children in the live tenant, 0 matched their parent's description and 34 described
  // plainly different work, at a median of 33 characters.
  it("prefers the CO's OWN description — the 97% case in real data", () => {
    expect(
      deriveChangeOrderScopeTitle({
        changeOrderDescription: "Panel Relocation",
        parentScopeTitle: "Balcony Repair",
      })
    ).toBe("Panel Relocation");
  });

  it("trims the CO description rather than storing its padding", () => {
    expect(
      deriveChangeOrderScopeTitle({ changeOrderDescription: "  CE#001 Stucco Repairs  ", parentScopeTitle: null })
    ).toBe("CE#001 Stucco Repairs");
  });

  it("falls back to the parent's title when the CO has no description", () => {
    for (const blank of [null, undefined, "", "   "]) {
      expect(
        deriveChangeOrderScopeTitle({ changeOrderDescription: blank, parentScopeTitle: "Balcony Repair" })
      ).toBe("Balcony Repair");
    }
  });

  it("falls back when the CO description is a notes blob rather than a title", () => {
    // Squeezing the first 120 characters of a "Scope of Work:" block into a title is how the wall-of-text
    // problem gets recreated one field over, so multi-line is excluded outright.
    expect(
      deriveChangeOrderScopeTitle({
        changeOrderDescription: "CO-001 Batch 1 Additional Units\nScope of Work:\nUnit 302, 314, 511",
        parentScopeTitle: "Balcony Repair",
      })
    ).toBe("Balcony Repair");
    expect(
      deriveChangeOrderScopeTitle({
        changeOrderDescription: "First line\r\nSecond line",
        parentScopeTitle: "Balcony Repair",
      })
    ).toBe("Balcony Repair");
  });

  it("falls back when the CO description is over the cap, and never returns an over-cap value", () => {
    expect(
      deriveChangeOrderScopeTitle({ changeOrderDescription: OVER_LIMIT, parentScopeTitle: "Balcony Repair" })
    ).toBe("Balcony Repair");

    // Belt and braces: an over-cap PARENT title (only reachable if the column were widened by hand) must
    // not be passed through either — the seed can never be the thing that makes a CO insert fail 22001.
    expect(
      deriveChangeOrderScopeTitle({ changeOrderDescription: null, parentScopeTitle: OVER_LIMIT })
    ).toBeNull();
  });

  it("uses a CO description of exactly the cap", () => {
    expect(
      deriveChangeOrderScopeTitle({ changeOrderDescription: AT_LIMIT, parentScopeTitle: "Balcony Repair" })
    ).toBe(AT_LIMIT);
  });

  it("returns null when neither side supplies anything usable", () => {
    expect(deriveChangeOrderScopeTitle({ changeOrderDescription: null, parentScopeTitle: null })).toBeNull();
    expect(deriveChangeOrderScopeTitle({})).toBeNull();
  });

  it("is a pure seed — the same inputs always give the same answer, and it reads nothing else", () => {
    // Independence is the design: nothing here consults the parent once the child exists, which is why a
    // later parent retitle cannot rewrite a change order accounting has already keyed.
    const input = { changeOrderDescription: "Tile & Plumbing Alt", parentScopeTitle: "Interior Repair" };
    expect(deriveChangeOrderScopeTitle(input)).toBe(deriveChangeOrderScopeTitle(input));
  });

  it("never returns a value the API validator would reject", () => {
    const cases = [
      { changeOrderDescription: "Panel Relocation", parentScopeTitle: null },
      { changeOrderDescription: OVER_LIMIT, parentScopeTitle: "Balcony Repair" },
      { changeOrderDescription: "  Step Repair and Re-coat  ", parentScopeTitle: null },
      { changeOrderDescription: AT_LIMIT, parentScopeTitle: null },
    ];
    for (const input of cases) {
      expect(validateDealScopeTitle(deriveChangeOrderScopeTitle(input)).ok).toBe(true);
    }
  });
});
