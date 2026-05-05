import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const queryMock = vi.hoisted(() => vi.fn());

vi.mock("../../db.js", () => ({
  db: { execute: executeMock },
  pool: { query: queryMock, connect: vi.fn() },
}));

vi.mock("../files/service.js", () => ({
  getDealPhotoTimeline: vi.fn(),
  getFileDownloadUrl: vi.fn(),
}));

vi.mock("../files/audit-log-service.js", () => ({
  logPhotoEvent: vi.fn(),
}));

describe("public photo token service", () => {
  beforeEach(() => {
    executeMock.mockReset();
    queryMock.mockReset();
  });

  it("hashes public tokens before persistence and returns the raw token only once", async () => {
    const { generatePublicToken, hashPublicPhotoToken } = await import("./service.js");
    executeMock.mockResolvedValue({
      rows: [{
        id: "token-1",
        deal_id: "deal-1",
        tenant_id: "tenant-1",
        expires_at: null,
      }],
    });

    const result = await generatePublicToken({
      dealId: "deal-1",
      tenantId: "tenant-1",
      createdByUserId: "user-1",
    });

    expect(result.rawToken).toHaveLength(43);
    expect(result.token).toEqual({
      id: "token-1",
      dealId: "deal-1",
      tenantId: "tenant-1",
      expiresAt: null,
    });
    const queryText = String(executeMock.mock.calls[0][0]);
    expect(queryText).not.toContain(result.rawToken);
    expect(hashPublicPhotoToken(result.rawToken)).toHaveLength(64);
  });

  it("does not expose raw or hashed token values when listing tokens", async () => {
    const { listTokensForDeal } = await import("./service.js");
    executeMock.mockResolvedValue({
      rows: [{
        id: "token-1",
        deal_id: "deal-1",
        tenant_id: "tenant-1",
        created_by_user_id: "user-1",
        created_by_name: "Admin User",
        created_at: new Date("2026-05-01T00:00:00.000Z"),
        expires_at: null,
        revoked_at: null,
        last_accessed_at: null,
        access_count: 3,
        token: "hashed-value",
      }],
    });

    const tokens = await listTokensForDeal("deal-1", "tenant-1");

    expect(tokens[0]).toMatchObject({
      id: "token-1",
      status: "active",
      accessCount: 3,
      createdBy: { id: "user-1", name: "Admin User" },
    });
    expect(tokens[0]).not.toHaveProperty("token");
    expect(tokens[0]).not.toHaveProperty("rawToken");
  });

  it("returns 404 for invalid, expired, or revoked public tokens", async () => {
    const { verifyAndConsumeToken } = await import("./service.js");
    executeMock.mockResolvedValue({ rows: [] });

    await expect(verifyAndConsumeToken("missing-token")).rejects.toMatchObject({
      statusCode: 404,
      message: "Photo link not found",
    });
  });
});
