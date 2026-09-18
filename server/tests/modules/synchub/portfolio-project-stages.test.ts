import { describe, expect, it } from "vitest";
import {
  PORTFOLIO_OFF_BOARD_STAGE_ALIASES,
  PORTFOLIO_PROJECT_BOARD_STAGES,
  PORTFOLIO_PROJECT_OFF_BOARD_STAGES,
  bareNormalizePortfolioProjectStage,
  isPortfolioProjectBoardRelevantStage,
  isPortfolioProjectBoardStage,
  isPortfolioProjectOffBoardStage,
  normalizePortfolioProjectStage,
} from "@trock-crm/shared/types";

describe("portfolio project stage normalization", () => {
  it.each([
    ["Bidding", "bidding"],
    ["BID", "bidding"],
    ["Buy Out", "buyout"],
    ["Buy-Out", "buyout"],
    ["buy_out", "buyout"],
    ["Close Out", "close out"],
    ["Close-Out", "close out"],
    ["closeout", "close out"],
    ["Close Out - Final Invoice", "close out - final invoice"],
    ["Close-Out - Final Invoice", "close out - final invoice"],
    ["Close-Out-Final Invoice", "close out - final invoice"],
    ["closeout final invoice", "close out - final invoice"],
    ["Closed", "closed"],
    ["Contract Executed", "contract executed"],
    ["contracts executed", "contract executed"],
    ["In Production", "in production"],
    ["production", "in production"],
  ])("maps %s to canonical board stage %s", (input, expected) => {
    expect(normalizePortfolioProjectStage(input)).toBe(expected);
    expect(isPortfolioProjectBoardStage(input)).toBe(true);
  });

  it("keeps all canonical board stages board-relevant", () => {
    for (const stage of PORTFOLIO_PROJECT_BOARD_STAGES) {
      expect(normalizePortfolioProjectStage(stage)).toBe(stage);
      expect(isPortfolioProjectBoardStage(stage)).toBe(true);
    }
  });

  it("normalizes every canonical stage to ITSELF (double-normalization is a no-op)", () => {
    // The relay normalizes and then re-classifies the already-normalized value, so a canonical
    // stage that did not survive a second pass would silently lose its column.
    for (const stage of [...PORTFOLIO_PROJECT_BOARD_STAGES, ...PORTFOLIO_PROJECT_OFF_BOARD_STAGES]) {
      expect(normalizePortfolioProjectStage(normalizePortfolioProjectStage(stage))).toBe(stage);
    }
  });
});

/**
 * The 16 stage strings actually present in SyncHub's `public.procore_projects` for active
 * projects, copied VERBATIM from a live census — including the trailing space Procore stores
 * on "Estimating ". Every one of them must land somewhere deliberate.
 */
const LIVE_PROCORE_STAGES: Array<{
  raw: string;
  normalized: string;
  placement: "board" | "off-board";
}> = [
  { raw: "Hold (LEGACY)", normalized: "hold (legacy)", placement: "off-board" },
  { raw: "Lost/Cancelled (Legacy)", normalized: "lost/cancelled (legacy)", placement: "off-board" },
  { raw: "Service - Close Out Final Invoice", normalized: "service - close out final invoice", placement: "board" },
  { raw: "Closed", normalized: "closed", placement: "board" },
  { raw: "Close Out - Final Invoice", normalized: "close out - final invoice", placement: "board" },
  { raw: "In Production", normalized: "in production", placement: "board" },
  { raw: "Service - In Production", normalized: "service - in production", placement: "board" },
  { raw: "Buy Out", normalized: "buyout", placement: "board" },
  { raw: "Pre-Construction", normalized: "pre-construction", placement: "board" },
  { raw: "Estimating ", normalized: "estimating", placement: "board" }, // NOTE: trailing space in Procore
  { raw: "Service - Close Out", normalized: "service - close out", placement: "board" },
  { raw: "Close Out", normalized: "close out", placement: "board" },
  { raw: "Service - Lost", normalized: "service - lost", placement: "board" },
  { raw: "Service - Estimating", normalized: "service - estimating", placement: "board" },
  { raw: "Bidding", normalized: "bidding", placement: "board" },
  { raw: "Contract Executed", normalized: "contract executed", placement: "board" },
];

