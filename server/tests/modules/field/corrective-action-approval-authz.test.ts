import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import {
  assertCorrectiveActionApprover,
  canApproveCorrectiveActions,
  parseApproveItemIds,
  parseRejectionComment,
  MAX_REJECTION_COMMENT_LENGTH,
} from "../../../src/modules/field/corrective-action-approval-routes.js";

const req = (email: string | null, id = "user-1") =>
  ({ user: { id, email, displayName: "James Helms" } }) as unknown as Request;

const env = (over: Record<string, string> = {}) =>
  ({ NODE_ENV: "production", ...over }) as unknown as NodeJS.ProcessEnv;

describe("assertCorrectiveActionApprover", () => {
  it("authorizes an allowlisted user and returns the actor to stamp on the event", () => {
    const actor = assertCorrectiveActionApprover(
      req("james@trockgc.com"),
      env({ QC_APPROVER_EMAILS: "james@trockgc.com" }),
    );
    expect(actor).toEqual({ userId: "user-1", name: "James Helms", email: "james@trockgc.com" });
  });

  it("matches case-insensitively", () => {
    expect(() =>
      assertCorrectiveActionApprover(req("JAMES@TrockGC.com"), env({ QC_APPROVER_EMAILS: "james@trockgc.com" })),
    ).not.toThrow();
  });

  it("403s anyone not on the list", () => {
    expect(() =>
      assertCorrectiveActionApprover(req("someone@trockgc.com"), env({ QC_APPROVER_EMAILS: "james@trockgc.com" })),
    ).toThrow(/not authorized/i);
  });

  it("FAILS CLOSED when the allowlist is unset — nobody approves, and it does not fall back to a role", () => {
    // The single most important behaviour here. A role fallback would silently grant exactly the authority
    // the allowlist exists to withhold, and it would do so to everyone holding that role.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const value of [undefined, "", "  , ,"]) {
        const e = value === undefined ? env() : env({ QC_APPROVER_EMAILS: value });
        expect(() => assertCorrectiveActionApprover(req("james@trockgc.com"), e)).toThrow(
          /approval is not configured/i,
        );
      }
      // And it says why, so a misconfiguration is diagnosable rather than mysterious.
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("401s an unauthenticated caller before consulting the allowlist", () => {
    expect(() =>
      assertCorrectiveActionApprover({} as Request, env({ QC_APPROVER_EMAILS: "james@trockgc.com" })),
    ).toThrow(/not authenticated/i);
  });

  it("403s a user with no email even when the list is configured", () => {
    expect(() =>
      assertCorrectiveActionApprover(req(null), env({ QC_APPROVER_EMAILS: "james@trockgc.com" })),
    ).toThrow(/not authorized/i);
  });
});

describe("canApproveCorrectiveActions", () => {
  it("mirrors the gate without throwing, for rendering the controls", () => {
    expect(
      canApproveCorrectiveActions(req("james@trockgc.com"), env({ QC_APPROVER_EMAILS: "james@trockgc.com" })),
    ).toBe(true);
    expect(
      canApproveCorrectiveActions(req("other@trockgc.com"), env({ QC_APPROVER_EMAILS: "james@trockgc.com" })),
    ).toBe(false);
    // Unconfigured => nobody, matching the server gate rather than optimistically showing controls.
    expect(canApproveCorrectiveActions(req("james@trockgc.com"), env())).toBe(false);
  });
});

describe("request parsing", () => {
  it("treats an absent itemIds as approve-all, and rejects a malformed one", () => {
    expect(parseApproveItemIds({})).toBeUndefined();
    expect(parseApproveItemIds({ itemIds: null })).toBeUndefined();
    expect(parseApproveItemIds({ itemIds: ["a", "a", "b"] })).toEqual(["a", "b"]);
    expect(() => parseApproveItemIds({ itemIds: "a" })).toThrow(/must be an array/i);
    expect(() => parseApproveItemIds({ itemIds: [] })).toThrow(/at least one/i);
    expect(() => parseApproveItemIds({ itemIds: ["", "  "] })).toThrow(/at least one/i);
  });

  it("requires a non-empty, bounded rejection comment", () => {
    expect(parseRejectionComment({ comment: "  Re-torque the anchors.  " })).toBe("Re-torque the anchors.");
    for (const bad of [undefined, null, "", "   ", 42]) {
      expect(() => parseRejectionComment({ comment: bad })).toThrow(/needs a comment/i);
    }
    expect(() =>
      parseRejectionComment({ comment: "x".repeat(MAX_REJECTION_COMMENT_LENGTH + 1) }),
    ).toThrow(/cannot exceed/i);
    expect(parseRejectionComment({ comment: "x".repeat(MAX_REJECTION_COMMENT_LENGTH) })).toHaveLength(
      MAX_REJECTION_COMMENT_LENGTH,
    );
  });

  it("NEVER discloses the allowlist itself — only the boolean", () => {
    // The allowlist is authorization config. A UI that received it would be telling every CRM user exactly
    // who can sign off, and would invite the client to re-derive a gate that must stay server-authoritative.
    const capability = canApproveCorrectiveActions(
      req("james@trockgc.com"),
      env({ QC_APPROVER_EMAILS: "james@trockgc.com,someone@trockgc.com" }),
    );
    expect(typeof capability).toBe("boolean");
    expect(JSON.stringify({ canApproveCorrectiveActions: capability })).not.toContain("@");
  });
});
