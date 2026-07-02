import { describe, it, expect } from "vitest";
import {
  parseVoterEmails,
  resolveRfpVoterEmails,
  isRfpVoterEmail,
  DEFAULT_NON_PROD_RFP_VOTER,
} from "@trock-crm/shared/lib/rfpVoterEmails";

describe("parseVoterEmails", () => {
  it("splits, trims, and de-dupes case-insensitively (keeping first spelling)", () => {
    expect(
      parseVoterEmails("Sidney@trock.com, tim@trock.com , SIDNEY@trock.com"),
    ).toEqual(["Sidney@trock.com", "tim@trock.com"]);
  });

  it("returns [] for empty, whitespace, or undefined input", () => {
    expect(parseVoterEmails(undefined)).toEqual([]);
    expect(parseVoterEmails(null)).toEqual([]);
    expect(parseVoterEmails("   ")).toEqual([]);
    expect(parseVoterEmails(",, ,")).toEqual([]);
  });
});

describe("resolveRfpVoterEmails", () => {
  it("uses RFP_VOTER_EMAILS when set", () => {
    expect(
      resolveRfpVoterEmails({
        NODE_ENV: "production",
        RFP_VOTER_EMAILS: "sidney@trock.com, tim@trock.com, james@trock.com",
      }),
    ).toEqual(["sidney@trock.com", "tim@trock.com", "james@trock.com"]);
  });

  it("falls back to the dev address in dev/test when unset", () => {
    expect(resolveRfpVoterEmails({ NODE_ENV: "test" })).toEqual([DEFAULT_NON_PROD_RFP_VOTER]);
    expect(resolveRfpVoterEmails({ NODE_ENV: "development" })).toEqual([DEFAULT_NON_PROD_RFP_VOTER]);
  });

  it("returns [] in production when unset (fail closed)", () => {
    expect(resolveRfpVoterEmails({ NODE_ENV: "production" })).toEqual([]);
  });
});

describe("isRfpVoterEmail", () => {
  const env = {
    NODE_ENV: "production",
    RFP_VOTER_EMAILS: "sidney@trock.com, tim@trock.com, james@trock.com",
  };

  it("is true for a listed voter (case-insensitive, trimmed)", () => {
    expect(isRfpVoterEmail("SIDNEY@trock.com", env)).toBe(true);
    expect(isRfpVoterEmail("  james@trock.com ", env)).toBe(true);
  });

  it("is false for a non-listed user (e.g. an admin who isn't a voter)", () => {
    expect(isRfpVoterEmail("someadmin@trock.com", env)).toBe(false);
  });

  it("is false for empty/missing email", () => {
    expect(isRfpVoterEmail("", env)).toBe(false);
    expect(isRfpVoterEmail(null, env)).toBe(false);
    expect(isRfpVoterEmail(undefined, env)).toBe(false);
  });

  it("denies everyone in a misconfigured production (env unset)", () => {
    expect(isRfpVoterEmail("sidney@trock.com", { NODE_ENV: "production" })).toBe(false);
  });
});
