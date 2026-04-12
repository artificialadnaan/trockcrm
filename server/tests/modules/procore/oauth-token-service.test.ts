import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  },
  pool: {},
}));

vi.mock("../../../src/lib/encryption.js", () => ({
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, "")),
}));

const {
  upsertProcoreOauthTokens,
  getStoredProcoreOauthTokens,
  markProcoreOauthReauthNeeded,
} = await import("../../../src/modules/procore/oauth-token-service.js");

describe("procore oauth token service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores encrypted access and refresh tokens using the default db", async () => {
    const { db } = await import("../../../src/db.js");
    const insertValues = vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    });
    db.insert.mockReturnValue({
      values: insertValues,
    });

    await upsertProcoreOauthTokens({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-04-13T12:00:00.000Z"),
      scopes: ["read"],
      accountEmail: "admin@trock.dev",
      accountName: "Admin User",
    });

    expect(db.insert).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "enc:access-123",
        refreshToken: "enc:refresh-456",
        scopes: ["read"],
        connectedAccountEmail: "admin@trock.dev",
        connectedAccountName: "Admin User",
        status: "active",
        lastError: null,
      })
    );
  });

  it("returns decrypted tokens when a stored row exists", async () => {
    const { db } = await import("../../../src/db.js");
    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([
          {
            id: "token-row",
            accessToken: "enc:access-123",
            refreshToken: "enc:refresh-456",
            tokenExpiresAt: new Date("2026-04-13T12:00:00.000Z"),
            scopes: ["read", "write"],
            connectedAccountEmail: "admin@trock.dev",
            connectedAccountName: "Admin User",
            status: "active",
            lastError: null,
          },
        ]),
      }),
    });

    await expect(getStoredProcoreOauthTokens()).resolves.toMatchObject({
      id: "token-row",
      accessToken: "access-123",
      refreshToken: "refresh-456",
      scopes: ["read", "write"],
      accountEmail: "admin@trock.dev",
      accountName: "Admin User",
      status: "active",
      lastError: null,
    });
  });

  it("returns null when no procore oauth tokens exist", async () => {
    const { db } = await import("../../../src/db.js");
    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    });

    await expect(getStoredProcoreOauthTokens()).resolves.toBeNull();
  });

  it("marks the stored token row as reauth_needed when refresh fails using the default db", async () => {
    const { db } = await import("../../../src/db.js");
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ id: "token-row" }]),
      }),
    });
    db.update.mockReturnValue({
      set,
    });

    await markProcoreOauthReauthNeeded(undefined, "refresh failed");

    expect(db.update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "reauth_needed",
        lastError: "refresh failed",
        updatedAt: expect.any(Date),
      })
    );
  });

  it("supports injecting a db client for upserts", async () => {
    const insertValues = vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    const injectedDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: insertValues,
      }),
    } as any;

    await upsertProcoreOauthTokens(
      {
        accessToken: "access-789",
        refreshToken: "refresh-987",
        expiresAt: new Date("2026-04-13T12:00:00.000Z"),
        scopes: ["read"],
      },
      injectedDb
    );

    expect(injectedDb.insert).toHaveBeenCalledOnce();
  });
});
