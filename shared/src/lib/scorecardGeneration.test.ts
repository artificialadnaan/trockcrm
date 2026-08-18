import { describe, expect, it } from "vitest";
import {
  SCORECARD_GENERATION_SQL_PREFIX,
  SCORECARD_GENERATION_SQL_SUFFIX,
  scorecardGeneration,
  scorecardGenerationEpochMicroseconds,
  scorecardGenerationSql,
  scorecardGenerationsMatch,
} from "./scorecardGeneration.js";

// The SQL these tests describe is EXECUTED against a real Postgres in
// server/tests/modules/field/scorecard-pdf-finalization.runtime.test.ts — including under a non-UTC session
// TimeZone, which is the property no string assertion can establish. What is asserted here is the
// JavaScript half: the shape the database is asked for, and the comparison built on top of it.

describe("scorecardGenerationSql", () => {
  it("is assembled from the exported prefix/suffix, so a spliced caller cannot drift from a raw-SQL one", () => {
    // The server splices these two constants around a Drizzle column object; the worker calls the function
    // with raw SQL text. Two spellings of "the canonical generation" would let the CAS bind a value it then
    // compares against a differently-formatted copy of itself.
    expect(scorecardGenerationSql("sc.updated_at")).toBe(
      `${SCORECARD_GENERATION_SQL_PREFIX}sc.updated_at${SCORECARD_GENERATION_SQL_SUFFIX}`,
    );
  });

  it("asks for six fractional digits and pins the offset to a literal Z", () => {
    // `US` is microseconds — Postgres's own timestamptz resolution, and the whole point of reading as text.
    // The offset is a literal `Z` rather than `OF` because to_char renders in the SESSION TimeZone: the
    // `AT TIME ZONE 'UTC'` ahead of it is what makes the Z true on every connection.
    const rendered = scorecardGenerationSql("updated_at");
    expect(rendered).toContain(".US");
    expect(rendered).toContain(`AT TIME ZONE 'UTC'`);
    expect(rendered).not.toContain("OF");
  });
});

describe("scorecardGeneration", () => {
  it("passes canonical text through untouched", () => {
    expect(scorecardGeneration("2026-07-27T12:00:00.123456Z")).toBe("2026-07-27T12:00:00.123456Z");
  });

  it("widens a Date with three zero microseconds", () => {
    // Honest, not lossy-in-disguise: a JS Date never had microseconds, so `.123000` is what it means. The
    // loaders must NOT rely on this — a widened Date compared against true database text reads stale on
    // every download — but a test fixture or a legacy value has nothing better.
    expect(scorecardGeneration(new Date("2026-07-27T12:00:00.123Z"))).toBe("2026-07-27T12:00:00.123000Z");
  });

  it("is null for absent or unparseable values", () => {
    expect(scorecardGeneration(null)).toBeNull();
    expect(scorecardGeneration(undefined)).toBeNull();
    expect(scorecardGeneration("not a time")).toBeNull();
    expect(scorecardGeneration(new Date("nope"))).toBeNull();
  });
});

describe("scorecardGenerationEpochMicroseconds", () => {
  it("counts microseconds, not milliseconds", () => {
    const a = scorecardGenerationEpochMicroseconds("2026-07-27T12:00:00.123456Z");
    const b = scorecardGenerationEpochMicroseconds("2026-07-27T12:00:00.123900Z");
    expect(b - a).toBe(444);
  });

  it("stays inside the safe integer range for a contemporary timestamp", () => {
    expect(scorecardGenerationEpochMicroseconds("2026-07-27T12:00:00.000000Z")).toBeLessThan(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("is NaN for anything that is not canonical", () => {
    expect(scorecardGenerationEpochMicroseconds("2026-07-27T12:00:00.123Z")).toBeNaN();
  });
});

describe("scorecardGenerationsMatch", () => {
  it("REGRESSION: two generations less than a millisecond apart do NOT match", () => {
    // The defect this module exists to close. Through millisecond values these compare EQUAL, so a PDF
    // rendered from the pre-change card classifies as current — on the download, and on the email
    // attachment — and nothing later repairs it when that change was the card's last write.
    expect(scorecardGenerationsMatch("2026-07-27T12:00:00.123456Z", "2026-07-27T12:00:00.123900Z")).toBe(false);
  });

  it("matches the same instant to the microsecond", () => {
    expect(scorecardGenerationsMatch("2026-07-27T12:00:00.123456Z", "2026-07-27T12:00:00.123456Z")).toBe(true);
  });

  it("matches a Date against its own canonical text", () => {
    expect(
      scorecardGenerationsMatch(new Date("2026-07-27T12:00:00.123Z"), "2026-07-27T12:00:00.123000Z"),
    ).toBe(true);
  });

  it("is order-insensitive — it answers SAME, not NEWER", () => {
    // Exact equality is deliberate: a scorecard's generation is one column advanced strictly forward by
    // every writer, so a stored generation AHEAD of the live one means the row moved backwards beneath the
    // artifact and those bytes no longer describe the card. Re-rendering is the right answer; an ordering
    // comparison would serve them forever.
    const older = "2026-07-27T12:00:00.123456Z";
    const newer = "2026-07-27T12:00:00.123900Z";
    expect(scorecardGenerationsMatch(newer, older)).toBe(false);
    expect(scorecardGenerationsMatch(older, newer)).toBe(false);
  });

  it("is false when either side is missing or unparseable", () => {
    expect(scorecardGenerationsMatch(null, "2026-07-27T12:00:00.123456Z")).toBe(false);
    expect(scorecardGenerationsMatch("2026-07-27T12:00:00.123456Z", undefined)).toBe(false);
    expect(scorecardGenerationsMatch("garbage", "2026-07-27T12:00:00.123456Z")).toBe(false);
  });
});
