import {
  buildLoginReturnTo,
  resolvePostLoginHref,
  DEFAULT_POST_LOGIN_HREF,
} from "../return-to";

describe("buildLoginReturnTo", () => {
  it("preserves a corrective-action deep-link path (group segment already stripped)", () => {
    // usePathname() strips the (app) group, so a deep link to
    // /(app)/scorecards/corrective-action/sc-1 arrives here as the group-less path.
    expect(
      buildLoginReturnTo("/scorecards/corrective-action/sc-1", { id: "sc-1" }),
    ).toBe("/scorecards/corrective-action/sc-1");
  });

  it("carries a genuine query param (e.g. the link token) but never the dynamic id segment", () => {
    expect(
      buildLoginReturnTo("/scorecards/corrective-action/sc-1", {
        id: "sc-1",
        token: "abc123",
      }),
    ).toBe("/scorecards/corrective-action/sc-1?token=abc123");
  });

  it("takes the first value of an array param", () => {
    expect(
      buildLoginReturnTo("/scorecards/corrective-action/sc-1", {
        id: ["sc-1"],
        token: ["abc123", "ignored"],
      }),
    ).toBe("/scorecards/corrective-action/sc-1?token=abc123");
  });

  it("never captures an auth/boot path (would loop)", () => {
    expect(buildLoginReturnTo("/login")).toBeNull();
    expect(buildLoginReturnTo("/login", { returnTo: "/x" })).toBeNull();
    expect(buildLoginReturnTo("/accept-invite", { token: "t" })).toBeNull();
    expect(buildLoginReturnTo("/")).toBeNull();
    expect(buildLoginReturnTo("/index")).toBeNull();
  });

  it("rejects empty/external/scheme-relative paths", () => {
    expect(buildLoginReturnTo(undefined)).toBeNull();
    expect(buildLoginReturnTo(null)).toBeNull();
    expect(buildLoginReturnTo("")).toBeNull();
    expect(buildLoginReturnTo("https://evil.example.com")).toBeNull();
    expect(buildLoginReturnTo("//evil.example.com")).toBeNull();
  });

  it("does not nest an existing returnTo param into a new capture", () => {
    expect(
      buildLoginReturnTo("/scorecards/corrective-action/sc-1", {
        id: "sc-1",
        returnTo: "/somewhere",
      }),
    ).toBe("/scorecards/corrective-action/sc-1");
  });
});

describe("resolvePostLoginHref", () => {
  it("returns the pending corrective-action destination", () => {
    expect(resolvePostLoginHref("/scorecards/corrective-action/sc-1")).toBe(
      "/scorecards/corrective-action/sc-1",
    );
  });

  it("preserves a query string on the destination", () => {
    expect(
      resolvePostLoginHref("/scorecards/corrective-action/sc-1?token=abc123"),
    ).toBe("/scorecards/corrective-action/sc-1?token=abc123");
  });

  it("decodes a percent-encoded returnTo (params round-trip through a URL)", () => {
    expect(
      resolvePostLoginHref("%2Fscorecards%2Fcorrective-action%2Fsc-1%3Ftoken%3Dabc123"),
    ).toBe("/scorecards/corrective-action/sc-1?token=abc123");
  });

  it("falls back to projects with no pending destination", () => {
    expect(resolvePostLoginHref(undefined)).toBe(DEFAULT_POST_LOGIN_HREF);
    expect(resolvePostLoginHref("")).toBe(DEFAULT_POST_LOGIN_HREF);
  });

  it("takes the first value when the param arrives as an array", () => {
    expect(resolvePostLoginHref(["/scorecards/corrective-action/sc-1", "x"])).toBe(
      "/scorecards/corrective-action/sc-1",
    );
  });

  it("refuses to loop back to an auth screen or go off-app", () => {
    expect(resolvePostLoginHref("/login")).toBe(DEFAULT_POST_LOGIN_HREF);
    expect(resolvePostLoginHref("/login?returnTo=/x")).toBe(DEFAULT_POST_LOGIN_HREF);
    expect(resolvePostLoginHref("/accept-invite")).toBe(DEFAULT_POST_LOGIN_HREF);
    expect(resolvePostLoginHref("https://evil.example.com")).toBe(DEFAULT_POST_LOGIN_HREF);
    expect(resolvePostLoginHref("//evil.example.com")).toBe(DEFAULT_POST_LOGIN_HREF);
  });

  it("falls back on a malformed percent-encoding", () => {
    expect(resolvePostLoginHref("%E0%A4%A")).toBe(DEFAULT_POST_LOGIN_HREF);
  });
});
