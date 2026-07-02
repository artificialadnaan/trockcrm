import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireRfpVoter } from "../../src/middleware/rbac.js";

const SIDNEY = "sidney@trockgc.com";
const JAMES = "james@trockgc.com";

function run(user: any) {
  const next = vi.fn();
  requireRfpVoter({ user } as any, {} as any, next);
  return next;
}

describe("requireRfpVoter (email allowlist = RFP_VOTER_EMAILS)", () => {
  const original = process.env.RFP_VOTER_EMAILS;

  beforeEach(() => {
    process.env.RFP_VOTER_EMAILS = `${SIDNEY}, ${JAMES}`;
  });
  afterEach(() => {
    process.env.RFP_VOTER_EMAILS = original;
  });

  it("allows a configured voter (case-insensitive)", () => {
    const next = run({ id: "u1", email: SIDNEY.toUpperCase(), role: "rep" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it("403 RFP_VOTER_ONLY for an authenticated admin who is NOT a voter", () => {
    const next = run({ id: "u2", email: "someadmin@trockgc.com", role: "admin" });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "RFP_VOTER_ONLY" }),
    );
  });

  it("401 when there is no authenticated user", () => {
    const next = run(undefined);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});
