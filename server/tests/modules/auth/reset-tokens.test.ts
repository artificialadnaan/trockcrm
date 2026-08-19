import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { generateResetToken, hashResetToken } from "../../../src/modules/auth/reset-tokens.js";
import { generateInviteToken, hashInviteToken } from "../../../src/modules/field-users/service.js";

describe("reset tokens", () => {
  it("generates 256 bits of entropy as base64url", () => {
    const token = generateResetToken();
    // 32 raw bytes -> 43 base64url chars, unpadded, and no + or / to survive a URL fragment intact.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("does not repeat across generations", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateResetToken()));
    expect(tokens.size).toBe(200);
  });

  it("hashes with sha256 and never returns the raw token", () => {
    const token = generateResetToken();
    const hash = hashResetToken(token);
    expect(hash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes deterministically, so a lookup by hash finds the row", () => {
    const token = generateResetToken();
    expect(hashResetToken(token)).toBe(hashResetToken(token));
  });

  it("maps distinct tokens to distinct hashes", () => {
    const hashes = new Set(Array.from({ length: 100 }, () => hashResetToken(generateResetToken())));
    expect(hashes.size).toBe(100);
  });
});

describe("field-users re-exports", () => {
  // The field flow must keep working unchanged after the helpers moved. Same function, not a copy --
  // two implementations that drift would mean tokens issued by one path cannot be consumed by the other.
  it("keeps generateInviteToken pointing at the shared implementation", () => {
    expect(generateInviteToken).toBe(generateResetToken);
  });

  it("keeps hashInviteToken pointing at the shared implementation", () => {
    expect(hashInviteToken).toBe(hashResetToken);
    const token = generateInviteToken();
    expect(hashInviteToken(token)).toBe(hashResetToken(token));
  });
});
