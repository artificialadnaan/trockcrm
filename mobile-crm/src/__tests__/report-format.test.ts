import {
  compactMoney,
  deltaChip,
  departmentCountLabel,
  showsWowDelta,
  sparklineHeights,
} from "../report-format";

describe("week-over-week deltas only where they mean something", () => {
  it("shows for week periods", () => {
    expect(showsWowDelta("to_date")).toBe(true);
    expect(showsWowDelta("completed")).toBe(true);
  });

  it("hides for month- and year-to-date", () => {
    // "Up 3 from last week" against a year-to-date total compares a year to a week. The web hides it
    // for the same reason; this is a mirror of that rule, not an independent opinion.
    expect(showsWowDelta("mtd")).toBe(false);
    expect(showsWowDelta("ytd")).toBe(false);
  });
});

describe("a deferred department is a placeholder, not a zero", () => {
  it("renders an em dash rather than inventing a number", () => {
    expect(departmentCountLabel({ count: null, deferred: true })).toBe("—");
    expect(departmentCountLabel({ count: null, deferred: false })).toBe("—");
  });

  it("renders a genuine zero as zero", () => {
    // The distinction the whole null-vs-0 rule exists for: nothing happened is a fact, and it reads
    // differently from "we do not measure this yet".
    expect(departmentCountLabel({ count: 0, deferred: false })).toBe("0");
  });

  it("renders a real count", () => {
    expect(departmentCountLabel({ count: 12, deferred: false })).toBe("12");
  });
});

describe("the delta chip", () => {
  const week = "to_date" as const;

  it("signs an increase and a decrease", () => {
    expect(deltaChip({ deltaCountWoW: 3, deferred: false }, week)).toEqual({ label: "+3", tone: "up" });
    expect(deltaChip({ deltaCountWoW: -2, deferred: false }, week)).toEqual({
      label: "-2",
      tone: "down",
    });
  });

  it("shows an unsigned zero as flat, not as an increase", () => {
    expect(deltaChip({ deltaCountWoW: 0, deferred: false }, week)).toEqual({ label: "0", tone: "flat" });
  });

  it("withholds it for three DIFFERENT reasons, none of which is falsiness", () => {
    // Meaningless period, no number to compare, and no delta sent. Collapsing these into one truthiness
    // check is how a placeholder ends up rendering "+0".
    expect(deltaChip({ deltaCountWoW: 5, deferred: false }, "ytd")).toBeNull();
    expect(deltaChip({ deltaCountWoW: null, deferred: true }, week)).toBeNull();
    expect(deltaChip({ deltaCountWoW: null, deferred: false }, week)).toBeNull();
  });
});

describe("sparkline heights", () => {
  it("scales to the tallest week, because the shape is the message", () => {
    expect(sparklineHeights([0, 5, 10])).toEqual([0, 0.5, 1]);
  });

  it("returns all zeros for a series that never moved", () => {
    // Dividing by the max would be division by zero; falling back to full-height bars would say
    // "steady and strong" about a department that did nothing.
    expect(sparklineHeights([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("survives junk in the series without producing NaN geometry", () => {
    expect(sparklineHeights([Number.NaN, 4, 8])).toEqual([0, 0.5, 1]);
    expect(sparklineHeights([])).toEqual([]);
  });
});

describe("compact money", () => {
  it("abbreviates at a glance", () => {
    expect(compactMoney(1_200_000)).toBe("$1.2M");
    expect(compactMoney(412_500)).toBe("$412.5k");
    expect(compactMoney(950)).toBe("$950");
    expect(compactMoney(0)).toBe("$0");
  });

  it("drops a meaningless decimal", () => {
    expect(compactMoney(3_000_000)).toBe("$3M");
    expect(compactMoney(5_000)).toBe("$5k");
  });

  it("keeps a negative, because a deductive change order is real money", () => {
    expect(compactMoney(-50_000)).toBe("-$50k");
  });

  it("does not render NaN as a number", () => {
    expect(compactMoney(Number.NaN)).toBe("—");
  });
});
