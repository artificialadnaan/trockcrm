import { describe, expect, it, vi } from "vitest";
import {
  upsertProcoreOauthTokens,
  getStoredProcoreOauthTokens,
  markProcoreOauthReauthNeeded,
} from "../../../src/modules/procore/oauth-token-service.js";

vi.mock("../../../src/lib/encryption.js", () => ({
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^enc:/, "")),
}));

describe("procore oauth token service", () => {
  it("stores encrypted access and refresh tokens", async () => {
    const insertValues = vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: insertValues,
      }),
    } as any;

    await upsertProcoreOauthTokens(db, {
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
    const db = {
      select: vi.fn().mockReturnValue({
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
      }),
    } as any;

    await expect(getStoredProcoreOauthTokens(db)).resolves.toMatchObject({
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
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any;

    await expect(getStoredProcoreOauthTokens(db)).resolves.toBeNull();
  });

  it("marks the stored token row as reauth_needed when refresh fails", async () => {
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: "token-row" }]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set,
      }),
    } as any;

    await markProcoreOauthReauthNeeded(db, "refresh failed");

    expect(db.update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "reauth_needed",
        lastError: "refresh failed",
        updatedAt: expect.any(Date),
      })
    );
  });
});
