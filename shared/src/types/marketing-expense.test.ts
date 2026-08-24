import { describe, expect, it } from "vitest";
import {
  MARKETING_EXPENSE_COST_FIELDS,
  isMarketingExpensePaymentMethod,
  isMarketingExpenseAttachmentKind,
  parseMoneyInput,
  sumMoneyForDisplay,
} from "./marketing-expense.js";

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
