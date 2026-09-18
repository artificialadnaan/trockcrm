import { describe, expect, it } from "vitest";
import {
  DEFAULT_NON_PROD_CANVASSING_VIEWER,
  isCanvassingReportViewerEmail,
  resolveCanvassingReportViewers,
} from "@trock-crm/shared/lib/canvassingReportViewers";

const COLBY = "cburling@trockgc.com";
const TAKASHI = "tyamashita@trockgc.com";

describe("resolveCanvassingReportViewers", () => {
  it("parses, trims and de-duplicates the list case-insensitively", () => {
    const env = { CANVASSING_REPORT_VIEWER_EMAILS: ` ${COLBY}, ${TAKASHI} ,, ${COLBY.toUpperCase()}` } as never;
    expect(resolveCanvassingReportViewers(env)).toEqual([COLBY, TAKASHI]);
  });

  it("returns [] in production when unset or blank — the gate must fail closed", () => {
    expect(resolveCanvassingReportViewers({ NODE_ENV: "production" } as never)).toEqual([]);
    expect(
      resolveCanvassingReportViewers({ NODE_ENV: "production", CANVASSING_REPORT_VIEWER_EMAILS: " , , " } as never)
    ).toEqual([]);
  });

  it("falls back to a NON-PERSONAL placeholder in dev/test", () => {
    expect(resolveCanvassingReportViewers({ NODE_ENV: "development" } as never)).toEqual([
      DEFAULT_NON_PROD_CANVASSING_VIEWER,
    ]);
  });

  it("lets dev/test override with DEV_CANVASSING_REPORT_VIEWER", () => {
    const env = { NODE_ENV: "test", DEV_CANVASSING_REPORT_VIEWER: "me@example.com" } as never;
    expect(resolveCanvassingReportViewers(env)).toEqual(["me@example.com"]);
  });

  it("prefers the real var over the dev fallback when both are set", () => {
    const env = {
      NODE_ENV: "development",
      CANVASSING_REPORT_VIEWER_EMAILS: COLBY,
      DEV_CANVASSING_REPORT_VIEWER: "me@example.com",
    } as never;
    expect(resolveCanvassingReportViewers(env)).toEqual([COLBY]);
  });
});

describe("isCanvassingReportViewerEmail", () => {
  const env = { NODE_ENV: "production", CANVASSING_REPORT_VIEWER_EMAILS: `${COLBY}, ${TAKASHI}` } as never;

  it("matches regardless of case or surrounding whitespace", () => {
    expect(isCanvassingReportViewerEmail(COLBY.toUpperCase(), env)).toBe(true);
    expect(isCanvassingReportViewerEmail(`  ${TAKASHI} `, env)).toBe(true);
  });

  it("rejects an address not on the list", () => {
    expect(isCanvassingReportViewerEmail("someone.else@trockgc.com", env)).toBe(false);
  });

  it("rejects empty, null and undefined without throwing", () => {
    expect(isCanvassingReportViewerEmail("", env)).toBe(false);
    expect(isCanvassingReportViewerEmail("   ", env)).toBe(false);
    expect(isCanvassingReportViewerEmail(null, env)).toBe(false);
    expect(isCanvassingReportViewerEmail(undefined, env)).toBe(false);
  });

  it("requires a whole-address match, not a substring", () => {
    expect(isCanvassingReportViewerEmail("burling@trockgc.com", env)).toBe(false);
    expect(isCanvassingReportViewerEmail(`x${COLBY}`, env)).toBe(false);
  });

  // The two report allowlists are separate lists on purpose — being on one must not imply the other.
  it("is independent of DAILY_ACTIVITY_LOG_VIEWER_EMAILS", () => {
    const other = {
      NODE_ENV: "production",
      DAILY_ACTIVITY_LOG_VIEWER_EMAILS: COLBY,
    } as never;
    expect(isCanvassingReportViewerEmail(COLBY, other)).toBe(false);
  });
});
