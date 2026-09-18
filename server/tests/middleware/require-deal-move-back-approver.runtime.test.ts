import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireDealMoveBackApprover } from "../../src/middleware/rbac.js";

const TAKASHI = "tyamashita@trockgc.com";

function run(user: unknown) {
  const next = vi.fn();
  requireDealMoveBackApprover({ user } as never, {} as never, next);
  return next;
}

describe("requireDealMoveBackApprover (allowlist = DEAL_MOVE_BACK_APPROVER_EMAILS)", () => {
  const originalList = process.env.DEAL_MOVE_BACK_APPROVER_EMAILS;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.DEAL_MOVE_BACK_APPROVER_EMAILS = TAKASHI;
  });
  afterEach(() => {
    if (originalList === undefined) delete process.env.DEAL_MOVE_BACK_APPROVER_EMAILS;
    else process.env.DEAL_MOVE_BACK_APPROVER_EMAILS = originalList;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("allows a listed approver, case-insensitively and ignoring whitespace", () => {
    const next = run({ id: "u1", email: `  ${TAKASHI.toUpperCase()} `, role: "director" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  // The point of the change: the role floor is no longer sufficient for this one verb.
  it("403s an ADMIN who is not on the list", () => {
    const next = run({ id: "u2", email: "someadmin@trockgc.com", role: "admin" });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "DEAL_MOVE_BACK_APPROVER_ONLY" })
    );
  });

  it("403s a director who is not on the list", () => {
    const next = run({ id: "u3", email: "otherdirector@trockgc.com", role: "director" });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "DEAL_MOVE_BACK_APPROVER_ONLY" })
    );
  });

  it("401s when there is no authenticated user", () => {
    const next = run(undefined);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  // Fails closed. For a NEW capability that means it is simply unavailable — nothing is taken away, and
  // every other path through the deal is untouched.
  it("denies everyone when the list is unset outside dev/test", () => {
    delete process.env.DEAL_MOVE_BACK_APPROVER_EMAILS;
    process.env.NODE_ENV = "production";
    const next = run({ id: "u4", email: TAKASHI, role: "admin" });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "DEAL_MOVE_BACK_APPROVER_ONLY" })
    );
  });

  it("denies a user with no email", () => {
    const next = run({ id: "u5", email: null, role: "admin" });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});