describe("every live Procore stage is mapped on purpose", () => {
  it.each(LIVE_PROCORE_STAGES.map((row) => [row.raw, row.normalized, row.placement] as const))(
    "%j normalizes to %j and is %s",
    (raw, normalized, placement) => {
      expect(normalizePortfolioProjectStage(raw)).toBe(normalized);
      expect(isPortfolioProjectBoardStage(raw)).toBe(placement === "board");
      expect(isPortfolioProjectOffBoardStage(raw)).toBe(placement === "off-board");
      // Off-board stages are the ONLY ones excluded from ingestion.
      expect(isPortfolioProjectBoardRelevantStage(raw)).toBe(placement === "off-board" ? false : true);
    },
  );

  it("covers all 16 live stages, so none can fall through the alias map by accident", () => {
    expect(LIVE_PROCORE_STAGES).toHaveLength(16);
    const unclassified = LIVE_PROCORE_STAGES.filter(
      (row) => !isPortfolioProjectBoardStage(row.raw) && !isPortfolioProjectOffBoardStage(row.raw),
    );
    expect(unclassified).toEqual([]);
  });

  it("trims Procore's trailing space rather than minting a separate stage", () => {
    expect(normalizePortfolioProjectStage("Estimating ")).toBe(
      normalizePortfolioProjectStage("Estimating"),
    );
  });

  it("keeps the service final-invoice stage distinct from the construction one", () => {
    // Procore punctuates these differently: no hyphen before "Final" on the service stage.
    expect(normalizePortfolioProjectStage("Service - Close Out Final Invoice")).not.toBe(
      normalizePortfolioProjectStage("Close Out - Final Invoice"),
    );
    expect(normalizePortfolioProjectStage("Service - Close Out Final Invoice")).not.toBe(
      normalizePortfolioProjectStage("Service - Close Out"),
    );
  });
});

describe("stages nobody anticipated", () => {
  it("stays board-relevant so it is ingested and surfaced instead of dropped", () => {
    const surprise = "Warranty - Punch List";
    expect(isPortfolioProjectBoardStage(surprise)).toBe(false);
    expect(isPortfolioProjectOffBoardStage(surprise)).toBe(false);
    // The load-bearing bit: unknown != excluded.
    expect(isPortfolioProjectBoardRelevantStage(surprise)).toBe(true);
    expect(normalizePortfolioProjectStage(surprise)).toBe("warranty - punch list");
  });

  it("treats an absent stage as unknown-but-relevant, never as a decision to exclude", () => {
    for (const value of [null, undefined, ""]) {
      expect(isPortfolioProjectOffBoardStage(value)).toBe(false);
      expect(isPortfolioProjectBoardRelevantStage(value)).toBe(true);
    }
  });

  it("excludes ONLY the two explicitly listed legacy stages", () => {
    expect([...PORTFOLIO_PROJECT_OFF_BOARD_STAGES]).toEqual([
      "hold (legacy)",
      "lost/cancelled (legacy)",
    ]);
    for (const stage of PORTFOLIO_PROJECT_OFF_BOARD_STAGES) {
      expect(isPortfolioProjectBoardRelevantStage(stage)).toBe(false);
      expect(isPortfolioProjectBoardStage(stage)).toBe(false);
    }
  });
});

/**
 * SLASH SPACING — the shipped defect.
 *
 * The normalizer absorbed hyphen spacing ("Pre-Construction" / "Pre - Construction" / "Pre Construction"
 * are one stage) but not SLASH spacing, and the alias map's bare legacy key is written WITHOUT spaces.
 * So "Lost / Cancelled" matched nothing, and `isPortfolioProjectBoardRelevantStage` fails OPEN by
 * design — unrecognised means "surface it anyway", never "exclude it". A project deliberately parked in
 * a dead Procore bucket was therefore ingested by the seed AND the webhook relay and shown on the board
 * under "Other / No Column", presented as live work. Measured on the code that shipped in PR #1040:
 *
 *   "Lost / Cancelled"   bare="lost / cancelled"  norm="lost / cancelled"        boardRelevant=TRUE
 *   "Lost  /  Cancelled" bare="lost / cancelled"  norm="lost / cancelled"        boardRelevant=TRUE
 *   "Lost/Cancelled"     bare="lost/cancelled"    norm="lost/cancelled (legacy)" boardRelevant=false
 */
