import { photoMonthOptions, photoMonthOptionsSince } from "../field-projects";

/**
 * photoMonthOptions builds the gallery's server-side date window.
 *
 * It matters more than a formatting helper normally would: on a project past the page ceiling, this is
 * the ONLY control that can reach an older photo at all (the category/tag/uploader filters run
 * client-side over what was loaded), and a bound that is off by a day drops or duplicates a whole
 * workday's photos at the edge of the range.
 */
describe("photoMonthOptions", () => {
  it("returns the current month first, then walks backwards", () => {
    const options = photoMonthOptions(new Date(2026, 8, 18), 4); // 18 Sep 2026, local
    expect(options.map((o) => o.key)).toEqual(["2026-09", "2026-08", "2026-07", "2026-06"]);
    expect(options[0].label).toBe("Sep 2026");
  });

  it("bounds each month inclusively, first day to last", () => {
    const [sep] = photoMonthOptions(new Date(2026, 8, 18), 1);
    expect(sep.from).toBe("2026-09-01");
    expect(sep.to).toBe("2026-09-30"); // 30, not 31
  });

  it("gets February right, including leap years", () => {
    const [feb2027] = photoMonthOptions(new Date(2027, 1, 10), 1);
    expect(feb2027.to).toBe("2027-02-28");
    const [feb2028] = photoMonthOptions(new Date(2028, 1, 10), 1);
    expect(feb2028.to).toBe("2028-02-29");
  });

  it("crosses the year boundary", () => {
    const options = photoMonthOptions(new Date(2026, 0, 15), 3); // Jan 2026
    expect(options.map((o) => o.key)).toEqual(["2026-01", "2025-12", "2025-11"]);
    expect(options[1].to).toBe("2025-12-31");
  });

  /**
   * The month-arithmetic trap: stepping months from a date whose DAY does not exist in the target month
   * overflows. Constructing from Mar 31 and subtracting a month yields Mar 3 (Feb 31 -> Mar 3), which
   * would emit two March entries and never offer February.
   */
  it("does not overflow when today is a day the previous month lacks", () => {
    const options = photoMonthOptions(new Date(2026, 2, 31), 3); // 31 Mar 2026
    expect(options.map((o) => o.key)).toEqual(["2026-03", "2026-02", "2026-01"]);
  });

  it("emits no duplicate months over a long window", () => {
    const options = photoMonthOptions(new Date(2026, 2, 31), 24);
    expect(new Set(options.map((o) => o.key)).size).toBe(24);
  });

  /**
   * Bounds come from LOCAL calendar parts. The server and toDayString both bucket a photo by its local
   * day, so deriving these from UTC (e.g. toISOString().slice(0,10)) would shift each boundary by the
   * offset — on a negative offset, `new Date(2026,8,1).toISOString()` is already 2026-08-31.
   */
  it("derives bounds from LOCAL calendar parts, not a UTC conversion", () => {
    const today = new Date(2026, 8, 18);
    const [sep] = photoMonthOptions(today, 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    // TZ-independent: the bound must be the 1st of TODAY'S LOCAL month, whatever zone this runs in.
    expect(sep.from).toBe(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`);

    // And where the two spellings can disagree, ours must be the local one. `new Date(y,m,1)` is local
    // midnight; in a zone AHEAD of UTC that instant is still the previous month in UTC, so a refactor to
    // toISOString().slice(0,10) would emit "2026-08-31" as September's start and quietly pull a day of
    // August's photos into every September report. getTimezoneOffset() is NEGATIVE ahead of UTC.
    const utcSliced = new Date(2026, 8, 1).toISOString().slice(0, 10);
    if (new Date(2026, 8, 1).getTimezoneOffset() < 0) {
      expect(utcSliced).not.toBe(sep.from);
    } else {
      // Behind or at UTC the two agree, so this machine cannot distinguish them — recorded so a green
      // run here is not mistaken for proof that a UTC-based implementation would be safe.
      expect(utcSliced).toBe(sep.from);
    }
  });

  /**
   * A STRUCTURAL assertion, because the outcome is unobservable where this runs.
   *
   * Deriving a bound with `toISOString().slice(0,10)` is correct in every zone at or behind UTC — this
   * machine (UTC-5) and GitHub Actions (UTC) included — and wrong only ahead of it, where local midnight
   * on the 1st is still the previous month in UTC. Measured: with the helper mutated to the UTC
   * spelling, this suite stays 8/8 green here and fails under TZ=Asia/Tokyo with "2026-08-31".
   *
   * So a result-only test cannot catch the regression in the places it actually runs, and pinning the
   * zone per-file does not work either (Node resolves TZ before jest evaluates the module; an attempt
   * setting process.env.TZ here was vacuous). What IS observable everywhere is that the helper never
   * reaches for a UTC conversion. Same reasoning as the indexability assertion on the photo-timeline
   * predicate: assert the mechanism when the outcome cannot distinguish right from wrong.
   */
  it("never routes a bound through a UTC conversion", () => {
    const toISOString = jest.spyOn(Date.prototype, "toISOString");
    try {
      const options = photoMonthOptions(new Date(2026, 8, 18), 12);
      expect(options).toHaveLength(12);
      expect(toISOString).not.toHaveBeenCalled();
    } finally {
      toISOString.mockRestore();
    }
  });

  it("defaults to twelve months", () => {
    expect(photoMonthOptions(new Date(2026, 8, 18))).toHaveLength(12);
  });

  describe("photoMonthOptionsSince", () => {
    it("spans from the project's earliest photo to today, inclusive of both months", () => {
      const options = photoMonthOptionsSince(new Date(2026, 8, 18), "2026-06-26T12:00:00Z");
      expect(options.map((o) => o.key)).toEqual(["2026-09", "2026-08", "2026-07", "2026-06"]);
    });

    it("offers a single month when the project started this month", () => {
      const options = photoMonthOptionsSince(new Date(2026, 8, 18), "2026-09-02T12:00:00Z");
      expect(options.map((o) => o.key)).toEqual(["2026-09"]);
    });

    it("reaches years back — the case a fixed twelve-month list could never show", () => {
      const options = photoMonthOptionsSince(new Date(2026, 8, 18), "2023-01-05T12:00:00Z");
      expect(options).toHaveLength(45); // Jan 2023 .. Sep 2026 inclusive
      expect(options[options.length - 1].key).toBe("2023-01");
    });

    it("counts months by calendar, not by dividing a duration", () => {
      // 30-day months and DST make a millisecond-based count drift; across this span a naive
      // (ms / 30 days) would land a month short and silently hide the earliest month.
      const options = photoMonthOptionsSince(new Date(2026, 8, 18), "2025-03-09T12:00:00Z");
      expect(options[options.length - 1].key).toBe("2025-03");
    });

    it("caps a very long project rather than growing without limit", () => {
      const options = photoMonthOptionsSince(new Date(2026, 8, 18), "1999-01-01T00:00:00Z", 24);
      expect(options).toHaveLength(24);
    });

    it("falls back to twelve months when the server reported no earliest photo", () => {
      expect(photoMonthOptionsSince(new Date(2026, 8, 18), null)).toHaveLength(12);
      expect(photoMonthOptionsSince(new Date(2026, 8, 18), undefined)).toHaveLength(12);
      expect(photoMonthOptionsSince(new Date(2026, 8, 18), "not-a-date")).toHaveLength(12);
    });

    it("never returns an empty list, even if the earliest photo is somehow in the future", () => {
      const options = photoMonthOptionsSince(new Date(2026, 8, 18), "2027-01-01T00:00:00Z");
      expect(options.length).toBeGreaterThan(0);
      expect(options[0].key).toBe("2026-09");
    });
  });
});
