import { describe, expect, it } from "vitest";
import {
  MARKETING_EXPENSE_COST_FIELDS,
  isMarketingExpensePaymentMethod,
  isMarketingExpenseAttachmentKind,
  parseMoneyInput,
  sumMoneyForDisplay,
  formatDateOnly,
  MARKETING_EXPENSE_APPROVER_GROUP_KEY,
} from "./marketing-expense.js";
import { NOTIFICATION_RECIPIENT_GROUPS } from "./notification-recipient-groups.js";

describe("parseMoneyInput", () => {
  it("coerces an empty CurrencyInput to zero — the form's cleared state is not an error", () => {
    expect(parseMoneyInput("")).toEqual({ ok: true, value: "0" });
    expect(parseMoneyInput("   ")).toEqual({ ok: true, value: "0" });
    expect(parseMoneyInput(undefined)).toEqual({ ok: true, value: "0" });
    expect(parseMoneyInput(null)).toEqual({ ok: true, value: "0" });
  });

  it("passes plain dollar amounts through as STRINGS, never as floats", () => {
    expect(parseMoneyInput("4250")).toEqual({ ok: true, value: "4250" });
    expect(parseMoneyInput("4250.75")).toEqual({ ok: true, value: "4250.75" });
    expect(parseMoneyInput("0.05")).toEqual({ ok: true, value: "0.05" });
    expect(parseMoneyInput(" 12.30 ")).toEqual({ ok: true, value: "12.30" });
  });

  it("accepts a JSON number without ever going through parseFloat arithmetic", () => {
    expect(parseMoneyInput(4250)).toEqual({ ok: true, value: "4250" });
    expect(parseMoneyInput(4250.75)).toEqual({ ok: true, value: "4250.75" });
  });

  it("rejects a negative amount — the DB CHECK would otherwise surface as a 500", () => {
    expect(parseMoneyInput("-1")).toEqual({ ok: false, reason: "negative" });
    expect(parseMoneyInput(-0.01)).toEqual({ ok: false, reason: "negative" });
  });

  it("rejects exponent notation, which numeric(14,2) accepts and no human typed", () => {
    expect(parseMoneyInput("1e3")).toEqual({ ok: false, reason: "format" });
    expect(parseMoneyInput("1E3")).toEqual({ ok: false, reason: "format" });
    expect(parseMoneyInput(1e21)).toEqual({ ok: false, reason: "format" });
  });

  it("rejects more than two decimal places rather than letting Postgres round silently", () => {
    expect(parseMoneyInput("1.234")).toEqual({ ok: false, reason: "format" });
  });

  it("rejects anything that is not a number at all", () => {
    expect(parseMoneyInput("abc")).toEqual({ ok: false, reason: "format" });
    expect(parseMoneyInput("$100")).toEqual({ ok: false, reason: "format" });
    expect(parseMoneyInput("1,000")).toEqual({ ok: false, reason: "format" });
    expect(parseMoneyInput(Number.NaN)).toEqual({ ok: false, reason: "format" });
    expect(parseMoneyInput(Number.POSITIVE_INFINITY)).toEqual({ ok: false, reason: "format" });
    expect(parseMoneyInput(true as unknown as string)).toEqual({ ok: false, reason: "format" });
  });

  it("rejects an amount too wide for numeric(14,2)", () => {
    expect(parseMoneyInput("1234567890123")).toEqual({ ok: false, reason: "format" });
  });
});

describe("sumMoneyForDisplay", () => {
  // DISPLAY only. The authoritative total is computed in SQL; this exists so the form can show a running
  // figure, and it must not drift from the SQL sum on the cases a person will actually type.
  it("adds cents exactly where a float would not", () => {
    expect(sumMoneyForDisplay(["0.1", "0.2"])).toBe("0.30");
    expect(sumMoneyForDisplay(["1.10", "2.20", "3.30"])).toBe("6.60");
  });

  it("treats blanks and unparseable entries as zero so the running total never reads NaN", () => {
    expect(sumMoneyForDisplay(["", "  ", "5"])).toBe("5.00");
    expect(sumMoneyForDisplay(["abc", "5"])).toBe("5.00");
    expect(sumMoneyForDisplay([])).toBe("0.00");
  });

  it("never returns a negative running total", () => {
    expect(sumMoneyForDisplay(["-5", "1"])).toBe("1.00");
  });
});

