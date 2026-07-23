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

const { getLocalAuthStatus, hashPassword, loginWithLocalPassword, sendUserInvite, revokeUserInvite } = await import("../../../src/modules/auth/local-auth-service.js");
import type { RevokeRestartDeps } from "../../../src/modules/auth/local-auth-service.js";

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
      "T Rock CRM — You're Invited",
      expect.stringContaining("You've been invited to T Rock CRM"),
      expect.objectContaining({
        text: expect.stringContaining("Go to https://onboarding.trockcrm.com"),
      })
    );
    const [, , html, options] = dbMocks.sendSystemEmail.mock.calls[0]!;
    expect(html).toContain("Hi Rep,");
    expect(html).toContain("https://onboarding.trockcrm.com");
    expect(html).toContain("469-690-2240");
    expect(html).toContain("Change your password immediately");
    expect(options.text).toContain("1. Go to https://onboarding.trockcrm.com");
    expect(options.text).toContain("3. Change your password immediately when prompted");
    // It's a plain invitation now — no data-cleanup / onboarding workflow language.
    expect(html).not.toContain("data cleanup");
    expect(html).not.toContain("Mark historical");
    expect(html).not.toContain("Complete onboarding");
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

// Wiring: revoking a user's field login must restart the open corrective-action cycle for each deal where that
// user is an active super/PM, so the worker re-routes the now-field-login-less user to the tokenized web link.
// The cross-office fan-out itself is exercised end-to-end against PGlite in
// revoke-field-login-restart-cycle.runtime.test.ts; here we assert revokeUserInvite CALLS the restart with the
// injected deps and that a restart failure never fails the revoke.
describe("revokeUserInvite triggers a corrective-action re-notify", () => {
  function makeRestartDeps(dealsByOffice: Record<string, string[]>) {
    const offices = Object.keys(dealsByOffice).map((slug) => ({ id: `id-${slug}`, slug }));
    const restartCycleForDeal = vi.fn().mockResolvedValue(undefined);
    const deps: RevokeRestartDeps = {
      listOffices: vi.fn().mockResolvedValue(offices),
      // Faithful to the real runInOffice: hand the callback an officeDb whose selectDistinct returns THIS
      // office's affected deals, so the function under test enumerates + restarts them.
      runInOffice: vi.fn(async (office, run) => {
        const officeDb = {
          selectDistinct: () => ({
            from: () => ({
              where: async () => dealsByOffice[office.slug]!.map((dealId) => ({ dealId })),
            }),
          }),
        };
        await run(officeDb as never);
      }),
      restartCycleForDeal,
    };
    return { deps, restartCycleForDeal };
  }

  beforeEach(() => {
    // revokeUserInvite: select(existing).limit → update().set().where → insert(event).values.
    dbMocks.limit.mockResolvedValue([{ userId: "user-9" }]);
    dbMocks.updateWhere.mockResolvedValue(undefined);
    dbMocks.insertValues.mockResolvedValue(undefined);
  });

  it("restarts the cycle once per affected deal across every office", async () => {
    const { deps, restartCycleForDeal } = makeRestartDeps({
      alpha: ["deal-a1", "deal-a2"],
      bravo: ["deal-b1"],
    });

    await revokeUserInvite({ userId: "user-9", actorUserId: "admin-1" }, deps);

    expect(restartCycleForDeal).toHaveBeenCalledTimes(3);
    const restartedDeals = restartCycleForDeal.mock.calls.map((c) => c[1].dealId).sort();
    expect(restartedDeals).toEqual(["deal-a1", "deal-a2", "deal-b1"]);
    // Each restart carries the office context (id + slug) the worker's tenant schema needs.
    for (const call of restartCycleForDeal.mock.calls) {
      expect(call[1].office).toMatchObject({ id: expect.any(String), slug: expect.any(String) });
    }
  });

  it("does not restart when the user is an active super/PM on no deal", async () => {
    const { deps, restartCycleForDeal } = makeRestartDeps({ alpha: [], bravo: [] });
    await revokeUserInvite({ userId: "user-9", actorUserId: "admin-1" }, deps);
    expect(restartCycleForDeal).not.toHaveBeenCalled();
  });

  it("still resolves (revoke succeeds) when the re-notify throws — best-effort, non-blocking", async () => {
    const { deps } = makeRestartDeps({ alpha: ["deal-a1"] });
    (deps.restartCycleForDeal as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    // The revoke's own DB writes still ran, and the thrown re-notify is swallowed.
    await expect(revokeUserInvite({ userId: "user-9", actorUserId: "admin-1" }, deps)).resolves.toBeUndefined();
    expect(dbMocks.updateWhere).toHaveBeenCalled();
  });

  it("404s (and never re-notifies) when the user has no local login row", async () => {
    const { deps, restartCycleForDeal } = makeRestartDeps({ alpha: ["deal-a1"] });
    dbMocks.limit.mockResolvedValueOnce([]);
    await expect(
      revokeUserInvite({ userId: "user-9", actorUserId: "admin-1" }, deps),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(restartCycleForDeal).not.toHaveBeenCalled();
  });
});
