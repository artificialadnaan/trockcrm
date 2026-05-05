import { beforeEach, describe, expect, it, vi } from "vitest";

const poolQueryMock = vi.hoisted(() => vi.fn());
const clientQueryMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
const connectMock = vi.hoisted(() => vi.fn(() => ({ query: clientQueryMock, release: releaseMock })));

vi.mock("../db.js", () => ({
  pool: {
    query: poolQueryMock,
    connect: connectMock,
  },
}));

describe("procore photo worker", () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    clientQueryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    delete process.env.PROCORE_PHOTOS_PUSH_ENABLED;
    delete process.env.PROCORE_LINK_CREATION_ENABLED;
  });

  it("leaves photo rows untouched when Procore photo push is feature-flagged off", async () => {
    const { handleProcorePhotoSyncJob } = await import("./procore-photos.js");
    poolQueryMock.mockResolvedValueOnce({ rows: [{ slug: "main" }] });
    clientQueryMock.mockResolvedValueOnce({ rows: [{ id: "deal-1", procore_project_id: 12345 }] });

    await handleProcorePhotoSyncJob({ dealId: "deal-1", officeId: "office-1" }, null);

    const sqlText = clientQueryMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).not.toContain("UPDATE office_main.files");
    expect(sqlText).not.toContain("procore_sync_status = 'pending'");
  });

  it("does not create public viewer links when link creation is feature-flagged off", async () => {
    const { ensurePublicPhotoLinkForDeal } = await import("./procore-photos.js");

    const result = await ensurePublicPhotoLinkForDeal({
      officeId: "office-1",
      schemaName: "office_main",
      dealId: "deal-1",
    });

    expect(result).toBe(false);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("does not create the Procore image category while photo push is feature-flagged off", async () => {
    const { ensureTRockPhotosAlbumForDeal } = await import("./procore-photos.js");

    const result = await ensureTRockPhotosAlbumForDeal({
      officeId: "office-1",
      schemaName: "office_main",
      dealId: "deal-1",
    });

    expect(result).toBe(false);
    expect(connectMock).not.toHaveBeenCalled();
  });
});
