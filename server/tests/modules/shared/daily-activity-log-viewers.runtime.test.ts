import { describe, expect, it } from "vitest";
import {
  DEFAULT_NON_PROD_DAILY_ACTIVITY_LOG_VIEWER,
  isDailyActivityLogViewerEmail,
  resolveDailyActivityLogViewers,
} from "@trock-crm/shared/lib/dailyActivityLogViewers";

const TAKASHI = "tyamashita@trockgc.com";
const ADAM = "ashaw@trockgc.com";

describe("resolveDailyActivityLogViewers", () => {
  it("parses, trims and de-duplicates DAILY_ACTIVITY_LOG_VIEWER_EMAILS case-insensitively", () => {
    const env = {
      DAILY_ACTIVITY_LOG_VIEWER_EMAILS: ` ${TAKASHI}, ${ADAM} ,, ${TAKASHI.toUpperCase()}`,
    } as never;
    expect(resolveDailyActivityLogViewers(env)).toEqual([TAKASHI, ADAM]);
  });

  it("returns [] in production when the var is unset — the gate must fail closed", () => {
    expect(resolveDailyActivityLogViewers({ NODE_ENV: "production" } as never)).toEqual([]);
  });

  it("returns [] in production when the var is present but blank", () => {
    expect(
      resolveDailyActivityLogViewers({ NODE_ENV: "production", DAILY_ACTIVITY_LOG_VIEWER_EMAILS: " , , " } as never)
    ).toEqual([]);
  });

  it("falls back to a NON-PERSONAL placeholder in dev/test so no real inbox is embedded in source", () => {
    expect(resolveDailyActivityLogViewers({ NODE_ENV: "development" } as never)).toEqual([
      DEFAULT_NON_PROD_DAILY_ACTIVITY_LOG_VIEWER,
    ]);
  });

  it("lets dev/test override the placeholder with DEV_DAILY_ACTIVITY_LOG_VIEWER", () => {
    const env = { NODE_ENV: "test", DEV_DAILY_ACTIVITY_LOG_VIEWER: "me@example.com" } as never;
    expect(resolveDailyActivityLogViewers(env)).toEqual(["me@example.com"]);
  });

  it("prefers the real var over the dev fallback when both are present", () => {
    const env = {
      NODE_ENV: "development",
      DAILY_ACTIVITY_LOG_VIEWER_EMAILS: TAKASHI,
      DEV_DAILY_ACTIVITY_LOG_VIEWER: "me@example.com",
    } as never;
    expect(resolveDailyActivityLogViewers(env)).toEqual([TAKASHI]);
  });
});

describe("isDailyActivityLogViewerEmail", () => {
  const env = { NODE_ENV: "production", DAILY_ACTIVITY_LOG_VIEWER_EMAILS: `${TAKASHI}, ${ADAM}` } as never;

  it("matches regardless of case or surrounding whitespace", () => {
    expect(isDailyActivityLogViewerEmail(TAKASHI.toUpperCase(), env)).toBe(true);
    expect(isDailyActivityLogViewerEmail(`  ${ADAM} `, env)).toBe(true);
  });

  it("rejects an address that is not on the list", () => {
    expect(isDailyActivityLogViewerEmail("someone.else@trockgc.com", env)).toBe(false);
  });

  it("rejects empty, null and undefined without throwing", () => {
    expect(isDailyActivityLogViewerEmail("", env)).toBe(false);
    expect(isDailyActivityLogViewerEmail("   ", env)).toBe(false);
    expect(isDailyActivityLogViewerEmail(null, env)).toBe(false);
    expect(isDailyActivityLogViewerEmail(undefined, env)).toBe(false);
  });

  // A substring must not match: "shaw@trockgc.com" is a different mailbox from "ashaw@trockgc.com".
  it("requires a whole-address match, not a substring", () => {
    expect(isDailyActivityLogViewerEmail("shaw@trockgc.com", env)).toBe(false);
    expect(isDailyActivityLogViewerEmail(`x${ADAM}`, env)).toBe(false);
  });
});
