import { describe, it, expect } from "vitest";
import {
  parseReviewerEmails,
  resolveRfpReviewerEmails,
  isRfpReviewerEmail,
  DEFAULT_NON_PROD_RFP_REVIEWER,
} from "@trock-crm/shared/lib/rfpReviewerEmails";

describe("parseReviewerEmails", () => {
  it("splits, trims, and de-dupes case-insensitively (keeping first spelling)", () => {
    expect(
      parseReviewerEmails("Takashi@trock.com, adam@trock.com , TAKASHI@trock.com")
    ).toEqual(["Takashi@trock.com", "adam@trock.com"]);
  });

  it("returns [] for empty, whitespace, or undefined input", () => {
    expect(parseReviewerEmails(undefined)).toEqual([]);
    expect(parseReviewerEmails(null)).toEqual([]);
    expect(parseReviewerEmails("   ")).toEqual([]);
    expect(parseReviewerEmails(",, ,")).toEqual([]);
  });
});

describe("resolveRfpReviewerEmails", () => {
  it("uses RFP_REJECTION_EMAIL_RECIPIENTS when set", () => {
    expect(
      resolveRfpReviewerEmails({
        NODE_ENV: "production",
        RFP_REJECTION_EMAIL_RECIPIENTS: "takashi@trock.com, adam@trock.com",
      })
    ).toEqual(["takashi@trock.com", "adam@trock.com"]);
  });

  it("falls back to the dev address in dev/test when unset", () => {
    expect(resolveRfpReviewerEmails({ NODE_ENV: "test" })).toEqual([
      DEFAULT_NON_PROD_RFP_REVIEWER,
    ]);
    expect(resolveRfpReviewerEmails({ NODE_ENV: "development" })).toEqual([
      DEFAULT_NON_PROD_RFP_REVIEWER,
    ]);
  });

  it("returns [] in production when unset (fail closed)", () => {
    expect(resolveRfpReviewerEmails({ NODE_ENV: "production" })).toEqual([]);
  });
});

describe("isRfpReviewerEmail", () => {
  const env = {
    NODE_ENV: "production",
    RFP_REJECTION_EMAIL_RECIPIENTS: "takashi@trock.com, adam@trock.com",
  };

  it("is true for a listed reviewer (case-insensitive, trimmed)", () => {
    expect(isRfpReviewerEmail("TAKASHI@trock.com", env)).toBe(true);
    expect(isRfpReviewerEmail("  adam@trock.com ", env)).toBe(true);
  });

  it("is false for a non-listed user (e.g. an admin who isn't a reviewer)", () => {
    expect(isRfpReviewerEmail("someadmin@trock.com", env)).toBe(false);
  });

  it("is false for empty/missing email", () => {
    expect(isRfpReviewerEmail("", env)).toBe(false);
    expect(isRfpReviewerEmail(null, env)).toBe(false);
    expect(isRfpReviewerEmail(undefined, env)).toBe(false);
  });

  it("denies everyone in a misconfigured production (env unset)", () => {
    expect(isRfpReviewerEmail("takashi@trock.com", { NODE_ENV: "production" })).toBe(false);
  });
});