describe("legacy Lost/Cancelled bucket, whatever the slash spacing", () => {
  const SPACED_SPELLINGS = [
    "Lost / Cancelled",
    "Lost  /  Cancelled", // doubled spaces: the bare normalizer collapses them, the lookup must not care
    "Lost /Cancelled",    // one-sided
    "Lost/ Cancelled",    // one-sided, the other way
    "LOST / CANCELLED",
    "  Lost / Cancelled  ",
    "Lost\t/\tCancelled",
    "Lost_/_Cancelled",   // underscores become spaces before the slash is compacted
    "Lost / Cancelled (Legacy)",
    "Lost  /  Cancelled  (Legacy)",
  ];

  it.each(SPACED_SPELLINGS)("%j is off-board and NOT ingested", (raw) => {
    expect(normalizePortfolioProjectStage(raw)).toBe("lost/cancelled (legacy)");
    expect(isPortfolioProjectOffBoardStage(raw)).toBe(true);
    expect(isPortfolioProjectBoardRelevantStage(raw)).toBe(false);
    expect(isPortfolioProjectBoardStage(raw)).toBe(false);
  });

  /**
   * The spellings that ALREADY worked before the fix, pinned so a later "simplification" of the lookup
   * chain cannot trade one class of failure for another. Every one of these is a real Procore string or
   * a documented alias key.
   */
  it.each([
    ["Lost/Cancelled", "lost/cancelled (legacy)"],
    ["Lost/Cancelled (Legacy)", "lost/cancelled (legacy)"],
    ["LOST/CANCELLED (LEGACY)", "lost/cancelled (legacy)"],
    ["Hold", "hold (legacy)"],
    ["Hold (LEGACY)", "hold (legacy)"],
    ["  HOLD  ", "hold (legacy)"],
  ])("%j still normalizes to %j and stays off-board", (raw, expected) => {
    expect(normalizePortfolioProjectStage(raw)).toBe(expected);
    expect(isPortfolioProjectBoardRelevantStage(raw)).toBe(false);
  });

  it("leaves the BARE normalized form untouched, so persisted idempotency keys do not move", () => {
    // `bareNormalizePortfolioProjectStage` feeds `legacyEventKeysForPayload`, whose output is STORED on
    // relayed stage events. Compacting the slash there instead of at lookup time would have re-keyed
    // every historical event and re-delivered them. The fix therefore lives in the lookup chain only.
    expect(bareNormalizePortfolioProjectStage("Lost / Cancelled")).toBe("lost / cancelled");
    expect(bareNormalizePortfolioProjectStage("Lost  /  Cancelled")).toBe("lost / cancelled");
    expect(bareNormalizePortfolioProjectStage("Lost/Cancelled")).toBe("lost/cancelled");
  });

  it("adds no alias key, so the derived off-board alias list migration 0216 is pinned against is unchanged", () => {
    // The one-line fix — a 'lost / cancelled' entry in STAGE_ALIASES — was rejected precisely here.
    // PORTFOLIO_OFF_BOARD_STAGE_ALIASES is derived from that map and pinned by a drift test against
    // migration 0216, an ALREADY-APPLIED file the runner will never re-execute. Adding a key would
    // break that test against a file that can no longer be corrected.
    expect([...PORTFOLIO_OFF_BOARD_STAGE_ALIASES]).toEqual([
      "hold",
      "hold (legacy)",
      "lost / cancelled (legacy)",
      "lost/cancelled",
      "lost/cancelled (legacy)",
    ]);
  });

  it("cannot move an unrecognised slash stage ONTO the board", () => {
    // The compact-slash lookup widens matching toward keys that already exist, and no BOARD alias key
    // contains a slash — so the only verdict it can change is relevant -> off-board. Migration 0217
    // relies on that: it only ever flips the flag true -> false.
    for (const stage of ["Design / Build", "Service / Warranty", "Won / Signed"]) {
      expect(isPortfolioProjectBoardStage(stage)).toBe(false);
      expect(isPortfolioProjectOffBoardStage(stage)).toBe(false);
      expect(isPortfolioProjectBoardRelevantStage(stage)).toBe(true);
    }
    for (const stage of PORTFOLIO_PROJECT_BOARD_STAGES) {
      expect(stage).not.toContain("/");
    }
  });
});
