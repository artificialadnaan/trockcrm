import {
  compactMoney,
  heroBasisLines,
  lastWeekIsInProgress,
  sparklineSummary,
  deltaChip,
  departmentCountLabel,
  departmentEvidenceMetric,
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
    expect(deltaChip({ deltaCountWoW: 3, deferred: false }, week)).toEqual({ label: "+3 WoW", tone: "up" });
    expect(deltaChip({ deltaCountWoW: -2, deferred: false }, week)).toEqual({
      label: "-2 WoW",
      tone: "down",
    });
  });

  it("shows an unsigned zero as flat, not as an increase", () => {
    expect(deltaChip({ deltaCountWoW: 0, deferred: false }, week)).toEqual({ label: "0 WoW", tone: "flat" });
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

describe("compact money at the suffix boundaries", () => {
  it("promotes a rounded value into the next unit", () => {
    // The suffix used to be chosen BEFORE rounding, so 999_999 became "$1000k" — four digits, at the
    // boundary a real report total is most likely to sit on.
    expect(compactMoney(999_999)).toBe("$1M");
    expect(compactMoney(999_950)).toBe("$1M");
    expect(compactMoney(999)).toBe("$999");
    expect(compactMoney(1_000)).toBe("$1k");
  });

  it("still abbreviates normally either side of a boundary", () => {
    expect(compactMoney(994_000)).toBe("$994k");
    expect(compactMoney(1_050_000)).toBe("$1.1M");
  });
});

describe("which value basis belongs to which hero figure", () => {
  const won = { label: "Won", basisLabel: "Awarded-first won value" };
  const sent = { label: "Sent", basisLabel: "Best current estimate" };
  const est = { label: "Estimated", basisLabel: "Best current estimate" };

  it("attributes each DISTINCT basis to the metrics that use it", () => {
    // The bug: only Won's label was printed, under all three figures — one caption for a row counted
    // three different ways.
    expect(heroBasisLines([won, sent, est])).toEqual([
      "Won: Awarded-first won value",
      "Sent & Estimated: Best current estimate",
    ]);
  });

  it("says a shared basis once, unattributed", () => {
    // Naming all three metrics to say the same thing about each is worse than saying it once.
    expect(heroBasisLines([won, { ...sent, basisLabel: won.basisLabel }])).toEqual([
      "Awarded-first won value",
    ]);
  });

  it("renders nothing rather than an empty caption when the server sends no basis", () => {
    expect(heroBasisLines([{ label: "Won", basisLabel: "" }])).toEqual([]);
    expect(heroBasisLines([])).toEqual([]);
  });
});

describe("the last sparkline bucket is a week in progress", () => {
  it("is partial in every mode but completed", () => {
    // computeWeeklyTrend anchors the final bucket to the current Sunday and caps it at today, so on a
    // Tuesday it holds two days against its neighbours' seven.
    expect(lastWeekIsInProgress("to_date")).toBe(true);
    expect(lastWeekIsInProgress("mtd")).toBe(true);
    expect(lastWeekIsInProgress("ytd")).toBe(true);
  });

  it("is a whole week in completed, which returns the prior Sun-Sat", () => {
    expect(lastWeekIsInProgress("completed")).toBe(false);
  });
});

describe("the eight-week shape, for anyone who cannot see the bars", () => {
  it("reads the direction off the COMPLETED weeks and reports the partial one separately", () => {
    // Including the partial week in the comparison would report the same false decline the solid bar
    // used to draw.
    expect(sparklineSummary([2, 4, 6, 8, 1], { lastInProgress: true })).toBe(
      "4-week trend: 2 to 8, rising. This week so far: 1",
    );
  });

  it("uses every week when the last one is whole", () => {
    expect(sparklineSummary([8, 6, 4, 2], { lastInProgress: false })).toBe(
      "4-week trend: 8 to 2, falling",
    );
  });

  it("says level rather than inventing a direction", () => {
    expect(sparklineSummary([5, 9, 5], { lastInProgress: false })).toBe("3-week trend: 5 to 5, level");
  });

  it("returns null when there is nothing to describe", () => {
    // A summary of one data point is not a trend, and an empty string would announce as a blank line.
    expect(sparklineSummary([], { lastInProgress: false })).toBeNull();
    expect(sparklineSummary([4], { lastInProgress: false })).toBeNull();
    expect(sparklineSummary([4, 7], { lastInProgress: true })).toBeNull();
  });
});

describe("which evidence cohort a department card opens", () => {
  it("maps each measured department to its cohort", () => {
    expect(departmentEvidenceMetric({ key: "won", deferred: false })).toBe("won");
    expect(departmentEvidenceMetric({ key: "sent", deferred: false })).toBe("sent");
  });

  it("knows estimating is backed by the ESTIMATED cohort", () => {
    // The two vocabularies differ. Guessing the metric from the label would have sent this card at a
    // metric name the server rejects — or worse, one it accepts and answers differently.
    expect(departmentEvidenceMetric({ key: "estimating", deferred: false })).toBe("estimated");
  });

  it("gives a deferred department nothing to open", () => {
    // `collected` has no number on the card, so there is no cohort behind it and the card must not
    // offer a drill that lands on an empty list.
    expect(departmentEvidenceMetric({ key: "collected", deferred: true })).toBeNull();
    expect(departmentEvidenceMetric({ key: "collected", deferred: false })).toBeNull();
  });

  it("refuses a department it does not recognise rather than guessing", () => {
    // A key the server adds tomorrow is not drillable until this map is taught it — not drilled into
    // whichever cohort happens to sort first.
    expect(departmentEvidenceMetric({ key: "brand_new_thing", deferred: false })).toBeNull();
  });
});
