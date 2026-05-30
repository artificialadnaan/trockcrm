import { describe, expect, it } from "vitest";

import { LOST_STAGE_SLUGS, WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";
import {
  capPerOffice,
  compareHits,
  deriveDealStatus,
  mergeAndLimit,
  scoreMatch,
} from "../../../src/modules/search/global-search-helpers.js";

const WON_SLUG = WON_STAGE_SLUGS[0];
const LOST_SLUG = LOST_STAGE_SLUGS[0];

describe("deriveDealStatus", () => {
  it("marks a won terminal stage as won (findable + marked, not hidden)", () => {
    expect(deriveDealStatus(WON_SLUG, false)).toBe("won");
  });
  it("marks a lost terminal stage as lost", () => {
    expect(deriveDealStatus(LOST_SLUG, false)).toBe("lost");
  });
  it("marks on-hold (non-terminal) as on_hold", () => {
    expect(deriveDealStatus("opportunity", true)).toBe("on_hold");
  });
  it("treats a normal active stage as active", () => {
    expect(deriveDealStatus("opportunity", false)).toBe("active");
  });
  it("treats null/unknown stage as active", () => {
    expect(deriveDealStatus(null, false)).toBe("active");
    expect(deriveDealStatus(undefined, null)).toBe("active");
  });
  it("prefers a terminal stage over the on-hold flag", () => {
    expect(deriveDealStatus(WON_SLUG, true)).toBe("won");
  });
});

describe("capPerOffice (director anti-crowd-out)", () => {
  it("uses the full limit for a single office (or fewer)", () => {
    expect(capPerOffice(25, 1)).toBe(25);
    expect(capPerOffice(25, 0)).toBe(25);
  });
  it("splits the limit across offices, ceiling", () => {
    expect(capPerOffice(25, 2)).toBe(13); // ceil(25/2)
    expect(capPerOffice(25, 3)).toBe(9); // ceil(25/3)
  });
  it("floors at 5 so a small office is always represented", () => {
    expect(capPerOffice(25, 10)).toBe(5); // ceil(25/10)=3 -> floored to 5
  });
});

describe("compareHits / mergeAndLimit", () => {
  it("orders active before on_hold before terminal, then by rank desc within a tier", () => {
    const hits = [
      { id: "won-hi", rank: 100, status: "won" as const },
      { id: "active-lo", rank: 1, status: "active" as const },
      { id: "active-hi", rank: 50, status: "active" as const },
      { id: "hold", rank: 200, status: "on_hold" as const },
    ];
    const ordered = [...hits].sort(compareHits).map((h) => h.id);
    expect(ordered).toEqual(["active-hi", "active-lo", "hold", "won-hi"]);
  });

  it("merges, re-ranks and truncates to the per-entity limit, exposing total + truncated", () => {
    const hits = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, rank: i, status: "active" as const }));
    const result = mergeAndLimit(hits, 25);
    expect(result.hits).toHaveLength(25);
    expect(result.total).toBe(30);
    expect(result.truncated).toBe(true);
    expect(result.hits[0]?.rank).toBe(29); // highest rank first
  });

  it("reports not-truncated when under the limit", () => {
    const result = mergeAndLimit([{ rank: 1 }, { rank: 2 }], 25);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
  });
});

describe("scoreMatch", () => {
  it("ranks exact > prefix > substring > related-only", () => {
    expect(scoreMatch("acme", "Acme")).toBe(3); // exact (case-insensitive)
    expect(scoreMatch("acme", "Acme Construction")).toBe(2); // prefix
    expect(scoreMatch("acme", "The Acme Group")).toBe(1); // substring
    expect(scoreMatch("acme", "Beta Corp", null)).toBe(0); // matched only via a related field
  });
  it("takes the best across candidates and ignores empties", () => {
    expect(scoreMatch("acme", null, "no match", "ACME")).toBe(3);
    expect(scoreMatch("", "anything")).toBe(0);
  });
});
