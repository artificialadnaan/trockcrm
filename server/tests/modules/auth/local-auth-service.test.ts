import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  limit: vi.fn(),
}));

vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: dbMocks.limit,
          })),
        })),
      })),
    })),
  },
}));

vi.mock("../../../src/lib/resend-client.js", () => ({
  sendSystemEmail: vi.fn(),
}));

const { loginWithLocalPassword } = await import("../../../src/modules/auth/local-auth-service.js");

describe("local auth service role narrowing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects field contractors before local password verification", async () => {
    dbMocks.limit.mockResolvedValueOnce([
      {
        id: "field-1",
        email: "field@example.com",
        displayName: "Field Contractor",
        role: "field_contractor",
        officeId: "office-1",
        isActive: true,
        passwordHash: "not-a-valid-scrypt-hash",
        mustChangePassword: false,
        isEnabled: true,
        inviteExpiresAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    ]);

    await expect(
      loginWithLocalPassword({
        email: "FIELD@example.com",
        password: "SomePassword123!",
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Local login is not available for this role",
    });
  });
});
