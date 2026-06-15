import { describe, it, expect, vi, beforeEach } from "vitest";
import { signJwt, verifyJwt } from "../../src/modules/auth/service.js";
import type { JwtClaims } from "@trock-crm/shared/types";

describe("JWT auth", () => {
  const claims: JwtClaims = {
    userId: "550e8400-e29b-41d4-a716-446655440000",
    email: "test@trock.dev",
    officeId: "660e8400-e29b-41d4-a716-446655440000",
    role: "rep",
  };

  it("should sign and verify a JWT", () => {
    const token = signJwt(claims);
    const decoded = verifyJwt(token);
    expect(decoded.userId).toBe(claims.userId);
    expect(decoded.email).toBe(claims.email);
    expect(decoded.role).toBe(claims.role);
  });

  it("should reject an invalid token", () => {
    expect(() => verifyJwt("invalid.token.here")).toThrow();
  });

  it("should reject a tampered token", () => {
    const token = signJwt(claims);
    const tampered = token.slice(0, -5) + "xxxxx";
    expect(() => verifyJwt(tampered)).toThrow();
  });

  it("should include all required claims in the token payload", () => {
    const token = signJwt(claims);
    const decoded = verifyJwt(token);
    expect(decoded).toMatchObject({
      userId: claims.userId,
      email: claims.email,
      officeId: claims.officeId,
      role: claims.role,
    });
    // JWT should also have standard claims
    expect(decoded).toHaveProperty("iat");
    expect(decoded).toHaveProperty("exp");
  });

  it("defaults to the 24h (CRM/admin) lifetime when no override is given", () => {
    const decoded = verifyJwt(signJwt(claims)) as JwtClaims & { iat: number; exp: number };
    expect(decoded.exp - decoded.iat).toBe(24 * 60 * 60);
  });

  it("honors an expiresIn override (the field surface passes a 30d lifetime)", () => {
    const decoded = verifyJwt(signJwt(claims, { expiresIn: "30d" })) as JwtClaims & { iat: number; exp: number };
    expect(decoded.exp - decoded.iat).toBe(30 * 24 * 60 * 60);
  });

  it("round-trips the surface:'field' audience claim", () => {
    const decoded = verifyJwt(signJwt({ ...claims, surface: "field" }));
    expect(decoded.surface).toBe("field");
    // CRM/admin tokens (no surface) decode with surface undefined.
    expect(verifyJwt(signJwt(claims)).surface).toBeUndefined();
  });
});
