import { describe, expect, it } from "vitest";
import { canPublishWeeklyReport } from "./reports-service.js";
import { isWeeklyReportOfficeSlug } from "./office-connection.js";
import { isWeeklyReportShareableStatus } from "./tokens-service.js";

// The three rules that decide whether something reaches a client, kept in one place because they are the
// ones a reviewer will want to read together: WHO may publish, WHAT may be published, and WHERE the public
// reader is allowed to look.

const PM = "pm-1";
const SUPER = "super-1";
const PROJECT = { trock_pm_user_id: PM, trock_super_user_id: SUPER };

describe("canPublishWeeklyReport", () => {
  it("lets the assigned PM issue a client link", () => {
    expect(canPublishWeeklyReport(PROJECT, { id: PM, role: "construction" })).toBe(true);
  });

  it("lets leadership publish without being the assigned PM", () => {
    expect(canPublishWeeklyReport(PROJECT, { id: "someone", role: "director" })).toBe(true);
    expect(canPublishWeeklyReport(PROJECT, { id: "someone", role: "admin" })).toBe(true);
  });

  it("does NOT let the superintendent publish their own work", () => {
    // Minting the 180-day unauthenticated URL IS the act of publication, so it takes the same check as
    // moving the report to `sent`. Gating it any lower routes around the PM gate rather than enforcing it.
    expect(canPublishWeeklyReport(PROJECT, { id: SUPER, role: "construction" })).toBe(false);
  });

  it("does NOT let an unrelated rep publish another team's report", () => {
    expect(canPublishWeeklyReport(PROJECT, { id: "rep-1", role: "rep" })).toBe(false);
  });

  it("treats an unassigned PM slot as nobody, not as everybody", () => {
    expect(canPublishWeeklyReport({ trock_pm_user_id: null }, { id: "anyone", role: "rep" })).toBe(false);
    // A null id must not match a null slot — the classic way this kind of check goes wrong.
    expect(canPublishWeeklyReport({ trock_pm_user_id: null }, { id: null as never, role: "rep" })).toBe(false);
  });
});

describe("isWeeklyReportShareableStatus", () => {
  it("admits only a report the PM has approved or sent", () => {
    expect(isWeeklyReportShareableStatus("approved")).toBe(true);
    expect(isWeeklyReportShareableStatus("sent")).toBe(true);
  });

  it("refuses a draft and a report back in review", () => {
    // `approved -> pending_review` is a transition the assigned superintendent may make alone, and a report
    // in `pending_review` is one they may then rewrite. This predicate is applied on EVERY public request
    // precisely so that pulling a report back takes its link dark with it.
    expect(isWeeklyReportShareableStatus("draft")).toBe(false);
    expect(isWeeklyReportShareableStatus("pending_review")).toBe(false);
  });

  it("refuses anything it does not recognise", () => {
    for (const value of [null, undefined, "", "APPROVED", "sent ", 1, {}]) {
      expect(isWeeklyReportShareableStatus(value)).toBe(false);
    }
  });
});

describe("isWeeklyReportOfficeSlug", () => {
  it("accepts a real office slug", () => {
    expect(isWeeklyReportOfficeSlug("dallas")).toBe(true);
    expect(isWeeklyReportOfficeSlug("fort_worth2")).toBe(true);
  });

  it("refuses anything that could become SQL structure", () => {
    // The slug is concatenated into `office_${slug}` for search_path — the one value in this feature that
    // becomes structure rather than a bound parameter.
    for (const value of ["Dallas", "dallas;drop", "dallas,public", "public--", "1office", "", " dallas", null, 7]) {
      expect(isWeeklyReportOfficeSlug(value)).toBe(false);
    }
  });
});
