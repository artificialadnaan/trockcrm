import { describe, it, expect } from "vitest";
import {
  DEFAULT_NON_PROD_FIELD_SCORECARD_RECIPIENT,
  resolveFieldScorecardRecipients,
} from "./fieldScorecardEmails.js";

describe("resolveFieldScorecardRecipients", () => {
  it("parses a comma-separated list: trims, drops blanks, de-dupes case-insensitively", () => {
    const env = {
      NODE_ENV: "production",
      FIELD_SCORECARD_EMAIL_RECIPIENTS: " ops@trock.com , , Ops@trock.com ,leadership@trock.com",
    } as unknown as NodeJS.ProcessEnv;
    expect(resolveFieldScorecardRecipients(env)).toEqual(["ops@trock.com", "leadership@trock.com"]);
  });

  it("returns [] in prod when unset (fail loud — worker retries then dead-letters)", () => {
    expect(resolveFieldScorecardRecipients({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(
      resolveFieldScorecardRecipients({ NODE_ENV: "production", FIELD_SCORECARD_EMAIL_RECIPIENTS: "   " } as unknown as NodeJS.ProcessEnv),
    ).toEqual([]);
  });

  it("falls back to a single dev address in dev/test only", () => {
    expect(resolveFieldScorecardRecipients({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toEqual([
      DEFAULT_NON_PROD_FIELD_SCORECARD_RECIPIENT,
    ]);
    expect(resolveFieldScorecardRecipients({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toEqual([
      DEFAULT_NON_PROD_FIELD_SCORECARD_RECIPIENT,
    ]);
  });

  it("prefers a configured value over the dev fallback", () => {
    const env = { NODE_ENV: "development", FIELD_SCORECARD_EMAIL_RECIPIENTS: "real@trock.com" } as unknown as NodeJS.ProcessEnv;
    expect(resolveFieldScorecardRecipients(env)).toEqual(["real@trock.com"]);
  });
});
