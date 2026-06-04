import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireRfpReviewer } from "../../src/middleware/rbac.js";

const TAKASHI = "takashi@trockgc.com";
const ADAM = "ashaw@trockgc.com";

function run(user: any) {
  const next = vi.fn();
  requireRfpReviewer({ user } as any, {} as any, next);
  return next;
}

describe("requireRfpReviewer (email allowlist = RFP_REJECTION_EMAIL_RECIPIENTS)", () => {
  const original = process.env.RFP_REJECTION_EMAIL_RECIPIENTS;

  beforeEach(() => {
    process.env.RFP_REJECTION_EMAIL_RECIPIENTS = `${TAKASHI}, ${ADAM}`;
  });
  afterEach(() => {
    process.env.RFP_REJECTION_EMAIL_RECIPIENTS = original;
  });

  it("allows a configured reviewer (case-insensitive)", () => {
    const next = run({ id: "u1", email: TAKASHI.toUpperCase(), role: "director" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it("403s an authenticated admin who is NOT a configured reviewer", () => {
    const next = run({ id: "u2", email: "someadmin@trockgc.com", role: "admin" });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it("401s when there is no authenticated user", () => {
    const next = run(undefined);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});
