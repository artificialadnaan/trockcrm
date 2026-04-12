import { describe, expect, it, vi, beforeEach } from "vitest";
import { procoreOauthTokens } from "@trock-crm/shared/schema";

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
  refreshStoredProcoreOauthTokens,
} = await import("../../../src/modules/procore/oauth-token-service.js");
const { encrypt } = await import("../../../src/lib/encryption.js");

describe("procore oauth token service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores encrypted access and refresh tokens using the singleton upsert", async () => {
    const { db } = await import("../../../src/db.js");
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn().mockReturnValue({
      onConflictDoUpdate,
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
        singletonKey: 1,
        accessToken: "enc:access-123",
        refreshToken: "enc:refresh-456",
        scopes: ["read"],
        connectedAccountEmail: "admin@trock.dev",
        connectedAccountName: "Admin User",
        status: "active",
        lastError: null,
      })
    );
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: procoreOauthTokens.singletonKey,
        set: expect.objectContaining({
          accessToken: "enc:access-123",
          refreshToken: "enc:refresh-456",
          tokenExpiresAt: new Date("2026-04-13T12:00:00.000Z"),
          scopes: ["read"],
          connectedAccountEmail: "admin@trock.dev",
          connectedAccountName: "Admin User",
          status: "active",
          lastError: null,
          updatedAt: expect.any(Date),
        }),
      })
    );
    expect(encrypt).toHaveBeenCalledTimes(2);
  });

  it("reuses the singleton row on repeated upserts", async () => {
    const { db } = await import("../../../src/db.js");
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn().mockReturnValue({
      onConflictDoUpdate,
    });
    db.insert.mockReturnValue({
      values: insertValues,
    });

    const tokens = {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: new Date("2026-04-13T12:00:00.000Z"),
      scopes: ["read"],
    };

    await upsertProcoreOauthTokens(tokens);
    await upsertProcoreOauthTokens(tokens);

    expect(db.insert).toHaveBeenCalledTimes(2);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(2);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns decrypted tokens when the singleton row exists", async () => {
    const { db } = await import("../../../src/db.js");
    db.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              id: "token-row",
              singletonKey: 1,
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
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    await expect(getStoredProcoreOauthTokens()).resolves.toBeNull();
  });

  it("marks the singleton row as reauth_needed when refresh fails using the default db", async () => {
    const { db } = await import("../../../src/db.js");
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    db.update.mockReturnValue({
      set,
    });

    await markProcoreOauthReauthNeeded(undefined, "refresh failed");

    expect(db.update).toHaveBeenCalledOnce();
    expect(db.select).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "reauth_needed",
        lastError: "refresh failed",
        updatedAt: expect.any(Date),
      })
    );
  });

  it("supports injecting a db client for upserts", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn().mockReturnValue({
      onConflictDoUpdate,
    });
    const injectedDb = {
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
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        singletonKey: 1,
      })
    );
  });

  it("refreshes stored oauth tokens and persists the refreshed token set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
          expires_in: 3600,
          scope: "read write",
        }),
        { status: 200 }
      )
    );
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn().mockReturnValue({
      onConflictDoUpdate,
    });
    const injectedDb = {
      insert: vi.fn().mockReturnValue({
        values: insertValues,
      }),
    } as any;

    await expect(
      refreshStoredProcoreOauthTokens("refresh-token", {
        fetchImpl: fetchMock,
        dbClient: injectedDb,
        now: () => new Date("2026-04-13T12:00:00.000Z"),
      })
    ).resolves.toBe("refreshed-access");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://login.procore.com/oauth/token",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(injectedDb.insert).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "enc:refreshed-access",
        refreshToken: "enc:refreshed-refresh",
        tokenExpiresAt: new Date("2026-04-13T13:00:00.000Z"),
        scopes: ["read", "write"],
        status: "active",
        lastError: null,
      })
    );
  });

  it("marks stored oauth tokens as reauth_needed when refresh fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("refresh failed", { status: 401 })
    );
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    const injectedDb = {
      update: vi.fn().mockReturnValue({
        set,
      }),
    } as any;

    await expect(
      refreshStoredProcoreOauthTokens("refresh-token", {
        fetchImpl: fetchMock,
        dbClient: injectedDb,
      })
    ).rejects.toThrow("PROCORE_OAUTH_REFRESH_FAILED");

    expect(injectedDb.update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "reauth_needed",
        lastError: "refresh failed",
        updatedAt: expect.any(Date),
      })
    );
  });
});