describe("enum guards", () => {
  it("names all eight cost fields, which is what the SQL total sums", () => {
    expect(MARKETING_EXPENSE_COST_FIELDS).toHaveLength(8);
  });

  it("accepts only documented payment methods", () => {
    expect(isMarketingExpensePaymentMethod("invoice_ap")).toBe(true);
    expect(isMarketingExpensePaymentMethod("company_card")).toBe(true);
    expect(isMarketingExpensePaymentMethod("reimbursement")).toBe(true);
    expect(isMarketingExpensePaymentMethod("crypto")).toBe(false);
    expect(isMarketingExpensePaymentMethod("")).toBe(false);
  });

  it("accepts only documented attachment kinds", () => {
    expect(isMarketingExpenseAttachmentKind("quote_proposal")).toBe(true);
    expect(isMarketingExpenseAttachmentKind("receipts")).toBe(false);
  });
});

describe("formatDateOnly", () => {
  // `needed_by` is a Postgres `date`, which arrives as "YYYY-MM-DD". `new Date("2026-10-01")` parses that
  // as midnight UTC, so `toLocaleDateString()` in any US zone renders SEPTEMBER 30 — a deadline shown a day
  // early. This repo has shipped that bug before; the fix is to never build an instant from a date-only
  // value in the first place.
  it("renders the calendar day it was given, in every negative-offset zone", () => {
    const original = process.env.TZ;
    for (const zone of ["America/Chicago", "America/Los_Angeles", "UTC", "Pacific/Auckland"]) {
      process.env.TZ = zone;
      expect(formatDateOnly("2026-10-01")).toContain("2026");
      expect(formatDateOnly("2026-10-01")).toContain("10");
      expect(formatDateOnly("2026-10-01")).not.toContain("9/30");
    }
    process.env.TZ = original;
  });

  it("keeps the first of the month on the first of the month", () => {
    expect(formatDateOnly("2026-01-01")).toBe(new Date(2026, 0, 1).toLocaleDateString());
  });

  it("tolerates a full ISO timestamp by taking its date part", () => {
    expect(formatDateOnly("2026-10-01T00:00:00.000Z")).toBe(new Date(2026, 9, 1).toLocaleDateString());
  });

  it("renders an em dash for nothing at all", () => {
    expect(formatDateOnly(null)).toBe("—");
    expect(formatDateOnly(undefined)).toBe("—");
    expect(formatDateOnly("")).toBe("—");
    expect(formatDateOnly("not a date")).toBe("—");
  });
});

describe("the approver group is a permission, not a mailing list", () => {
  const group = NOTIFICATION_RECIPIENT_GROUPS.find(
    (entry) => entry.key === MARKETING_EXPENSE_APPROVER_GROUP_KEY,
  );

  it("restricts who may be assigned to it", () => {
    // Unset means "any active user", which is right for a subscription like the bid due date report. This
    // group decides who is ASKED to approve company spend, and the queue and decide endpoints admit only
    // admins and directors — so an unrestricted list lets an admin tick a rep who then receives the mail,
    // follows the link and is refused, while the request sits pending with nobody able to act.
    expect(group?.assignableRoles).toEqual(["admin", "director"]);
  });

  it("does not widen to the whole leadership team when emptied", () => {
    // The fallback is what makes an empty list dangerous elsewhere; here an empty list is a refused submit
    // that names the admin page, which is the outcome we want.
    expect(group?.fallbackToAdminsAndDirectors).toBe(false);
  });
});
