// The address that reaches the `inet` column, and the one that must not.
//
// `recordWeeklyReportView` swallows its own failures on purpose — a view that cannot be logged must never
// turn a client's report into an error page. That makes a bad cast expensive in a way it usually is not:
// a 22P02 does not lose the ADDRESS, it loses the whole EVENT, and `X-Forwarded-For` is chosen by the
// visitor. A link holder who wanted no record of their visit only had to send a junk address.

import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { clientIpForLog, recordWeeklyReportView } from "../../../src/modules/weekly-reports/view-log.js";

function req(forwardedFor: string | undefined, remote = "10.0.0.1"): Request {
  return {
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    socket: { remoteAddress: remote },
  } as unknown as Request;
}

describe("what gets stored as the visitor's address", () => {
  it("keeps a real IPv4 address from the front of the chain", () => {
    expect(clientIpForLog(req("73.162.44.219, 10.0.0.7"))).toBe("73.162.44.219");
  });

  it("keeps a real IPv6 address", () => {
    expect(clientIpForLog(req("2001:db8::8a2e:370:7334"))).toBe("2001:db8::8a2e:370:7334");
  });

  it.each([
    [":::", "colons only — legal characters, not an address"],
    ["1.2.3.4:8080", "an address with a port appended"],
    ["....", "dots only"],
    ["999.999.999.999", "numeric but out of range"],
    ["not-an-ip", "plain text"],
  ])("stores null for %s (%s) rather than losing the event", (value) => {
    // Each of these passed the character-class check this replaced and was then REJECTED by `inet`.
    // Null is the outcome the code always claimed to produce; what actually happened was the row
    // vanishing, and with it the fact that the fetch occurred at all.
    expect(clientIpForLog(req(value))).toBeNull();
  });

  it("falls back to the socket address when no header is present", () => {
    expect(clientIpForLog(req(undefined, "198.51.100.4"))).toBe("198.51.100.4");
  });

  it("stores null rather than a forged value when the socket address is junk too", () => {
    expect(clientIpForLog(req(undefined, "garbage"))).toBeNull();
  });
});

describe("a HEAD probe is not somebody reading the report", () => {
  it("records nothing at all for a metadata-only request", async () => {
    // Express dispatches HEAD through the matching GET handler when no HEAD route exists, so
    // `HEAD /wr/:token/pdf` reached the same logging call as a real download. A PDF or photo fetch is
    // the classifier's DEFINITIVE evidence of a person, so a monitoring probe or link checker could
    // make the audit assert that somebody at the client read a report nobody opened.
    //
    // No database is needed to prove it: if the guard is removed the call reaches `pool.query`, which
    // in this suite has no connection and rejects — and `recordWeeklyReportView` swallows that, so the
    // assertion is that nothing was ATTEMPTED rather than that nothing threw.
    const attempted: string[] = [];
    const head = {
      method: "HEAD",
      headers: { "x-forwarded-for": "73.162.44.219" },
      socket: { remoteAddress: "10.0.0.1" },
    } as unknown as Request;

    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      attempted.push(String(args[0]));
    };
    try {
      await recordWeeklyReportView(head, {
        weeklyReportId: "00000000-0000-4000-8000-000000000001",
        tokenId: null,
        tenantId: null,
        officeSlug: null,
        eventType: "pdf",
      });
    } finally {
      console.warn = originalWarn;
    }

    // A swallowed failure logs a warning. Silence means the insert was never attempted.
    expect(attempted).toEqual([]);
  });
});
