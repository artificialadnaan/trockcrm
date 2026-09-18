import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireDailyActivityLogViewer } from "../../src/middleware/rbac.js";

const TAKASHI = "tyamashita@trockgc.com";
const TIM = "tmitchell@trockgc.com";

function run(user: unknown) {
  const next = vi.fn();
  requireDailyActivityLogViewer({ user } as never, {} as never, next);
  return next;
}

describe("requireDailyActivityLogViewer (email allowlist = DAILY_ACTIVITY_LOG_VIEWER_EMAILS)", () => {
  const originalList = process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS = `${TAKASHI}, ${TIM}`;
  });
  afterEach(() => {
    if (originalList === undefined) delete process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS;
    else process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS = originalList;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("allows a configured viewer, case-insensitively and ignoring surrounding whitespace", () => {
    const next = run({ id: "u1", email: `  ${TAKASHI.toUpperCase()} `, role: "admin" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  // The point of the whole change: role no longer grants readership. Before this gate an admin — and any
  // director or rep — could open the log, email bodies included.
  it("403 DAILY_ACTIVITY_LOG_VIEWER_ONLY for an authenticated admin who is NOT on the list", () => {
    const next = run({ id: "u2", email: "someadmin@trockgc.com", role: "admin" });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "DAILY_ACTIVITY_LOG_VIEWER_ONLY" })
    );
  });

  it("403 for a rep who is not on the list, even though reps could read their OWN entries before", () => {
    const next = run({ id: "u3", email: "arep@trockgc.com", role: "rep" });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "DAILY_ACTIVITY_LOG_VIEWER_ONLY" })
    );
  });

  it("401 when there is no authenticated user", () => {
    const next = run(undefined);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  // Fail CLOSED. A prod deploy that forgets the env var must hide the report from everyone rather than
  // silently fall back to the old role check, which is the access this allowlist exists to withhold.
  it("denies everyone, including a listed-looking admin, when the var is unset outside dev/test", () => {
    delete process.env.DAILY_ACTIVITY_LOG_VIEWER_EMAILS;
    process.env.NODE_ENV = "production";
    const next = run({ id: "u4", email: TAKASHI, role: "admin" });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "DAILY_ACTIVITY_LOG_VIEWER_ONLY" })
    );
  });

  it("denies a user with no email at all", () => {
    const next = run({ id: "u5", email: null, role: "admin" });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});
