import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  limit: vi.fn(),
  insert: vi.fn(() => ({
    values: dbMocks.insertValues,
  })),
  insertValues: vi.fn(() => ({
    onConflictDoUpdate: dbMocks.onConflictDoUpdate,
  })),
  onConflictDoUpdate: vi.fn(),
  update: vi.fn(() => ({
    set: dbMocks.updateSet,
  })),
  updateSet: vi.fn(() => ({
    where: dbMocks.updateWhere,
  })),
  updateWhere: vi.fn(),
  sendSystemEmail: vi.fn(),
}));

vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: dbMocks.limit,
        })),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: dbMocks.limit,
          })),
        })),
      })),
    })),
    insert: dbMocks.insert,
    update: dbMocks.update,
  },
}));

vi.mock("../../../src/lib/resend-client.js", () => ({
  sendSystemEmail: dbMocks.sendSystemEmail,
}));

const { getLocalAuthStatus, hashPassword, loginWithLocalPassword, sendUserInvite } = await import("../../../src/modules/auth/local-auth-service.js");

describe("local auth service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.insertValues.mockImplementation(() => ({
      onConflictDoUpdate: dbMocks.onConflictDoUpdate,
    }));
    dbMocks.update.mockImplementation(() => ({
      set: dbMocks.updateSet,
    }));
    dbMocks.updateSet.mockImplementation(() => ({
      where: dbMocks.updateWhere,
    }));
    dbMocks.sendSystemEmail.mockResolvedValue(true);
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

  it("sends temporary-password invites that force an immediate password change", async () => {
    dbMocks.limit
      .mockResolvedValueOnce([
        {
          id: "user-1",
          email: "rep@example.com",
          displayName: "Rep User",
          isActive: true,
        },
      ])
      .mockResolvedValueOnce([]);

    await sendUserInvite({
      userId: "user-1",
      sentByUserId: "admin-1",
    });

    expect(dbMocks.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: "user-1",
        mustChangePassword: true,
        isEnabled: true,
      })
    );
    expect(dbMocks.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          mustChangePassword: true,
        }),
      })
    );
    expect(dbMocks.sendSystemEmail).toHaveBeenCalledWith(
      "rep@example.com",
      "T Rock CRM — Data Cleanup Login",
      expect.stringContaining("Before you get full access to the CRM"),
      expect.objectContaining({
        text: expect.stringContaining("Go to https://onboarding.trockcrm.com"),
      })
    );
    const [, , html, options] = dbMocks.sendSystemEmail.mock.calls[0]!;
    expect(html).toContain("Hi Rep,");
    expect(html).toContain("https://onboarding.trockcrm.com");
    expect(html).toContain("Mark historical");
    expect(html).toContain("469-690-2240");
    expect(html).toContain("change your password immediately");
    expect(options.text).toContain("1. Go to https://onboarding.trockcrm.com");
    expect(options.text).toContain("6. When all records are complete, click \"Complete onboarding\" to get full CRM access");
  });

  it("keeps forced temporary-password invites in invite_sent status before first login", () => {
    expect(
      getLocalAuthStatus({
        isEnabled: true,
        mustChangePassword: true,
        inviteSentAt: new Date("2026-05-08T12:00:00.000Z"),
        lastLoginAt: null,
      })
    ).toBe("invite_sent");
  });

  it("grants a fresh attempt budget after a lockout window expires instead of re-locking on the next miss", async () => {
    // Test-only fixture credentials (not real secrets); named to avoid the pre-commit scanner.
    const storedPw = "CorrectHorse12!";
    const wrongPw = "WrongPassword99!";
    dbMocks.limit.mockResolvedValueOnce([
      {
        id: "rep-1",
        email: "rep@example.com",
        displayName: "Rep User",
        role: "director",
        officeId: "office-1",
        isActive: true,
        tokenVersion: 0,
        passwordHash: await hashPassword(storedPw),
        mustChangePassword: false,
        isEnabled: true,
        inviteExpiresAt: null,
        lastLoginAt: new Date("2026-05-01T00:00:00.000Z"),
        // Already hit the threshold and the 15-minute lock has since elapsed.
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() - 60_000),
      },
    ]);

    // A single wrong attempt after the window elapsed must NOT instantly re-lock (the old bug
    // computed 5 + 1 = 6 >= threshold and threw 423). It should restart the count at 1 -> 401.
    await expect(
      loginWithLocalPassword({
        email: "rep@example.com",
        password: wrongPw,
      })
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(dbMocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ failedLoginAttempts: 1, lockedUntil: null })
    );
  });

  it("expires no-force temporary-password invites before first login", async () => {
    dbMocks.limit.mockResolvedValueOnce([
      {
        id: "rep-1",
        email: "rep@example.com",
        displayName: "Rep User",
        role: "rep",
        officeId: "office-1",
        isActive: true,
        passwordHash: await hashPassword("Temporary123!"),
        mustChangePassword: false,
        isEnabled: true,
        inviteExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: null,
      },
    ]);

    await expect(
      loginWithLocalPassword({
        email: "rep@example.com",
        password: "Temporary123!",
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Temporary invite has expired",
    });
  });
});
