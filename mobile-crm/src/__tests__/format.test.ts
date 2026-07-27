import { mailtoUrl, phoneParts, smsUrl, telUrl } from "../contact-links";
import { daysSince, formatDate, formatLocation, formatMoney } from "../format";

describe("formatMoney", () => {
  it("formats the STRING that Postgres numeric actually sends", () => {
    // The bug this exists to prevent: money columns are `numeric`, which serialises to a string. A
    // number-typed formatter compiles fine and renders the literal text "NaN" on a phone.
    expect(formatMoney("125000.00")).toBe("$125,000");
    expect(formatMoney("0")).toBe("$0");
  });

  it("formats numbers too, for any endpoint that sends one", () => {
    expect(formatMoney(4200)).toBe("$4,200");
  });

  it.each([null, undefined, "", "not-a-number"])("renders an em dash for %p", (value) => {
    expect(formatMoney(value as string | null | undefined)).toBe("—");
  });
});

describe("formatDate", () => {
  it("renders a YYYY-MM-DD date in the LOCAL day, not UTC's", () => {
    // `new Date("2026-03-05")` is UTC midnight, which is 4 March for anyone west of Greenwich. Splitting
    // the parts is what keeps a close date from displaying a day early for every US user.
    expect(formatDate("2026-03-05")).toBe("Mar 5, 2026");
  });

  it("handles an ISO timestamp", () => {
    expect(formatDate("2026-03-05T18:30:00.000Z")).toMatch(/Mar \d, 2026/);
  });

  it.each([null, undefined, "", "garbage"])("renders an em dash for %p", (value) => {
    expect(formatDate(value as string | null)).toBe("—");
  });
});

describe("daysSince", () => {
  const now = new Date("2026-03-10T12:00:00.000Z").getTime();

  it("counts whole days", () => {
    expect(daysSince("2026-03-05T12:00:00.000Z", now)).toBe(5);
  });

  it("never returns a negative for a future timestamp", () => {
    expect(daysSince("2026-04-01T12:00:00.000Z", now)).toBe(0);
  });

  it.each([null, undefined, "nonsense"])("returns null for %p rather than a misleading 0", (value) => {
    // A fake 0 would read as "entered this stage today", which is a different and wrong claim.
    expect(daysSince(value as string | null, now)).toBeNull();
  });
});

describe("formatLocation", () => {
  it.each([
    ["Dallas", "TX", "Dallas, TX"],
    ["Dallas", null, "Dallas"],
    [null, "TX", "TX"],
    [null, null, ""],
    ["  ", "  ", ""],
  ])("formats (%p, %p) as %p", (city, state, expected) => {
    expect(formatLocation(city, state)).toBe(expected);
  });
});

describe("contact link URLs", () => {
  it.each([
    ["214-555-1212 ext 3", "2145551212", "3"],
    ["214-555-1212 ext. 3", "2145551212", "3"],
    ["214-555-1212 x104", "2145551212", "104"],
    ["(214) 555-1212 extension 22", "2145551212", "22"],
    ["214-555-1212 #45", "2145551212", "45"],
  ])("splits the extension out of %s", (input, number, extension) => {
    expect(phoneParts(input)).toEqual({ number, extension });
  });

  it.each([
    ["214-555-1212", "2145551212"],
    ["+1 (214) 555-1212", "+12145551212"],
    ["  214.555.1212  ", "2145551212"],
  ])("leaves %s alone when there is no extension", (input, number) => {
    expect(phoneParts(input)).toEqual({ number, extension: null });
  });

  it("does not fold the extension into the number", () => {
    // Stripping every non-digit produced the ELEVEN-digit 21455512123 — a different number entirely.
    // Tapping Call then dialled a stranger, with nothing on screen to say so.
    expect(telUrl("214-555-1212 ext 3")).not.toBe("tel:21455512123");
  });

  it("dials the extension after a pause", () => {
    expect(telUrl("214-555-1212 ext 3")).toBe("tel:2145551212,,3");
  });

  it("never puts an extension in an SMS URL", () => {
    // You cannot text an extension; including it would address the message to a nonexistent number.
    expect(smsUrl("214-555-1212 ext 3")).toBe("sms:2145551212");
  });

  it.each([
    ["user?tag@example.com", "mailto:user%3Ftag@example.com"],
    ["user#tag@example.com", "mailto:user%23tag@example.com"],
    ["user&co@example.com", "mailto:user%26co@example.com"],
  ])("encodes the reserved character in %s", (email, expected) => {
    // Raw interpolation makes the URL parser read everything after ? or # as a query or fragment, so the
    // composer opens addressed to "user". The server's validation accepts these addresses.
    expect(mailtoUrl(email)).toBe(expected);
  });

  it("proves the failure it prevents", () => {
    expect(new URL(`mailto:user?tag@example.com`).pathname).toBe("user");
    expect(new URL(mailtoUrl("user?tag@example.com")).pathname).toBe("user%3Ftag@example.com");
  });

  it("leaves an ordinary address readable rather than percent-encoding the @", () => {
    expect(mailtoUrl("rep@trockgc.com")).toBe("mailto:rep@trockgc.com");
  });
});

