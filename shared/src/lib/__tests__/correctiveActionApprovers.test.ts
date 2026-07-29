import { describe, it, expect } from "vitest";
import {
  DEFAULT_NON_PROD_QC_APPROVER,
  isCorrectiveActionApprover,
  resolveCorrectiveActionApprovers,
} from "../correctiveActionApprovers.js";

const prod = (over: Record<string, string> = {}) =>
  ({ NODE_ENV: "production", ...over }) as unknown as NodeJS.ProcessEnv;
const dev = (over: Record<string, string> = {}) =>
  ({ NODE_ENV: "development", ...over }) as unknown as NodeJS.ProcessEnv;

describe("resolveCorrectiveActionApprovers", () => {
  it("parses, trims and de-duplicates the configured list", () => {
    expect(
      resolveCorrectiveActionApprovers(
        prod({ QC_APPROVER_EMAILS: " james@trockgc.com , JAMES@trockgc.com ,, ops@trockgc.com " }),
      ),
    ).toEqual(["james@trockgc.com", "ops@trockgc.com"]);
  });

  it("FAILS CLOSED in prod when unset or blank — nobody can approve", () => {
    // The one behaviour that must never regress: an empty list means nobody, not everybody. A role-based
    // fallback here would silently grant the authority the allowlist exists to withhold.
    expect(resolveCorrectiveActionApprovers(prod())).toEqual([]);
    expect(resolveCorrectiveActionApprovers(prod({ QC_APPROVER_EMAILS: "" }))).toEqual([]);
    expect(resolveCorrectiveActionApprovers(prod({ QC_APPROVER_EMAILS: "  , ,, " }))).toEqual([]);
  });

  it("falls back to a non-personal placeholder in dev/test only", () => {
    expect(resolveCorrectiveActionApprovers(dev())).toEqual([DEFAULT_NON_PROD_QC_APPROVER]);
    expect(
      resolveCorrectiveActionApprovers(dev({ DEV_QC_APPROVER_EMAIL: "local@example.com" })),
    ).toEqual(["local@example.com"]);
    // A configured list still wins in dev.
    expect(
      resolveCorrectiveActionApprovers(dev({ QC_APPROVER_EMAILS: "real@trockgc.com" })),
    ).toEqual(["real@trockgc.com"]);
  });
});

describe("isCorrectiveActionApprover", () => {
  const approvers = ["James@TrockGC.com", "ops@trockgc.com"];

  it("matches case-insensitively and tolerates whitespace", () => {
    expect(isCorrectiveActionApprover("james@trockgc.com", approvers)).toBe(true);
    expect(isCorrectiveActionApprover("  JAMES@TROCKGC.COM  ", approvers)).toBe(true);
  });

  it("rejects anyone not on the list, and any empty identity", () => {
    expect(isCorrectiveActionApprover("someone.else@trockgc.com", approvers)).toBe(false);
    expect(isCorrectiveActionApprover("", approvers)).toBe(false);
    expect(isCorrectiveActionApprover(null, approvers)).toBe(false);
    expect(isCorrectiveActionApprover(undefined, approvers)).toBe(false);
    expect(isCorrectiveActionApprover("   ", approvers)).toBe(false);
  });

  it("authorizes nobody against an empty allowlist", () => {
    expect(isCorrectiveActionApprover("james@trockgc.com", [])).toBe(false);
  });
});
