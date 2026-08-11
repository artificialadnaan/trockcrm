import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireCanvassingReportViewer } from "../../src/middleware/rbac.js";

const COLBY = "cburling@trockgc.com";
const TAKASHI = "tyamashita@trockgc.com";

function run(user: unknown) {
  const next = vi.fn();
  requireCanvassingReportViewer({ user } as never, {} as never, next);
  return next;
}

describe("requireCanvassingReportViewer (email allowlist = CANVASSING_REPORT_VIEWER_EMAILS)", () => {
  const originalList = process.env.CANVASSING_REPORT_VIEWER_EMAILS;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.CANVASSING_REPORT_VIEWER_EMAILS = `${COLBY}, ${TAKASHI}`;
  });
  afterEach(() => {
    if (originalList === undefined) delete process.env.CANVASSING_REPORT_VIEWER_EMAILS;
    else process.env.CANVASSING_REPORT_VIEWER_EMAILS = originalList;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("allows a configured viewer, case-insensitively and ignoring whitespace", () => {
    const next = run({ id: "u1", email: `  ${COLBY.toUpperCase()} `, role: "director" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  // The report names individuals and scores them, so holding a role is not enough to read it.
  it("403s a director who is not on the list", () => {
    const next = run({ id: "u2", email: "otherdirector@trockgc.com", role: "director" });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "CANVASSING_REPORT_VIEWER_ONLY" })
    );
  });

  it("403s a rep — including one whose own numbers are on the report", () => {
    const next = run({ id: "u3", email: "emccarty@trockgc.com", role: "rep" });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "CANVASSING_REPORT_VIEWER_ONLY" })
    );
  });

  it("401s when there is no authenticated user", () => {
    const next = run(undefined);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("denies everyone when the list is unset outside dev/test — the gate fails closed", () => {
    delete process.env.CANVASSING_REPORT_VIEWER_EMAILS;
    process.env.NODE_ENV = "production";
    const next = run({ id: "u4", email: COLBY, role: "director" });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403, code: "CANVASSING_REPORT_VIEWER_ONLY" })
    );
  });

  it("denies a user with no email", () => {
    const next = run({ id: "u5", email: null, role: "admin" });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});
