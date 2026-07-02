import { describe, expect, it } from "vitest";
import { isRfpVotingEnabled } from "./feature-flags.js";

describe("isRfpVotingEnabled", () => {
  it("is OFF by default (unset) — the feature ships inert", () => {
    expect(isRfpVotingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
  it("is OFF for any value other than the exact string 'true'", () => {
    expect(isRfpVotingEnabled({ ENABLE_RFP_VOTING: "1" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isRfpVotingEnabled({ ENABLE_RFP_VOTING: "false" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
  it("is ON only when ENABLE_RFP_VOTING === 'true'", () => {
    expect(isRfpVotingEnabled({ ENABLE_RFP_VOTING: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});