describe("openLink failure reporting", () => {
  afterEach(() => jest.resetModules());

  function withLinking(openURL: jest.Mock) {
    jest.resetModules();
    jest.doMock("react-native", () => ({ Linking: { openURL } }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../lib/open-link") as typeof import("../lib/open-link");
  }

  it("reports null when the link opens, clearing any previous failure", async () => {
    const openURL = jest.fn().mockResolvedValue(undefined);
    const { openLink } = withLinking(openURL);
    const report = jest.fn();
    await openLink("tel:2145551212", report);
    expect(openURL).toHaveBeenCalledWith("tel:2145551212");
    // NOT "never called": reporting success is what stops a one-off failure sticking on the button.
    expect(report).toHaveBeenCalledWith(null);
  });

  it.each([
    ["tel:2145551212", "call"],
    ["sms:2145551212", "text"],
    ["mailto:rep@trockgc.com", "email"],
  ])("names the action that failed for %s", async (url, verb) => {
    // The previous `.catch(() => undefined)` was a success-looking failure: the rep taps Call, nothing
    // happens, and nothing distinguishes a missing dialer from a slow one.
    const { openLink } = withLinking(jest.fn().mockRejectedValue(new Error("no handler")));
    const report = jest.fn();
    await openLink(url, report);
    expect(report).toHaveBeenCalledWith(`Couldn't ${verb} from this device.`);
  });

  it("never rethrows — a failed link must not crash the screen", async () => {
    const { openLink } = withLinking(jest.fn().mockRejectedValue(new Error("boom")));
    await expect(openLink("tel:1", jest.fn())).resolves.toBeUndefined();
  });
});

describe("format fallbacks that looked handled but were not", () => {
  it("treats a whitespace-only amount as no value, not as $0", () => {
    // Number("   ") is 0, not NaN, so it slipped past both the emptiness and the finiteness guard and
    // rendered "$0" — a confident wrong number where the em dash means "we don't have one".
    expect(formatMoney("   ")).toBe("—");
  });

  it.each([null, undefined, "", "  ", "abc"])("renders %p as an em dash", (value) => {
    expect(formatMoney(value as string | null)).toBe("—");
  });

  it("still formats a legitimate zero as $0", () => {
    // "no value" and "a value of zero" are different, and only the first gets the dash.
    expect(formatMoney("0")).toBe("$0");
    expect(formatMoney(0)).toBe("$0");
  });

  it.each([
    ["2026-02-31", "31 February"],
    ["2026-13-01", "month 13"],
    ["2026-00-10", "month 0"],
  ])("refuses %s rather than rolling it over (%s)", (value) => {
    // The regex only proves the SHAPE is digits. new Date(2026, 1, 31) silently becomes 3 March — a
    // plausible wrong date, which is worse than a dash because nothing about it looks wrong.
    expect(formatDate(value)).toBe("—");
  });

  it("formats a real date-only value without timezone drift", () => {
    // The whole reason for splitting the parts: new Date("2026-07-04") is UTC midnight, which renders
    // as 3 July for anyone west of Greenwich.
    expect(formatDate("2026-07-04")).toBe("Jul 4, 2026");
  });
});
